// Shared post-STT pipeline for both transcription paths:
//
//   * the batch POST /api/transcribe route (upload whole clip), and
//   * the streaming WebSocket proxy (relay audio to Deepgram live).
//
// Once we have a raw transcript + a provider-reported audio duration, the
// tail is identical: optional polish pass, credit debit (idempotent on the
// client-supplied transcription id), PostHog analytics for the polish LLM,
// and cost computation. Keeping it in one place means the streaming path
// can't silently drift from batch on billing or polish behavior.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { debitForAudioTranscription } from "@/lib/credits";
import { runPolish, POLISH_MODEL, type PolishMode } from "@/lib/transcription/polish";
import { getProviderPricing, computeCost } from "@/lib/transcription/pricing";
import { captureAIGeneration } from "@/lib/posthog/server";
import type { ProviderKeyEnv } from "@/lib/transcription/secrets";
import type { ProviderId } from "@/lib/transcription/types";

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

export interface FinalizeResult {
  debitKind: "ok" | "duplicate" | "insufficient";
  /** Present only when debitKind === "insufficient". */
  balanceMillicents?: number;
  /** Post-polish transcript (=== rawText when polish disabled/skipped). */
  finalText: string;
  /** Pre-polish STT output; clients persist this for feedback reports. */
  rawText: string;
  /** Provider-reported seconds, echoed to the client as audioSeconds. */
  audioSeconds: number;
  polishApplied: boolean;
  polishErrorReason?: string;
  usageEventId?: string;
  newBalanceMillicents?: number;
  autoTopupTriggered?: boolean;
  /** Analytics: computed cost. 0 on duplicate/insufficient (as before). */
  upstreamMc: number;
  retailMc: number;
  /** Analytics: round(providerSeconds * 1000). */
  audioMs: number;
  processingMs: number;
  /** Cumulative ms from startedAt at the polish + debit checkpoints, so
   *  the batch route can keep its per-stage `timings` breakdown. */
  timings: { polish: number; debit: number };
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Run polish (optional) + debit + cost computation for a completed
 * transcription. Never throws for polish failures — they fall through with
 * the raw text. Returns everything both response builders need; mapping to
 * HTTP JSON vs a WebSocket terminal message is the caller's job.
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
  try {
    if (polishPrefs?.polishEnabled && rawText.trim().length > 0 && !polishSkip) {
      const polish = await runPolish(
        env,
        orgId,
        rawText,
        (polishPrefs.polishMode as PolishMode) ?? "prescriptive"
      );
      // Metadata-only log (no content) so operators can confirm the right
      // prompt variant ran + whether output length looks sane.
      console.info(
        `[transcribe] polish ${polish.applied ? "applied" : "skipped"} ` +
          `mode=${polishPrefs.polishMode} ` +
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
      captureAIGeneration({
        distinctId: userId,
        traceId: transcriptionClientId,
        provider: "groq",
        model: POLISH_MODEL,
        inputTokens: polish.promptTokens,
        outputTokens: polish.completionTokens,
        latencySeconds: polish.latencyMs / 1000,
        httpStatus: polish.applied ? 200 : 0,
        isError: !polish.applied,
        groups: { organization: orgId },
        extra: {
          polish_mode: polishPrefs.polishMode,
          polish_applied: polish.applied,
          polish_error_reason: polish.errorReason,
          input_chars: rawText.length,
          output_chars: polish.text.length,
        },
      });
    } else if (polishSkip && polishPrefs?.polishEnabled) {
      polishErrorReason = "skipped_by_client";
    }
  } catch (err) {
    // Polish errors never block transcription — fall through with raw text.
    console.warn("[transcribe] polish threw:", err);
    polishErrorReason = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const polishAt = Date.now() - startedAt;

  // ---- debit ---------------------------------------------------------------
  const processingMs = Date.now() - startedAt;
  const debit = await debitForAudioTranscription({
    orgId,
    userId,
    transcriptionClientId,
    providerId,
    model,
    audioSeconds: audioSecondsForBilling,
    // Billed on the final (post-polish) word count so the dashboard shows
    // what the user actually got. Billing math itself is duration × rate.
    wordCount: wordCount(finalText),
    polishApplied,
    processingMs,
  });
  const debitAt = Date.now() - startedAt;

  const base = {
    finalText,
    rawText,
    audioSeconds,
    polishApplied,
    polishErrorReason,
    audioMs,
    processingMs,
    timings: { polish: polishAt, debit: debitAt },
  };

  if (debit.kind === "insufficient") {
    return {
      ...base,
      debitKind: "insufficient",
      balanceMillicents: debit.balanceMillicents,
      upstreamMc: 0,
      retailMc: 0,
    };
  }

  if (debit.kind === "duplicate") {
    // Idempotent replay — keep cost fields at 0 as the batch route did
    // (it returned before computing costs on the duplicate branch).
    return {
      ...base,
      debitKind: "duplicate",
      usageEventId: debit.usageEventId,
      upstreamMc: 0,
      retailMc: 0,
    };
  }

  // ok — compute cost for analytics.
  let upstreamMc = 0;
  let retailMc = 0;
  const pricing = await getProviderPricing(providerId, model);
  if (pricing) {
    const costs = computeCost(pricing, audioSecondsForBilling);
    upstreamMc = costs.upstreamMc;
    retailMc = costs.retailMc;
  }

  return {
    ...base,
    debitKind: "ok",
    usageEventId: debit.usageEventId,
    newBalanceMillicents: debit.newBalanceMillicents,
    autoTopupTriggered: debit.autoTopupTriggered,
    upstreamMc,
    retailMc,
  };
}
