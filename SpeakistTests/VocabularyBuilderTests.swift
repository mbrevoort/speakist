import XCTest
@testable import Speakist

@MainActor
final class VocabularyBuilderTests: XCTestCase {

    /// Auto-ingested corrections start as `appliesTo = .local` and
    /// therefore must NOT appear in keyterms — keyterms() filters
    /// to `.stt`. Until the reactive classifier promotes a row to
    /// `.stt` (which requires an API client + the LLM verdict, both
    /// absent in unit tests), the row stays out of the STT pipeline.
    /// This is the invariant that fixes the "every inline edit
    /// becomes a global rewrite rule" failure mode.
    func testAutoIngestedEntriesAreNotInKeyterms() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true),
            CorrectionPair(from: "teh", to: "the", isProperNounLike: false),
        ])
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true),
        ])
        let terms = VocabularyBuilder.keyterms(from: store)
        XCTAssertFalse(
            terms.contains("Brevoort"),
            "Auto-ingested proper-noun-like correction must stay local until the classifier promotes it; it should not reach keyterms by virtue of count alone."
        )
        XCTAssertFalse(
            terms.contains("the"),
            "Common-word correction must never reach keyterms regardless of state."
        )
    }

    /// Once a row has been promoted to `appliesTo = .stt` (the
    /// equivalent of either the classifier saying add=true or the
    /// user manually adding the entry in Settings) AND it carries
    /// the proper-noun flag, it shows up in keyterms. Both gates are
    /// required: `.stt` alone or `isProperNoun` alone is not enough.
    func testStttPromotedProperNounsAppearInKeyterms() throws {
        let store = CorrectionStore()
        try store.bootstrapInMemoryForTesting()

        // Simulate a manual Settings add (or a successful classifier
        // promotion) by upserting straight into the .stt bucket.
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
        // Common-word entry that's somehow already in .stt — keyterms
        // should STILL exclude it because of the isProperNoun gate.
        // (Manual adds in Settings derive isProperNoun from
        // DiffEngine.isProperNounLike(), so an all-lowercase "the"
        // would land here with isProperNoun=false.)
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

        let terms = VocabularyBuilder.keyterms(from: store)
        XCTAssertTrue(
            terms.contains("Brevoort"),
            "STT-promoted proper noun should appear in keyterms."
        )
        XCTAssertFalse(
            terms.contains("the"),
            "Common-word correction should still be excluded by the isProperNoun gate even when applies_to=.stt."
        )
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

    func testDeleteQueuesDurableTombstoneForLaterCloudSync() throws {
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

        guard let row = store.all.first else {
            return XCTFail("Expected inserted correction")
        }
        store.delete(row)

        let queued = try store.pendingVocabularyChangesForTesting()
        let tombstone = queued.first {
            $0.from == "brevort" && $0.to == "Brevoort"
        }
        XCTAssertEqual(tombstone?.deleted, true)
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
