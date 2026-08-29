import Foundation
import GRDB
import Combine
import AppKit

/// Whether a learned correction is active or remains staged for explicit
/// approval. The raw values are retained for database compatibility with
/// earlier Speakist releases.
///
///   * `.local` — stored locally but not applied. This is the safe default for
///     auto-ingested entries from inline transcript edits. Without
///     this gate, every word-level edit became a global rewrite rule
///     ("as" → "given") applied to every future dictation.
///
///   * `.stt` — applied as an exact, case-insensitive replacement after
///     on-device speech recognition. Users activate rules explicitly; a new
///     spelling variant may also inherit approval from an existing proper-noun
///     rule when it passes the conservative similarity checks below.
enum CorrectionAppliesTo: String, Codable, Equatable {
    case local
    case stt
}

struct CorrectionRow: Identifiable, Equatable, Hashable {
    var dbID: Int64?
    var fromText: String
    var toText: String
    var count: Int
    var lastSeen: Date
    var isProperNoun: Bool
    var userManaged: Bool
    var appliesTo: CorrectionAppliesTo

    var id: String {
        if let dbID { return "db:\(dbID)" }
        return "pair:\(fromText)|\(toText)"
    }
}

@MainActor
final class CorrectionStore: ObservableObject {
    @Published private(set) var all: [CorrectionRow] = []

    private var dbQueue: DatabaseQueue?
    private static let stableRulesImportKey = "stable_explicit_replace_rules_v1"

    func bootstrap() {
        do {
            let url = try Self.databaseURL()
            let queue = try DatabaseQueue(path: url.path)
            try migrate(queue)
            self.dbQueue = queue

            // Debug/local is a separate app channel, so its Application
            // Support directory starts empty even when the installed stable
            // app already has the user's explicit Replace Words. Seed those
            // rules once from the stable on-device database. This is a local
            // SQLite-to-SQLite copy: it neither requires sign-in nor calls the
            // Speakist backend. Local edits remain authoritative afterward.
            if AppIdentity.channel == "local",
               ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
                do {
                    let stableURL = try Self.stableCorrectionsDatabaseURL()
                    let imported = try Self.importExplicitRulesOnce(
                        from: stableURL,
                        into: queue)
                    if imported > 0 {
                        Logger.shared.info(
                            "Imported \(imported) on-device replacement rules from Speakist")
                    }
                } catch {
                    // A missing/corrupt stable database must never prevent the
                    // local app from starting or using rules created locally.
                    Logger.shared.warn(
                        "Local replacement-rule import skipped: \(error.localizedDescription)")
                }
            }
            reload()
        } catch {
            Logger.shared.error("CorrectionStore bootstrap failed: \(error.localizedDescription)")
        }
    }

    /// Test-only entry point. Opens an in-memory SQLite database
    /// (GRDB's no-path initializer) so unit tests don't pick up the
    /// developer's real corrections.sqlite from Application Support.
    /// Without this, running the test suite on a dev machine that
    /// has actively used Speakist surfaces real rows + their
    /// migrated `applies_to` state, which makes "fresh-state"
    /// assertions flake. The production `bootstrap()` path is
    /// unchanged.
    func bootstrapInMemoryForTesting() throws {
        let queue = try DatabaseQueue()
        try migrate(queue)
        self.dbQueue = queue
        reload()
    }

    /// Test-only file-backed bootstrap for exercising the same cross-channel
    /// import used by Speakist Local without reading the developer's real app
    /// data. Passing no source behaves like a normal isolated database.
    func bootstrapForTesting(
        databaseURL: URL,
        stableRulesURL: URL? = nil
    ) throws {
        let queue = try DatabaseQueue(path: databaseURL.path)
        try migrate(queue)
        self.dbQueue = queue
        if let stableRulesURL {
            _ = try Self.importExplicitRulesOnce(
                from: stableRulesURL,
                into: queue)
        }
        reload()
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
                    // New auto-ingested entries normally start as `local`.
                    // A spelling variant of an already-approved name may
                    // inherit that approval, but only when the source is
                    // conservatively similar to the canonical spelling.
                    // Capitalization alone is not enough: a one-off edit such
                    // as `change` -> `Jeanie` must never become a global rule.
                    let hasApprovedCanonical = try Bool.fetchOne(
                        db,
                        sql: """
                            SELECT EXISTS(
                                SELECT 1 FROM corrections
                                WHERE lower(to_text) = lower(?)
                                  AND applies_to = 'stt'
                                  AND is_proper_noun = 1
                            )
                            """,
                        arguments: [trimmedTo]) ?? false
                    let appliesTo = pair.isProperNounLike
                        && hasApprovedCanonical
                        && Self.isSafeAutomaticAlias(
                            source: trimmedFrom,
                            canonical: trimmedTo)
                        ? CorrectionAppliesTo.stt.rawValue
                        : CorrectionAppliesTo.local.rawValue
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed, applies_to)
                        VALUES (\(trimmedFrom), \(trimmedTo), 1, \(now.timeIntervalSince1970), \(pair.isProperNounLike ? 1 : 0), 0, \(appliesTo))
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

    /// Automatic aliases are deliberately narrow. They must resemble an
    /// already-approved canonical spelling
    /// after punctuation and whitespace are removed. This catches variants
    /// such as `brevort`/`prevoort` -> `Brevoort` while rejecting ordinary
    /// words that were corrected to a name in one particular sentence.
    static func isSafeAutomaticAlias(source: String, canonical: String) -> Bool {
        let sourceWords = source.split(whereSeparator: { $0.isWhitespace })
        guard sourceWords.count == 1 else { return false }
        let sourceWord = String(sourceWords[0])
        let spelling = NSSpellChecker.shared.checkSpelling(
            of: sourceWord,
            startingAt: 0)
        // A valid English word is ambiguous even when its spelling happens to
        // resemble a name (`want` -> `Walti`, for example). Keep it staged for
        // explicit approval instead of activating it automatically.
        guard spelling.location != NSNotFound else { return false }

        func folded(_ value: String) -> String {
            value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
                .unicodeScalars
                .filter(CharacterSet.alphanumerics.contains)
                .map(String.init)
                .joined()
                .lowercased()
        }

        let source = folded(source)
        let canonical = folded(canonical)
        guard source.count >= 4, canonical.count >= 4, source != canonical else {
            return false
        }

        let distance = levenshteinDistance(source, canonical)
        let longest = max(source.count, canonical.count)
        let similarity = 1 - (Double(distance) / Double(longest))
        return similarity >= 0.55
    }

    private static func levenshteinDistance(_ lhs: String, _ rhs: String) -> Int {
        let left = Array(lhs)
        let right = Array(rhs)
        var previous = Array(0...right.count)

        for (leftIndex, leftCharacter) in left.enumerated() {
            var current = [leftIndex + 1]
            current.reserveCapacity(right.count + 1)
            for (rightIndex, rightCharacter) in right.enumerated() {
                current.append(min(
                    current[rightIndex] + 1,
                    previous[rightIndex + 1] + 1,
                    previous[rightIndex] + (leftCharacter == rightCharacter ? 0 : 1)
                ))
            }
            previous = current
        }
        return previous[right.count]
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
                            user_managed = \(row.userManaged ? 1 : 0),
                            applies_to = \(row.appliesTo.rawValue)
                        WHERE id = \(id)
                    """)
                } else {
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed, applies_to)
                        VALUES (\(row.fromText), \(row.toText), \(row.count), \(row.lastSeen.timeIntervalSince1970), \(row.isProperNoun ? 1 : 0), \(row.userManaged ? 1 : 0), \(row.appliesTo.rawValue))
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          count = \(row.count),
                          last_seen = \(row.lastSeen.timeIntervalSince1970),
                          is_proper_noun = \(row.isProperNoun ? 1 : 0),
                          user_managed = \(row.userManaged ? 1 : 0),
                          applies_to = \(row.appliesTo.rawValue)
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
    /// Exact local replacement rules. The find side is lowercased because the
    /// on-device replacement pass matches case-insensitively; the replacement
    /// preserves the user's intended casing. De-duplicated by source phrase.
    ///
    /// Only explicitly approved or conservatively promoted rows become active,
    /// preventing ordinary one-off edits from becoming global substitutions.
    func replaceRules(limit: Int) -> [ReplaceRule] {
        var seen = Set<String>()
        var out: [ReplaceRule] = []
        let candidates = all
            .filter { $0.appliesTo == .stt }
            .sorted(by: { ($0.count, $0.lastSeen) > ($1.count, $1.lastSeen) })
        for row in candidates {
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
                    SELECT id, from_text, to_text, count, last_seen, is_proper_noun, user_managed, applies_to
                    FROM corrections
                    ORDER BY count DESC, last_seen DESC
                """)
                var results: [CorrectionRow] = []
                while let row = try cursor.next() {
                    // Unknown values fall back to `.local`, the safe staged
                    // state that cannot rewrite future dictation.
                    let appliesToRaw: String = row["applies_to"] ?? "local"
                    let appliesTo = CorrectionAppliesTo(rawValue: appliesToRaw) ?? .local
                    results.append(CorrectionRow(
                        dbID: row["id"],
                        fromText: row["from_text"] ?? "",
                        toText: row["to_text"] ?? "",
                        count: row["count"] ?? 0,
                        lastSeen: Date(timeIntervalSince1970: row["last_seen"] ?? 0),
                        isProperNoun: (row["is_proper_noun"] as Int? ?? 0) == 1,
                        userManaged: (row["user_managed"] as Int? ?? 0) == 1,
                        appliesTo: appliesTo))
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
        // v2 — add `applies_to` so corrections can be staged safely instead
        // of immediately becoming active replacement rules.
        // The local default protects users from accidentally global-
        // rewriting common words via auto-ingestion from inline
        // transcript edits. See `CorrectionAppliesTo` in this file
        // for the full mental model.
        migrator.registerMigration("v2_applies_to") { db in
            try db.execute(sql: """
                ALTER TABLE corrections
                ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'local';
            """)
            // Backfill: legacy entries that pass the tight safety
            // screen get promoted to 'stt' so users with safe
            // existing entries (real proper nouns) keep their vocab
            // active in transcription. Everything else falls back
            // to 'local' so dangerous globals (as → given, a → an,
            // this → is a) stop reaching STT immediately on next
            // dictation. The local database is now the source of truth,
            // so this conservative backfill permanently protects existing
            // installations as they upgrade to the local-only release.
            //
            // Keep the blocklist in sync with the server migration
            // (0021_vocabulary_applies_to.sql) — same set of words.
            try db.execute(sql: """
                UPDATE corrections
                SET applies_to = 'stt'
                WHERE is_proper_noun = 1
                  AND LENGTH(from_text) >= 3
                  AND LOWER(from_text) NOT IN (
                    'the','and','but','for','with','that','this','these','those',
                    'they','them','their','there','then','than',
                    'have','has','had','was','were','are','been','being',
                    'will','would','should','could','can','may','might','must',
                    'into','onto','upon','from','about','over','under','between',
                    'when','where','while','because','although','though',
                    'not','yes','okay','such','some','any','all','both','each',
                    'how','why','who','what','which','whose','whom',
                    'you','your','yours','our','ours','mine','her','his','hers',
                    'one','two','three','four','five'
                  );
            """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS idx_corrections_applies_to
                ON corrections(applies_to, count DESC, last_seen DESC);
            """)
        }
        migrator.registerMigration("v3_correction_metadata") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS correction_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
        }
        try migrator.migrate(queue)
    }

    /// Import deliberate, globally-active replacement rules from another
    /// on-device Speakist correction database. A durable marker makes this a
    /// one-time seed, so deleting an imported rule in Speakist Local does not
    /// make it reappear at the next launch.
    private static func importExplicitRulesOnce(
        from sourceURL: URL,
        into destination: DatabaseQueue
    ) throws -> Int {
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            return 0
        }

        let alreadyImported = try destination.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT value FROM correction_metadata WHERE key = ?",
                arguments: [stableRulesImportKey]) != nil
        }
        guard !alreadyImported else { return 0 }

        var configuration = Configuration()
        configuration.readonly = true
        let source = try DatabaseQueue(
            path: sourceURL.path,
            configuration: configuration)
        let rules = try source.read { db -> [CorrectionRow] in
            let columns = try String.fetchAll(
                db,
                sql: "SELECT name FROM pragma_table_info('corrections')")
            let required = Set([
                "from_text", "to_text", "count", "last_seen",
                "is_proper_noun", "user_managed",
            ])
            guard required.isSubset(of: Set(columns)) else { return [] }

            let hasAppliesTo = columns.contains("applies_to")
            let filter = hasAppliesTo
                ? "user_managed = 1 AND applies_to = 'stt'"
                : "user_managed = 1"
            let rows = try Row.fetchAll(db, sql: """
                SELECT from_text, to_text, count, last_seen,
                       is_proper_noun, user_managed
                FROM corrections
                WHERE \(filter)
                ORDER BY count DESC, last_seen DESC
                """)
            return rows.compactMap { row in
                let fromText: String = row["from_text"] ?? ""
                let toText: String = row["to_text"] ?? ""
                guard !fromText.isEmpty, !toText.isEmpty else { return nil }
                return CorrectionRow(
                    dbID: nil,
                    fromText: fromText,
                    toText: toText,
                    count: row["count"] ?? 1,
                    lastSeen: Date(timeIntervalSince1970: row["last_seen"] ?? 0),
                    isProperNoun: (row["is_proper_noun"] as Int? ?? 0) == 1,
                    userManaged: true,
                    appliesTo: .stt)
            }
        }

        // If the stable channel has no explicit rules yet, leave the marker
        // unset so a later local launch can import rules added in the interim.
        guard !rules.isEmpty else { return 0 }

        try destination.write { db in
            for rule in rules {
                try db.execute(literal: """
                    INSERT INTO corrections
                      (from_text, to_text, count, last_seen,
                       is_proper_noun, user_managed, applies_to)
                    VALUES
                      (\(rule.fromText), \(rule.toText), \(rule.count),
                       \(rule.lastSeen.timeIntervalSince1970),
                       \(rule.isProperNoun ? 1 : 0), 1, 'stt')
                    ON CONFLICT(from_text, to_text) DO UPDATE SET
                      count = MAX(corrections.count, excluded.count),
                      last_seen = MAX(corrections.last_seen, excluded.last_seen),
                      is_proper_noun = MAX(corrections.is_proper_noun,
                                           excluded.is_proper_noun),
                      user_managed = 1,
                      applies_to = 'stt'
                    """)
            }
            try db.execute(
                sql: "INSERT OR REPLACE INTO correction_metadata (key, value) VALUES (?, ?)",
                arguments: [stableRulesImportKey, String(rules.count)])
        }
        return rules.count
    }

    private static func databaseURL() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        // Per-channel folder — see AppIdentity.displayName.
        let dir = base.appendingPathComponent(AppIdentity.displayName, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("corrections.sqlite")
    }

    private static func stableCorrectionsDatabaseURL() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true)
        return base
            .appendingPathComponent("Speakist", isDirectory: true)
            .appendingPathComponent("corrections.sqlite")
    }
}
