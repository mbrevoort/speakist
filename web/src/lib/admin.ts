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
} from "@/lib/db/schema";

// --- platform rollups ------------------------------------------------------

export interface PlatformTotals {
  orgs: number;
  users: number;
  usage30dWords: number;
  usage30dEvents: number;
  usage30dCostMillicents: number;
  usage30dDeepgramCostMillicents: number;
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
      cost: sql<number>`COALESCE(SUM(${usageEvents.costMillicents}), 0)`,
      dgCost: sql<number>`COALESCE(SUM(${usageEvents.deepgramCostMillicents}), 0)`,
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
    usage30dCostMillicents: Number(usage30?.cost ?? 0),
    usage30dDeepgramCostMillicents: Number(usage30?.dgCost ?? 0),
    balanceAllOrgsMillicents: Number(balance?.total ?? 0),
    topupsAllTimeMillicents: Number(topups?.total ?? 0),
  };
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
      createdAt: organizations.createdAt,
      stripeCustomerId: organizations.stripeCustomerId,
      stripePmId: organizations.stripeDefaultPaymentMethodId,
      autoTopupEnabled: organizations.autoTopupEnabled,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!row) return null;

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

// --- users list ------------------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  orgCount: number;
  createdAt: Date;
  lastSignIn: Date | null;  // approx — we use emailVerified as proxy pending sessions query
}

export async function listAllUsers(filter?: string): Promise<AdminUserRow[]> {
  const db = getDb();
  const where = filter
    ? or(like(users.email, `%${filter}%`), like(users.displayName, `%${filter}%`))
    : undefined;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
      createdAt: users.createdAt,
      emailVerified: users.emailVerified,
      orgCount: sql<number>`(
        SELECT COUNT(*) FROM org_members WHERE org_members.user_id = users.id
      )`,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt));

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isSuperAdmin: r.isSuperAdmin,
    orgCount: Number(r.orgCount),
    createdAt: r.createdAt,
    lastSignIn: r.emailVerified,
  }));
}
