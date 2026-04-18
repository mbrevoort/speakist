import Foundation
import AppKit

struct TranscriptionRequest {
    let recording: RecordingResult
    let skipCleanup: Bool
    let maxDurationHit: Bool
}

@MainActor
final class TranscriptionService {
    private let preferences: Preferences
    private let keychain: KeychainStore
    private let correctionStore: CorrectionStore
    private let historyStore: HistoryStore
    private let audioArchive: AudioArchive
    private let cursorInserter: CursorInserter
    private let focusedFieldProbe: FocusedFieldProbe
    private let hud: HUDController
    private let notifier: Notifier
    private let usage: UsageTracker

    init(preferences: Preferences,
         keychain: KeychainStore,
         correctionStore: CorrectionStore,
         historyStore: HistoryStore,
         audioArchive: AudioArchive,
         cursorInserter: CursorInserter,
         focusedFieldProbe: FocusedFieldProbe,
         hud: HUDController,
         notifier: Notifier,
         usage: UsageTracker) {
        self.preferences = preferences
        self.keychain = keychain
        self.correctionStore = correctionStore
        self.historyStore = historyStore
        self.audioArchive = audioArchive
        self.cursorInserter = cursorInserter
        self.focusedFieldProbe = focusedFieldProbe
        self.hud = hud
        self.notifier = notifier
        self.usage = usage
    }

    func process(_ request: TranscriptionRequest) async {
        hud.setTranscribing()

        let focus = focusedFieldProbe.probe()
        let entryID = UUID().uuidString
        let createdAt = Date()
        let durationMs = Int(request.recording.durationSeconds * 1000)

        if request.maxDurationHit {
            notifier.maxDurationHit(minutes: max(preferences.maxDurationSec / 60, 1))
        }

        guard let client = buildClient() else {
            let provider = preferences.activeProvider
            notifier.missingApiKey(provider: provider.displayName)
            hud.hide()
            let archivedURL = audioArchive.archive(tempURL: request.recording.url, id: entryID)
            historyStore.save(TranscriptionEntry(
                id: entryID,
                createdAt: createdAt,
                durationMs: durationMs,
                provider: provider.rawValue,
                model: "",
                rawTranscript: "",
                finalTranscript: "",
                cleanupApplied: false,
                audioPath: archivedURL?.path,
                targetBundleID: focus.bundleID,
                pasteStatus: "failed",
                transcriptionStatus: "failed",
                errorMessage: "API key missing",
                editedAt: nil))
            return
        }

        let keyterms = VocabularyBuilder.keyterms(
            for: preferences.activeProvider,
            from: correctionStore)
        let language = preferences.language.isEmpty ? nil : preferences.language

        // 1) Transcribe with 1 retry.
        var rawText = ""
        var audioSeconds = request.recording.durationSeconds
        do {
            let result = try await withRetry {
                try await client.transcribe(audioURL: request.recording.url,
                                            keyterms: keyterms,
                                            language: language)
            }
            rawText = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if result.audioSeconds > 0 {
                audioSeconds = result.audioSeconds
            }
        } catch {
            Logger.shared.warn("transcribe failed: \(error.localizedDescription)")
            handleTranscribeFailure(error: error,
                                    entryID: entryID,
                                    createdAt: createdAt,
                                    durationMs: durationMs,
                                    audioURL: request.recording.url,
                                    bundleID: focus.bundleID,
                                    client: client)
            hud.hide()
            return
        }

        if rawText.isEmpty {
            Logger.shared.info("empty transcript, nothing to paste")
            hud.hide()
            audioArchive.discard(tempURL: request.recording.url)
            return
        }

        // 2) Optional cleanup pass.
        var finalText = rawText
        var cleanupApplied = false
        var cleanupIn = 0
        var cleanupOut = 0
        var cleanupError: String?

        let shouldCleanup = preferences.cleanupEnabled && !request.skipCleanup
        if shouldCleanup, let openAIKey = keychain.get(.openai), !openAIKey.isEmpty {
            let cleanup = CleanupClient(apiKey: openAIKey, model: preferences.cleanupModel)
            let dict = preferences.includeCorrectionsInCleanup
                ? VocabularyBuilder.cleanupDictionary(from: correctionStore)
                : [:]
            do {
                let result = try await cleanup.clean(
                    rawTranscript: rawText,
                    systemPrompt: preferences.cleanupSystemPrompt,
                    corrections: dict)
                finalText = result.text.isEmpty ? rawText : result.text
                cleanupApplied = true
                cleanupIn = result.inputTokens
                cleanupOut = result.outputTokens
            } catch {
                cleanupError = error.localizedDescription
                Logger.shared.warn("cleanup failed, using raw transcript: \(error.localizedDescription)")
            }
        }

        // 3) Paste.
        let outcome = await cursorInserter.insert(text: finalText, hasEditableFocus: focus.hasEditableFocus)
        let pasteStatus: String
        switch outcome {
        case .pasted: pasteStatus = "pasted"
        case .clipboardOnly:
            pasteStatus = "clipboard_only"
            notifier.pasteFailed()
        case .failed:
            pasteStatus = "failed"
            notifier.pasteFailed()
        }

        // 4) Persist.
        let archivedURL = audioArchive.archive(tempURL: request.recording.url, id: entryID)
        let entry = TranscriptionEntry(
            id: entryID,
            createdAt: createdAt,
            durationMs: durationMs,
            provider: client.providerLabel,
            model: client.modelLabel,
            rawTranscript: rawText,
            finalTranscript: finalText,
            cleanupApplied: cleanupApplied,
            audioPath: archivedURL?.path,
            targetBundleID: focus.bundleID,
            pasteStatus: pasteStatus,
            transcriptionStatus: cleanupError == nil ? "ok" : "cleanup_failed",
            errorMessage: cleanupError,
            editedAt: nil)
        historyStore.save(entry)
        usage.record(provider: client.providerLabel,
                     model: client.modelLabel,
                     audioSeconds: audioSeconds,
                     cleanupInputTokens: cleanupApplied ? cleanupIn : nil,
                     cleanupOutputTokens: cleanupApplied ? cleanupOut : nil)

        // 5) Finish.
        playStopSound()
        hud.hide()
    }

    func retranscribe(entryID: String) async {
        guard let entry = try? historyStore.get(id: entryID),
              let path = entry.audioPath else { return }
        let url = URL(fileURLWithPath: path)
        let recording = RecordingResult(url: url, durationSeconds: Double(entry.durationMs) / 1000.0)
        // Copy to a temp URL since `process` may move / delete it.
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("Speakist-retry-\(UUID().uuidString).wav")
        try? FileManager.default.copyItem(at: url, to: tempURL)
        await process(TranscriptionRequest(
            recording: RecordingResult(url: tempURL, durationSeconds: recording.durationSeconds),
            skipCleanup: false,
            maxDurationHit: false))
    }

    // MARK: - Failure path

    private func handleTranscribeFailure(error: Error,
                                         entryID: String,
                                         createdAt: Date,
                                         durationMs: Int,
                                         audioURL: URL,
                                         bundleID: String?,
                                         client: TranscriptionClient) {
        let message = error.localizedDescription
        if let te = error as? TranscriptionError, te.isAuthFailure {
            notifier.apiKeyRejected(provider: client.providerLabel)
        } else {
            notifier.transcriptionFailed(message)
        }
        let archivedURL = audioArchive.archive(tempURL: audioURL, id: entryID)
        historyStore.save(TranscriptionEntry(
            id: entryID,
            createdAt: createdAt,
            durationMs: durationMs,
            provider: client.providerLabel,
            model: client.modelLabel,
            rawTranscript: "",
            finalTranscript: "",
            cleanupApplied: false,
            audioPath: archivedURL?.path,
            targetBundleID: bundleID,
            pasteStatus: "failed",
            transcriptionStatus: "failed",
            errorMessage: message,
            editedAt: nil))
    }

    // MARK: - Helpers

    private func buildClient() -> TranscriptionClient? {
        switch preferences.activeProvider {
        case .deepgram:
            guard let key = keychain.get(.deepgram), !key.isEmpty else { return nil }
            return DeepgramClient(apiKey: key, model: preferences.deepgramModel)
        case .openai:
            guard let key = keychain.get(.openai), !key.isEmpty else { return nil }
            return OpenAITranscribeClient(apiKey: key, model: preferences.openaiTranscribeModel)
        }
    }

    private func withRetry<T>(_ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch let error as TranscriptionError where !error.isAuthFailure {
            try await Task.sleep(nanoseconds: 500_000_000)
            return try await work()
        }
    }

    private func playStopSound() {
        guard preferences.playSounds else { return }
        NSSound(named: "Pop")?.play()
    }
}
