import XCTest
@testable import Speakist

final class LocalTranscriptCleanupTests: XCTestCase {
    func testRestoresCommonContractionWithoutChangingWords() async {
        let result = await DeterministicLocalTranscriptCleanup().cleanup(
            text: "I dont think thats the right one",
            pauses: [])

        XCTAssertEqual(result.text, "I don't think that's the right one")
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.reason, "contraction-and-punctuation")
    }

    func testPauseRepairRequiresAContinuationWord() async {
        let cleanup = DeterministicLocalTranscriptCleanup()
        let result = await cleanup.cleanup(
            text: "I could. My colleague agreed",
            pauses: [ParakeetPause(afterWordIndex: 1, seconds: 1.0)])

        XCTAssertEqual(result.text, "I could. My colleague agreed")
        XCTAssertFalse(result.applied)
    }

    func testPauseRepairJoinsAContinuationClauseAndLowercasesOnlyNextWord() async {
        let cleanup = DeterministicLocalTranscriptCleanup()
        let result = await cleanup.cleanup(
            text: "I could. Use the smaller model",
            pauses: [ParakeetPause(afterWordIndex: 1, seconds: 0.8)])

        XCTAssertEqual(result.text, "I could use the smaller model")
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.reason, "pause-boundary-repair")
    }

    func testLongPauseDoesNotInventTheRestOfAThought() async {
        let result = await DeterministicLocalTranscriptCleanup().cleanup(
            text: "The sentence ends with could",
            pauses: [ParakeetPause(afterWordIndex: 5, seconds: 3.0)])

        XCTAssertEqual(result.text, "The sentence ends with could")
    }

    func testSafetyGateRejectsDroppedOrInventedContent() {
        XCTAssertTrue(LocalTranscriptSafetyGate.accepts(
            original: "I dont need this",
            candidate: "I don't need this"))
        XCTAssertFalse(LocalTranscriptSafetyGate.accepts(
            original: "I need this",
            candidate: "I need"))
        XCTAssertFalse(LocalTranscriptSafetyGate.accepts(
            original: "I need this",
            candidate: "I need that"))
    }

    func testSpeechStyleNormalizerExpandsCasualSpeechAndRemovesFillers() {
        XCTAssertEqual(
            LocalSpeechStyleNormalizer.normalize(
                "Um, I think we're gonna ship, uh, tomorrow."),
            "I think we're going to ship tomorrow.")
    }

    func testSpeechStyleNormalizerProtectsMentionedQuotedAndAcronymTokens() {
        XCTAssertEqual(
            LocalSpeechStyleNormalizer.normalize(
                "Write the word um, then say \"uh-oh\" near the UM campus."),
            "Write the word um, then say \"uh-oh\" near the UM campus.")
        XCTAssertEqual(
            LocalSpeechStyleNormalizer.normalize(
                "The song is called \"Gonna Fly Now.\""),
            "The song is called \"Gonna Fly Now.\"")
    }

    func testQwenCleanupAcceptsPresentationOnlyCandidate() async {
        let cleanup = QwenLocalTranscriptCleanup(
            modelRuntime: FakeQwenCleanupModel(output: "I think this is ready."))
        let result = await cleanup.cleanup(
            text: "um, I think this is ready",
            pauses: [])

        XCTAssertEqual(result.text, "I think this is ready.")
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.reason, "speech-normalization-and-qwen")
    }

    func testQwenCleanupRejectsInventedExplanationButKeepsSafeRules() async {
        let cleanup = QwenLocalTranscriptCleanup(
            modelRuntime: FakeQwenCleanupModel(
                output: "UM means the University of Michigan."))
        let result = await cleanup.cleanup(
            text: "I'm gonna call the UM campus.",
            pauses: [])

        XCTAssertEqual(result.text, "I'm going to call the UM campus.")
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.reason, "speech-normalization-qwen-unsafe-fallback")
    }

    func testQwenCleanupFallsBackWhenRuntimeFails() async {
        let cleanup = QwenLocalTranscriptCleanup(
            modelRuntime: FakeQwenCleanupModel(error: FakeQwenError.failed))
        let result = await cleanup.cleanup(
            text: "We wanna go, um.",
            pauses: [])

        XCTAssertEqual(result.text, "We want to go.")
        XCTAssertEqual(result.reason, "speech-normalization-qwen-unavailable")
    }

    @MainActor
    func testQwenManagerSurfacesPreparationFailureForFallbackUI() async {
        let manager = QwenCleanupModelManager(
            runtime: FakeQwenCleanupModel(error: FakeQwenError.failed))

        do {
            try await manager.prepare()
            XCTFail("Expected model preparation to fail")
        } catch {
            XCTAssertEqual(manager.state, .failed("fake Qwen runtime failed"))
        }
    }

    func testLongCleanupInputIsChunkedWithoutDroppingWords() {
        let input = (1...150).map { "word\($0)" }.joined(separator: " ")
        let chunks = TranscriptCleanupChunker.chunks(input)

        XCTAssertEqual(chunks.count, 3)
        XCTAssertTrue(chunks.allSatisfy {
            $0.split(whereSeparator: { $0.isWhitespace }).count
                <= TranscriptCleanupChunker.maximumWords
        })
        XCTAssertEqual(chunks.joined(separator: " "), input)
    }
}

private actor FakeQwenCleanupModel: QwenCleanupModelRuntimeProtocol {
    private let output: String?
    private let error: Error?

    init(output: String) {
        self.output = output
        self.error = nil
    }

    init(error: Error) {
        self.output = nil
        self.error = error
    }

    func prepare(
        progress: (@Sendable (QwenCleanupLoadProgress) -> Void)?
    ) async throws {
        if let error { throw error }
    }

    func rewrite(text: String) async throws -> String {
        if let error { throw error }
        return output ?? text
    }
}

private enum FakeQwenError: LocalizedError {
    case failed

    var errorDescription: String? { "fake Qwen runtime failed" }
}
