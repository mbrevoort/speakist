import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import {
  makeInvitation,
  makeMembership,
  makeOrg,
  makeUser,
} from "@/test/factories";
import { getDb } from "@/lib/db";
import {
  creditLedger,
  invitations,
  orgMembers,
  organizations,
  usageEvents,
} from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";

// Mock the authz module so tests can dictate which user is "signed in"
// without standing up a full Auth.js session. The internal acceptInvitation
// action only uses `requireUser`, so that's all we need to swap out.
const requireUser = vi.fn<() => Promise<AuthedUser>>();
vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
}));

// Importing AFTER vi.mock so the action's dynamic import picks up the mocked
// authz module. This pattern is documented at
// https://vitest.dev/api/vi.html#vi-mock.
const { acceptInvitationInternal } = await import("../actions");

function asAuthedUser(user: { id: string; email: string }): AuthedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: null,
    isSuperAdmin: false,
  };
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("acceptInvitation", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("brand-new user accepts an invitation: membership inserted, invitation cleaned up", async () => {
    const owner = await makeUser({ email: "owner@acme.com" });
    const org = await makeOrg({ slug: "acme" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const u = await makeUser({ email: "alice@example.com" });
    const inv = await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result.ok).toBe(true);
    const db = getDb();
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe(org.id);

    const remaining = await db.select().from(invitations);
    expect(remaining).toHaveLength(0);
  });

  it("rejects an expired invitation", async () => {
    const owner = await makeUser({ email: "owner@acme.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const u = await makeUser({ email: "alice@example.com" });
    const inv = await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result).toEqual({ ok: false, error: "Invitation expired" });

    const db = getDb();
    const memberships = await db.select().from(orgMembers);
    // owner only
    expect(memberships).toHaveLength(1);
  });

  it("rejects when the signed-in user has a different email than the invitation", async () => {
    const owner = await makeUser({ email: "owner@acme.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const intended = await makeUser({ email: "intended@example.com" });
    const inv = await makeInvitation({
      orgId: org.id,
      email: "intended@example.com",
      invitedBy: owner.id,
    });
    void intended;
    const stranger = await makeUser({ email: "stranger@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(stranger));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result).toEqual({
      ok: false,
      error: "Signed in as a different email",
    });
  });

  it("missing token → idempotent ok (no error)", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: "no-such" }));

    expect(result).toEqual({ ok: true });
  });

  it("existing user with co-owners switches: old membership gone, new one in place", async () => {
    // User is owner of orgA along with another owner.
    const u = await makeUser({ email: "alice@example.com" });
    const otherOwner = await makeUser({ email: "co@example.com" });
    const orgA = await makeOrg({ slug: "a" });
    await makeMembership({ orgId: orgA.id, userId: u.id, role: "owner" });
    await makeMembership({
      orgId: orgA.id,
      userId: otherOwner.id,
      role: "owner",
    });

    // Invited to orgB.
    const orgBOwner = await makeUser({ email: "ownerb@example.com" });
    const orgB = await makeOrg({ slug: "b" });
    await makeMembership({
      orgId: orgB.id,
      userId: orgBOwner.id,
      role: "owner",
    });
    const inv = await makeInvitation({
      orgId: orgB.id,
      email: "alice@example.com",
      invitedBy: orgBOwner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result.ok).toBe(true);
    const db = getDb();
    const myMembership = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(myMembership).toHaveLength(1);
    expect(myMembership[0].orgId).toBe(orgB.id);

    // orgA still exists; the co-owner is still there.
    const [orgAStill] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgA.id));
    expect(orgAStill).toBeDefined();
    const orgAMembers = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgA.id));
    expect(orgAMembers).toHaveLength(1);
    expect(orgAMembers[0].userId).toBe(otherOwner.id);
  });

  it("sole-owner without slug confirmation → rejected; nothing mutated", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const orgA = await makeOrg({ slug: "alice-workspace" });
    await makeMembership({ orgId: orgA.id, userId: u.id, role: "owner" });

    const orgBOwner = await makeUser({ email: "ownerb@example.com" });
    const orgB = await makeOrg({ slug: "b" });
    await makeMembership({
      orgId: orgB.id,
      userId: orgBOwner.id,
      role: "owner",
    });
    const inv = await makeInvitation({
      orgId: orgB.id,
      email: "alice@example.com",
      invitedBy: orgBOwner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/sole owner/i);
    expect(result.needsSlugConfirmation).toEqual({ slug: "alice-workspace" });

    const db = getDb();
    const [orgAStill] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgA.id));
    expect(orgAStill).toBeDefined();
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe(orgA.id);
  });

  it("sole-owner with WRONG slug confirmation → rejected", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const orgA = await makeOrg({ slug: "alice-workspace" });
    await makeMembership({ orgId: orgA.id, userId: u.id, role: "owner" });

    const orgBOwner = await makeUser({ email: "ownerb@example.com" });
    const orgB = await makeOrg({ slug: "b" });
    await makeMembership({
      orgId: orgB.id,
      userId: orgBOwner.id,
      role: "owner",
    });
    const inv = await makeInvitation({
      orgId: orgB.id,
      email: "alice@example.com",
      invitedBy: orgBOwner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(
      fd({ token: inv.token, confirm_current_org_slug: "wrong" })
    );

    expect(result.ok).toBe(false);
  });

  it("sole-owner with CORRECT slug confirmation → old org deleted (cascade), new membership inserted", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const orgA = await makeOrg({ slug: "alice-workspace" });
    await makeMembership({ orgId: orgA.id, userId: u.id, role: "owner" });
    // Add some downstream rows that should cascade.
    const db = getDb();
    await db.insert(creditLedger).values({
      orgId: orgA.id,
      deltaMillicents: 60_000,
      reason: "signup_bonus",
    });
    await db.insert(usageEvents).values({
      orgId: orgA.id,
      userId: u.id,
      transcriptionClientId: "client-1",
      providerId: "deepgram",
      wordCount: 10,
      audioMs: 5000,
      model: "nova-3",
    });

    const orgBOwner = await makeUser({ email: "ownerb@example.com" });
    const orgB = await makeOrg({ slug: "b" });
    await makeMembership({
      orgId: orgB.id,
      userId: orgBOwner.id,
      role: "owner",
    });
    const inv = await makeInvitation({
      orgId: orgB.id,
      email: "alice@example.com",
      invitedBy: orgBOwner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(
      fd({ token: inv.token, confirm_current_org_slug: "alice-workspace" })
    );

    expect(result.ok).toBe(true);

    const [stillThere] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgA.id));
    expect(stillThere).toBeUndefined();

    const orgALedger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, orgA.id));
    expect(orgALedger).toHaveLength(0);
    const orgAUsage = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.orgId, orgA.id));
    expect(orgAUsage).toHaveLength(0);

    // New membership in orgB.
    const myMembership = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(myMembership).toHaveLength(1);
    expect(myMembership[0].orgId).toBe(orgB.id);
  });

  it("two pending invitations for the same email + same org → accepting one cleans up both", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const inv1 = await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
    });
    await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
      // Distinct token; same email + org. Forces the cleanup query to
      // remove BOTH rows post-accept.
    });
    const u = await makeUser({ email: "alice@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv1.token }));

    expect(result.ok).toBe(true);
    const db = getDb();
    const remaining = await db.select().from(invitations);
    expect(remaining).toHaveLength(0);
  });

  it("already a member of the invited org → idempotent ok, duplicate invitations cleaned up", async () => {
    const owner = await makeUser({ email: "owner@acme.com" });
    const org = await makeOrg({ slug: "acme" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const u = await makeUser({ email: "alice@example.com" });
    await makeMembership({ orgId: org.id, userId: u.id, role: "member" });
    const inv = await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await acceptInvitationInternal(fd({ token: inv.token }));

    expect(result.ok).toBe(true);
    const db = getDb();
    const remaining = await db
      .select()
      .from(invitations)
      .where(eq(invitations.orgId, org.id));
    expect(remaining).toHaveLength(0);
  });
});
