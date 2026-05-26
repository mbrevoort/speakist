// Vocabulary classifier — decides whether a (find, replacement) pair
// learned from an inline transcript edit should be promoted from local-
// only to "send to STT as a keyterm bias + replace rule."
//
// This is the reactive gate referenced in `CorrectionStore.swift` and
// in migration 0021. Auto-ingested edits start as `applies_to = 'local'`
// (they don't reach STT). When a pair's count climbs to ≥ 2 (i.e., the
// user has made the same correction twice), the Mac calls this endpoint
// to decide whether the correction looks like a real vocab item or
// just a one-off rewrite. If `add = true`, the row gets promoted to
// `applies_to = 'stt'` and starts riding along on /api/transcribe.
//
// Why an LLM and not a regex: the heuristic that ships today
// (DiffEngine.isProperNounLike — "contains uppercase or digit") catches
// "Kubernetes" and "v9" but misses lowercase technical jargon
// ("idempotent", "iframe") and slang phrases ("wanna → want to").
// Conversely it false-positives on stray sentence-initial capitals
// from STT. The LLM does the actual semantic classification — proper
// noun vs technical term vs slang vs common-word swap vs grammar fix.
// Latency is ~300ms and cost is ~$0.0001/call; the count ≥ 2 trigger
// caps call volume to "pairs the user has actually repeated" which
// is tiny relative to total edit volume.
//
// Falls back to `add = false` on any model error, bad JSON, or
// timeout. Local-only is the safe default — under-promoting a real
// vocab item just means the user does it manually in Settings.
// Over-promoting (false positive) would put a bad replace rule on
// every future transcribe call.

import { resolveProviderKey, type ProviderKeyEnv } from "./secrets";

/** Groq's gpt-oss-20b — chosen for classification specifically
 *  because it supports STRICT structured outputs (json_schema with
 *  `strict: true`), which constrains the decode at the token level
 *  to match our declared schema. Llama models in the same family
 *  pattern-match the (find, replacement) input as a "find/replace
 *  operation" and produce an operation-shaped object like
 *  {"remove": ..., "replace": ...} instead of the requested
 *  decision JSON. The bench caught this on both 8b-instant and
 *  3.3-70b — 0/17 pass — before this switch.
 *
 *  Cost: ~1.7× llama-3.1-8b-instant. At the volume the classifier
 *  fires (only on count ≥ 2, so maybe 50 calls/week per active
 *  user), this comes out to single-digit cents per user per year.
 *  The polish pass keeps using 8b-instant — that path is
 *  text-in/text-out and doesn't need strict outputs. */
const CLASSIFIER_URL = "https://api.groq.com/openai/v1/chat/completions";
export const CLASSIFIER_MODEL = "openai/gpt-oss-20b";

/** Hard cap; the classifier should respond in well under 2s. If we
 *  hit this it's almost certainly a transient API issue and we'd
 *  rather fall back to `add = false` (safe) than block the Mac on
 *  a slow call. */
const CLASSIFIER_TIMEOUT_MS = 5_000;

export type VocabCategory =
  | "proper_noun"
  | "technical_term"
  | "slang"
  | "abbreviation"
  | "common_word"
  | "grammar"
  | "function_word"
  | "self_correction"
  | "rewrite"
  | "other";

export interface VocabClassifierInput {
  /** The misheard / STT-output side of the pair. */
  find: string;
  /** The user's corrected version. */
  replacement: string;
  /** Optional surrounding text from the transcript where the
   *  correction was made. Helps the model distinguish a one-off
   *  in-context fix from a true vocab item. Truncated to ~400
   *  chars before being sent to keep token cost bounded. */
  context?: string;
}

export interface VocabClassifierResult {
  /** Whether the pair should be added to the user's STT-vocab. */
  add: boolean;
  /** Categorical label for the decision; surfaced in the Settings UI
   *  as a "learned as: <category>" badge. */
  category: VocabCategory;
  /** One-line natural-language explanation. Useful for the
   *  Vocabulary UI tooltip + for debugging in admin views. */
  reason: string;
  /** True when the LLM call completed cleanly. False when we fell
   *  back to a safe default (model error, timeout, bad JSON). */
  applied: boolean;
  /** Set when `applied === false`; lets the caller log the
   *  underlying failure for debugging without affecting the result. */
  errorReason?: string;
  /** Model wall-clock latency, in ms. */
  latencyMs: number;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict gatekeeper for a personal voice-dictation vocabulary.

WHAT YOU ARE DECIDING

A user dictated speech, got an STT transcript back, and edited one phrase. We give you the (find, replacement) pair. If you return add=true, the find string becomes a PERMANENT GLOBAL RULE — every occurrence of "find" in every future dictation gets automatically replaced with "replacement." Forever. Until the user notices and manually prunes the rule in Settings.

Your default is add=false. You only return add=true when you have strong evidence the user wants this exact substitution applied to every future occurrence — not just this once.

THE COST FUNCTION

  False positive (add=true when wrong): every future dictation containing "find" is silently corrupted. The user has to notice + investigate + prune. High pain, possibly lost work.

  False negative (add=false when right): the user makes the same edit a second time. Mild annoyance, no data loss. They can manually add it in Settings.

Because the costs are asymmetric, when in doubt, RETURN add=false.

WHEN TO RETURN add=true

Only when "replacement" is unambiguously ONE of:

  1. A proper noun (person, company, place, brand, product) where the find side is a misspelling or miscapitalization. Brand names, project names, technical product names. Examples:
       kubernetes → Kubernetes      (capitalization preference for a product)
       brevort    → Brevoort         (spelling of a personal name)
       mitra      → Mytra            (spelling of a company name)

  2. A specific technical term, code identifier, or domain jargon whose canonical spelling/casing the user wants enforced globally. Examples:
       javascript → JavaScript       (casing of a language name)
       v nine     → v9               (version-string shorthand)

  3. A slang-to-writing substitution that ALWAYS applies regardless of context — i.e., the spoken form should NEVER appear in writing. Examples:
       wanna      → want to
       gonna      → going to
       kinda      → kind of

  4. A consistent abbreviation/acronym preference where the find side is a spelled-out form. Examples:
       okay       → OK
       u s a      → USA

WHEN TO RETURN add=false (DEFAULT)

If you cannot place the pair confidently in one of the four categories above, return add=false. In particular:

  - Both sides are common English words. Examples: "as → given", "leak → leaky", "our → or", "first → next". These are almost always one-off contextual word-choice changes the user made for THIS sentence. Globally rewriting "as" to "given" everywhere would be a disaster.

  - The change is a grammar/agreement fix that depends on the next word. Examples: "a → an", "is → are", "this → these". Articles and verb forms must agree with context — they are NEVER global rewrite rules.

  - The find side is a function word, article, preposition, pronoun, conjunction, or auxiliary verb (a, an, the, of, in, on, at, to, for, with, by, as, is, are, was, were, this, that, these, those, it, he, she, they, we, you, I, and, or, but, so, if, when, then, than). NEVER add these. The cost of corrupting every occurrence is too high.

  - The change is a self-correction the user made mid-sentence — the find side is itself a normal English word in a normal English position. Examples: "leak → leaky", "first → next", "happy → sad". These are word-choice changes, not vocab.

  - The change is punctuation, capitalization, or formatting only. Examples: "it → It" (sentence-initial cap), "test → test." (added period), "ok → OK." (added period). These belong to polishing, not vocab.

  - The find or replacement spans more than ~4 words. At that length it's a sentence rewrite, not a vocab entry.

  - The find side is one or two characters. NEVER add a 1- or 2-char rule — too many false matches.

  - You aren't confident this is one of the four ADD categories. When in doubt, add=false.

OUTPUT

The response_format constrains your output to a JSON object with exactly:
  decision : one of the 13 slots below
  reason   : one short sentence

The decision enum is your only way to express add vs skip. There is NO separate boolean. If the right category is a "skip_" one, you have already decided not to add. There is NO "add_rewrite" or "add_grammar" slot — those combinations are semantically wrong and the schema does not allow them.

ADD slots (use only when you have strong evidence — see categories above):
  add_proper_noun       Brand, person, place, product name. Spelling or casing.
  add_technical_term    Code identifier, framework, version. Casing or spelling.
  add_slang             "wanna", "gonna", "kinda" → expanded form.
  add_abbreviation      Spelled-out → abbreviation.

SKIP slots (your default — pick the most specific one that fits):
  skip_common_word      Both sides are common English words ("as → given").
  skip_grammar          Context-dependent grammar fix ("a → an", "is → are").
  skip_function_word    Find is a function word / article / pronoun / etc.
  skip_self_correction  Looks like in-context word choice ("leak → leaky").
  skip_punctuation      Adding/removing punctuation ("test → test.").
  skip_capitalization   Sentence-initial cap or proper-noun cap of a common word ("it → It").
  skip_rewrite          Multi-word rewrite (> ~4 words on either side).
  skip_short_find       Find is 1-2 characters.
  skip_other            None of the above but still don't add.

WORKED EXAMPLES (study these before responding)

  find: "kubernetes"  replacement: "Kubernetes"
  → {"decision": "add_proper_noun", "reason": "Capitalization preference for a product name."}

  find: "brevort"  replacement: "Brevoort"
  → {"decision": "add_proper_noun", "reason": "Spelling correction for a personal/proper name."}

  find: "wanna"  replacement: "want to"
  → {"decision": "add_slang", "reason": "Slang-to-writing substitution the user prefers globally."}

  find: "javascript"  replacement: "JavaScript"
  → {"decision": "add_technical_term", "reason": "Casing convention for a technical/product name."}

  find: "as"  replacement: "given"
  → {"decision": "skip_common_word", "reason": "Both are common English words; global swap would corrupt unrelated sentences."}

  find: "a"  replacement: "an"
  → {"decision": "skip_grammar", "reason": "Article-agreement is context-dependent and must NOT be a global rule."}

  find: "this"  replacement: "is a"
  → {"decision": "skip_function_word", "reason": "Function word; global swap would corrupt many sentences."}

  find: "leak"  replacement: "leaky"
  → {"decision": "skip_self_correction", "reason": "Both common English words; looks like an in-context word choice, not vocab."}

  find: "our"  replacement: "or"
  → {"decision": "skip_common_word", "reason": "Common-word STT homophone; not a vocab item."}

  find: "test"  replacement: "test."
  → {"decision": "skip_punctuation", "reason": "Punctuation fix, not vocabulary."}

  find: "it"  replacement: "It"
  → {"decision": "skip_capitalization", "reason": "Capitalization of a function word at a sentence start, not vocab."}

  find: "a"  replacement: "A"
  → {"decision": "skip_short_find", "reason": "Single-character find; too many false matches to be safe globally."}

  find: "i was thinking about maybe doing this thing"  replacement: "I'd like to consider doing this differently"
  → {"decision": "skip_rewrite", "reason": "Multi-word rewrite, not a vocab entry."}`;

/**
 * Run the classifier against a single pair. Production callers go
 * through this; the env-free `classifyWithApiKey` below is what the
 * bench (and unit tests) use.
 *
 * Never throws. On any failure (no key, network, bad JSON, model
 * timeout), returns `applied: false` with `add: false` — i.e., we
 * fall back to the safe default and the entry stays local-only.
 */
export async function runClassifier(
  env: ProviderKeyEnv,
  orgId: string,
  input: VocabClassifierInput
): Promise<VocabClassifierResult> {
  let apiKey: string;
  try {
    apiKey = await resolveProviderKey(env, orgId, "groq");
  } catch (err) {
    return {
      add: false,
      category: "other",
      reason: "classifier_skipped",
      applied: false,
      errorReason: `no_groq_key: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: 0,
    };
  }
  return classifyWithApiKey({
    apiKey,
    model: CLASSIFIER_MODEL,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    input,
  });
}

export interface ClassifyWithApiKeyArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  input: VocabClassifierInput;
}

/**
 * Pure, env-free classifier call — direct Groq HTTP, no DB reads,
 * no Worker bindings. Used by bench scripts and tests.
 */
export async function classifyWithApiKey(
  args: ClassifyWithApiKeyArgs
): Promise<VocabClassifierResult> {
  const startedAt = Date.now();
  const { apiKey, model, systemPrompt, input } = args;

  const find = input.find.trim();
  const replacement = input.replacement.trim();
  if (!find || !replacement) {
    return {
      add: false,
      category: "other",
      reason: "empty_input",
      applied: false,
      errorReason: "empty_input",
      latencyMs: 0,
    };
  }

  // Truncate context if oversized so token budget stays bounded.
  const context = (input.context ?? "").slice(0, 400);
  const userMessage = context
    ? `find: ${JSON.stringify(find)}\nreplacement: ${JSON.stringify(replacement)}\ncontext: ${JSON.stringify(context)}`
    : `find: ${JSON.stringify(find)}\nreplacement: ${JSON.stringify(replacement)}`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
      // No assistant-side prefill here — `response_format` with
      // strict structured outputs handles the shape constraint at
      // the decode level. Prefilling would conflict with the
      // schema-enforced opening tokens.
    ],
    // Strict structured output. The Groq decoder is constrained at
    // the token level to produce ONLY tokens that keep the JSON on
    // a path to schema-validity, so the model literally cannot
    // emit {"remove": ...} or {"replace": ...} — those keys aren't
    // in the schema. This is the single biggest reliability lever
    // we have on a small model.
    // Unified `decision` enum instead of separate add+category. Why:
    // the model kept emitting contradictory combinations like
    // {add: true, category: "rewrite"} (rewrites should be add=false)
    // or {add: true, category: "grammar"} — schema-valid but
    // semantically nonsense, and the bench paid for it. With one
    // enum each value implies the add/skip; an `add_rewrite` slot
    // doesn't exist, so the decode can't reach it. We derive the
    // boolean `add` from the prefix after parsing.
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "vocab_classifier_decision",
        schema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: [
                // add slots
                "add_proper_noun",
                "add_technical_term",
                "add_slang",
                "add_abbreviation",
                // skip slots
                "skip_common_word",
                "skip_grammar",
                "skip_function_word",
                "skip_self_correction",
                "skip_punctuation",
                "skip_capitalization",
                "skip_rewrite",
                "skip_short_find",
                "skip_other",
              ],
            },
            reason: { type: "string" },
          },
          required: ["decision", "reason"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
    temperature: 0.0,
    top_p: 0.1,
    // gpt-oss-20b uses reasoning tokens internally before producing
    // the visible response, and Groq counts those against max_tokens
    // for billing/limits. An overly tight cap (the 200 that was fine
    // for llama-3.x's direct emission) starves the model mid-think
    // and surfaces as `json_validate_failed` with an empty
    // failed_generation. 1024 leaves comfortable headroom; the
    // visible JSON is still bounded to ~150 chars by the schema, so
    // the budget mostly funds reasoning.
    max_tokens: 1024,
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(CLASSIFIER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
    });
  } catch (err) {
    return safeFallback(
      `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
      Date.now() - startedAt
    );
  }
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "(unreadable)");
    return safeFallback(
      `http_${res.status}: ${responseBody.slice(0, 200)}`,
      Date.now() - startedAt
    );
  }

  let parsed: GroqChatResponse;
  try {
    parsed = (await res.json()) as GroqChatResponse;
  } catch (err) {
    return safeFallback(
      `bad_json: ${err instanceof Error ? err.message : String(err)}`,
      Date.now() - startedAt
    );
  }

  const raw = parsed.choices?.[0]?.message?.content ?? "";
  // With strict structured outputs the model returns a full JSON
  // document. No reassembly needed; parse directly.
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return safeFallback(
      `parse_failed: ${raw.slice(0, 200)}`,
      Date.now() - startedAt
    );
  }

  if (!isClassifierShape(decoded)) {
    return safeFallback(
      `bad_shape: ${raw.slice(0, 200)}`,
      Date.now() - startedAt
    );
  }

  // Derive both legacy-shape fields from the unified `decision`
  // enum. Anything starting with "add_" promotes; anything starting
  // with "skip_" stays local. The category is the suffix.
  const decision = decoded.decision;
  const add = decision.startsWith("add_");
  const category = decision.replace(/^(add|skip)_/, "") as VocabCategory;
  return {
    add,
    category: normalizeCategory(category),
    reason: decoded.reason,
    applied: true,
    latencyMs: Date.now() - startedAt,
  };
}

/** Map the schema's expanded skip-reasons back onto the public
 *  `VocabCategory` enum. The schema has more skip slots than the
 *  public type (e.g. `skip_punctuation`, `skip_capitalization`)
 *  because we want the model to make finer distinctions internally,
 *  but downstream consumers only care about the broad bucket. */
function normalizeCategory(c: string): VocabCategory {
  switch (c) {
    case "proper_noun":
    case "technical_term":
    case "slang":
    case "abbreviation":
    case "common_word":
    case "grammar":
    case "function_word":
    case "self_correction":
    case "rewrite":
      return c;
    case "punctuation":
    case "capitalization":
    case "short_find":
    case "other":
    default:
      return "other";
  }
}

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
}

const VALID_DECISIONS = new Set<string>([
  "add_proper_noun",
  "add_technical_term",
  "add_slang",
  "add_abbreviation",
  "skip_common_word",
  "skip_grammar",
  "skip_function_word",
  "skip_self_correction",
  "skip_punctuation",
  "skip_capitalization",
  "skip_rewrite",
  "skip_short_find",
  "skip_other",
]);

function isClassifierShape(
  v: unknown
): v is { decision: string; reason: string } {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.decision !== "string") return false;
  if (!VALID_DECISIONS.has(obj.decision)) return false;
  if (typeof obj.reason !== "string") return false;
  return true;
}

/** Safe default when the classifier can't be trusted. `add: false`
 *  keeps the entry local-only — the user can always promote it
 *  manually in Settings. The category + reason fields encode the
 *  failure mode for admin debugging. */
function safeFallback(
  errorReason: string,
  latencyMs: number
): VocabClassifierResult {
  return {
    add: false,
    category: "other",
    reason: "classifier_unavailable",
    applied: false,
    errorReason,
    latencyMs,
  };
}
