// Tests for the polish-prompt MCP tools.
//
// Covers the four new tools (get_active_polish_prompt,
// list_polish_prompt_versions, get_polish_prompt_version,
// propose_polish_prompt), the prompts:read / prompts:write scope
// gates, and the end-to-end propose flow that creates a versioned
// row with source='agent' attributed to the calling service token.
//
// notifyPromptUpdate is exercised implicitly — the propose path
// calls insertActiveVersion which dispatches the Slack ping. With
// no webhook configured (the default state of a fresh test DB) the
// notifier early-returns inside postToSlack, so we don't need to
// mock anything; the test just confirms the write side works
// end-to-end through the route.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeUser } from "@/test/factories";
import { createServiceToken } from "@/lib/service-tokens";
import {
  createVersion,
  getActivePrompt,
  type PolishPromptMode,
} from "@/lib/polish-prompts";

// MCP audio tool reaches into Cloudflare R2; the no-audio path
// doesn't trigger that, but the import graph still pulls the SDK in.
// Same harness shape as mcp.test.ts.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: { FEEDBACK_AUDIO: null } }),
}));

let handle: TestDbHandle;
let POST: typeof import("../route").POST;

beforeEach(async () => {
  handle = setupTestDb();
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

async function rpc(token: string, method: string, params?: unknown) {
  const res = await POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  );
  const body = (await res.json()) as RpcResponse;
  return { status: res.status, body };
}

async function mintToken(
  scopes: ("prompts:read" | "prompts:write" | "feedback:read")[]
): Promise<{ plaintext: string; adminId: string }> {
  const admin = await makeUser({ isSuperAdmin: true });
  const { plaintext } = await createServiceToken({
    label: `test-${scopes.join("+")}`,
    scopes,
    createdBy: admin.id,
  });
  return { plaintext, adminId: admin.id };
}

async function seedActive(
  mode: PolishPromptMode,
  body: string,
  benchScore?: number
) {
  const admin = await makeUser({ isSuperAdmin: true });
  return createVersion({
    mode,
    body,
    notes: "seeded by test",
    source: "admin",
    createdByUserId: admin.id,
    benchScore,
  });
}

// ---- tools/list scope filtering ------------------------------------------

describe("tools/list — prompts visibility", () => {
  it("hides all four prompt tools when the token has neither prompts:* scope", async () => {
    const { plaintext } = await mintToken(["feedback:read"]);
    const { body } = await rpc(plaintext, "tools/list");
    const tools = ((body as RpcResponse).result as {
      tools: { name: string }[];
    }).tools;
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("get_active_polish_prompt");
    expect(names).not.toContain("list_polish_prompt_versions");
    expect(names).not.toContain("get_polish_prompt_version");
    expect(names).not.toContain("propose_polish_prompt");
  });

  it("exposes the three read tools but not propose with prompts:read only", async () => {
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/list");
    const tools = ((body as RpcResponse).result as {
      tools: { name: string }[];
    }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_active_polish_prompt");
    expect(names).toContain("list_polish_prompt_versions");
    expect(names).toContain("get_polish_prompt_version");
    expect(names).not.toContain("propose_polish_prompt");
  });

  it("exposes propose with prompts:write", async () => {
    const { plaintext } = await mintToken(["prompts:read", "prompts:write"]);
    const { body } = await rpc(plaintext, "tools/list");
    const tools = ((body as RpcResponse).result as {
      tools: { name: string }[];
    }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("propose_polish_prompt");
  });
});

// ---- get_active_polish_prompt -------------------------------------------

describe("tools/call get_active_polish_prompt", () => {
  it("returns active: null when no version exists yet", async () => {
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_active_polish_prompt",
      arguments: { mode: "intuitive" },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.active).toBeNull();
    expect(typeof parsed.note).toBe("string");
  });

  it("returns the active body + metadata when one exists", async () => {
    await seedActive(
      "intuitive",
      "active intuitive body, at least fifty chars to clear the limit.",
      0.92
    );
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_active_polish_prompt",
      arguments: { mode: "intuitive" },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe("intuitive");
    expect(parsed.version).toBe(1);
    expect(parsed.is_active).toBe(true);
    expect(parsed.body).toContain("active intuitive body");
    expect(parsed.bench_score).toBe(0.92);
    expect(parsed.source).toBe("admin");
  });
});

// ---- list_polish_prompt_versions ----------------------------------------

describe("tools/call list_polish_prompt_versions", () => {
  it("returns newest-first projection, body omitted", async () => {
    await seedActive("intuitive", "v1 body — long enough to clear the floor.");
    await new Promise((r) => setTimeout(r, 5));
    await seedActive("intuitive", "v2 body — long enough to clear the floor.");
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "list_polish_prompt_versions",
      arguments: { mode: "intuitive" },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as {
      items: { version: number; is_active: boolean }[];
      count: number;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.items[0].version).toBe(2);
    expect(parsed.items[0].is_active).toBe(true);
    expect(parsed.items[1].version).toBe(1);
    expect(parsed.items[1].is_active).toBe(false);
    // Body is intentionally omitted from the listing.
    expect((parsed.items[0] as { body?: unknown }).body).toBeUndefined();
  });
});

// ---- get_polish_prompt_version ------------------------------------------

describe("tools/call get_polish_prompt_version", () => {
  it("fetches by (mode, version)", async () => {
    await seedActive("intuitive", "v1 body — long enough to clear the floor.");
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_polish_prompt_version",
      arguments: { mode: "intuitive", version: 1 },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version).toBe(1);
    expect(parsed.body).toContain("v1 body");
  });

  it("fetches by id when version is unknown to the caller", async () => {
    const v = await seedActive(
      "intuitive",
      "v1 body — long enough to clear the floor."
    );
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_polish_prompt_version",
      arguments: { id: v.id },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(v.id);
  });

  it("returns isError when no row matches", async () => {
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "get_polish_prompt_version",
      arguments: { mode: "intuitive", version: 999 },
    });
    const result = (body as RpcResponse).result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not_found");
  });
});

// ---- propose_polish_prompt -----------------------------------------------

describe("tools/call propose_polish_prompt", () => {
  it("creates a new active version with source='agent' attributed to the token", async () => {
    await seedActive(
      "intuitive",
      "v1 body — original active row, long enough to clear the floor.",
      0.85
    );
    const { plaintext } = await mintToken(["prompts:read", "prompts:write"]);

    const candidateBody =
      "Candidate v2 body — anti-response framing intact, this is the agent's revision.";
    const { body } = await rpc(plaintext, "tools/call", {
      name: "propose_polish_prompt",
      arguments: {
        mode: "intuitive",
        body: candidateBody,
        notes: "Addresses feedback IDs fb-1 and fb-2 — trap-question regression.",
        bench_score: 0.93,
        bench_results: { passed: 22, failed: 0 },
      },
    });
    const result = (body as RpcResponse).result as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe(2);
    expect(parsed.is_active).toBe(true);
    expect(parsed.bench_score).toBe(0.93);

    // Confirm the new active row in the DB matches what the agent
    // proposed — body, source, and createdByTokenId all set
    // correctly.
    const active = await getActivePrompt("intuitive");
    expect(active?.body).toBe(candidateBody);
    expect(active?.source).toBe("agent");
    expect(active?.createdByTokenId).not.toBeNull();
    expect(active?.createdByUserId).toBeNull();
  });

  it("rejects a token that lacks prompts:write", async () => {
    const { plaintext } = await mintToken(["prompts:read"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "propose_polish_prompt",
      arguments: {
        mode: "intuitive",
        body: "a candidate that's long enough to clear the fifty-char limit",
        notes: "n",
      },
    });
    expect((body as RpcResponse).error?.message).toMatch(/scope/i);
  });

  it("rejects a body shorter than the soft minimum", async () => {
    const { plaintext } = await mintToken(["prompts:read", "prompts:write"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "propose_polish_prompt",
      arguments: {
        mode: "intuitive",
        body: "too short",
        notes: "n",
      },
    });
    // Args validation rejects via ZodError → INVALID_PARAMS.
    expect((body as RpcResponse).error?.code).toBe(-32602);
  });

  it("requires notes (the why)", async () => {
    const { plaintext } = await mintToken(["prompts:read", "prompts:write"]);
    const { body } = await rpc(plaintext, "tools/call", {
      name: "propose_polish_prompt",
      arguments: {
        mode: "intuitive",
        body: "candidate body long enough to clear the floor, anti-response framing kept.",
        // notes: missing
      },
    });
    expect((body as RpcResponse).error?.code).toBe(-32602);
  });
});
