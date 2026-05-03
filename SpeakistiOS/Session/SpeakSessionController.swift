import Foundation
import Combine
import AVFoundation
import UIKit

/// Owns the lifecycle of a Speak Session end-to-end:
///
///   1. URL scheme lands → transition to `.activating`, configure
///      `AVAudioSession`, show ListeningOverlay.
///   2. User swipes right (iOS 26.4's mandatory return-to-previous-app
///      gesture) → we detect via `UIApplication.willResignActiveNotification`
///      → transition to `.listening`, start `AudioRecorder`.
///   3. User taps checkmark in the keyboard → Darwin `keyboardRequestedFinish`
///      lands → stop recording, upload to `/api/transcribe`, stream back
///      partial + final transcripts via AppGroupBridge + Darwin notifications.
///   4. Session auto-expires after the configured idle window (default
///      5 min) if the user never swipes back or the keyboard never finishes.
///
/// This is the single source of truth the rest of the iOS app reads from;
/// it publishes `status` and keeps AppGroupBridge's shared UserDefaults in
/// sync so the keyboard sees the same state we do.
@MainActor
final class SpeakSessionController: ObservableObject {
    @Published private(set) var status: SpeakSessionStatus = .idle
    @Published private(set) var lastError: String?
    /// Seconds since epoch; nil when there's no pending timeout (e.g. idle).
    @Published private(set) var sessionExpiresAt: Date?

    /// True when we should be rendering the full-screen listening card.
    var isActivatingOrListening: Bool {
        status == .activating || status == .listening
    }

    private var recorder: AudioRecorder?
    private var darwinTokens: [UUID] = []
    private var expiryTimer: Timer?
    /// Host app bundle ID captured from AppGroupBridge at session start.
    /// May be nil — iOS doesn't expose the host reliably; we store it
    /// with the history entry if the keyboard was able to sniff it.
    private var currentHostBundleID: String?

    private let history: HistoryStore
    private let tokenProvider: () -> String?
    private let baseURL: URL

    /// Default idle window before we tear down an unused session. Matches
    /// Wispr Flow's default (5 min); real impl will expose this in Settings.
    private let defaultSessionDuration: TimeInterval = 5 * 60

    init(history: HistoryStore,
         baseURL: URL = SpeakistChannel.current.defaultAPIBaseURL,
         tokenProvider: @escaping () -> String?) {
        self.history = history
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        wireDarwinObservers()
        wireSystemObservers()
        pushStatusToSharedDefaults()
    }

    private var systemObservers: [NSObjectProtocol] = []

    // MARK: - Pending-request handoff (iOS-26 workaround)

    /// Check whether the keyboard left a pending session request the
    /// last time it was tapped, and if so auto-start a session. Called
    /// from SpeakistApp on every `didBecomeActiveNotification`.
    ///
    /// Freshness window is 60 seconds. If the user taps Speakist in
    /// the keyboard, then takes longer than that to actually open the
    /// Speakist app, the request is considered stale and discarded —
    /// they can tap the keyboard button again.
    func consumePendingKeyboardRequest() {
        guard let defaults = AppGroupBridge.defaults else { return }
        let stamp = defaults.double(forKey: AppGroupBridge.Key.pendingSessionRequestAt)
        guard stamp > 0 else { return }
        let age = Date().timeIntervalSince1970 - stamp
        // Always clear on read so retrying doesn't double-fire.
        defaults.removeObject(forKey: AppGroupBridge.Key.pendingSessionRequestAt)
        guard age < 60 else {
            Logger.shared.info("pending request stale (age=\(Int(age))s), ignoring")
            return
        }
        Logger.shared.info("consuming pending keyboard session request (age=\(Int(age))s)")
        // Skip activation if we're already mid-session — avoids racing
        // with a session the user manually started in the app.
        if case .idle = status {
            let host = defaults.string(forKey: AppGroupBridge.Key.currentHostBundleID)
            self.currentHostBundleID = host
            startActivating(hostBundleID: host, tone: nil)
        }
    }

    // MARK: - URL scheme entry point

    func handle(route: URLSchemeRoute) {
        switch route {
        case .startSession(let host, let tone):
            Logger.shared.info("URL scheme start-session host=\(host ?? "?") tone=\(tone ?? "?")")
            self.currentHostBundleID = host
            startActivating(hostBundleID: host, tone: tone)
        case .cancelSession:
            Logger.shared.info("URL scheme cancel-session")
            teardown(reason: "cancel")
        case .openApp:
            // Brand-icon tap from the keyboard. The URL scheme is just
            // a transport for foreground promotion; iOS already brought
            // the app forward by the time we got here. No session work
            // to do — just log it.
            Logger.shared.info("URL scheme open-app (brand-icon tap)")
        }
    }

    /// Cancel the current session from the ListeningOverlay's X
    /// button. Unlike `returnToIdle` this works from any phase —
    /// listening, activating, etc. — so the user can bail out of the
    /// flow whenever. Releases the recorder, deactivates the audio
    /// session, clears state, and broadcasts the change so the
    /// keyboard re-renders.
    func cancelSession() {
        Logger.shared.info("session cancelled from overlay X")
        teardown(reason: "overlay-cancel")
    }

    // MARK: - State transitions

    func startActivating(hostBundleID: String?, tone: String?) {
        status = .activating
        lastError = nil
        sessionExpiresAt = Date().addingTimeInterval(defaultSessionDuration)
        pushStatusToSharedDefaults()

        // Configure the AVAudioSession for record + background playback.
        // Background-audio entitlement keeps the mic live while the
        // user is swiping back to the host app so no words get lost.
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetooth, .mixWithOthers, .duckOthers])
            try s.setActive(true)
        } catch {
            Logger.shared.warn("AVAudioSession setup failed: \(error.localizedDescription)")
            lastError = "Couldn't activate microphone"
            status = .error
            pushStatusToSharedDefaults()
            return
        }

        startExpiryTimer()

        // Prepare the recorder — installs the mic tap and starts the
        // engine, but does NOT yet write frames to disk (the tap
        // drops buffers until `startCapture()` flips the flag). Two
        // reasons to start the engine now, before the user asks:
        //
        //   1. The `audio` UIBackgroundMode only keeps us alive while
        //      the audio engine is actively running. Without it, iOS
        //      suspends us inside ~30 seconds of backgrounding — and
        //      then the user's subsequent `.keyboardRequestedActivation`
        //      Darwin notification has no live process to land on.
        //   2. Warming the mic up front makes Begin Speaking's round-
        //      trip-to-recording latency imperceptible — the engine
        //      is already producing frames, we just start archiving.
        //
        // The orange mic indicator in iOS's status bar will light up
        // here, which is accurate: we ARE using the mic, just not
        // recording to a file.
        do {
            let recorder = AudioRecorder()
            // Wire live level callback → shared UserDefaults so the
            // keyboard's WaveformView can read it and react. The callback
            // fires on main actor; we only publish during `.listening`
            // so the bars stay quiet while the mic is merely warm.
            recorder.onLevel { [weak self] level in
                self?.publishMicLevel(level)
            }
            try recorder.prepare()
            self.recorder = recorder
        } catch {
            Logger.shared.error("recorder prepare failed: \(error.localizedDescription)")
            lastError = "Couldn't prepare microphone"
            status = .error
            pushStatusToSharedDefaults()
        }
    }

    private func publishMicLevel(_ level: Float) {
        // Only meaningful during listening — mic is warm during
        // `.activating` too but we don't want bars jumping before the
        // user taps Begin Speaking.
        guard status == .listening, let defaults = AppGroupBridge.defaults else { return }
        defaults.set(Double(level), forKey: AppGroupBridge.Key.micLevel)
        defaults.set(Date().timeIntervalSince1970, forKey: AppGroupBridge.Key.micLevelAt)
    }

    func startRecordingIfReady() {
        guard status == .activating, let recorder else {
            Logger.shared.warn("startRecordingIfReady: status=\(status) recorder=\(recorder != nil)")
            return
        }
        // Engine is already running from `startActivating`'s prepare()
        // — flip the capture flag so tap frames start landing in the
        // output file. The round-trip from tap to recorder-started is
        // effectively zero because the engine never stopped.
        recorder.startCapture()
        status = .listening
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appStateChanged)
    }

    func finishAndTranscribe() {
        guard status == .listening, let recorder else { return }

        status = .transcribing
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appStateChanged)

        Task {
            do {
                let audioURL = try await recorder.stop()
                Logger.shared.info("recorded \(audioURL.lastPathComponent)")
                await self.transcribeAndPublish(audioURL: audioURL)
            } catch {
                Logger.shared.error("recorder stop failed: \(error.localizedDescription)")
                self.lastError = "Recording failed"
                self.status = .error
                self.pushStatusToSharedDefaults()
            }
        }
    }

    private func transcribeAndPublish(audioURL: URL) async {
        guard let token = tokenProvider(), !token.isEmpty else {
            Logger.shared.warn("finishAndTranscribe called without a signed-in token")
            lastError = "Sign in to Speakist before dictating."
            status = .error
            pushStatusToSharedDefaults()
            try? FileManager.default.removeItem(at: audioURL)
            return
        }

        let client = SpeakistTranscribeClient(apiBaseURL: baseURL, bearerToken: token)
        do {
            let result = try await client.transcribe(audioURL: audioURL)
            // Record history so keyboard-driven dictations show up in
            // the same list as Quick Dictate entries.
            history.append(HistoryEntry(
                text: result.text,
                audioSeconds: result.audioSeconds,
                source: .keyboard(hostBundleID: currentHostBundleID),
                providerModel: result.providerModelLabel
            ))
            Analytics.shared.capture("transcription_completed", properties: [
                "platform": "ios",
                "provider_model": result.providerModelLabel,
                "audio_seconds": result.audioSeconds,
                "word_count": result.text.split(whereSeparator: { $0.isWhitespace }).count,
                "host_bundle_id": currentHostBundleID ?? "",
            ])
            await publishFinal(text: result.text)
        } catch {
            Logger.shared.warn("transcribe failed: \(String(describing: error))")
            let message: String
            if let t = error as? TranscriptionError {
                message = t.errorDescription ?? "Transcription failed"
            } else {
                message = "Transcription failed"
            }
            lastError = message
            status = .error
            pushStatusToSharedDefaults()
            Analytics.shared.capture("transcription_failed", properties: [
                "platform": "ios",
                "error_message": message,
                "host_bundle_id": currentHostBundleID ?? "",
            ])
            // Broadcast a state-change so the keyboard can surface the
            // error pill even though there's no final transcript to
            // insert. Without this the keyboard looks frozen on
            // "Transcribing…".
            DarwinNotifier.post(.appStateChanged)
            // Error states also auto-reset so the keyboard doesn't
            // sit on a stale error line forever.
            scheduleReturnToIdle(after: 2.2)
        }

        try? FileManager.default.removeItem(at: audioURL)
    }

    private func publishFinal(text: String) async {
        AppGroupBridge.defaults?.set(text, forKey: AppGroupBridge.Key.finalTranscript)
        let seq = (AppGroupBridge.defaults?.integer(forKey: AppGroupBridge.Key.transcriptSequence) ?? 0) + 1
        AppGroupBridge.defaults?.set(seq, forKey: AppGroupBridge.Key.transcriptSequence)
        status = .done
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appPublishedFinal)
        // After success, don't fully tear down — re-arm into
        // `.activating` so the user can tap Begin Speaking again with
        // zero friction. The full teardown only happens on expiry or
        // error.
        scheduleReturnToArmed(after: 1.4)
    }

    /// After a successful dictation, flip back to `.activating` (mic
    /// warm, engine running, not capturing). The keyboard will render
    /// the Begin Speaking button directly — no Start Speakist detour,
    /// no app switch. The session expiry timer (already running from
    /// the original `startActivating`) will tear down after a few
    /// minutes of inactivity.
    private func scheduleReturnToArmed(after seconds: TimeInterval) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            await MainActor.run {
                self?.returnToArmed()
            }
        }
    }

    private func returnToArmed() {
        guard status == .done else { return }
        // The recorder from the previous round already stopped (file
        // written + uploaded). Build a fresh one for the next round —
        // same AVAudioSession, same engine-warm pattern. If this
        // fails, fall back to a full teardown so the user isn't left
        // staring at a stuck "Transcribing…" keyboard.
        recorder = nil
        do {
            let recorder = AudioRecorder()
            recorder.onLevel { [weak self] level in
                self?.publishMicLevel(level)
            }
            try recorder.prepare()
            self.recorder = recorder
            lastError = nil
            status = .activating
            sessionExpiresAt = Date().addingTimeInterval(defaultSessionDuration)
            startExpiryTimer()
            pushStatusToSharedDefaults()
            DarwinNotifier.post(.appStateChanged)
        } catch {
            Logger.shared.warn("returnToArmed: re-prepare failed (\(error.localizedDescription)); falling back to idle")
            returnToIdle()
        }
    }

    /// Full teardown — releases the audio session, stops the recorder,
    /// flips to `.idle`. Used on expiry, error, or explicit cancel.
    private func scheduleReturnToIdle(after seconds: TimeInterval) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            await MainActor.run {
                self?.returnToIdle()
            }
        }
    }

    private func returnToIdle() {
        // Only reset from terminal states.
        guard status == .done || status == .error || status == .activating else { return }
        recorder?.cancel()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        expiryTimer?.invalidate()
        expiryTimer = nil
        lastError = nil
        sessionExpiresAt = nil
        status = .idle
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appStateChanged)
    }

    private func teardown(reason: String) {
        Logger.shared.info("session teardown: \(reason)")
        expiryTimer?.invalidate()
        expiryTimer = nil

        recorder?.cancel()
        recorder = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])

        status = .idle
        sessionExpiresAt = nil
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appStateChanged)
    }

    // MARK: - Shared-state mirroring

    private func pushStatusToSharedDefaults() {
        guard let defaults = AppGroupBridge.defaults else { return }
        defaults.set(status.rawValue, forKey: AppGroupBridge.Key.sessionStatus)
        if let exp = sessionExpiresAt {
            defaults.set(exp.timeIntervalSince1970, forKey: AppGroupBridge.Key.sessionExpiresAt)
        } else {
            defaults.removeObject(forKey: AppGroupBridge.Key.sessionExpiresAt)
        }
        defaults.set(lastError, forKey: AppGroupBridge.Key.lastError)
    }

    // MARK: - Darwin observers

    private func wireDarwinObservers() {
        darwinTokens.append(DarwinNotifier.shared.observe(.keyboardRequestedFinish) { [weak self] in
            self?.finishAndTranscribe()
        })
        darwinTokens.append(DarwinNotifier.shared.observe(.keyboardRequestedCancel) { [weak self] in
            self?.teardown(reason: "keyboard-cancel")
        })
        // Keyboard's "Begin Speaking" button — fires this to promote
        // the session from `.activating` to `.listening`.
        darwinTokens.append(DarwinNotifier.shared.observe(.keyboardRequestedActivation) { [weak self] in
            self?.startRecordingIfReady()
        })
    }

    /// Subscribe to system audio events that can take the mic away
    /// from us mid-flow. The big one in practice: tapping the iOS
    /// system dictation mic that sits outside our keyboard extension
    /// — that icon is drawn by iOS and we can't suppress it, so the
    /// only viable defense is to detect the interruption AVAudioSession
    /// posts when iOS seizes the mic, kill our session, and let the
    /// keyboard re-render to typing mode so the user can re-trigger
    /// Speakist on a clean slate. Same path covers Siri, phone calls,
    /// and any other audio-grabbing notifier.
    private func wireSystemObservers() {
        let token = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            // Hop to the actor before mutating state — we declared
            // queue: .main but Swift 6 still requires explicit isolation.
            Task { @MainActor [weak self] in
                self?.handleAudioInterruption(note)
            }
        }
        systemObservers.append(token)
    }

    private func handleAudioInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeRaw = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw)
        else { return }

        // Only `.began` is actionable for us. `.ended` would let us
        // resume on Apple's nudge, but the dictation case isn't a
        // resumable interruption — by the time iOS posts `.ended`,
        // dictation has handed the mic back but our recorder is gone
        // and the user has likely moved on. Better to require an
        // explicit re-tap of Start Speakist than to fire-up a stale
        // session in the background.
        guard type == .began else { return }

        // Idle/done sessions don't care about audio interruptions.
        guard status == .activating || status == .listening else { return }

        Logger.shared.warn("audio interrupted by system — ending Speakist session")

        // Release resources immediately so we're not feeding bytes
        // into a dead audio session. Don't call teardown() — it sets
        // status to .idle, but we want a brief .error window so the
        // keyboard surfaces a hint before snapping back to typing.
        recorder?.cancel()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        expiryTimer?.invalidate()
        expiryTimer = nil

        lastError = "Microphone taken by another app — tap Start Speakist to retry"
        status = .error
        sessionExpiresAt = nil
        pushStatusToSharedDefaults()
        DarwinNotifier.post(.appStateChanged)
        // After ~2.5s the keyboard's transient banner auto-hides; the
        // controller drops back to .idle so the next tap of Start
        // Speakist starts a fresh session.
        scheduleReturnToIdle(after: 2.5)
    }

    // MARK: - Auto-expiry

    private func startExpiryTimer() {
        expiryTimer?.invalidate()
        expiryTimer = Timer.scheduledTimer(withTimeInterval: defaultSessionDuration, repeats: false) { [weak self] _ in
            Task { @MainActor in
                // When the armed window expires without use, release
                // the audio session so iOS can suspend us properly.
                // If we're still armed (`.activating`) at this point
                // the user hasn't used the keyboard in 5 minutes —
                // safe to fully cool down.
                self?.returnToIdle()
            }
        }
    }
}
