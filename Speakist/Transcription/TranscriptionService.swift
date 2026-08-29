import Foundation
import AppKit

struct TranscriptionRequest {
    let recording: RecordingResult
    let maxDurationHit: Bool
}

/// Runs the complete dictation pipeline on this Mac: speech recognition,
/// guarded language-model cleanup, exact vocabulary replacement, paste, and
/// local history. It has no account, telemetry, or network transcription path.
@MainActor
final class TranscriptionService {
    private let preferences: Preferences
    private let parakeetModel: ParakeetModelManager
    private let qwenCleanupModel: QwenCleanupModelManager
    private let correctionStore: CorrectionStore
    private let historyStore: HistoryStore
    private let audioArchive: AudioArchive
    private let cursorInserter: CursorInserter
    private let focusedFieldProbe: FocusedFieldProbe
    private let hud: HUDController
    private let notifier: Notifier
    private let usage: UsageTracker

    init(preferences: Preferences,
         parakeetModel: ParakeetModelManager,
         qwenCleanupModel: QwenCleanupModelManager,
         correctionStore: CorrectionStore,
         historyStore: HistoryStore,
         audioArchive: AudioArchive,
         cursorInserter: CursorInserter,
         focusedFieldProbe: FocusedFieldProbe,
         hud: HUDController,
         notifier: Notifier,
         usage: UsageTracker) {
        self.preferences = preferences
        self.parakeetModel = parakeetModel
        self.qwenCleanupModel = qwenCleanupModel
        self.correctionStore = correctionStore
        self.historyStore = historyStore
        self.audioArchive = audioArchive
        self.cursorInserter = cursorInserter
        self.focusedFieldProbe = focusedFieldProbe
        self.hud = hud
        self.notifier = notifier
        self.usage = usage
    }

    var modelsReady: Bool {
        parakeetModel.state.isReady && qwenCleanupModel.state.isReady
    }

    func prepareModelsInBackground() {
        parakeetModel.prepareInBackground()
        qwenCleanupModel.prepareInBackground()
    }

    func process(_ request: TranscriptionRequest) async {
        hud.setTranscribing()

        let baseline = ShortcutManager.releaseStartedAt
        func ms(_ label: String) -> String {
            let dt = (CFAbsoluteTimeGetCurrent() - baseline) * 1000
            return String(format: "%@=+%.0fms", label, dt)
        }
        Logger.shared.info("PERF process \(ms("enter"))")

        let focus = focusedFieldProbe.probe()
        let entryID = UUID().uuidString
        let createdAt = Date()
        let durationMs = Int(request.recording.durationSeconds * 1000)

        if request.maxDurationHit {
            notifier.maxDurationHit(minutes: max(preferences.maxDurationSec / 60, 1))
        }

        guard modelsReady else {
            prepareModelsInBackground()
            let message = "Speakist is still preparing its on-device models. Open Settings → Transcription to see progress."
            notifier.transcriptionFailed(message)
            hud.hide()
            saveFailedEntry(
                id: entryID,
                createdAt: createdAt,
                durationMs: durationMs,
                audioURL: request.recording.url,
                bundleID: focus.bundleID,
                errorMessage: message)
            return
        }

        let client = makeClient()
        Logger.shared.info("PERF process \(ms("clientBuilt"))")

        let result: TranscriptionResult
        do {
            result = try await client.transcribe(audioURL: request.recording.url)
            Logger.shared.info("PERF process \(ms("transcribeReturned"))")
        } catch {
            Logger.shared.warn("local transcription failed: \(error.localizedDescription)")
            let message = error.localizedDescription
            notifier.transcriptionFailed(message)
            saveFailedEntry(
                id: entryID,
                createdAt: createdAt,
                durationMs: durationMs,
                audioURL: request.recording.url,
                bundleID: focus.bundleID,
                providerLabel: client.providerLabel,
                modelLabel: client.modelLabel,
                errorMessage: message)
            hud.hide()
            return
        }

        let finalText = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawText = (result.rawText ?? result.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalText.isEmpty else {
            Logger.shared.info("empty transcript, nothing to paste")
            hud.hide()
            audioArchive.discard(tempURL: request.recording.url)
            return
        }

        let outcome = await cursorInserter.insert(
            text: finalText,
            hasEditableFocus: focus.hasEditableFocus,
            bundleID: focus.bundleID)
        Logger.shared.info("PERF process \(ms("pasted"))")

        let pasteStatus: String
        switch outcome {
        case .pasted:
            pasteStatus = "pasted"
        case .clipboardOnly:
            pasteStatus = "clipboard_only"
            notifier.pasteFailed()
        case .failed:
            pasteStatus = "failed"
            notifier.pasteFailed()
        }

        let archivedURL = audioArchive.archive(tempURL: request.recording.url, id: entryID)
        historyStore.save(TranscriptionEntry(
            id: entryID,
            createdAt: createdAt,
            durationMs: durationMs,
            provider: client.providerLabel,
            model: client.modelLabel,
            rawTranscript: rawText,
            finalTranscript: finalText,
            cleanupApplied: result.cleanupApplied,
            audioPath: archivedURL?.path,
            targetBundleID: focus.bundleID,
            pasteStatus: pasteStatus,
            transcriptionStatus: "ok",
            errorMessage: nil,
            editedAt: nil))
        usage.record(
            provider: client.providerLabel,
            model: client.modelLabel,
            audioSeconds: result.audioSeconds > 0
                ? result.audioSeconds
                : request.recording.durationSeconds)

        playStopSound()
        hud.hide()
    }

    func retranscribe(entryID: String) async {
        guard let entry = try? historyStore.get(id: entryID),
              let path = entry.audioPath else { return }
        let source = URL(fileURLWithPath: path)
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("Speakist-retry-\(UUID().uuidString).wav")
        try? FileManager.default.copyItem(at: source, to: tempURL)
        await process(TranscriptionRequest(
            recording: RecordingResult(
                url: tempURL,
                durationSeconds: Double(entry.durationMs) / 1000.0),
            maxDurationHit: false))
    }

    func transcribeForPreview(audioURL: URL) async throws -> TranscriptionResult {
        guard modelsReady else {
            prepareModelsInBackground()
            throw TranscriptionError.localModel(
                "Speakist is still preparing its on-device models.")
        }
        return try await makeClient().transcribe(audioURL: audioURL)
    }

    private func makeClient() -> ParakeetTranscriptionClient {
        parakeetModel.makeClient(
            replaceRules: VocabularyBuilder.replaceRules(from: correctionStore),
            cleanupRuntime: qwenCleanupModel.makeCleanupRuntime())
    }

    private func saveFailedEntry(id: String,
                                 createdAt: Date,
                                 durationMs: Int,
                                 audioURL: URL,
                                 bundleID: String?,
                                 providerLabel: String = "on-device",
                                 modelLabel: String = "",
                                 errorMessage: String) {
        let archivedURL = audioArchive.archive(tempURL: audioURL, id: id)
        historyStore.save(TranscriptionEntry(
            id: id,
            createdAt: createdAt,
            durationMs: durationMs,
            provider: providerLabel,
            model: modelLabel,
            rawTranscript: "",
            finalTranscript: "",
            audioPath: archivedURL?.path,
            targetBundleID: bundleID,
            pasteStatus: "failed",
            transcriptionStatus: "failed",
            errorMessage: errorMessage,
            editedAt: nil))
    }

    private func playStopSound() {
        guard preferences.playSounds else { return }
        NSSound(named: "Pop")?.play()
    }
}
