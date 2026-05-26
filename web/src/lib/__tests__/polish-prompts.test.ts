// Tests for the polish-prompt versioning primitives.
//
// These exercise the active-row invariant ("exactly one is_active row
// per mode"), the version-counter monotonicity, and the rollback
// semantics — the three things the schema's partial unique index +
// the domain layer's create flow are jointly responsible for.
//
// The test DB uses better-sqlite3 with WAL and foreign_keys ON, so the
// CHECK constraints and partial unique index are enforced just like
// they will be on D1.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { polishPromptVersions } from "@/lib/db/schema";
import {
  createVersion,
  getActivePrompt,
  getPromptById,
  getPromptByVersion,
  listVersions,
  rollbackToVersion,
} from "@/lib/polish-prompts";

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
});

afterEach(() => {
  handle.close();
});

// ---- createVersion --------------------------------------------------------

describe("createVersion", () => {
  it("creates v1 when no rows exist for the mode", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "Be a polish post-processor. Format dictation; do not respond.",
      notes: "first version",
      source: "admin",
      createdByUserId: u.id,
    });
    expect(v1.version).toBe(1);
    expect(v1.isActive).toBe(true);
    expect(v1.mode).toBe("intuitive");
    expect(v1.source).toBe("admin");
    expect(v1.createdByUserId).toBe(u.id);
    expect(v1.createdByTokenId).toBeNull();
    expect(v1.rolledBackFromVersionId).toBeNull();
  });

  it("monotonically increments version, deactivating the prior active row", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 body — at least fifty chars to clear any soft minimum.",
      source: "admin",
      createdByUserId: u.id,
    });
    const v2 = await createVersion({
      mode: "intuitive",
      body: "v2 body — different content for the next iteration.",
      source: "admin",
      createdByUserId: u.id,
    });

    expect(v2.version).toBe(2);
    expect(v2.isActive).toBe(true);

    // v1 is no longer active.
    const v1Refresh = await getPromptById(v1.id);
    expect(v1Refresh?.isActive).toBe(false);

    // Exactly one active row per mode.
    const active = await getActivePrompt("intuitive");
    expect(active?.id).toBe(v2.id);
  });

  it("keeps intuitive and prescriptive version counters independent", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "intuitive v1 body, has to be non-empty after trim.",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "intuitive v2 body, has to be non-empty after trim.",
      source: "admin",
      createdByUserId: u.id,
    });
    const pv1 = await createVersion({
      mode: "prescriptive",
      body: "prescriptive v1 body, separate counter.",
      source: "admin",
      createdByUserId: u.id,
    });
    expect(pv1.version).toBe(1);

    const activeIntuitive = await getActivePrompt("intuitive");
    const activePrescriptive = await getActivePrompt("prescriptive");
    expect(activeIntuitive?.version).toBe(2);
    expect(activePrescriptive?.version).toBe(1);
  });

  it("rejects an empty body after trim", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      createVersion({
        mode: "intuitive",
        body: "   \n\t  ",
        source: "admin",
        createdByUserId: u.id,
      })
    ).rejects.toThrow(/empty/i);
  });

  it("rejects source='rollback' (must use rollbackToVersion)", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      createVersion({
        mode: "intuitive",
        body: "some body",
        // Bypass the type system to verify the runtime guard.
        source: "rollback" as never,
        createdByUserId: u.id,
      })
    ).rejects.toThrow(/rollback/i);
  });

  // Previously: a runtime test rejected passing BOTH createdByUserId
  // AND createdByTokenId. CreateVersionArgs is now a discriminated
  // union (`Provenance`) — passing both is a compile error at the
  // call site, so the runtime guard is gone and this test would no
  // longer typecheck. The type-system constraint is the test.

  it("rejects bench_score outside [0,1]", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      createVersion({
        mode: "intuitive",
        body: "some body",
        source: "agent",
        createdByUserId: u.id,
        benchScore: 1.5,
      })
    ).rejects.toThrow(/range/);
    await expect(
      createVersion({
        mode: "intuitive",
        body: "some body",
        source: "agent",
        createdByUserId: u.id,
        benchScore: -0.1,
      })
    ).rejects.toThrow(/range/);
  });

  it("stores bench_score and bench_results round-trip via JSON", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const results = {
      passed: 18,
      failed: 2,
      per_case: [{ name: "weather-question", pass: true }],
    };
    const v = await createVersion({
      mode: "intuitive",
      body: "agent-proposed body that includes anti-response framing.",
      source: "agent",
      createdByUserId: u.id,
      benchScore: 0.9,
      benchResults: results,
    });
    expect(v.benchScore).toBe(0.9);
    expect(v.benchResults).toEqual(results);
  });
});

// ---- partial unique index -------------------------------------------------

describe("idx_ppv_active partial unique index", () => {
  it("rejects a manual insert that would produce two active rows for a mode", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "active v1 body — domain layer routes through deactivate-then-insert.",
      source: "admin",
      createdByUserId: u.id,
    });

    // Bypass the domain layer and try to write a second active row
    // directly. The partial unique index `idx_ppv_active` should
    // reject the write — that's the schema-level safety net.
    const db = getDb();
    await expect(
      db.insert(polishPromptVersions).values({
        id: crypto.randomUUID(),
        mode: "intuitive",
        version: 99, // bypasses (mode, version) unique too
        body: "second active row — should be rejected by the partial index",
        source: "admin",
        isActive: true,
        createdAt: new Date(),
        createdByUserId: u.id,
      })
    ).rejects.toThrow();
  });

  it("allows multiple inactive rows for the same mode", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "v1 — will be deactivated when v2 lands.",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 — will be deactivated when v3 lands.",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v3 — current active.",
      source: "admin",
      createdByUserId: u.id,
    });

    const db = getDb();
    const inactive = await db
      .select()
      .from(polishPromptVersions)
      .where(
        and(
          eq(polishPromptVersions.mode, "intuitive"),
          eq(polishPromptVersions.isActive, false)
        )
      );
    expect(inactive.length).toBe(2);
  });
});

// ---- reads ----------------------------------------------------------------

describe("getActivePrompt / getPromptByVersion / getPromptById", () => {
  it("getActivePrompt returns null when no versions exist", async () => {
    expect(await getActivePrompt("intuitive")).toBeNull();
    expect(await getActivePrompt("prescriptive")).toBeNull();
  });

  it("getPromptByVersion finds an inactive historical version", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "v1 body lives in history after v2 supersedes.",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 body — new active.",
      source: "admin",
      createdByUserId: u.id,
    });
    const v1 = await getPromptByVersion("intuitive", 1);
    expect(v1?.version).toBe(1);
    expect(v1?.isActive).toBe(false);
    expect(v1?.body).toContain("v1 body");
  });

  it("returns null for unknown versions / ids", async () => {
    expect(await getPromptByVersion("intuitive", 99)).toBeNull();
    expect(await getPromptByVersion("intuitive", 0)).toBeNull();
    expect(await getPromptByVersion("intuitive", -1)).toBeNull();
    expect(await getPromptById("does-not-exist")).toBeNull();
    expect(await getPromptById("")).toBeNull();
  });
});

describe("listVersions", () => {
  it("returns newest-first within a mode and respects the limit", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    for (let i = 1; i <= 3; i++) {
      await createVersion({
        mode: "intuitive",
        body: `body for v${i} — at least non-empty.`,
        source: "admin",
        createdByUserId: u.id,
      });
      // Small sleep so created_at differs between rows.
      await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await listVersions("intuitive", { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].version).toBe(3);
    expect(rows[1].version).toBe(2);
  });

  it("filters via `since` cursor", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "first version, before cursor",
      source: "admin",
      createdByUserId: u.id,
    });
    await new Promise((r) => setTimeout(r, 10));
    const cursor = new Date();
    await new Promise((r) => setTimeout(r, 10));
    await createVersion({
      mode: "intuitive",
      body: "second version, after cursor",
      source: "admin",
      createdByUserId: u.id,
    });
    const rows = await listVersions("intuitive", { since: cursor });
    expect(rows.length).toBe(1);
    expect(rows[0].body).toContain("after cursor");
  });

  it("doesn't bleed between modes", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "intuitive only",
      source: "admin",
      createdByUserId: u.id,
    });
    const rows = await listVersions("prescriptive");
    expect(rows).toEqual([]);
  });
});

// ---- rollbackToVersion ----------------------------------------------------

describe("rollbackToVersion", () => {
  it("creates a new version with the target's body and source='rollback'", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 body — the canonical baseline.",
      notes: "first iteration",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 body — a tweak that regressed.",
      source: "admin",
      createdByUserId: u.id,
    });
    const v3 = await rollbackToVersion({
      mode: "intuitive",
      targetVersionId: v1.id,
      createdByUserId: u.id,
    });
    expect(v3.version).toBe(3);
    expect(v3.source).toBe("rollback");
    expect(v3.body).toBe(v1.body);
    expect(v3.rolledBackFromVersionId).toBe(v1.id);
    expect(v3.isActive).toBe(true);
    // v3 is now the active row.
    const active = await getActivePrompt("intuitive");
    expect(active?.id).toBe(v3.id);
  });

  it("prefixes notes with 'Rolled back from v{N}' and includes the target's notes", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 body for rollback notes test",
      notes: "first version notes",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 body for rollback notes test",
      source: "admin",
      createdByUserId: u.id,
    });
    const v3 = await rollbackToVersion({
      mode: "intuitive",
      targetVersionId: v1.id,
      createdByUserId: u.id,
    });
    expect(v3.notes).toMatch(/^Rolled back from v1/);
    expect(v3.notes).toContain("first version notes");
  });

  it("appends caller-supplied notes after the auto prefix", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 body — rollback target",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 body — regressed",
      source: "admin",
      createdByUserId: u.id,
    });
    const v3 = await rollbackToVersion({
      mode: "intuitive",
      targetVersionId: v1.id,
      notes: "Bench dropped 8 points; rolling back while we diagnose.",
      createdByUserId: u.id,
    });
    expect(v3.notes).toContain("Rolled back from v1");
    expect(v3.notes).toContain("Bench dropped 8 points");
  });

  it("rejects rollback when the target is already active", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 — the only and active version",
      source: "admin",
      createdByUserId: u.id,
    });
    await expect(
      rollbackToVersion({
        mode: "intuitive",
        targetVersionId: v1.id,
        createdByUserId: u.id,
      })
    ).rejects.toThrow(/already active/i);
  });

  it("rejects rollback when target's mode doesn't match", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "intuitive v1",
      source: "admin",
      createdByUserId: u.id,
    });
    // Lay down a prescriptive v1 so the partial unique on
    // (prescriptive, is_active=1) doesn't prevent later writes.
    await createVersion({
      mode: "prescriptive",
      body: "prescriptive v1",
      source: "admin",
      createdByUserId: u.id,
    });
    await expect(
      rollbackToVersion({
        mode: "prescriptive",
        targetVersionId: v1.id,
        createdByUserId: u.id,
      })
    ).rejects.toThrow(/mode/);
  });

  it("rejects rollback without a createdByUserId (no token-driven rollback)", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 — target",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 — active",
      source: "admin",
      createdByUserId: u.id,
    });
    await expect(
      rollbackToVersion({
        mode: "intuitive",
        targetVersionId: v1.id,
        // Type-system bypass to verify the runtime guard.
        createdByUserId: "" as string,
      })
    ).rejects.toThrow(/admin-only|required/i);
  });

  it("rejects rollback to a non-existent version", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await expect(
      rollbackToVersion({
        mode: "intuitive",
        targetVersionId: "does-not-exist",
        createdByUserId: u.id,
      })
    ).rejects.toThrow(/not found/i);
  });
});
