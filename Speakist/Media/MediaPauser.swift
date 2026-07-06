import AppKit

/// Pauses Spotify when a dictation starts and resumes it when the
/// dictation ends — but only if *we* did the pausing, so a track the
/// user paused themselves stays paused.
final class MediaPauser {
    private static let spotifyBundleID = "com.spotify.client"

    /// All state + AppleScript round-trips live on this queue so a slow
    /// or wedged Spotify can never block the latency-sensitive recording
    /// start on the main thread.
    private let queue = DispatchQueue(label: "speakist.media-pauser", qos: .userInitiated)
    private var didPause = false

    /// Fire-and-forget: pause Spotify if it's currently playing.
    /// `enabled` is read on the caller's side (main actor) and passed in
    /// so this class never touches Preferences off-main.
    func pauseIfPlaying(enabled: Bool) {
        guard enabled else { return }
        queue.async {
            // Never `tell` an app that isn't running — AppleScript would
            // launch it.
            guard Self.spotifyIsRunning() else { return }
            let out = Self.run(
                """
                tell application "Spotify"
                    if player state is playing then
                        pause
                        return "paused"
                    end if
                end tell
                """)
            self.didPause = (out == "paused")
        }
    }

    /// Fire-and-forget: resume playback iff the last `pauseIfPlaying`
    /// actually paused something. Deliberately not gated on the
    /// preference — if the user flips the setting mid-dictation we still
    /// undo our own pause.
    func resumeIfPaused() {
        queue.async {
            guard self.didPause else { return }
            self.didPause = false
            guard Self.spotifyIsRunning() else { return }
            _ = Self.run("tell application \"Spotify\" to play")
        }
    }

    private static func spotifyIsRunning() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: spotifyBundleID).isEmpty
    }

    /// Runs on `queue`, never the main thread. First call prompts the
    /// user with the standard macOS Automation dialog ("Speakist wants
    /// to control Spotify"); a denial surfaces as error -1743 here and
    /// the feature silently degrades to a no-op.
    private static func run(_ source: String) -> String? {
        guard let script = NSAppleScript(source: source) else { return nil }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error {
            Logger.shared.warn("MediaPauser AppleScript failed: \(error)")
            return nil
        }
        return result.stringValue
    }
}
