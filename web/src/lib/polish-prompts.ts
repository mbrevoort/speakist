// Domain layer for versioned polish prompts.
//
// Every read and write of `polish_prompt_versions` flows through this
// module. The schema (migration 0022) enforces "one active row per
// mode" via a partial unique index, but the active-row maintenance
// (deactivate-then-insert) and version numbering live here. Route
// handlers, server actions, and MCP tools all import the helpers
// below; nothing else touches the table directly.
//
// Active-row maintenance:
//   D1 doesn't expose multi-statement transactions through drizzle-orm/d1,
//   so createVersion runs two sequential statements:
//     1. UPDATE ... SET is_active = 0 WHERE mode = ? AND is_active = 1
//     2. INSERT ... is_active = 1
//   Between them there's a brief window (sub-ms) in which no row is
//   active. The resolver in lib/transcription/polish.ts handles that
//   case by falling back through to the deprecated app_settings
//   columns and then to the baked-in default — no read ever fails.
//
// Race against concurrent createVersion calls:
//   Two callers compute MAX(version)+1 simultaneously, both pick the
//   same number, and the second INSERT loses against the
//   `(mode, version)` unique index. The constraint error surfaces to
//   the caller as a SqliteError; admin operations are infrequent
//   enough that "try again" is acceptable, and we surface a clear
//   message rather than swallowing it.
//
// Rollback semantics:
//   rollbackToVersion is *forward-only*. Calling "roll back to v7"
//   creates a new v8 with v7's body, `source = 'rollback'`, and
//   `rolledBackFromVersionId = v7.id`. The notes field is prefixed
//   with "Rolled back from v7" so the timeline is self-describing.
//   The old active row stays in history; nothing is destructive.
//
// Slack notification:
//   createVersion and rollbackToVersion both have a placeholder for
//   the prompt-update Slack ping. The actual call lands in PR 3 along
//   with the new `prompt_update` destination on lib/slack.ts. Until
//   then the placeholder is a no-op so PR 1 is self-contained.

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  polishPromptVersions,
  type PolishPromptMode,
  type PolishPromptSource,
} from "@/lib/db/schema";

// Re-export the shared types so callers can import everything from
// this module without reaching into the Drizzle schema.
export type { PolishPromptMode, PolishPromptSource };

/** Hydrated representation of a single version row. */
export interface PromptVersion {
  id: string;
  mode: PolishPromptMode;
  version: number;
  body: string;
  notes: string | null;
  source: PolishPromptSource;
  isActive: boolean;
  rolledBackFromVersionId: string | null;
  benchScore: number | null;
  /** Parsed JSON; shape owned by the bench harness. `null` when no
   *  bench was run for this version. */
  benchResults: unknown | null;
  createdAt: Date;
  createdByUserId: string | null;
  createdByTokenId: string | null;
}

const ALL_MODES: readonly PolishPromptMode[] = ["intuitive", "prescriptive"];

/** Cheap sanity guard for hand-typed input (route handlers, MCP
 *  tools). Zod schemas in those callers do the real validation; this
 *  is the last line of defense inside the domain layer. */
function assertMode(mode: PolishPromptMode): void {
  if (!ALL_MODES.includes(mode)) {
    throw new Error(`invalid mode: ${mode}`);
  }
}

/** Hydrate a raw row from the DB into the typed shape callers want.
 *  Centralizes the JSON.parse of bench_results_json so we don't
 *  scatter try/catch around every call site. */
function hydrate(row: typeof polishPromptVersions.$inferSelect): PromptVersion {
  let benchResults: unknown | null = null;
  if (row.benchResultsJson) {
    try {
      benchResults = JSON.parse(row.benchResultsJson);
    } catch {
      // Don't blow up the whole resolver if a single row's JSON is
      // malformed (could happen with a hand-edit gone wrong).
      // Callers see null and treat it as "no bench data".
      benchResults = null;
    }
  }
  return {
    id: row.id,
    mode: row.mode,
    version: row.version,
    body: row.body,
    notes: row.notes,
    source: row.source,
    isActive: row.isActive,
    rolledBackFromVersionId: row.rolledBackFromVersionId,
    benchScore: row.benchScore,
    benchResults,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    createdByTokenId: row.createdByTokenId,
  };
}

// ---- Reads ----------------------------------------------------------------

/**
 * Return the currently active prompt for a mode, or null if none has
 * been created yet (fresh install with no app_settings override).
 *
 * The caller (resolver in lib/transcription/polish.ts) treats null as
 * "fall through to the legacy app_settings column, then to the
 * baked-in default." This function does NOT do that fallback itself
 * because the resolver needs to distinguish "no active version" from
 * "active version with empty body" (the latter is a bug, never a
 * legitimate state — empty bodies are rejected at write time).
 */
export async function getActivePrompt(
  mode: PolishPromptMode
): Promise<PromptVersion | null> {
  assertMode(mode);
  const db = getDb();
  const [row] = await db
    .select()
    .from(polishPromptVersions)
    .where(
      and(
        eq(polishPromptVersions.mode, mode),
        eq(polishPromptVersions.isActive, true)
      )
    )
    .limit(1);
  return row ? hydrate(row) : null;
}

/** Look up by (mode, version) — the natural identifier the admin UI
 *  and the MCP `get_polish_prompt_version` tool expose. */
export async function getPromptByVersion(
  mode: PolishPromptMode,
  version: number
): Promise<PromptVersion | null> {
  assertMode(mode);
  if (!Number.isInteger(version) || version < 1) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(polishPromptVersions)
    .where(
      and(
        eq(polishPromptVersions.mode, mode),
        eq(polishPromptVersions.version, version)
      )
    )
    .limit(1);
  return row ? hydrate(row) : null;
}

/** Look up by primary key. Used by rollbackToVersion to fetch the
 *  source row before copying its body. */
export async function getPromptById(
  id: string
): Promise<PromptVersion | null> {
  if (!id) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(polishPromptVersions)
    .where(eq(polishPromptVersions.id, id))
    .limit(1);
  return row ? hydrate(row) : null;
}

export interface ListVersionsOptions {
  /** Max rows to return. Defaults to 50; capped at 200 because the
   *  admin UI paginates anyway. */
  limit?: number;
  /** Only include rows created strictly after this timestamp. Lets
   *  the MCP agent advance a cursor across runs. */
  since?: Date;
}

/** Newest-first listing for a mode. The admin UI and the MCP
 *  `list_polish_prompt_versions` tool both call this; the projection
 *  difference (UI shows body inline, MCP omits it for compactness)
 *  is the caller's choice. */
export async function listVersions(
  mode: PolishPromptMode,
  opts: ListVersionsOptions = {}
): Promise<PromptVersion[]> {
  assertMode(mode);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const db = getDb();
  const rows = await db
    .select()
    .from(polishPromptVersions)
    .where(eq(polishPromptVersions.mode, mode))
    .orderBy(desc(polishPromptVersions.createdAt))
    .limit(limit);
  const filtered = opts.since
    ? rows.filter((r) => r.createdAt > opts.since!)
    : rows;
  return filtered.map(hydrate);
}

// ---- Writes ---------------------------------------------------------------

export interface CreateVersionArgs {
  mode: PolishPromptMode;
  /** New prompt body. Rejected if empty / whitespace-only. */
  body: string;
  /** Free-form context — why this version exists, what changed. */
  notes?: string;
  /** Provenance of this version. `rollback` is rejected here; use
   *  `rollbackToVersion` instead so the FK + notes prefix are set
   *  correctly. */
  source: Exclude<PolishPromptSource, "rollback">;
  /** Set for admin UI edits. Mutually exclusive with createdByTokenId. */
  createdByUserId?: string;
  /** Set for MCP service-token writes. Mutually exclusive with
   *  createdByUserId. */
  createdByTokenId?: string;
  benchScore?: number;
  benchResults?: unknown;
}

/** Bounds for the bench score; rejected as a programming error if
 *  callers pass anything else. The bench harness emits 0..1. */
function assertBenchScore(score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`bench_score out of range [0,1]: ${score}`);
  }
}

/**
 * Create a new version and atomically promote it to active.
 *
 * Steps (each a separate D1 statement; D1 doesn't expose multi-statement
 * transactions through drizzle):
 *   1. Compute next version via MAX(version)+1 (read).
 *   2. Deactivate any current active row for the mode (UPDATE).
 *   3. Insert the new row with is_active = 1 (INSERT).
 *
 * If step 3 fails (most likely on a (mode, version) race), the table
 * is left with no active row for that mode for the brief failure
 * window. The resolver's fallback chain handles that case; the caller
 * gets a thrown error and should retry.
 *
 * Returns the freshly-created PromptVersion.
 */
export async function createVersion(
  args: CreateVersionArgs
): Promise<PromptVersion> {
  assertMode(args.mode);
  if (args.source === ("rollback" as PolishPromptSource)) {
    throw new Error(
      "createVersion does not accept source='rollback'; use rollbackToVersion instead"
    );
  }
  const body = args.body?.trim();
  if (!body) {
    throw new Error("body is empty after trim — rejecting to protect prod");
  }
  if (args.createdByUserId && args.createdByTokenId) {
    throw new Error(
      "createVersion: pass either createdByUserId OR createdByTokenId, not both"
    );
  }
  if (args.benchScore !== undefined) {
    assertBenchScore(args.benchScore);
  }

  const db = getDb();

  // Step 1 — next version number. The unique (mode, version) index
  // is the safety net for the read-then-write race; we read here so
  // the common path doesn't throw.
  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${polishPromptVersions.version}), 0)` })
    .from(polishPromptVersions)
    .where(eq(polishPromptVersions.mode, args.mode))
    .limit(1);
  const nextVersion = (maxRow?.max ?? 0) + 1;

  // Step 2 — deactivate any current active row. Filtered on
  // is_active = 1 so the partial unique index doesn't get tripped
  // by a concurrent insert: at most one row matches.
  await db
    .update(polishPromptVersions)
    .set({ isActive: false })
    .where(
      and(
        eq(polishPromptVersions.mode, args.mode),
        eq(polishPromptVersions.isActive, true)
      )
    );

  // Step 3 — insert the new active row.
  const id = crypto.randomUUID();
  await db.insert(polishPromptVersions).values({
    id,
    mode: args.mode,
    version: nextVersion,
    body,
    notes: args.notes?.trim() ?? null,
    source: args.source,
    isActive: true,
    rolledBackFromVersionId: null,
    benchScore: args.benchScore ?? null,
    benchResultsJson:
      args.benchResults !== undefined ? JSON.stringify(args.benchResults) : null,
    createdByUserId: args.createdByUserId ?? null,
    createdByTokenId: args.createdByTokenId ?? null,
  });

  // TODO(PR 3): notifyPromptUpdate({ mode, newVersion: nextVersion, source: args.source, ... }).
  // Wired up in the same PR that adds the `prompt_update` Slack destination.

  const fresh = await getPromptById(id);
  if (!fresh) {
    // Defensive — the row was just written, so this is impossible
    // unless D1 lost the write. Throw rather than return a half-state.
    throw new Error(
      `createVersion: row ${id} not found immediately after insert`
    );
  }
  return fresh;
}

export interface RollbackArgs {
  mode: PolishPromptMode;
  /** ID of the version to restore. Its body is copied into a new row. */
  targetVersionId: string;
  /** Optional caller-supplied notes. Will be combined with the auto-
   *  generated "Rolled back from vN" prefix. */
  notes?: string;
  /** Admin user performing the rollback. Required — rollback is not
   *  exposed via MCP in PR 3, so a token-driven path is intentionally
   *  rejected at the domain layer. */
  createdByUserId: string;
}

/**
 * Forward-only rollback. Looks up `targetVersionId`, copies its body
 * into a brand-new version with `source = 'rollback'` and
 * `rolledBackFromVersionId = target.id`, then promotes that new
 * version to active. The previous active row is deactivated as a
 * side effect of createVersion's invariants.
 *
 * The notes field is auto-prefixed with "Rolled back from v{N}" so
 * the admin UI timeline reads naturally. If the caller supplies
 * additional notes they're appended after a separator.
 */
export async function rollbackToVersion(
  args: RollbackArgs
): Promise<PromptVersion> {
  assertMode(args.mode);
  if (!args.createdByUserId) {
    throw new Error(
      "rollbackToVersion: createdByUserId is required (rollback is admin-only)"
    );
  }
  const target = await getPromptById(args.targetVersionId);
  if (!target) {
    throw new Error(`target version not found: ${args.targetVersionId}`);
  }
  if (target.mode !== args.mode) {
    throw new Error(
      `target version is mode='${target.mode}' but rollback requested mode='${args.mode}'`
    );
  }
  if (target.isActive) {
    throw new Error(
      `target version v${target.version} is already active — nothing to roll back to`
    );
  }

  // Compose the notes: machine-readable prefix + optional human note.
  const prefix = `Rolled back from v${target.version}`;
  const targetNotePart = target.notes ? `: ${target.notes}` : "";
  const callerNote = args.notes?.trim();
  const notes = callerNote
    ? `${prefix}${targetNotePart}\n---\n${callerNote}`
    : `${prefix}${targetNotePart}`;

  const db = getDb();

  // Same shape as createVersion (next-version read, deactivate,
  // insert), but with source = 'rollback' and the FK set. We can't
  // call createVersion directly because it explicitly rejects
  // source='rollback' to keep the typing honest at the public
  // surface.
  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${polishPromptVersions.version}), 0)` })
    .from(polishPromptVersions)
    .where(eq(polishPromptVersions.mode, args.mode))
    .limit(1);
  const nextVersion = (maxRow?.max ?? 0) + 1;

  await db
    .update(polishPromptVersions)
    .set({ isActive: false })
    .where(
      and(
        eq(polishPromptVersions.mode, args.mode),
        eq(polishPromptVersions.isActive, true)
      )
    );

  const id = crypto.randomUUID();
  await db.insert(polishPromptVersions).values({
    id,
    mode: args.mode,
    version: nextVersion,
    body: target.body,
    notes,
    source: "rollback",
    isActive: true,
    rolledBackFromVersionId: target.id,
    // Bench score does NOT carry over — the rollback is the action
    // being recorded, not a re-bench of the old prompt. Admin UI
    // can show the target's bench_score alongside if useful.
    benchScore: null,
    benchResultsJson: null,
    createdByUserId: args.createdByUserId,
    createdByTokenId: null,
  });

  // TODO(PR 3): notifyPromptUpdate({ mode, newVersion: nextVersion, source: 'rollback', ... }).

  const fresh = await getPromptById(id);
  if (!fresh) {
    throw new Error(
      `rollbackToVersion: row ${id} not found immediately after insert`
    );
  }
  return fresh;
}
