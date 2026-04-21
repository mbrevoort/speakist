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
///   debug   → bundleID com.brevoort-studio.speakist.debug  displayName "Speakist Debug"
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
    /// "Speakist Debug". Used for folder names under `Application Support/`
    /// and `~/Library/Logs/` so the channel is obvious in Finder.
    static var displayName: String {
        Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "Speakist"
    }

    /// Release channel slug baked in by `scripts/release.sh`:
    /// "stable", "beta", "dev", or "debug". Default if unset = "debug"
    /// (local Xcode builds don't go through the release script).
    static var channel: String {
        Bundle.main.object(forInfoDictionaryKey: "SpeakistChannel") as? String ?? "debug"
    }
}
