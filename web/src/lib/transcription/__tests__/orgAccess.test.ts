// Tests for the per-org routing default. The headline invariant: every
// language now defaults to Deepgram nova-3 (was Groq Whisper). The
// allow-list override paths — how a super admin pins an org to a specific
// (provider, model), e.g. back to Groq for cost — are locked here too.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeOrg } from "@/test/factories";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { languageDefault, resolveProviderForOrg } from "@/lib/transcription/orgAccess";

describe("languageDefault", () => {
  it("routes English to deepgram/nova-3", () => {
    expect(languageDefault({ language: "en" })).toEqual({
      providerId: "deepgram",
      model: "nova-3",
    });
  });

  it("routes non-English to deepgram/nova-3", () => {
    expect(languageDefault({ language: "fr" })).toEqual({
      providerId: "deepgram",
      model: "nova-3",
    });
  });

  it("routes auto-detect to deepgram/nova-3", () => {
    expect(languageDefault({ detectLanguage: true })).toEqual({
      providerId: "deepgram",
      model: "nova-3",
    });
  });
});

describe("resolveProviderForOrg", () => {
  let handle: TestDbHandle;
  beforeEach(() => {
    handle = setupTestDb();
  });
  afterEach(() => handle.close());

  async function setAllowList(orgId: string, list: string[] | null) {
    await getDb()
      .update(organizations)
      .set({ allowedModelsJson: list === null ? null : JSON.stringify(list) })
      .where(eq(organizations.id, orgId));
  }

  it("uses the language default when the org has no allow-list", async () => {
    const org = await makeOrg();
    const resolved = await resolveProviderForOrg(org.id, { language: "en" });
    expect(resolved).toMatchObject({
      providerId: "deepgram",
      model: "nova-3",
      source: "language_default",
    });
  });

  it("uses the language default when it's present in the allow-list", async () => {
    const org = await makeOrg();
    await setAllowList(org.id, ["deepgram/nova-3", "groq/whisper-large-v3-turbo"]);
    const resolved = await resolveProviderForOrg(org.id, { language: "en" });
    expect(resolved).toMatchObject({
      providerId: "deepgram",
      model: "nova-3",
      source: "allow_list_default",
    });
  });

  it("falls back to the first allow-list entry to pin an org to Groq", async () => {
    const org = await makeOrg();
    await setAllowList(org.id, ["groq/whisper-large-v3-turbo"]);
    const resolved = await resolveProviderForOrg(org.id, { language: "en" });
    expect(resolved).toMatchObject({
      providerId: "groq",
      model: "whisper-large-v3-turbo",
      source: "allow_list_fallback",
    });
  });
});
