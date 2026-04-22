// POST /api/transcribe — Phase A of the Worker-proxied transcription rollout.
//
// Replaces the old (mint Deepgram token → Mac POSTs to Deepgram → separate
// /api/usage call) flow. The Mac now:
//   1. POSTs audio bytes directly to this endpoint
//   2. We forward to the chosen provider (Phase A: Deepgram only)
//   3. We debit credits inline from the provider-reported audio duration
//   4. We return { text, audioSeconds, usageEventId, newBalanceMillicents }
//
// Request:
//   POST /api/transcribe
//   Authorization: Bearer <mac-session-token>
//   Content-Type: audio/wav   (or audio/mpeg / audio/ogg — passed through
//                              to the provider verbatim)
//   X-Transcription-Id: <uuid>         required — dedup key
//   X-Provider-Hint: deepgram          Phase A: only "deepgram" allowed
//   X-Model-Hint: nova-3 | nova-2      default "nova-3"
//   X-Language: en                     optional (ISO code)
//   X-Keyterms: term1,term2            optional, comma-separated
//   X-Replace: find1:rep1;find2:rep2   optional, semicolon-separated pairs
//   X-Dictation: true|false
//   X-Filler-Words: true|false
//   X-Measurements: true|false
//   X-Profanity-Filter: true|false
//   X-Detect-Language: true|false
//   X-Audio-Ms: 2345                   Mac-side duration hint, fallback only
//   Body: raw audio bytes
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
import { runPolish } from "@/lib/transcription/polish";
import { checkOrgModelAccess } from "@/lib/transcription/orgAccess";
import { isProviderId, type ProviderId, type TranscriptionInput } from "@/lib/transcription/types";

/** Workers' default request-body cap is generous; we enforce a sensible
 *  one to keep audio from blowing past reasonable batch-transcription
 *  durations. 16 kHz mono Int16 WAV ≈ 32 KB/s → 100 MB ≈ 53 min, well
 *  above our current 5-min recording cap. */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const { env } = await getCloudflareContext({ async: true });

  // Defaults for the analytics log so we always emit one event per request.
  let orgId = "unknown";
  let providerId: ProviderId = "deepgram";
  let model = "nova-3";
  let audioMs = 0;
  let upstreamMc = 0;
  let retailMc = 0;
  let upstreamStatus = 0;

  function finish(
    status: Parameters<typeof logTranscriptionEvent>[1]["status"],
    response: Response
  ): Response {
    logTranscriptionEvent(env as unknown as Parameters<typeof logTranscriptionEvent>[0], {
      providerId,
      model,
      status,
      orgId,
      audioMs,
      upstreamMc,
      retailMc,
      latencyMs: Date.now() - startedAt,
      upstreamStatus,
    });
    return response;
  }

  // ---- auth + org ---------------------------------------------------------
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    const status = err instanceof AuthzError ? err.status : 401;
    return finish("invalid_input", json({ error: "unauthorized" }, status));
  }

  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    return finish("invalid_input", json({ error: "no_org" }, 400));
  }
  orgId = org.id;

  // ---- header parsing -----------------------------------------------------
  const transcriptionClientId = req.headers.get("X-Transcription-Id");
  if (!transcriptionClientId || transcriptionClientId.length < 8) {
    return finish("invalid_input", json({ error: "missing_or_short_X-Transcription-Id" }, 400));
  }

  const providerHint = (req.headers.get("X-Provider-Hint") ?? "deepgram").toLowerCase();
  if (!isProviderId(providerHint)) {
    return finish(
      "invalid_input",
      json({ error: "bad_provider", allowed: ["deepgram", "groq"] }, 400)
    );
  }
  providerId = providerHint;

  model = (req.headers.get("X-Model-Hint") ?? "nova-3").trim();
  if (model.length === 0) model = "nova-3";

  // ---- org allowed-models gate -------------------------------------------
  const access = await checkOrgModelAccess(org.id, providerId, model);
  if (!access.allowed) {
    return finish(
      "invalid_input",
      json(
        {
          error: "model_not_allowed",
          detail: access.reason,
          allowed: access.allowedSlugs ?? [],
        },
        403
      )
    );
  }

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

  // ---- dispatch to provider ----------------------------------------------
  const input: TranscriptionInput = {
    providerId,
    model,
    audioBody,
    audioContentType: req.headers.get("Content-Type") ?? "audio/wav",
    transcriptionClientId,
    language: req.headers.get("X-Language") ?? undefined,
    keyterms: splitCsv(req.headers.get("X-Keyterms")),
    replaceRules: splitReplace(req.headers.get("X-Replace")),
    dictation: boolHeader(req.headers.get("X-Dictation")),
    fillerWords: boolHeader(req.headers.get("X-Filler-Words")),
    measurements: boolHeader(req.headers.get("X-Measurements")),
    profanityFilter: boolHeader(req.headers.get("X-Profanity-Filter")),
    detectLanguage: boolHeader(req.headers.get("X-Detect-Language")),
    audioMsHint: parseInt(req.headers.get("X-Audio-Ms") ?? "0", 10) || undefined,
  };

  let output;
  try {
    output = await dispatch(
      env as unknown as Parameters<typeof dispatch>[0],
      org.id,
      input
    );
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
  // Load the user's polish prefs (cheap single-row read). Polish runs
  // synchronously so the returned `text` is already polished; cost is
  // absorbed (not billed) in Phase 1 since per-transcription polish is
  // ~$0.0001 vs ~$0.01 transcription.
  let finalText = output.text;
  let polishApplied = false;
  try {
    const db = getDb();
    const [userPrefs] = await db
      .select({
        polishEnabled: users.polishEnabled,
        polishSystemPrompt: users.polishSystemPrompt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (userPrefs?.polishEnabled && output.text.trim().length > 0) {
      const polish = await runPolish(
        env as unknown as Parameters<typeof runPolish>[0],
        org.id,
        output.text,
        userPrefs.polishSystemPrompt
      );
      // Metadata-only log (no content) so operators can confirm in
      // `pnpm dev` / tail logs that the right prompt variant ran +
      // whether the model output changed length unexpectedly.
      console.info(
        `[transcribe] polish ${polish.applied ? "applied" : "skipped"} ` +
          `prompt=${userPrefs.polishSystemPrompt ? "custom" : "default"} ` +
          `inChars=${output.text.length} outChars=${polish.text.length} ` +
          `tokens=${polish.promptTokens}/${polish.completionTokens} ` +
          `latencyMs=${polish.latencyMs}` +
          (polish.errorReason ? ` reason=${polish.errorReason}` : "")
      );
      if (polish.applied) {
        finalText = polish.text;
        polishApplied = true;
      }
    }
  } catch (err) {
    // Polish errors never block transcription — fall through with raw text.
    console.warn("[transcribe] polish threw:", err);
  }

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

  if (debit.kind === "duplicate") {
    // Idempotent replay — return the transcript we already have from this
    // call (not from the stored row; we never persist transcript text).
    return finish("ok", json({
      text: finalText,
      audioSeconds: output.audioSeconds,
      provider: providerId,
      model,
      polishApplied,
      usageEventId: debit.usageEventId,
      duplicate: true,
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
    audioSeconds: output.audioSeconds,
    provider: providerId,
    model,
    polishApplied,
    usageEventId: debit.usageEventId,
    newBalanceMillicents: debit.newBalanceMillicents,
    autoTopupTriggered: debit.autoTopupTriggered,
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
