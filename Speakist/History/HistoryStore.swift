import Foundation
import GRDB
import Combine

struct TranscriptionEntry: Identifiable, Hashable {
    var id: String
    var createdAt: Date
    var durationMs: Int
    var provider: String
    var model: String
    var rawTranscript: String
    var finalTranscript: String
    var cleanupApplied: Bool
    var audioPath: String?
    var targetBundleID: String?
    var pasteStatus: String          // "pasted" | "clipboard_only" | "failed"
    var transcriptionStatus: String  // "ok" | "failed" | "cleanup_failed"
    var errorMessage: String?
    var editedAt: Date?
}

enum HistoryFilter: Equatable {
    case all
    case edited
    case notPasted
    case withAudio
}

@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var entries: [TranscriptionEntry] = []

    private var dbQueue: DatabaseQueue?

    func bootstrap() {
        do {
            let url = try Self.databaseURL()
            let queue = try DatabaseQueue(path: url.path)
            try migrate(queue)
            self.dbQueue = queue
            reload()
        } catch {
            Logger.shared.error("HistoryStore bootstrap failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Public API

    func save(_ entry: TranscriptionEntry) {
        guard let dbQueue else { return }
        do {
            try dbQueue.write { db in
                try db.execute(literal: """
                    INSERT INTO transcriptions
                      (id, created_at, duration_ms, provider, model, raw_transcript, final_transcript,
                       cleanup_applied, audio_path, target_bundle_id, paste_status,
                       transcription_status, error_message, edited_at)
                    VALUES
                      (\(entry.id), \(entry.createdAt.timeIntervalSince1970), \(entry.durationMs),
                       \(entry.provider), \(entry.model), \(entry.rawTranscript), \(entry.finalTranscript),
                       \(entry.cleanupApplied ? 1 : 0), \(entry.audioPath), \(entry.targetBundleID),
                       \(entry.pasteStatus), \(entry.transcriptionStatus), \(entry.errorMessage),
                       \(entry.editedAt?.timeIntervalSince1970))
                    ON CONFLICT(id) DO UPDATE SET
                      final_transcript = excluded.final_transcript,
                      cleanup_applied = excluded.cleanup_applied,
                      audio_path = excluded.audio_path,
                      paste_status = excluded.paste_status,
                      transcription_status = excluded.transcription_status,
                      error_message = excluded.error_message,
                      edited_at = excluded.edited_at
                """)
                try db.execute(literal: """
                    INSERT INTO transcriptions_fts(rowid, raw_transcript, final_transcript)
                    SELECT rowid, raw_transcript, final_transcript FROM transcriptions WHERE id = \(entry.id)
                """)
            }
            reload()
        } catch {
            Logger.shared.error("save entry failed: \(error.localizedDescription)")
        }
    }

    func updateFinalTranscript(id: String, newText: String, editedAt: Date = Date()) {
        guard let dbQueue else { return }
        do {
            try dbQueue.write { db in
                try db.execute(literal: """
                    UPDATE transcriptions
                    SET final_transcript = \(newText), edited_at = \(editedAt.timeIntervalSince1970)
                    WHERE id = \(id)
                """)
                try db.execute(literal: """
                    DELETE FROM transcriptions_fts WHERE rowid = (SELECT rowid FROM transcriptions WHERE id = \(id))
                """)
                try db.execute(literal: """
                    INSERT INTO transcriptions_fts(rowid, raw_transcript, final_transcript)
                    SELECT rowid, raw_transcript, final_transcript FROM transcriptions WHERE id = \(id)
                """)
            }
            reload()
        } catch {
            Logger.shared.error("update entry failed: \(error.localizedDescription)")
        }
    }

    func delete(id: String) {
        guard let dbQueue else { return }
        do {
            try dbQueue.write { db in
                try db.execute(literal: "DELETE FROM transcriptions WHERE id = \(id)")
                try db.execute(literal: "DELETE FROM transcriptions_fts WHERE rowid NOT IN (SELECT rowid FROM transcriptions)")
            }
            reload()
        } catch {
            Logger.shared.error("delete entry failed: \(error.localizedDescription)")
        }
    }

    func deleteAll() {
        guard let dbQueue else { return }
        do {
            try dbQueue.write { db in
                try db.execute(sql: "DELETE FROM transcriptions")
                try db.execute(sql: "DELETE FROM transcriptions_fts")
            }
            reload()
        } catch {
            Logger.shared.error("deleteAll failed: \(error.localizedDescription)")
        }
    }

    func get(id: String) throws -> TranscriptionEntry? {
        guard let dbQueue else { return nil }
        return try dbQueue.read { db in
            if let row = try Row.fetchOne(db, sql: """
                SELECT * FROM transcriptions WHERE id = ?
            """, arguments: [id]) {
                return Self.entry(from: row)
            }
            return nil
        }
    }

    func filter(search: String, filter: HistoryFilter) -> [TranscriptionEntry] {
        var filtered = entries
        switch filter {
        case .all: break
        case .edited: filtered = filtered.filter { $0.editedAt != nil }
        case .notPasted: filtered = filtered.filter { $0.pasteStatus != "pasted" }
        case .withAudio: filtered = filtered.filter { $0.audioPath != nil }
        }
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !q.isEmpty {
            filtered = filtered.filter {
                $0.rawTranscript.lowercased().contains(q) ||
                $0.finalTranscript.lowercased().contains(q)
            }
        }
        return filtered
    }

    func purgeExpired(days: Int, maxEntries: Int) {
        guard let dbQueue else { return }
        let cutoff = Date().addingTimeInterval(-Double(days) * 86_400).timeIntervalSince1970
        do {
            try dbQueue.write { db in
                try db.execute(literal: "DELETE FROM transcriptions WHERE created_at < \(cutoff)")
                try db.execute(literal: """
                    DELETE FROM transcriptions WHERE id IN (
                      SELECT id FROM transcriptions
                      ORDER BY created_at DESC
                      LIMIT -1 OFFSET \(maxEntries)
                    )
                """)
                try db.execute(sql: "DELETE FROM transcriptions_fts WHERE rowid NOT IN (SELECT rowid FROM transcriptions)")
            }
            reload()
        } catch {
            Logger.shared.error("purge failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Loading

    private func reload() {
        guard let dbQueue else { return }
        do {
            let rows = try dbQueue.read { db in
                try Row.fetchAll(db, sql: "SELECT * FROM transcriptions ORDER BY created_at DESC")
            }
            self.entries = rows.map(Self.entry(from:))
        } catch {
            Logger.shared.error("reload history failed: \(error.localizedDescription)")
        }
    }

    private static func entry(from row: Row) -> TranscriptionEntry {
        TranscriptionEntry(
            id: row["id"] ?? "",
            createdAt: Date(timeIntervalSince1970: row["created_at"] ?? 0),
            durationMs: row["duration_ms"] ?? 0,
            provider: row["provider"] ?? "",
            model: row["model"] ?? "",
            rawTranscript: row["raw_transcript"] ?? "",
            finalTranscript: row["final_transcript"] ?? "",
            cleanupApplied: (row["cleanup_applied"] as Int? ?? 0) == 1,
            audioPath: row["audio_path"],
            targetBundleID: row["target_bundle_id"],
            pasteStatus: row["paste_status"] ?? "failed",
            transcriptionStatus: row["transcription_status"] ?? "ok",
            errorMessage: row["error_message"],
            editedAt: (row["edited_at"] as Double?).map(Date.init(timeIntervalSince1970:)))
    }

    // MARK: - Migrations

    private func migrate(_ queue: DatabaseQueue) throws {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS transcriptions (
                    id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    raw_transcript TEXT NOT NULL,
                    final_transcript TEXT NOT NULL,
                    cleanup_applied INTEGER NOT NULL,
                    audio_path TEXT,
                    target_bundle_id TEXT,
                    paste_status TEXT NOT NULL,
                    transcription_status TEXT NOT NULL,
                    error_message TEXT,
                    edited_at REAL
                );
            """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS idx_transcriptions_created
                ON transcriptions(created_at DESC);
            """)
            try db.execute(sql: """
                CREATE VIRTUAL TABLE IF NOT EXISTS transcriptions_fts USING fts5(
                    raw_transcript, final_transcript,
                    content='transcriptions', content_rowid='rowid'
                );
            """)
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at REAL NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    audio_seconds REAL,
                    cleanup_input_tokens INTEGER,
                    cleanup_output_tokens INTEGER
                );
            """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS idx_usage_created
                ON usage(created_at DESC);
            """)
        }
        try migrator.migrate(queue)
    }

    static func databaseURL() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Speakist", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("history.sqlite")
    }

    func dbQueueHandle() -> DatabaseQueue? { dbQueue }
}
