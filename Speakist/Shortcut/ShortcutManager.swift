import Foundation
import AppKit
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    static let pushToTalk = Self("pushToTalk", default: .init(.x, modifiers: [.command, .control]))
    static let toggleRecord = Self("toggleRecord")
}

@MainActor
final class ShortcutManager {
    private let env: AppEnvironment
    private var isToggleRecording = false
    private var recordingStartedAt: Date?
    private var maxDurationTimer: Timer?
    private var didHitMaxDuration = false

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
    }

    // MARK: - Push-to-talk

    private func pushDown() {
        guard !env.preferences.shortcutPaused else { return }
        guard handlePermissionPrecondition() else { return }
        // Debounce: ignore key-down while a prior recording is still transcribing.
        if env.hudController.state == .transcribing { return }
        if env.audioRecorder.isRecording { return }
        beginRecording()
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
        guard env.audioRecorder.isRecording else { return }
        finishRecording()
    }

    // MARK: - Toggle mode

    func toggleRecording() {
        guard !env.preferences.shortcutPaused else { return }
        if env.audioRecorder.isRecording {
            isToggleRecording = false
            finishRecording()
        } else {
            guard handlePermissionPrecondition() else { return }
            isToggleRecording = true
            beginRecording()
        }
    }

    // MARK: - Lifecycle

    private func beginRecording() {
        // Show the HUD FIRST, before we touch the audio engine. Engine
        // startup is fast on Mac but not free, and the user pressed
        // their shortcut to get a UI response — so flash the panel up
        // in the same frame as the key event and hide engine warmup
        // behind the preparing state.
        env.hudController.showPreparing()

        do {
            try env.audioRecorder.start()
        } catch {
            Logger.shared.error("recorder.start failed: \(error.localizedDescription)")
            env.hudController.hide()
            env.notifier.transcriptionFailed(error.localizedDescription)
            return
        }
        // Engine is now actually running and producing samples — flip
        // the HUD into its recording state, which kicks off the timer
        // and starts animating the waveform from real RMS values.
        recordingStartedAt = Date()
        didHitMaxDuration = false
        env.hudController.activateRecording()
        playStartSound()
        scheduleMaxDurationCutoff()
    }

    private func finishRecording() {
        cancelMaxDurationTimer()
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
