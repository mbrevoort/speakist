// Tests for resolvePromptForMode — the three-tier fallback that
// /api/transcribe relies on.
//
// Tier 1 — active row in polish_prompt_versions
// Tier 2 — deprecated app_settings.polish_*_prompt
// Tier 3 — baked-in baseline (PR 5 will replace with the distilled
//          version; for now it's the long intuitive/prescriptive
//          constants in polish.ts)
//
// The point of locking these as a test: a future PR that drops the
// deprecated columns must explicitly remove Tier 2 + this test in
// the same change. Hard to accidentally regress to "polish silently
// serves the baseline because we forgot to migrate the rows."

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { createVersion } from "@/lib/polish-prompts";
import {
  bakedInPromptForMode,
  resolvePromptForMode,
} from "@/lib/transcription/polish";

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
});

afterEach(() => {
  handle.close();
});

describe("resolvePromptForMode", () => {
  it("Tier 3 (fallthrough): no rows in versions table + no app_settings override → baked-in baseline", async () => {
    // app_settings row exists (seeded by 0000_init) with NULL polish
    // columns; polish_prompt_versions is empty. Both fallbacks miss.
    const intuitive = await resolvePromptForMode("intuitive");
    expect(intuitive).toBe(bakedInPromptForMode("intuitive"));
    const prescriptive = await resolvePromptForMode("prescriptive");
    expect(prescriptive).toBe(bakedInPromptForMode("prescriptive"));
  });

  it("Tier 2: no active version + app_settings has an override → returns the legacy override", async () => {
    const db = getDb();
    await db
      .update(appSettings)
      .set({
        polishIntuitivePrompt: "legacy intuitive override body",
        polishPrescriptivePrompt: "legacy prescriptive override body",
      })
      .where(eq(appSettings.id, 1));

    expect(await resolvePromptForMode("intuitive")).toBe(
      "legacy intuitive override body"
    );
    expect(await resolvePromptForMode("prescriptive")).toBe(
      "legacy prescriptive override body"
    );
  });

  it("Tier 1: active version wins over both the app_settings override and the baked-in baseline", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    // Populate Tier 2 — the resolver must skip it because Tier 1
    // is set.
    const db = getDb();
    await db
      .update(appSettings)
      .set({ polishIntuitivePrompt: "should-not-be-used legacy override" })
      .where(eq(appSettings.id, 1));

    const newBody =
      "active intuitive body — versioned, lives in polish_prompt_versions.";
    await createVersion({
      mode: "intuitive",
      body: newBody,
      source: "admin",
      createdByUserId: u.id,
    });

    expect(await resolvePromptForMode("intuitive")).toBe(newBody);
  });

  it("an empty / whitespace-only app_settings override is treated as 'no override' and falls through to baked-in", async () => {
    const db = getDb();
    await db
      .update(appSettings)
      .set({
        polishIntuitivePrompt: "   \n\t   ",
        polishPrescriptivePrompt: "",
      })
      .where(eq(appSettings.id, 1));

    expect(await resolvePromptForMode("intuitive")).toBe(
      bakedInPromptForMode("intuitive")
    );
    expect(await resolvePromptForMode("prescriptive")).toBe(
      bakedInPromptForMode("prescriptive")
    );
  });

  it("modes don't bleed: an active intuitive version doesn't leak into prescriptive resolution", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    await createVersion({
      mode: "intuitive",
      body: "active INTUITIVE body, mode-specific.",
      source: "admin",
      createdByUserId: u.id,
    });
    expect(await resolvePromptForMode("intuitive")).toBe(
      "active INTUITIVE body, mode-specific."
    );
    // prescriptive has no versions row and no legacy override.
    expect(await resolvePromptForMode("prescriptive")).toBe(
      bakedInPromptForMode("prescriptive")
    );
  });

  it("rollback flow: rolling back makes the resolver serve the rolled-back body", async () => {
    const u = await makeUser({ isSuperAdmin: true });
    const v1 = await createVersion({
      mode: "intuitive",
      body: "v1 body — the stable target.",
      source: "admin",
      createdByUserId: u.id,
    });
    await createVersion({
      mode: "intuitive",
      body: "v2 body — a regression we want to undo.",
      source: "admin",
      createdByUserId: u.id,
    });
    expect(await resolvePromptForMode("intuitive")).toContain(
      "v2 body"
    );

    // Roll back to v1. resolver must immediately serve v3 (= v1's body).
    const { rollbackToVersion } = await import("@/lib/polish-prompts");
    const v3 = await rollbackToVersion({
      mode: "intuitive",
      targetVersionId: v1.id,
      createdByUserId: u.id,
    });
    expect(v3.body).toBe(v1.body);
    expect(await resolvePromptForMode("intuitive")).toBe(v1.body);
  });
});
