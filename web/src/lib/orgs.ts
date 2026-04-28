// Organization primitives. Shared by the Auth.js createUser hook, every
// /dashboard route, and the /invite accept flow. Everything that needs to
// "find this user's org" or "spin up an org for this brand-new user" goes
// through here so the behavior is consistent.
//
// Invariant: a user belongs to at most one org at any time. Enforced at
// the schema layer via UNIQUE INDEX org_members_user_unique. The helpers
// in this file assume that invariant — no fallback "pick the earliest of
// many" logic remains.
//
// The helpers assume a caller already has an authenticated user context —
// they don't do authz. Route handlers are expected to wrap them with the
// `require*` helpers from src/lib/authz.ts.

import { and, eq, isNull, sum } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  appSettings,
  invitations,
  organizations,
  orgMembers,
  pricingConfig,
  users,
  type OrgRole,
} from "@/lib/db/schema";
import { appendLedger } from "@/lib/credits";

// --- slug generation -------------------------------------------------------

/** Turn an arbitrary string into a URL-safe slug. */
function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      // Strip combining marks (diacritics) — U+0300..U+036F.
      .replace(/[̀-ͯ]/g, "")
      // Non-alphanumerics → hyphen.
      .replace(/[^a-z0-9]+/g, "-")
      // Trim leading/trailing hyphens.
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
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

// --- token helper ----------------------------------------------------------
//
// Same shape the dashboard inviteMember action uses (24 random bytes →
// 48 hex chars). Lives here so the auto-join domain code path doesn't
// have to import from a server-action file.

function randomHexToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- new-user provisioning -------------------------------------------------

/**
 * Result of attempting to set up a newly-created user.
 *
 * `awaiting-acceptance` is the new compound state used both for "user has
 * pending invitations to existing orgs" and "no invitations but their email
 * domain auto-generates one." The dashboard's no-org panel renders the same
 * UI for both cases (a list of invitation cards plus a fallback "create
 * your own workspace" CTA), so the caller doesn't need finer granularity.
 */
export type ProvisionResult =
  | { kind: "awaiting-acceptance" }
  | { kind: "created-org"; orgId: string }
  | { kind: "awaiting-invitation" }
  | { kind: "skipped"; reason: string };

/**
 * Provision a freshly-created user. Intended to be called exactly once from
 * Auth.js's `events.createUser`.
 *
 * Decision tree (in priority order):
 *   1. User already has a membership row → skip (defensive; createUser
 *      shouldn't fire twice, but if it does we don't double-provision).
 *   2. Pending invitation(s) exist for this user's email → return
 *      `awaiting-acceptance`. The dashboard's no-org panel surfaces them.
 *   3. No invitation, but some org's `auto_join_domain` matches the user's
 *      email domain → insert a placeholder invitation for that org and
 *      return `awaiting-acceptance`. Same UX as (2). The user always
 *      gets to consent before joining.
 *   4. `allow_public_org_creation = true` → create org + grant signup
 *      bonus (only on first lifetime org per user — `users.signup_bonus_
 *      granted_at` gates it).
 *   5. Otherwise → `awaiting-invitation` (today's "invite-only environment"
 *      behavior).
 */
export async function provisionNewUser(userId: string): Promise<ProvisionResult> {
  const db = getDb();

  // 1. Already provisioned?
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

  // 2. Pending manual invitation(s) for this email?
  const pending = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, user.email.toLowerCase()),
        isNull(invitations.acceptedAt)
      )
    )
    .limit(1);
  if (pending.length > 0) {
    return { kind: "awaiting-acceptance" };
  }

  // 3. Auto-join domain match? Generate a placeholder invitation rather
  // than silently inserting org_members. Same Accept/Decline UX as a
  // manual invite — the user always opts in explicitly.
  const domain = domainFromEmail(user.email);
  if (domain) {
    const [autoJoinOrg] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.autoJoinDomain, domain))
      .limit(1);
    if (autoJoinOrg) {
      await createPlaceholderInvitation({
        orgId: autoJoinOrg.id,
        email: user.email.toLowerCase(),
      });
      return { kind: "awaiting-acceptance" };
    }
  }

  // 4. Public signup gate.
  const [settings] = await db
    .select({ allow: appSettings.allowPublicOrgCreation })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  if (settings && !settings.allow) {
    return { kind: "awaiting-invitation" };
  }

  // 5. Create their own workspace.
  const orgId = await createOrgAndGrantBonusIfFirstTime(user.id, {
    displayName: user.displayName,
    name: user.name,
    email: user.email,
  });
  return { kind: "created-org", orgId };
}

// --- shared "create org" path ---------------------------------------------

/**
 * Create a fresh org owned by `userId` and grant the signup bonus IFF
 * the user has never been granted one before. Used by both
 * `provisionNewUser` (first sign-in) and `createOwnWorkspaceForExistingUser`
 * (post-leave dashboard CTA).
 *
 * The bonus is gated on `users.signup_bonus_granted_at`; once stamped,
 * future calls produce an org without granting more credit. This is what
 * keeps the leave-and-recreate loop honest.
 */
async function createOrgAndGrantBonusIfFirstTime(
  userId: string,
  who: { displayName: string | null; name: string | null; email: string }
): Promise<string> {
  const db = getDb();
  const baseName =
    who.displayName?.trim() || who.name?.trim() || who.email.split("@")[0];
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

  // Read user's bonus state. Only stamp + credit on first lifetime org.
  const [u] = await db
    .select({ grantedAt: users.signupBonusGrantedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.grantedAt) {
    const [cfg] = await db
      .select({ amount: pricingConfig.signupBonusMillicents })
      .from(pricingConfig)
      .where(eq(pricingConfig.id, 1))
      .limit(1);
    const bonusAmount = cfg?.amount ?? 60_000;
    if (bonusAmount > 0) {
      await appendLedger({
        orgId,
        deltaMillicents: bonusAmount,
        reason: "signup_bonus",
        note: "Automatic signup bonus",
      });
    }
    await db
      .update(users)
      .set({ signupBonusGrantedAt: new Date() })
      .where(eq(users.id, userId));
  }

  return orgId;
}

/**
 * Create a placeholder invitation for an auto-join domain match. The
 * "invitedBy" attribution goes to the org's earliest-joined owner — the
 * invitations table requires a non-null inviter, and this gives the
 * recipient a recognizable name when they look at the invite (whoever
 * configured the auto-join domain in the first place is almost always
 * an owner of the org).
 *
 * Idempotent: if a pending invitation already exists for (org, email)
 * we leave it in place rather than spawning a second token.
 */
async function createPlaceholderInvitation(opts: {
  orgId: string;
  email: string;
}): Promise<void> {
  const db = getDb();

  const [existing] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, opts.orgId),
        eq(invitations.email, opts.email),
        isNull(invitations.acceptedAt)
      )
    )
    .limit(1);
  if (existing) return;

  const [owner] = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, opts.orgId), eq(orgMembers.role, "owner")))
    .orderBy(orgMembers.createdAt)
    .limit(1);

  if (!owner) {
    // Defensive: every org should have at least one owner; if not,
    // skip rather than crash. The user lands on the no-org panel
    // with a "create your own workspace" CTA.
    console.warn(
      `[orgs] auto-join org ${opts.orgId} has no owner; skipping placeholder invitation for ${opts.email}`
    );
    return;
  }

  await db.insert(invitations).values({
    orgId: opts.orgId,
    email: opts.email,
    role: "member",
    token: randomHexToken(),
    invitedBy: owner.userId,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
}

/**
 * Dashboard "create your own workspace" CTA. Called when the user has
 * no current org (declined invites, just left an org, etc.) and wants
 * a fresh workspace. Same shape as `provisionNewUser` case 4 — including
 * the once-per-user signup bonus gate.
 *
 * Returns the new orgId on success, or a structured error if the user
 * already has a membership (defense-in-depth — the UI shouldn't show
 * the CTA in that state, but server-side double-check guards against
 * a stale tab race).
 */
export type CreateOwnWorkspaceResult =
  | { ok: true; orgId: string }
  | { ok: false; error: "already_in_org" | "user_not_found" };

export async function createOwnWorkspaceForExistingUser(
  userId: string
): Promise<CreateOwnWorkspaceResult> {
  const db = getDb();

  const [member] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  if (member) return { ok: false, error: "already_in_org" };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, error: "user_not_found" };

  const orgId = await createOrgAndGrantBonusIfFirstTime(userId, {
    displayName: user.displayName,
    name: user.name,
    email: user.email,
  });
  return { ok: true, orgId };
}

// --- active-org resolution -------------------------------------------------

/**
 * The org the user belongs to, or null if they don't have one yet.
 * One-org-per-user invariant means this is a single join with no
 * preference logic.
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
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: orgMembers.role,
      isComped: organizations.isComped,
      autoJoinDomain: organizations.autoJoinDomain,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return row ?? null;
}

// --- credit balance --------------------------------------------------------

/**
 * Current credit balance for an org in millicents. Reads the
 * materialized `organizations.balance_millicents` column maintained
 * by `appendLedger` in lib/credits.ts — every ledger write bumps
 * this number atomically with the same delta. Cheap O(1) lookup
 * regardless of how long the org's ledger has grown. For comped
 * orgs the balance is informational only (they don't debit).
 */
export async function getOrgCreditBalance(orgId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ balance: organizations.balanceMillicents })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
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

/**
 * Pending invitations addressed to a given email. Used by the dashboard's
 * no-org panel to render the user's "you've been invited to …" cards.
 *
 * Returns enough context for the UI: the org's name + slug (for display
 * + the sole-owner-confirmation flow downstream), the invitation token
 * (so the Accept button can submit it to the existing acceptInvitation
 * action), and the role they were invited as.
 */
export interface PendingInvitationForUser {
  invitationId: string;
  token: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
  invitedByEmail: string;
  expiresAt: Date;
}

export async function listPendingInvitationsForEmail(
  email: string
): Promise<PendingInvitationForUser[]> {
  const db = getDb();
  const rows = await db
    .select({
      invitationId: invitations.id,
      token: invitations.token,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      role: invitations.role,
      invitedByEmail: users.email,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .innerJoin(users, eq(users.id, invitations.invitedBy))
    .where(
      and(
        eq(invitations.email, email.toLowerCase()),
        isNull(invitations.acceptedAt)
      )
    )
    .orderBy(invitations.createdAt);
  return rows;
}

// Suppress unused-import lint; `sum` is reserved for a later
// "total spend" helper that will land with the usage dashboard in Phase 4.
export const __unused = { sum };
