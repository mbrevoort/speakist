import Foundation
import FluidAudio

struct ParakeetRuntimeResult: Sendable, Equatable {
    let text: String
    let audioSeconds: Double
    let processingSeconds: Double
    let pauses: [ParakeetPause]

    init(
        text: String,
        audioSeconds: Double,
        processingSeconds: Double,
        pauses: [ParakeetPause] = []
    ) {
        self.text = text
        self.audioSeconds = audioSeconds
        self.processingSeconds = processingSeconds
        self.pauses = pauses
    }
}

struct ParakeetLoadProgress: Sendable, Equatable {
    let fractionCompleted: Double
    let phase: String
}

protocol ParakeetRuntimeProtocol: Sendable {
    func prepare(
        progress: (@Sendable (ParakeetLoadProgress) -> Void)?
    ) async throws
    func transcribe(audioURL: URL) async throws -> ParakeetRuntimeResult
}

/// Owns FluidAudio's Core ML objects and serializes model loading/inference.
/// Model files are downloaded by FluidAudio once and cached under
/// ~/Library/Application Support/FluidAudio/Models.
actor ParakeetRuntime: ParakeetRuntimeProtocol {
    private var manager: AsrManager?
    private var loadTask: Task<AsrManager, Error>?

    func prepare(
        progress: (@Sendable (ParakeetLoadProgress) -> Void)? = nil
    ) async throws {
        _ = try await ensureManager(progress: progress)
    }

    func transcribe(audioURL: URL) async throws -> ParakeetRuntimeResult {
        let started = CFAbsoluteTimeGetCurrent()
        let manager = try await ensureManager(progress: nil)
        let decoderLayers = await manager.decoderLayerCount
        var decoderState = TdtDecoderState.make(decoderLayers: decoderLayers)
        let result = try await manager.transcribe(
            audioURL,
            decoderState: &decoderState)
        return ParakeetRuntimeResult(
            text: result.text,
            audioSeconds: result.duration,
            processingSeconds: CFAbsoluteTimeGetCurrent() - started,
            pauses: Self.pauseBoundaries(from: result.tokenTimings))
    }

    private func ensureManager(
        progress: (@Sendable (ParakeetLoadProgress) -> Void)?
    ) async throws -> AsrManager {
        if let manager { return manager }
        if let loadTask { return try await loadTask.value }

        let task = Task<AsrManager, Error> {
            let models = try await AsrModels.downloadAndLoad(
                version: .v2,
                encoderPrecision: .int8,
                progressHandler: { update in
                    progress?(Self.map(update))
                })
            return AsrManager(config: .default, models: models)
        }
        loadTask = task
        do {
            let loaded = try await task.value
            manager = loaded
            loadTask = nil
            return loaded
        } catch {
            loadTask = nil
            throw error
        }
    }

    private nonisolated static func map(_ progress: DownloadProgress) -> ParakeetLoadProgress {
        let phase: String
        switch progress.phase {
        case .listing:
            phase = "Checking model files"
        case .downloading(let completed, let total):
            phase = "Downloading model (\(completed) of \(total) files)"
        case .compiling(let modelName):
            phase = "Preparing \(modelName)"
        }
        return ParakeetLoadProgress(
            fractionCompleted: progress.fractionCompleted,
            phase: phase)
    }

    private nonisolated static func pauseBoundaries(
        from timings: [TokenTiming]?
    ) -> [ParakeetPause] {
        guard let timings, timings.count > 1 else { return [] }
        let words = buildWordTimings(from: timings)
        guard words.count > 1 else { return [] }

        return words.dropLast().enumerated().compactMap { index, word in
            let next = words[index + 1]
            let gap = next.startTime - word.endTime
            guard gap >= 0.55 else { return nil }
            return ParakeetPause(afterWordIndex: index, seconds: gap)
        }
    }
}

@MainActor
final class ParakeetModelManager: ObservableObject {
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

    @Published private(set) var state: State

    private let runtime: any ParakeetRuntimeProtocol
    private var preparationTask: Task<Void, Error>?

    init(runtime: any ParakeetRuntimeProtocol = ParakeetRuntime()) {
        self.runtime = runtime
        let cache = AsrModels.defaultCacheDirectory(for: .v2)
        self.state = AsrModels.modelsExist(
            at: cache,
            version: .v2,
            encoderPrecision: .int8)
            ? .preparing(progress: 0, phase: "Loading cached model")
            : .notInstalled
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
            try await self.runPreparation()
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

    func makeClient(
        replaceRules: [ReplaceRule],
        cleanupRuntime: any LocalTranscriptCleanupRuntime = DeterministicLocalTranscriptCleanup()
    ) -> ParakeetTranscriptionClient {
        ParakeetTranscriptionClient(
            runtime: runtime,
            replaceRules: replaceRules,
            cleanupRuntime: cleanupRuntime)
    }

    private func runPreparation() async throws {
        let cache = AsrModels.defaultCacheDirectory(for: .v2)
        let cached = AsrModels.modelsExist(
            at: cache,
            version: .v2,
            encoderPrecision: .int8)
        state = .preparing(
            progress: 0,
            phase: cached ? "Loading cached model" : "Starting model download")
        do {
            try await runtime.prepare { [weak self] update in
                Task { @MainActor in
                    self?.state = .preparing(
                        progress: update.fractionCompleted,
                        phase: update.phase)
                }
            }
            state = .ready
            Logger.shared.info("Parakeet model ready (tdt-0.6b-v2-int8)")
        } catch {
            state = .failed(error.localizedDescription)
            Logger.shared.warn("Parakeet model preparation failed: \(error.localizedDescription)")
            throw error
        }
    }
}

struct ParakeetTranscriptionClient: TranscriptionClient {
    static let modelName = "tdt-0.6b-v2-int8"

    let runtime: any ParakeetRuntimeProtocol
    let replaceRules: [ReplaceRule]
    let cleanupRuntime: any LocalTranscriptCleanupRuntime

    var providerLabel: String { "parakeet" }
    var modelLabel: String { Self.modelName }

    init(
        runtime: any ParakeetRuntimeProtocol,
        replaceRules: [ReplaceRule],
        cleanupRuntime: any LocalTranscriptCleanupRuntime = DeterministicLocalTranscriptCleanup()
    ) {
        self.runtime = runtime
        self.replaceRules = replaceRules
        self.cleanupRuntime = cleanupRuntime
    }

    func transcribe(
        audioURL: URL,
        keyterms: [String],
        language: String?
    ) async throws -> TranscriptionResult {
        do {
            let result = try await runtime.transcribe(audioURL: audioURL)
            let corrected = LocalTranscriptCorrections.applyWithCount(
                to: result.text,
                rules: replaceRules)
            let cleanup = await cleanupRuntime.cleanup(
                text: corrected.text,
                pauses: result.pauses)
            Logger.shared.info(String(
                format: "PERF local parakeet inference=%.0fms cleanup=%.0fms audio=%.2fs rtfx=%.1f rules=%d replacements=%d cleanup_applied=%d reason=%@ pauses=%d",
                result.processingSeconds * 1000,
                cleanup.processingSeconds * 1000,
                result.audioSeconds,
                result.processingSeconds > 0
                    ? result.audioSeconds / result.processingSeconds
                    : 0,
                replaceRules.count,
                corrected.replacementCount,
                cleanup.applied ? 1 : 0,
                cleanup.reason,
                result.pauses.count))
            return TranscriptionResult(
                text: cleanup.text,
                rawText: result.text == cleanup.text ? nil : result.text,
                cleanupApplied: cleanup.applied,
                providerModelLabel: "\(providerLabel) \(modelLabel)",
                audioSeconds: result.audioSeconds)
        } catch is CancellationError {
            throw TranscriptionError.canceled
        } catch let error as TranscriptionError {
            throw error
        } catch {
            throw TranscriptionError.localModel(error.localizedDescription)
        }
    }
}

/// Apply the user's explicit vocabulary replacements after local ASR. This
/// preserves Deepgram's existing case-insensitive, whole-token behavior
/// without requiring a second network or language-model pass.
enum LocalTranscriptCorrections {
    static func apply(to text: String, rules: [ReplaceRule]) -> String {
        applyWithCount(to: text, rules: rules).text
    }

    static func applyWithCount(
        to text: String,
        rules: [ReplaceRule]
    ) -> (text: String, replacementCount: Int) {
        var output = text
        var replacementCount = 0
        for rule in rules.prefix(200) where rule.isValid {
            let find = rule.find.trimmingCharacters(in: .whitespacesAndNewlines)
            let replacement = rule.replacement.trimmingCharacters(in: .whitespacesAndNewlines)
            let escaped = NSRegularExpression.escapedPattern(for: find)
            let pattern = "(?i)(?<![\\p{L}\\p{N}_])\(escaped)(?![\\p{L}\\p{N}_])"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            let matchCount = regex.numberOfMatches(in: output, range: range)
            guard matchCount > 0 else { continue }
            output = regex.stringByReplacingMatches(
                in: output,
                range: range,
                withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
            replacementCount += matchCount
        }
        return (output, replacementCount)
    }
}
