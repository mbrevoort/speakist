// Server-side PostHog helper.
//
// Used from API routes / server components / route handlers to capture
// events with full Worker-side context (the user/org we already resolved,
// upstream timings, model + token counts). No-ops gracefully when the
// project key isn't baked in (dev / preview deploys), so callers can sprinkle
// captures freely without env-checking each site.
//
// posthog-node opens a long-lived flush queue; in the Cloudflare Workers
// runtime that's incompatible with the request/response lifecycle. We
// create a fresh client per call with `flushAt: 1` so the event is sent
// inline, and call `shutdown()` after capture to drain. This is the
// pattern PostHog recommends for serverless / edge runtimes.

import { PostHog } from "posthog-node";
import { env } from "@/lib/env";

/**
 * Resolves a PostHog client, or null if no key is configured. Callers are
 * expected to handle `null` (typically by skipping capture entirely).
 */
function getClient(): PostHog | null {
  const key = env.public.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  return new PostHog(key, {
    host: env.public.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
}

interface CaptureArgs {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}

/**
 * Capture a single event server-side. Fire-and-forget — never throws,
 * never blocks the response on a slow PostHog flush. The shutdown()
 * promise is intentionally not awaited; on Cloudflare Workers we'd have
 * to wrap it in `ctx.waitUntil()` to keep the runtime alive past the
 * response, and that's not always available here. Worst case: the
 * occasional event drops. Acceptable for product analytics.
 */
export function captureServerEvent({
  distinctId,
  event,
  properties,
  groups,
}: CaptureArgs): void {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({
      distinctId,
      event,
      properties,
      groups,
    });
    // Don't await — PostHog will flush in the background. Workers
    // request lifetime is short; we accept the small drop rate.
    void client.shutdown().catch(() => {});
  } catch {
    // Capture must never break the request path.
  }
}

/**
 * Capture an `$ai_generation` event the way PostHog's LLM Analytics
 * dashboard expects to see it. Property names match PostHog's reserved
 * `$ai_*` schema so the event lights up the LLM Analytics UI (cost,
 * latency, token counts) without further configuration.
 *
 * Use this for any LLM call — wrap the existing fetch and pass the
 * resolved usage numbers in here. Streaming calls should sum the
 * deltas before calling.
 */
export interface AIGenerationEvent {
  distinctId: string;
  traceId: string;
  /** e.g. "groq", "openai", "anthropic". */
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock latency in seconds (PostHog's expected unit). */
  latencySeconds: number;
  /** HTTP status from the provider. 200 on success. */
  httpStatus: number;
  /** True when the call failed or the output was rejected by polish. */
  isError: boolean;
  /** Free-form additional properties — surfaces in the event view. */
  extra?: Record<string, unknown>;
  groups?: Record<string, string>;
}

export function captureAIGeneration(args: AIGenerationEvent): void {
  captureServerEvent({
    distinctId: args.distinctId,
    event: "$ai_generation",
    groups: args.groups,
    properties: {
      $ai_trace_id: args.traceId,
      $ai_provider: args.provider,
      $ai_model: args.model,
      $ai_input_tokens: args.inputTokens,
      $ai_output_tokens: args.outputTokens,
      $ai_latency: args.latencySeconds,
      $ai_http_status: args.httpStatus,
      $ai_is_error: args.isError,
      ...args.extra,
    },
  });
}
