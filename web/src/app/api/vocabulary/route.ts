// GET/POST /api/vocabulary
//
// User-scoped vocabulary sync endpoint. The Mac app:
//   * Pulls the full set on launch via GET
//   * Pushes deltas on every correction save via POST (upsert by
//     (user_id, from_text, to_text))
//
// Server is the source of truth. Conflict resolution = last-write-wins per
// row via updated_at. Tombstones (deleted_at) are returned from GET so the
// Mac can reconcile its local cache rather than silently re-creating rows
// the user deleted on the web UI.
//
// Shape is deliberately flat — no diff protocol, no vector clock. At the
// volumes a single user produces (tens to low hundreds of corrections),
// full-sync on launch is fine and dramatically simpler.

import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { requireUserFromRequest, AuthzError } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { vocabularyEntries } from "@/lib/db/schema";

interface WireEntry {
  from: string;
  to: string;
  count: number;
  is_proper_noun: boolean;
  last_seen: string; // ISO
  updated_at: string; // ISO
  deleted: boolean;
}

// --- GET -------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Optional `?since=<iso>` for incremental sync. No watermark means "full".
  const sinceParam = new URL(req.url).searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : null;

  const db = getDb();
  const base = eq(vocabularyEntries.userId, user.id);
  const where = since ? and(base, gt(vocabularyEntries.updatedAt, since)) : base;

  const rows = await db
    .select()
    .from(vocabularyEntries)
    .where(where)
    .orderBy(vocabularyEntries.updatedAt);

  const entries: WireEntry[] = rows.map((r) => ({
    from: r.fromText,
    to: r.toText,
    count: r.count,
    is_proper_noun: r.isProperNoun,
    last_seen: r.lastSeen.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    deleted: !!r.deletedAt,
  }));

  return Response.json({
    entries,
    server_time: new Date().toISOString(),
  });
}

// --- POST ------------------------------------------------------------------

const upsertSchema = z.object({
  entries: z
    .array(
      z.object({
        from: z.string().trim().min(1).max(200),
        to: z.string().trim().min(1).max(500),
        count: z.number().int().min(0).optional(),
        is_proper_noun: z.boolean().optional(),
        last_seen: z.string().datetime().optional(),
        deleted: z.boolean().optional(),
      })
    )
    .max(500),
});

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const db = getDb();
  const now = new Date();

  // Straight-line upsert loop. 500-entry cap means this runs in well under a
  // second on D1. Batching via db.batch() is a later optimization if we ever
  // see large sync bursts.
  for (const e of parsed.data.entries) {
    const lastSeen = e.last_seen ? new Date(e.last_seen) : now;

    if (e.deleted) {
      await db
        .update(vocabularyEntries)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(vocabularyEntries.userId, user.id),
            eq(vocabularyEntries.fromText, e.from),
            eq(vocabularyEntries.toText, e.to)
          )
        );
      continue;
    }

    // UPSERT via INSERT OR REPLACE semantics; Drizzle has `onConflictDoUpdate`.
    await db
      .insert(vocabularyEntries)
      .values({
        userId: user.id,
        fromText: e.from,
        toText: e.to,
        count: e.count ?? 1,
        isProperNoun: e.is_proper_noun ?? false,
        lastSeen,
      })
      .onConflictDoUpdate({
        target: [
          vocabularyEntries.userId,
          vocabularyEntries.fromText,
          vocabularyEntries.toText,
        ],
        set: {
          count: e.count ?? undefined,
          isProperNoun: e.is_proper_noun ?? undefined,
          lastSeen,
          updatedAt: now,
          deletedAt: null, // re-adding a previously-deleted entry un-tombstones
        },
      });
  }

  return Response.json({ ok: true, processed: parsed.data.entries.length });
}
