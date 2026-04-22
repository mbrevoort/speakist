// Post-transcription LLM cleanup.
//
// Runs after the upstream STT provider returns raw transcript text. The
// cleanup pass is a single chat-completion on Groq with
// `llama-3.1-8b-instant` — fast (~200-500ms for a few sentences) and
// cheap (~$0.0001 per typical dictation).
//
// Behavior:
//   * User opts in per their `users.cleanup_enabled` flag
//   * Custom system prompt lives in `users.cleanup_system_prompt`; NULL →
//     we use `DEFAULT_CLEANUP_PROMPT` below
//   * We reuse the Groq key resolution path so org-override keys cover
//     cleanup too (same upstream project)
//
// Failure mode: if cleanup fails (network, 401, timeout, empty response)
// we log a warning and return the *original* raw transcript. The user
// still gets their transcription; cleanup is best-effort.

import { resolveProviderKey, type ProviderKeyEnv } from "./secrets";

export const DEFAULT_CLEANUP_PROMPT =
  "Return only the cleaned-up dictation result, with no explanations, " +
  "preamble, or commentary. Add punctuation, correct grammar, and " +
  "consider the context carefully when correcting words. The result " +
  "must contain ONLY the cleaned dictation text.";

/** Groq chat-completions endpoint (OpenAI-compatible). */
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Deliberately cheap + fast. If accuracy proves too low, swap for
 *  `llama-3.3-70b-versatile` (pricier) or `gpt-oss-20b` (mid-tier). */
const CLEANUP_MODEL = "llama-3.1-8b-instant";

/** Seconds — cleanup is bounded because we're blocking the /api/transcribe
 *  response on it. Whisper-compatible timeout budget (25s upstream-transcribe
 *  + 5s cleanup + headroom) stays under the Worker's 30s ceiling. */
const CLEANUP_TIMEOUT_MS = 5_000;

export interface CleanupResult {
  text: string;
  applied: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** Set when `applied === false` and we fell back to the raw transcript. */
  errorReason?: string;
}

/**
 * Run the cleanup pass. Resolves the Groq API key the same way a Groq
 * transcription would (org override → env secret), so users whose org
 * has a BYO-key for Groq get cleanup on their own Groq bill too.
 *
 * Never throws. Returns `applied: false` with the original `rawText`
 * when anything goes wrong so the caller can always proceed to paste.
 */
export async function runCleanup(
  env: ProviderKeyEnv,
  orgId: string,
  rawText: string,
  customSystemPrompt: string | null
): Promise<CleanupResult> {
  const startedAt = Date.now();
  const text = rawText.trim();

  // Empty / whitespace-only transcript — nothing to clean.
  if (text.length === 0) {
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      errorReason: "empty_input",
    };
  }

  let apiKey: string;
  try {
    apiKey = await resolveProviderKey(env, orgId, "groq");
  } catch (err) {
    // Cleanup requires a Groq key. If none is configured, fall back
    // silently — the user's transcription shouldn't fail just because
    // a nice-to-have cleanup can't run.
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      errorReason: `no_groq_key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const systemPrompt = customSystemPrompt?.trim() || DEFAULT_CLEANUP_PROMPT;

  const body = {
    model: CLEANUP_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    // Low temperature so the model stays faithful; we're editing for
    // punctuation/grammar, not rewriting for style.
    temperature: 0.2,
    // Cap output at ~2× input length — enough for any reasonable grammar
    // fix, not enough for runaway rewrites. Token count estimated at
    // ~0.25 tokens/char which is generous for English.
    max_tokens: Math.max(128, Math.min(2048, Math.ceil(text.length / 2))),
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      errorReason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "(unreadable body)");
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      errorReason: `http_${res.status}: ${responseBody.slice(0, 200)}`,
    };
  }

  let parsed: GroqChatResponse;
  try {
    parsed = (await res.json()) as GroqChatResponse;
  } catch (err) {
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      errorReason: `bad_json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cleaned = parsed.choices?.[0]?.message?.content?.trim() ?? "";
  if (cleaned.length === 0) {
    return {
      text,
      applied: false,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      errorReason: "empty_completion",
    };
  }

  return {
    text: cleaned,
    applied: true,
    promptTokens: parsed.usage?.prompt_tokens ?? 0,
    completionTokens: parsed.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  };
}

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
