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
}
