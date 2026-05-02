// Regression fixtures for the polish pass.
//
// Each case captures a behavior we want the model to produce (or
// avoid) on a specific class of input. The bench
// (`web/scripts/bench-polish.ts`) runs every case through `polishWithApiKey`
// and reports per-case pass/fail plus aggregate metrics.
//
// Adding a case:
//   1. Pick a clear `name` and `description`.
//   2. Set `mode` to `intuitive` or `prescriptive` (or duplicate the
//      case across both with different expectations — see the
//      self-correction pair).
//   3. Pick `expects` from the union — most cases want
//      `{ kind: "no_assistant_preamble" }` plus a `must_contain`.
//   4. Test locally: `pnpm bench:polish -- --only your-name`.
//
// Don't include cases whose expected output depends on a model's
// arbitrary stylistic choice (e.g. "should it use an em-dash or a
// comma?"). Those produce noisy regressions that don't reflect a real
// quality change. Only assert what's structurally correct or
// structurally wrong.

export type PolishMode = "intuitive" | "prescriptive";

/** A single regression case. */
export interface PolishFixture {
  /** Stable kebab-case identifier for the case — referenced in
   *  bench output and `--only` filters. */
  name: string;
  /** One-line human description. */
  description: string;
  /** Which prompt to drive the model with. */
  mode: PolishMode;
  /** Raw STT input, exactly as Groq Whisper would have produced it
   *  (lowercase, no punctuation). */
  input: string;
  /** Behaviors the polished output must satisfy. AND-combined — every
   *  expectation must hold for the case to pass. */
  expects: PolishExpectation[];
}

/** Each variant is a simple structural assertion the bench applies to
 *  the model's output. We deliberately avoid "exact match" assertions
 *  because polish output legitimately varies in stylistic choices. */
export type PolishExpectation =
  /** Output must NOT begin with any common assistant preamble.
   *  Default banned list = the same one `polish.ts` rejects on. */
  | { kind: "no_assistant_preamble" }
  /** Output must contain every listed substring (case-sensitive
   *  unless `case_insensitive` is true). Use for proper-noun
   *  capitalization, contraction handling, key-content presence. */
  | { kind: "must_contain"; substrings: string[]; case_insensitive?: boolean }
  /** Output must NOT contain any of these substrings — useful for
   *  intuitive-mode self-correction where we want the original
   *  retracted statement dropped. */
  | { kind: "must_not_contain"; substrings: string[]; case_insensitive?: boolean }
  /** Output length / input length must not exceed `ratio`. Captures
   *  the "model rewrote it as a 4-paragraph essay" failure mode for
   *  non-trivially-short inputs. */
  | { kind: "max_length_ratio"; ratio: number }
  /** Polish must have been applied (i.e. `applied: true`). The case
   *  fails if rejection logic kicked in. Pair with other expectations
   *  for the strictest possible pass/fail. */
  | { kind: "must_be_applied" };

const DEFAULT_BANNED_PREAMBLES = [
  "sure,",
  "sure!",
  "here is",
  "here's the",
  "here's your",
  "of course",
  "i'd be happy",
  "i understand",
  "it sounds like",
  "got it!",
  "got it,",
  "okay,",
  "okay!",
  "ok,",
  "alright,",
];

export function preambleBannedList(): string[] {
  return [...DEFAULT_BANNED_PREAMBLES];
}

export const POLISH_FIXTURES: PolishFixture[] = [
  // ---- Trap cases — instruction-shaped dictation ---------------------------
  // These are where llama-3.1-8b-instant historically fails. The model is
  // fluent in chat, sees what looks like a question / imperative, and
  // either answers it or prefaces with "Sure, here's...". With the prefill
  // change all of these should pass.
  {
    name: "weather-question",
    description: "Question-shaped dictation should be returned as a question, not answered.",
    mode: "prescriptive",
    input: "what's the weather like in tokyo today",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["Tokyo", "?"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "haiku-request",
    description: "Imperative dictation must be returned verbatim, not executed (no haiku written).",
    mode: "prescriptive",
    input: "can you write me a haiku about autumn",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["haiku", "?"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "rome-history",
    description: "Open-ended question must be returned as text, not answered with a history lesson.",
    mode: "prescriptive",
    input: "tell me about the history of rome",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["Rome"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "direct-address-chatgpt",
    description: "Direct address to another AI must be preserved as text, not answered.",
    mode: "prescriptive",
    input: "hey chatgpt please help me debug this",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["debug"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "delete-command",
    description: "Imperative command must be returned as text, never executed/explained.",
    mode: "prescriptive",
    input: "delete all files in the temp directory",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["temp"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "what-do-you-think",
    description: "Speculative question — must come back as a question, not as an answer.",
    mode: "prescriptive",
    input: "what do you think is going to happen",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["?"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "okay-prefix-trap",
    description: "Input starting with 'okay' historically tripped the model into 'Okay, ...' preamble.",
    mode: "prescriptive",
    input: "okay so the next step is to call the API and check the response code",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["API"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },

  // ---- Standard formatting -------------------------------------------------
  {
    name: "casual-statement",
    description: "Unambiguous declarative — proper nouns capitalized, contractions, end-stop.",
    mode: "prescriptive",
    input: "send an email to john saying im running late",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["John", "I'm"] },
      { kind: "max_length_ratio", ratio: 1.3 },
    ],
  },
  {
    name: "filler-words-prescriptive",
    description: "Prescriptive mode preserves filler words ('um', 'uh').",
    mode: "prescriptive",
    input: "um yeah so i was thinking we could meet at three",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["um"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "multi-sentence",
    description: "Multiple sentences should be split with proper punctuation.",
    mode: "prescriptive",
    input: "i went to the store today then i came home it was nice",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["I went"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "numbers-and-time",
    description: "Numbers spoken as words should remain readable; proper nouns capitalized.",
    mode: "prescriptive",
    input: "the meeting is at 3 30 pm with sarah from marketing",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["Sarah"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },

  // ---- Self-corrections (intuitive vs prescriptive) ------------------------
  {
    name: "self-correction-intuitive",
    description: "Intuitive mode collapses 'I mean' self-corrections to the corrected version.",
    mode: "intuitive",
    input: "i will be at your house at 2pm i mean ill be there at 3 30 be ready",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["3:30"] },
      { kind: "must_not_contain", substrings: ["I mean", "i mean"] },
      { kind: "max_length_ratio", ratio: 1.3 },
    ],
  },
  {
    name: "self-correction-prescriptive",
    description: "Prescriptive mode preserves the 'I mean' phrasing verbatim.",
    mode: "prescriptive",
    input: "i will be at your house at 2pm i mean ill be there at 3 30 be ready",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["I mean"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "false-self-correction",
    description: "'i actually really enjoyed the book' is filler, not a correction — preserve.",
    mode: "intuitive",
    input: "i actually really enjoyed the book",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["enjoyed", "book"] },
      { kind: "max_length_ratio", ratio: 1.5 },
    ],
  },

  // ---- Edge cases ----------------------------------------------------------
  {
    name: "very-short",
    description: "Single-word input has more headroom for length ratio.",
    mode: "prescriptive",
    input: "hello",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "max_length_ratio", ratio: 3.0 },
    ],
  },
  {
    name: "code-fragment",
    description: "Technical phrase with code-like terms — must not be 'helpfully' rewritten.",
    mode: "prescriptive",
    input: "the function returns null when the input is empty otherwise it returns the parsed json",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["function", "JSON"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "pronoun-i-cap",
    description: "Standalone 'i' must be capitalized.",
    mode: "prescriptive",
    input: "i think i need to call her later but i'm not sure",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["I think", "I'm"] },
      { kind: "max_length_ratio", ratio: 1.3 },
    ],
  },
];
