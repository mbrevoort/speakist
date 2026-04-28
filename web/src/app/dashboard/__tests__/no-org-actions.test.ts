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
  users,
} from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";

const requireUser = vi.fn<() => Promise<AuthedUser>>();
vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { createOwnWorkspaceFromNoOrg, declineInvitationFromNoOrg } = await import(
  "../no-org-actions"
);

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

describe("createOwnWorkspaceFromNoOrg", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("creates an org + grants the bonus on the first lifetime call", async () => {
    const u = await makeUser({ email: "alice@example.com", name: "Alice" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await createOwnWorkspaceFromNoOrg();

    expect(result.ok).toBe(true);

    const db = getDb();
    const memberships = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe("owner");

    const ledger = await db.select().from(creditLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("signup_bonus");
  });

  it("creates an org WITHOUT the bonus when signup_bonus_granted_at is already set", async () => {
    const u = await makeUser({
      email: "alice@example.com",
      signupBonusGrantedAt: new Date(),
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await createOwnWorkspaceFromNoOrg();

    expect(result.ok).toBe(true);
    const db = getDb();
    const ledger = await db.select().from(creditLedger);
    expect(ledger).toHaveLength(0);
  });

  it("rejects when the user already has a membership", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id, role: "owner" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await createOwnWorkspaceFromNoOrg();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already belong/i);
  });
});

describe("declineInvitationFromNoOrg", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("deletes the invitation row when addressed to current user", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const u = await makeUser({ email: "alice@example.com" });
    const inv = await makeInvitation({
      orgId: org.id,
      email: "alice@example.com",
      invitedBy: owner.id,
    });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await declineInvitationFromNoOrg(
      fd({ invitation_id: inv.id })
    );

    expect(result.ok).toBe(true);
    const db = getDb();
    const remaining = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, inv.id));
    expect(remaining).toHaveLength(0);
  });

  it("rejects when invitation is not addressed to current user", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    const intended = await makeUser({ email: "intended@example.com" });
    void intended;
    const inv = await makeInvitation({
      orgId: org.id,
      email: "intended@example.com",
      invitedBy: owner.id,
    });
    const stranger = await makeUser({ email: "stranger@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(stranger));

    const result = await declineInvitationFromNoOrg(
      fd({ invitation_id: inv.id })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/isn't addressed to you/i);

    const db = getDb();
    const stillThere = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, inv.id));
    expect(stillThere).toHaveLength(1);
  });

  it("idempotent ok when the invitation has already been removed", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    const result = await declineInvitationFromNoOrg(
      fd({ invitation_id: "no-such" })
    );

    expect(result.ok).toBe(true);
  });
});

// Belt-and-suspenders: confirm that creating the workspace populates
// `users.signup_bonus_granted_at` so a subsequent attempt no-ops the bonus.
describe("signup bonus invariant across leave-and-recreate", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    requireUser.mockReset();
  });
  afterEach(() => {
    h.close();
  });

  it("first create grants bonus, leave, second create does not", async () => {
    const u = await makeUser({ email: "alice@example.com" });
    requireUser.mockResolvedValue(asAuthedUser(u));

    // First create.
    const r1 = await createOwnWorkspaceFromNoOrg();
    expect(r1.ok).toBe(true);

    const db = getDb();

    // Verify timestamp set.
    const [u1] = await db
      .select({ grantedAt: users.signupBonusGrantedAt })
      .from(users)
      .where(eq(users.id, u.id));
    expect(u1.grantedAt).toBeInstanceOf(Date);

    // Leave (manually clear membership).
    await db.delete(orgMembers).where(eq(orgMembers.userId, u.id));

    // Second create.
    const r2 = await createOwnWorkspaceFromNoOrg();
    expect(r2.ok).toBe(true);

    const ledger = await db.select().from(creditLedger);
    // Only the bonus from the FIRST org persists; the second got no bonus.
    expect(ledger.filter((l) => l.reason === "signup_bonus")).toHaveLength(1);
  });
});
