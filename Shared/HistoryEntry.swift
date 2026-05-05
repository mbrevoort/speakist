import Foundation

/// A single saved dictation. Lives in Shared because the keyboard
/// extension (which doesn't do the actual recording but does see the
/// final transcript from the main app) may eventually want to append
/// directly — right now only the main app writes, but the type is
/// identical on both sides of the bridge.
struct HistoryEntry: Codable, Identifiable, Equatable {
    let id: UUID
    let createdAt: Date
    /// The polished transcript the server returned, AFTER any user
    /// edits in the Quick Dictate buffer. We store the user's final
    /// version so they can copy-paste it again later verbatim.
    var text: String
    /// How many seconds of audio produced this entry (from the server's
    /// per-provider duration metric). Useful for the history row's
    /// "3.4s" subtitle.
    let audioSeconds: Double
    /// Which path produced this entry.
    let source: Source
    /// Server-returned provider/model label, e.g. "nova-3" or
    /// "whisper-large-v3-turbo". Shown in detail view; helps debug
    /// "why does this transcript look different" questions.
    let providerModel: String?
    /// Raw STT text before any local user edits, captured at the
    /// moment of transcription. Stored separately so a "Report bad
    /// transcription" submission can include both what the model
    /// produced and what the user shipped. Optional because older
    /// entries (pre-feedback) didn't carry it.
    var rawTranscript: String?
    /// X-Transcription-Id sent on the original /api/transcribe call,
    /// preserved verbatim. /api/feedback uses it to join against
    /// usage_events for provider/model context. Optional because
    /// older entries (pre-feedback) didn't persist it.
    var transcriptionClientId: String?
    /// Filesystem path to the archived audio recording for this entry.
    /// Lives under the iOS Caches dir and is pruned at app launch by
    /// AudioArchive (24-hour TTL, 50 MB LRU cap). Absent when the
    /// archive has reaped the file or when the entry predates the
    /// archive.
    var audioPath: String?
    /// Set when the user has tapped "Report bad transcription" on
    /// this entry and the upload to /api/feedback succeeded. Used
    /// to badge the history row and suppress duplicate reports.
    var reportedAt: Date?

    enum Source: Codable, Equatable {
        /// User tapped Quick Dictate inside the Speakist app and saved.
        case quickDictate
        /// User dictated via the keyboard extension in some other app.
        /// The host app's bundle ID is NOT reliably accessible from a
        /// keyboard extension — iOS doesn't expose it for privacy
        /// reasons. If we ever manage to sniff it (via a private hint
        /// or user-assigned label), it goes here.
        case keyboard(hostBundleID: String?)

        var displayLabel: String {
            switch self {
            case .quickDictate:
                return "Quick Dictate"
            case .keyboard(let bundleID):
                return bundleID.map { "Keyboard · \($0)" } ?? "Keyboard"
            }
        }

        var icon: String {
            switch self {
            case .quickDictate: return "waveform.badge.mic"
            case .keyboard:     return "keyboard"
            }
        }
    }

    init(id: UUID = UUID(),
         createdAt: Date = Date(),
         text: String,
         audioSeconds: Double,
         source: Source,
         providerModel: String? = nil,
         rawTranscript: String? = nil,
         transcriptionClientId: String? = nil,
         audioPath: String? = nil,
         reportedAt: Date? = nil) {
        self.id = id
        self.createdAt = createdAt
        self.text = text
        self.audioSeconds = audioSeconds
        self.source = source
        self.providerModel = providerModel
        self.rawTranscript = rawTranscript
        self.transcriptionClientId = transcriptionClientId
        self.audioPath = audioPath
        self.reportedAt = reportedAt
    }
}
