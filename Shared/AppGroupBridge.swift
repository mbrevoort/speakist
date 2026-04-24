import Foundation

/// Cross-process bridge between the iOS main app and the SpeakistKeyboard
/// extension. Built on three iOS primitives:
///
///   1. **App Group shared container** — a sandboxed folder both targets can
///      read and write (`FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`),
///      used for the final transcript hand-off and any large blobs.
///   2. **Shared UserDefaults** (`UserDefaults(suiteName: appGroupID)`) — used
///      for small coordination state: current session status, the pending
///      transcript, error strings, session expiry timestamp.
///   3. **Darwin notifications** (`DarwinNotifier`) — low-latency signals so
///      the keyboard wakes up the moment a new transcript chunk is ready,
///      without polling.
///
/// `AppGroupBridge.shared` derives the correct group ID from the current
/// channel (local/dev/beta/stable) so dev/beta/stable installs don't cross-
/// contaminate state. The App Group ID has to appear in BOTH the main app's
/// AND the keyboard extension's entitlements.
///
/// Note on the keyboard + `RequestsOpenAccess`: an iOS keyboard extension
/// gets access to App Groups and the network only when the user flips
/// "Allow Full Access" in Settings → General → Keyboard. Without it this
/// bridge silently returns nil containers and the keyboard can't talk to
/// the app.
enum AppGroupBridge {
    /// Suite name for `UserDefaults(suiteName:)` and the App Group container
    /// lookup. Channel-aware so each install has its own shared state.
    static var identifier: String {
        switch SpeakistChannel.current {
        case .stable: return "group.com.brevoort-studio.speakist"
        case .beta:   return "group.com.brevoort-studio.speakist.beta"
        case .dev:    return "group.com.brevoort-studio.speakist.dev"
        case .local:  return "group.com.brevoort-studio.speakist.local"
        }
    }

    /// Shared UserDefaults the app and the keyboard both read/write. Lazy
    /// so failure to resolve (e.g. keyboard without Full Access) degrades
    /// gracefully — callers should treat `nil` as "IPC not available".
    static var defaults: UserDefaults? {
        UserDefaults(suiteName: identifier)
    }

    /// On-disk shared container for the transcript audio archive + anything
    /// bigger than a reasonable UserDefaults value.
    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    // MARK: - Keys used on the shared UserDefaults

    enum Key {
        /// String. Current session state: `"idle"`, `"activating"`,
        /// `"listening"`, `"transcribing"`, `"done"`, `"error"`. Both sides
        /// read; only the main app writes.
        static let sessionStatus = "speakist.session.status"

        /// Double (seconds since epoch). When the current Speak Session
        /// expires — after this the keyboard must re-activate via URL scheme.
        static let sessionExpiresAt = "speakist.session.expiresAt"

        /// String. Partial transcript being streamed in. Bumped every few
        /// hundred ms while listening.
        static let pendingTranscript = "speakist.transcript.pending"

        /// String. Final polished transcript, set once by the main app at
        /// the end of the flow. The keyboard reads this and calls
        /// `textDocumentProxy.insertText(_:)`.
        static let finalTranscript = "speakist.transcript.final"

        /// String. Incrementing token bumped every time a new transcript is
        /// ready so the keyboard can dedupe stale Darwin-notification reads.
        static let transcriptSequence = "speakist.transcript.sequence"

        /// String. Last error message, shown briefly in the keyboard UI.
        static let lastError = "speakist.session.lastError"

        /// String. Current tone preset: `"formal"`, `"casual"`, `"fun"`, etc.
        /// Keyboard writes; main app reads when starting a session.
        static let tonePreference = "speakist.preference.tone"

        /// String. Bundle ID of the app currently hosting the keyboard.
        /// Keyboard writes when `viewDidAppear`; main app reads so it can
        /// tune tone defaults per host ("Messages" → casual, "Mail" → formal).
        static let currentHostBundleID = "speakist.keyboard.hostBundleID"

        /// Double (seconds since epoch). Main app stamps this every time
        /// the scene transitions to `.active`. Keyboard reads it to decide
        /// whether the app is "hot" (recently foregrounded → Darwin-
        /// notification flow might work) vs "cold" (has to bring the app
        /// up manually because iOS 26 blocks keyboard→app URL opens).
        static let lastForegroundAt = "speakist.app.lastForegroundAt"

        /// Double (seconds since epoch). Keyboard stamps this when the
        /// user taps Speakist while the app is cold. The main app, next
        /// time it becomes active, reads this within a 60-second freshness
        /// window and auto-starts a Speak Session — so the user's tap
        /// carries through even when iOS refuses to perform the app-
        /// switch itself. Cleared on consume.
        static let pendingSessionRequestAt = "speakist.keyboard.pendingSessionAt"

        /// Double in [0, 1]. Main app writes the current (sqrt-curved)
        /// mic RMS level every tap callback while recording. Keyboard
        /// polls this during the listening phase and feeds it to the
        /// WaveformView so the user sees the bars actually track their
        /// voice. Writes happen ~30 times per second, which
        /// UserDefaults(suiteName:) handles fine at this scale — it's
        /// backed by a shared memory region that's cheaper than the
        /// plist round-trip most callers assume.
        static let micLevel = "speakist.mic.level"

        /// Double (seconds since epoch). Paired with `micLevel`. Keyboard
        /// uses this to detect "stale" readings (e.g. main app crashed
        /// mid-recording or was suspended) and fall back to a quiet
        /// baseline instead of holding the last value forever.
        static let micLevelAt = "speakist.mic.levelAt"
    }
}
