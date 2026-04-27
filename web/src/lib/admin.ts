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

  const [usage30] = await db
    .select({
      events: sql<number>`COUNT(*)`,
      words: sql<number>`COALESCE(SUM(${usageEvents.wordCount}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since30));

  // Total balance across all orgs. Not "platform revenue" — this is
  // outstanding credit we still owe.
  const [balance] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger);

  // Sum of all top-up reasons (manual + auto) = gross revenue, pre-refund.
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

// --- platform-wide daily activity ------------------------------------------

export interface PlatformDayPoint {
  /** YYYY-MM-DD in UTC. */
  day: string;
  words: number;
  /** Distinct users with at least one usage_event on this day. */
  activeUsers: number;
}

/**
 * Per-day platform activity for the last N days (including today). Buckets
 * usage_events by UTC date in JavaScript rather than via SQL strftime —
 * matches the pattern in `getUsageByDay` for the same reason (D1 + Drizzle
 * timestamp_ms quirks).
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

  const events = await db
    .select({
      createdAt: usageEvents.createdAt,
      userId: usageEvents.userId,
      wordCount: usageEvents.wordCount,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since));

  const byDay = new Map<string, { words: number; userIds: Set<string> }>();
  for (const e of events) {
    const d = e.createdAt instanceof Date ? e.createdAt : new Date(Number(e.createdAt));
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? { words: 0, userIds: new Set<string>() };
    bucket.words += Number(e.wordCount ?? 0);
    bucket.userIds.add(e.userId);
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

  // Drizzle-land: do the joins/subqueries as scalar correlated SELECTs so
  // the result is one row per org. SQLite handles this fine with our data
  // volumes; if the org count ever gets large we'd switch to CTEs.
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      isComped: organizations.isComped,
      autoJoinDomain: organizations.autoJoinDomain,
      deepgramOverride: organizations.deepgramKeyOverrideEncrypted,
      createdAt: organizations.createdAt,
      memberCount: sql<number>`(
        SELECT COUNT(*) FROM org_members WHERE org_members.org_id = organizations.id
      )`,
      balance: sql<number>`(
        SELECT COALESCE(SUM(delta_millicents), 0) FROM credit_ledger
        WHERE credit_ledger.org_id = organizations.id
      )`,
      lifetimeSpend: sql<number>`(
        SELECT COALESCE(-SUM(delta_millicents), 0) FROM credit_ledger
        WHERE credit_ledger.org_id = organizations.id
          AND credit_ledger.reason = 'usage'
      )`,
      last30dEvents: sql<number>`(
        SELECT COUNT(*) FROM usage_events
        WHERE usage_events.org_id = organizations.id
          AND usage_events.created_at >= ${since30.getTime()}
      )`,
    })
    .from(organizations)
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
    last30dEvents: Number(r.last30dEvents),
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
  const [balanceRow] = await db
    .select({
      b: sql<number>`COALESCE(SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger)
    .where(eq(creditLedger.orgId, orgId));
  const [spendRow] = await db
    .select({
      s: sql<number>`COALESCE(-SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.orgId, orgId), eq(creditLedger.reason, "usage")));
  const [eventsRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, since30)));

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
  const since30Ms = since30.getTime();
  const where = filter
    ? or(like(users.email, `%${filter}%`), like(users.displayName, `%${filter}%`))
    : undefined;

  // Correlated subqueries for the per-user usage rollups. Cheap on SQLite
  // for a few hundred users; if this gets slow we'd switch to a single
  // GROUP BY join.
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
      createdAt: users.createdAt,
      orgCount: sql<number>`(
        SELECT COUNT(*) FROM org_members WHERE org_members.user_id = users.id
      )`,
      lastActiveMs: sql<number | null>`(
        SELECT MAX(created_at) FROM usage_events
        WHERE usage_events.user_id = users.id
      )`,
      last30dEvents: sql<number>`(
        SELECT COUNT(*) FROM usage_events
        WHERE usage_events.user_id = users.id
          AND usage_events.created_at >= ${since30Ms}
      )`,
      last30dWords: sql<number>`(
        SELECT COALESCE(SUM(word_count), 0) FROM usage_events
        WHERE usage_events.user_id = users.id
          AND usage_events.created_at >= ${since30Ms}
      )`,
    })
    .from(users)
    .where(where)
    // Sort by last active DESC, with users that have never transcribed
    // sorting last (COALESCE → 0). Ties (e.g. multiple never-active users)
    // break by signup date DESC so newest accounts surface first.
    .orderBy(
      sql`COALESCE((SELECT MAX(created_at) FROM usage_events WHERE usage_events.user_id = users.id), 0) DESC`,
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

  // 30-day summary in one query, plus all-time last-active.
  const [summary] = await db
    .select({
      events: sql<number>`COUNT(*)`,
      words: sql<number>`COALESCE(SUM(${usageEvents.wordCount}), 0)`,
      audioMs: sql<number>`COALESCE(SUM(${usageEvents.audioMs}), 0)`,
      cost: sql<number>`COALESCE(SUM(${usageEvents.costMillicents}), 0)`,
      lastActiveMs: sql<number | null>`MAX(${usageEvents.createdAt})`,
    })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId));

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

  // Daily series — JS-side bucketing for D1/timestamp_ms-friendliness.
  const dailyEvents = await db
    .select({
      createdAt: usageEvents.createdAt,
      wordCount: usageEvents.wordCount,
      costMillicents: usageEvents.costMillicents,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.createdAt, since30)
      )
    );

  const byDay = new Map<
    string,
    { words: number; events: number; cost: number }
  >();
  for (const e of dailyEvents) {
    const d = e.createdAt instanceof Date ? e.createdAt : new Date(Number(e.createdAt));
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? { words: 0, events: 0, cost: 0 };
    bucket.words += Number(e.wordCount ?? 0);
    bucket.events += 1;
    bucket.cost += Number(e.costMillicents ?? 0);
    byDay.set(key, bucket);
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
