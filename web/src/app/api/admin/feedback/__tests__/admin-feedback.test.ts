// Tests for the super-admin feedback API surface:
//   GET   /api/admin/feedback           — list (filter by status)
//   PATCH /api/admin/feedback/[id]      — update status / resolution
//
// Audio streaming (GET /api/admin/feedback/[id]/audio) is out of scope
// for unit tests — it just round-trips through the R2 binding which is
// covered by /api/feedback's own audio-upload assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeMembership, makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";

const state: {
  user: AuthedUser | null;
  authError: boolean;
} = { user: null, authError: false };

vi.mock("@/lib/authz", () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireUserFromRequest: async () => {
      if (state.authError) {
        throw new AuthzError(401, "no session");
      }
      if (!state.user) {
        throw new AuthzError(401, "no user set in test state");
      }
      return state.user;
    },
  };
});

let handle: TestDbHandle;
let listGET: typeof import("../route").GET;
let detailPATCH: typeof import("../[id]/route").PATCH;

beforeEach(async () => {
  handle = setupTestDb();
  state.user = null;
  state.authError = false;
  ({ GET: listGET } = await import("../route"));
  ({ PATCH: detailPATCH } = await import("../[id]/route"));
});

afterEach(() => {
  handle.close();
  vi.resetModules();
});

// Helper: insert a feedback row directly with sane defaults.
async function makeFeedback(overrides: {
  id: string;
  userId: string;
  orgId: string;
  status?: "new" | "reviewed" | "resolved" | "dismissed" | "proposed";
  createdAt?: Date;
  rawText?: string;
  polishedText?: string;
  expectedText?: string;
  audioObjectKey?: string | null;
}) {
  await getDb()
    .insert(transcriptionFeedback)
    .values({
      id: overrides.id,
      userId: overrides.userId,
      orgId: overrides.orgId,
      createdAt: overrides.createdAt ?? new Date(),
      transcriptionClientId: `tcli-${overrides.id}`,
      rawText: overrides.rawText ?? "raw",
      polishedText: overrides.polishedText ?? "polished",
      expectedText: overrides.expectedText ?? "expected",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      polishApplied: true,
      audioObjectKey: overrides.audioObjectKey ?? null,
      status: overrides.status ?? "new",
    });
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(`https://example.test${url}`, init);
}

describe("GET /api/admin/feedback", () => {
  it("forbids non-super-admins", async () => {
    const u = await makeUser({ email: "regular@example.com" });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await listGET(makeRequest("/api/admin/feedback"));
    expect(res.status).toBe(403);
  });

  it("returns 401 when not signed in", async () => {
    state.authError = true;
    const res = await listGET(makeRequest("/api/admin/feedback"));
    expect(res.status).toBe(401);
  });

  it("lists rows newest-first, filtered by status=new (default)", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    const org = await makeOrg();
    const reporter = await makeUser({ email: "r@example.com" });
    await makeMembership({ orgId: org.id, userId: reporter.id });

    await makeFeedback({
      id: "feedback-old",
      userId: reporter.id,
      orgId: org.id,
      status: "new",
      createdAt: new Date(2026, 0, 1),
    });
    await makeFeedback({
      id: "feedback-recent",
      userId: reporter.id,
      orgId: org.id,
      status: "new",
      createdAt: new Date(2026, 5, 1),
      audioObjectKey: "feedback/feedback-recent.wav",
    });
    await makeFeedback({
      id: "feedback-resolved",
      userId: reporter.id,
      orgId: org.id,
      status: "resolved",
    });

    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await listGET(makeRequest("/api/admin/feedback"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        userEmail: string;
        hasAudio: boolean;
        audioObjectKey?: string;
      }>;
    };
    // status=new default — only the two new rows, newest first.
    expect(body.items.map((r: { id: string }) => r.id)).toEqual([
      "feedback-recent",
      "feedback-old",
    ]);
    // hasAudio is exposed as a boolean; the object key is hidden.
    const recent = body.items.find((r) => r.id === "feedback-recent");
    expect(recent).toBeDefined();
    expect(recent!.hasAudio).toBe(true);
    expect(recent!.audioObjectKey).toBeUndefined();
    expect(recent!.userEmail).toBe("r@example.com");
  });

  it("respects status=all", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    const org = await makeOrg();
    const reporter = await makeUser({ email: "r@example.com" });
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedback({
      id: "f1",
      userId: reporter.id,
      orgId: org.id,
      status: "new",
    });
    await makeFeedback({
      id: "f2",
      userId: reporter.id,
      orgId: org.id,
      status: "resolved",
    });
    await makeFeedback({
      id: "f3",
      userId: reporter.id,
      orgId: org.id,
      status: "dismissed",
    });

    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await listGET(
      makeRequest("/api/admin/feedback?status=all")
    );
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        userEmail: string;
        hasAudio: boolean;
        audioObjectKey?: string;
      }>;
    };
    expect(body.items.length).toBe(3);
  });

  it("rejects unknown status values", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await listGET(
      makeRequest("/api/admin/feedback?status=bogus")
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/feedback/[id]", () => {
  it("forbids non-super-admins", async () => {
    const u = await makeUser({ email: "u@example.com" });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await detailPATCH(
      makeRequest("/api/admin/feedback/abc12345", {
        method: "PATCH",
        body: JSON.stringify({ status: "reviewed" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "abc12345" }) }
    );
    expect(res.status).toBe(403);
  });

  it("updates status and stamps the reviewer", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    const org = await makeOrg();
    const reporter = await makeUser({ email: "r@example.com" });
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedback({
      id: "fb-aaaaaaa1",
      userId: reporter.id,
      orgId: org.id,
      status: "new",
    });

    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await detailPATCH(
      makeRequest("/api/admin/feedback/fb-aaaaaaa1", {
        method: "PATCH",
        body: JSON.stringify({
          status: "resolved",
          resolution: "added to polish-fixtures.ts",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "fb-aaaaaaa1" }) }
    );
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, "fb-aaaaaaa1"));
    expect(row.status).toBe("resolved");
    expect(row.resolution).toBe("added to polish-fixtures.ts");
    expect(row.reviewedBy).toBe(admin.id);
    expect(row.reviewedAt).toBeInstanceOf(Date);
  });

  it("returns 404 for unknown ids", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await detailPATCH(
      makeRequest("/api/admin/feedback/no-such-id", {
        method: "PATCH",
        body: JSON.stringify({ status: "reviewed" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "no-such-id" }) }
    );
    expect(res.status).toBe(404);
  });

  it("rejects an empty body (must include status or resolution)", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      isSuperAdmin: true,
    });
    state.user = {
      id: admin.id,
      email: admin.email,
      displayName: null,
      isSuperAdmin: true,
    };
    const res = await detailPATCH(
      makeRequest("/api/admin/feedback/anything1", {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "anything1" }) }
    );
    expect(res.status).toBe(400);
  });
});
