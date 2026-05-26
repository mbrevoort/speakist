// Post-transcription LLM polish.
//
// Runs after the upstream STT provider returns raw transcript text. The
// polish pass is a single chat-completion on Groq with
// `llama-3.1-8b-instant` — fast (~200-500ms for a few sentences) and
// cheap (~$0.0001 per typical dictation).
//
// Behavior:
//   * User opts in per their `users.polish_enabled` flag.
//   * `users.polish_mode` picks one of two server prompts:
//       - `intuitive`    → intent-aware, applies explicit self-corrections
//       - `prescriptive` → conservative, only fixes punctuation/grammar,
//                          never touches meaning (default for new users)
//   * Both prompts evolve through the active learning loop in
//     `lib/polish-prompts.ts`. The seed bodies for fresh deployments
//     live in `./default-polish-prompts.ts`; the active row served by
//     /api/transcribe is whatever's in `polish_prompt_versions`
//     (filled by admin edits, agent proposals via MCP, rollbacks, and
//     cross-env mirrors). End users cannot edit prompts.
//   * We reuse the Groq key resolution path so org-override keys cover
//     polish too (same upstream project).
//
// Failure mode: if polish fails (network, 401, timeout, empty response,
// or the output is suspiciously different from the input — see the
// length sanity check) we log a warning and return the *original* raw
// transcript. The user still gets their transcription; polish is
// best-effort.
//
// Originally shipped as `cleanup`; renamed to `polish` because "cleanup"
// suggested content sanitization / removal, which isn't what this does.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { getActivePrompt } from "@/lib/polish-prompts";
import {
  INTUITIVE_POLISH_PROMPT,
  PRESCRIPTIVE_POLISH_PROMPT,
  bakedInPromptForMode,
} from "./default-polish-prompts";
import { resolveProviderKey, type ProviderKeyEnv } from "./secrets";

export type PolishMode = "intuitive" | "prescriptive";

// Re-exported so existing callers (bench harness, admin tooling)
// can keep importing from polish.ts. The actual baseline bodies +
// the active-learning-loop framing live in default-polish-prompts.ts.
export {
  INTUITIVE_POLISH_PROMPT,
  PRESCRIPTIVE_POLISH_PROMPT,
  bakedInPromptForMode,
};

// The two baseline prompts moved to ./default-polish-prompts.ts when
// the active-learning loop landed. They're re-exported above for
// back-compat with callers (admin tooling, bench harness) and are the
// fallback at tier 3 of resolvePromptForMode. The live prompts the
// model actually sees on /api/transcribe come from polish_prompt_versions
// in D1 — see lib/polish-prompts.ts.


/**
 * Resolve the system prompt actually used at polish time.
 *
 * Three-tier fallback:
 *   1. `polish_prompt_versions` (active row for `mode`) — the source of
 *      truth as of migration 0022. Every prompt update — admin edit,
 *      agent proposal, rollback, cross-env mirror — writes a new row
 *      here. The partial unique index `idx_ppv_active` guarantees at
 *      most one active row per mode.
 *   2. `app_settings.polish_<mode>_prompt` — DEPRECATED. Kept for one
 *      release as a fallback so prod can't accidentally start serving
 *      the baked-in baseline if the versions-table read fails or the
 *      table is somehow empty.
 *   3. `bakedInPromptForMode(mode)` — the distilled baseline shipped
 *      in the repo (PR 5). For a brand-new deployment this is what
 *      gets served until an admin (or the active-learning agent)
 *      creates the first version.
 *
 * Any DB error short-circuits to the next tier rather than throwing —
 * a transient read failure must never break transcription. The cost
 * is one extra row read per polish call, cheap relative to the
 * upstream LLM round-trip.
 */
export async function resolvePromptForMode(mode: PolishMode): Promise<string> {
  // Tier 1 — versions table.
  try {
    const active = await getActivePrompt(mode);
    if (active && active.body.trim().length > 0) return active.body;
  } catch (err) {
    console.warn(
      "[polish] versions-table read failed; falling through to app_settings:",
      err
    );
  }

  // Tier 2 — deprecated app_settings columns. Will be dropped after one
  // release cycle; do not add new callers.
  try {
    const db = getDb();
    const [row] = await db
      .select({
        intuitive: appSettings.polishIntuitivePrompt,
        prescriptive: appSettings.polishPrescriptivePrompt,
      })
      .from(appSettings)
      .where(eq(appSettings.id, 1))
      .limit(1);
    const legacy =
      mode === "intuitive" ? row?.intuitive : row?.prescriptive;
    if (legacy && legacy.trim().length > 0) return legacy;
  } catch (err) {
    console.warn(
      "[polish] app_settings fallback read failed; using baked-in:",
      err
    );
  }

  // Tier 3 — baked-in baseline from ./default-polish-prompts.ts.
  // Reached on fresh installs (no versioned row, no legacy override)
  // OR on prod if both prior tiers silently failed — log so we
  // notice if it ever fires on a deployed Worker. The baseline
  // handles the load-bearing anti-response framing; longer-form
  // behaviors come from versions written by the active-learning
  // loop.
  if (process.env.NEXT_PUBLIC_SITE_URL?.includes("speakist.ai")) {
    console.warn(
      `[polish] resolver fell through to baked-in baseline for mode='${mode}' on prod — polish_prompt_versions and app_settings both empty?`
    );
  }
  return bakedInPromptForMode(mode);
}

/** Groq chat-completions endpoint (OpenAI-compatible). */
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Deliberately cheap + fast. If accuracy proves too low, swap for
 *  `openai/gpt-oss-20b` (strict structured outputs, 1.7× cost) or
 *  `llama-3.3-70b-versatile` (12× cost). Bench against
 *  `web/src/lib/transcription/polish-fixtures.ts` first. */
export const POLISH_MODEL = "llama-3.1-8b-instant";

/** Milliseconds — polish is bounded because we're blocking the
 *  /api/transcribe response on it. Whisper-compatible timeout budget
 *  (25s upstream-transcribe + 5s polish + headroom) stays under the
 *  Worker's 30s ceiling. */
const POLISH_TIMEOUT_MS = 5_000;

/** Sentinels for assistant-message prefilling.
 *
 * Llama-3.1-8B's RLHF training is heavily biased toward assistant-mode
 * opening tokens ("Okay,", "Sure,", "Here's"). At temperature=0 the
 * decoding is deterministic, so when input phrasing trips the "this
 * looks like a request" boundary, the model locks onto the assistant
 * token distribution and the system prompt can't dislodge it. We
 * measured ~20% rejection rate on this exact failure mode.
 *
 * Fix: prefill the assistant turn with `POLISH_OPEN`. Groq supports
 * this — the model continues from where the assistant message ended,
 * so it cannot emit a preamble before our sentinel because its turn
 * has already started past that position. We pass `stop: [POLISH_CLOSE]`
 * as a belt-and-suspenders bound on output length.
 *
 * **Sentinel choice matters.** We initially tried `<<<` / `>>>`; the
 * regression suite caught that the model pattern-matched it as an
 * XML-tag opener (since the user message wraps input in `<dictation>`
 * tags) and produced output like `<<<dictation>...</dictation>>>`.
 * `>>>>>` is plain ASCII repetition, doesn't suggest XML, doesn't
 * collide with any token in normal English, and is unlikely to ever
 * appear inside a polished transcript. The newline after `POLISH_OPEN`
 * gives the model a clean line on which to begin emitting text. */
const POLISH_OPEN = ">>>>>\n";
const POLISH_CLOSE = "<<<<<";

/**
 * Reject the polish output and fall back to raw text when the model has
 * clearly produced something other than a formatted version of the input.
 * Two complementary signals:
 *   1. Output length > 2x input length. Polish + self-correction can
 *      shrink the output (corrections drop content) but it physically
 *      should never make it dramatically longer. 2x is a generous
 *      threshold that still catches the catastrophic "10x rewrite into a
 *      design document" failure we hit in dev.
 *   2. Output starts with an assistant-preamble phrase that the prompt
 *      explicitly forbids. Caught even with temperature=0 occasionally,
 *      and is always a bug when seen.
 *
 * Returns null when output looks valid; an error reason string when it
 * should be rejected.
 */
function rejectionReason(input: string, output: string): string | null {
  if (output.length > input.length * 2) {
    return `output_too_long: ${output.length} chars vs ${input.length} input`;
  }

  // If the polished output begins with the same word as the input,
  // the model is preserving the user's first word — not adding an
  // assistant preamble. This is the exact false-positive that caught
  // dictations like "okay so the next step is..." where the polish
  // legitimately produces "Okay, so the next step is..." and we'd
  // otherwise incorrectly reject it. Captured by the regression
  // suite's `okay-prefix-trap` fixture.
  const firstOutputWord = output.toLowerCase().match(/^[a-z]+/)?.[0];
  const firstInputWord = input.toLowerCase().match(/^[a-z]+/)?.[0];
  const echoesInputStart =
    !!firstOutputWord && firstOutputWord === firstInputWord;

  const lower = output.toLowerCase().trimStart();
  const banned = [
    "sure,",
    "sure!",
    "here is",
    "here's the",
    "of course",
    "i'd be happy",
    "i understand",
    "it sounds like",
    "got it!",
    "got it,",
    "okay,",
    "okay!",
  ];
  for (const prefix of banned) {
    if (lower.startsWith(prefix)) {
      if (echoesInputStart) {
        // Polished version is echoing the user's first word — not
        // a preamble, even if it happens to land on the banned list.
        continue;
      }
      return `assistant_preamble: starts with "${prefix}"`;
    }
  }
  return null;
}

export interface PolishResult {
  text: string;
  applied: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** Set when `applied === false` and we fell back to the raw transcript. */
  errorReason?: string;
}

/**
 * Run the polish pass. Resolves the Groq API key the same way a Groq
 * transcription would (org override → env secret), so users whose org
 * has a BYO-key for Groq get polish on their own Groq bill too.
 *
 * The system prompt for the requested mode is read via
 * `resolvePromptForMode()` — super-admin override at /admin/system if
 * set, otherwise the baked-in constant. End users no longer customize
 * prompts.
 *
 * Never throws. Returns `applied: false` with the original `rawText`
 * when anything goes wrong so the caller can always proceed to paste.
 */
export async function runPolish(
  env: ProviderKeyEnv,
  orgId: string,
  rawText: string,
  mode: PolishMode
): Promise<PolishResult> {
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
    // Polish requires a Groq key. If none is configured, fall back
    // silently — the user's transcription shouldn't fail just because
    // a nice-to-have polish pass can't run.
    return {
      text,
      applied: false,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      errorReason: `no_groq_key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Mode-based system prompt — the super-admin override from
  // app_settings if set, else the baked-in constant. Both variants
  // handle the <dictation> tag contract + anti-response framing
  // internally; an admin who pastes a totally fresh prompt has to
  // include their own version of those guards (or accept the risk
  // of model drift).
  const systemPrompt = await resolvePromptForMode(mode);

  return polishWithApiKey({
    apiKey,
    model: POLISH_MODEL,
    systemPrompt,
    rawText: text,
  });
}

/**
 * Pure, env-free polish call. Takes an explicit API key, model, and
 * system prompt; calls Groq directly. No DB reads, no Worker bindings.
 *
 * This is the function the regression bench (`web/scripts/bench-polish.ts`)
 * calls to A/B different prompts and models against the fixture set
 * without needing the Cloudflare Workers runtime. Production code path
 * goes through `runPolish()` which wraps this with key resolution and
 * prompt-override lookup.
 *
 * Two changes from the older inline implementation worth noting here:
 *
 * 1. **Assistant-message prefilling** — the messages array ends with
 *    `{ role: "assistant", content: "<<<" }`. The model continues from
 *    that sentinel. This makes assistant-style preambles structurally
 *    impossible: the model cannot emit "Okay," before `<<<` because the
 *    assistant turn has already started. Llama-3.1-8B's RLHF bias
 *    toward those preambles is the documented cause of our ~20%
 *    rejection rate — prefilling targets it directly.
 *
 * 2. **Stop sequence on `>>>`** — system prompt instructs the model to
 *    end output with `>>>`; we also pass it as a `stop` sequence so
 *    Groq truncates there. Belt-and-suspenders. Both `<<<` and `>>>`
 *    are stripped from the response before applying the rejection
 *    sanity check.
 */
export interface PolishWithApiKeyArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  rawText: string;
}

export async function polishWithApiKey(
  args: PolishWithApiKeyArgs
): Promise<PolishResult> {
  const startedAt = Date.now();
  const { apiKey, model, systemPrompt, rawText } = args;
  const text = rawText.trim();

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

  // Wrap the raw STT output in <dictation> tags. This syntactically
  // separates user-provided content from any instruction-shaped text
  // it might contain, which materially reduces the chance the model
  // "answers" the dictation. Any stray < or > already in the transcript
  // are fine — they break the outer tag structure only if they form a
  // complete </dictation>, which STT virtually never produces. If it
  // ever does, stripTags below removes the tags after the fact.
  const userMessage = `<dictation>${text}</dictation>`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
      // Prefill the assistant turn — see POLISH_OPEN docstring.
      { role: "assistant", content: POLISH_OPEN },
    ],
    // Zero temperature + tight top_p so the model has no sampling slack
    // to wander into a "Here is your text:" preface or a tangent. This is
    // a find/replace-style task, not a generative one — we want it boring.
    temperature: 0.0,
    top_p: 0.1,
    // Hard cap on output tokens to curtail hallucination. Polish adds
    // punctuation + ~5% length for grammar fixes; a 30% headroom (chars/3)
    // covers that while making it physically impossible for the model to
    // emit a long preamble or summary. Floor at 96 so very short inputs
    // still have room for punctuation on a multi-sentence thought; ceiling
    // at 1024 handles long dictations.
    max_tokens: Math.max(96, Math.min(1024, Math.ceil(text.length / 3))),
    // Belt to the prefill suspenders — if the model emits the closing
    // sentinel we stop generation there. Bounds tail latency on the
    // odd case where the model wanders past the close.
    stop: [POLISH_CLOSE],
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
      signal: AbortSignal.timeout(POLISH_TIMEOUT_MS),
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

  const raw = parsed.choices?.[0]?.message?.content ?? "";
  const cleaned = stripPolishSentinels(stripDictationTags(raw));
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

  // Sanity check: if the polished output looks wildly different from
  // the input (much longer, or starts with a forbidden assistant
  // preamble), the model has gone off the rails. With prefilling this
  // should be rare — the preamble check is mostly a guard for the
  // case where the SDK echoes the prefill back and the model still
  // managed to insert a preamble after our sentinel.
  const rejection = rejectionReason(text, cleaned);
  if (rejection) {
    console.warn(`[polish] rejected output: ${rejection}`);
    return {
      text,
      applied: false,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      errorReason: `rejected: ${rejection}`,
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

/** Remove the prefill / stop sentinels if the model echoed them back. */
function stripPolishSentinels(s: string): string {
  let out = s;
  // Leading prefill — Groq sometimes prepends it to the returned
  // content; trim if present. Match either the full prefill (with
  // newline) or just the sentinel chars in case the newline got
  // collapsed.
  if (out.startsWith(POLISH_OPEN)) {
    out = out.slice(POLISH_OPEN.length);
  } else if (out.startsWith(POLISH_OPEN.trimEnd())) {
    out = out.slice(POLISH_OPEN.trimEnd().length);
  }
  // Trailing close — should normally be cut by the stop sequence,
  // but strip defensively in case max_tokens was reached just past
  // it or the SDK includes it.
  const closeIdx = out.indexOf(POLISH_CLOSE);
  if (closeIdx !== -1) {
    out = out.slice(0, closeIdx);
  }
  return out.trim();
}

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Strip any stray <dictation>…</dictation> tags from the model's output.
 * The system prompt tells the model to omit the tags; this is a defensive
 * backstop for the occasional model that echoes the wrapping.
 *
 * If the entire response is `<dictation>X</dictation>`, returns X. If
 * tags appear only on one side (opening without closing, or vice versa),
 * strip what's there. Also trims whitespace at the end.
 */
function stripDictationTags(s: string): string {
  return s
    .replace(/<\/?dictation[^>]*>/gi, "")
    .trim();
}
