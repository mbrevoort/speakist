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
        // `transcriptionProvider` and `transcriptionModel` UserDefaults
        // keys were removed when provider/model selection moved to the
        // super admin org page. Stale values from older installs are
        // ignored; the Worker now picks the model from the user's
        // language preference and the org's allowed-models list.
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
        static let useGlobeKey = "useGlobeKey"
        static let rateDeepgramNova3 = "rate.deepgram.nova3"
        static let rateDeepgramNova2 = "rate.deepgram.nova2"
        static let apiBaseURL = "apiBaseURL"
        static let useTranscribeProxy = "useTranscribeProxy"
        static let useStreamingTranscription = "useStreamingTranscription"
        static let polishEnabled = "polishEnabled"
        static let polishMode = "polishMode"
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

        // Self-heal cross-channel UserDefaults pollution before
        // defaults.register runs. UserDefaults persists across reinstalls
        // keyed by bundle ID, and `defaults.register(defaults:)` only
        // provides fallbacks — any value already in the plist wins,
        // including stale ones from a prior install of the same channel
        // that got pointed at a different env via `defaults write` or
        // legacy migration code.
        //
        // Symptom in the wild: the prod Mac app silently called the dev
        // backend (dev D1 / dev vocabulary / dev usage) because an old
        // entry in ~/Library/Preferences/com.brevoort-studio.speakist.plist
        // had apiBaseURL=https://speakist-dev.brevoortstudio.com. Once
        // we noticed via "vocabulary edits in prod app land in dev D1",
        // we manually `defaults delete`'d to recover; this guard prevents
        // the trap from biting again on a fresh install or for any other
        // user who hits the same scenario.
        //
        // Strategy: only reset when the stored value matches a *known
        // sibling channel*'s canonical URL. Genuine local-dev overrides
        // (localhost on a non-port-3000, an internal staging URL set by
        // hand) are preserved — they don't appear in this set.
        let knownSiblingChannelURLs: Set<String> = [
            "http://localhost:3000",
            "https://speakist-dev.brevoortstudio.com",
            "https://speakist.ai",
        ]
        if let stored = defaults.string(forKey: K.apiBaseURL),
           stored != channelDefaultAPIBase,
           knownSiblingChannelURLs.contains(stored) {
            Logger.shared.warn(
                "Cross-channel apiBaseURL pollution detected — resetting. stored=\(stored) channel-default=\(channelDefaultAPIBase)"
            )
            defaults.removeObject(forKey: K.apiBaseURL)
        }

        defaults.register(defaults: [
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
            // When true, the Globe (🌐 / fn) key acts as push-to-talk.
            // Implemented outside KeyboardShortcuts because that library
            // can't bind pure modifier keys — see ShortcutManager's
            // Globe monitor. Off by default; opt-in.
            K.useGlobeKey: false,
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
            // Real-time streaming transcription (Mac → Worker WebSocket →
            // Deepgram live). Default OFF while it bakes; flip on to have
            // audio stream as the user speaks instead of uploading the
            // whole WAV on key-release. Only consulted when
            // useTranscribeProxy is also true; on any streaming failure the
            // Mac falls back to the batch upload automatically.
            //   defaults write <bundleID> useStreamingTranscription 1
            K.useStreamingTranscription: false,
            // Polish prefs are authoritative on the backend (source of
            // truth = /api/me/polish). These local values are a cache so
            // Settings can render instantly on launch without blocking on
            // /api/me. Refreshed after sign-in and after every successful
            // PUT. Default false + empty prompt matches what a fresh user
            // gets server-side.
            K.polishEnabled: false,
            K.polishMode: "prescriptive",
            K.polishSystemPrompt: "",
            K.polishDefaultPrompt: "",
            K.polishIsCustom: false
        ])
    }

    // MARK: - Bindings

    /// Legacy — only used by the direct-Deepgram path when
    /// `useTranscribeProxy` is OFF. The proxy path no longer reads any
    /// model setting from Preferences; the Worker chooses based on
    /// language and the org's super-admin-configured allowed-models list.
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
    /// Phase A transcription routing flag — see `K.useTranscribeProxy`.
    /// True = audio flows Mac → Worker → Deepgram (new path).
    /// False = Mac mints ephemeral key + uploads direct to Deepgram (legacy).
    /// User-overridable via `defaults write <bundleID> useTranscribeProxy 0`.
    var useTranscribeProxy: Bool {
        get { defaults.bool(forKey: K.useTranscribeProxy) }
        set { defaults.set(newValue, forKey: K.useTranscribeProxy); objectWillChange.send() }
    }

    /// Real-time streaming transcription flag — see
    /// `K.useStreamingTranscription`. True = audio streams to the Worker
    /// over a WebSocket as the user speaks (lower release-to-paste
    /// latency); false = the whole WAV is uploaded on key-release. Only
    /// meaningful when `useTranscribeProxy` is also on. User-overridable
    /// via `defaults write <bundleID> useStreamingTranscription 1`.
    var useStreamingTranscription: Bool {
        get { defaults.bool(forKey: K.useStreamingTranscription) }
        set { defaults.set(newValue, forKey: K.useStreamingTranscription); objectWillChange.send() }
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

    /// Selected polish mode (`intuitive` / `prescriptive`). Defaults to
    /// `prescriptive` — the conservative variant that only fixes
    /// punctuation and grammar, never touches meaning. Existing users
    /// who had polish enabled before mode shipped were promoted to
    /// `intuitive` server-side via migration 0010.
    var polishMode: SpeakistAPIClient.PolishMode {
        get {
            let raw = defaults.string(forKey: K.polishMode) ?? ""
            return SpeakistAPIClient.PolishMode(rawValue: raw) ?? .prescriptive
        }
        set { defaults.set(newValue.rawValue, forKey: K.polishMode); objectWillChange.send() }
    }

    /// Atomically update all five polish cache fields from a fresh server
    /// response. Single `objectWillChange.send()` so Settings doesn't
    /// flicker through intermediate states.
    func applyPolishFromServer(enabled: Bool,
                                mode: SpeakistAPIClient.PolishMode,
                                systemPrompt: String,
                                isCustom: Bool,
                                defaultPrompt: String) {
        defaults.set(enabled, forKey: K.polishEnabled)
        defaults.set(mode.rawValue, forKey: K.polishMode)
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
