import Foundation

/// Release channel for both Mac and iOS builds. Matches the Mac app's
/// channel matrix (local/dev/beta/stable) so dashboards, backend-side
/// pricing, and app-group IDs stay consistent across platforms.
///
/// On iOS the value is baked into the main app's Info.plist as
/// `SpeakistChannel` at build time (XcodeGen's `SPEAKIST_CHANNEL` flag).
/// The keyboard extension reads it from ITS own Info.plist — we copy the
/// same channel marker across both targets so they stay in lockstep.
enum SpeakistChannel: String, CaseIterable {
    case local
    case dev
    case beta
    case stable

    /// Resolves the current build's channel. Falls back to `.local` if the
    /// Info.plist key is missing (can happen in tests and previews).
    static var current: SpeakistChannel {
        let raw = Bundle.main.object(forInfoDictionaryKey: "SpeakistChannel") as? String ?? "local"
        return SpeakistChannel(rawValue: raw) ?? .local
    }

    /// Backend base URL for this build. The single source of truth is
    /// the `SpeakistDefaultAPIBaseURL` Info.plist value, which xcodegen
    /// generates from the `SPEAKIST_API_BASE_URL` build setting — so
    /// flipping that YAML knob reliably updates the URL the app hits.
    /// The per-channel fallback only kicks in if Info.plist somehow
    /// drops the key; it's a last-ditch default, not the primary path.
    ///
    /// Previously this returned hardcoded URLs per channel, which
    /// silently overrode any YAML change — Debug pointed at localhost
    /// no matter what `SPEAKIST_API_BASE_URL` said, and every
    /// device-testing workflow broke in non-obvious ways.
    var defaultAPIBaseURL: URL {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "SpeakistDefaultAPIBaseURL") as? String,
           let url = URL(string: configured),
           !configured.isEmpty,
           url.scheme != nil {
            return url
        }
        switch self {
        case .local:  return URL(string: "http://localhost:3000")!
        case .dev:    return URL(string: "https://speakist-dev.brevoortstudio.com")!
        case .beta:   return URL(string: "https://speakist.ai")!
        case .stable: return URL(string: "https://speakist.ai")!
        }
    }

    var displayLabel: String {
        switch self {
        case .local:  return "Local"
        case .dev:    return "Dev"
        case .beta:   return "Beta"
        case .stable: return "Stable"
        }
    }
}
