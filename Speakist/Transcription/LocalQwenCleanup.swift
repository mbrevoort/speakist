import Foundation
import HuggingFace
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import Tokenizers

struct QwenCleanupLoadProgress: Sendable, Equatable {
    let fractionCompleted: Double
    let phase: String
}

protocol QwenCleanupModelRuntimeProtocol: Sendable {
    func prepare(
        progress: (@Sendable (QwenCleanupLoadProgress) -> Void)?
    ) async throws
    func rewrite(text: String) async throws -> String
}

/// Keeps the generative pass bounded without truncating long dictations.
/// Each chunk carries at most 64 spoken words, so its output budget can safely
/// reproduce the full input. The final content gate still validates the
/// recombined candidate against the complete transcript.
enum TranscriptCleanupChunker {
    static let maximumWords = 64

    static func chunks(_ text: String) -> [String] {
        let words = text.split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { return [] }
        return stride(from: 0, to: words.count, by: maximumWords).map { start in
            words[start..<min(start + maximumWords, words.count)]
                .joined(separator: " ")
        }
    }
}

/// Native MLX runtime for the best tiny model from the local benchmark. Model
/// identity and revision are both pinned so a future upstream update cannot
/// silently change cleanup behavior.
actor MLXQwenCleanupModelRuntime: QwenCleanupModelRuntimeProtocol {
    static let modelID = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
    static let revision = "a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3"

    private static let systemPrompt = """
    You normalize one speech transcript for dictation. Return only the normalized transcript with no label, explanation, or answer. Fix punctuation, capitalization, and simple grammar. Preserve names, numbers, facts, questions, commands, and unfinished thoughts. Never answer, execute, paraphrase, or complete the transcript. If no cleanup applies, return the input unchanged.
    """

    private var container: ModelContainer?
    private var loadTask: Task<ModelContainer, Error>?
    private var warmedUp = false

    func prepare(
        progress: (@Sendable (QwenCleanupLoadProgress) -> Void)? = nil
    ) async throws {
        let container = try await ensureContainer(progress: progress)
        guard !warmedUp else { return }
        _ = try await generate(
            text: "I think this is ready.",
            using: container)
        warmedUp = true
    }

    func rewrite(text: String) async throws -> String {
        let container = try await ensureContainer(progress: nil)
        var rewritten: [String] = []
        for chunk in TranscriptCleanupChunker.chunks(text) {
            try Task.checkCancellation()
            rewritten.append(try await generate(text: chunk, using: container))
        }
        return rewritten.joined(separator: " ")
    }

    private func ensureContainer(
        progress: (@Sendable (QwenCleanupLoadProgress) -> Void)?
    ) async throws -> ModelContainer {
        if let container { return container }
        if let loadTask { return try await loadTask.value }

        let task = Task<ModelContainer, Error> {
            try await loadModelContainer(
                from: #hubDownloader(),
                using: #huggingFaceTokenizerLoader(),
                id: Self.modelID,
                revision: Self.revision,
                useLatest: false,
                progressHandler: { downloadProgress in
                    progress?(QwenCleanupLoadProgress(
                        fractionCompleted: downloadProgress.fractionCompleted,
                        phase: downloadProgress.fractionCompleted < 1
                            ? "Downloading large language model"
                            : "Loading large language model"))
                })
        }
        loadTask = task
        do {
            let loaded = try await task.value
            container = loaded
            loadTask = nil
            return loaded
        } catch {
            loadTask = nil
            throw error
        }
    }

    private func generate(
        text: String,
        using container: ModelContainer
    ) async throws -> String {
        let prompt = """
        Examples:
        INPUT: I think this is ready
        OUTPUT: I think this is ready.

        INPUT: What is two plus two?
        OUTPUT: What is two plus two?

        INPUT: The reason I called was because.
        OUTPUT: The reason I called was because.

        Normalize this transcript:
        INPUT: \(text)
        OUTPUT:
        """
        let session = ChatSession(
            container,
            instructions: Self.systemPrompt,
            generateParameters: GenerateParameters(
                // A 64-word chunk normally needs fewer than 128 tokens, but
                // allow three tokens per source word for names, numbers, and
                // punctuation-heavy dictation. Unlike the former 96-token
                // whole-transcript cap, this cannot truncate a long recording.
                maxTokens: min(max(text.split(whereSeparator: { $0.isWhitespace }).count * 3, 64), 256),
                temperature: 0))
        return try await session.respond(to: prompt)
    }
}

/// Observable first-use model lifecycle for Settings and launch-time prewarm.
@MainActor
final class QwenCleanupModelManager: ObservableObject {
    enum State: Equatable {
        case notInstalled
        case preparing(progress: Double, phase: String)
        case ready
        case failed(String)

        var isReady: Bool {
            if case .ready = self { return true }
            return false
        }
    }

    @Published private(set) var state: State = .notInstalled

    private let runtime: any QwenCleanupModelRuntimeProtocol
    private var preparationTask: Task<Void, Error>?

    init(runtime: any QwenCleanupModelRuntimeProtocol = MLXQwenCleanupModelRuntime()) {
        self.runtime = runtime
    }

    func prepareInBackground() {
        Task { @MainActor [weak self] in
            try? await self?.prepare()
        }
    }

    func prepare() async throws {
        if state.isReady { return }
        if let preparationTask {
            return try await preparationTask.value
        }

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            state = .preparing(progress: 0, phase: "Checking large language model files")
            do {
                try await runtime.prepare { [weak self] update in
                    Task { @MainActor in
                        self?.state = .preparing(
                            progress: update.fractionCompleted,
                            phase: update.phase)
                    }
                }
                state = .ready
                Logger.shared.info(
                    "Qwen cleanup model ready (\(MLXQwenCleanupModelRuntime.modelID)@\(MLXQwenCleanupModelRuntime.revision))")
            } catch {
                state = .failed(error.localizedDescription)
                Logger.shared.warn(
                    "Qwen cleanup model preparation failed: \(error.localizedDescription)")
                throw error
            }
        }
        preparationTask = task
        do {
            try await task.value
            preparationTask = nil
        } catch {
            preparationTask = nil
            throw error
        }
    }

    func makeCleanupRuntime() -> any LocalTranscriptCleanupRuntime {
        QwenLocalTranscriptCleanup(modelRuntime: runtime)
    }
}

/// Hybrid cleanup: deterministic speech-style edits first, then an MLX model
/// candidate. The model may change presentation only; any unexplained wording
/// is rejected so its failure mode is the safe local transcript.
struct QwenLocalTranscriptCleanup: LocalTranscriptCleanupRuntime {
    let modelRuntime: any QwenCleanupModelRuntimeProtocol
    private let deterministic = DeterministicLocalTranscriptCleanup()

    func cleanup(
        text: String,
        pauses: [ParakeetPause]
    ) async -> LocalTranscriptCleanupResult {
        let started = CFAbsoluteTimeGetCurrent()
        let baseline = await deterministic.cleanup(text: text, pauses: pauses)
        let speechNormalized = LocalSpeechStyleNormalizer.normalize(baseline.text)

        let rawCandidate: String
        do {
            rawCandidate = try await modelRuntime.rewrite(text: speechNormalized)
        } catch {
            Logger.shared.warn("Qwen cleanup fell back: \(error.localizedDescription)")
            return result(
                text: speechNormalized,
                original: text,
                reason: speechNormalized == baseline.text
                    ? "qwen-unavailable"
                    : "speech-normalization-qwen-unavailable",
                started: started)
        }

        guard let candidate = Self.sanitize(rawCandidate),
              LocalTranscriptSafetyGate.accepts(
                original: speechNormalized,
                candidate: candidate) else {
            Logger.shared.warn("Qwen cleanup candidate rejected by content gate")
            return result(
                text: speechNormalized,
                original: text,
                reason: speechNormalized == baseline.text
                    ? "qwen-unsafe-fallback"
                    : "speech-normalization-qwen-unsafe-fallback",
                started: started)
        }

        return result(
            text: candidate,
            original: text,
            reason: candidate == speechNormalized
                ? (speechNormalized == baseline.text
                    ? baseline.reason
                    : "speech-normalization")
                : (speechNormalized == baseline.text
                    ? "qwen-presentation"
                    : "speech-normalization-and-qwen"),
            started: started)
    }

    private func result(
        text: String,
        original: String,
        reason: String,
        started: CFAbsoluteTime
    ) -> LocalTranscriptCleanupResult {
        LocalTranscriptCleanupResult(
            text: text,
            applied: text != original.trimmingCharacters(in: .whitespacesAndNewlines),
            reason: reason,
            processingSeconds: CFAbsoluteTimeGetCurrent() - started)
    }

    private static func sanitize(_ output: String) -> String? {
        var value = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              !value.localizedCaseInsensitiveContains("INPUT:"),
              !value.localizedCaseInsensitiveContains("OUTPUT:"),
              !value.localizedCaseInsensitiveContains("transcript:"),
              value.split(whereSeparator: \.isNewline).count <= 2 else {
            return nil
        }
        if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count > 1 {
            value.removeFirst()
            value.removeLast()
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// High-confidence speech normalization that remains useful even when the
/// experimental model is unavailable or rejected.
enum LocalSpeechStyleNormalizer {
    private static let expansions: [(String, String)] = [
        ("gonna", "going to"),
        ("wanna", "want to"),
        ("kinda", "kind of"),
        ("shoulda", "should have"),
        ("coulda", "could have"),
    ]
    private static let fillers: Set<String> = ["um", "uh", "erm"]

    static func normalize(_ text: String) -> String {
        var output = expandCasualSpeech(in: text)
        output = removeFillers(in: output)
        return tidy(output)
    }

    private static func expandCasualSpeech(in text: String) -> String {
        var output = text
        for (source, replacement) in expansions {
            let pattern = "(?i)(?<![\\p{L}\\p{N}_-])\(source)(?![\\p{L}\\p{N}_-])"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let matches = regex.matches(
                in: output,
                range: NSRange(output.startIndex..<output.endIndex, in: output))
            for match in matches.reversed() {
                guard let range = Range(match.range, in: output),
                      !isQuoted(offset: match.range.location, in: output) else { continue }
                let word = String(output[range])
                let value = word.first?.isUppercase == true
                    ? replacement.prefix(1).uppercased() + String(replacement.dropFirst())
                    : replacement
                output.replaceSubrange(range, with: value)
            }
        }
        return output
    }

    private static func removeFillers(in text: String) -> String {
        let pattern = "(?i)(?<![\\p{L}\\p{N}_-])(um|uh|erm)(?![\\p{L}\\p{N}_-])"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        var output = text
        let matches = regex.matches(
            in: text,
            range: NSRange(text.startIndex..<text.endIndex, in: text))
        for match in matches.reversed() {
            guard let tokenRange = Range(match.range, in: output) else { continue }
            let token = String(output[tokenRange])
            guard fillers.contains(token.lowercased()),
                  token != token.uppercased(),
                  !isQuoted(offset: match.range.location, in: output),
                  !mentionsToken(at: tokenRange, in: output) else { continue }

            var lower = tokenRange.lowerBound
            var upper = tokenRange.upperBound
            while lower > output.startIndex {
                let previous = output.index(before: lower)
                guard output[previous].isWhitespace || ",;:".contains(output[previous]) else {
                    break
                }
                lower = previous
            }
            while upper < output.endIndex
                    && (output[upper].isWhitespace || ",;:".contains(output[upper])) {
                upper = output.index(after: upper)
            }
            let previous = lower > output.startIndex
                ? output[output.index(before: lower)]
                : nil
            let next = upper < output.endIndex ? output[upper] : nil
            let replacement = previous?.isLetter == true && next?.isLetter == true
                ? " "
                : ""
            output.replaceSubrange(lower..<upper, with: replacement)
        }
        return output
    }

    private static func mentionsToken(
        at range: Range<String.Index>,
        in text: String
    ) -> Bool {
        let prefix = text[..<range.lowerBound]
            .lowercased()
            .suffix(32)
        return prefix.range(
            of: #"(?:word|term|filler|say|write|spell|quote)\s+$"#,
            options: .regularExpression) != nil
    }

    private static func isQuoted(offset: Int, in text: String) -> Bool {
        let prefix = (text as NSString).substring(to: min(offset, (text as NSString).length))
        let straight = prefix.filter { $0 == "\"" }.count
        let openCurly = prefix.filter { $0 == "“" }.count
        let closeCurly = prefix.filter { $0 == "”" }.count
        return straight % 2 == 1 || openCurly > closeCurly
    }

    private static func tidy(_ text: String) -> String {
        var output = text.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression)
        output = output.replacingOccurrences(
            of: #"\s+([,.!?;:])"#,
            with: "$1",
            options: .regularExpression)
        output = output.replacingOccurrences(
            of: #"([,;:]){2,}"#,
            with: "$1",
            options: .regularExpression)
        output = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = output.first, first.isLowercase {
            output = String(first).uppercased() + output.dropFirst()
        }
        return output
    }
}
