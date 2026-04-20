import Foundation
import AppKit

struct TranscriptionRequest {
    let recording: RecordingResult
    let maxDurationHit: Bool
}

/// Orchestrates a single transcription end-to-end:
///   1. Mint a short-lived Deepgram key from the Speakist backend
///   2. POST the audio to Deepgram directly (audio never touches our server)
///   3. Paste the result at the user's cursor
///   4. Persist a history entry
///   5. Report usage to Speakist so the credit ledger debits
///
/// Failure modes that need different UX:
///   * Not signed in → prompt user to sign in via Settings
///   * Insufficient credit → toast + open billing page
///   * Deepgram 4xx/5xx → retry once, then save failed history entry
///   * Paste blocked (no editable field) → leave on clipboard + notify
@MainActor
final class TranscriptionService {
    private let preferences: Preferences
    private let accountManager: SpeakistAccountManager
    private let apiClient: SpeakistAPIClient
    private let correctionStore: CorrectionStore
    private let historyStore: HistoryStore
    private let audioArchive: AudioArchive
    private let cursorInserter: CursorInserter
    private let focusedFieldProbe: FocusedFieldProbe
    private let hud: HUDController
    private let notifier: Notifier
    private let usage: UsageTracker

    init(preferences: Preferences,
         accountManager: SpeakistAccountManager,
         apiClient: SpeakistAPIClient,
         correctionStore: CorrectionStore,
         historyStore: HistoryStore,
         audioArchive: AudioArchive,
         cursorInserter: CursorInserter,
         focusedFieldProbe: FocusedFieldProbe,
         hud: HUDController,
         notifier: Notifier,
         usage: UsageTracker) {
        self.preferences = preferences
        self.accountManager = accountManager
        self.apiClient = apiClient
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

        // 1. Need a Speakist session before we can mint a Deepgram token.
        guard accountManager.isSignedIn else {
            notifier.missingApiKey(provider: "Speakist")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Not signed in")
            return
        }

        // 2. Build the Deepgram client with a freshly-minted short-lived key.
        let client: DeepgramClient
        do {
            client = try await buildClient()
        } catch SpeakistAPIClient.Error.insufficientCredit {
            notifier.transcriptionFailed("Out of credit. Top up at \(preferences.apiBaseURL.absoluteString)/dashboard/billing")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Insufficient credit")
            return
        } catch SpeakistAPIClient.Error.notSignedIn {
            notifier.apiKeyRejected(provider: "Speakist")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Session rejected — please sign in again")
            return
        } catch {
            Logger.shared.warn("Deepgram token mint failed: \(String(describing: error))")
            notifier.transcriptionFailed("Couldn't start transcription.")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Token mint failed")
            return
        }

        let keyterms = VocabularyBuilder.keyterms(from: correctionStore)
        let language = preferences.language.isEmpty ? nil : preferences.language

        // 3. Transcribe (1 retry for transient failures).
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

        // 4. Paste.
        let outcome = await cursorInserter.insert(text: rawText, hasEditableFocus: focus.hasEditableFocus)
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

        // 5. Persist local history.
        let archivedURL = audioArchive.archive(tempURL: request.recording.url, id: entryID)
        let entry = TranscriptionEntry(
            id: entryID,
            createdAt: createdAt,
            durationMs: durationMs,
            provider: client.providerLabel,
            model: client.modelLabel,
            rawTranscript: rawText,
            finalTranscript: rawText,
            audioPath: archivedURL?.path,
            targetBundleID: focus.bundleID,
            pasteStatus: pasteStatus,
            transcriptionStatus: "ok",
            errorMessage: nil,
            editedAt: nil)
        historyStore.save(entry)
        usage.record(provider: client.providerLabel,
                     model: client.modelLabel,
                     audioSeconds: audioSeconds)

        // 6. Report usage to Speakist so the ledger debits. Fire-and-forget
        // from the user's perspective — we've already pasted + stored
        // locally. The reporting call deduplicates on entryID, so a network
        // blip leaves us safe for next run (Phase 7: retry queue).
        Task.detached { [weak self, entryID, rawText, audioSeconds, modelLabel = client.modelLabel] in
            guard let self else { return }
            await self.reportUsage(
                transcriptionClientId: entryID,
                wordCount: Self.wordCount(rawText),
                audioMs: Int(audioSeconds * 1000),
                model: modelLabel
            )
        }

        playStopSound()
        hud.hide()
    }

    func retranscribe(entryID: String) async {
        guard let entry = try? historyStore.get(id: entryID),
              let path = entry.audioPath else { return }
        let url = URL(fileURLWithPath: path)
        let recording = RecordingResult(url: url, durationSeconds: Double(entry.durationMs) / 1000.0)
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("Speakist-retry-\(UUID().uuidString).wav")
        try? FileManager.default.copyItem(at: url, to: tempURL)
        await process(TranscriptionRequest(
            recording: RecordingResult(url: tempURL, durationSeconds: recording.durationSeconds),
            maxDurationHit: false))
    }

    // MARK: - Usage reporting

    private func reportUsage(transcriptionClientId: String,
                             wordCount: Int,
                             audioMs: Int?,
                             model: String) async {
        do {
            _ = try await apiClient.reportUsage(
                transcriptionClientId: transcriptionClientId,
                wordCount: wordCount,
                audioMs: audioMs,
                model: model
            )
        } catch {
            Logger.shared.warn("reportUsage failed for \(transcriptionClientId): \(String(describing: error))")
            // TODO(phase-7): queue for retry. For now, unreported events are
            // essentially comped — user gets a transcription we didn't bill.
        }
    }

    private static func wordCount(_ s: String) -> Int {
        s.split(whereSeparator: { $0.isWhitespace }).count
    }

    // MARK: - Failure path

    private func handleTranscribeFailure(error: Error,
                                         entryID: String,
                                         createdAt: Date,
                                         durationMs: Int,
                                         audioURL: URL,
                                         bundleID: String?,
                                         client: DeepgramClient) {
        let message = error.localizedDescription
        if let te = error as? TranscriptionError, te.isAuthFailure {
            // A minted Deepgram token getting rejected means the key ladder
            // is busted on the server side (our project key wrong, or the
            // mint is returning stale keys). Surface as a Speakist-side
            // problem, not a "your Deepgram account" problem.
            notifier.apiKeyRejected(provider: "Speakist")
        } else {
            notifier.transcriptionFailed(message)
        }
        saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                        audioURL: audioURL, bundleID: bundleID,
                        providerLabel: client.providerLabel, modelLabel: client.modelLabel,
                        errorMessage: message)
    }

    private func saveFailedEntry(id: String,
                                 createdAt: Date,
                                 durationMs: Int,
                                 audioURL: URL,
                                 bundleID: String?,
                                 providerLabel: String = "deepgram",
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

    // MARK: - Build Deepgram client

    /// Fetches a short-lived Deepgram key and wraps it in a DeepgramClient
    /// configured with the user's current preferences + correction rules.
    private func buildClient() async throws -> DeepgramClient {
        let token = try await apiClient.mintDeepgramToken()
        return DeepgramClient(
            apiKey: token.key,
            model: preferences.deepgramModel,
            dictation: preferences.dictationMode,
            fillerWords: preferences.includeFillerWords,
            measurements: preferences.convertMeasurements,
            profanityFilter: preferences.maskProfanity,
            detectLanguage: preferences.autoDetectLanguage,
            replaceRules: VocabularyBuilder.replaceRules(from: correctionStore))
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
