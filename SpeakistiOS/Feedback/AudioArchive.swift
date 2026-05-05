import Foundation

/// On-device sandbox cache for recorded audio so the iOS app can
/// support "Report bad transcription". Mac keeps audio long-term in
/// Application Support so the user can re-transcribe an entry; iOS
/// has no equivalent UI need and intentionally treats audio as
/// disposable for privacy. The archive bridges the gap by holding
/// each recording for **at most 24 hours** (long enough that a user
/// who notices a bad transcript can report it) and capped at **50
/// MB total** (so a chatty user doesn't fill their Caches dir
/// indefinitely).
///
/// Storage: `~/Library/Caches/SpeakistAudio/<id>.wav`. iOS treats
/// Caches as evictable under storage pressure — that's the right
/// tradeoff: feedback is best-effort, the user's transcript history
/// is what we care about long-term.
///
/// Naming: keyed by the transcription's `transcriptionClientId`
/// (matches the X-Transcription-Id sent on /api/transcribe). One
/// stable identifier across the audio file, the History entry, and
/// the feedback row server-side.
@MainActor
final class AudioArchive {
    /// 24 hours. Anything older than this when `prune()` runs is
    /// deleted on app launch.
    static let retention: TimeInterval = 60 * 60 * 24

    /// Total cache cap. When exceeded, oldest files are removed first
    /// (LRU by file mtime) until under the cap.
    static let totalSizeCap: Int = 50 * 1024 * 1024

    /// Resolve the archive directory under the iOS Caches dir,
    /// creating it on first call. Returns nil if the FS access fails;
    /// callers degrade to text-only feedback.
    static func archiveDirectory() -> URL? {
        let fm = FileManager.default
        do {
            let caches = try fm.url(
                for: .cachesDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true)
            let dir = caches.appendingPathComponent("SpeakistAudio", isDirectory: true)
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            return dir
        } catch {
            Logger.shared.warn("AudioArchive: caches dir unavailable: \(error.localizedDescription)")
            return nil
        }
    }

    /// Move a transcription's audio file into the archive under the
    /// transcription id. The source file (typically the temp WAV the
    /// recorder produced) is moved, not copied — saves a disk round-
    /// trip on every dictation. Returns the new file path on success;
    /// nil if the FS write failed (caller leaves audioPath nil and
    /// the corresponding History entry simply won't have audio for
    /// any subsequent feedback report).
    static func archive(audioURL: URL, forTranscriptionId id: String) -> String? {
        guard let dir = archiveDirectory() else { return nil }
        let dest = dir.appendingPathComponent("\(id).wav")
        let fm = FileManager.default
        do {
            // If a file already exists at the destination — shouldn't
            // happen with UUID-based ids, but defensively handle it —
            // remove the old one first so the move can succeed.
            if fm.fileExists(atPath: dest.path) {
                try fm.removeItem(at: dest)
            }
            try fm.moveItem(at: audioURL, to: dest)
            return dest.path
        } catch {
            Logger.shared.warn(
                "AudioArchive: failed to archive \(audioURL.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }

    /// Read the archived audio for a given path. Returns nil if the
    /// file has been pruned or never existed; callers fall back to
    /// text-only feedback when audio is gone.
    static func readAudio(at path: String) -> Data? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        return try? Data(contentsOf: URL(fileURLWithPath: path))
    }

    /// Drop everything older than `retention`, then enforce the
    /// total-size cap (LRU by mtime). Idempotent and cheap (a few
    /// stat calls per file). Call this from app launch — the next
    /// time the user opens History, only the recent recordings are
    /// still around to be reported on.
    static func prune() {
        guard let dir = archiveDirectory() else { return }
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-retention)

        // Phase 1: TTL prune.
        let urls: [URL]
        do {
            urls = try fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [
                    .contentModificationDateKey, .fileSizeKey,
                ],
                options: [.skipsHiddenFiles])
        } catch {
            Logger.shared.warn("AudioArchive prune: list failed: \(error.localizedDescription)")
            return
        }

        // (url, mtime, size) tuples we'll need below.
        var survivors: [(url: URL, mtime: Date, size: Int)] = []
        var ttlDeleted = 0
        for url in urls {
            let values = try? url.resourceValues(forKeys: [
                .contentModificationDateKey, .fileSizeKey,
            ])
            let mtime = values?.contentModificationDate ?? Date.distantPast
            let size = values?.fileSize ?? 0
            if mtime < cutoff {
                try? fm.removeItem(at: url)
                ttlDeleted += 1
                continue
            }
            survivors.append((url, mtime, size))
        }

        // Phase 2: size-cap LRU prune.
        let totalSize = survivors.reduce(0) { $0 + $1.size }
        var capDeleted = 0
        if totalSize > totalSizeCap {
            // Oldest first.
            survivors.sort { $0.mtime < $1.mtime }
            var running = totalSize
            for entry in survivors {
                if running <= totalSizeCap { break }
                try? fm.removeItem(at: entry.url)
                running -= entry.size
                capDeleted += 1
            }
        }

        if ttlDeleted > 0 || capDeleted > 0 {
            Logger.shared.info(
                "AudioArchive pruned: \(ttlDeleted) by TTL, \(capDeleted) by size cap")
        }
    }
}
