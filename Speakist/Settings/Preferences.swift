import Foundation
import Combine
import ServiceManagement
import AppKit

enum LocalOnlySetupMigration {
    static let requiredVersion = 1

    static func needsOnboarding(completedVersion: Int) -> Bool {
        completedVersion < requiredVersion
    }
}

@MainActor
final class Preferences: ObservableObject {
    private let defaults = UserDefaults.standard

    // MARK: - Keys
    private enum K {
        static let playSounds = "playSounds"
        static let showHUD = "showHUD"
        static let keepAudio = "keepAudio"
        static let keepAudioCount = "keepAudioCount"
        static let minDurationMs = "minDurationMs"
        static let maxDurationSec = "maxDurationSec"
        static let retentionDays = "retentionDays"
        static let maxHistoryEntries = "maxHistoryEntries"
        static let inputDeviceUID = "inputDeviceUID"
        static let launchAtLogin = "launchAtLogin"
        static let shortcutPaused = "shortcutPaused"
        static let onboardingCompleted = "onboardingCompleted"
        static let useGlobeKey = "useGlobeKey"
        static let localOnlySetupVersion = "localOnlySetupVersion"
        // Storage key predates the switch from volume-ducking to a full
        // process-tap mute — kept so existing users' on/off choice
        // survives the rename. The old `audioDuckLevel` key is ignored.
        static let muteAudioDuringDictation = "duckAudioDuringDictation"
    }

    init() {
        defaults.register(defaults: [
            K.playSounds: true,
            K.showHUD: true,
            K.keepAudio: true,
            K.keepAudioCount: 20,
            K.minDurationMs: 300,
            K.maxDurationSec: 300,
            K.retentionDays: 90,
            K.maxHistoryEntries: 1000,
            K.launchAtLogin: false,
            K.shortcutPaused: false,
            K.onboardingCompleted: false,
            // When true, the Globe (🌐 / fn) key acts as push-to-talk.
            // Implemented outside KeyboardShortcuts because that library
            // can't bind pure modifier keys — see ShortcutManager's
            // Globe monitor. Off by default; opt-in.
            K.useGlobeKey: false,
            K.localOnlySetupVersion: 0,
            // Optional because it requires a Core Audio process tap and an
            // additional System Audio Recording permission. Dictation itself
            // never depends on this convenience feature.
            K.muteAudioDuringDictation: false
        ])
    }

    // MARK: - Bindings

    var playSounds: Bool {
        get { defaults.bool(forKey: K.playSounds) }
        set { defaults.set(newValue, forKey: K.playSounds); objectWillChange.send() }
    }
    var showHUD: Bool {
        get { defaults.bool(forKey: K.showHUD) }
        set { defaults.set(newValue, forKey: K.showHUD); objectWillChange.send() }
    }
    var keepAudio: Bool {
        get { defaults.bool(forKey: K.keepAudio) }
        set { defaults.set(newValue, forKey: K.keepAudio); objectWillChange.send() }
    }
    var keepAudioCount: Int {
        get { defaults.integer(forKey: K.keepAudioCount) }
        set { defaults.set(newValue, forKey: K.keepAudioCount); objectWillChange.send() }
    }
    var minDurationMs: Int {
        get { defaults.integer(forKey: K.minDurationMs) }
        set { defaults.set(newValue, forKey: K.minDurationMs); objectWillChange.send() }
    }
    var maxDurationSec: Int {
        get { defaults.integer(forKey: K.maxDurationSec) }
        set { defaults.set(newValue, forKey: K.maxDurationSec); objectWillChange.send() }
    }
    var retentionDays: Int {
        get { defaults.integer(forKey: K.retentionDays) }
        set { defaults.set(newValue, forKey: K.retentionDays); objectWillChange.send() }
    }
    var maxHistoryEntries: Int {
        get { defaults.integer(forKey: K.maxHistoryEntries) }
        set { defaults.set(newValue, forKey: K.maxHistoryEntries); objectWillChange.send() }
    }
    var inputDeviceUID: String? {
        get { defaults.string(forKey: K.inputDeviceUID) }
        set {
            if let v = newValue { defaults.set(v, forKey: K.inputDeviceUID) }
            else { defaults.removeObject(forKey: K.inputDeviceUID) }
            objectWillChange.send()
        }
    }
    var launchAtLogin: Bool {
        get { defaults.bool(forKey: K.launchAtLogin) }
        set {
            defaults.set(newValue, forKey: K.launchAtLogin)
            applyLaunchAtLogin(newValue)
            objectWillChange.send()
        }
    }
    var shortcutPaused: Bool {
        get { defaults.bool(forKey: K.shortcutPaused) }
        set { defaults.set(newValue, forKey: K.shortcutPaused); objectWillChange.send() }
    }
    var onboardingCompleted: Bool {
        get { defaults.bool(forKey: K.onboardingCompleted) }
        set { defaults.set(newValue, forKey: K.onboardingCompleted); objectWillChange.send() }
    }
    /// Use the Globe (🌐 / fn) key as push-to-talk. Lives outside the
    /// KeyboardShortcuts recorder because that library refuses pure
    /// modifier keys (the sindresorhus implementation explicitly
    /// subtracts the `.function` flag from any captured event). When
    /// on, ShortcutManager installs an NSEvent monitor that watches
    /// `.flagsChanged` for `.function` transitions and routes them
    /// through the same pushDown/pushUp pipeline.
    var useGlobeKey: Bool {
        get { defaults.bool(forKey: K.useGlobeKey) }
        set { defaults.set(newValue, forKey: K.useGlobeKey); objectWillChange.send() }
    }
    /// Mute other apps' audio (music, video, anything) while a dictation is
    /// recording, unmute when it ends. Off by default. User-overridable via
    /// `defaults write <bundleID> duckAudioDuringDictation 1` (legacy key
    /// name — see K.muteAudioDuringDictation).
    var muteAudioDuringDictation: Bool {
        get { defaults.bool(forKey: K.muteAudioDuringDictation) }
        set { defaults.set(newValue, forKey: K.muteAudioDuringDictation); objectWillChange.send() }
    }

    var needsLocalOnlyOnboarding: Bool {
        LocalOnlySetupMigration.needsOnboarding(
            completedVersion: defaults.integer(forKey: K.localOnlySetupVersion))
    }

    func markLocalOnlyOnboardingComplete() {
        defaults.set(LocalOnlySetupMigration.requiredVersion,
                     forKey: K.localOnlySetupVersion)
        onboardingCompleted = true
    }

    // MARK: - Launch at login
    private func applyLaunchAtLogin(_ enabled: Bool) {
        do {
            let service = SMAppService.mainApp
            if enabled {
                if service.status == .enabled { return }
                try service.register()
            } else {
                if service.status == .notRegistered { return }
                try service.unregister()
            }
        } catch {
            Logger.shared.error("Launch at login toggle failed: \(error.localizedDescription)")
        }
    }
}
