// Tests for the prod → dev mirror receiver.
//
// Covers the auth gate (missing / wrong-prefix / revoked / wrong-scope
// bearer), body validation, and the happy path that creates a
// versioned row with source='mirror' and the auto-prefixed notes.
//
// The sender path (lib/polish-prompts-mirror.ts) is intentionally not
// tested at the integration level — it depends on env.server.DEV_MIRROR_*
// being set at module load, which requires fragile env-mocking. The
// receiver covers the business-critical surface; the sender is a
// thin fetch wrapper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeUser } from "@/test/factories";
import {
  createServiceToken,
  revokeServiceToken,
  type ServiceScope,
} from "@/lib/service-tokens";
import { getActivePrompt, listVersions } from "@/lib/polish-prompts";

// MCP / slack reach into Cloudflare context elsewhere in the import
// graph; stub the binding so the import chain doesn't crash in the
// happy path.
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

interface MirrorBody {
  mode?: string;
  body?: string;
  notes?: string;
  source_version?: number;
  source_bench_score?: number;
}

async function post(
  token: string | null,
  body: MirrorBody | string | null
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await POST(
    new Request("https://example.test/api/admin/polish-prompts/mirror-receive", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function mintToken(
  scopes: ServiceScope[]
): Promise<{ plaintext: string; userId: string }> {
  const admin = await makeUser({ isSuperAdmin: true });
  const { plaintext } = await createServiceToken({
    label: `test-${scopes.join("+")}`,
    scopes,
    createdBy: admin.id,
  });
  return { plaintext, userId: admin.id };
}

const VALID_BODY: MirrorBody = {
  mode: "intuitive",
  body: "Mirrored body — long enough to clear the fifty-character soft minimum on the receiver.",
  notes: "agent loop, fb-1 + fb-2",
  source_version: 12,
  source_bench_score: 0.93,
};

// ---- auth gate -----------------------------------------------------------

describe("POST /api/admin/polish-prompts/mirror-receive — auth", () => {
  it("returns 401 with no bearer", async () => {
    const { status } = await post(null, VALID_BODY);
    expect(status).toBe(401);
  });

  it("rejects a bearer without the ssat_ prefix", async () => {
    const { status } = await post("not-an-ssat-token", VALID_BODY);
    expect(status).toBe(401);
  });

  it("rejects an unknown / revoked token", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const tokens = await (
      await import("@/lib/service-tokens")
    ).listServiceTokens();
    await revokeServiceToken(tokens[0].id);
    const { status } = await post(plaintext, VALID_BODY);
    expect(status).toBe(401);
  });

  it("rejects a token without prompts:write (403, not 401)", async () => {
    const { plaintext } = await mintToken(["prompts:read"]);
    const { status, json } = await post(plaintext, VALID_BODY);
    expect(status).toBe(403);
    expect((json as { error: string }).error).toMatch(/prompts:write/);
  });
});

// ---- body validation -----------------------------------------------------

describe("POST /api/admin/polish-prompts/mirror-receive — body validation", () => {
  it("returns 400 on malformed JSON", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status } = await post(plaintext, "this is not json");
    expect(status).toBe(400);
  });

  it("returns 400 when body is too short", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status, json } = await post(plaintext, {
      ...VALID_BODY,
      body: "too short",
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("bad_body");
  });

  it("returns 400 when source_version is missing", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status } = await post(plaintext, {
      ...VALID_BODY,
      source_version: undefined,
    });
    expect(status).toBe(400);
  });

  it("returns 400 on unknown mode", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status } = await post(plaintext, {
      ...VALID_BODY,
      mode: "literal",
    });
    expect(status).toBe(400);
  });
});

// ---- happy path ----------------------------------------------------------

describe("POST /api/admin/polish-prompts/mirror-receive — happy path", () => {
  it("creates a new active version with source='mirror' and the auto-prefixed notes", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status, json } = await post(plaintext, VALID_BODY);
    expect(status).toBe(200);
    expect((json as { is_active: boolean }).is_active).toBe(true);

    const active = await getActivePrompt("intuitive");
    expect(active).not.toBeNull();
    expect(active!.body).toBe(VALID_BODY.body);
    expect(active!.source).toBe("mirror");
    // Auto-prefix is unconditional; caller's notes appended below.
    expect(active!.notes).toContain(
      `Mirrored from prod v${VALID_BODY.source_version}`
    );
    expect(active!.notes).toContain(VALID_BODY.notes);
    expect(active!.benchScore).toBe(VALID_BODY.source_bench_score);
    // Attribution: createdByTokenId set, createdByUserId null —
    // the mirror is a token-driven write.
    expect(active!.createdByTokenId).not.toBeNull();
    expect(active!.createdByUserId).toBeNull();
  });

  it("auto-prefix fires even when the caller sends no notes", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    const { status } = await post(plaintext, {
      ...VALID_BODY,
      notes: undefined,
    });
    expect(status).toBe(200);
    const active = await getActivePrompt("intuitive");
    expect(active!.notes).toBe(
      `Mirrored from prod v${VALID_BODY.source_version}`
    );
  });

  it("monotonically increments the local version on repeated mirrors", async () => {
    const { plaintext } = await mintToken(["prompts:write"]);
    await post(plaintext, { ...VALID_BODY, source_version: 12 });
    await post(plaintext, {
      ...VALID_BODY,
      source_version: 13,
      body:
        "Second mirrored body — long enough to clear the fifty-character soft minimum on the receiver.",
    });
    const versions = await listVersions("intuitive", { limit: 10 });
    expect(versions.length).toBe(2);
    expect(versions[0].version).toBe(2);
    expect(versions[0].isActive).toBe(true);
    expect(versions[1].version).toBe(1);
    expect(versions[1].isActive).toBe(false);
    // Both rows are source='mirror' and reference the right prod
    // version in their notes.
    expect(versions[0].notes).toContain("Mirrored from prod v13");
    expect(versions[1].notes).toContain("Mirrored from prod v12");
  });
});
