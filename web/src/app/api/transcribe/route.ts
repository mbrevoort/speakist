// POST /api/transcribe — Worker-proxied transcription endpoint.
//
// Mac and iOS clients:
//   1. POST audio bytes here
//   2. Worker resolves (provider, model) from the user's language and
//      the org's allowed-models list (super admin → Org page)
//   3. Worker forwards to the chosen provider
//   4. Worker debits credits from the provider-reported audio duration
//   5. Worker returns { text, audioSeconds, usageEventId, newBalanceMillicents }
//
// Routing rules (no client knobs):
//   * English (X-Language ~ /^en/) → Groq Whisper Turbo
//   * anything else → Groq Whisper Large (multilingual)
//   * org's `allowed_models_json` whitelist overrides: if it's set and
//     the language default isn't in it, the first allowed entry wins.
//     Super admins use this to pin specific orgs to Deepgram.
//
// Request:
//   POST /api/transcribe
//   Authorization: Bearer <session-token>
//   Content-Type: audio/wav   (or audio/mpeg / audio/ogg — passed through
//                              to the provider verbatim)
//   X-Transcription-Id: <uuid>         required — dedup key
//   X-Language: en                     optional (ISO code, drives routing)
//   X-Detect-Language: true|false      optional, treated as "non-English"
//                                       so multilingual model is picked
//   X-Keyterms: term1,term2            optional, comma-separated
//   X-Replace: find1:rep1;find2:rep2   optional, semicolon-separated pairs
//   X-Dictation: true|false
//   X-Filler-Words: true|false
//   X-Measurements: true|false
//   X-Profanity-Filter: true|false
//   X-Audio-Ms: 2345                   Mac-side duration hint, fallback only
//   Body: raw audio bytes
//
// Headers `X-Provider-Hint` / `X-Model-Hint` from older clients are
// silently ignored — left in place for tolerance, not honored.
//
// Response (JSON):
//   200 { text, audioSeconds, provider, model, usageEventId, newBalanceMillicents, autoTopupTriggered }
//   400 { error }                ← missing X-Transcription-Id, bad provider, etc.
//   401 { error }                ← auth
//   402 { error, balanceMillicents } ← insufficient credit
//   413 { error }                ← body too large
//   502 { error, detail? }       ← upstream auth / error
//   504 { error }                ← upstream timeout
//
// Analytics: every request (success or failure) writes one event to the
// `TRANSCRIPTION_EVENTS` Workers Analytics Engine dataset; see
// web/src/lib/transcription/analytics.ts.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { debitForAudioTranscription } from "@/lib/credits";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { dispatch, TranscriptionDispatchError } from "@/lib/transcription";
import { logTranscriptionEvent } from "@/lib/transcription/analytics";
import { runPolish, POLISH_MODEL } from "@/lib/transcription/polish";
import { resolveProviderForOrg } from "@/lib/transcription/orgAccess";
import { type ProviderId, type TranscriptionInput } from "@/lib/transcription/types";
import { captureAIGeneration, captureServerEvent } from "@/lib/posthog/server";

/** Workers' default request-body cap is generous; we enforce a sensible
 *  one to keep audio from blowing past reasonable batch-transcription
 *  durations. 16 kHz mono Int16 WAV ≈ 32 KB/s → 100 MB ≈ 53 min, well
 *  above our current 5-min recording cap. */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const { env } = await getCloudflareContext({ async: true });

  // Per-stage wall-clock breakdown returned to the client in every
  // success response under `timings`. Lets the Mac log a unified
  // network-vs-worker-vs-upstream picture without having to scrape
  // analytics. Numbers are ms relative to `startedAt`; cumulative,
  // not deltas, so order-of-events is recoverable from the log.
  const timings: Record<string, number> = {};
  const mark = (label: string): void => {
    timings[label] = Date.now() - startedAt;
  };

  // Defaults for the analytics log so we always emit one event per request.
  // Routing is decided server-side now (was: client X-Provider-Hint
  // headers), so we initialize to the most common default — English →
  // Groq Whisper Turbo. Reassigned post-resolution before any real work.
  let orgId = "unknown";
  let providerId: ProviderId = "groq";
  let model = "whisper-large-v3-turbo";
  let audioMs = 0;
  let upstreamMc = 0;
  let retailMc = 0;
  let upstreamStatus = 0;

  function finish(
    status: Parameters<typeof logTranscriptionEvent>[1]["status"],
    response: Response
  ): Response {
    const totalLatencyMs = Date.now() - startedAt;
    logTranscriptionEvent(env as unknown as Parameters<typeof logTranscriptionEvent>[0], {
      providerId,
      model,
      status,
      orgId,
      audioMs,
      upstreamMc,
      retailMc,
      latencyMs: totalLatencyMs,
      upstreamStatus,
    });
    // Mirror to PostHog as a product event so the LLM Analytics dashboard
    // shows transcription alongside polish. distinctId falls back to
    // orgId when the request didn't authenticate (we still want to see
    // unauth failures bucketed by status). No-op when key isn't set.
    captureServerEvent({
      distinctId: posthogDistinctId ?? orgId,
      event:
        status === "ok"
          ? "transcription_completed"
          : "transcription_failed",
      groups: orgId !== "unknown" ? { organization: orgId } : undefined,
      properties: {
        provider: providerId,
        model,
        status,
        audio_ms: audioMs,
        latency_ms: totalLatencyMs,
        upstream_status: upstreamStatus,
        upstream_millicents: upstreamMc,
        retail_millicents: retailMc,
      },
    });
    return response;
  }

  // distinctId for PostHog is the user.id once auth resolves; before that
  // we'll fall back to orgId (set inside finish()).
  let posthogDistinctId: string | undefined;

  // ---- auth + org ---------------------------------------------------------
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    const status = err instanceof AuthzError ? err.status : 401;
    return finish("invalid_input", json({ error: "unauthorized" }, status));
  }

  posthogDistinctId = user.id;

  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    return finish("invalid_input", json({ error: "no_org" }, 400));
  }
  orgId = org.id;
  mark("auth");

  // ---- header parsing -----------------------------------------------------
  const transcriptionClientId = req.headers.get("X-Transcription-Id");
  if (!transcriptionClientId || transcriptionClientId.length < 8) {
    return finish("invalid_input", json({ error: "missing_or_short_X-Transcription-Id" }, 400));
  }

  // ---- provider/model resolution -----------------------------------------
  // Server picks the (provider, model) — the Mac/iOS clients only send
  // the user's chosen language. Routing rules:
  //
  //   1. Default by language: English → Groq Whisper Turbo (fastest);
  //      anything else → Groq Whisper Large (multilingual). Auto-detect
  //      counts as "anything else" since the actual language is unknown.
  //   2. Org's `allowed_models_json` whitelist (super admin → Org page)
  //      acts as both a guard and an override knob: if non-empty and the
  //      language default isn't in it, we use the first allowed entry
  //      instead. This is how a super admin pins a specific org to e.g.
  //      DeepGram nova-3 even though the language-based default is Groq.
  //
  // X-Provider-Hint / X-Model-Hint headers from older client builds are
  // intentionally ignored — clients no longer choose, the server does.
  const language = req.headers.get("X-Language");
  const detectLanguage = boolHeader(req.headers.get("X-Detect-Language"));
  const resolved = await resolveProviderForOrg(org.id, {
    language,
    detectLanguage,
  });
  providerId = resolved.providerId;
  model = resolved.model;

  // ---- balance gate (comped orgs bypass) ---------------------------------
  if (!org.isComped) {
    // Cheap pre-check so empty-wallet users don't rack up an upstream call
    // before the debit catches it. The real idempotent guard is in
    // debitForAudioTranscription.
    const { getOrgCreditBalance } = await import("@/lib/orgs");
    const balance = await getOrgCreditBalance(org.id);
    if (balance <= 0) {
      return finish(
        "insufficient_credit",
        json({ error: "insufficient_credit", balanceMillicents: balance }, 402)
      );
    }
  }

  // ---- body size + fetch --------------------------------------------------
  const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return finish("invalid_input", json({ error: "body_too_large", limitBytes: MAX_BODY_BYTES }, 413));
  }

  const audioBody = await req.arrayBuffer();
  if (audioBody.byteLength === 0) {
    return finish("invalid_input", json({ error: "empty_body" }, 400));
  }
  if (audioBody.byteLength > MAX_BODY_BYTES) {
    return finish("invalid_input", json({ error: "body_too_large", limitBytes: MAX_BODY_BYTES }, 413));
  }
  mark("body");

  // ---- dispatch to provider ----------------------------------------------
  const input: TranscriptionInput = {
    providerId,
    model,
    audioBody,
    audioContentType: req.headers.get("Content-Type") ?? "audio/wav",
    transcriptionClientId,
    language: language ?? undefined,
    keyterms: splitCsv(req.headers.get("X-Keyterms")),
    replaceRules: splitReplace(req.headers.get("X-Replace")),
    dictation: boolHeader(req.headers.get("X-Dictation")),
    fillerWords: boolHeader(req.headers.get("X-Filler-Words")),
    measurements: boolHeader(req.headers.get("X-Measurements")),
    profanityFilter: boolHeader(req.headers.get("X-Profanity-Filter")),
    detectLanguage,
    audioMsHint: parseInt(req.headers.get("X-Audio-Ms") ?? "0", 10) || undefined,
  };

  // Kick off the user's polish prefs read in parallel with the upstream
  // STT dispatch. The prefs lookup takes ~100ms (a single D1 row read);
  // the STT call is 250–500ms. Running them concurrently shaves the
  // smaller of the two off the critical path — meaningfully so on
  // short transcripts where STT is fast enough that the prefs read
  // would otherwise be the dominant pre-polish step. We tolerate a
  // failed prefs read (skips polish) so transcription itself never
  // breaks because of the prefs query.
  type PolishPrefs = { polishEnabled: boolean; polishMode: string | null };
  const polishPrefsPromise: Promise<PolishPrefs | null> = (async () => {
    try {
      const db = getDb();
      const [row] = await db
        .select({
          polishEnabled: users.polishEnabled,
          polishMode: users.polishMode,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      return (row as PolishPrefs | undefined) ?? null;
    } catch (err) {
      console.warn("[transcribe] polish prefs read failed:", err);
      return null;
    }
  })();

  let output;
  try {
    output = await dispatch(
      env as unknown as Parameters<typeof dispatch>[0],
      org.id,
      input
    );
    mark("upstream");
  } catch (err) {
    if (err instanceof TranscriptionDispatchError) {
      upstreamStatus = err.upstreamStatus ?? 0;
      const httpStatus = mapDispatchErrorStatus(err.kind);
      console.warn(`[transcribe] ${err.kind}: ${err.detail}`);
      return finish(
        err.kind,
        json({ error: err.kind, detail: err.detail }, httpStatus)
      );
    }
    console.error("[transcribe] unexpected error:", err);
    return finish(
      "internal_error",
      json({ error: "internal_error", detail: err instanceof Error ? err.message : String(err) }, 500)
    );
  }

  upstreamStatus = output.upstreamStatus;
  audioMs = Math.round(output.audioSeconds * 1000);
  // If the provider didn't report a duration (audioSeconds = 0), fall back
  // to the Mac-provided hint so we still debit something proportional.
  const audioSecondsForBilling =
    output.audioSeconds > 0
      ? output.audioSeconds
      : input.audioMsHint
      ? input.audioMsHint / 1000
      : 0;

  // ---- optional polish pass -----------------------------------------------
  // Load the user's polish prefs (kicked off in parallel above so this
  // await is mostly already-resolved). Polish runs synchronously so the
  // returned `text` is already polished — UNLESS the client opts in to
  // "fast mode" by sending `X-Polish-Skip: true`, in which case we
  // return the raw transcript immediately and skip polish entirely.
  // Cost is absorbed (not billed) in Phase 1 since per-transcription
  // polish is ~$0.0001 vs ~$0.01 transcription.
  let finalText = output.text;
  let polishApplied = false;
  let polishErrorReason: string | undefined;
  const polishSkipRequested = boolHeader(req.headers.get("X-Polish-Skip"));
  try {
    const userPrefs = await polishPrefsPromise;
    if (userPrefs?.polishEnabled && output.text.trim().length > 0 && !polishSkipRequested) {
      const polish = await runPolish(
        env as unknown as Parameters<typeof runPolish>[0],
        org.id,
        output.text,
        (userPrefs.polishMode as "intuitive" | "prescriptive") ?? "prescriptive"
      );
      // Metadata-only log (no content) so operators can confirm in
      // `pnpm dev` / tail logs that the right prompt variant ran +
      // whether the model output changed length unexpectedly.
      console.info(
        `[transcribe] polish ${polish.applied ? "applied" : "skipped"} ` +
          `mode=${userPrefs.polishMode} ` +
          `inChars=${output.text.length} outChars=${polish.text.length} ` +
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
      // PostHog LLM Analytics — surfaces in the LLM dashboard with
      // model/provider/token/latency/cost rollups. Trace ID = the
      // X-Transcription-Id so downstream correlation against the
      // transcription_completed event is one filter away.
      captureAIGeneration({
        distinctId: user.id,
        traceId: transcriptionClientId,
        provider: "groq",
        model: POLISH_MODEL,
        inputTokens: polish.promptTokens,
        outputTokens: polish.completionTokens,
        latencySeconds: polish.latencyMs / 1000,
        httpStatus: polish.applied ? 200 : 0,
        isError: !polish.applied,
        groups: { organization: org.id },
        extra: {
          polish_mode: userPrefs.polishMode,
          polish_applied: polish.applied,
          polish_error_reason: polish.errorReason,
          input_chars: output.text.length,
          output_chars: polish.text.length,
        },
      });
    } else if (polishSkipRequested && userPrefs?.polishEnabled) {
      polishErrorReason = "skipped_by_client";
    }
  } catch (err) {
    // Polish errors never block transcription — fall through with raw text.
    console.warn("[transcribe] polish threw:", err);
    polishErrorReason = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  mark("polish");

  // ---- debit --------------------------------------------------------------
  // processingMs = wall-clock from request start to this point. Captures
  // upstream STT fetch + optional polish call + validation. Storing it
  // gives the dashboard a real latency signal independent of audio length.
  const processingMs = Date.now() - startedAt;
  const debit = await debitForAudioTranscription({
    orgId: org.id,
    userId: user.id,
    transcriptionClientId,
    providerId,
    model,
    audioSeconds: audioSecondsForBilling,
    // Billed on the final (post-polish) word count so users see what they
    // actually got, not a pre-edit estimate. Note: billing math is driven
    // by audio duration × per-minute rate inside debitForAudioTranscription;
    // wordCount is stored on the row purely for the dashboard display.
    wordCount: wordCount(finalText),
    polishApplied,
    processingMs,
  });
  mark("debit");

  if (debit.kind === "duplicate") {
    // Idempotent replay — return the transcript we already have from this
    // call (not from the stored row; we never persist transcript text).
    return finish("ok", json({
      text: finalText,
      audioSeconds: output.audioSeconds,
      provider: providerId,
      model,
      polishApplied,
      polishErrorReason,
      usageEventId: debit.usageEventId,
      duplicate: true,
      timings: { ...timings, total: Date.now() - startedAt },
    }));
  }
  if (debit.kind === "insufficient") {
    // Should be rare given the pre-check above, but possible if balance
    // raced. Treat as 402 — the transcript is effectively lost because we
    // already pasted headers back; Mac won't see the text.
    return finish(
      "insufficient_credit",
      json({ error: "insufficient_credit", balanceMillicents: debit.balanceMillicents }, 402)
    );
  }

  // Compute analytics cost post-debit (pricing lookup already happened
  // inside debitForAudioTranscription; recompute here keeps that function
  // pure about its return shape). Cheap cached read.
  const { getProviderPricing, computeCost } = await import("@/lib/transcription/pricing");
  const pricing = await getProviderPricing(providerId, model);
  if (pricing) {
    const costs = computeCost(pricing, audioSecondsForBilling);
    upstreamMc = costs.upstreamMc;
    retailMc = costs.retailMc;
  }

  return finish("ok", json({
    text: finalText,
    // Pre-polish STT output. Always populated, even when polish is
    // disabled or skipped (in which case rawText === text). Clients
    // persist this on the history row so a later "Report bad
    // transcription" submission carries the actual upstream STT
    // string, not the polished version — that's what the evaluation
    // pipeline needs to distinguish STT-side vs polish-side bugs.
    rawText: output.text,
    audioSeconds: output.audioSeconds,
    provider: providerId,
    model,
    polishApplied,
    // Set when polish ran but the result wasn't used — surfaces the
    // failure mode to the client so the Mac log shows e.g.
    // `rejected: output_too_long` or `assistant_preamble: starts with
    // "here is"`. Helps debug why polishApplied=false when the user
    // expected it to be true.
    polishErrorReason,
    usageEventId: debit.usageEventId,
    newBalanceMillicents: debit.newBalanceMillicents,
    autoTopupTriggered: debit.autoTopupTriggered,
    // Per-stage cumulative ms relative to request start. `auth` is the
    // user/org lookup, `body` adds reading the audio bytes off the wire,
    // `upstream` adds the STT provider round-trip, `polish` adds the
    // optional LLM pass (==`upstream` if polish was skipped), `debit`
    // adds the credit-ledger write, `total` is end-to-end Worker time.
    // Compute deltas client-side: e.g. upstream cost = upstream - body.
    timings: { ...timings, total: Date.now() - startedAt },
  }));
}

// ---- helpers --------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function boolHeader(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return v.toLowerCase() === "true" || v === "1";
}

function splitCsv(v: string | null): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function splitReplace(v: string | null): string[] | undefined {
  if (!v) return undefined;
  return v.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Map a dispatch error kind to an HTTP status code. */
function mapDispatchErrorStatus(
  kind: TranscriptionDispatchError["kind"]
): number {
  switch (kind) {
    case "invalid_input":
    case "unsupported_model":
      return 400;
    case "no_key_configured":
      return 500;
    case "upstream_auth":
    case "upstream_error":
      return 502;
    case "upstream_timeout":
      return 504;
  }
}
