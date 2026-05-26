import Foundation
import GRDB
import Combine

/// Whether a learned correction reaches the upstream STT provider or
/// stays client-side only. Mirrors the `applies_to` column on the
/// server's vocabulary_entries table (see web/drizzle/migrations/0021).
///
///   * `.local` — stored + visible in the Vocabulary UI, but NEVER
///     sent to the STT provider. This is the new safe default for
///     auto-ingested entries from inline transcript edits. Without
///     this gate, every word-level edit became a global rewrite rule
///     ("as" → "given") applied to every future dictation.
///
///   * `.stt`   — sent to the STT provider as a keyterm bias and as a
///     replace=find:replacement rule. Promoted from `.local` either
///     by the user explicitly in Settings or by the reactive LLM
///     classifier (count ≥ 2 + "looks like a real vocab item"). This
///     is the value migration 0021 backfilled for legacy entries that
///     passed a tight safety screen.
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

    /// API client used to mirror local edits up to the server. Bound
    /// from `AppEnvironment` after construction so the store can stay
    /// network-agnostic at the file level. Nil = no push (local-only).
    private var apiClient: SpeakistAPIClient?

    func bind(api: SpeakistAPIClient) {
        self.apiClient = api
    }

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
                    // New auto-ingested entries start as `local` —
                    // stored + visible in Settings, but NOT sent to
                    // STT. The classifier (follow-up) promotes them
                    // to `stt` when count ≥ 2 and the LLM agrees
                    // it's vocab-worthy. The ON CONFLICT clause
                    // increments count + last_seen on a recurring
                    // correction; it does NOT downgrade applies_to,
                    // so a row already promoted to `stt` keeps that
                    // status when re-ingested.
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed, applies_to)
                        VALUES (\(trimmedFrom), \(trimmedTo), 1, \(now.timeIntervalSince1970), \(pair.isProperNounLike ? 1 : 0), 0, 'local')
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          count = count + 1,
                          last_seen = \(now.timeIntervalSince1970)
                    """)
                }
            }
            reload()
            // Mirror the touched rows up to the server so the web view
            // shows what the Mac just learned.
            pushTouchedPairs(pairs)
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
            pushUpsert(row)
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
            pushDelete(from: row.fromText, to: row.toText)
        } catch {
            Logger.shared.error("delete correction failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Server sync

    /// Apply a batch of vocabulary entries from the server. Tombstoned
    /// rows (`deleted == true`) are deleted locally; live rows are
    /// upserted by `(from_text, to_text)`. Used by `syncFromServer`
    /// after a `/api/vocabulary` GET, and is what makes web edits show
    /// up on the Mac.
    func merge(serverEntries entries: [SpeakistAPIClient.VocabEntryWire]) {
        guard let dbQueue else { return }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parserNoFractional = ISO8601DateFormatter()
        parserNoFractional.formatOptions = [.withInternetDateTime]

        func parseTime(_ s: String?) -> TimeInterval {
            guard let s else { return Date().timeIntervalSince1970 }
            if let d = parser.date(from: s) ?? parserNoFractional.date(from: s) {
                return d.timeIntervalSince1970
            }
            return Date().timeIntervalSince1970
        }

        do {
            try dbQueue.write { db in
                for entry in entries {
                    let from = entry.from.trimmingCharacters(in: .whitespacesAndNewlines)
                    let to = entry.to.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !from.isEmpty, !to.isEmpty else { continue }

                    if entry.deleted == true {
                        // Tombstone — drop the local row if it exists.
                        // No-op if we never had it.
                        try db.execute(literal: """
                            DELETE FROM corrections
                            WHERE from_text = \(from) AND to_text = \(to)
                        """)
                        continue
                    }

                    let count = entry.count ?? 1
                    let isProperNoun = entry.isProperNoun ?? false
                    let lastSeen = parseTime(entry.lastSeen)
                    // Trust the server's applies_to over the local
                    // value — the server is the source of truth and
                    // is where classifier promotion lives. When the
                    // wire entry omits applies_to (older server, or
                    // a partial update), default to `local` so the
                    // safe-by-default invariant holds.
                    let appliesTo = entry.appliesTo ?? "local"

                    // Treat server-sourced rows as user_managed so they
                    // survive any future eviction/aging logic. The web
                    // editor is by definition a deliberate user action.
                    try db.execute(literal: """
                        INSERT INTO corrections (from_text, to_text, count, last_seen, is_proper_noun, user_managed, applies_to)
                        VALUES (\(from), \(to), \(count), \(lastSeen), \(isProperNoun ? 1 : 0), 1, \(appliesTo))
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          count = \(count),
                          last_seen = \(lastSeen),
                          is_proper_noun = \(isProperNoun ? 1 : 0),
                          user_managed = 1,
                          applies_to = \(appliesTo)
                    """)
                }
            }
            reload()
        } catch {
            Logger.shared.error("merge corrections from server failed: \(error.localizedDescription)")
        }
    }

    /// Pull the latest server-side vocabulary and merge it into the
    /// local store, then push any local entries the server hasn't seen
    /// (back-fill for entries that existed locally before push-on-edit
    /// was wired up). Safe to call on a no-op state — silently returns
    /// if the user is signed out or the request fails.
    ///
    /// Called from app launch and `didBecomeActive`, so anything edited
    /// in the web dashboard appears on the Mac the next time the app
    /// comes to the foreground, and anything edited (or auto-learned)
    /// on the Mac before sync was wired up shows up on the web.
    func syncFromServer(api: SpeakistAPIClient) async {
        do {
            let response = try await api.fetchVocabulary()
            merge(serverEntries: response.entries)

            // Back-fill: any local entry whose (from, to) pair never
            // made it to the server (server has no row, alive or
            // tombstoned) gets pushed once. The server's POST is
            // idempotent so a duplicate push is harmless if we ever
            // double-fire this path.
            let serverKeys: Set<String> = Set(response.entries.map { wireKey(from: $0.from, to: $0.to) })
            let toPush = all.compactMap { row -> SpeakistAPIClient.VocabEntryWire? in
                let key = wireKey(from: row.fromText, to: row.toText)
                guard !serverKeys.contains(key) else { return nil }
                return makeWire(from: row)
            }
            if !toPush.isEmpty {
                _ = try? await api.pushVocabulary(entries: toPush)
            }
        } catch SpeakistAPIClient.Error.notSignedIn {
            // Silent — nothing to sync.
        } catch {
            Logger.shared.warn("vocab sync failed: \(String(describing: error))")
        }
    }

    // MARK: - Push helpers (best-effort, fire-and-forget)

    /// Push a single locally-edited row up to the server. Called after
    /// the local DB write so the web dashboard sees the change without
    /// waiting for the next sync.
    private func pushUpsert(_ row: CorrectionRow) {
        guard let api = apiClient else { return }
        let wire = makeWire(from: row)
        Task {
            do {
                _ = try await api.pushVocabulary(entries: [wire])
            } catch SpeakistAPIClient.Error.notSignedIn {
                // Silent — nothing to push.
            } catch {
                Logger.shared.warn("push vocab upsert failed: \(String(describing: error))")
            }
        }
    }

    /// Push a tombstone for a `(from, to)` pair the user just deleted.
    private func pushDelete(from fromText: String, to toText: String) {
        guard let api = apiClient else { return }
        let wire = SpeakistAPIClient.VocabEntryWire(
            from: fromText,
            to: toText,
            count: nil,
            isProperNoun: nil,
            // Tombstone — server uses (from, to) as the key and the
            // `deleted: true` marker to soft-delete; applies_to is
            // irrelevant for a delete and stays nil.
            appliesTo: nil,
            lastSeen: nil,
            updatedAt: nil,
            deleted: true
        )
        Task {
            do {
                _ = try await api.pushVocabulary(entries: [wire])
            } catch SpeakistAPIClient.Error.notSignedIn {
            } catch {
                Logger.shared.warn("push vocab delete failed: \(String(describing: error))")
            }
        }
    }

    /// Push the rows touched by a recent `ingest(pairs:)` so auto-
    /// learned corrections show up on the web alongside manual ones.
    private func pushTouchedPairs(_ pairs: [CorrectionPair]) {
        guard let api = apiClient, !pairs.isEmpty else { return }
        let touchedKeys: Set<String> = Set(pairs.map { pair in
            wireKey(
                from: pair.from.trimmingCharacters(in: .whitespacesAndNewlines),
                to: pair.to.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        })
        let wire = all
            .filter { touchedKeys.contains(wireKey(from: $0.fromText, to: $0.toText)) }
            .map(makeWire(from:))
        guard !wire.isEmpty else { return }
        Task {
            do {
                _ = try await api.pushVocabulary(entries: wire)
            } catch SpeakistAPIClient.Error.notSignedIn {
            } catch {
                Logger.shared.warn("push vocab ingest failed: \(String(describing: error))")
            }
        }
    }

    private func makeWire(from row: CorrectionRow) -> SpeakistAPIClient.VocabEntryWire {
        SpeakistAPIClient.VocabEntryWire(
            from: row.fromText,
            to: row.toText,
            count: row.count,
            isProperNoun: row.isProperNoun,
            appliesTo: row.appliesTo.rawValue,
            lastSeen: ISO8601DateFormatter().string(from: row.lastSeen),
            updatedAt: nil,
            deleted: nil
        )
    }

    private func wireKey(from: String, to: String) -> String {
        "\(from)|\(to)"
    }

    /// Top-ranked corrections for STT custom-vocab bias. Filtered to
    /// `applies_to = stt` so that local-only entries (the new default
    /// for auto-ingested edits) never reach the upstream STT provider.
    /// The previous behavior — every is_proper_noun row reached STT
    /// regardless of intent — turned out to misclassify common-word
    /// swaps as "proper nouns" and globally rewrite unrelated dictation.
    func keyterms(limit: Int) -> [String] {
        all.filter { $0.appliesTo == .stt && $0.isProperNoun }
            .sorted(by: { ($0.count, $0.lastSeen) > ($1.count, $1.lastSeen) })
            .prefix(limit)
            .map(\.toText)
    }

    /// Corrections formatted for Deepgram's `replace=find:replacement`
    /// param. The find side is lowercased because Deepgram matches it
    /// case-insensitively; the replacement preserves the user's
    /// intended casing. De-duplicated on the lowercased find so we
    /// don't send conflicting pairs that Deepgram would resolve
    /// unpredictably.
    ///
    /// Filtered to `applies_to = stt` (same gate as keyterms, see
    /// above). Without this filter the bench captured "as → given",
    /// "a → an", "this → is a" being sent to Deepgram on every
    /// transcribe call — auto-ingested from inline transcript edits
    /// the user never intended as global rewrite rules.
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
                    // Unknown future enum value (e.g. server adds a
                    // third applies_to mode before the Mac knows about
                    // it) falls back to .local — the safe default that
                    // never reaches STT. Better to under-promote than
                    // to misinterpret as `.stt` and ship something
                    // unintended to the upstream provider.
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
        // v2 — add `applies_to` so corrections can be local-only
        // (stored, shown in UI, not sent to STT) vs sent to STT.
        // Mirrors the server-side migration 0021 column + backfill.
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
            // dictation. Server-side syncFromServer will then
            // overwrite each row's applies_to with the server's
            // canonical value, but this local-side backfill keeps
            // the Mac safe during the brief window between launch
            // and the first /api/vocabulary GET.
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
        try migrator.migrate(queue)
    }

    private static func databaseURL() throws -> URL {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        // Per-channel folder — see AppIdentity.displayName.
        let dir = base.appendingPathComponent(AppIdentity.displayName, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("corrections.sqlite")
    }
}
