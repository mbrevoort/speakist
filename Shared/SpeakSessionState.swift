import Foundation

/// Lifecycle of a single user-initiated dictation inside the iOS app.
///
/// Why this lives in Shared: both the main app (the state machine owner)
/// and the keyboard extension (a read-only observer rendering UI based on
/// the current state) need to be able to serialize/deserialize it across
/// the App Group bridge.
enum SpeakSessionStatus: String, Codable {
    /// No dictation in progress; mic is cold.
    case idle

    /// Main app just came foreground via URL scheme; `AVAudioSession` is
    /// being configured, mic hasn't started yet. iOS 26.4 keeps us in
    /// this state while the user does the swipe-right-to-return gesture.
    case activating

    /// Mic is live, streaming audio to the backend.
    case listening

    /// Recording stopped; `/api/transcribe` call in flight (plus optional
    /// polish step). Partial transcripts may still be streaming into the
    /// `pendingTranscript` key.
    case transcribing

    /// `finalTranscript` has been written and a Darwin notification was
    /// fired. Keyboard picks it up, calls `insertText`, then the session
    /// transitions back to `.idle` on the next user gesture.
    case done

    /// Something broke — `lastError` on the shared UserDefaults has the
    /// user-facing message. Keyboard shows the error pill for a beat
    /// before reverting to `.idle`.
    case error
}
