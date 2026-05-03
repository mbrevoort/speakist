// Server-side PostHog helper.
//
// Used from API routes / server components / route handlers to capture
// events with full Worker-side context (the user/org we already resolved,
// upstream timings, model + token counts). No-ops gracefully when the
// project key isn't baked in (dev / preview deploys), so callers can
// sprinkle captures freely without env-checking each site.
//
// Workers-native flush model: posthog-node's `captureImmediate` returns
// a promise that resolves once the event has been POSTed to PostHog;
// we hand that promise to `ctx.waitUntil(...)` so the Worker runtime
// keeps the request alive until the upstream call completes. Without
// `waitUntil`, the Worker would tear down its TCP connections the
// moment the response is sent, silently dropping any in-flight events.

import { PostHog } from "posthog-node";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { env } from "@/lib/env";

function getClient(): PostHog | null {
  const key = env.public.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  return new PostHog(key, {
    host: env.public.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
}

// Hand a flush promise to the Worker runtime so it survives past
// response. Falls back to a no-op `void` when there's no Cloudflare
// context (e.g., `next dev` Node runtime, unit tests) — in those
// environments PostHog also typically isn't keyed, so this branch
// isn't load-bearing.
function holdOpen(promise: Promise<void>): void {
  try {
    const { ctx } = getCloudflareContext();
    ctx.waitUntil(promise.catch(() => {}));
  } catch {
    void promise.catch(() => {});
  }
}

interface CaptureArgs {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}

export function captureServerEvent({
  distinctId,
  event,
  properties,
  groups,
}: CaptureArgs): void {
  const client = getClient();
  if (!client) return;
  holdOpen(client.captureImmediate({ distinctId, event, properties, groups }));
}

/**
 * Capture an `$ai_generation` event the way PostHog's LLM Analytics
 * dashboard expects to see it. Property names match PostHog's reserved
 * `$ai_*` schema so the event lights up the LLM Analytics UI (cost,
 * latency, token counts) without further configuration.
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
