// Tests for finalizeTranscription — the shared post-STT tail (polish +
// cost on the critical path, deferred settle() for the debit) used by both
// the batch route and the streaming proxy.
//
// Polish is left disabled (polishPrefs: null) in the billing tests so they
// never make a network call. The gate tests use polishEnabled=true but rely
// on the short-input gate firing BEFORE any network/key resolution.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { appendLedger } from "@/lib/credits";
import { usageEvents } from "@/lib/db/schema";
import {
  finalizeTranscription,
  POLISH_MIN_INPUT_CHARS,
} from "@/lib/transcription/finalize";

// runPolish/debit need a Cloudflare-ish env only for the Groq key + fetch,
// which we never reach in these tests. An empty object is fine.
const env = {} as never;

describe("finalizeTranscription", () => {
  let h: TestDbHandle;
  beforeEach(() => {
    h = setupTestDb();
  });
  afterEach(() => {
    h.close();
  });

  async function fundedOrg() {
    const org = await makeOrg();
    const user = await makeUser({ email: "u@example.com" });
    await appendLedger({
      orgId: org.id,
      deltaMillicents: 1_000_000,
      reason: "signup_bonus",
    });
    return { org, user };
  }

  it("computes cost up front and settles the debit deferred", async () => {
    const { org, user } = await fundedOrg();
    const res = await finalizeTranscription({
      env,
      orgId: org.id,
      userId: user.id,
      transcriptionClientId: "tcli-finalize-1",
      providerId: "deepgram",
      model: "nova-3",
      rawText: "hello world this is a test",
      audioSeconds: 60, // exactly one minute → cost == per-minute rate
      polishPrefs: null,
      polishSkip: false,
      startedAt: 0,
    });

    // Critical-path result: text + cost, no debit yet.
    expect(res.finalText).toBe("hello world this is a test");
    expect(res.rawText).toBe("hello world this is a test");
    expect(res.polishApplied).toBe(false);
    // deepgram/nova-3 seed: 430 cost / 1290 retail mC per minute.
    expect(res.upstreamMc).toBe(430);
    expect(res.retailMc).toBe(1290);
    expect(res.audioMs).toBe(60_000);

    // No usage_events row until settle() runs.
    const before = await getDb()
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.transcriptionClientId, "tcli-finalize-1"));
    expect(before).toHaveLength(0);

    const settled = await res.settle();
    expect(settled.debitKind).toBe("ok");
    expect(settled.usageEventId).toBeTruthy();

    const [row] = await getDb()
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.transcriptionClientId, "tcli-finalize-1"));
    expect(row.providerId).toBe("deepgram");
    expect(row.model).toBe("nova-3");
    expect(row.wordCount).toBe(6);
    expect(row.audioMs).toBe(60_000);
  });

  it("settle is idempotent on the transcription id (duplicate replay)", async () => {
    const { org, user } = await fundedOrg();
    const args = {
      env,
      orgId: org.id,
      userId: user.id,
      transcriptionClientId: "tcli-finalize-dup",
      providerId: "deepgram" as const,
      model: "nova-3",
      rawText: "same clip",
      audioSeconds: 30,
      polishPrefs: null,
      polishSkip: false,
      startedAt: 0,
    };
    const first = await finalizeTranscription(args);
    const second = await finalizeTranscription(args);

    const firstSettle = await first.settle();
    const secondSettle = await second.settle();
    expect(firstSettle.debitKind).toBe("ok");
    expect(secondSettle.debitKind).toBe("duplicate");
    expect(secondSettle.usageEventId).toBe(firstSettle.usageEventId);

    // Only one usage_events row despite two settles.
    const rows = await getDb()
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.transcriptionClientId, "tcli-finalize-dup"));
    expect(rows).toHaveLength(1);
  });

  it("falls back to the client duration hint when the provider reports 0s", async () => {
    const { org, user } = await fundedOrg();
    const res = await finalizeTranscription({
      env,
      orgId: org.id,
      userId: user.id,
      transcriptionClientId: "tcli-finalize-hint",
      providerId: "deepgram",
      model: "nova-3",
      rawText: "no duration from provider",
      audioSeconds: 0,
      audioMsHint: 30_000, // half a minute
      polishPrefs: null,
      polishSkip: false,
      startedAt: 0,
    });
    // Billed on the hint: half the per-minute rate, rounded up.
    expect(res.retailMc).toBe(Math.ceil(1290 / 2));
    // audioMs (analytics) tracks the provider-reported value (0 here),
    // not the billing fallback.
    expect(res.audioMs).toBe(0);
    const settled = await res.settle();
    expect(settled.debitKind).toBe("ok");
  });

  it("skips polish for short inputs without touching the network", async () => {
    const { org, user } = await fundedOrg();
    const shortText = "quick note"; // well under POLISH_MIN_INPUT_CHARS
    expect(shortText.length).toBeLessThan(POLISH_MIN_INPUT_CHARS);
    const res = await finalizeTranscription({
      env,
      orgId: org.id,
      userId: user.id,
      transcriptionClientId: "tcli-finalize-short",
      providerId: "deepgram",
      model: "nova-3",
      rawText: shortText,
      audioSeconds: 2,
      // Polish ENABLED — the gate must fire before any key resolution or
      // fetch (this test env has no Groq key; reaching runPolish would
      // surface a different errorReason).
      polishPrefs: { polishEnabled: true, polishMode: "prescriptive" },
      polishSkip: false,
      startedAt: 0,
    });
    expect(res.polishApplied).toBe(false);
    expect(res.polishErrorReason).toBe("skipped_short_input");
    expect(res.finalText).toBe(shortText);
  });

  it("honors the client fast-mode skip over the short-input gate", async () => {
    const { org, user } = await fundedOrg();
    const res = await finalizeTranscription({
      env,
      orgId: org.id,
      userId: user.id,
      transcriptionClientId: "tcli-finalize-skip",
      providerId: "deepgram",
      model: "nova-3",
      rawText: "short",
      audioSeconds: 1,
      polishPrefs: { polishEnabled: true, polishMode: "prescriptive" },
      polishSkip: true,
      startedAt: 0,
    });
    expect(res.polishApplied).toBe(false);
    expect(res.polishErrorReason).toBe("skipped_by_client");
  });
});
