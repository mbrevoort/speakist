import Foundation
import Combine
import AppKit
import AVFoundation

/// Mac equivalent of the iOS `QuickDictateController`. Drives a
/// record → transcribe → review → copy flow that lives entirely
/// inside Speakist's main window — handy when the user wants to
/// dictate but isn't focused on an editable field, or when they
/// want to review the transcript before pasting.
///
/// Phases:
///
///   `idle`
///     │  .start()
///     ▼
///   `preparing` ── permission check + engine warmup ──▶ `recording`
///                                                          │
///                                             .stop() ───▶ `transcribing`
///                                                          │
///                                    success ─ `.reviewing` ─ fail ─▶ `.error`
///                                                          │
///                                             .save() ───▶ copies to clipboard,
///                                                           appends to history,
///                                                           then `.done`
///
/// Reuses `AudioRecorder` from the push-to-talk path so the user
/// gets the same input-device selection and audio quality. We don't
/// touch `HUDController` or `CursorInserter` — Quick Dictate is
/// strictly an in-window flow.
@MainActor
final class QuickDictateController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case preparing
        case recording
        case transcribing
        case reviewing(rawText: String, audioSeconds: Double, providerModel: String)
        case error(message: String)
        case done

        static func == (lhs: Phase, rhs: Phase) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.preparing, .preparing), (.recording, .recording),
                 (.transcribing, .transcribing), (.done, .done):
                return true
            case let (.reviewing(a, _, _), .reviewing(b, _, _)):
                return a == b
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    @Published private(set) var phase: Phase = .idle
    /// 0…1 RMS level for the live waveform ring, mirrored from
    /// `AudioRecorder.levels` while we're recording.
    @Published private(set) var level: Float = 0
    /// Two-way bound to the review TextEditor.
    @Published var editedText: String = ""

    private let audioRecorder: AudioRecorder
    private let history: HistoryStore
    private let preferences: Preferences
    private let accountManager: SpeakistAccountManager
    private let audioArchive: AudioArchive
    private let correctionStore: CorrectionStore

    private var levelSubscription: AnyCancellable?
    /// Carried across phases so save() can construct a feedback-ready
    /// TranscriptionEntry without re-driving the network. Cleared on
    /// `reset()` so a discarded session can't leak into the next.
    private var pendingEntryID: String?
    private var pendingAudioURL: URL?
    private var pendingDurationMs: Int = 0

    init(env: AppEnvironment) {
        self.audioRecorder = env.audioRecorder
        self.history = env.historyStore
        self.preferences = env.preferences
        self.accountManager = env.accountManager
        self.audioArchive = env.audioArchive
        self.correctionStore = env.correctionStore
    }

    /// Begin a recording session. Permission gate first so a revoked
    /// mic doesn't crash inside `AVAudioEngine.start()`.
    func start() async {
        guard case .idle = phase else { return }
        pendingEntryID = nil
        pendingAudioURL = nil
        pendingDurationMs = 0
        editedText = ""
        phase = .preparing

        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard granted else {
                phase = .error(message: "Microphone permission is off — enable it in System Settings → Privacy & Security → Microphone.")
                return
            }
        } else if status != .authorized {
            phase = .error(message: "Microphone permission is off — enable it in System Settings → Privacy & Security → Microphone.")
            return
        }

        // Subscribe to levels for the ring animation. Done before
        // `start()` so we don't miss the first few samples while the
        // engine ramps up.
        levelSubscription = audioRecorder.levels
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.level = value }

        do {
            try await audioRecorder.start()
            phase = .recording
        } catch {
            levelSubscription?.cancel()
            levelSubscription = nil
            Logger.shared.warn("Quick Dictate start failed: \(error.localizedDescription)")
            phase = .error(message: "Couldn't start recording: \(error.localizedDescription)")
        }
    }

    /// User clicked Stop. Recorder finalizes, audio uploads to
    /// `/api/transcribe`, and we land in `.reviewing` or `.error`.
    func stop() async {
        guard case .recording = phase else { return }
        phase = .transcribing
        levelSubscription?.cancel()
        levelSubscription = nil
        level = 0

        guard let result = audioRecorder.stop() else {
            phase = .error(message: "Recording produced no audio — try again.")
            return
        }

        guard accountManager.isSignedIn, let token = accountManager.bearerToken, !token.isEmpty else {
            phase = .error(message: "Sign in to Speakist before transcribing.")
            audioArchive.discard(tempURL: result.url)
            return
        }

        let entryID = UUID().uuidString
        let durationMs = Int(result.durationSeconds * 1000)
        pendingEntryID = entryID
        pendingDurationMs = durationMs

        let client = SpeakistTranscribeClient(
            apiBaseURL: preferences.apiBaseURL,
            bearerToken: token,
            transcriptionClientId: entryID,
            dictation: preferences.dictationMode,
            fillerWords: preferences.includeFillerWords,
            measurements: preferences.convertMeasurements,
            profanityFilter: preferences.maskProfanity,
            detectLanguage: preferences.autoDetectLanguage,
            replaceRules: VocabularyBuilder.replaceRules(from: correctionStore))

        let keyterms = VocabularyBuilder.keyterms(from: correctionStore)
        let language = preferences.language.isEmpty ? nil : preferences.language

        do {
            let response = try await client.transcribe(
                audioURL: result.url,
                keyterms: keyterms,
                language: language)
            let raw = response.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty else {
                phase = .error(message: "Didn't catch anything — try again.")
                audioArchive.discard(tempURL: result.url)
                pendingAudioURL = nil
                return
            }
            // Hold the temp audio path; `save()` archives it once the
            // user commits. `cancel()` discards it.
            pendingAudioURL = result.url
            editedText = raw
            phase = .reviewing(rawText: raw,
                               audioSeconds: response.audioSeconds > 0 ? response.audioSeconds : result.durationSeconds,
                               providerModel: response.providerModelLabel)
        } catch {
            Logger.shared.warn("Quick Dictate transcribe failed: \(error.localizedDescription)")
            phase = .error(message: humanMessage(from: error))
            audioArchive.discard(tempURL: result.url)
            pendingAudioURL = nil
        }
    }

    /// Save the (possibly edited) transcript to history + clipboard.
    /// `pasteStatus` is recorded as `clipboard_only` because Quick
    /// Dictate intentionally never auto-pastes — the user is here to
    /// review and copy explicitly.
    func saveAndCopy() {
        guard case .reviewing(let raw, _, let providerModel) = phase else { return }
        let finalText = editedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalText.isEmpty else {
            phase = .error(message: "Nothing to save.")
            return
        }
        guard let entryID = pendingEntryID else { return }

        // Ingest any user edits as corrections so the vocabulary
        // learns from this session, mirroring the push-to-talk path.
        let pairs = DiffEngine.corrections(from: raw, to: finalText)
        if !pairs.isEmpty { correctionStore.ingest(pairs: pairs) }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(finalText, forType: .string)

        var archivedPath: String?
        if let tempURL = pendingAudioURL, preferences.keepAudio {
            archivedPath = audioArchive.archive(tempURL: tempURL, id: entryID)?.path
        } else if let tempURL = pendingAudioURL {
            audioArchive.discard(tempURL: tempURL)
        }

        let providerParts = providerModel.split(separator: " ", maxSplits: 1).map(String.init)
        let providerLabel = providerParts.first ?? "auto"
        let modelLabel = providerParts.count > 1 ? providerParts[1] : ""

        // pasteStatus = "pasted" because Quick Dictate's contract is
        // "land the text on the clipboard so the user can paste it"
        // — i.e., the text successfully reached its destination.
        // The shortcut-driven push-to-talk path uses "clipboard_only"
        // when its synthetic ⌘V *failed* to insert at the cursor;
        // surfacing that same status here would flag every Quick
        // Dictate entry with the ⚠️ "didn't paste" badge in History,
        // which would be misleading.
        history.save(TranscriptionEntry(
            id: entryID,
            createdAt: Date(),
            durationMs: pendingDurationMs,
            provider: providerLabel,
            model: modelLabel,
            rawTranscript: raw,
            finalTranscript: finalText,
            audioPath: archivedPath,
            targetBundleID: nil,
            pasteStatus: "pasted",
            transcriptionStatus: "ok",
            errorMessage: nil,
            editedAt: raw != finalText ? Date() : nil))

        pendingAudioURL = nil
        pendingEntryID = nil
        phase = .done
    }

    /// Discard the recording and tear down cleanly. Safe to call from
    /// any phase — `.recording` stops the engine, `.reviewing` drops
    /// the audio without saving.
    func cancel() {
        levelSubscription?.cancel()
        levelSubscription = nil
        level = 0
        if case .recording = phase {
            audioRecorder.cancel()
        }
        if let tempURL = pendingAudioURL {
            audioArchive.discard(tempURL: tempURL)
            pendingAudioURL = nil
        }
        pendingEntryID = nil
        phase = .idle
    }

    /// Re-arm to record again after a `.done` or `.error` state.
    func reset() {
        cancel()
    }

    private func humanMessage(from error: Error) -> String {
        if let t = error as? TranscriptionError {
            return t.errorDescription ?? "Transcription failed."
        }
        return error.localizedDescription
    }
}
