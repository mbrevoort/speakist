import Foundation

/// URL scheme contract between the SpeakistKeyboard extension and the
/// main Speakist iOS app. The keyboard has exactly one IPC weapon strong
/// enough to bring the main app to the foreground — `extensionContext.open`.
/// We use a typed route enum so both sides agree on the command surface.
///
/// The URL scheme itself is channel-scoped so dev/beta/stable side-by-side
/// installs don't hijack each other's deep links:
///
///   local  → `speakistlocal://…`
///   dev    → `speakistdev://…`
///   beta   → `speakistbeta://…`
///   stable → `speakist://…`
enum URLSchemeRoute {
    /// Keyboard wants the main app to start (or re-arm) a Speak Session.
    /// Optionally pipes through the host bundle ID so the main app can
    /// tune the tone default for the target app.
    case startSession(hostBundleID: String?, tone: String?)

    /// Convenience: cancel any in-progress session when the user closes
    /// the keyboard while recording. Less common; the main app auto-tears
    /// down on background, but belt and suspenders.
    case cancelSession

    /// Builds the URL to hand to `extensionContext.open(_:completionHandler:)`.
    /// Never returns nil in practice — if `URLComponents` fails to resolve,
    /// we've got a bigger problem than a keyboard deep link.
    var url: URL? {
        var components = URLComponents()
        components.scheme = URLSchemeBridge.scheme
        switch self {
        case .startSession(let host, let tone):
            components.host = "start-session"
            var items: [URLQueryItem] = []
            if let host { items.append(URLQueryItem(name: "host", value: host)) }
            if let tone { items.append(URLQueryItem(name: "tone", value: tone)) }
            if !items.isEmpty { components.queryItems = items }
        case .cancelSession:
            components.host = "cancel-session"
        }
        return components.url
    }
}

enum URLSchemeBridge {
    /// Scheme registered in the main app's Info.plist `CFBundleURLTypes`.
    /// Channel-scoped so multiple channels can coexist on a device.
    static var scheme: String {
        switch SpeakistChannel.current {
        case .stable: return "speakist"
        case .beta:   return "speakistbeta"
        case .dev:    return "speakistdev"
        case .local:  return "speakistlocal"
        }
    }

    /// Parse an incoming URL delivered to the main app (via
    /// `SceneDelegate.scene(_:openURLContexts:)` or SwiftUI's
    /// `.onOpenURL`). Returns nil if the URL isn't one we recognize.
    static func route(from url: URL) -> URLSchemeRoute? {
        guard url.scheme == scheme else { return nil }
        switch url.host {
        case "start-session":
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let host = comps?.queryItems?.first(where: { $0.name == "host" })?.value
            let tone = comps?.queryItems?.first(where: { $0.name == "tone" })?.value
            return .startSession(hostBundleID: host, tone: tone)
        case "cancel-session":
            return .cancelSession
        default:
            return nil
        }
    }
}
