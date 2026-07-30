// Transcription dispatcher — picks an adapter, fetches the upstream, maps
// errors to typed failures. Called by /api/transcribe on every request.
//
// Deepgram is the only STT adapter. Groq Whisper was retired (Deepgram
// nova-3 outperformed it and is the default for every language); note the
// `groq` PROVIDER ID still exists as a key namespace because the polish
// LLM runs on Groq. A future provider = new file in adapters/ + an entry
// in `ADAPTERS` below.
//
// Dispatch does NOT handle billing or analytics — that's the route
// handler's job, so it can log analytics even on dispatch errors.

import { deepgramAdapter } from "./adapters/deepgram";
import { resolveProviderKey, type ProviderKeyEnv } from "./secrets";
import {
  TranscriptionDispatchError,
  type ProviderAdapter,
  type ProviderId,
  type TranscriptionInput,
  type TranscriptionOutput,
} from "./types";

/** The timeout we enforce on upstream STT requests. Workers' wall-clock
 *  ceiling on the Paid plan is 30 s; 25 s gives us 5 s headroom for
 *  auth/parse/debit/logging after the provider responds. */
const UPSTREAM_TIMEOUT_MS = 25_000;

const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  deepgram: deepgramAdapter,
};

/** Provider IDs with a live STT adapter. The allow-list parser validates
 *  against this (not the full PROVIDER_IDS key namespace) so a stale
 *  `groq/…` allow-list entry can't route to a provider with no adapter. */
export function isSupportedSttProvider(providerId: ProviderId): boolean {
  return providerId in ADAPTERS;
}

export function getAdapter(providerId: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[providerId];
  if (!adapter) {
    throw new TranscriptionDispatchError(
      "unsupported_model",
      `Provider '${providerId}' isn't wired up yet. Currently supported: ` +
        Object.keys(ADAPTERS).join(", ")
    );
  }
  return adapter;
}

export interface DispatchResult extends TranscriptionOutput {
  upstreamStatus: number;
}

/**
 * Build the upstream request, fetch with a timeout, parse the response.
 * Throws `TranscriptionDispatchError` on any failure mode the caller
 * might want to turn into a specific HTTP status.
 */
export async function dispatch(
  env: ProviderKeyEnv,
  orgId: string,
  input: TranscriptionInput
): Promise<DispatchResult> {
  const adapter = getAdapter(input.providerId);

  if (!adapter.models.includes(input.model)) {
    throw new TranscriptionDispatchError(
      "unsupported_model",
      `Model '${input.model}' not supported by provider '${input.providerId}'. ` +
        `Supported: ${adapter.models.join(", ")}.`
    );
  }

  const apiKey = await resolveProviderKey(env, orgId, input.providerId);
  const req = adapter.buildRequest(input, apiKey);

  let res: Response;
  try {
    res = await fetch(req, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("timeout") || (err as { name?: string })?.name === "TimeoutError") {
      throw new TranscriptionDispatchError("upstream_timeout", `Upstream exceeded ${UPSTREAM_TIMEOUT_MS}ms`);
    }
    throw new TranscriptionDispatchError("upstream_error", `fetch failed: ${msg}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new TranscriptionDispatchError(
      "upstream_auth",
      `${input.providerId} rejected our API key (HTTP ${res.status})`,
      res.status
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable body)");
    throw new TranscriptionDispatchError(
      "upstream_error",
      `${input.providerId} returned HTTP ${res.status}: ${body.slice(0, 500)}`,
      res.status
    );
  }

  const output = await adapter.parseResponse(res);
  return { ...output, upstreamStatus: res.status };
}

export type { ProviderId, TranscriptionInput, TranscriptionOutput };
export { TranscriptionDispatchError } from "./types";
