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
        static let transcriptionProvider = "transcriptionProvider"
        static let transcriptionModel = "transcriptionModel"
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
        static let useTranscribeProxy = "useTranscribeProxy"
        static let polishEnabled = "polishEnabled"
        static let polishSystemPrompt = "polishSystemPrompt"
        static let polishDefaultPrompt = "polishDefaultPrompt"
        static let polishIsCustom = "polishIsCustom"
    }

    init() {
        // Channel-specific default, baked into Info.plist at release time by
        // scripts/release.sh. Falls back to localhost for unflagged dev builds
        // run straight from Xcode without any release pipeline.
        let channelDefaultAPIBase = (Bundle.main.object(forInfoDictionaryKey: "SpeakistDefaultAPIBaseURL") as? String)
            ?? "http://localhost:3000"

        defaults.register(defaults: [
            // Phase B transcription provider + model. Default to Deepgram
            // nova-3 so upgrading from Phase A preserves the exact upstream.
            // User picks between Deepgram / Groq in Settings → Transcription;
            // when they switch providers, the model auto-flips to that
            // provider's default (see SettingsWindow provider picker).
            K.transcriptionProvider: TranscriptionProvider.deepgram.rawValue,
            K.transcriptionModel: TranscriptionProvider.deepgram.defaultModel,
            // Legacy — only consulted by the direct-Deepgram path when
            // useTranscribeProxy is OFF. Kept for backward compat.
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
            K.apiBaseURL: channelDefaultAPIBase,
            // Phase A flag: when true, Mac uploads audio to the Worker's
            // /api/transcribe endpoint. When false, Mac mints a Deepgram
            // ephemeral key and uploads directly to api.deepgram.com (the
            // legacy path). Default ON everywhere — the legacy path stays
            // as a fallback that a user or QA can flip via:
            //   defaults write <bundleID> useTranscribeProxy 0
            // If we see breakage in the dev channel, flipping this off
            // restores the known-good flow without waiting for a release.
            K.useTranscribeProxy: true,
            // Polish prefs are authoritative on the backend (source of
            // truth = /api/me/polish). These local values are a cache so
            // Settings can render instantly on launch without blocking on
            // /api/me. Refreshed after sign-in and after every successful
            // PUT. Default false + empty prompt matches what a fresh user
            // gets server-side.
            K.polishEnabled: false,
            K.polishSystemPrompt: "",
            K.polishDefaultPrompt: "",
            K.polishIsCustom: false
        ])
    }

    // MARK: - Bindings

    /// Selected transcription provider for the /api/transcribe proxy path
    /// (Phase B). Drives which upstream the Worker dispatches to. When
    /// useTranscribeProxy is false, this is ignored — the legacy direct-
    /// Deepgram path uses `deepgramModel` instead.
    var transcriptionProvider: TranscriptionProvider {
        get {
            let raw = defaults.string(forKey: K.transcriptionProvider) ?? ""
            return TranscriptionProvider(rawValue: raw) ?? .deepgram
        }
        set {
            defaults.set(newValue.rawValue, forKey: K.transcriptionProvider)
            // Auto-reset model to the new provider's default if the current
            // model isn't valid for the new provider. Avoids the state where
            // a user picks Groq but the stored model is still "nova-3".
            if !newValue.models.contains(transcriptionModel) {
                transcriptionModel = newValue.defaultModel
            }
            objectWillChange.send()
        }
    }

    /// Model slug within the selected provider. Raw string (not an enum)
    /// because the server accepts whatever slug the provider's API wants
    /// — we don't want to bottleneck new model rollout on a Mac release.
    var transcriptionModel: String {
        get {
            let raw = defaults.string(forKey: K.transcriptionModel) ?? ""
            return raw.isEmpty ? transcriptionProvider.defaultModel : raw
        }
        set { defaults.set(newValue, forKey: K.transcriptionModel); objectWillChange.send() }
    }

    /// Legacy — only used by the direct-Deepgram path when
    /// `useTranscribeProxy` is OFF. New proxy path uses `transcriptionModel`.
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
    /// Phase A transcription routing flag — see `K.useTranscribeProxy`.
    /// True = audio flows Mac → Worker → Deepgram (new path).
    /// False = Mac mints ephemeral key + uploads direct to Deepgram (legacy).
    /// User-overridable via `defaults write <bundleID> useTranscribeProxy 0`.
    var useTranscribeProxy: Bool {
        get { defaults.bool(forKey: K.useTranscribeProxy) }
        set { defaults.set(newValue, forKey: K.useTranscribeProxy); objectWillChange.send() }
    }

    // MARK: - Polish prefs (cached from /api/me)
    //
    // These four mirror the `polish` block in the /api/me response. The
    // backend is source of truth; local writes always fire a PUT and then
    // sync the cache from the response. Reads are free; writes that happen
    // offline will error and the user needs to retry when online.

    /// Runs the LLM polish pass on each transcription when true.
    var polishEnabled: Bool {
        get { defaults.bool(forKey: K.polishEnabled) }
        set { defaults.set(newValue, forKey: K.polishEnabled); objectWillChange.send() }
    }

    /// Currently-effective system prompt — either the user's custom one or
    /// the server default, depending on `polishIsCustom`.
    var polishSystemPrompt: String {
        get { defaults.string(forKey: K.polishSystemPrompt) ?? "" }
        set { defaults.set(newValue, forKey: K.polishSystemPrompt); objectWillChange.send() }
    }

    /// Server's baked-in default prompt. Shown as placeholder / reset target.
    var polishDefaultPrompt: String {
        get { defaults.string(forKey: K.polishDefaultPrompt) ?? "" }
        set { defaults.set(newValue, forKey: K.polishDefaultPrompt); objectWillChange.send() }
    }

    /// True when the user has saved a custom prompt. False when they're
    /// still on the server default.
    var polishIsCustom: Bool {
        get { defaults.bool(forKey: K.polishIsCustom) }
        set { defaults.set(newValue, forKey: K.polishIsCustom); objectWillChange.send() }
    }

    /// Atomically update all four polish cache fields from a fresh server
    /// response. Single `objectWillChange.send()` so Settings doesn't
    /// flicker through intermediate states.
    func applyPolishFromServer(enabled: Bool, systemPrompt: String,
                                isCustom: Bool, defaultPrompt: String) {
        defaults.set(enabled, forKey: K.polishEnabled)
        defaults.set(systemPrompt, forKey: K.polishSystemPrompt)
        defaults.set(isCustom, forKey: K.polishIsCustom)
        defaults.set(defaultPrompt, forKey: K.polishDefaultPrompt)
        objectWillChange.send()
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
