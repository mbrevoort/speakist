// Usage queries for the dashboard.
//
// The Mac app will populate usage_events via POST /api/usage in Phase 6.
// Until then all these queries return empty/zero — pages render a friendly
// empty state.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { usageEvents, users } from "@/lib/db/schema";

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
    const conds = [eq(usageEvents.orgId, orgId)];
    if (since) conds.push(gte(usageEvents.createdAt, since));
    if (userId) conds.push(eq(usageEvents.userId, userId));
    const [row] = await db
      .select({
        events: sql<number>`COUNT(*)`,
        words: sql<number>`COALESCE(SUM(${usageEvents.wordCount}), 0)`,
        cost: sql<number>`COALESCE(SUM(${usageEvents.costMillicents}), 0)`,
      })
      .from(usageEvents)
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
 *  Pass `userId` to scope to a single member's activity. */
export async function getUsageByDay(
  orgId: string,
  days = 14,
  userId?: string
): Promise<DayPoint[]> {
  const db = getDb();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  // Fetch raw events in the window and bucket them in JavaScript. The
  // previous two revisions both tried SQL-side `GROUP BY strftime(...)`
  // — first with an alias (D1 rejected), then with the expression
  // inlined in groupBy/orderBy (ran without error but returned zero
  // rows in practice, for reasons we couldn't pin down between
  // Drizzle's timestamp_ms serialization and D1's strftime handling).
  //
  // Doing the grouping in JS sidesteps both. For realistic traffic a
  // 14-day window is a few hundred events at most; moving that over
  // the D1 wire is trivial, and the JS aggregation is straightforward
  // to reason about and test.
  //
  // Use `gte(col, Date)` for the date filter (not raw `sql\`col >=
  // ${ms}\``) — matches the exact pattern `getUsageSummary.rollup`
  // uses to filter "last 7 days" / "last 30 days", which is verified
  // to work against D1's timestamp_ms columns.
  const since = new Date(sinceMs);
  const conds = [
    eq(usageEvents.orgId, orgId),
    gte(usageEvents.createdAt, since),
  ];
  if (userId) conds.push(eq(usageEvents.userId, userId));
  const events = await db
    .select({
      createdAt: usageEvents.createdAt,
      wordCount: usageEvents.wordCount,
      costMillicents: usageEvents.costMillicents,
    })
    .from(usageEvents)
    .where(and(...conds));


  const byDay = new Map<string, { words: number; cost: number }>();
  for (const e of events) {
    // Drizzle unboxes timestamp_ms to Date on read; guard against
    // a raw number just in case a future driver revision changes that.
    const d = e.createdAt instanceof Date ? e.createdAt : new Date(Number(e.createdAt));
    const key = d.toISOString().slice(0, 10);
    const prev = byDay.get(key) ?? { words: 0, cost: 0 };
    byDay.set(key, {
      words: prev.words + Number(e.wordCount ?? 0),
      cost: prev.cost + Number(e.costMillicents ?? 0),
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

export async function getTopUsers(orgId: string, limit = 10): Promise<TopUserRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      events: sql<number>`COUNT(*)`,
      words: sql<number>`COALESCE(SUM(${usageEvents.wordCount}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageEvents.costMillicents}), 0)`,
    })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .where(eq(usageEvents.orgId, orgId))
    .groupBy(users.id)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.wordCount}), 0)`))
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
