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

import { and, desc, eq, gt, sql } from "drizzle-orm";
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

/** Canonical list of polish modes. Exported so API route handlers and
 *  MCP tools can validate hand-typed input against the same source of
 *  truth the domain layer uses, instead of redeclaring the array. */
export const ALL_MODES: readonly PolishPromptMode[] = [
  "intuitive",
  "prescriptive",
];

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
  const whereExpr = opts.since
    ? and(
        eq(polishPromptVersions.mode, mode),
        gt(polishPromptVersions.createdAt, opts.since)
      )
    : eq(polishPromptVersions.mode, mode);
  const rows = await db
    .select()
    .from(polishPromptVersions)
    .where(whereExpr)
    .orderBy(desc(polishPromptVersions.createdAt))
    .limit(limit);
  return rows.map(hydrate);
}

// ---- Writes ---------------------------------------------------------------

/** Exactly-one-of provenance: every version is attributed either to a
 *  super admin (admin UI) or to a service token (MCP agent). Encoded
 *  as a discriminated union so the compiler rejects both-or-neither
 *  at the call site instead of relying on a runtime guard. */
type Provenance =
  | { createdByUserId: string; createdByTokenId?: never }
  | { createdByTokenId: string; createdByUserId?: never };

export type CreateVersionArgs = {
  mode: PolishPromptMode;
  /** New prompt body. Rejected if empty / whitespace-only. */
  body: string;
  /** Free-form context — why this version exists, what changed. */
  notes?: string;
  /** Provenance of this version. `rollback` is rejected here; use
   *  `rollbackToVersion` instead so the FK + notes prefix are set
   *  correctly. */
  source: Exclude<PolishPromptSource, "rollback">;
  benchScore?: number;
  benchResults?: unknown;
} & Provenance;

export interface RollbackArgs {
  mode: PolishPromptMode;
  /** ID of the version to restore. Its body is copied into a new row. */
  targetVersionId: string;
  /** Optional caller-supplied notes. Combined with the auto-generated
   *  "Rolled back from vN" prefix. */
  notes?: string;
  /** Admin user performing the rollback. Required — rollback is not
   *  exposed via MCP, so the token-driven path is intentionally
   *  unrepresentable here. */
  createdByUserId: string;
}

/** Bounds for the bench score; rejected as a programming error if
 *  callers pass anything else. The bench harness emits 0..1. */
function assertBenchScore(score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`bench_score out of range [0,1]: ${score}`);
  }
}

/** Shared core for createVersion + rollbackToVersion. Reads
 *  MAX(version)+1, deactivates the current active row, inserts the
 *  new one with `.returning()` so we never need a post-insert SELECT.
 *  The (mode, version) unique index is the safety net for the
 *  read-then-write race window between the MAX read and the INSERT —
 *  we translate that specific failure into a retryable user-facing
 *  message so the admin UI doesn't surface a raw SqliteError. */
async function insertActiveVersion(args: {
  mode: PolishPromptMode;
  body: string;
  notes: string | null;
  source: PolishPromptSource;
  rolledBackFromVersionId: string | null;
  benchScore: number | null;
  benchResultsJson: string | null;
  createdByUserId: string | null;
  createdByTokenId: string | null;
}): Promise<PromptVersion> {
  const db = getDb();

  const [maxRow] = await db
    .select({
      max: sql<number>`COALESCE(MAX(${polishPromptVersions.version}), 0)`,
    })
    .from(polishPromptVersions)
    .where(eq(polishPromptVersions.mode, args.mode))
    .limit(1);
  const nextVersion = (maxRow?.max ?? 0) + 1;

  // Deactivate the current active row, if any. Filtered on
  // is_active = 1 so the partial unique index can't be tripped by
  // a concurrent insert: at most one row matches.
  await db
    .update(polishPromptVersions)
    .set({ isActive: false })
    .where(
      and(
        eq(polishPromptVersions.mode, args.mode),
        eq(polishPromptVersions.isActive, true)
      )
    );

  let inserted: typeof polishPromptVersions.$inferSelect | undefined;
  try {
    [inserted] = await db
      .insert(polishPromptVersions)
      .values({
        id: crypto.randomUUID(),
        mode: args.mode,
        version: nextVersion,
        body: args.body,
        notes: args.notes,
        source: args.source,
        isActive: true,
        rolledBackFromVersionId: args.rolledBackFromVersionId,
        benchScore: args.benchScore,
        benchResultsJson: args.benchResultsJson,
        createdByUserId: args.createdByUserId,
        createdByTokenId: args.createdByTokenId,
      })
      .returning();
  } catch (err) {
    // Most likely cause: another writer landed (mode, nextVersion)
    // between our MAX read and this INSERT. Surface a clear retry
    // message instead of the raw SqliteError text.
    if (
      err instanceof Error &&
      /UNIQUE constraint failed/i.test(err.message)
    ) {
      throw new Error(
        "Another prompt version was created concurrently. Refresh and try again."
      );
    }
    throw err;
  }
  if (!inserted) {
    // D1 returning() should always yield exactly one row on a
    // successful single-row insert. Throw rather than return a
    // half-state if something upstream changed that contract.
    throw new Error("insertActiveVersion: insert returned no rows");
  }

  // TODO(PR 3): notifyPromptUpdate(...) once the prompt_update Slack
  // destination lands. Fire-and-forget after this return so a Slack
  // failure can't block the DB commit.

  return hydrate(inserted);
}

/**
 * Create a new version and atomically promote it to active. The
 * caller's `source` must be one of admin/agent/seed/mirror;
 * `rollback` goes through `rollbackToVersion` so the FK and notes
 * prefix get set correctly.
 */
export async function createVersion(
  args: CreateVersionArgs
): Promise<PromptVersion> {
  assertMode(args.mode);
  if ((args.source as PolishPromptSource) === "rollback") {
    throw new Error(
      "createVersion does not accept source='rollback'; use rollbackToVersion instead"
    );
  }
  const body = args.body?.trim();
  if (!body) {
    throw new Error("body is empty after trim — rejecting to protect prod");
  }
  if (args.benchScore !== undefined) {
    assertBenchScore(args.benchScore);
  }

  return insertActiveVersion({
    mode: args.mode,
    body,
    notes: args.notes?.trim() ?? null,
    source: args.source,
    rolledBackFromVersionId: null,
    benchScore: args.benchScore ?? null,
    benchResultsJson:
      args.benchResults !== undefined
        ? JSON.stringify(args.benchResults)
        : null,
    createdByUserId: args.createdByUserId ?? null,
    createdByTokenId: args.createdByTokenId ?? null,
  });
}

/**
 * Forward-only rollback. Copies `targetVersionId`'s body into a new
 * version with `source = 'rollback'` and
 * `rolledBackFromVersionId = target.id`, then promotes it to active.
 * The notes field is auto-prefixed with "Rolled back from v{N}".
 * Bench score does NOT carry over — the new row records the rollback
 * action, not a re-bench of the old prompt.
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

  const prefix = `Rolled back from v${target.version}`;
  const targetNotePart = target.notes ? `: ${target.notes}` : "";
  const callerNote = args.notes?.trim();
  const notes = callerNote
    ? `${prefix}${targetNotePart}\n---\n${callerNote}`
    : `${prefix}${targetNotePart}`;

  return insertActiveVersion({
    mode: args.mode,
    body: target.body,
    notes,
    source: "rollback",
    rolledBackFromVersionId: target.id,
    benchScore: null,
    benchResultsJson: null,
    createdByUserId: args.createdByUserId,
    createdByTokenId: null,
  });
}
