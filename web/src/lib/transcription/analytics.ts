// Workers Analytics Engine helper for per-transcription metrics.
//
// One event per call to /api/transcribe, regardless of outcome. Queryable
// from the Cloudflare dashboard via SQL against the dataset configured in
// wrangler.toml (`speakist_transcription_dev` / `_prod`).
//
// Shape of an AE data point:
//   blobs   — up to 20 strings; we use 1–4 for categorical fields
//   doubles — up to 20 numbers; we use 1–4 for counts/latencies
//   indexes — one indexed string; we use orgId so per-org queries are fast
//
// AE is sample-based and fast to write (sub-ms), safe to call on the hot
// path. If the binding is missing (e.g. local test without wrangler.toml
// updated), the helper no-ops rather than throwing.

import type { ProviderId } from "./types";

export type TranscriptionEventStatus =
  | "ok"
  | "upstream_auth"
  | "upstream_timeout"
  | "upstream_error"
  | "invalid_input"
  | "insufficient_credit"
  | "no_key_configured"
  | "unsupported_model"
  | "internal_error";

export interface TranscriptionEventPayload {
  providerId: ProviderId;
  model: string;
  status: TranscriptionEventStatus;
  orgId: string;
  /** Audio duration reported by the provider (ms). 0 if we never got that far. */
  audioMs: number;
  /** What we paid the provider (millicents). 0 on any non-ok status. */
  upstreamMc: number;
  /** What we charged the org (millicents). 0 on any non-ok status. */
  retailMc: number;
  /** Wall-clock latency of the whole /api/transcribe request (ms). */
  latencyMs: number;
  /** Upstream HTTP status if we got a response; 0 otherwise. */
  upstreamStatus: number;
}

/**
 * Minimal interface of the Workers Analytics Engine binding. We define it
 * locally (instead of relying on @cloudflare/workers-types ambient) so the
 * file compiles in any context.
 */
interface AnalyticsEngineBinding {
  writeDataPoint(event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

interface EnvWithAnalytics {
  TRANSCRIPTION_EVENTS?: AnalyticsEngineBinding;
}

export function logTranscriptionEvent(
  env: EnvWithAnalytics,
  payload: TranscriptionEventPayload
): void {
  const sink = env.TRANSCRIPTION_EVENTS;
  if (!sink) return;
  try {
    sink.writeDataPoint({
      blobs: [payload.providerId, payload.model, payload.status, payload.orgId],
      doubles: [
        payload.audioMs,
        payload.upstreamMc,
        payload.retailMc,
        payload.latencyMs,
        payload.upstreamStatus,
      ],
      indexes: [payload.orgId],
    });
  } catch (err) {
    // Never throw out of analytics — observability must not break requests.
    console.warn("[analytics] writeDataPoint failed:", err);
  }
}
