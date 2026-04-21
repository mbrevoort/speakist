import Foundation

/// Single source of truth for per-channel identity. Everything else in the
/// app (Keychain service, logger subsystem, Application Support folder,
/// Logs folder, UI strings that mention "Speakist") derives from these
/// three values. `scripts/release.sh` rewrites `project.yml` pre-build for
/// dev and beta channels so the final Info.plist carries the right values.
///
/// Channel matrix:
///   stable  → bundleID com.brevoort-studio.speakist        displayName "Speakist"
///   beta    → bundleID com.brevoort-studio.speakist.beta   displayName "Speakist Beta"
///   dev     → bundleID com.brevoort-studio.speakist.dev    displayName "Speakist Dev"
///   local   → bundleID com.brevoort-studio.speakist.local  displayName "Speakist Local"
///
/// Because bundle-id and display-name are different across channels, macOS
/// treats each channel as a distinct app: TCC grants, UserDefaults,
/// Keychain items, and filesystem data folders are all partitioned. You
/// can install all four side-by-side without cross-contamination.
enum AppIdentity {
    /// Reverse-DNS identifier, e.g. `com.brevoort-studio.speakist.dev`. Used
    /// as the Keychain service name and `os.Logger` subsystem. Falls back
    /// to the stable-channel ID only in the impossible case Bundle.main
    /// loses its Info.plist at runtime.
    static var bundleID: String {
        Bundle.main.bundleIdentifier ?? "com.brevoort-studio.speakist"
    }

    /// User-facing name shown in Finder, the Dock, Cmd+Tab, System
    /// Settings → Privacy: "Speakist", "Speakist Dev", "Speakist Beta",
    /// "Speakist Local". Used for folder names under `Application Support/`
    /// and `~/Library/Logs/` so the channel is obvious in Finder.
    static var displayName: String {
        Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "Speakist"
    }

    /// Release channel slug: "stable", "beta", "dev", or "local". Local
    /// builds pick up "local" from project.yml's Debug config; release.sh
    /// rewrites the Release config's value for dev/beta. Fallback is
    /// "local" in the vanishingly-unlikely case Info.plist loses the key.
    static var channel: String {
        Bundle.main.object(forInfoDictionaryKey: "SpeakistChannel") as? String ?? "local"
    }

    /// Cloudflare AI Gateway base URL for this channel, e.g.
    /// `https://gateway.ai.cloudflare.com/v1/{acct}/speakist-dev`. Provider
    /// paths are appended at call sites (e.g. `/deepgram/v1/listen`).
    ///
    /// local+dev  → `speakist-dev` gateway
    /// beta+stable → `speakist-prod` gateway
    ///
    /// Per-gateway rules disable request/response body logging and caching,
    /// so using the gateway adds request-count analytics without touching
    /// audio payloads or privacy guarantees. The account ID is baked into
    /// project.yml; release.sh rewrites the URL for dev/beta channels.
    static var gatewayBaseURL: String {
        Bundle.main.object(forInfoDictionaryKey: "SpeakistGatewayBaseURL") as? String ?? ""
    }
}
