import Foundation
import GRDB
import Combine
import AppKit

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
    private static let stableRulesImportKey = "stable_explicit_replace_rules_v1"

    /// API client used to mirror local edits up to the server. Bound
    /// from `AppEnvironment` after construction so the store can stay
    /// network-agnostic at the file level. Nil = no push (local-only).
    private var apiClient: SpeakistAPIClient?
    private var cloudSyncEnabled: () -> Bool = { true }

    /// In-memory "already tried this session" set for the reactive
    /// classifier. Keyed by the (from, to) pair. Prevents the same
    /// row from being re-classified multiple times during one app
    /// session — without this, every ingest() that touches a row at
    /// count ≥ 2 would re-call the classifier.
    ///
    /// Deliberately in-memory only (not persisted). Across launches
    /// we DO want to re-attempt classification for rows that are
    /// still local + count ≥ 2: the classifier is deterministic at
    /// temp=0 + strict structured outputs, so a repeat call returns
    /// the same verdict — but if the previous call hit a transient
    /// network error or rate limit, the next launch gets a clean
    /// retry. The wasted cost (~5-20 classifier calls per launch
    /// for a typical user's local-only set) is well under a cent.
    private var classifierAttempted: Set<String> = []

    func bind(
        api: SpeakistAPIClient,
        cloudSyncEnabled: @escaping () -> Bool = { true }
    ) {
        self.apiClient = api
        self.cloudSyncEnabled = cloudSyncEnabled
    }

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
            // Mirror the touched rows up to the server so the web view
            // shows what the Mac just learned.
            pushTouchedPairs(pairs)
            // After ingest, any row that just crossed count ≥ 2 and
            // is still applies_to=local is eligible for the reactive
            // classifier. Fire-and-forget so the user's save path
            // doesn't pay for the LLM round-trip.
            promotePromotables()
        } catch {
            Logger.shared.error("ingest corrections failed: \(error.localizedDescription)")
        }
    }

    /// Automatic aliases are deliberately narrower than the server-side
    /// classifier. They must resemble an already-approved canonical spelling
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

    /// Find every local-only row and dispatch it to the classifier.
    /// Each callback runs on its own Task; we don't block the
    /// caller.
    ///
    /// There is intentionally NO count threshold. The classifier is
    /// the gate: it decides whether an auto-ingested correction
    /// looks like a real vocab item or a one-off contextual edit.
    /// Earlier iterations of this code required `count >= 2` (the
    /// user had to make the same correction twice before anything
    /// happened), then a partial relaxation that ran at count=1
    /// for proper-noun-like edits but still required count>=2 for
    /// everything else — both versions leaked the count threshold
    /// into UX. From the user's perspective, "I gave the system a
    /// correction and it did nothing" is broken, regardless of how
    /// cheap or conservative the gate was internally. The bench
    /// established 100% precision on every skip category (common-
    /// word swaps, grammar fixes, function words, self-corrections,
    /// punctuation, multi-word rewrites, single-char finds), so
    /// the threshold was guarding against a failure mode that
    /// doesn't actually appear.
    ///
    /// In-memory dedup via `classifierAttempted` still prevents
    /// re-classifying the same (from, to) pair within a single
    /// session.
    ///
    /// Also called from `syncFromServer` so a fresh launch picks up
    /// any rows that were left local-only on a previous session
    /// (offline, classifier rate-limited, etc.) — the in-memory
    /// `classifierAttempted` set is empty at launch so everything
    /// gets a clean re-try.
    private func promotePromotables() {
        guard cloudSyncEnabled(), apiClient != nil else { return }
        for row in all where row.appliesTo == .local {
            let key = wireKey(from: row.fromText, to: row.toText)
            guard !classifierAttempted.contains(key) else { continue }
            classifierAttempted.insert(key)
            attemptPromotion(row)
        }
    }

    /// Run a single (from, to) pair through the server's classifier
    /// endpoint. If the classifier returns add=true, flip the local
    /// row's applies_to to .stt + push the change to the server.
    /// All errors are swallowed (best-effort) — the row stays local,
    /// which is the safe default.
    private func attemptPromotion(_ row: CorrectionRow) {
        guard let api = apiClient else { return }
        Task { [weak self, fromText = row.fromText, toText = row.toText] in
            do {
                let result = try await api.classifyVocabPair(
                    find: fromText,
                    replacement: toText
                )
                guard result.applied else {
                    // Classifier itself didn't run cleanly (no Groq
                    // key, timeout, etc). Leave the row local. The
                    // next ingest on the same key won't re-attempt
                    // (in-memory dedup), but a fresh launch will.
                    Logger.shared.info(
                        "classifier skipped \(fromText)→\(toText): \(result.errorReason ?? "no_detail")"
                    )
                    return
                }
                Logger.shared.info(
                    "classifier verdict for \(fromText)→\(toText): " +
                    "add=\(result.add) category=\(result.category)"
                )
                guard result.add else { return }
                await self?.applyPromotion(fromText: fromText, toText: toText)
            } catch SpeakistAPIClient.Error.notSignedIn {
                // Silent — the row stays local. Promotion will be
                // re-attempted next launch when the user signs in.
            } catch {
                Logger.shared.warn(
                    "classifier call failed for \(fromText)→\(toText): \(String(describing: error))"
                )
            }
        }
    }

    /// Promote a local row to applies_to=.stt and push the change up
    /// to the server. Looks the row up fresh from `all` so we don't
    /// race with concurrent mutations.
    private func applyPromotion(fromText: String, toText: String) {
        guard
            var row = all.first(where: {
                $0.fromText == fromText && $0.toText == toText
            }),
            row.appliesTo == .local
        else {
            // Either the row was deleted between classifier-call and
            // -response, or it was already promoted by something else
            // (the user manually edited it in Settings, a server sync
            // landed first). Either way, nothing to do.
            return
        }
        row.appliesTo = .stt
        // upsert pushes to the server too, so the web view sees the
        // promotion and other clients pick it up on next sync.
        upsert(row)
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
        guard cloudSyncEnabled() else { return }
        do {
            // Local mode and signed-out use are allowed to mutate vocabulary.
            // Replay those durable mutations before reading remote state so a
            // stale server row cannot resurrect a rule the user deleted or
            // overwrite an edit made while Cloud was not selected.
            try await flushPendingVocabularyChanges(using: api)
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
            // After we've reconciled with the server, re-check for
            // any local rows that should now be promoted. Catches
            // rows that were left local-only on a previous session
            // (e.g., user dictated offline, or the classifier was
            // rate-limited and we gave up after the in-memory cap).
            promotePromotables()
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
        let wire = makeWire(from: row)
        enqueuePendingVocabularyChange(wire)
        flushPendingVocabularyChangesInBackground()
    }

    /// Push a tombstone for a `(from, to)` pair the user just deleted.
    private func pushDelete(from fromText: String, to toText: String) {
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
        enqueuePendingVocabularyChange(wire)
        flushPendingVocabularyChangesInBackground()
    }

    /// Push the rows touched by a recent `ingest(pairs:)` so auto-
    /// learned corrections show up on the web alongside manual ones.
    private func pushTouchedPairs(_ pairs: [CorrectionPair]) {
        guard !pairs.isEmpty else { return }
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
        wire.forEach(enqueuePendingVocabularyChange)
        flushPendingVocabularyChangesInBackground()
    }

    private func enqueuePendingVocabularyChange(
        _ wire: SpeakistAPIClient.VocabEntryWire
    ) {
        guard let dbQueue else { return }
        do {
            let payload = try JSONEncoder().encode(wire)
            try dbQueue.write { db in
                try db.execute(
                    sql: """
                        INSERT INTO correction_sync_queue
                          (from_text, to_text, payload)
                        VALUES (?, ?, ?)
                        ON CONFLICT(from_text, to_text) DO UPDATE SET
                          payload = excluded.payload
                        """,
                    arguments: [wire.from, wire.to, payload])
            }
        } catch {
            Logger.shared.error(
                "queue vocabulary change failed: \(error.localizedDescription)")
        }
    }

    private func flushPendingVocabularyChangesInBackground() {
        guard cloudSyncEnabled(), let api = apiClient else { return }
        Task { [weak self] in
            do {
                try await self?.flushPendingVocabularyChanges(using: api)
            } catch SpeakistAPIClient.Error.notSignedIn {
                // Keep the durable queue for the next signed-in Cloud sync.
            } catch {
                Logger.shared.warn(
                    "push queued vocabulary changes failed: \(String(describing: error))")
            }
        }
    }

    private func flushPendingVocabularyChanges(
        using api: SpeakistAPIClient
    ) async throws {
        guard let dbQueue else { return }
        let pending = try await dbQueue.read { db -> [SpeakistAPIClient.VocabEntryWire] in
            let payloads = try Data.fetchAll(
                db,
                sql: "SELECT payload FROM correction_sync_queue ORDER BY rowid")
            return try payloads.map { try JSONDecoder().decode(
                SpeakistAPIClient.VocabEntryWire.self,
                from: $0)
            }
        }
        guard !pending.isEmpty else { return }

        _ = try await api.pushVocabulary(entries: pending)
        try await dbQueue.write { db in
            for wire in pending {
                let payload = try JSONEncoder().encode(wire)
                try db.execute(
                    sql: """
                        DELETE FROM correction_sync_queue
                        WHERE from_text = ? AND to_text = ? AND payload = ?
                        """,
                    arguments: [wire.from, wire.to, payload])
            }
        }
    }

    func pendingVocabularyChangesForTesting() throws -> [SpeakistAPIClient.VocabEntryWire] {
        guard let dbQueue else { return [] }
        return try dbQueue.read { db in
            let payloads = try Data.fetchAll(
                db,
                sql: "SELECT payload FROM correction_sync_queue ORDER BY rowid")
            return try payloads.map {
                try JSONDecoder().decode(SpeakistAPIClient.VocabEntryWire.self, from: $0)
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
        migrator.registerMigration("v3_correction_metadata") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS correction_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
        }
        migrator.registerMigration("v4_correction_sync_queue") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS correction_sync_queue (
                    from_text TEXT NOT NULL,
                    to_text TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    PRIMARY KEY(from_text, to_text)
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
