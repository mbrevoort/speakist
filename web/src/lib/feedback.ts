// DB helpers for the super-admin /admin/feedback pages.
//
// Queries here READ cross-org data, so every caller MUST gate with
// `requireSuperAdmin()` before invoking. Follows the same convention
// as `lib/admin.ts`.

import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  organizations,
  transcriptionFeedback,
  users,
  type TranscriptionFeedback,
} from "@/lib/db/schema";

export type FeedbackStatus =
  | "new"
  | "reviewed"
  | "resolved"
  | "dismissed"
  | "proposed";

/** Decoded transcription-options snapshot from `transcription_options_json`.
 *  Mirrors the request shape of /api/transcribe, minus the bits the
 *  feedback row already stores in dedicated columns (provider, model,
 *  language, audioSeconds, keyterms). Every field optional because
 *  feedback rows from before this column existed have NULL and clients
 *  may legitimately omit fields they don't track. */
export interface TranscriptionOptionsSnapshot {
  dictation?: boolean;
  fillerWords?: boolean;
  measurements?: boolean;
  profanityFilter?: boolean;
  detectLanguage?: boolean;
  /** "find:replacement" pairs as sent on /api/transcribe. */
  replaceRules?: string[];
  /** Free-form for forward compatibility — any extra fields the client
   *  serialized that we haven't formalized yet stay accessible by name. */
  [extra: string]: unknown;
}

export interface FeedbackListRow {
  id: string;
  createdAt: Date;
  userId: string;
  userEmail: string;
  orgId: string;
  orgName: string;
  transcriptionClientId: string;
  rawText: string;
  polishedText: string;
  expectedText: string;
  provider: string;
  model: string;
  polishApplied: boolean;
  polishMode: "intuitive" | "prescriptive" | null;
  audioSeconds: number | null;
  language: string | null;
  /** Vocab/keyterm list the client had in scope at transcription time.
   *  `null` = client did not report a list (older Mac builds, current
   *  iOS). `[]` = explicitly empty. */
  keyterms: string[] | null;
  /** Decoded snapshot of the rest of the transcribe request options.
   *  `null` = client did not report. */
  transcriptionOptions: TranscriptionOptionsSnapshot | null;
  failureKind: "wrong_word" | "punctuation" | "both" | "other" | null;
  userNote: string | null;
  hasAudio: boolean;
  status: FeedbackStatus;
  resolution: string | null;
  reviewedAt: Date | null;
}

export interface FeedbackDetail extends FeedbackListRow {
  audioObjectKey: string | null;
}

/**
 * Status-bucketed counts for the list page's filter chips. One round
 * trip, returns 0 for buckets with no rows so the chip always renders.
 */
export interface FeedbackStatusCounts {
  new: number;
  reviewed: number;
  resolved: number;
  dismissed: number;
  proposed: number;
  total: number;
}

export async function getFeedbackStatusCounts(): Promise<FeedbackStatusCounts> {
  const db = getDb();
  const rows = await db
    .select({
      status: transcriptionFeedback.status,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(transcriptionFeedback)
    .groupBy(transcriptionFeedback.status);

  const counts: FeedbackStatusCounts = {
    new: 0,
    reviewed: 0,
    resolved: 0,
    dismissed: 0,
    proposed: 0,
    total: 0,
  };
  for (const row of rows) {
    const n = Number(row.count);
    counts.total += n;
    if (row.status in counts) {
      counts[row.status as FeedbackStatus] = n;
    }
  }
  return counts;
}

export interface ListFeedbackOptions {
  status?: FeedbackStatus;
  /** Default 50, hard-capped at 200. */
  limit?: number;
}

export async function listFeedback(
  opts: ListFeedbackOptions = {}
): Promise<FeedbackListRow[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const baseSelect = db
    .select({
      id: transcriptionFeedback.id,
      createdAt: transcriptionFeedback.createdAt,
      userId: transcriptionFeedback.userId,
      userEmail: users.email,
      orgId: transcriptionFeedback.orgId,
      orgName: organizations.name,
      transcriptionClientId: transcriptionFeedback.transcriptionClientId,
      rawText: transcriptionFeedback.rawText,
      polishedText: transcriptionFeedback.polishedText,
      expectedText: transcriptionFeedback.expectedText,
      provider: transcriptionFeedback.provider,
      model: transcriptionFeedback.model,
      polishApplied: transcriptionFeedback.polishApplied,
      polishMode: transcriptionFeedback.polishMode,
      audioSeconds: transcriptionFeedback.audioSeconds,
      language: transcriptionFeedback.language,
      keytermsJson: transcriptionFeedback.keytermsJson,
      transcriptionOptionsJson:
        transcriptionFeedback.transcriptionOptionsJson,
      failureKind: transcriptionFeedback.failureKind,
      userNote: transcriptionFeedback.userNote,
      audioObjectKey: transcriptionFeedback.audioObjectKey,
      status: transcriptionFeedback.status,
      resolution: transcriptionFeedback.resolution,
      reviewedAt: transcriptionFeedback.reviewedAt,
    })
    .from(transcriptionFeedback)
    .innerJoin(users, eq(users.id, transcriptionFeedback.userId))
    .innerJoin(
      organizations,
      eq(organizations.id, transcriptionFeedback.orgId)
    )
    .orderBy(desc(transcriptionFeedback.createdAt))
    .limit(limit);

  const rows = opts.status
    ? await baseSelect.where(eq(transcriptionFeedback.status, opts.status))
    : await baseSelect;

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    userId: r.userId,
    userEmail: r.userEmail,
    orgId: r.orgId,
    orgName: r.orgName,
    transcriptionClientId: r.transcriptionClientId,
    rawText: r.rawText,
    polishedText: r.polishedText,
    expectedText: r.expectedText,
    provider: r.provider,
    model: r.model,
    polishApplied: r.polishApplied,
    polishMode: r.polishMode,
    audioSeconds: r.audioSeconds,
    language: r.language,
    keyterms: decodeKeyterms(r.keytermsJson),
    transcriptionOptions: decodeTranscriptionOptions(
      r.transcriptionOptionsJson
    ),
    failureKind: r.failureKind,
    userNote: r.userNote,
    hasAudio: r.audioObjectKey !== null,
    status: r.status,
    resolution: r.resolution,
    reviewedAt: r.reviewedAt,
  }));
}

export async function getFeedbackById(
  id: string
): Promise<FeedbackDetail | null> {
  const db = getDb();
  const [row] = await db
    .select({
      feedback: transcriptionFeedback,
      userEmail: users.email,
      orgName: organizations.name,
    })
    .from(transcriptionFeedback)
    .innerJoin(users, eq(users.id, transcriptionFeedback.userId))
    .innerJoin(
      organizations,
      eq(organizations.id, transcriptionFeedback.orgId)
    )
    .where(eq(transcriptionFeedback.id, id))
    .limit(1);
  if (!row) return null;
  const f: TranscriptionFeedback = row.feedback;
  return {
    id: f.id,
    createdAt: f.createdAt,
    userId: f.userId,
    userEmail: row.userEmail,
    orgId: f.orgId,
    orgName: row.orgName,
    transcriptionClientId: f.transcriptionClientId,
    rawText: f.rawText,
    polishedText: f.polishedText,
    expectedText: f.expectedText,
    provider: f.provider,
    model: f.model,
    polishApplied: f.polishApplied,
    polishMode: f.polishMode,
    audioSeconds: f.audioSeconds,
    language: f.language,
    keyterms: decodeKeyterms(f.keytermsJson),
    transcriptionOptions: decodeTranscriptionOptions(
      f.transcriptionOptionsJson
    ),
    failureKind: f.failureKind,
    userNote: f.userNote,
    hasAudio: f.audioObjectKey !== null,
    audioObjectKey: f.audioObjectKey,
    status: f.status,
    resolution: f.resolution,
    reviewedAt: f.reviewedAt,
  };
}

/** Parse the `keyterms_json` column into a string array. Returns null
 *  when the column is null/empty/malformed — old feedback rows and
 *  rows from clients that don't yet report keyterms both surface as
 *  null. A malformed payload also surfaces as null rather than
 *  throwing: the rest of the row is still useful for triage. */
function decodeKeyterms(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

/** Parse the `transcription_options_json` column into a typed
 *  snapshot. Same null-on-bad-data discipline as decodeKeyterms — the
 *  rest of the feedback row is still valuable even if this blob is
 *  missing or malformed. */
function decodeTranscriptionOptions(
  json: string | null
): TranscriptionOptionsSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as TranscriptionOptionsSnapshot;
  } catch {
    return null;
  }
}

/**
 * Shape suitable for pasting into `polish-fixtures.ts`. The fixture
 * file's actual TypeScript shape is richer (categories, tags, expected
 * outputs object) — this is the minimal seed a maintainer can hand-
 * massage into a real fixture entry.
 */
export interface FixtureExportEntry {
  source_feedback_id: string;
  reported_at: string; // ISO
  failure_kind: string | null;
  raw_input: string;
  polished_actual: string;
  polished_expected: string;
  user_note: string | null;
}

/**
 * Build a JSON-array of fixture seeds from a list of feedback rows.
 * Used by the "Export to JSON" button on the admin page.
 */
export function exportToFixtureSeeds(
  rows: Pick<
    TranscriptionFeedback,
    | "id"
    | "createdAt"
    | "rawText"
    | "polishedText"
    | "expectedText"
    | "failureKind"
    | "userNote"
  >[]
): FixtureExportEntry[] {
  return rows.map((r) => ({
    source_feedback_id: r.id,
    reported_at: r.createdAt.toISOString(),
    failure_kind: r.failureKind,
    raw_input: r.rawText,
    polished_actual: r.polishedText,
    polished_expected: r.expectedText,
    user_note: r.userNote,
  }));
}
