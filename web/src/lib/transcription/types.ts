// Types shared across the transcription dispatch pipeline.
//
// The pipeline's job: take an audio stream + provider hints from the Mac,
// figure out which upstream provider to call, make one `fetch()`, and
// canonicalize the response into { text, audioSeconds }. Per-provider
// dialect (Deepgram's `keyterm=` vs OpenAI's `prompt=`, etc.) lives in
// the adapter, not here.
//
// Adding a new provider = new file under `adapters/`, new entry in the
// `PROVIDER_IDS` tuple, new rows in `provider_pricing`. The router doesn't
// need to change.

/** Canonical set of supported upstream providers. */
export const PROVIDER_IDS = ["deepgram", "groq", "openai", "xai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/**
 * Everything an adapter needs to build an upstream request.
 *
 * `audioBody` is the raw bytes — the Mac uploads a WAV body, we pass it
 * through without re-encoding. `audioContentType` preserves whatever
 * Content-Type the Mac sent (typically `audio/wav`) so the adapter can
 * forward it or wrap in multipart as needed.
 *
 * The STT-specific toggles (dictation, fillerWords, etc.) are all
 * Deepgram-flavored today. Other adapters map what's meaningful and
 * ignore the rest — they're not cross-provider-universal semantics, just
 * the set of knobs the Mac's Settings UI currently exposes.
 */
export interface TranscriptionInput {
  providerId: ProviderId;
  model: string;
  audioBody: ArrayBuffer;
  audioContentType: string;

  /** Client-generated UUID, used for dedup + Analytics Engine correlation. */
  transcriptionClientId: string;

  language?: string;
  keyterms?: string[];
  replaceRules?: string[]; // "find:replacement" pairs
  dictation?: boolean;
  fillerWords?: boolean;
  measurements?: boolean;
  profanityFilter?: boolean;
  detectLanguage?: boolean;

  /**
   * Mac-reported duration in milliseconds. Used only as a fallback for
   * cost computation when the provider response doesn't include a
   * duration; the provider's value is authoritative.
   */
  audioMsHint?: number;
}

/** What every adapter returns after parsing its upstream response. */
export interface TranscriptionOutput {
  text: string;
  audioSeconds: number;
}

/**
 * One adapter per upstream provider. Exports a pure function pair:
 * `buildRequest` creates the outbound `Request`, `parseResponse` decodes
 * the result. The dispatcher handles the actual fetch + error mapping
 * + analytics so adapters stay small and testable.
 */
export interface ProviderAdapter {
  id: ProviderId;
  /** Model slugs this adapter supports. Used for preflight validation. */
  readonly models: readonly string[];
  buildRequest(input: TranscriptionInput, apiKey: string): Request;
  parseResponse(res: Response): Promise<TranscriptionOutput>;
}

/**
 * Distinct failure modes, exposed to /api/transcribe so the route handler
 * can map them to specific HTTP status codes (401 vs 402 vs 502 vs 504).
 */
export class TranscriptionDispatchError extends Error {
  constructor(
    public readonly kind:
      | "upstream_auth"       // provider rejected our key → 502 + log + alert
      | "upstream_timeout"    // AbortSignal fired → 504
      | "upstream_error"      // 4xx/5xx from provider → 502
      | "invalid_input"       // body/headers malformed → 400
      | "no_key_configured"   // admin hasn't set up the provider secret → 500
      | "unsupported_model",  // provider_pricing has no row for (provider, model) → 400
    public readonly detail: string,
    public readonly upstreamStatus?: number
  ) {
    super(`${kind}: ${detail}`);
    this.name = "TranscriptionDispatchError";
  }
}
