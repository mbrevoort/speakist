// Tests for the service-tokens primitives (mint / verify / revoke).
// Hits the real DB through setupTestDb so the SHA-256 hash + UNIQUE
// index are exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeUser } from "@/test/factories";
import { hashToken } from "@/lib/hash";
import {
  createServiceToken,
  listServiceTokens,
  revokeServiceToken,
  TOKEN_PREFIX,
  verifyServiceToken,
} from "@/lib/service-tokens";

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
});

afterEach(() => {
  handle.close();
});

describe("createServiceToken", () => {
  it("returns a plaintext starting with the canonical prefix", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const { plaintext, id } = await createServiceToken({
      label: "test",
      scopes: ["feedback:read"],
      createdBy: u.id,
    });
    expect(plaintext.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(plaintext.length).toBeGreaterThan(TOKEN_PREFIX.length + 20);
    expect(typeof id).toBe("string");
  });

  it("rejects an empty label", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      createServiceToken({ label: "  ", scopes: ["feedback:read"], createdBy: u.id })
    ).rejects.toThrow();
  });

  it("rejects unknown scopes", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      createServiceToken({
        label: "x",
        scopes: ["feedback:bogus" as "feedback:read"],
        createdBy: u.id,
      })
    ).rejects.toThrow();
  });
});

describe("verifyServiceToken", () => {
  it("returns the verified row when the plaintext matches an active token", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const { plaintext, id } = await createServiceToken({
      label: "test",
      scopes: ["feedback:read", "feedback:triage"],
      createdBy: u.id,
    });
    const verified = await verifyServiceToken(plaintext);
    expect(verified).not.toBeNull();
    expect(verified!.id).toBe(id);
    expect(new Set(verified!.scopes)).toEqual(
      new Set(["feedback:read", "feedback:triage"])
    );
  });

  it("returns null for a missing plaintext", async () => {
    const verified = await verifyServiceToken(`${TOKEN_PREFIX}does-not-exist`);
    expect(verified).toBeNull();
  });

  it("returns null when the bearer doesn't have the ssat_ prefix", async () => {
    const verified = await verifyServiceToken("Bearer abc");
    expect(verified).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const { plaintext, id } = await createServiceToken({
      label: "test",
      scopes: ["feedback:read"],
      createdBy: u.id,
    });
    expect(await verifyServiceToken(plaintext)).not.toBeNull();
    await revokeServiceToken(id);
    expect(await verifyServiceToken(plaintext)).toBeNull();
  });
});

describe("hashToken", () => {
  it("is deterministic and produces a 64-char lowercase hex string", async () => {
    const a = await hashToken("hello");
    const b = await hashToken("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different hashes for different inputs", async () => {
    const a = await hashToken("hello");
    const b = await hashToken("hellp");
    expect(a).not.toBe(b);
  });
});

describe("listServiceTokens", () => {
  it("returns active tokens before revoked ones, newest first within each group", async () => {
    const u = await makeUser({ email: "admin@example.com", isSuperAdmin: true });
    const a = await createServiceToken({
      label: "a (oldest active)",
      scopes: ["feedback:read"],
      createdBy: u.id,
    });
    // Bump clock by writing directly so the next token sorts later.
    await new Promise((r) => setTimeout(r, 5));
    const b = await createServiceToken({
      label: "b (newest active)",
      scopes: ["feedback:triage"],
      createdBy: u.id,
    });
    await new Promise((r) => setTimeout(r, 5));
    const c = await createServiceToken({
      label: "c (revoked)",
      scopes: ["feedback:read"],
      createdBy: u.id,
    });
    await revokeServiceToken(c.id);

    const rows = await listServiceTokens();
    const ids = rows.map((r) => r.id);
    // Active first, newest within active group.
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(a.id);
    expect(ids[2]).toBe(c.id);
    // Created-by email surfaced via join.
    expect(rows.find((r) => r.id === a.id)?.createdByEmail).toBe(
      "admin@example.com"
    );
  });
});

describe("revokeServiceToken", () => {
  it("returns true the first time, false on a no-op re-revoke", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const { id } = await createServiceToken({
      label: "test",
      scopes: ["feedback:read"],
      createdBy: u.id,
    });
    expect(await revokeServiceToken(id)).toBe(true);
    expect(await revokeServiceToken(id)).toBe(false);
  });
});
