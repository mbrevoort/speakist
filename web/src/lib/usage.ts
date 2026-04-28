// Usage queries for the dashboard.
//
// The hot tables are `usage_events` (one row per transcription) and the
// per-(org, user, day) rollup `usage_daily` populated by
// `recordDailyUsage` in lib/credits.ts. Aggregate queries (summary
// tiles, by-day chart, top users) read the rollup so they scale with
// active-user count rather than total event volume. Single-event
// reads (recent events feed) still hit `usage_events` because we want
// the individual rows + per-event metadata (provider/model/polish).

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { usageDaily, usageEvents, users } from "@/lib/db/schema";

// --- summary tiles ---------------------------------------------------------

export interface UsageSummary {
  last7Days: { events: number; words: number; costMillicents: number };
  last30Days: { events: number; words: number; costMillicents: number };
  allTime: { events: number; words: number; costMillicents: number };
}

/**
 * Summary-tile rollup for an org. Pass `userId` to scope to a single
 * user's activity — used on the member's self-view of /dashboard/usage.
 * Without it, the rollup sums the whole org (admin view).
 *
 * Reads `usage_daily` — one row per (org, user, day). 7-day and
 * 30-day clauses filter on `day_ts`; the all-time roll has no
 * filter. All three queries hit the (org_id, day_ts) index.
 */
export async function getUsageSummary(
  orgId: string,
  userId?: string
): Promise<UsageSummary> {
  const db = getDb();

  const now = Date.now();
  const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

  async function rollup(since?: Date) {
    const conds = [eq(usageDaily.orgId, orgId)];
    if (since) conds.push(gte(usageDaily.dayTs, since));
    if (userId) conds.push(eq(usageDaily.userId, userId));
    const [row] = await db
      .select({
        events: sql<number>`COALESCE(SUM(${usageDaily.events}), 0)`,
        words: sql<number>`COALESCE(SUM(${usageDaily.wordCount}), 0)`,
        cost: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`,
      })
      .from(usageDaily)
      .where(and(...conds));
    return {
      events: Number(row?.events ?? 0),
      words: Number(row?.words ?? 0),
      costMillicents: Number(row?.cost ?? 0),
    };
  }

  const [last7Days, last30Days, allTime] = await Promise.all([
    rollup(since7),
    rollup(since30),
    rollup(),
  ]);
  return { last7Days, last30Days, allTime };
}

// --- per-day chart series --------------------------------------------------

export interface DayPoint {
  /** YYYY-MM-DD in UTC. */
  day: string;
  words: number;
  costMillicents: number;
}

/** Word+cost totals for each of the last N days (including today).
 *  Pass `userId` to scope to a single member's activity.
 *
 *  Reads `usage_daily` — already grouped by (org, user, day), so we
 *  GROUP BY `day_ts` to merge users when no `userId` filter is set
 *  and produce one point per day. The dense fill below ensures the
 *  chart has zero rows for inactive days. */
export async function getUsageByDay(
  orgId: string,
  days = 14,
  userId?: string
): Promise<DayPoint[]> {
  const db = getDb();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs);

  const conds = [
    eq(usageDaily.orgId, orgId),
    gte(usageDaily.dayTs, since),
  ];
  if (userId) conds.push(eq(usageDaily.userId, userId));
  const rows = await db
    .select({
      dayTs: usageDaily.dayTs,
      words: sql<number>`COALESCE(SUM(${usageDaily.wordCount}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`,
    })
    .from(usageDaily)
    .where(and(...conds))
    .groupBy(usageDaily.dayTs);

  const byDay = new Map<string, { words: number; cost: number }>();
  for (const r of rows) {
    const d = r.dayTs instanceof Date ? r.dayTs : new Date(Number(r.dayTs));
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, {
      words: Number(r.words ?? 0),
      cost: Number(r.cost ?? 0),
    });
  }

  // Fill in missing days so the chart doesn't have gaps.
  const out: DayPoint[] = [];
  const todayUtcMidnight = new Date();
  todayUtcMidnight.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtcMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    out.push({
      day: key,
      words: bucket?.words ?? 0,
      costMillicents: bucket?.cost ?? 0,
    });
  }

  return out;
}

// --- top users -------------------------------------------------------------

export interface TopUserRow {
  userId: string;
  email: string;
  displayName: string | null;
  events: number;
  words: number;
  costMillicents: number;
}

/**
 * Top contributors in an org over the trailing 30 days. Reads the
 * rollup grouped by user; was previously an unbounded GROUP BY against
 * the raw events table. The 30-day bound is fixed (rather than
 * configurable) because the dashboard renders this as "this month"
 * context — a longer window is what the org admin would look at on
 * the per-user admin pages, not here.
 */
export async function getTopUsers(orgId: string, limit = 10): Promise<TopUserRow[]> {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      events: sql<number>`COALESCE(SUM(${usageDaily.events}), 0)`,
      words: sql<number>`COALESCE(SUM(${usageDaily.wordCount}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`,
    })
    .from(usageDaily)
    .innerJoin(users, eq(users.id, usageDaily.userId))
    .where(and(eq(usageDaily.orgId, orgId), gte(usageDaily.dayTs, since30)))
    .groupBy(users.id)
    .orderBy(desc(sql`COALESCE(SUM(${usageDaily.wordCount}), 0)`))
    .limit(limit);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName,
    events: Number(r.events),
    words: Number(r.words),
    costMillicents: Number(r.cost),
  }));
}

// --- recent events feed ----------------------------------------------------
//
// Stays on `usage_events` — we want the individual transcription rows
// (provider/model/polish flag/processingMs) which the rollup intentionally
// doesn't preserve. Bounded by `limit` (default 20), so even with
// millions of events the read is constant-time via the
// (org_id, created_at) index.

export interface RecentEvent {
  id: string;
  userEmail: string;
  userDisplayName: string | null;
  wordCount: number;
  audioMs: number | null;
  /** Wall-clock Worker processing time — null for events from before
   *  migration 0008 or any event where the Worker crashed mid-request. */
  processingMs: number | null;
  costMillicents: number;
  model: string;
  providerId: string;
  polishApplied: boolean;
  createdAt: Date;
}

export async function getRecentEvents(
  orgId: string,
  limit = 20,
  userId?: string
): Promise<RecentEvent[]> {
  const db = getDb();
  const conds = [eq(usageEvents.orgId, orgId)];
  if (userId) conds.push(eq(usageEvents.userId, userId));
  const rows = await db
    .select({
      id: usageEvents.id,
      userEmail: users.email,
      userDisplayName: users.displayName,
      wordCount: usageEvents.wordCount,
      audioMs: usageEvents.audioMs,
      processingMs: usageEvents.processingMs,
      costMillicents: usageEvents.costMillicents,
      model: usageEvents.model,
      providerId: usageEvents.providerId,
      polishApplied: usageEvents.polishApplied,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .where(and(...conds))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    audioMs: r.audioMs ?? null,
    processingMs: r.processingMs ?? null,
  }));
}
