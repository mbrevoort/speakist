import Foundation
import Combine

/// JSON-backed history of Speakist dictations on this device. Stored in
/// the App Group shared container so the keyboard extension can append
/// its own entries later without coordinating through the main app at
/// runtime.
///
/// Why JSON not SQLite: scaffold simplicity. The Mac app uses GRDB +
/// FTS5 for history because it grew text search + correction learning.
/// iOS hasn't earned that complexity yet — a single file with all
/// entries is fine up to a few thousand rows (the whole use case is
/// "scroll the last week of dictations"). Migration to GRDB is a
/// two-hour refactor when we hit that ceiling.
///
/// Write coalescing: every mutation rewrites the whole file. Not a
/// problem at our scale; becomes one around 1k+ entries. At that point
/// we switch to GRDB.
@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var entries: [HistoryEntry] = []

    private let storeURL: URL?

    init() {
        self.storeURL = HistoryStore.resolveStoreURL()
        self.entries = loadFromDisk()
    }

    /// Prepend a new entry. History is displayed newest-first so
    /// insertion at index 0 means the row shows up at the top without
    /// a sort pass.
    func append(_ entry: HistoryEntry) {
        entries.insert(entry, at: 0)
        saveToDisk()
    }

    /// Update the transcript text of an existing entry (e.g. after the
    /// user edits in the Quick Dictate buffer or the History detail
    /// view). No-op if the entry isn't found.
    func updateText(id: UUID, newText: String) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[idx].text = newText
        saveToDisk()
    }

    func delete(id: UUID) {
        entries.removeAll(where: { $0.id == id })
        saveToDisk()
    }

    func deleteAll() {
        entries.removeAll()
        saveToDisk()
    }

    // MARK: - Persistence

    private static func resolveStoreURL() -> URL? {
        guard let container = AppGroupBridge.containerURL else {
            // App Group not entitled — keyboard won't have shared
            // access later either. Log once and degrade to in-memory.
            Logger.shared.warn("HistoryStore: App Group container unavailable; running in-memory")
            return nil
        }
        let dir = container.appendingPathComponent("History", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("entries.json")
    }

    private func loadFromDisk() -> [HistoryEntry] {
        guard let url = storeURL, FileManager.default.fileExists(atPath: url.path) else {
            return []
        }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode([HistoryEntry].self, from: data)
        } catch {
            Logger.shared.warn("HistoryStore decode failed: \(error.localizedDescription)")
            return []
        }
    }

    private func saveToDisk() {
        guard let url = storeURL else { return }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(entries)
            try data.write(to: url, options: [.atomic])
        } catch {
            Logger.shared.warn("HistoryStore save failed: \(error.localizedDescription)")
        }
    }
}
