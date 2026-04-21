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
        // Permission failures used to silently early-return, which was the
        // worst possible UX — a user who'd just installed a fresh-signed
        // build (e.g. switching from a Debug build to the notarized DMG)
        // would find the shortcut mysteriously dead, because TCC wipes mic
        // and accessibility grants when the code signature changes AND
        // notifications are typically also unauthorized for the new signature
        // so the denial notification gets eaten.
        //
        // Now we fire three signals instead: audible Funk beep, direct jump
        // to the right System Settings pane, and the notification (best-effort).
        guard env.permissions.mic == .granted else {
            Logger.shared.warn("Shortcut blocked: microphone permission is \(env.permissions.mic)")
            NSSound(named: "Funk")?.play()
            env.permissions.openMicrophoneSettings()
            env.notifier.micDenied()
            return
        }
        guard env.permissions.accessibility == .granted else {
            Logger.shared.warn("Shortcut blocked: accessibility permission is \(env.permissions.accessibility)")
            NSSound(named: "Funk")?.play()
            env.permissions.openAccessibilitySettings()
            env.notifier.accessibilityDenied()
            return
        }
        // Debounce: ignore key-down while a prior recording is still transcribing.
        if env.hudController.state == .transcribing { return }
        if env.audioRecorder.isRecording { return }
        beginRecording()
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
            // Same rationale as pushDown(): make permission-denial loud and
            // self-guiding, not silent.
            guard env.permissions.mic == .granted else {
                Logger.shared.warn("Toggle shortcut blocked: microphone permission is \(env.permissions.mic)")
                NSSound(named: "Funk")?.play()
                env.permissions.openMicrophoneSettings()
                env.notifier.micDenied()
                return
            }
            guard env.permissions.accessibility == .granted else {
                Logger.shared.warn("Toggle shortcut blocked: accessibility permission is \(env.permissions.accessibility)")
                NSSound(named: "Funk")?.play()
                env.permissions.openAccessibilitySettings()
                env.notifier.accessibilityDenied()
                return
            }
            isToggleRecording = true
            beginRecording()
        }
    }

    // MARK: - Lifecycle

    private func beginRecording() {
        do {
            try env.audioRecorder.start()
        } catch {
            Logger.shared.error("recorder.start failed: \(error.localizedDescription)")
            env.notifier.transcriptionFailed(error.localizedDescription)
            return
        }
        recordingStartedAt = Date()
        didHitMaxDuration = false
        env.hudController.showRecording()
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
