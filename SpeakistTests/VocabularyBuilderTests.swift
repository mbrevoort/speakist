import XCTest
@testable import Speakist

@MainActor
final class VocabularyBuilderTests: XCTestCase {

    /// Repeated inline edits stay staged unless they safely inherit approval
    /// from an existing proper-noun rule. Frequency alone must never create a
    /// global replacement.
    func testAutoIngestedEntriesAreNotActiveReplacementRules() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true),
            CorrectionPair(from: "teh", to: "the", isProperNounLike: false),
        ])
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true),
        ])
        XCTAssertTrue(VocabularyBuilder.replaceRules(from: store).isEmpty)
    }

    func testExplicitRulesApplyToNamesAndPreferredWrittenForms() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()

        store.upsert(CorrectionRow(
            dbID: nil,
            fromText: "brevort",
            toText: "Brevoort",
            count: 1,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt
        ))
        store.upsert(CorrectionRow(
            dbID: nil,
            fromText: "teh",
            toText: "the",
            count: 1,
            lastSeen: Date(),
            isProperNoun: false,
            userManaged: true,
            appliesTo: .stt
        ))

        XCTAssertEqual(
            Set(VocabularyBuilder.replaceRules(from: store)),
            Set([
                ReplaceRule(find: "brevort", replacement: "Brevoort"),
                ReplaceRule(find: "teh", replacement: "the"),
            ]))
    }

    func testSimilarMisspellingAliasActivatesWhenCanonicalWasAlreadyApproved() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()
        store.upsert(CorrectionRow(
            dbID: nil,
            fromText: "brevort",
            toText: "Brevoort",
            count: 1,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt))

        store.ingest(pairs: [
            CorrectionPair(
                from: "prevoort",
                to: "Brevoort",
                isProperNounLike: true)
        ])

        let learned = store.all.first {
            $0.fromText == "prevoort" && $0.toText == "Brevoort"
        }
        XCTAssertEqual(learned?.appliesTo, .stt)
        XCTAssertEqual(
            Set(VocabularyBuilder.replaceRules(from: store)),
            Set([
                ReplaceRule(find: "prevoort", replacement: "Brevoort"),
                ReplaceRule(find: "brevort", replacement: "Brevoort"),
            ]))
    }

    func testCommonAndDissimilarWordsDoNotBecomeAutomaticNameAliases() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()
        store.upsert(CorrectionRow(
            dbID: nil,
            fromText: "jeannie",
            toText: "Jeanie",
            count: 1,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt))
        store.upsert(CorrectionRow(
            dbID: nil,
            fromText: "walty",
            toText: "Walti",
            count: 1,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt))

        store.ingest(pairs: [
            CorrectionPair(from: "change", to: "Jeanie", isProperNounLike: true),
            CorrectionPair(from: "want", to: "Walti", isProperNounLike: true),
        ])

        XCTAssertEqual(
            store.all.first(where: { $0.fromText == "change" })?.appliesTo,
            .local)
        XCTAssertEqual(
            store.all.first(where: { $0.fromText == "want" })?.appliesTo,
            .local)
        let rules = VocabularyBuilder.replaceRules(from: store)
        XCTAssertFalse(rules.contains(where: { $0.find == "change" || $0.find == "want" }))
    }

    func testLocalChannelImportsStableExplicitRulesOnceAndAppliesThem() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("Speakist-replacement-import-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let stableURL = directory.appendingPathComponent("stable.sqlite")
        let localURL = directory.appendingPathComponent("local.sqlite")

        let stable = CorrectionStore()
        try stable.bootstrapForTesting(databaseURL: stableURL)
        stable.upsert(CorrectionRow(
            dbID: nil,
            fromText: "Mitra",
            toText: "Mytra",
            count: 2,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt))
        stable.upsert(CorrectionRow(
            dbID: nil,
            fromText: "Jeannie",
            toText: "Jeanie",
            count: 1,
            lastSeen: Date(),
            isProperNoun: true,
            userManaged: true,
            appliesTo: .stt))
        // Staged edit: intentionally not a globally active Replace Word.
        stable.upsert(CorrectionRow(
            dbID: nil,
            fromText: "teh",
            toText: "the",
            count: 5,
            lastSeen: Date(),
            isProperNoun: false,
            userManaged: true,
            appliesTo: .local))

        let local = CorrectionStore()
        try local.bootstrapForTesting(
            databaseURL: localURL,
            stableRulesURL: stableURL)
        let rules = VocabularyBuilder.replaceRules(from: local)

        XCTAssertEqual(Set(rules), Set([
            ReplaceRule(find: "mitra", replacement: "Mytra"),
            ReplaceRule(find: "jeannie", replacement: "Jeanie"),
        ]))

        let corrected = LocalTranscriptCorrections.applyWithCount(
            to: "I work at Mitra and my wife's name is Jeannie.",
            rules: rules)
        XCTAssertEqual(
            corrected.text,
            "I work at Mytra and my wife's name is Jeanie.")
        XCTAssertEqual(corrected.replacementCount, 2)

        // The durable import marker makes local deletion authoritative.
        guard let mitra = local.all.first(where: { $0.fromText == "Mitra" }) else {
            return XCTFail("Expected imported Mitra rule")
        }
        local.delete(mitra)

        let relaunched = CorrectionStore()
        try relaunched.bootstrapForTesting(
            databaseURL: localURL,
            stableRulesURL: stableURL)
        XCTAssertFalse(relaunched.all.contains(where: { $0.fromText == "Mitra" }))
        XCTAssertTrue(relaunched.all.contains(where: { $0.fromText == "Jeannie" }))
    }
}
