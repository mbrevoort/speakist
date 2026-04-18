import Foundation
import Combine
import ServiceManagement
import AppKit

enum TranscriptionProvider: String, CaseIterable, Identifiable, Codable {
    case deepgram
    case openai
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .deepgram: return "Deepgram"
        case .openai: return "OpenAI"
        }
    }
}

enum DeepgramModel: String, CaseIterable, Identifiable, Codable {
    case nova3 = "nova-3"
    case nova2 = "nova-2"
    var id: String { rawValue }
    var displayName: String { rawValue }
}

enum OpenAITranscribeModel: String, CaseIterable, Identifiable, Codable {
    case gpt4oMiniTranscribe = "gpt-4o-mini-transcribe"
    case gpt4oTranscribe = "gpt-4o-transcribe"
    case whisper1 = "whisper-1"
    var id: String { rawValue }
    var displayName: String { rawValue }
}

enum CleanupModel: String, CaseIterable, Identifiable, Codable {
    case gpt4oMini = "gpt-4o-mini"
    case gpt4o = "gpt-4o"
    var id: String { rawValue }
    var displayName: String { rawValue }
}

@MainActor
final class Preferences: ObservableObject {
    private let defaults = UserDefaults.standard

    static let defaultCleanupPrompt: String = """
    You are an editor cleaning up a single dictated utterance for pasting into a document. Your goals, in order:

    1. Preserve the speaker's meaning, voice, and word choice. Do not rewrite for "style."
    2. Remove disfluencies: "um", "uh", "like" (as filler), "you know", stutters, and false starts where the speaker clearly restarted.
    3. Fix punctuation, capitalization, and obvious transcription errors (homophones, split/joined words).
    4. Keep contractions and casual phrasing if the speaker used them.
    5. Do NOT add content, greetings, sign-offs, or commentary. Do NOT ask questions.
    6. Return only the cleaned text. No quotes, no prefixes, no explanations.

    If the input is very short (a single phrase), return it with only minimal fixes.
    """

    // MARK: - Keys
    private enum K {
        static let activeProvider = "activeProvider"
        static let deepgramModel = "deepgramModel"
        static let openaiTranscribeModel = "openaiTranscribeModel"
        static let cleanupEnabled = "cleanupEnabled"
        static let cleanupModel = "cleanupModel"
        static let cleanupSystemPrompt = "cleanupSystemPrompt"
        static let includeCorrectionsInCleanup = "includeCorrectionsInCleanup"
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
        static let rateOpenAIMiniTranscribe = "rate.openai.miniTranscribe"
        static let rateOpenAITranscribe = "rate.openai.transcribe"
        static let rateOpenAIWhisper = "rate.openai.whisper"
        static let rateCleanupInputPer1M = "rate.cleanup.in"
        static let rateCleanupOutputPer1M = "rate.cleanup.out"
    }

    init() {
        defaults.register(defaults: [
            K.activeProvider: TranscriptionProvider.deepgram.rawValue,
            K.deepgramModel: DeepgramModel.nova3.rawValue,
            K.openaiTranscribeModel: OpenAITranscribeModel.gpt4oMiniTranscribe.rawValue,
            K.cleanupEnabled: true,
            K.cleanupModel: CleanupModel.gpt4oMini.rawValue,
            K.cleanupSystemPrompt: Self.defaultCleanupPrompt,
            K.includeCorrectionsInCleanup: true,
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
            K.rateOpenAIMiniTranscribe: 0.003,
            K.rateOpenAITranscribe: 0.006,
            K.rateOpenAIWhisper: 0.006,
            K.rateCleanupInputPer1M: 0.15,
            K.rateCleanupOutputPer1M: 0.60
        ])
    }

    // MARK: - Bindings
    var activeProvider: TranscriptionProvider {
        get { TranscriptionProvider(rawValue: defaults.string(forKey: K.activeProvider) ?? "") ?? .deepgram }
        set { defaults.set(newValue.rawValue, forKey: K.activeProvider); objectWillChange.send() }
    }
    var deepgramModel: DeepgramModel {
        get { DeepgramModel(rawValue: defaults.string(forKey: K.deepgramModel) ?? "") ?? .nova3 }
        set { defaults.set(newValue.rawValue, forKey: K.deepgramModel); objectWillChange.send() }
    }
    var openaiTranscribeModel: OpenAITranscribeModel {
        get { OpenAITranscribeModel(rawValue: defaults.string(forKey: K.openaiTranscribeModel) ?? "") ?? .gpt4oMiniTranscribe }
        set { defaults.set(newValue.rawValue, forKey: K.openaiTranscribeModel); objectWillChange.send() }
    }
    var cleanupEnabled: Bool {
        get { defaults.bool(forKey: K.cleanupEnabled) }
        set { defaults.set(newValue, forKey: K.cleanupEnabled); objectWillChange.send() }
    }
    var cleanupModel: CleanupModel {
        get { CleanupModel(rawValue: defaults.string(forKey: K.cleanupModel) ?? "") ?? .gpt4oMini }
        set { defaults.set(newValue.rawValue, forKey: K.cleanupModel); objectWillChange.send() }
    }
    var cleanupSystemPrompt: String {
        get { defaults.string(forKey: K.cleanupSystemPrompt) ?? Self.defaultCleanupPrompt }
        set { defaults.set(newValue, forKey: K.cleanupSystemPrompt); objectWillChange.send() }
    }
    var includeCorrectionsInCleanup: Bool {
        get { defaults.bool(forKey: K.includeCorrectionsInCleanup) }
        set { defaults.set(newValue, forKey: K.includeCorrectionsInCleanup); objectWillChange.send() }
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
    var rateOpenAIMiniTranscribe: Double {
        get { defaults.double(forKey: K.rateOpenAIMiniTranscribe) }
        set { defaults.set(newValue, forKey: K.rateOpenAIMiniTranscribe); objectWillChange.send() }
    }
    var rateOpenAITranscribe: Double {
        get { defaults.double(forKey: K.rateOpenAITranscribe) }
        set { defaults.set(newValue, forKey: K.rateOpenAITranscribe); objectWillChange.send() }
    }
    var rateOpenAIWhisper: Double {
        get { defaults.double(forKey: K.rateOpenAIWhisper) }
        set { defaults.set(newValue, forKey: K.rateOpenAIWhisper); objectWillChange.send() }
    }
    var rateCleanupInputPer1M: Double {
        get { defaults.double(forKey: K.rateCleanupInputPer1M) }
        set { defaults.set(newValue, forKey: K.rateCleanupInputPer1M); objectWillChange.send() }
    }
    var rateCleanupOutputPer1M: Double {
        get { defaults.double(forKey: K.rateCleanupOutputPer1M) }
        set { defaults.set(newValue, forKey: K.rateCleanupOutputPer1M); objectWillChange.send() }
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
