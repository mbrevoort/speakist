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
//   * default (every language) → Deepgram nova-3
//   * org's `allowed_models_json` whitelist overrides: if it's set and
//     the default isn't in it, the first allowed entry wins. Super admins
//     use this to pin specific orgs to e.g. Groq Whisper for cost.
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
import { dispatch, TranscriptionDispatchError } from "@/lib/transcription";
import { logTranscriptionEvent } from "@/lib/transcription/analytics";
import { resolveProviderForOrg } from "@/lib/transcription/orgAccess";
import { finalizeTranscription, readPolishPrefs } from "@/lib/transcription/finalize";
import { type ProviderId, type TranscriptionInput } from "@/lib/transcription/types";
import { captureServerEvent } from "@/lib/posthog/server";

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
  // headers), so we initialize to the global default — Deepgram nova-3.
  // Reassigned post-resolution before any real work.
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
  //   1. Global default: Deepgram nova-3 for every language (its
  //      multilingual model; the adapter forwards language/detect params).
  //   2. Org's `allowed_models_json` whitelist (super admin → Org page)
  //      acts as both a guard and an override knob: if non-empty and the
  //      default isn't in it, we use the first allowed entry instead. This
  //      is how a super admin pins a specific org to e.g. Groq Whisper.
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
  const polishPrefsPromise = readPolishPrefs(user.id);

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

  // ---- polish + debit + cost (shared with the streaming path) -------------
  // finalizeTranscription runs the optional polish pass, debits credits on
  // the idempotent (org, transcription id) key, and computes cost. Polish
  // is skipped when the client sends `X-Polish-Skip: true` (fast mode).
  const polishSkipRequested = boolHeader(req.headers.get("X-Polish-Skip")) ?? false;
  const result = await finalizeTranscription({
    env: env as unknown as Parameters<typeof finalizeTranscription>[0]["env"],
    orgId: org.id,
    userId: user.id,
    transcriptionClientId,
    providerId,
    model,
    rawText: output.text,
    audioSeconds: output.audioSeconds,
    audioMsHint: input.audioMsHint,
    polishPrefs: await polishPrefsPromise,
    polishSkip: polishSkipRequested,
    startedAt,
  });

  // Surface analytics fields captured inside finalize (0 on duplicate).
  audioMs = result.audioMs;
  upstreamMc = result.upstreamMc;
  retailMc = result.retailMc;
  timings.polish = result.timings.polish;
  timings.debit = result.timings.debit;

  if (result.debitKind === "insufficient") {
    // Should be rare given the pre-check above, but possible if balance
    // raced. Treat as 402 — the transcript is effectively lost.
    return finish(
      "insufficient_credit",
      json({ error: "insufficient_credit", balanceMillicents: result.balanceMillicents }, 402)
    );
  }

  if (result.debitKind === "duplicate") {
    // Idempotent replay — return the transcript we already have from this
    // call (not from the stored row; we never persist transcript text).
    return finish("ok", json({
      text: result.finalText,
      audioSeconds: result.audioSeconds,
      provider: providerId,
      model,
      polishApplied: result.polishApplied,
      polishErrorReason: result.polishErrorReason,
      usageEventId: result.usageEventId,
      duplicate: true,
      timings: { ...timings, total: Date.now() - startedAt },
    }));
  }

  return finish("ok", json({
    text: result.finalText,
    // Pre-polish STT output. Always populated, even when polish is
    // disabled or skipped (in which case rawText === text). Clients
    // persist this on the history row so a later "Report bad
    // transcription" submission carries the actual upstream STT
    // string, not the polished version — that's what the evaluation
    // pipeline needs to distinguish STT-side vs polish-side bugs.
    rawText: result.rawText,
    audioSeconds: result.audioSeconds,
    provider: providerId,
    model,
    polishApplied: result.polishApplied,
    // Set when polish ran but the result wasn't used — surfaces the
    // failure mode to the client so the Mac log shows e.g.
    // `rejected: output_too_long` or `assistant_preamble: starts with
    // "here is"`. Helps debug why polishApplied=false when the user
    // expected it to be true.
    polishErrorReason: result.polishErrorReason,
    usageEventId: result.usageEventId,
    newBalanceMillicents: result.newBalanceMillicents,
    autoTopupTriggered: result.autoTopupTriggered,
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
