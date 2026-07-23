// Tests for finalizeTranscription — the shared post-STT tail (polish +
// debit + cost) used by both the batch route and the streaming proxy.
//
// Polish is left disabled (polishPrefs: null) so these tests never make a
// network call — they exercise the debit + cost + idempotency behavior
// that both paths depend on. Polish itself is covered by polish.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import { appendLedger } from "@/lib/credits";
import { usageEvents } from "@/lib/db/schema";
import { finalizeTranscription } from "@/lib/transcription/finalize";

// runPolish/debit need a Cloudflare-ish env only for the Groq key + fetch,
// which we never reach because polish is disabled. An empty object is fine.
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

  it("debits, writes a usage_events row, and computes deepgram cost", async () => {
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

    expect(res.debitKind).toBe("ok");
    expect(res.finalText).toBe("hello world this is a test");
    expect(res.rawText).toBe("hello world this is a test");
    expect(res.polishApplied).toBe(false);
    expect(res.usageEventId).toBeTruthy();
    // deepgram/nova-3 seed: 430 cost / 1290 retail mC per minute.
    expect(res.upstreamMc).toBe(430);
    expect(res.retailMc).toBe(1290);
    expect(res.audioMs).toBe(60_000);

    const [row] = await getDb()
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.transcriptionClientId, "tcli-finalize-1"));
    expect(row.providerId).toBe("deepgram");
    expect(row.model).toBe("nova-3");
    expect(row.wordCount).toBe(6);
    expect(row.audioMs).toBe(60_000);
  });

  it("is idempotent on the transcription id (duplicate replay)", async () => {
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

    expect(first.debitKind).toBe("ok");
    expect(second.debitKind).toBe("duplicate");
    // Cost fields stay 0 on the duplicate branch (matches batch route).
    expect(second.upstreamMc).toBe(0);
    expect(second.retailMc).toBe(0);
    expect(second.usageEventId).toBe(first.usageEventId);

    // Only one usage_events row despite two calls.
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
    expect(res.debitKind).toBe("ok");
    // Billed on the hint: half the per-minute rate, rounded up.
    expect(res.retailMc).toBe(Math.ceil(1290 / 2));
    // audioMs (analytics) tracks the provider-reported value (0 here),
    // not the billing fallback.
    expect(res.audioMs).toBe(0);
  });
});
