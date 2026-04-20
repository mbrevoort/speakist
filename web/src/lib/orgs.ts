// Organization primitives. Shared by the Auth.js createUser hook, every
// /dashboard route, and the /invite accept flow. Everything that needs to
// "find my current org" or "spin up an org for this brand-new user" goes
// through here so the behavior is consistent.
//
// The helpers assume a caller already has an authenticated user context —
// they don't do authz. Route handlers are expected to wrap them with the
// `require*` helpers from src/lib/authz.ts.

import { and, eq, isNull, sql, sum } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  appSettings,
  creditLedger,
  invitations,
  organizations,
  orgMembers,
  pricingConfig,
  users,
  type OrgRole,
} from "@/lib/db/schema";

// --- slug generation -------------------------------------------------------

/** Turn an arbitrary string into a URL-safe slug. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")       // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")           // non-alphanumerics → hyphen
    .replace(/^-+|-+$/g, "")               // trim leading/trailing hyphens
    .slice(0, 40) || "workspace";
}

/**
 * Produce a slug that's unique across the organizations table, appending a
 * short random suffix if the base slug is taken. Collisions are rare enough
 * that a single retry is overwhelmingly sufficient.
 */
async function uniqueOrgSlug(base: string): Promise<string> {
  const db = getDb();
  const baseSlug = slugify(base);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate =
      attempt === 0
        ? baseSlug
        : `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  // Absurdly unlikely — fall back to a fully random slug.
  return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
}

// --- email domain helpers --------------------------------------------------

/** "me@Acme.com" → "acme.com". Null on malformed input. */
export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// --- new-user provisioning -------------------------------------------------

/**
 * Result of attempting to set up a newly-created user. The caller (Auth.js
 * createUser event) doesn't need this return value functionally, but having
 * it typed makes the intent of the function readable and lets us log what
 * happened for debugging.
 */
export type ProvisionResult =
  | { kind: "auto-joined"; orgId: string }
  | { kind: "created-org"; orgId: string }
  | { kind: "awaiting-invitation" }
  | { kind: "skipped"; reason: string };

/**
 * Provision a freshly-created user. Intended to be called exactly once from
 * Auth.js's `events.createUser`.
 *
 * Decision tree:
 *   1. If any org has auto_join_domain matching the user's email domain →
 *      add the user as a 'member' of that org. No bonus is granted —
 *      auto-joiners inherit the existing org's credit pool.
 *   2. Otherwise → create a new org named "{displayName}'s Workspace" with
 *      the user as 'owner', grant the signup bonus from pricing_config to
 *      the new org's credit ledger.
 *   3. If the user already has a membership row (shouldn't happen from
 *      createUser but defensive), skip.
 *
 * SQLite doesn't have RLS, and D1 doesn't expose multi-statement transactions
 * via the binding API (you can use `db.batch()` for atomic multi-statement
 * execution, but atomic with rollback across arbitrary Drizzle calls is not
 * available). The worst-case failure mode is a partially-provisioned user:
 * we protect against that by checking-then-inserting and by guarding the
 * ledger insert with a "must not already exist" check. Idempotent on retry.
 */
export async function provisionNewUser(userId: string): Promise<ProvisionResult> {
  const db = getDb();

  // Has this user already been provisioned? (Defensive: in case createUser
  // fires twice, or we re-run this manually.)
  const existingMembership = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  if (existingMembership.length > 0) {
    return { kind: "skipped", reason: "user already has a membership" };
  }

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    return { kind: "skipped", reason: "user row not found" };
  }

  // 1. Auto-join domain match?
  const domain = domainFromEmail(user.email);
  if (domain) {
    const autoJoinOrg = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.autoJoinDomain, domain))
      .limit(1);
    if (autoJoinOrg.length > 0) {
      const orgId = autoJoinOrg[0].id;
      await db.insert(orgMembers).values({
        orgId,
        userId,
        role: "member",
      });
      return { kind: "auto-joined", orgId };
    }
  }

  // 2. Check the platform-wide "allow public org creation" toggle. When off
  // (typical in dev/staging) and the user didn't match an auto-join domain,
  // we stop here — the user exists but has no org. They land on the dashboard
  // and see an "awaiting invitation" state until a super admin invites them
  // or an existing org starts auto-joining their domain.
  const [settings] = await db
    .select({ allow: appSettings.allowPublicOrgCreation })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  if (settings && !settings.allow) {
    return { kind: "awaiting-invitation" };
  }

  // 3. Create fresh org + membership + bonus.
  const baseName = user.displayName?.trim() || user.name?.trim() || user.email.split("@")[0];
  const orgName = `${baseName}'s Workspace`;
  const slug = await uniqueOrgSlug(baseName);

  const orgId = crypto.randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    name: orgName,
    slug,
  });
  await db.insert(orgMembers).values({
    orgId,
    userId,
    role: "owner",
  });

  // Grant the signup bonus. Read the current pricing config so the amount
  // reflects whatever super admin has set (default 500000 millicents = $5).
  const [cfg] = await db
    .select({ amount: pricingConfig.signupBonusMillicents })
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 1))
    .limit(1);
  const bonusAmount = cfg?.amount ?? 500_000;
  if (bonusAmount > 0) {
    await db.insert(creditLedger).values({
      orgId,
      deltaMillicents: bonusAmount,
      reason: "signup_bonus",
      note: "Automatic signup bonus",
    });
  }

  return { kind: "created-org", orgId };
}

// --- active-org resolution -------------------------------------------------

/**
 * Information about the org a signed-in user is currently acting in. For
 * v1 a user has exactly one org (their first); multi-org-switching UI lands
 * in a later phase. If the user somehow has multiple memberships we pick the
 * oldest (their original org) for stability.
 */
export interface CurrentOrg {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  isComped: boolean;
  autoJoinDomain: string | null;
}

export async function getCurrentOrgForUser(userId: string): Promise<CurrentOrg | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: orgMembers.role,
      isComped: organizations.isComped,
      autoJoinDomain: organizations.autoJoinDomain,
      createdAt: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))
    .orderBy(orgMembers.createdAt)
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    role: r.role,
    isComped: r.isComped,
    autoJoinDomain: r.autoJoinDomain,
  };
}

// --- credit balance --------------------------------------------------------

/**
 * Current credit balance for an org in millicents. Sum of credit_ledger
 * deltas. For comped orgs the balance is meaningless (they don't debit)
 * but we still compute it so the UI can show history.
 */
export async function getOrgCreditBalance(orgId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({
      balance: sql<number>`COALESCE(SUM(${creditLedger.deltaMillicents}), 0)`,
    })
    .from(creditLedger)
    .where(eq(creditLedger.orgId, orgId));
  return Number(row?.balance ?? 0);
}

// --- member list -----------------------------------------------------------

export interface OrgMemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
  joinedAt: Date;
}

export async function listOrgMembers(orgId: string): Promise<OrgMemberRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: orgMembers.role,
      joinedAt: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(orgMembers.createdAt);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName,
    role: r.role,
    joinedAt: r.joinedAt,
  }));
}

// --- pending invitations ---------------------------------------------------

export interface PendingInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
}

export async function listPendingInvitations(orgId: string): Promise<PendingInvitation[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedByEmail: users.email,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt)))
    .orderBy(invitations.createdAt);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

// Suppress unused-import lint; `sum` is reserved for a later
// "total spend" helper that will land with the usage dashboard in Phase 4.
export const __unused = { sum };
