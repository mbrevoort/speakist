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

    /// The streaming session opened at record-start (when
    /// `useStreamingTranscription` is on), consumed by `buildClient` at
    /// key-release. Nil when streaming is off or between recordings.
    private var activeStream: StreamingTranscribeSession?

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

    // MARK: - Streaming session lifecycle

    /// Open a real-time streaming session for the recording that's about to
    /// start. Returns the session (so the caller can wire the audio tap's
    /// PCM sink to it) or nil when streaming isn't applicable — off by
    /// pref, not on the proxy path, or not signed in. `buildClient` picks
    /// it up at key-release; if it's never consumed, `endStreamingSession`
    /// tears it down.
    func beginStreamingSession() -> StreamingTranscribeSession? {
        guard preferences.useTranscribeProxy,
              preferences.useStreamingTranscription,
              accountManager.isSignedIn,
              let token = accountManager.bearerToken, !token.isEmpty else {
            return nil
        }
        let session = StreamingTranscribeSession(
            apiBaseURL: preferences.apiBaseURL,
            bearerToken: token,
            transcriptionClientId: UUID().uuidString,
            language: preferences.language.isEmpty ? nil : preferences.language,
            keyterms: VocabularyBuilder.keyterms(from: correctionStore),
            replaceRules: VocabularyBuilder.replaceRules(from: correctionStore),
            dictation: preferences.dictationMode,
            fillerWords: preferences.includeFillerWords,
            measurements: preferences.convertMeasurements,
            profanityFilter: preferences.maskProfanity,
            detectLanguage: preferences.autoDetectLanguage,
            polishSkip: false)
        session.open()
        activeStream = session
        return session
    }

    /// Cancel + drop an unconsumed streaming session (recording aborted or
    /// discarded before transcription). No-op once `buildClient` has taken
    /// ownership of it.
    func endStreamingSession() {
        activeStream?.cancel()
        activeStream = nil
    }

    func process(_ request: TranscriptionRequest) async {
        // Safety net: if we return early (e.g. not signed in) without
        // buildClient consuming the streaming session, don't leak the open
        // socket. On the happy path buildClient has already niled this, so
        // the cancel is a no-op.
        defer {
            activeStream?.cancel()
            activeStream = nil
        }
        hud.setTranscribing()

        // Per-stage cumulative ms relative to the user releasing the
        // shortcut key — captured by ShortcutManager.pushUp. Logged at
        // the end of process() so we get a single line per recording
        // showing where the release-to-paste budget went. Use the new
        // SpeakistTranscribeClient log line for the network/worker
        // breakdown that lives inside the `transcribe` window here.
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

        // 1. Need a Speakist session before we can mint a Deepgram token.
        guard accountManager.isSignedIn else {
            notifier.missingApiKey(provider: "Speakist")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Not signed in")
            return
        }

        // 2. Build the transcription client. Phase A default: proxy through
        //    the Speakist Worker via /api/transcribe. The legacy direct-
        //    Deepgram path (mint ephemeral key + POST to api.deepgram.com)
        //    is still reachable by flipping `useTranscribeProxy` off.
        let client: any TranscriptionClient
        do {
            client = try await buildClient(transcriptionClientId: entryID)
            Logger.shared.info("PERF process \(ms("clientBuilt"))")
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
            Logger.shared.warn("Transcription client build failed: \(String(describing: error))")
            notifier.transcriptionFailed("Couldn't start transcription.")
            hud.hide()
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            errorMessage: "Client build failed")
            return
        }

        let keyterms = VocabularyBuilder.keyterms(from: correctionStore)
        let language = preferences.language.isEmpty ? nil : preferences.language

        // 3. Transcribe (1 retry for transient failures).
        //
        // `finalText` is what we paste / display / store as finalTranscript
        // — on the proxy path this is the post-polish result, on the
        // legacy Deepgram-direct path polish doesn't run so it's just
        // the raw STT.
        //
        // `rawSttText` is the pre-polish output, preserved separately
        // so a "Report bad transcription" submission carries the
        // actual upstream STT string. Falls back to `finalText` when
        // result.rawText is nil — that's the legacy Deepgram-direct
        // path (where raw == final by construction) and older Worker
        // builds (where the server didn't yet return rawText).
        var finalText = ""
        var rawSttText = ""
        var audioSeconds = request.recording.durationSeconds
        do {
            let result = try await withRetry {
                try await client.transcribe(audioURL: request.recording.url,
                                            keyterms: keyterms,
                                            language: language)
            }
            Logger.shared.info("PERF process \(ms("transcribeReturned"))")
            finalText = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            rawSttText = (result.rawText ?? result.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if result.audioSeconds > 0 {
                audioSeconds = result.audioSeconds
            }
        } catch SpeakistAPIClient.Error.insufficientCredit {
            // Surfaced from SpeakistTranscribeClient when server returns 402
            // mid-request (e.g., balance raced since the pre-check). Same
            // UX as the pre-check hit above.
            notifier.transcriptionFailed("Out of credit. Top up at \(preferences.apiBaseURL.absoluteString)/dashboard/billing")
            saveFailedEntry(id: entryID, createdAt: createdAt, durationMs: durationMs,
                            audioURL: request.recording.url, bundleID: focus.bundleID,
                            providerLabel: client.providerLabel, modelLabel: client.modelLabel,
                            errorMessage: "Insufficient credit")
            hud.hide()
            return
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

        if finalText.isEmpty {
            Logger.shared.info("empty transcript, nothing to paste")
            hud.hide()
            audioArchive.discard(tempURL: request.recording.url)
            return
        }

        // 4. Paste.
        let outcome = await cursorInserter.insert(
            text: finalText,
            hasEditableFocus: focus.hasEditableFocus,
            bundleID: focus.bundleID
        )
        Logger.shared.info("PERF process \(ms("pasted"))")
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
            rawTranscript: rawSttText,
            finalTranscript: finalText,
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

        // 6. Report usage to Speakist so the ledger debits — but only on
        // the legacy path. When `useTranscribeProxy` is on, the Worker's
        // /api/transcribe endpoint debited inline, so we skip this call.
        // This branching lives here (not at call sites below) so the Phase A
        // proxy flow is one HTTP round-trip total from Mac's perspective.
        if !preferences.useTranscribeProxy {
            Task.detached { [weak self, entryID, finalText, audioSeconds, modelLabel = client.modelLabel] in
                guard let self else { return }
                await self.reportUsage(
                    transcriptionClientId: entryID,
                    wordCount: Self.wordCount(finalText),
                    audioMs: Int(audioSeconds * 1000),
                    model: modelLabel
                )
            }
        }

        playStopSound()
        hud.hide()

        Analytics.shared.capture("transcription_completed", properties: [
            "platform": "mac",
            "provider": client.providerLabel,
            "model": client.modelLabel,
            "audio_seconds": audioSeconds,
            "duration_ms": durationMs,
            "word_count": Self.wordCount(finalText),
            "paste_status": pasteStatus,
            "target_bundle_id": focus.bundleID ?? "",
        ])
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
                                         client: any TranscriptionClient) {
        let message = error.localizedDescription
        if let te = error as? TranscriptionError, te.isAuthFailure {
            // Auth failure on the transcribe-proxy path means the Mac's
            // bearer token was rejected (session revoked) or the Worker's
            // provider key is busted — either way, a Speakist-side problem.
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

        Analytics.shared.capture("transcription_failed", properties: [
            "platform": "mac",
            "provider": providerLabel,
            "model": modelLabel,
            "duration_ms": durationMs,
            "error_message": errorMessage,
            "target_bundle_id": bundleID ?? "",
        ])
    }

    // MARK: - Build transcription client

    /// Returns the transcription client to use for this request.
    ///
    /// * `useTranscribeProxy` ON (Phase A default) → `SpeakistTranscribeClient`
    ///   which POSTs the audio to our Worker's /api/transcribe. No ephemeral
    ///   key mint, no separate /api/usage call — the Worker debits inline.
    ///
    /// * `useTranscribeProxy` OFF (legacy fallback) → mint a short-lived
    ///   Deepgram ephemeral key and hand it to a `DeepgramClient` that
    ///   POSTs audio directly to api.deepgram.com.
    private func buildClient(transcriptionClientId: String) async throws -> any TranscriptionClient {
        let replaceRules = VocabularyBuilder.replaceRules(from: correctionStore)

        if preferences.useTranscribeProxy {
            guard let token = try? keychainToken(), !token.isEmpty else {
                throw SpeakistAPIClient.Error.notSignedIn
            }
            // Provider + model are no longer chosen client-side. The
            // Worker picks based on the user's chosen language and the
            // org's super-admin-configured allowed-models list (defaults:
            // English → Groq Whisper Turbo; other languages → Groq Whisper
            // Large). Deepgram-specific toggles (dictation, fillerWords,
            // etc.) are still passed for all providers — the server's
            // per-provider adapter picks what it understands and ignores
            // the rest, so there's no harm sending them to Groq.
            let batch = SpeakistTranscribeClient(
                apiBaseURL: preferences.apiBaseURL,
                bearerToken: token,
                transcriptionClientId: transcriptionClientId,
                dictation: preferences.dictationMode,
                fillerWords: preferences.includeFillerWords,
                measurements: preferences.convertMeasurements,
                profanityFilter: preferences.maskProfanity,
                detectLanguage: preferences.autoDetectLanguage,
                replaceRules: replaceRules)

            // Streaming path: a session was opened at record-start and fed
            // live PCM. Finalize it here; on any transport failure the
            // wrapper falls back to `batch` uploading the WAV. Take
            // ownership so the process()-level cleanup defer doesn't cancel
            // a session we're about to use.
            if let stream = activeStream {
                activeStream = nil
                return StreamingTranscribeClient(session: stream, fallback: batch)
            }
            return batch
        }

        // Legacy path — mint ephemeral key and call Deepgram directly.
        let token = try await apiClient.mintDeepgramToken()
        return DeepgramClient(
            apiKey: token.key,
            model: preferences.deepgramModel,
            dictation: preferences.dictationMode,
            fillerWords: preferences.includeFillerWords,
            measurements: preferences.convertMeasurements,
            profanityFilter: preferences.maskProfanity,
            detectLanguage: preferences.autoDetectLanguage,
            replaceRules: replaceRules)
    }

    /// Pull the Mac session bearer token from the account manager. Same
    /// Keychain slot the SpeakistAPIClient uses via its tokenProvider
    /// closure, just read directly because SpeakistTranscribeClient needs
    /// the raw token at construction time (not per-request).
    private func keychainToken() throws -> String {
        accountManager.bearerToken ?? ""
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
