// Super-admin queries. Every function here bypasses the authz helpers and
// reads cross-org data, so callers MUST gate with requireSuperAdmin() before
// invoking. We don't check inside these — the helpers are pure data access
// and get reused across both admin routes and Phase-6 internal jobs.

import { and, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  creditLedger,
  orgMembers,
  organizations,
  usageDaily,
  usageEvents,
  users,
  type OrgRole,
} from "@/lib/db/schema";

// --- platform rollups ------------------------------------------------------

export interface PlatformTotals {
  orgs: number;
  users: number;
  usage30dWords: number;
  usage30dEvents: number;
  balanceAllOrgsMillicents: number;
  topupsAllTimeMillicents: number;
}

export async function getPlatformTotals(): Promise<PlatformTotals> {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [orgsRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(organizations);
  const [usersRow] = await db.select({ n: sql<number>`COUNT(*)` }).from(users);

  // 30-day usage from the rollup table — one row per (org, user, day),
  // so this scans roughly N_active_users × 30 rows instead of every
  // raw event in the last month.
  const [usage30] = await db
    .select({
      events: sql<number>`COALESCE(SUM(${usageDaily.events}), 0)`,
      words: sql<number>`COALESCE(SUM(${usageDaily.wordCount}), 0)`,
    })
    .from(usageDaily)
    .where(gte(usageDaily.dayTs, since30));

  // Total outstanding credit liability across all orgs — sum of the
  // materialized balance column, which is one row per org rather
  // than one row per ledger entry.
  const [balance] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${organizations.balanceMillicents}), 0)`,
    })
    .from(organizations);

  // Sum of all top-up reasons (manual + auto) = gross revenue, pre-refund.
  // Stays on credit_ledger because there's no rollup of revenue events;
  // ledger row count for topups is small (one per Stripe charge).
  const [topups] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger)
    .where(
      or(
        eq(creditLedger.reason, "stripe_topup"),
        eq(creditLedger.reason, "stripe_auto_topup")
      )
    );

  return {
    orgs: Number(orgsRow?.n ?? 0),
    users: Number(usersRow?.n ?? 0),
    usage30dWords: Number(usage30?.words ?? 0),
    usage30dEvents: Number(usage30?.events ?? 0),
    balanceAllOrgsMillicents: Number(balance?.total ?? 0),
    topupsAllTimeMillicents: Number(topups?.total ?? 0),
  };
}

// --- table row counts (instrumentation) -----------------------------------
//
// Surfaced on /admin overview so the operator can eyeball the three
// high-volume tables every time they look at the dashboard. The two
// raw tables (`usage_events`, `credit_ledger`) approach D1's 10 GB
// hard ceiling at ~25M rows each; the rollup stays small (one row
// per active-user-day, capped at ~365 rows per user per year). Quick
// sanity for "are we headed toward a wall" without leaving the
// admin shell.

export interface TableRowCounts {
  usageEvents: number;
  creditLedger: number;
  usageDaily: number;
}

export async function getTableRowCounts(): Promise<TableRowCounts> {
  const db = getDb();
  const [eventsRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(usageEvents);
  const [ledgerRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(creditLedger);
  const [dailyRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(usageDaily);
  return {
    usageEvents: Number(eventsRow?.n ?? 0),
    creditLedger: Number(ledgerRow?.n ?? 0),
    usageDaily: Number(dailyRow?.n ?? 0),
  };
}

// --- platform-wide daily activity ------------------------------------------

export interface PlatformDayPoint {
  /** YYYY-MM-DD in UTC. */
  day: string;
  words: number;
  /** Distinct users with at least one usage_event on this day. */
  activeUsers: number;
}

/**
 * Per-day platform activity for the last N days (including today).
 * Reads the `usage_daily` rollup directly — one row per (org, user,
 * day) — so the query scales with active-user count, not raw event
 * count. Distinct-active-users per day is computed from those rows
 * (one rollup row per user per day, so COUNT(DISTINCT user_id) on
 * the matching day is exact).
 *
 * The series is dense: missing days appear as zero rows so the chart
 * doesn't have gaps.
 */
export async function getPlatformDailyUsage(
  days = 30
): Promise<PlatformDayPoint[]> {
  const db = getDb();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs);

  const rows = await db
    .select({
      dayTs: usageDaily.dayTs,
      userId: usageDaily.userId,
      wordCount: usageDaily.wordCount,
    })
    .from(usageDaily)
    .where(gte(usageDaily.dayTs, since));

  const byDay = new Map<string, { words: number; userIds: Set<string> }>();
  for (const r of rows) {
    const d = r.dayTs instanceof Date ? r.dayTs : new Date(Number(r.dayTs));
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? { words: 0, userIds: new Set<string>() };
    bucket.words += Number(r.wordCount ?? 0);
    bucket.userIds.add(r.userId);
    byDay.set(key, bucket);
  }

  const out: PlatformDayPoint[] = [];
  const todayUtcMidnight = new Date();
  todayUtcMidnight.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtcMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    out.push({
      day: key,
      words: bucket?.words ?? 0,
      activeUsers: bucket?.userIds.size ?? 0,
    });
  }

  return out;
}

// --- orgs list -------------------------------------------------------------

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  isComped: boolean;
  autoJoinDomain: string | null;
  hasDeepgramOverride: boolean;
  memberCount: number;
  balanceMillicents: number;
  lifetimeSpendMillicents: number;
  last30dEvents: number;
  createdAt: Date;
}

export async function listAllOrgs(filter?: string): Promise<AdminOrgRow[]> {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const where = filter
    ? or(
        like(organizations.name, `%${filter}%`),
        like(organizations.slug, `%${filter}%`),
        like(organizations.autoJoinDomain, `%${filter}%`)
      )
    : undefined;

  // Pre-aggregate the 30-day events count and lifetime spend from the
  // rollup table, then LEFT JOIN once. Replaces the previous N+1
  // correlated-subquery pattern (4 subqueries × N orgs); now it's
  // O(1) queries and the rollup itself is small enough for SQLite to
  // run the GROUP BY in milliseconds.
  const orgUsage = db
    .select({
      orgId: usageDaily.orgId,
      events30d: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.events} ELSE 0 END), 0)`.as("events30d"),
      lifetimeSpend: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`.as("lifetimeSpend"),
    })
    .from(usageDaily)
    .groupBy(usageDaily.orgId)
    .as("org_usage");

  const orgMemberCounts = db
    .select({
      orgId: orgMembers.orgId,
      n: sql<number>`COUNT(*)`.as("member_count"),
    })
    .from(orgMembers)
    .groupBy(orgMembers.orgId)
    .as("org_member_counts");

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      isComped: organizations.isComped,
      autoJoinDomain: organizations.autoJoinDomain,
      deepgramOverride: organizations.deepgramKeyOverrideEncrypted,
      createdAt: organizations.createdAt,
      // O(1) read of the materialized balance.
      balance: organizations.balanceMillicents,
      memberCount: sql<number>`COALESCE(${orgMemberCounts.n}, 0)`,
      events30d: sql<number>`COALESCE(${orgUsage.events30d}, 0)`,
      lifetimeSpend: sql<number>`COALESCE(${orgUsage.lifetimeSpend}, 0)`,
    })
    .from(organizations)
    .leftJoin(orgUsage, eq(orgUsage.orgId, organizations.id))
    .leftJoin(orgMemberCounts, eq(orgMemberCounts.orgId, organizations.id))
    .where(where)
    .orderBy(desc(organizations.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    isComped: r.isComped,
    autoJoinDomain: r.autoJoinDomain,
    hasDeepgramOverride: !!r.deepgramOverride,
    memberCount: Number(r.memberCount),
    balanceMillicents: Number(r.balance),
    lifetimeSpendMillicents: Number(r.lifetimeSpend),
    last30dEvents: Number(r.events30d),
    createdAt: r.createdAt,
  }));
}

// --- org detail ------------------------------------------------------------

export interface AdminOrgDetail extends AdminOrgRow {
  stripeCustomerId: string | null;
  hasPaymentMethod: boolean;
  autoTopupEnabled: boolean;
  hasGroqOverride: boolean;
  /** Parsed `allowed_models_json` — empty array means "no restriction". */
  allowedModels: string[];
  /** True when the org has flipped off the "Report bad transcription"
   *  feature; the column on `organizations`. Surfaced so the admin
   *  detail page can render the toggle. */
  feedbackDisabled: boolean;
}

export async function getOrgDetail(orgId: string): Promise<AdminOrgDetail | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      isComped: organizations.isComped,
      autoJoinDomain: organizations.autoJoinDomain,
      deepgramOverride: organizations.deepgramKeyOverrideEncrypted,
      groqOverride: organizations.groqKeyOverrideEncrypted,
      allowedModelsJson: organizations.allowedModelsJson,
      createdAt: organizations.createdAt,
      stripeCustomerId: organizations.stripeCustomerId,
      stripePmId: organizations.stripeDefaultPaymentMethodId,
      autoTopupEnabled: organizations.autoTopupEnabled,
      feedbackDisabled: organizations.feedbackDisabled,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!row) return null;

  let allowedModels: string[] = [];
  if (row.allowedModelsJson) {
    try {
      const parsed = JSON.parse(row.allowedModelsJson);
      if (Array.isArray(parsed)) {
        allowedModels = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // Treat malformed JSON as "no restriction" — matches orgAccess.ts behavior.
    }
  }

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [memberRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, orgId));
  // Balance comes straight off the org row — no SUM needed.
  const [balanceRow] = await db
    .select({ b: organizations.balanceMillicents })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  // Lifetime spend + 30d events both ride the rollup. Two queries
  // instead of two ledger/events scans, each ~365× smaller.
  const [spendRow] = await db
    .select({
      s: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`,
    })
    .from(usageDaily)
    .where(eq(usageDaily.orgId, orgId));
  const [eventsRow] = await db
    .select({ n: sql<number>`COALESCE(SUM(${usageDaily.events}), 0)` })
    .from(usageDaily)
    .where(and(eq(usageDaily.orgId, orgId), gte(usageDaily.dayTs, since30)));

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isComped: row.isComped,
    autoJoinDomain: row.autoJoinDomain,
    hasDeepgramOverride: !!row.deepgramOverride,
    hasGroqOverride: !!row.groqOverride,
    allowedModels,
    stripeCustomerId: row.stripeCustomerId,
    hasPaymentMethod: !!row.stripePmId,
    autoTopupEnabled: row.autoTopupEnabled,
    feedbackDisabled: row.feedbackDisabled,
    memberCount: Number(memberRow?.n ?? 0),
    balanceMillicents: Number(balanceRow?.b ?? 0),
    lifetimeSpendMillicents: Number(spendRow?.s ?? 0),
    last30dEvents: Number(eventsRow?.n ?? 0),
    createdAt: row.createdAt,
  };
}

/** All active `provider_pricing` rows, used by the admin UI to render the
 *  allowed-models checkbox list. */
export async function listActiveProviderModels(): Promise<
  { providerId: string; model: string; retailPerMinuteMillicents: number }[]
> {
  const db = getDb();
  const { providerPricing } = await import("@/lib/db/schema");
  const rows = await db
    .select()
    .from(providerPricing);
  return rows
    .filter((r) => r.active)
    .map((r) => ({
      providerId: r.providerId,
      model: r.model,
      retailPerMinuteMillicents: r.retailPerMinuteMillicents,
    }))
    .sort((a, b) => {
      if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
      return a.model.localeCompare(b.model);
    });
}

// --- users list ------------------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  orgCount: number;
  createdAt: Date;
  /** Most recent usage_event timestamp; null if the user has never
   *  transcribed. Used as the sort key in the admin users list. */
  lastActiveAt: Date | null;
  /** Counts in the trailing 30 days, surfaced inline so the list shows
   *  who's active without clicking through. */
  last30dEvents: number;
  last30dWords: number;
}

export async function listAllUsers(filter?: string): Promise<AdminUserRow[]> {
  const db = getDb();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const where = filter
    ? or(like(users.email, `%${filter}%`), like(users.displayName, `%${filter}%`))
    : undefined;

  // Pre-aggregate per-user activity from the rollup table, then LEFT
  // JOIN. Replaces 4 correlated subqueries × N users with O(1) joins.
  // `lastActiveMs` here is the most recent rollup *day* a user had
  // activity on, not the literal createdAt of their last event —
  // close enough for the admin sort order, and keeps us off the raw
  // events table.
  const userUsage = db
    .select({
      userId: usageDaily.userId,
      lastActiveMs: sql<number>`MAX(${usageDaily.dayTs})`.as("last_active_ms"),
      events30d: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.events} ELSE 0 END), 0)`.as("events30d"),
      words30d: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.wordCount} ELSE 0 END), 0)`.as("words30d"),
    })
    .from(usageDaily)
    .groupBy(usageDaily.userId)
    .as("user_usage");

  const userOrgCounts = db
    .select({
      userId: orgMembers.userId,
      n: sql<number>`COUNT(*)`.as("org_count"),
    })
    .from(orgMembers)
    .groupBy(orgMembers.userId)
    .as("user_org_counts");

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
      createdAt: users.createdAt,
      orgCount: sql<number>`COALESCE(${userOrgCounts.n}, 0)`,
      lastActiveMs: userUsage.lastActiveMs,
      last30dEvents: sql<number>`COALESCE(${userUsage.events30d}, 0)`,
      last30dWords: sql<number>`COALESCE(${userUsage.words30d}, 0)`,
    })
    .from(users)
    .leftJoin(userUsage, eq(userUsage.userId, users.id))
    .leftJoin(userOrgCounts, eq(userOrgCounts.userId, users.id))
    .where(where)
    // Sort by last active DESC. Users who have never transcribed get
    // NULL → ordered last via COALESCE; ties (multiple never-active
    // users) break by signup date DESC so newest accounts surface
    // first.
    .orderBy(
      sql`COALESCE(${userUsage.lastActiveMs}, 0) DESC`,
      desc(users.createdAt)
    );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isSuperAdmin: r.isSuperAdmin,
    orgCount: Number(r.orgCount),
    createdAt: r.createdAt,
    lastActiveAt:
      r.lastActiveMs != null ? new Date(Number(r.lastActiveMs)) : null,
    last30dEvents: Number(r.last30dEvents),
    last30dWords: Number(r.last30dWords),
  }));
}

// --- user detail (admin view) ---------------------------------------------

export interface AdminUserMembership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
  joinedAt: Date;
}

export interface AdminUserRecentEvent {
  id: string;
  orgId: string;
  orgName: string;
  wordCount: number;
  audioMs: number | null;
  processingMs: number | null;
  costMillicents: number;
  providerId: string;
  model: string;
  polishApplied: boolean;
  createdAt: Date;
}

export interface AdminUserDailyPoint {
  /** YYYY-MM-DD in UTC. */
  day: string;
  words: number;
  events: number;
  costMillicents: number;
}

export interface AdminUserDetail {
  id: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  createdAt: Date;
  lastActiveAt: Date | null;

  memberships: AdminUserMembership[];

  /** Aggregates across the trailing 30 days. */
  last30d: {
    events: number;
    words: number;
    audioMs: number;
    costMillicents: number;
  };

  /** Dense-fill 30-day series — zero rows for inactive days so the chart
   *  doesn't have gaps. */
  daily: AdminUserDailyPoint[];

  /** Most recent dictation events with the org each one came from. */
  recentEvents: AdminUserRecentEvent[];
}

export async function getUserDetail(
  userId: string
): Promise<AdminUserDetail | null> {
  const db = getDb();

  // Base user row.
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // 30-day summary + all-time last-active from the rollup. Day-
  // precision on lastActive (vs the raw event's exact millisecond)
  // is acceptable for the admin view.
  const [summary] = await db
    .select({
      events: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.events} ELSE 0 END), 0)`,
      words: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.wordCount} ELSE 0 END), 0)`,
      audioMs: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.audioMs} ELSE 0 END), 0)`,
      cost: sql<number>`COALESCE(SUM(CASE WHEN ${usageDaily.dayTs} >= ${since30.getTime()} THEN ${usageDaily.costMillicents} ELSE 0 END), 0)`,
      lastActiveMs: sql<number | null>`MAX(${usageDaily.dayTs})`,
    })
    .from(usageDaily)
    .where(eq(usageDaily.userId, userId));

  // Memberships (with org names).
  const memberships = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      role: orgMembers.role,
      joinedAt: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))
    .orderBy(desc(orgMembers.createdAt));

  // Daily series straight from the rollup — already one row per
  // (user, day), so no JS bucketing required. SUM the rollup's
  // per-(org, user, day) rows in case the user is a member of more
  // than one org with activity on the same day (the
  // one-user-one-org invariant means this is N=1 in practice, but
  // the SUM keeps the query correct for any historical multi-
  // membership rows that pre-date the invariant).
  const dailyRollup = await db
    .select({
      dayTs: usageDaily.dayTs,
      words: sql<number>`COALESCE(SUM(${usageDaily.wordCount}), 0)`,
      events: sql<number>`COALESCE(SUM(${usageDaily.events}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageDaily.costMillicents}), 0)`,
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), gte(usageDaily.dayTs, since30)))
    .groupBy(usageDaily.dayTs);

  const byDay = new Map<
    string,
    { words: number; events: number; cost: number }
  >();
  for (const r of dailyRollup) {
    const d = r.dayTs instanceof Date ? r.dayTs : new Date(Number(r.dayTs));
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, {
      words: Number(r.words ?? 0),
      events: Number(r.events ?? 0),
      cost: Number(r.cost ?? 0),
    });
  }
  const daily: AdminUserDailyPoint[] = [];
  const todayUtcMidnight = new Date();
  todayUtcMidnight.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayUtcMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    daily.push({
      day: key,
      words: bucket?.words ?? 0,
      events: bucket?.events ?? 0,
      costMillicents: bucket?.cost ?? 0,
    });
  }

  // Recent events with org names.
  const recentRows = await db
    .select({
      id: usageEvents.id,
      orgId: organizations.id,
      orgName: organizations.name,
      wordCount: usageEvents.wordCount,
      audioMs: usageEvents.audioMs,
      processingMs: usageEvents.processingMs,
      costMillicents: usageEvents.costMillicents,
      providerId: usageEvents.providerId,
      model: usageEvents.model,
      polishApplied: usageEvents.polishApplied,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(organizations, eq(organizations.id, usageEvents.orgId))
    .where(eq(usageEvents.userId, userId))
    .orderBy(desc(usageEvents.createdAt))
    .limit(25);

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isSuperAdmin: row.isSuperAdmin,
    createdAt: row.createdAt,
    lastActiveAt:
      summary?.lastActiveMs != null
        ? new Date(Number(summary.lastActiveMs))
        : null,
    memberships: memberships.map((m) => ({
      orgId: m.orgId,
      orgName: m.orgName,
      orgSlug: m.orgSlug,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    last30d: {
      events: Number(summary?.events ?? 0),
      words: Number(summary?.words ?? 0),
      audioMs: Number(summary?.audioMs ?? 0),
      costMillicents: Number(summary?.cost ?? 0),
    },
    daily,
    recentEvents: recentRows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      orgName: r.orgName,
      wordCount: r.wordCount,
      audioMs: r.audioMs,
      processingMs: r.processingMs,
      costMillicents: r.costMillicents,
      providerId: r.providerId,
      model: r.model,
      polishApplied: r.polishApplied,
      createdAt: r.createdAt,
    })),
  };
}
