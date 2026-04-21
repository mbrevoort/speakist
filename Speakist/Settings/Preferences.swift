import Foundation
import Combine
import ServiceManagement
import AppKit

enum DeepgramModel: String, CaseIterable, Identifiable, Codable {
    case nova3 = "nova-3"
    case nova2 = "nova-2"
    var id: String { rawValue }
    var displayName: String { rawValue }
}

@MainActor
final class Preferences: ObservableObject {
    private let defaults = UserDefaults.standard

    // MARK: - Keys
    private enum K {
        static let deepgramModel = "deepgramModel"
        static let dictationMode = "dictationMode"
        static let includeFillerWords = "includeFillerWords"
        static let convertMeasurements = "convertMeasurements"
        static let maskProfanity = "maskProfanity"
        static let autoDetectLanguage = "autoDetectLanguage"
        static let playSounds = "playSounds"
        static let showHUD = "showHUD"
        static let keepAudio = "keepAudio"
        static let keepAudioCount = "keepAudioCount"
        static let minDurationMs = "minDurationMs"
        static let maxDurationSec = "maxDurationSec"
        static let retentionDays = "retentionDays"
        static let maxHistoryEntries = "maxHistoryEntries"
        static let inputDeviceUID = "inputDeviceUID"
        static let language = "language"
        static let launchAtLogin = "launchAtLogin"
        static let shortcutPaused = "shortcutPaused"
        static let onboardingCompleted = "onboardingCompleted"
        static let rateDeepgramNova3 = "rate.deepgram.nova3"
        static let rateDeepgramNova2 = "rate.deepgram.nova2"
        static let apiBaseURL = "apiBaseURL"
    }

    init() {
        // Channel-specific default, baked into Info.plist at release time by
        // scripts/release.sh. Falls back to localhost for unflagged dev builds
        // run straight from Xcode without any release pipeline.
        let channelDefaultAPIBase = (Bundle.main.object(forInfoDictionaryKey: "SpeakistDefaultAPIBaseURL") as? String)
            ?? "http://localhost:3000"

        defaults.register(defaults: [
            K.deepgramModel: DeepgramModel.nova3.rawValue,
            // Dictation mode is opt-in. When ON, Deepgram converts spoken
            // commands ("period", "comma", "new paragraph") to characters —
            // but as a side effect it becomes much less aggressive about
            // inferring punctuation from pauses/intonation. For natural
            // push-to-talk where most users just speak conversationally, OFF
            // produces cleanly-punctuated output; ON suits users who want
            // explicit control. See:
            //   https://developers.deepgram.com/docs/dictation
            K.dictationMode: false,
            K.includeFillerWords: false,
            K.convertMeasurements: false,
            K.maskProfanity: false,
            K.autoDetectLanguage: false,
            K.playSounds: true,
            K.showHUD: true,
            K.keepAudio: true,
            K.keepAudioCount: 20,
            K.minDurationMs: 300,
            K.maxDurationSec: 300,
            K.retentionDays: 90,
            K.maxHistoryEntries: 1000,
            K.language: "en",
            K.launchAtLogin: false,
            K.shortcutPaused: false,
            K.onboardingCompleted: false,
            K.rateDeepgramNova3: 0.0043,
            K.rateDeepgramNova2: 0.0043,
            // Speakist API endpoint. Defaults to the channel's URL baked
            // into Info.plist at release time (stable→speakist.ai,
            // dev→speakist-dev.brevoortstudio.com, etc.). Unflagged Xcode
            // builds fall back to localhost. Users can still override per
            // machine with:
            //   defaults write <bundleID> apiBaseURL "https://example.com"
            // where <bundleID> varies per channel — see AppIdentity.bundleID
            // for the mapping.
            K.apiBaseURL: channelDefaultAPIBase
        ])
    }

    // MARK: - Bindings
    var deepgramModel: DeepgramModel {
        get { DeepgramModel(rawValue: defaults.string(forKey: K.deepgramModel) ?? "") ?? .nova3 }
        set { defaults.set(newValue.rawValue, forKey: K.deepgramModel); objectWillChange.send() }
    }
    /// Enables Deepgram's dictation mode — "period", "new line", "new paragraph"
    /// and other spoken punctuation commands are converted to characters.
    /// Trade-off: this disables much of the model's automatic punctuation
    /// inference, so when ON you're expected to say commands explicitly.
    /// Default OFF so natural speech → cleanly-punctuated text.
    var dictationMode: Bool {
        get { defaults.bool(forKey: K.dictationMode) }
        set { defaults.set(newValue, forKey: K.dictationMode); objectWillChange.send() }
    }
    /// When on, Deepgram's `filler_words=true` leaves "um"/"uh" in the transcript.
    /// Default off — the normal dictation experience strips fillers.
    var includeFillerWords: Bool {
        get { defaults.bool(forKey: K.includeFillerWords) }
        set { defaults.set(newValue, forKey: K.includeFillerWords); objectWillChange.send() }
    }
    /// `measurements=true` — "milligram" → "mg", "milliliter" → "ml", etc.
    var convertMeasurements: Bool {
        get { defaults.bool(forKey: K.convertMeasurements) }
        set { defaults.set(newValue, forKey: K.convertMeasurements); objectWillChange.send() }
    }
    /// `profanity_filter=true` — masks profanity with `****`.
    var maskProfanity: Bool {
        get { defaults.bool(forKey: K.maskProfanity) }
        set { defaults.set(newValue, forKey: K.maskProfanity); objectWillChange.send() }
    }
    /// `detect_language=true` — picks the dominant language and swaps the
    /// model. Mutually exclusive with an explicit `language=` param.
    var autoDetectLanguage: Bool {
        get { defaults.bool(forKey: K.autoDetectLanguage) }
        set { defaults.set(newValue, forKey: K.autoDetectLanguage); objectWillChange.send() }
    }
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
    var language: String {
        get { defaults.string(forKey: K.language) ?? "en" }
        set { defaults.set(newValue, forKey: K.language); objectWillChange.send() }
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

    // MARK: - Rates
    var rateDeepgramNova3: Double {
        get { defaults.double(forKey: K.rateDeepgramNova3) }
        set { defaults.set(newValue, forKey: K.rateDeepgramNova3); objectWillChange.send() }
    }
    var rateDeepgramNova2: Double {
        get { defaults.double(forKey: K.rateDeepgramNova2) }
        set { defaults.set(newValue, forKey: K.rateDeepgramNova2); objectWillChange.send() }
    }

    // MARK: - API endpoint
    var apiBaseURL: URL {
        let raw = defaults.string(forKey: K.apiBaseURL) ?? "http://localhost:3000"
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
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
