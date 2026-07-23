// Real-time streaming transcription proxy: Mac ↔ Worker ↔ Deepgram.
//
// The Mac opens a WebSocket to `/api/transcribe/ws`, streams 16 kHz mono
// linear16 PCM frames as the user speaks, and the Worker relays them to
// Deepgram's live `/v1/listen` socket. Interim + final transcripts flow
// back for a live HUD; when the Mac finishes (closes the socket or sends
// `{"type":"CloseStream"}`), Deepgram flushes its final results and we run
// the SAME polish + debit tail as the batch route (`finalizeTranscription`)
// before sending a terminal `{type:"result"}` message and closing.
//
// This preserves the proxy model: the Deepgram key never leaves the
// Worker, billing is server-authoritative from Deepgram's reported audio
// duration, and no audio or transcript is persisted.
//
// NOTE: this module is reached from the custom Worker entrypoint
// (`web/worker.ts`) BEFORE OpenNext establishes its request context, so we
// set the `__cloudflare-context__` global ourselves (see below) — that's
// what `getDb()` reads.

import { requireUserFromRequest, type AuthedUser } from "@/lib/authz";
import { extractBearer } from "@/lib/bearer";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { resolveProviderForOrg } from "@/lib/transcription/orgAccess";
import { resolveProviderKey, type ProviderKeyEnv } from "@/lib/transcription/secrets";
import { buildDeepgramQuery } from "@/lib/transcription/adapters/deepgram";
import { finalizeTranscription, readPolishPrefs } from "@/lib/transcription/finalize";
import {
  logTranscriptionEvent,
  type TranscriptionEventStatus,
} from "@/lib/transcription/analytics";
import { captureServerEvent } from "@/lib/posthog/server";

const DEEPGRAM_STREAM_URL = "https://api.deepgram.com/v1/listen";

/** Minimal surface of the Cloudflare-runtime WebSocket we use. Declared
 *  locally because the project's tsconfig mixes DOM + workers-types libs;
 *  this keeps the relay code unambiguous. */
interface CfWebSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    handler: (event: { data?: string | ArrayBuffer; code?: number; reason?: string }) => void
  ): void;
}

/** The bit of ExecutionContext we need — keeps the isolate alive while the
 *  socket is open and while the async finalize runs after it closes. */
interface StreamCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/** Runs `fn` inside the OpenNext Cloudflare request context so `getDb()`
 *  (and everything under it) resolves the D1 binding. Supplied by
 *  `worker.ts`, which owns the OpenNext-internal import. We need it not
 *  just for the initial handler run but for the finalize work that fires
 *  in a later socket-close callback — outside the original context. */
export type RunInContext = <T>(fn: () => Promise<T>) => Promise<T>;

function csv(v: string | null): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function semicolons(v: string | null): string[] | undefined {
  if (!v) return undefined;
  return v.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Authenticate a WebSocket upgrade. The Mac sets `Authorization: Bearer
 *  <token>` on the upgrade request and Cloudflare preserves upgrade-request
 *  headers, so we require the header here. We deliberately do NOT accept the
 *  token in the query string: the Mac's bearer is a long-lived refresh
 *  token, and query strings leak into Worker logs, Cloudflare observability,
 *  and any intermediary. If a query-string path is ever needed (e.g. a
 *  browser client), mint a short-lived single-use ticket via an
 *  authenticated POST and accept only that — never the raw bearer. */
async function authWs(request: Request): Promise<AuthedUser | null> {
  const token = extractBearer(request);
  if (!token) return null;
  // Reuse the exact bearer→user lookup the batch route uses. `request`
  // already carries the Authorization header; requireUserFromRequest tries
  // bearer first, so it never reaches cookie auth here.
  try {
    return await requireUserFromRequest(request);
  } catch {
    return null;
  }
}

/**
 * Handle a `/api/transcribe/ws` upgrade. Returns a non-101 HTTP Response to
 * reject before upgrading (the Mac treats any non-101 as "fall back to the
 * batch upload"), or a 101 Response carrying the client socket on success.
 */
export async function handleTranscribeStream(
  request: Request,
  env: ProviderKeyEnv,
  ctx: StreamCtx,
  runInContext: RunInContext
): Promise<Response> {
  // Note: this is already invoked inside `runInContext` by worker.ts, so
  // getDb() works for the synchronous setup below. The finalize work runs
  // later (socket-close callback) and re-enters via `runInContext`.
  try {
    return await handleTranscribeStreamInner(request, env, ctx, runInContext);
  } catch (err) {
    console.error(
      "[transcribe/ws] uncaught:",
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
    );
    return new Response("stream_internal_error", { status: 500 });
  }
}

async function handleTranscribeStreamInner(
  request: Request,
  env: ProviderKeyEnv,
  ctx: StreamCtx,
  runInContext: RunInContext
): Promise<Response> {
  // ---- auth + org ---------------------------------------------------------
  const user = await authWs(request);
  if (!user) return new Response("unauthorized", { status: 401 });

  const org = await getCurrentOrgForUser(user.id);
  if (!org) return new Response("no_org", { status: 400 });

  if (!org.isComped) {
    const balance = await getOrgCreditBalance(org.id);
    if (balance <= 0) return new Response("insufficient_credit", { status: 402 });
  }

  // ---- request params (sent as query on the wss URL) ----------------------
  const p = new URL(request.url).searchParams;
  const transcriptionClientId = p.get("tid") ?? "";
  if (transcriptionClientId.length < 8) {
    return new Response("missing_or_short_tid", { status: 400 });
  }
  const language = p.get("language") ?? undefined;
  const detectLanguage = p.get("detect_language") === "true";
  const audioMsHint = parseInt(p.get("audio_ms") ?? "0", 10) || undefined;
  const polishSkip = p.get("polish_skip") === "true";

  // ---- provider/model + key ----------------------------------------------
  const resolved = await resolveProviderForOrg(org.id, { language, detectLanguage });
  if (resolved.providerId !== "deepgram") {
    // Org is pinned to a non-streaming provider (e.g. Groq). Reject so the
    // Mac falls back to the batch upload, which routes correctly.
    return new Response("streaming_unsupported_provider", { status: 409 });
  }
  const model = resolved.model;

  let apiKey: string;
  try {
    apiKey = await resolveProviderKey(env, org.id, "deepgram");
  } catch {
    return new Response("no_key_configured", { status: 500 });
  }

  // ---- open the Deepgram live socket --------------------------------------
  const q = buildDeepgramQuery({
    model,
    dictation: p.get("dictation") === "true",
    fillerWords: p.get("filler_words") === "true",
    measurements: p.get("measurements") === "true",
    profanityFilter: p.get("profanity_filter") === "true",
    detectLanguage,
    language,
    keyterms: csv(p.get("keyterms")),
    replaceRules: semicolons(p.get("replace")),
  });
  // Streaming-only params: the Mac sends raw 16 kHz mono linear16 PCM, and
  // we want interim results for the live HUD.
  q.set("encoding", "linear16");
  q.set("sample_rate", "16000");
  q.set("channels", "1");
  q.set("interim_results", "true");

  let deepgram: CfWebSocket | null = null;
  try {
    const dgResp = await fetch(`${DEEPGRAM_STREAM_URL}?${q.toString()}`, {
      headers: { Upgrade: "websocket", Authorization: `Token ${apiKey}` },
    });
    deepgram =
      (dgResp as unknown as { webSocket?: CfWebSocket | null }).webSocket ?? null;
  } catch (err) {
    console.error("[transcribe/ws] deepgram connect failed:", err);
  }
  if (!deepgram) return new Response("deepgram_upgrade_failed", { status: 502 });
  const dg = deepgram;
  dg.accept();

  // Kick off the polish prefs read in parallel — resolved by the time the
  // user stops talking, so it's off the finalize critical path.
  const polishPrefsPromise = readPolishPrefs(user.id);

  // ---- wire the client socket + relay -------------------------------------
  const WsPair = (globalThis as unknown as {
    WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };
  }).WebSocketPair;
  const pair = new WsPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const startedAt = Date.now();
  const finalSegments: string[] = [];
  let durationSeconds = 0;

  // Mirror the batch route's per-transcription analytics (Workers Analytics
  // Engine + PostHog) so streaming shows up alongside batch. Emitted once,
  // at the terminal outcome in finalizeAndClose. `streaming: true` +
  // `latency_ms` here spans the whole recording (the socket opens at
  // record-start), unlike the batch route's release-to-done latency — so
  // don't compare the two latencies directly. Pre-upgrade rejections aren't
  // emitted here: they drive the Mac's batch fallback, which emits its own.
  const emitAnalytics = (
    status: TranscriptionEventStatus,
    opts: { audioMs?: number; upstreamMc?: number; retailMc?: number; upstreamStatus?: number } = {}
  ): void => {
    const latencyMs = Date.now() - startedAt;
    const audioMs = opts.audioMs ?? 0;
    logTranscriptionEvent(env as unknown as Parameters<typeof logTranscriptionEvent>[0], {
      providerId: "deepgram",
      model,
      status,
      orgId: org.id,
      audioMs,
      upstreamMc: opts.upstreamMc ?? 0,
      retailMc: opts.retailMc ?? 0,
      latencyMs,
      upstreamStatus: opts.upstreamStatus ?? 0,
    });
    captureServerEvent({
      distinctId: user.id,
      event: status === "ok" ? "transcription_completed" : "transcription_failed",
      groups: { organization: org.id },
      properties: {
        provider: "deepgram",
        model,
        status,
        audio_ms: audioMs,
        latency_ms: latencyMs,
        upstream_status: opts.upstreamStatus ?? 0,
        upstream_millicents: opts.upstreamMc ?? 0,
        retail_millicents: opts.retailMc ?? 0,
        streaming: true,
      },
    });
  };
  let finalized = false;

  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  const safeSend = (ws: CfWebSocket, data: string | ArrayBuffer): void => {
    try {
      ws.send(data);
    } catch {
      /* socket already closing/closed — drop */
    }
  };
  const safeClose = (ws: CfWebSocket, code = 1000, reason = ""): void => {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  async function finalizeAndClose(): Promise<void> {
    if (finalized) return;
    finalized = true;
    const rawText = finalSegments.join(" ").replace(/\s+/g, " ").trim();
    try {
      const result = await finalizeTranscription({
        env,
        orgId: org!.id,
        userId: user!.id,
        transcriptionClientId,
        providerId: "deepgram",
        model,
        rawText,
        audioSeconds: durationSeconds,
        audioMsHint,
        polishPrefs: await polishPrefsPromise,
        polishSkip,
        startedAt,
      });
      if (result.debitKind === "insufficient") {
        emitAnalytics("insufficient_credit", { audioMs: result.audioMs, upstreamStatus: 101 });
        safeSend(
          server,
          JSON.stringify({
            type: "error",
            error: "insufficient_credit",
            balanceMillicents: result.balanceMillicents,
          })
        );
      } else {
        emitAnalytics("ok", {
          audioMs: result.audioMs,
          upstreamMc: result.upstreamMc,
          retailMc: result.retailMc,
          upstreamStatus: 101,
        });
        safeSend(
          server,
          JSON.stringify({
            type: "result",
            text: result.finalText,
            rawText: result.rawText,
            audioSeconds: result.audioSeconds,
            provider: "deepgram",
            model,
            polishApplied: result.polishApplied,
            polishErrorReason: result.polishErrorReason,
            usageEventId: result.usageEventId,
            newBalanceMillicents: result.newBalanceMillicents,
            duplicate: result.debitKind === "duplicate",
          })
        );
      }
    } catch (err) {
      console.error("[transcribe/ws] finalize failed:", err);
      emitAnalytics("internal_error", { upstreamStatus: 101 });
      safeSend(server, JSON.stringify({ type: "error", error: "finalize_failed" }));
    } finally {
      safeClose(server);
      safeClose(dg);
      markDone();
    }
  }

  // client → Deepgram. Binary PCM frames arrive as an ArrayBuffer (workerd)
  // or a Blob (miniflare); a raw `dg.send(blob)` would stringify to
  // "[object Blob]" and Deepgram rejects it as a bad text message. So we
  // normalize to ArrayBuffer. Blob→ArrayBuffer is async, and audio order
  // matters (and the trailing CloseStream text must follow all audio), so
  // every forwarded frame goes through one ordered promise chain.
  let sendChain: Promise<void> = Promise.resolve();
  server.addEventListener("message", (event) => {
    const data = event.data as unknown;
    if (data === undefined || data === null) return;
    const payload: Promise<string | ArrayBuffer> =
      typeof data === "string"
        ? Promise.resolve(data)
        : data instanceof ArrayBuffer
          ? Promise.resolve(data)
          : (data as Blob).arrayBuffer();
    sendChain = sendChain
      .then(() => payload)
      .then((p) => safeSend(dg, p))
      .catch(() => {});
  });
  // Client finished talking — ask Deepgram to flush its final results, but
  // only after any still-in-flight audio has been forwarded (hence the
  // chain). We finalize when Deepgram then closes (or on its Metadata).
  const flushDeepgram = () => {
    sendChain = sendChain
      .then(() => safeSend(dg, JSON.stringify({ type: "CloseStream" })))
      .catch(() => {});
  };
  server.addEventListener("close", flushDeepgram);
  server.addEventListener("error", flushDeepgram);

  // Deepgram → client: relay transcripts for the live HUD, track finalized
  // segments + total audio duration for billing.
  dg.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data !== "string") return; // Deepgram emits JSON text frames
    let msg: DeepgramLiveMessage;
    try {
      msg = JSON.parse(data) as DeepgramLiveMessage;
    } catch {
      return;
    }
    if (msg.type === "Results") {
      const text = (msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
      const isFinal = msg.is_final === true;
      if (text.length > 0) {
        safeSend(server, JSON.stringify({ type: "transcript", isFinal, text }));
        if (isFinal) finalSegments.push(text);
      }
      // Segment start + length gives a running lower bound on total audio,
      // used only if a final Metadata duration never arrives.
      if (typeof msg.start === "number" && typeof msg.duration === "number") {
        durationSeconds = Math.max(durationSeconds, msg.start + msg.duration);
      }
    } else if (msg.type === "Metadata") {
      if (typeof msg.duration === "number") {
        durationSeconds = Math.max(durationSeconds, msg.duration);
      }
    }
  });
  // Finalize fires in a socket-close callback — outside the initial
  // request context — so re-enter it here for getDb() (debit) to work.
  dg.addEventListener("close", () => {
    ctx.waitUntil(runInContext(() => finalizeAndClose()));
  });
  dg.addEventListener("error", () => {
    ctx.waitUntil(runInContext(() => finalizeAndClose()));
  });

  // Keep the isolate alive for the life of the session + the finalize tail.
  ctx.waitUntil(done);

  return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
}

interface DeepgramLiveMessage {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string }[] };
}
