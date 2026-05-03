import Foundation
#if canImport(PostHog)
import PostHog
#endif

/// Speakist's PostHog wrapper. Single source of truth for product
/// analytics across both Mac and iOS targets.
///
/// **Production-only by design.** The underlying SDK is *only* configured
/// when:
///
///   1. The `SpeakistChannel` Info.plist key is `"stable"` — keeps
///      Local/Dev/Beta builds out of the production PostHog project
///      entirely. We read the raw string here (rather than the iOS-only
///      `SpeakistChannel` enum or the Mac-only `AppIdentity.channel`)
///      so this file compiles into both targets without divergence.
///   2. `Info.plist` has a non-empty `SpeakistPostHogKey` — supplies the
///      `phc_…` project key. The key is set by the per-config build
///      setting `SPEAKIST_POSTHOG_KEY` in `project.yml`; only the
///      stable Release block populates it (from
///      `$SPEAKIST_POSTHOG_KEY_STABLE` in the build env).
///
/// Either gate failing → every API on this type is a no-op. Callers can
/// sprinkle `Analytics.shared.capture(...)` freely from anywhere without
/// channel-checking each site.
@MainActor
final class Analytics {
    static let shared = Analytics()

    private var enabled: Bool = false

    private init() {}

    private static var infoString_channel: String {
        Bundle.main.object(forInfoDictionaryKey: "SpeakistChannel") as? String ?? "local"
    }

    /// Boot the underlying PostHog SDK. Safe to call repeatedly — second
    /// and later calls are no-ops. Invoke from app launch (Mac:
    /// `applicationDidFinishLaunching`; iOS: `SpeakistApp.init()`).
    func bootstrap() {
        guard !enabled else { return }
        let channel = Self.infoString_channel
        guard channel == "stable" else {
            Logger.shared.info("Analytics disabled: channel is \(channel)")
            return
        }
        guard
            let key = Bundle.main.object(forInfoDictionaryKey: "SpeakistPostHogKey") as? String,
            !key.isEmpty
        else {
            Logger.shared.info("Analytics disabled: SpeakistPostHogKey not set in Info.plist")
            return
        }

        #if canImport(PostHog)
        let host = Bundle.main.object(forInfoDictionaryKey: "SpeakistPostHogHost") as? String
        let config = PostHogConfig(apiKey: key, host: host ?? "https://us.i.posthog.com")
        config.captureApplicationLifecycleEvents = true
        config.captureScreenViews = true
        // Session replay is iOS-only on the PostHog SDK — the property
        // itself is gated on `#if os(iOS)` in PostHogConfig, so the
        // macOS build wouldn't even compile a reference to it.
        #if os(iOS)
        config.sessionReplay = true
        #endif
        PostHogSDK.shared.setup(config)
        enabled = true
        Logger.shared.info("Analytics enabled for stable channel")
        #else
        // Build configurations that didn't link the PostHog package
        // (e.g. test bundles) compile cleanly but never enable.
        Logger.shared.info("Analytics disabled: PostHog SDK not linked")
        #endif
    }

    /// Associate the active session with a signed-in Speakist user.
    /// Call from the AccountManager state-change observer when state
    /// transitions to `.signedIn(identity:)`.
    func identify(userId: String, email: String?, displayName: String?, orgId: String?, orgName: String?, orgRole: String?) {
        guard enabled else { return }
        #if canImport(PostHog)
        var props: [String: Any] = [:]
        if let email { props["email"] = email }
        if let displayName { props["name"] = displayName }
        PostHogSDK.shared.identify(userId, userProperties: props)
        if let orgId {
            var orgProps: [String: Any] = [:]
            if let orgName { orgProps["name"] = orgName }
            if let orgRole { orgProps["role"] = orgRole }
            PostHogSDK.shared.group(type: "organization", key: orgId, groupProperties: orgProps)
        }
        #endif
    }

    /// Drop the identified-user association on sign-out so a subsequent
    /// sign-in on the same device doesn't carry forward properties from
    /// the previous user.
    func reset() {
        guard enabled else { return }
        #if canImport(PostHog)
        PostHogSDK.shared.reset()
        #endif
    }

    /// Capture an arbitrary product event. Property values must be
    /// JSON-serialisable (`String`, `Int`, `Double`, `Bool`, arrays /
    /// dicts of the same). Anything else is dropped by PostHog.
    func capture(_ event: String, properties: [String: Any]? = nil) {
        guard enabled else { return }
        #if canImport(PostHog)
        PostHogSDK.shared.capture(event, properties: properties)
        #endif
    }
}
