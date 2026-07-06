import Foundation
import AppKit
import Combine
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    static let pushToTalk = Self("pushToTalk", default: .init(.x, modifiers: [.command, .control]))
    static let toggleRecord = Self("toggleRecord")
}

@MainActor
final class ShortcutManager {
    /// Timestamp of the most recent push-to-talk key-up. Used by
    /// TranscriptionService to log end-to-end "release → paste" latency
    /// against a single shared baseline. `nonisolated(unsafe)` because
    /// it's read from MainActor-isolated code via a regular reference;
    /// torn reads only affect ms-level log accuracy.
    nonisolated(unsafe) static var releaseStartedAt: CFAbsoluteTime = 0

    private let env: AppEnvironment
    private var isToggleRecording = false
    private var recordingStartedAt: Date?
    private var maxDurationTimer: Timer?
    private var didHitMaxDuration = false
    /// In-flight async start initiated by `beginRecording()`. Tracked so
    /// `pushUp()` can detect that the engine is still warming up and
    /// schedule a finish-on-ready instead of dropping the keyup.
    private var pendingStart: Task<Void, Never>?
    /// Set by `pushUp()` if the user releases the shortcut while
    /// `engine.start()` is still running on a background task. The
    /// pending-start completion handler reads this and immediately
    /// finishes the recording so a quick tap doesn't strand the
    /// engine in the recording state with no keyup to terminate it.
    private var releaseRequestedDuringStart = false

    // MARK: - Globe key monitor
    //
    // Push-to-talk on the Globe (🌐 / fn) key can't be wired through
    // KeyboardShortcuts — the sindresorhus library strips `.function`
    // from any captured event and only listens for keyDown, while the
    // Globe key produces `flagsChanged` modifier transitions instead
    // of keyDown. Wispr Flow uses Globe as its default; to match, we
    // run a parallel NSEvent monitor that watches `.flagsChanged` and
    // routes `.function` press/release through the same pushDown /
    // pushUp pipeline as the regular shortcut.
    //
    // Two monitors are needed because NSEvent global/local are
    // exclusive: global only fires when our app isn't key, local only
    // fires when it is. The push-to-talk use case is dominated by the
    // user being in another app (typing somewhere), but we also need
    // it to work when our own Settings window has focus.
    //
    // Both monitor handles are kept so we can uninstall cleanly when
    // the user turns the toggle off — `NSEvent.removeMonitor` requires
    // the exact opaque token returned by the addMonitor call.
    private var globeGlobalMonitor: Any?
    private var globeLocalMonitor: Any?
    /// Tracks the most recent `.function` flag state so a `.flagsChanged`
    /// event for *any other* modifier doesn't mistakenly fire push/release.
    /// `flagsChanged` fires for the entire modifier mask, not just the
    /// key that changed — without this guard, pressing shift while
    /// holding Globe would re-fire pushDown.
    private var globeIsDown = false
    private var prefsSubscription: AnyCancellable?

    init(env: AppEnvironment) {
        self.env = env
    }

    func start() {
        KeyboardShortcuts.onKeyDown(for: .pushToTalk) { [weak self] in
            Task { @MainActor in self?.pushDown() }
        }
        KeyboardShortcuts.onKeyUp(for: .pushToTalk) { [weak self] in
            Task { @MainActor in self?.pushUp() }
        }
        KeyboardShortcuts.onKeyDown(for: .toggleRecord) { [weak self] in
            Task { @MainActor in self?.toggleRecording() }
        }

        // Install/uninstall Globe monitor based on the current
        // preference; re-evaluate whenever Preferences emits a
        // change. The sync method is idempotent so unrelated
        // preference changes are no-ops.
        syncGlobeMonitor()
        prefsSubscription = env.preferences.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.syncGlobeMonitor() }
    }

    private func syncGlobeMonitor() {
        if env.preferences.useGlobeKey {
            installGlobeMonitor()
        } else {
            uninstallGlobeMonitor()
        }
    }

    private func installGlobeMonitor() {
        guard globeGlobalMonitor == nil else { return }
        // Both monitor closures dispatch through `Task { @MainActor }`
        // rather than calling pushDown/pushUp directly. Running the
        // recording-start path synchronously inside the NSEvent
        // handler (i.e. mid-event-dispatch) causes the first HUD
        // show to race with AppKit's layout pass — the panel ends up
        // narrower than its canonical size and the gradient border
        // overflows. The runloop hop matches what the
        // KeyboardShortcuts library does for the regular shortcut
        // path, which doesn't have this problem.
        globeGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            guard let self else { return }
            Task { @MainActor in self.handleGlobeFlagsChanged(event) }
        }
        globeLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            guard let self else { return event }
            Task { @MainActor in self.handleGlobeFlagsChanged(event) }
            return event
        }
        Logger.shared.info("Globe key monitor installed")
    }

    /// Filter `.flagsChanged` events down to actual Globe-key
    /// transitions and route them through pushDown / pushUp.
    /// `flagsChanged` reports the full modifier mask on every change,
    /// so a shift tap during dictation would otherwise look like
    /// another Globe transition — the `globeIsDown` guard ignores
    /// events where the `.function` state hasn't actually flipped.
    private func handleGlobeFlagsChanged(_ event: NSEvent) {
        let isDown = event.modifierFlags.contains(.function)
        guard isDown != globeIsDown else { return }
        globeIsDown = isDown
        if isDown { pushDown() } else { pushUp() }
    }

    private func uninstallGlobeMonitor() {
        if let m = globeGlobalMonitor {
            NSEvent.removeMonitor(m)
            globeGlobalMonitor = nil
        }
        if let m = globeLocalMonitor {
            NSEvent.removeMonitor(m)
            globeLocalMonitor = nil
        }
        // If Globe was held when the toggle was flipped off, treat
        // it as released so the engine doesn't think it's still
        // mid-recording (otherwise pushDown would be skipped on next
        // press due to the "is already recording" guard).
        if globeIsDown {
            globeIsDown = false
            pushUp()
        }
    }

    // MARK: - Push-to-talk

    private func pushDown() {
        guard !env.preferences.shortcutPaused else { return }
        guard handlePermissionPrecondition() else { return }
        // Debounce: ignore key-down while a prior recording is still transcribing.
        if env.hudController.state == .transcribing { return }
        if env.audioRecorder.isRecording { return }
        // Drop repeat key-downs that arrive while a previous press is
        // still warming up the engine on a background task.
        if pendingStart != nil { return }
        // Pre-warm the network path to the Worker so TLS + the V8
        // isolate are hot by the time the user releases the key. Fire-
        // and-forget HEAD against the lightweight /api/me endpoint —
        // we don't care about the response, only the connection state.
        // Measurement showed first-of-session auth at 629ms vs warm at
        // 67ms (live press 1 vs press 2); a HEAD started at key-down
        // and a recording held for ≥200ms hides that 562ms cold spike.
        prewarmTranscriptionConnection()
        beginRecording()
    }

    private func prewarmTranscriptionConnection() {
        let url = URL(string: "/api/me", relativeTo: env.preferences.apiBaseURL)
        guard let url else { return }
        let token = env.accountManager.bearerToken
        Task.detached(priority: .userInitiated) {
            var req = URLRequest(url: url)
            req.httpMethod = "HEAD"
            req.timeoutInterval = 5
            if let token, !token.isEmpty {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            // We don't care about the result — failures here just mean
            // the actual transcribe call will pay the cold-connection
            // cost itself, which is the status quo.
            _ = try? await URLSession.shared.data(for: req)
        }
    }

    /// Check mic + accessibility. Returns `true` only if both are granted
    /// and recording can proceed.
    ///
    /// The branching matters: when a permission is `.notDetermined` (fresh
    /// install, TCC has no record yet), we need to actually *trigger* the
    /// OS prompt — just opening System Settings → Privacy doesn't help,
    /// because the app won't even appear in that list until it's invoked
    /// the matching permission API at least once. Only once the user has
    /// explicitly denied (`.denied`) does the Settings toggle exist for
    /// them to flip.
    ///
    /// Historic bug this fixes: pre-this-refactor, `.notDetermined` fell
    /// into the same branch as `.denied` and opened System Settings →
    /// Microphone, where users couldn't find their Speakist entry (because
    /// we'd never prompted) — and ended up thinking the shortcut was
    /// broken.
    private func handlePermissionPrecondition() -> Bool {
        switch env.permissions.mic {
        case .granted:
            break
        case .notDetermined:
            Logger.shared.info("Shortcut pressed with mic=.notDetermined; triggering OS prompt")
            Task { _ = await env.permissions.requestMicrophone() }
            return false
        case .denied:
            Logger.shared.warn("Shortcut blocked: microphone permission is denied")
            NSSound(named: "Funk")?.play()
            env.permissions.openMicrophoneSettings()
            env.notifier.micDenied()
            return false
        }
        switch env.permissions.accessibility {
        case .granted:
            break
        case .notDetermined:
            Logger.shared.info("Shortcut pressed with accessibility=.notDetermined; triggering OS prompt")
            _ = env.permissions.promptAccessibility()
            return false
        case .denied:
            Logger.shared.warn("Shortcut blocked: accessibility permission is denied")
            NSSound(named: "Funk")?.play()
            env.permissions.openAccessibilitySettings()
            env.notifier.accessibilityDenied()
            return false
        }
        return true
    }

    private func pushUp() {
        Self.releaseStartedAt = CFAbsoluteTimeGetCurrent()
        if env.audioRecorder.isRecording {
            finishRecording()
            return
        }
        // Engine is still warming up on a background task. Mark the
        // intent and let the start-completion handler wrap up as
        // soon as the engine is live. A genuine no-press (no
        // pendingStart) just falls through.
        if pendingStart != nil {
            releaseRequestedDuringStart = true
        }
    }

    // MARK: - Toggle mode

    func toggleRecording() {
        guard !env.preferences.shortcutPaused else { return }
        if env.audioRecorder.isRecording {
            isToggleRecording = false
            finishRecording()
        } else if pendingStart != nil {
            // Engine is still warming up from a prior toggle press.
            // Treat this press as the "stop" half of the toggle —
            // finish-on-ready when the engine is live.
            isToggleRecording = false
            releaseRequestedDuringStart = true
        } else {
            guard handlePermissionPrecondition() else { return }
            isToggleRecording = true
            beginRecording()
        }
    }

    // MARK: - Lifecycle

    private func beginRecording() {
        // Show the HUD FIRST, before we touch the audio engine. The
        // .preparing state covers the 280–560ms window while
        // engine.start runs on a background task and the HAL warms
        // up; the runloop is free during that window so the panel
        // can actually paint at +5ms instead of being held off
        // until the engine is live.
        env.hudController.showPreparing()

        // Off-main and fire-and-forget — never delays engine start.
        env.mediaPauser.pauseIfPlaying(enabled: env.preferences.pauseMediaWhileDictating)

        releaseRequestedDuringStart = false
        pendingStart = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.env.audioRecorder.start()
            } catch {
                Logger.shared.error("recorder.start failed: \(error.localizedDescription)")
                self.env.mediaPauser.resumeIfPaused()
                self.env.hudController.hide()
                self.env.notifier.transcriptionFailed(error.localizedDescription)
                self.pendingStart = nil
                self.releaseRequestedDuringStart = false
                return
            }
            self.pendingStart = nil
            // Engine is now actually running and producing samples —
            // flip the HUD into its recording state, kicking off the
            // timer and the live waveform.
            self.recordingStartedAt = Date()
            self.didHitMaxDuration = false
            self.env.hudController.activateRecording()
            self.playStartSound()
            self.scheduleMaxDurationCutoff()

            // The user already released the shortcut while the engine
            // was warming up — finish the recording immediately. The
            // sub-minimum-duration check in finishRecording will
            // discard the result if the press was too short.
            if self.releaseRequestedDuringStart {
                self.releaseRequestedDuringStart = false
                self.finishRecording()
            }
        }
    }

    private func finishRecording() {
        cancelMaxDurationTimer()
        // Resume as soon as the mic stops — transcription continues while
        // the music comes back. Covers every exit path below.
        defer { env.mediaPauser.resumeIfPaused() }
        guard let result = env.audioRecorder.stop() else {
            env.hudController.hide()
            return
        }

        let minMs = env.preferences.minDurationMs
        let durationMs = Int(result.durationSeconds * 1000)
        if durationMs < minMs {
            try? FileManager.default.removeItem(at: result.url)
            env.hudController.hide()
            Logger.shared.debug("Ignored sub-minimum recording (\(durationMs)ms < \(minMs)ms)")
            return
        }

        let hitMax = didHitMaxDuration
        env.hudController.setTranscribing()
        Task { @MainActor in
            await env.transcriptionService.process(TranscriptionRequest(
                recording: result,
                maxDurationHit: hitMax))
        }
    }

    // MARK: - Max duration

    private func scheduleMaxDurationCutoff() {
        maxDurationTimer?.invalidate()
        let seconds = max(env.preferences.maxDurationSec, 30)
        maxDurationTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(seconds), repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.env.audioRecorder.isRecording else { return }
                self.didHitMaxDuration = true
                self.finishRecording()
            }
        }
    }

    private func cancelMaxDurationTimer() {
        maxDurationTimer?.invalidate()
        maxDurationTimer = nil
    }

    // MARK: - Sounds

    private func playStartSound() {
        guard env.preferences.playSounds else { return }
        NSSound(named: "Tink")?.play()
    }
}
