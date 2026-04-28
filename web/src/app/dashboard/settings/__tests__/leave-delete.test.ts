import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import {
  makeMembership,
  makeOrg,
  makeUser,
} from "@/test/factories";
import { getDb } from "@/lib/db";
import {
  creditLedger,
  orgMembers,
  organizations,
} from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";

const requireUser = vi.fn<() => Promise<AuthedUser>>();
vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
}));

// `next/navigation`'s `redirect()` throws an internal NEXT_REDIRECT
// error to bail out of the request. Stub it so tests can assert
// "would-have-redirected" without crashing.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { leaveOrg, deleteOrg } = await import("../actions");

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

async function expectRedirect<T>(
  fn: () => Promise<T>,
  toUrl: string
): Promise<void> {
  await expect(fn()).rejects.toThrow(`NEXT_REDIRECT:${toUrl}`);
}

describe("leaveOrg", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("non-owner leaves successfully (membership deleted)", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeMembership({ orgId: org.id, userId: u.id, role: "member" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    await expectRedirect(leaveOrg, "/");

    const db = getDb();
    const myMembership = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(myMembership).toHaveLength(0);

    // Org persists.
    const [stillThere] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(stillThere).toBeDefined();
  });

  it("sole owner with co-members → blocked", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const member = await makeUser({ email: "member@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeMembership({
      orgId: org.id,
      userId: member.id,
      role: "member",
    });
    requireUser.mockResolvedValue(asAuthedUser(owner));

    const result = await leaveOrg();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only owner/i);
    const db = getDb();
    const stillOwner = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, owner.id));
    expect(stillOwner).toHaveLength(1);
  });

  it("co-owner leaves successfully (org persists)", async () => {
    const ownerA = await makeUser({ email: "ownera@example.com" });
    const ownerB = await makeUser({ email: "ownerb@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: ownerA.id, role: "owner" });
    await makeMembership({ orgId: org.id, userId: ownerB.id, role: "owner" });
    requireUser.mockResolvedValue(asAuthedUser(ownerA));

    await expectRedirect(leaveOrg, "/");

    const db = getDb();
    const remaining = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.orgId, org.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].userId).toBe(ownerB.id);
  });

  it("sole owner alone (no co-members) → still blocked because removing them would orphan the org", async () => {
    const owner = await makeUser({ email: "alone@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    requireUser.mockResolvedValue(asAuthedUser(owner));

    const result = await leaveOrg();
    expect(result.ok).toBe(false);
  });
});

describe("deleteOrg", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("owner with correct slug → org + memberships + ledger cascade-deleted", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const member = await makeUser({ email: "member@example.com" });
    const org = await makeOrg({ slug: "acme" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeMembership({
      orgId: org.id,
      userId: member.id,
      role: "member",
    });
    const db = getDb();
    await db.insert(creditLedger).values({
      orgId: org.id,
      deltaMillicents: 1000,
      reason: "signup_bonus",
    });
    requireUser.mockResolvedValue(asAuthedUser(owner));

    await expectRedirect(() => deleteOrg(fd({ confirm: "acme" })), "/");

    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(orgs).toHaveLength(0);
    const members = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.orgId, org.id));
    expect(members).toHaveLength(0);
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.orgId, org.id));
    expect(ledger).toHaveLength(0);
  });

  it("owner with WRONG slug → blocked, nothing mutated", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg({ slug: "acme" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    requireUser.mockResolvedValue(asAuthedUser(owner));

    const result = await deleteOrg(fd({ confirm: "wrong" }));

    expect(result.ok).toBe(false);
    const db = getDb();
    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(orgs).toHaveLength(1);
  });

  it("non-owner → blocked", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const member = await makeUser({ email: "member@example.com" });
    const org = await makeOrg({ slug: "acme" });
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeMembership({
      orgId: org.id,
      userId: member.id,
      role: "member",
    });
    requireUser.mockResolvedValue(asAuthedUser(member));

    const result = await deleteOrg(fd({ confirm: "acme" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/owners only/i);
  });
});
