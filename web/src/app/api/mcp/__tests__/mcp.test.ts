// Tests for the /api/mcp JSON-RPC handler.
//
// Covers the auth gate (no bearer / wrong-prefix bearer / revoked
// token), the three protocol methods (initialize, tools/list,
// tools/call), per-scope tool visibility, and the dispatcher's
// error-mapping for unknown methods + tools.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeMembership, makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";
import { createServiceToken, revokeServiceToken } from "@/lib/service-tokens";

// MCP audio tool calls Cloudflare R2 — provide a fake bucket so the
// handler doesn't crash. The test that exercises audio fetch sets
// `state.r2Object`; others leave it null and expect the no-audio
// branch.
const state: {
  r2Object: { body: ArrayBuffer; contentType: string } | null;
} = { r2Object: null };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: {
      FEEDBACK_AUDIO: {
        async get(_key: string) {
          if (!state.r2Object) return null;
          return {
            arrayBuffer: async () => state.r2Object!.body,
            httpMetadata: { contentType: state.r2Object!.contentType },
          };
        },
      },
    },
  }),
}));

let handle: TestDbHandle;
let POST: typeof import("../route").POST;

beforeEach(async () => {
  handle = setupTestDb();
  state.r2Object = null;
  ({ POST } = await import("../route"));
});

afterEach(() => {
  handle.close();
  vi.resetModules();
});

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  );
  const body = (await res.json()) as RpcResponse | { error?: string };
  return { status: res.status, body };
}

async function makeFeedbackRow(opts: {
  id: string;
  userId: string;
  orgId: string;
  audioObjectKey?: string | null;
  status?: "new" | "reviewed" | "resolved" | "dismissed" | "proposed";
}) {
  await getDb()
    .insert(transcriptionFeedback)
    .values({
      id: opts.id,
      userId: opts.userId,
      orgId: opts.orgId,
      transcriptionClientId: `tcli-${opts.id}`,
      rawText: "raw stt output",
      polishedText: "Polished delivered text.",
      expectedText: "Expected user correction.",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      polishApplied: true,
      audioObjectKey: opts.audioObjectKey ?? null,
      status: opts.status ?? "new",
    });
}

async function setupReadToken() {
  const admin = await makeUser({ isSuperAdmin: true });
  const { plaintext } = await createServiceToken({
    label: "read",
    scopes: ["feedback:read"],
    createdBy: admin.id,
  });
  return { plaintext, adminId: admin.id };
}

async function setupTriageToken() {
  const admin = await makeUser({ isSuperAdmin: true });
  const { plaintext } = await createServiceToken({
    label: "triage",
    scopes: ["feedback:read", "feedback:triage"],
    createdBy: admin.id,
  });
  return { plaintext, adminId: admin.id };
}

// ---- auth gate -----------------------------------------------------------

describe("POST /api/mcp — auth", () => {
  it("returns 401 with no bearer", async () => {
    const { status } = await rpc(null, "initialize");
    expect(status).toBe(401);
  });

  it("rejects a bearer without the ssat_ prefix", async () => {
    const { status } = await rpc("not-an-ssat-token", "initialize");
    expect(status).toBe(401);
  });

  it("rejects a revoked service token", async () => {
    const { plaintext, adminId } = await setupReadToken();
    void adminId;
    // Revoke by id — pull the id back from the listing.
    const tokens = await (await import("@/lib/service-tokens")).listServiceTokens();
    await revokeServiceToken(tokens[0].id);
    const { status } = await rpc(plaintext, "initialize");
    expect(status).toBe(401);
  });
});

// ---- initialize / ping ---------------------------------------------------

describe("MCP protocol", () => {
  it("initialize returns server info + tools capability", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "initialize");
    const r = (body as RpcResponse).result as {
      protocolVersion: string;
      capabilities: { tools: object };
      serverInfo: { name: string };
    };
    expect(r.protocolVersion).toBeDefined();
    expect(r.capabilities.tools).toBeDefined();
    expect(r.serverInfo.name).toBe("speakist");
  });

  it("ping returns an empty result", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "ping");
    expect((body as RpcResponse).result).toEqual({});
  });

  it("returns method-not-found for unknown methods", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "bogus/method");
    expect((body as RpcResponse).error?.code).toBe(-32601);
  });
});

// ---- tools/list scope filtering ------------------------------------------

describe("tools/list", () => {
  it("hides triage tools when the token only has read scope", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "tools/list");
    const tools = ((body as RpcResponse).result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_feedback");
    expect(names).toContain("get_feedback");
    expect(names).toContain("get_feedback_audio");
    expect(names).not.toContain("mark_feedback_proposed");
    expect(names).not.toContain("mark_feedback_resolution");
  });

  it("includes triage tools when the token has triage scope", async () => {
    const { plaintext } = await setupTriageToken();
    const { body } = await rpc(plaintext, "tools/list");
    const tools = ((body as RpcResponse).result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("mark_feedback_proposed");
    expect(names).toContain("mark_feedback_resolution");
  });
});

// ---- tools/call dispatch -------------------------------------------------

describe("tools/call list_feedback", () => {
  it("returns rows newest-first projected without heavy fields", async () => {
    const { plaintext, adminId } = await setupReadToken();
    void adminId;
    const org = await makeOrg();
    const reporter = await makeUser({ email: "r@example.com" });
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({ id: "fb-aaaaaaaa", userId: reporter.id, orgId: org.id });
    await makeFeedbackRow({ id: "fb-bbbbbbbb", userId: reporter.id, orgId: org.id });

    const { body } = await rpc(plaintext, "tools/call", {
      name: "list_feedback",
      arguments: {},
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as {
      items: { id: string; polished_preview: string }[];
      count: number;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.items[0].polished_preview).toBe("Polished delivered text.");
    // Heavy fields should NOT be on the projection — get_feedback gives those.
    expect((parsed.items[0] as { polished_text?: string }).polished_text).toBeUndefined();
  });

  it("filters by since cursor", async () => {
    const { plaintext } = await setupReadToken();
    const org = await makeOrg();
    const reporter = await makeUser();
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({ id: "fb-old00001", userId: reporter.id, orgId: org.id });
    // One epoch tick later so the cursor cleanly excludes the first row.
    await new Promise((r) => setTimeout(r, 10));
    const cursor = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    await makeFeedbackRow({ id: "fb-new00001", userId: reporter.id, orgId: org.id });

    const { body } = await rpc(plaintext, "tools/call", {
      name: "list_feedback",
      arguments: { since: cursor },
    });
    const result = (body as RpcResponse).result as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as {
      items: { id: string }[];
    };
    expect(parsed.items.map((i) => i.id)).toEqual(["fb-new00001"]);
  });
});

describe("tools/call get_feedback", () => {
  it("returns full row detail", async () => {
    const { plaintext } = await setupReadToken();
    const org = await makeOrg();
    const reporter = await makeUser({ email: "r@example.com" });
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({ id: "fb-deadbeef", userId: reporter.id, orgId: org.id });

    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_feedback",
      arguments: { id: "fb-deadbeef" },
    });
    const result = (body as RpcResponse).result as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as {
      id: string;
      raw_text: string;
      polished_text: string;
      expected_text: string;
    };
    expect(parsed.id).toBe("fb-deadbeef");
    expect(parsed.raw_text).toBe("raw stt output");
    expect(parsed.expected_text).toBe("Expected user correction.");
  });

  it("returns isError content when id is unknown", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_feedback",
      arguments: { id: "no-such-id" },
    });
    const result = (body as RpcResponse).result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not_found");
  });
});

describe("tools/call get_feedback_audio", () => {
  it("returns has_audio=false text when the row was text-only", async () => {
    const { plaintext } = await setupReadToken();
    const org = await makeOrg();
    const reporter = await makeUser();
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({
      id: "fb-textonly",
      userId: reporter.id,
      orgId: org.id,
      audioObjectKey: null,
    });
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_feedback_audio",
      arguments: { id: "fb-textonly" },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({
      has_audio: false,
      id: "fb-textonly",
    });
  });

  it("returns audio content when R2 has the object", async () => {
    state.r2Object = {
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      contentType: "audio/wav",
    };
    const { plaintext } = await setupReadToken();
    const org = await makeOrg();
    const reporter = await makeUser();
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({
      id: "fb-withaudio",
      userId: reporter.id,
      orgId: org.id,
      audioObjectKey: "feedback/fb-withaudio.wav",
    });
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_feedback_audio",
      arguments: { id: "fb-withaudio" },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; data?: string; mimeType?: string }[];
    };
    expect(result.content[0].type).toBe("audio");
    expect(result.content[0].mimeType).toBe("audio/wav");
    // Decode the base64 data and confirm bytes round-trip.
    const decoded = atob(result.content[0].data!);
    const bytes = new Uint8Array([...decoded].map((c) => c.charCodeAt(0)));
    expect(Array.from(bytes)).toEqual([0x52, 0x49, 0x46, 0x46]);
  });
});

describe("tools/call mark_feedback_proposed", () => {
  it("updates status + resolution", async () => {
    const { plaintext } = await setupTriageToken();
    const org = await makeOrg();
    const reporter = await makeUser();
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({ id: "fb-toproposed", userId: reporter.id, orgId: org.id });

    const { body } = await rpc(plaintext, "tools/call", {
      name: "mark_feedback_proposed",
      arguments: {
        id: "fb-toproposed",
        pr_url: "https://github.com/mbrevoort/speakist/pull/123",
        summary: "covers brevort→Brevoort",
      },
    });
    expect((body as RpcResponse).result).toBeDefined();
    const [row] = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, "fb-toproposed"));
    expect(row.status).toBe("proposed");
    expect(row.resolution).toContain("brevort");
    expect(row.resolution).toContain("github.com/mbrevoort/speakist/pull/123");
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewedBy).toBeNull(); // service-token-driven, no user
  });

  it("rejects when token is read-only", async () => {
    const { plaintext } = await setupReadToken();
    const org = await makeOrg();
    const reporter = await makeUser();
    await makeMembership({ orgId: org.id, userId: reporter.id });
    await makeFeedbackRow({ id: "fb-rotatry", userId: reporter.id, orgId: org.id });
    const { body } = await rpc(plaintext, "tools/call", {
      name: "mark_feedback_proposed",
      arguments: {
        id: "fb-rotatry",
        pr_url: "https://example.test/pr",
      },
    });
    expect((body as RpcResponse).error?.code).toBe(-32600); // INVALID_REQUEST
  });
});

describe("tools/call validation", () => {
  it("returns method-not-found for an unknown tool", async () => {
    const { plaintext } = await setupReadToken();
    const { body } = await rpc(plaintext, "tools/call", {
      name: "no_such_tool",
      arguments: {},
    });
    expect((body as RpcResponse).error?.code).toBe(-32601);
  });
});
