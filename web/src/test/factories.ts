// Test factories. Small builder fns that insert a row with sensible
// defaults and return it. Each takes a partial overrides object so a
// test can pin only the fields it cares about.
//
// All factories operate against the global test DB installed by
// `setupTestDb()` — they don't take a `db` argument because making
// every call site pass it around adds noise without buying isolation
// (each test file already gets a fresh DB).

import { eq } from "drizzle-orm";
import {
  appSettings,
  invitations,
  organizations,
  orgMembers,
  users,
  type Invitation,
  type OrgRole,
  type Organization,
  type User,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `seq-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UserOverrides {
  id?: string;
  email?: string;
  name?: string | null;
  displayName?: string | null;
  isSuperAdmin?: boolean;
  signupBonusGrantedAt?: Date | null;
}

export async function makeUser(overrides: UserOverrides = {}): Promise<User> {
  const id = overrides.id ?? nextId();
  const db = getDb();
  await db.insert(users).values({
    id,
    email: overrides.email ?? `user-${id}@example.com`,
    name: overrides.name ?? null,
    displayName: overrides.displayName ?? null,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    signupBonusGrantedAt: overrides.signupBonusGrantedAt ?? null,
  });
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export interface OrgOverrides {
  id?: string;
  name?: string;
  slug?: string;
  autoJoinDomain?: string | null;
  isComped?: boolean;
}

export async function makeOrg(overrides: OrgOverrides = {}): Promise<Organization> {
  const id = overrides.id ?? nextId();
  const db = getDb();
  const slug = overrides.slug ?? `org-${id}`;
  await db.insert(organizations).values({
    id,
    name: overrides.name ?? `Org ${id}`,
    slug,
    autoJoinDomain: overrides.autoJoinDomain ?? null,
    isComped: overrides.isComped ?? false,
  });
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return row;
}

export interface MembershipOverrides {
  orgId: string;
  userId: string;
  role?: OrgRole;
}

export async function makeMembership(opts: MembershipOverrides): Promise<void> {
  const db = getDb();
  await db.insert(orgMembers).values({
    orgId: opts.orgId,
    userId: opts.userId,
    role: opts.role ?? "member",
  });
}

export interface InvitationOverrides {
  orgId: string;
  email: string;
  invitedBy: string;
  role?: OrgRole;
  token?: string;
  /** Defaults to 14 days in the future. */
  expiresAt?: Date;
  acceptedAt?: Date | null;
}

export async function makeInvitation(
  opts: InvitationOverrides
): Promise<Invitation> {
  const id = nextId();
  const token = opts.token ?? `tok-${id}-${Math.random().toString(36).slice(2)}`;
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const db = getDb();
  await db.insert(invitations).values({
    id,
    orgId: opts.orgId,
    email: opts.email.toLowerCase(),
    role: opts.role ?? "member",
    token,
    invitedBy: opts.invitedBy,
    expiresAt,
    acceptedAt: opts.acceptedAt ?? null,
  });
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);
  return row;
}

/**
 * Flip the `allow_public_org_creation` toggle on the singleton row.
 * Useful for testing the invite-only branches of `provisionNewUser`.
 */
export async function setAllowPublicOrgCreation(allow: boolean): Promise<void> {
  const db = getDb();
  await db
    .update(appSettings)
    .set({ allowPublicOrgCreation: allow })
    .where(eq(appSettings.id, 1));
}
