import XCTest
@testable import Speakist

final class ParakeetTranscriptionClientTests: XCTestCase {
    func testMapsLocalRuntimeResultAndLabels() async throws {
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: "hello from parakeet",
            audioSeconds: 2.5,
            processingSeconds: 0.05))
        let client = ParakeetTranscriptionClient(runtime: runtime, replaceRules: [])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: ["Speakist"],
            language: "en")

        XCTAssertEqual(result.text, "hello from parakeet")
        XCTAssertNil(result.rawText)
        XCTAssertEqual(result.audioSeconds, 2.5)
        XCTAssertEqual(result.providerModelLabel, "parakeet tdt-0.6b-v2-int8")
        XCTAssertEqual(client.providerLabel, "parakeet")
        XCTAssertEqual(client.modelLabel, "tdt-0.6b-v2-int8")
    }

    func testAppliesExplicitVocabularyReplacementLocally() async throws {
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: "speak list works with mytrah but not mythrashing",
            audioSeconds: 1,
            processingSeconds: 0.01))
        let client = ParakeetTranscriptionClient(
            runtime: runtime,
            replaceRules: [
                ReplaceRule(find: "speak list", replacement: "Speakist"),
                ReplaceRule(find: "mytrah", replacement: "Mytrah"),
            ])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: [],
            language: "en")

        XCTAssertEqual(result.text, "Speakist works with Mytrah but not mythrashing")
    }

    func testAppliesConfiguredNameAliasAfterParakeet() async throws {
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: "My name is Breford",
            audioSeconds: 1,
            processingSeconds: 0.02))
        let client = ParakeetTranscriptionClient(
            runtime: runtime,
            replaceRules: [ReplaceRule(find: "Breford", replacement: "Brevoort")])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: [],
            language: "en")

        XCTAssertEqual(result.text, "My name is Brevoort")
        XCTAssertEqual(result.rawText, "My name is Breford")
    }

    func testExactNameRulesDoNotRewriteSimilarOrdinaryWords() async throws {
        let original = "Do not make a drastic change. I want a really good README from the previous repo."
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: original,
            audioSeconds: 3,
            processingSeconds: 0.02))
        let client = ParakeetTranscriptionClient(
            runtime: runtime,
            replaceRules: [
                ReplaceRule(find: "Jeannie", replacement: "Jeanie"),
                ReplaceRule(find: "Waltie", replacement: "Walti"),
                ReplaceRule(find: "Walty", replacement: "Walti"),
                ReplaceRule(find: "Breford", replacement: "Brevoort"),
                ReplaceRule(find: "brevort", replacement: "Brevoort"),
                ReplaceRule(find: "prevoort", replacement: "Brevoort"),
            ])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: [],
            language: "en")

        XCTAssertEqual(result.text, original)
        XCTAssertNil(result.rawText)
    }

    func testRepairsPrematureBoundaryWhenParakeetReportsThinkingPause() async throws {
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: "I could. Use the smaller model",
            audioSeconds: 2,
            processingSeconds: 0.02,
            pauses: [ParakeetPause(afterWordIndex: 1, seconds: 1.1)]))
        let client = ParakeetTranscriptionClient(runtime: runtime, replaceRules: [])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: [],
            language: "en")

        XCTAssertEqual(result.text, "I could use the smaller model")
        XCTAssertEqual(result.rawText, "I could. Use the smaller model")
        XCTAssertTrue(result.cleanupApplied)
    }

    func testDoesNotJoinIntentionalSentenceWithoutMatchingPause() async throws {
        let runtime = FakeParakeetRuntime(result: ParakeetRuntimeResult(
            text: "I could. My colleague agreed",
            audioSeconds: 2,
            processingSeconds: 0.02,
            pauses: [ParakeetPause(afterWordIndex: 0, seconds: 1.1)]))
        let client = ParakeetTranscriptionClient(runtime: runtime, replaceRules: [])

        let result = try await client.transcribe(
            audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
            keyterms: [],
            language: "en")

        XCTAssertEqual(result.text, "I could. My colleague agreed")
        XCTAssertFalse(result.cleanupApplied)
    }

    func testMapsRuntimeFailureToLocalModelError() async {
        let runtime = FakeParakeetRuntime(error: FakeError.failed)
        let client = ParakeetTranscriptionClient(runtime: runtime, replaceRules: [])

        do {
            _ = try await client.transcribe(
                audioURL: URL(fileURLWithPath: "/tmp/not-read-by-fake.wav"),
                keyterms: [],
                language: "en")
            XCTFail("Expected local model error")
        } catch let error as TranscriptionError {
            guard case .localModel(let message) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertTrue(message.contains("fake runtime failed"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    @MainActor
    func testModelManagerSurfacesPreparationFailureForRetryUI() async {
        let manager = ParakeetModelManager(
            runtime: FakeParakeetRuntime(error: FakeError.failed))

        do {
            try await manager.prepare()
            XCTFail("Expected model preparation to fail")
        } catch {
            XCTAssertEqual(manager.state, .failed("fake runtime failed"))
        }
    }
}

private actor FakeParakeetRuntime: ParakeetRuntimeProtocol {
    private let result: ParakeetRuntimeResult?
    private let error: Error?

    init(result: ParakeetRuntimeResult) {
        self.result = result
        self.error = nil
    }

    init(error: Error) {
        self.result = nil
        self.error = error
    }

    func prepare(
        progress: (@Sendable (ParakeetLoadProgress) -> Void)?
    ) async throws {
        if let error { throw error }
    }

    func transcribe(audioURL: URL) async throws -> ParakeetRuntimeResult {
        if let error { throw error }
        guard let result else { throw FakeError.failed }
        return result
    }
}

private enum FakeError: LocalizedError {
    case failed

    var errorDescription: String? { "fake runtime failed" }
}
