// Shared post-STT pipeline for both transcription paths:
//
//   * the batch POST /api/transcribe route (upload whole clip), and
//   * the streaming WebSocket proxy (relay audio to Deepgram live).
//
// Once we have a raw transcript + a provider-reported audio duration, the
// tail is identical: optional polish pass, cost computation, and a deferred
// "settlement" (credit debit + rollups). Keeping it in one place means the
// streaming path can't silently drift from batch on billing or polish
// behavior.
//
// Latency design: only polish + cost computation run on the response
// critical path. The debit (3–5 D1 writes, measured 23–194ms) is returned
// as a `settle()` closure the caller runs AFTER responding — via
// `ctx.waitUntil()` on the batch route, and after the terminal result
// message on the streaming path. Polish itself is gated (skipped for very
// short inputs, where it was observed to be rejected anyway) and budgeted
// (raw text wins if the LLM is slower than the budget), which caps the
// 200–1100ms tail measured in production logs.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { debitForAudioTranscription } from "@/lib/credits";
import { runPolish, type PolishMode } from "@/lib/transcription/polish";
import { getProviderPricing, computeCost } from "@/lib/transcription/pricing";
import type { ProviderKeyEnv } from "@/lib/transcription/secrets";
import type { ProviderId } from "@/lib/transcription/types";

/** Transcripts shorter than this skip polish entirely. Measured: short
 *  inputs (14–27 chars) consistently had polish REJECTED (output_too_long
 *  anti-inflation guard) after burning 200–350ms — pure wasted latency.
 *  Short dictations rarely need cleanup anyway. */
export const POLISH_MIN_INPUT_CHARS = 40;

/** Max time to wait for the polish LLM before returning the raw transcript.
 *  Benched against gpt-oss-20b (reasoning_effort=low): p50 ~410ms,
 *  p95 ~750ms — 800ms admits nearly every good polish while still capping
 *  the old 1000ms+ tail. The losing LLM call is simply ignored (not billed
 *  to latency — a few orphaned tokens at Groq). */
export const POLISH_BUDGET_MS = 800;

export interface PolishPrefs {
  polishEnabled: boolean;
  polishMode: string | null;
}

/**
 * Read a user's polish prefs (a single D1 row). Returns null on any error
 * so transcription never breaks because of the prefs query. Both paths
 * kick this off in parallel with the STT work and pass the resolved value
 * into `finalizeTranscription`.
 */
export async function readPolishPrefs(userId: string): Promise<PolishPrefs | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select({ polishEnabled: users.polishEnabled, polishMode: users.polishMode })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return (row as PolishPrefs | undefined) ?? null;
  } catch (err) {
    console.warn("[transcribe] polish prefs read failed:", err);
    return null;
  }
}

export interface FinalizeArgs {
  /** Cloudflare env — needed by runPolish for the Groq key + fetch. */
  env: ProviderKeyEnv;
  orgId: string;
  userId: string;
  transcriptionClientId: string;
  providerId: ProviderId;
  model: string;
  /** Raw STT output, pre-polish. */
  rawText: string;
  /** Provider-reported audio duration in seconds (0 if unknown). */
  audioSeconds: number;
  /** Client-reported duration hint in ms — billing fallback when the
   *  provider didn't report a duration (audioSeconds === 0). */
  audioMsHint?: number;
  /** Resolved polish prefs (see readPolishPrefs). */
  polishPrefs: PolishPrefs | null;
  /** Client opted into "fast mode" (X-Polish-Skip) — return raw text. */
  polishSkip: boolean;
  /** Request start epoch ms, for processingMs + cumulative timings. */
  startedAt: number;
}

/** Outcome of the deferred debit — see `FinalizeResult.settle`. */
export interface SettleResult {
  debitKind: "ok" | "duplicate" | "insufficient";
  usageEventId?: string;
  newBalanceMillicents?: number;
  autoTopupTriggered?: boolean;
  balanceMillicents?: number;
}

export interface FinalizeResult {
  /** Post-polish transcript (=== rawText when polish disabled/skipped). */
  finalText: string;
  /** Pre-polish STT output; clients persist this for feedback reports. */
  rawText: string;
  /** Provider-reported seconds, echoed to the client as audioSeconds. */
  audioSeconds: number;
  polishApplied: boolean;
  polishErrorReason?: string;
  /** Analytics: computed cost (always computed, even if the later debit
   *  turns out to be a duplicate — analytics wants the request's cost). */
  upstreamMc: number;
  retailMc: number;
  /** Analytics: round(providerSeconds * 1000). */
  audioMs: number;
  /** Cumulative ms from startedAt at the polish checkpoint. */
  timings: { polish: number };
  /** Deferred settlement: the idempotent credit debit + rollups. Callers
   *  MUST run this exactly once, off the response path — `ctx.waitUntil()`
   *  on the batch route; after the terminal result message on streaming.
   *  Never throws (logs + returns a kind instead). */
  settle: () => Promise<SettleResult>;
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Run polish (gated + budgeted) and cost computation for a completed
 * transcription, returning everything the response needs plus a deferred
 * `settle()` for the debit. Never throws for polish failures — they fall
 * through with the raw text.
 */
export async function finalizeTranscription(args: FinalizeArgs): Promise<FinalizeResult> {
  const {
    env,
    orgId,
    userId,
    transcriptionClientId,
    providerId,
    model,
    rawText,
    audioSeconds,
    audioMsHint,
    polishPrefs,
    polishSkip,
    startedAt,
  } = args;

  const audioMs = Math.round(audioSeconds * 1000);
  // If the provider didn't report a duration, fall back to the client's
  // hint so we still debit something proportional.
  const audioSecondsForBilling =
    audioSeconds > 0 ? audioSeconds : audioMsHint ? audioMsHint / 1000 : 0;

  // ---- optional polish pass ------------------------------------------------
  let finalText = rawText;
  let polishApplied = false;
  let polishErrorReason: string | undefined;
  const trimmed = rawText.trim();
  try {
    if (polishPrefs?.polishEnabled && trimmed.length > 0 && !polishSkip) {
      if (trimmed.length < POLISH_MIN_INPUT_CHARS) {
        // Short inputs: polish is overwhelmingly rejected by the
        // anti-inflation guard on these — skip the 200–350ms round-trip.
        polishErrorReason = "skipped_short_input";
      } else {
        // Polish is single-mode now: always the "intuitive" prompt (self-
        // correction collapse + paragraphing — polish's unique value; the
        // old "prescriptive" formatting-only mode is covered natively by
        // Deepgram smart_format). users.polish_mode + the /api/me/polish
        // `mode` param remain for older-client compat but are ignored here.
        const mode: PolishMode = "intuitive";
        // Race polish against the latency budget. On timeout we return the
        // raw transcript; the losing LLM call resolves into the void.
        const budget = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), POLISH_BUDGET_MS);
        });
        const polish = await Promise.race([runPolish(env, orgId, rawText, mode), budget]);
        if (polish === null) {
          polishErrorReason = `budget_exceeded_${POLISH_BUDGET_MS}ms`;
          console.info(
            `[transcribe] polish skipped mode=${mode} ` +
              `inChars=${rawText.length} reason=${polishErrorReason}`
          );
        } else {
          // Metadata-only log (no content) so operators can confirm the
          // right prompt variant ran + whether output length looks sane.
          console.info(
            `[transcribe] polish ${polish.applied ? "applied" : "skipped"} ` +
              `mode=${mode} ` +
              `inChars=${rawText.length} outChars=${polish.text.length} ` +
              `tokens=${polish.promptTokens}/${polish.completionTokens} ` +
              `latencyMs=${polish.latencyMs}` +
              (polish.errorReason ? ` reason=${polish.errorReason}` : "")
          );
          if (polish.applied) {
            finalText = polish.text;
            polishApplied = true;
          } else {
            polishErrorReason = polish.errorReason;
          }
        }
      }
    } else if (polishSkip && polishPrefs?.polishEnabled) {
      polishErrorReason = "skipped_by_client";
    }
  } catch (err) {
    // Polish errors never block transcription — fall through with raw text.
    console.warn("[transcribe] polish threw:", err);
    polishErrorReason = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const polishAt = Date.now() - startedAt;

  // ---- cost (cheap cached read; needed for analytics at response time) ----
  let upstreamMc = 0;
  let retailMc = 0;
  try {
    const pricing = await getProviderPricing(providerId, model);
    if (pricing) {
      const costs = computeCost(pricing, audioSecondsForBilling);
      upstreamMc = costs.upstreamMc;
      retailMc = costs.retailMc;
    }
  } catch (err) {
    console.warn("[transcribe] pricing read failed:", err);
  }

  // ---- deferred settlement (debit + rollups) -------------------------------
  const settle = async (): Promise<SettleResult> => {
    try {
      const processingMs = Date.now() - startedAt;
      const debit = await debitForAudioTranscription({
        orgId,
        userId,
        transcriptionClientId,
        providerId,
        model,
        audioSeconds: audioSecondsForBilling,
        // Billed on the final (post-polish) word count so the dashboard
        // shows what the user actually got. Billing math is duration × rate.
        wordCount: wordCount(finalText),
        polishApplied,
        processingMs,
      });
      if (debit.kind === "insufficient") {
        // Rare: balance raced negative between the route's pre-check and
        // now. The user already has their text; we just couldn't charge.
        console.warn(
          `[transcribe] deferred debit found insufficient balance ` +
            `org=${orgId} balance=${debit.balanceMillicents}mc`
        );
        return { debitKind: "insufficient", balanceMillicents: debit.balanceMillicents };
      }
      if (debit.kind === "duplicate") {
        return { debitKind: "duplicate", usageEventId: debit.usageEventId };
      }
      return {
        debitKind: "ok",
        usageEventId: debit.usageEventId,
        newBalanceMillicents: debit.newBalanceMillicents,
        autoTopupTriggered: debit.autoTopupTriggered,
      };
    } catch (err) {
      // Never let settlement failures surface — the transcript already
      // shipped. Unbilled usage is preferable to a user-visible error.
      console.error("[transcribe] settle failed:", err);
      return { debitKind: "insufficient" };
    }
  };

  return {
    finalText,
    rawText,
    audioSeconds,
    polishApplied,
    polishErrorReason,
    upstreamMc,
    retailMc,
    audioMs,
    timings: { polish: polishAt },
    settle,
  };
}
