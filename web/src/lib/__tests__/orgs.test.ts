import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import {
  makeInvitation,
  makeMembership,
  makeOrg,
  makeUser,
  setAllowPublicOrgCreation,
} from "@/test/factories";
import { getDb } from "@/lib/db";
import {
  createOwnWorkspaceForExistingUser,
  getCurrentOrgForUser,
  provisionNewUser,
} from "@/lib/orgs";
import {
  creditLedger,
  invitations,
  orgMembers,
  organizations,
  users,
} from "@/lib/db/schema";

describe("provisionNewUser", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("creates an org and grants the bonus on first sign-in (public signup on)", async () => {
    const u = await makeUser({ email: "alice@example.com", name: "Alice" });

    const result = await provisionNewUser(u.id);

    expect(result.kind).toBe("created-org");
    if (result.kind !== "created-org") return;

    const db = getDb();
    const [member] = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(member.orgId).toBe(result.orgId);
    expect(member.role).toBe("owner");

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.orgId));
    expect(org.name).toMatch(/Alice/);

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, result.orgId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("signup_bonus");
    expect(ledger[0].deltaMillicents).toBeGreaterThan(0);

    const [updated] = await db
      .select({ grantedAt: users.signupBonusGrantedAt })
      .from(users)
      .where(eq(users.id, u.id));
    expect(updated.grantedAt).toBeInstanceOf(Date);
  });

  it("does NOT re-grant the bonus when the same user creates a second org", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const first = await provisionNewUser(u.id);
    expect(first.kind).toBe("created-org");
    if (first.kind !== "created-org") return;

    // Leave their first org so the next call hits the "no membership" path.
    const db = getDb();
    await db.delete(orgMembers).where(eq(orgMembers.userId, u.id));

    const r = await createOwnWorkspaceForExistingUser(u.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, r.orgId));
    expect(ledger).toHaveLength(0);
  });

  it("returns awaiting-invitation when public signup is off and no invite", async () => {
    await setAllowPublicOrgCreation(false);
    const u = await makeUser({ email: "bob@example.com" });

    const result = await provisionNewUser(u.id);

    expect(result.kind).toBe("awaiting-invitation");
    const db = getDb();
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(0);
  });

  it("returns awaiting-acceptance when a pending manual invite exists", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeInvitation({
      orgId: org.id,
      email: "invitee@example.com",
      invitedBy: owner.id,
    });

    const u = await makeUser({ email: "invitee@example.com" });
    const result = await provisionNewUser(u.id);

    expect(result.kind).toBe("awaiting-acceptance");
    const db = getDb();
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(0);
    const ledger = await db.select().from(creditLedger);
    // No bonus granted yet — the user hasn't picked an org.
    expect(ledger).toHaveLength(0);
  });

  it("creates a placeholder invitation when an autoJoinDomain matches", async () => {
    const owner = await makeUser({ email: "owner@acme.com" });
    const org = await makeOrg({ autoJoinDomain: "acme.com" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });

    const u = await makeUser({ email: "alice@acme.com" });
    const result = await provisionNewUser(u.id);

    expect(result.kind).toBe("awaiting-acceptance");

    const db = getDb();
    const [inv] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.email, "alice@acme.com"),
          eq(invitations.orgId, org.id),
          isNull(invitations.acceptedAt)
        )
      );
    expect(inv).toBeDefined();
    expect(inv.role).toBe("member");
    expect(inv.invitedBy).toBe(owner.id);
    expect(inv.token).toMatch(/^[a-f0-9]{48}$/);
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Critically, no auto-membership was inserted.
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(0);
  });

  it("skips when the user already has a membership", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id, role: "owner" });

    const result = await provisionNewUser(u.id);
    expect(result.kind).toBe("skipped");
  });
});

describe("getCurrentOrgForUser", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("returns null when the user has no membership", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    expect(await getCurrentOrgForUser(u.id)).toBeNull();
  });

  it("returns the user's single org", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const org = await makeOrg({ name: "Acme", slug: "acme" });
    await makeMembership({ orgId: org.id, userId: u.id, role: "admin" });

    const result = await getCurrentOrgForUser(u.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(org.id);
    expect(result!.name).toBe("Acme");
    expect(result!.slug).toBe("acme");
    expect(result!.role).toBe("admin");
  });
});

describe("schema invariant: org_members_user_unique", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("rejects a second org_members row for the same user", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const orgA = await makeOrg({ slug: "a" });
    const orgB = await makeOrg({ slug: "b" });
    await makeMembership({ orgId: orgA.id, userId: u.id, role: "owner" });

    await expect(
      makeMembership({ orgId: orgB.id, userId: u.id, role: "member" })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("createOwnWorkspaceForExistingUser", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  it("rejects when the user is already in an org", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id, role: "owner" });

    const r = await createOwnWorkspaceForExistingUser(u.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("already_in_org");
  });

  it("creates an org and grants the bonus on the first lifetime call", async () => {
    const u = await makeUser({ email: "alice@example.com", name: "Alice" });

    const r = await createOwnWorkspaceForExistingUser(u.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const db = getDb();
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, r.orgId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("signup_bonus");
  });
});
