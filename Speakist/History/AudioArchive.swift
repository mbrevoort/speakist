import Foundation

/// Owns the on-disk lifecycle for retained audio recordings.
@MainActor
final class AudioArchive {
    private let preferences: Preferences

    init(preferences: Preferences) {
        self.preferences = preferences
    }

    func bootstrap() {
        _ = try? Self.directory()
    }

    func archive(tempURL: URL, id: String) -> URL? {
        guard preferences.keepAudio else {
            try? FileManager.default.removeItem(at: tempURL)
            return nil
        }
        do {
            let dir = try Self.directory()
            let dest = dir.appendingPathComponent("\(id).wav")
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: tempURL, to: dest)
            pruneToKeepLast(preferences.keepAudioCount)
            return dest
        } catch {
            Logger.shared.warn("AudioArchive move failed: \(error.localizedDescription)")
            return nil
        }
    }

    func discard(tempURL: URL) {
        try? FileManager.default.removeItem(at: tempURL)
    }

    func pruneToKeepLast(_ count: Int) {
        do {
            let dir = try Self.directory()
            let fm = FileManager.default
            let urls = try fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles])
            let sorted = urls.sorted { lhs, rhs in
                let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return l > r
            }
            if count <= 0 {
                for url in sorted { try? fm.removeItem(at: url) }
            } else if sorted.count > count {
                for url in sorted.dropFirst(count) {
                    try? fm.removeItem(at: url)
                }
            }
        } catch {
            Logger.shared.warn("AudioArchive prune failed: \(error.localizedDescription)")
        }
    }

    func removeAll() {
        if let dir = try? Self.directory() {
            try? FileManager.default.removeItem(at: dir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    static func directory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory,
                                               in: .userDomainMask,
                                               appropriateFor: nil,
                                               create: true)
        let dir = base.appendingPathComponent("Speakist/Audio", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
