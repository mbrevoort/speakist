import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import {
  makeMembership,
  makeOrg,
  makeUser,
} from "@/test/factories";
import { getDb } from "@/lib/db";
import { invitations } from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";
import type { OrgRole } from "@/lib/db/schema";

// State shared across the mocked requireOrgAdmin / getCurrentOrgForUser
// calls. Tests set `currentOrg` and `signedInUser` before invoking the
// action; the mock implementations read them.
const state: {
  user: AuthedUser | null;
  orgId: string | null;
} = { user: null, orgId: null };

vi.mock("@/lib/authz", () => ({
  requireUser: () => Promise.resolve(state.user),
  requireOrgAdmin: () =>
    Promise.resolve({
      user: state.user,
      role: "owner" as OrgRole,
    }),
}));

vi.mock("@/lib/orgs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/orgs")>("@/lib/orgs");
  return {
    ...actual,
    getCurrentOrgForUser: () =>
      Promise.resolve(
        state.orgId
          ? {
              id: state.orgId,
              name: "Test",
              slug: "test",
              role: "owner" as OrgRole,
              isComped: false,
              autoJoinDomain: null,
            }
          : null
      ),
  };
});

const sendInvitationEmail = vi.fn<() => Promise<void>>();
vi.mock("@/lib/email/invitation", () => ({
  sendInvitationEmail: () => sendInvitationEmail(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { inviteMember } = await import("../actions");

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

describe("inviteMember", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
    sendInvitationEmail.mockReset();
    sendInvitationEmail.mockResolvedValue(undefined);
  });
  afterEach(() => {
    h.close();
  });

  it("brand-new email → invitation row inserted, email sent", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    state.user = asAuthedUser(owner);
    state.orgId = org.id;

    const result = await inviteMember(
      fd({ email: "alice@example.com", role: "member" })
    );

    expect(result.ok).toBe(true);
    expect(sendInvitationEmail).toHaveBeenCalledOnce();

    const db = getDb();
    const rows = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, org.id),
          eq(invitations.email, "alice@example.com")
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");
    expect(rows[0].invitedBy).toBe(owner.id);
  });

  it("re-inviting same email → reuses existing token, no second row", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    state.user = asAuthedUser(owner);
    state.orgId = org.id;

    await inviteMember(fd({ email: "alice@example.com", role: "member" }));
    await inviteMember(fd({ email: "alice@example.com", role: "member" }));

    const db = getDb();
    const rows = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, org.id),
          eq(invitations.email, "alice@example.com"),
          isNull(invitations.acceptedAt)
        )
      );
    expect(rows).toHaveLength(1);
    expect(sendInvitationEmail).toHaveBeenCalledTimes(2);
  });

  it("invitee is already a member → blocked", async () => {
    const owner = await makeUser({ email: "owner@example.com" });
    const member = await makeUser({ email: "alice@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: owner.id, role: "owner" });
    await makeMembership({
      orgId: org.id,
      userId: member.id,
      role: "member",
    });
    state.user = asAuthedUser(owner);
    state.orgId = org.id;

    const result = await inviteMember(
      fd({ email: "alice@example.com", role: "member" })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already a member/);
    expect(sendInvitationEmail).not.toHaveBeenCalled();
  });
});
