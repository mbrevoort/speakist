import Foundation
import Combine
import AVFoundation
import UIKit

/// State machine for the Quick Dictate sheet:
///
///   `idle`
///     │  .start()
///     ▼
///   `preparing` ── permission / AVAudioSession setup ──▶ `recording`
///                                                          │
///                                             .stop() ───▶ `transcribing`
///                                                          │
///                                    success ─ .reviewing(text) ─ fail ─▶ `error`
///                                                          │
///                                             .save() ───▶ copies to clipboard,
///                                                           appends to history,
///                                                           then `done`
///
/// Separate controller (not a single SwiftUI view with `@State`) so the
/// recording + upload logic survives view refreshes and is easy to unit
/// test. Parallels SpeakSessionController for the keyboard flow.
@MainActor
final class QuickDictateController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case preparing
        case recording
        case transcribing
        case reviewing(text: String, audioSeconds: Double, providerModel: String?)
        case error(message: String)
        case done
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var level: Float = 0       // 0…1, for waveform
    @Published var editedText: String = ""             // bound to TextEditor

    private let history: HistoryStore
    private let accountFallback: () -> String?         // bearer token provider
    private let baseURL: URL
    private var recorder: AudioRecorder?

    // State carried between transcribe() and saveAndCopy() so the
    // History entry the user actually saves carries the same
    // X-Transcription-Id we used on /api/transcribe (and therefore
    // can be referenced from /api/feedback later). Cleared on each
    // new recording session so a stale id from a discarded run
    // can't leak into the next save.
    fileprivate var lastTranscriptionId: String?
    fileprivate var lastRawTranscript: String?
    fileprivate var lastAudioPath: String?

    init(history: HistoryStore,
         baseURL: URL = SpeakistChannel.current.defaultAPIBaseURL,
         tokenProvider: @escaping () -> String?) {
        self.history = history
        self.baseURL = baseURL
        self.accountFallback = tokenProvider
    }

    /// Entry point: call when the sheet presents. Asks for mic
    /// permission if missing, then starts recording.
    func start() async {
        guard case .idle = phase else { return }
        // Clear feedback-correlation state from any prior run so a
        // discarded earlier recording can't get its id reused on the
        // next save.
        lastTranscriptionId = nil
        lastRawTranscript = nil
        lastAudioPath = nil
        phase = .preparing

        // Permission gate. The onboarding flow already requests mic
        // access, but a user could revoke it in Settings between then
        // and now — handle that gracefully rather than crashing in
        // AVAudioEngine.start().
        if AVAudioApplication.shared.recordPermission != .granted {
            let granted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard granted else {
                phase = .error(message: "Microphone permission is off — enable it in Settings.")
                return
            }
        }

        // Audio session: `.playAndRecord` + `.spokenAudio` mode. iOS
        // only allows `.spokenAudio` on playback-capable categories, so
        // `.record` here throws OSStatus -50 (paramErr). We don't play
        // anything back during Quick Dictate, but `.playAndRecord` is
        // still the right choice — matches the SpeakSessionController
        // setup so behavior is consistent across flows, and the
        // `.mixWithOthers` option means whatever audio the user had
        // running keeps playing underneath without getting ducked.
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord,
                              mode: .spokenAudio,
                              options: [.allowBluetooth, .mixWithOthers, .defaultToSpeaker])
            try s.setActive(true)
        } catch {
            phase = .error(message: "Couldn't activate the microphone: \(error.localizedDescription)")
            return
        }

        let recorder = AudioRecorder()
        recorder.onLevel { [weak self] value in self?.level = value }
        do {
            try recorder.start()
            self.recorder = recorder
            phase = .recording
        } catch {
            phase = .error(message: "Couldn't start recording.")
        }
    }

    /// User tapped Stop. Recorder finalizes, audio uploads to the
    /// server, and we land in `.reviewing` or `.error`.
    func stop() async {
        guard case .recording = phase, let recorder else { return }
        phase = .transcribing

        let audioURL: URL
        do {
            audioURL = try await recorder.stop()
        } catch {
            phase = .error(message: "Recording failed: \(error.localizedDescription)")
            return
        }
        self.recorder = nil

        // Tear the audio session down so the Silent switch stops the
        // system from thinking we're still recording (status bar orange
        // dot). Safe to ignore errors — worst case it lingers.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])

        guard let token = accountFallback(), !token.isEmpty else {
            phase = .error(message: "Sign in to Speakist before transcribing.")
            return
        }

        let client = SpeakistTranscribeClient(apiBaseURL: baseURL, bearerToken: token)
        // Hold onto the transcription id + raw text so saveAndCopy
        // (called later, after the user reviews) can build a feedback-
        // ready HistoryEntry without re-driving the network request.
        // Audio archive happens here too so the user can report even
        // if they save-and-dismiss quickly.
        do {
            let result = try await client.transcribe(audioURL: audioURL)
            let archivedPath = AudioArchive.archive(
                audioURL: audioURL,
                forTranscriptionId: client.transcriptionClientId)
            self.editedText = result.text
            self.lastTranscriptionId = client.transcriptionClientId
            // Preserve the pre-polish STT separately so a later "Report
            // bad transcription" submission carries the actual upstream
            // string. `result.rawText` is nil on older Worker builds
            // (pre rawText-response change) — fall back to `text` then,
            // matching legacy behavior.
            self.lastRawTranscript = result.rawText ?? result.text
            self.lastAudioPath = archivedPath
            self.phase = .reviewing(text: result.text,
                                    audioSeconds: result.audioSeconds,
                                    providerModel: result.providerModelLabel)
        } catch {
            Logger.shared.warn("Quick Dictate transcribe failed: \(String(describing: error))")
            self.phase = .error(message: humanMessage(from: error))
        }

        // The temp audio file has been moved by AudioArchive on
        // success; this remove is a no-op then. On failure (no
        // archive happened) it cleans up the temp file as before.
        try? FileManager.default.removeItem(at: audioURL)
    }

    /// Copy the (possibly edited) text to the pasteboard, append a
    /// history entry, and transition to `.done`. The view then
    /// dismisses the sheet.
    func saveAndCopy() {
        guard case .reviewing(_, let audioSeconds, let providerModel) = phase else { return }
        let text = editedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            phase = .error(message: "Nothing to save.")
            return
        }
        UIPasteboard.general.string = text
        history.append(HistoryEntry(
            text: text,
            audioSeconds: audioSeconds,
            source: .quickDictate,
            providerModel: providerModel,
            rawTranscript: lastRawTranscript,
            transcriptionClientId: lastTranscriptionId,
            audioPath: lastAudioPath
        ))
        phase = .done
    }

    /// Tear down without saving. Used both by the Discard button and
    /// automatic dismissal (the view's `onDisappear`) so the recorder
    /// and audio session always end up clean.
    func cancel() {
        recorder?.cancel()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        if case .done = phase { return }        // already handled
        phase = .done
    }

    private func humanMessage(from error: Error) -> String {
        if let t = error as? TranscriptionError {
            return t.errorDescription ?? "Transcription failed."
        }
        return error.localizedDescription
    }
}
