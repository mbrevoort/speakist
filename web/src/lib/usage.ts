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

export async function getUsageSummary(orgId: string): Promise<UsageSummary> {
  const db = getDb();

  const now = Date.now();
  const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

  async function rollup(since?: Date) {
    const where = since
      ? and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, since))
      : eq(usageEvents.orgId, orgId);
    const [row] = await db
      .select({
        events: sql<number>`COUNT(*)`,
        words: sql<number>`COALESCE(SUM(${usageEvents.wordCount}), 0)`,
        cost: sql<number>`COALESCE(SUM(${usageEvents.costMillicents}), 0)`,
      })
      .from(usageEvents)
      .where(where);
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

/** Word+cost totals for each of the last N days (including today). */
export async function getUsageByDay(orgId: string, days = 14): Promise<DayPoint[]> {
  const db = getDb();
  // SQLite's strftime — created_at is stored as Unix ms (integer); divide
  // by 1000 and format as YYYY-MM-DD. GROUP BY day, latest first.
  const rows = await db.all<{ day: string; words: number; cost: number }>(sql`
    SELECT
      strftime('%Y-%m-%d', ${usageEvents.createdAt} / 1000, 'unixepoch') AS day,
      COALESCE(SUM(${usageEvents.wordCount}), 0) AS words,
      COALESCE(SUM(${usageEvents.costMillicents}), 0) AS cost
    FROM ${usageEvents}
    WHERE ${usageEvents.orgId} = ${orgId}
      AND ${usageEvents.createdAt} >= ${Date.now() - days * 24 * 60 * 60 * 1000}
    GROUP BY day
    ORDER BY day ASC
  `);

  // Fill in missing days so the chart doesn't have gaps.
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DayPoint[] = [];
  const todayUtcMidnight = new Date();
  todayUtcMidnight.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtcMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({
      day: key,
      words: row ? Number(row.words) : 0,
      costMillicents: row ? Number(row.cost) : 0,
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
  costMillicents: number;
  model: string;
  createdAt: Date;
}

export async function getRecentEvents(orgId: string, limit = 20): Promise<RecentEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: usageEvents.id,
      userEmail: users.email,
      userDisplayName: users.displayName,
      wordCount: usageEvents.wordCount,
      audioMs: usageEvents.audioMs,
      costMillicents: usageEvents.costMillicents,
      model: usageEvents.model,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .where(eq(usageEvents.orgId, orgId))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, audioMs: r.audioMs ?? null }));
}
