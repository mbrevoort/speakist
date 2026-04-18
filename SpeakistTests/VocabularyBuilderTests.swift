import XCTest
@testable import Speakist

@MainActor
final class VocabularyBuilderTests: XCTestCase {

    func testKeytermsPrefersProperNounsByCount() throws {
        let store = CorrectionStore()
        // Inject in-memory: use bootstrap against a temp dir.
        store.bootstrap()
        // Ingest some corrections
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true),
            CorrectionPair(from: "teh", to: "the", isProperNounLike: false)
        ])
        store.ingest(pairs: [
            CorrectionPair(from: "brevort", to: "Brevoort", isProperNounLike: true)
        ])
        let terms = VocabularyBuilder.keyterms(for: .deepgram, from: store)
        XCTAssertTrue(terms.contains("Brevoort"))
        XCTAssertFalse(terms.contains("the"), "Common-word corrections should not be promoted to STT keyterms")
    }
}
