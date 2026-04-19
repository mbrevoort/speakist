import Foundation
import GRDB
import Combine

struct CorrectionRow: Identifiable, Equatable, Hashable {
    var dbID: Int64?
    var fromText: String
    var toText: String
    var count: Int
    var lastSeen: Date
    var isProperNoun: Bool
    var userManaged: Bool

    var id: String {
        if let dbID { return "db:\(dbID)" }
        return "pair:\(fromText)|\(toText)"
    }
}

@MainActor
final class CorrectionStore: ObservableObject {
    @Published private(set) var all: [CorrectionRow] = []

    private var dbQueue: DatabaseQueue?

    func bootstrap() {
        do {
            let url = try Self.databaseURL()
            let queue = try DatabaseQueue(path: url.path)
            try migrate(queue)
            self.dbQueue = queue
            reload()
        } catch {
            Logger.shared.error("CorrectionStore bootstrap failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Public API

    func ingest(pairs: [CorrectionPair]) {
        guard let dbQueue else { return }
        let now = Date()
        do {
            try dbQueue.write { db in
                for pair in pairs {
                    let trimmedFrom = pair.from.trimmingCharacters(in: .whitespacesAndNewlines)
                    let trimmedTo = pair.to.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmedFrom.isEmpty, !trimmedTo.isEmpty else { continue }
                    guard trimmedFrom.lowercased() != trimmedTo.lowercased() else { continue }
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed)
                        VALUES (\(trimmedFrom), \(trimmedTo), 1, \(now.timeIntervalSince1970), \(pair.isProperNounLike ? 1 : 0), 0)
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          count = count + 1,
                          last_seen = \(now.timeIntervalSince1970)
                    """)
                }
            }
            reload()
        } catch {
            Logger.shared.error("ingest corrections failed: \(error.localizedDescription)")
        }
    }

    func upsert(_ row: CorrectionRow) {
        guard let dbQueue else { return }
        do {
            try dbQueue.write { db in
                if let id = row.dbID {
                    try db.execute(literal: """
                        UPDATE corrections
                        SET from_text = \(row.fromText),
                            to_text = \(row.toText),
                            count = \(row.count),
                            last_seen = \(row.lastSeen.timeIntervalSince1970),
                            is_proper_noun = \(row.isProperNoun ? 1 : 0),
                            user_managed = \(row.userManaged ? 1 : 0)
                        WHERE id = \(id)
                    """)
                } else {
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed)
                        VALUES (\(row.fromText), \(row.toText), \(row.count), \(row.lastSeen.timeIntervalSince1970), \(row.isProperNoun ? 1 : 0), \(row.userManaged ? 1 : 0))
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          count = \(row.count),
                          last_seen = \(row.lastSeen.timeIntervalSince1970),
                          is_proper_noun = \(row.isProperNoun ? 1 : 0),
                          user_managed = \(row.userManaged ? 1 : 0)
                    """)
                }
            }
            reload()
        } catch {
            Logger.shared.error("upsert correction failed: \(error.localizedDescription)")
        }
    }

    func delete(_ row: CorrectionRow) {
        guard let dbQueue, let id = row.dbID else { return }
        do {
            try dbQueue.write { db in
                try db.execute(literal: "DELETE FROM corrections WHERE id = \(id)")
            }
            reload()
        } catch {
            Logger.shared.error("delete correction failed: \(error.localizedDescription)")
        }
    }

    /// Top-ranked proper-noun-like corrections for STT custom vocab.
    func keyterms(limit: Int) -> [String] {
        all.filter(\.isProperNoun)
            .sorted(by: { ($0.count, $0.lastSeen) > ($1.count, $1.lastSeen) })
            .prefix(limit)
            .map(\.toText)
    }

    /// All corrections formatted for Deepgram's `replace=find:replacement`
    /// param. The find side is lowercased because Deepgram matches it case-
    /// insensitively; the replacement preserves the user's intended casing.
    /// De-duplicated on the lowercased find so we don't send conflicting
    /// pairs that Deepgram would resolve unpredictably.
    func replaceRules(limit: Int) -> [ReplaceRule] {
        var seen = Set<String>()
        var out: [ReplaceRule] = []
        for row in all.sorted(by: { ($0.count, $0.lastSeen) > ($1.count, $1.lastSeen) }) {
            let find = row.fromText.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            let replacement = row.toText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !find.isEmpty, !replacement.isEmpty else { continue }
            guard find != replacement.lowercased() else { continue }
            guard !seen.contains(find) else { continue }
            seen.insert(find)
            out.append(ReplaceRule(find: find, replacement: replacement))
            if out.count >= limit { break }
        }
        return out
    }

    // MARK: - Internal

    private func reload() {
        guard let dbQueue else { return }
        do {
            let rows = try dbQueue.read { db -> [CorrectionRow] in
                let cursor = try Row.fetchCursor(db, sql: """
                    SELECT id, from_text, to_text, count, last_seen, is_proper_noun, user_managed
                    FROM corrections
                    ORDER BY count DESC, last_seen DESC
                """)
                var results: [CorrectionRow] = []
                while let row = try cursor.next() {
                    results.append(CorrectionRow(
                        dbID: row["id"],
                        fromText: row["from_text"] ?? "",
                        toText: row["to_text"] ?? "",
                        count: row["count"] ?? 0,
                        lastSeen: Date(timeIntervalSince1970: row["last_seen"] ?? 0),
                        isProperNoun: (row["is_proper_noun"] as Int? ?? 0) == 1,
                        userManaged: (row["user_managed"] as Int? ?? 0) == 1))
                }
                return results
            }
            self.all = rows
        } catch {
            Logger.shared.error("reload corrections failed: \(error.localizedDescription)")
        }
    }

    private func migrate(_ queue: DatabaseQueue) throws {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS corrections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_text TEXT NOT NULL,
                    to_text TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 1,
                    last_seen REAL NOT NULL,
                    is_proper_noun INTEGER NOT NULL DEFAULT 0,
                    user_managed INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(from_text, to_text)
                );
            """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS idx_corrections_rank
                ON corrections(count DESC, last_seen DESC);
            """)
        }
        try migrator.migrate(queue)
    }

    private static func databaseURL() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Speakist", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("corrections.sqlite")
    }
}
