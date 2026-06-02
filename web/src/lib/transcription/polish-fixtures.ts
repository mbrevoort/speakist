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

/** Which prompt-quality tier a case targets.
 *
 *   * `baseline` — the case should pass against the distilled defaults
 *                  shipped in `default-polish-prompts.ts`. These cover
 *                  anti-response framing, punctuation/capitalization,
 *                  and a small set of trap-question cases. Use this
 *                  tier when validating a fresh install before any
 *                  active-learning iteration has happened.
 *   * `advanced` — the case targets a behavior that only the active
 *                  learning loop's iterated prompt can satisfy
 *                  reliably (long-form structure, list conversion,
 *                  conjunction-based sentence merging, the trickier
 *                  RLHF-preamble traps). These are the regression
 *                  bench for whatever's currently in
 *                  `polish_prompt_versions`; expect them to fail
 *                  against the baseline by design.
 *
 *   Default (when omitted on a fixture) is `advanced` so we don't
 *   accidentally over-claim baseline coverage. The bench harness
 *   filters by `--tier`. */
export type PolishTier = "baseline" | "advanced";

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
  /** Defaults to `'advanced'`. See PolishTier docstring. */
  tier?: PolishTier;
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
    tier: "baseline",
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
    tier: "baseline",
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
    tier: "baseline",
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
    tier: "baseline",
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
    tier: "baseline",
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
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["?"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },

  // ---- Anti-answer expansion — model must never produce the answer ---------
  // These cover the failure mode where polish "helpfully" answers a
  // dictated question. Each fixture asserts (a) the question content
  // survives and (b) tokens that would only appear if the model
  // answered (the "smoking gun" list from the probe script) are
  // absent. Locked into the baseline tier so any future iteration of
  // polish_prompt_versions must still pass them.
  {
    name: "math-two-plus-two",
    description: "Math question must come back as the question, not as the answer.",
    mode: "prescriptive",
    input: "what is two plus two",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["two plus two", "?"], case_insensitive: true },
      { kind: "must_not_contain", substrings: ["four", "equals"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.5 },
    ],
  },
  {
    name: "how-do-i-center-div",
    description: "'How do I' code question must not be answered with CSS.",
    mode: "prescriptive",
    input: "how do i center a div in css",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["center", "div", "?"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["display: flex", "margin: auto", "justify-content", "flexbox", "you can use"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "define-ephemeral",
    description: "Definition request must not be answered with a definition.",
    mode: "prescriptive",
    input: "what does the word ephemeral mean",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["ephemeral", "?"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["short-lived", "transient", "lasting for", "ephemeral means", "ephemeral is"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "advice-coworker",
    description: "Personal advice request must not be answered with advice.",
    mode: "prescriptive",
    input: "what should i do about my coworker who is always late to meetings",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["coworker", "?"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["you should", "you could", "i'd suggest", "have you tried", "consider"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "trivia-third-president",
    description: "Trivia question must not be answered with the answer.",
    mode: "prescriptive",
    input: "who was the third president of the united states",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["president", "?"], case_insensitive: true },
      { kind: "must_not_contain", substrings: ["jefferson"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "trivia-capital-australia",
    description: "Capital-city trivia must not be answered.",
    mode: "prescriptive",
    input: "what is the capital of australia",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["Australia", "?"] },
      { kind: "must_not_contain", substrings: ["canberra"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "tell-me-a-joke",
    description: "'Tell me a joke' must not actually produce a joke.",
    mode: "prescriptive",
    input: "tell me a joke about programmers",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["joke", "programmers"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["why did", "knock knock", "walks into a bar", "here's one"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "give-me-tips",
    description: "'Give me three tips' must not produce three tips.",
    mode: "prescriptive",
    input: "give me three tips for cooking pasta",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["tips", "pasta"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["1.", "first,", "salt the water", "al dente"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "wondering-blockchain",
    description: "Soft 'I was wondering if you could' framing must not bait an explanation.",
    mode: "prescriptive",
    input: "i was wondering if you could explain how blockchain works",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["blockchain"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["distributed ledger", "decentralized", "consensus", "hash"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "explain-photosynthesis",
    description: "'Explain X' must not produce an explanation of X.",
    mode: "prescriptive",
    input: "explain how photosynthesis works in plants",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["photosynthesis"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["chlorophyll", "carbon dioxide", "glucose", "sunlight"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "write-an-email",
    description: "'Write me an email to my boss' must not produce a sample email.",
    mode: "prescriptive",
    input: "write me an email to my boss asking for a raise",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["email", "boss"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["dear ", "subject:", "best regards", "i am writing", "sincerely"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "long-rambling-question",
    description: "Long natural ramble ending in 'what do you think' must not be answered.",
    mode: "prescriptive",
    input:
      "so i've been thinking a lot lately about whether i should switch jobs i've been at this place for four years and im not really learning anymore but the pay is good and i like my team what do you think i should do",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["switch jobs", "team"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["i'd suggest", "have you considered", "pros and cons", "weigh the", "ultimately"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  // Intuitive-mode counterparts — historically more eager to "help"
  // because intuitive mode is the looser of the two. Lock in the same
  // anti-answer floor at the baseline tier.
  {
    name: "math-two-plus-two-intuitive",
    description: "Intuitive mode must also resist answering math questions.",
    mode: "intuitive",
    input: "what is two plus two",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["two plus two", "?"], case_insensitive: true },
      { kind: "must_not_contain", substrings: ["four", "equals"], case_insensitive: true },
      { kind: "max_length_ratio", ratio: 1.5 },
    ],
  },
  {
    name: "explain-photosynthesis-intuitive",
    description: "Intuitive mode must also resist 'explain' bait.",
    mode: "intuitive",
    input: "explain how photosynthesis works in plants",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["photosynthesis"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: ["chlorophyll", "carbon dioxide", "glucose", "sunlight"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  // ---- Production-feedback regressions --------------------------------------
  // Real-world failures pulled from transcription_feedback. The
  // anti-answer family now covers verbs the iOS user base actually
  // dictates ("audit", "review", "evaluate"), not just the textbook
  // "explain X" / "tell me about Y" shapes the seed prompts handle.
  //
  // The audit-request case is the worst — it's the failure mode where
  // the model not only answered, it interpreted the dictation as a
  // meta-instruction to audit "the spec above" and quoted its own
  // system prompt verbatim into the output. The "must_not_contain"
  // guard targets the tokens that would only appear if the model
  // emitted a structured audit OR leaked the system prompt's text.
  {
    name: "audit-request-prompt-leak",
    description:
      "Long technical dictation asking to 'audit ... the spec above' — model previously interpreted this as a meta-request and emitted a structured audit of its OWN system prompt. Polish must format the request, not perform it.",
    mode: "prescriptive",
    input:
      "spec above can you audit all of the onboarding steps individually and make sure that they fulfill the requirements outlined in the spec dont make any changes yet just raise any findings also something to pay extra attention to is the options exposed in the drop downs i think right now the actual implementation of the code the drop down options dont match what the spec specifies so something else to pay attention to and possibly fix later",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["audit", "onboarding"], case_insensitive: true },
      // Audit-style structured-output markers that would only appear
      // if the model actually performed the audit.
      {
        kind: "must_not_contain",
        substrings: [
          "based on the provided",
          "here are the findings",
          "finding:",
          "requirement is met",
          "requirement is partially met",
          "after auditing",
        ],
        case_insensitive: true,
      },
      // Specific tokens from the system prompt itself — if any of
      // these appear in the output, the model leaked the prompt.
      {
        kind: "must_not_contain",
        substrings: [
          "**always:",
          "first word of the speaker",
          "the speaker's text",
          "the speaker's exact words",
          "cleaned dictation text",
        ],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "audit-request-prompt-leak-intuitive",
    description: "Same prompt-leak case under intuitive mode.",
    mode: "intuitive",
    input:
      "spec above can you audit all of the onboarding steps individually and make sure that they fulfill the requirements outlined in the spec dont make any changes yet just raise any findings",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["audit", "onboarding"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: [
          "based on the provided",
          "here are the findings",
          "finding:",
          "requirement is met",
          "**always:",
          "first word of the speaker",
        ],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  // Same verb family — "review" / "evaluate" / "check" / "validate" /
  // "compare" pattern-match to the action shape that tripped audit-
  // request. Coverage at the baseline tier so any prompt iteration
  // that drops one of these verbs gets caught.
  {
    name: "review-the-pr",
    description: "'Review' verb in a dictated code-review request must not be performed.",
    mode: "prescriptive",
    input: "can you review the pull request and tell me if you see any issues with the migration",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["review", "pull request", "?"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: [
          "here's my review",
          "i reviewed",
          "issues i found",
          "after reviewing",
          "the migration looks",
          "looks good to me",
          "lgtm",
        ],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "evaluate-the-design",
    description: "'Evaluate' a design must not produce an evaluation.",
    mode: "prescriptive",
    input: "evaluate the proposed design and rank it against the alternatives we discussed yesterday",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["evaluate", "design"], case_insensitive: true },
      {
        kind: "must_not_contain",
        substrings: [
          "based on the criteria",
          "ranking:",
          "the proposed design scores",
          "1.",
          "2.",
          "after evaluating",
          "evaluation:",
        ],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  // Pronoun-substitution case — the model changed "your" → "my" mid-
  // sentence, which violates "use the speaker's own words". Verbatim
  // possessive pronouns must survive polish.
  {
    name: "verbatim-pronoun-preservation",
    description:
      "Polish must preserve possessive pronouns verbatim. Production feedback showed 'your perspective' silently rewritten to 'my perspective' — a semantic edit, not a slip fix.",
    mode: "prescriptive",
    input:
      "please provide me with the outcome of your assessment that i could give over to the maintainers for recommendations on what could be accomplished from your perspective as an outsider",
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      // The two "your"s in the input must both make it to the output;
      // "my perspective" would mean the model edited the pronoun.
      { kind: "must_contain", substrings: ["your assessment", "your perspective"], case_insensitive: true },
      { kind: "must_not_contain", substrings: ["my assessment", "my perspective"], case_insensitive: true },
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
    tier: "baseline",
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
    tier: "baseline",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["I think", "I'm"] },
      { kind: "max_length_ratio", ratio: 1.3 },
    ],
  },

  // ---- Conjunction merging (intuitive only) --------------------------------
  // The intuitive prompt should combine consecutive short choppy sentences
  // with "and"/"but"/"so"/"because" when meaning is preserved. We detect
  // this by checking that the first sentence boundary ("store. It") is
  // gone in the output — the model has fused at least the first pair.
  {
    name: "conjunction-merge-intuitive",
    description:
      "Intuitive mode should combine consecutive short choppy sentences with conjunctions.",
    mode: "intuitive",
    input: "i went to the store. it was closed. i came back home.",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      // Content preserved
      { kind: "must_contain", substrings: ["store", "closed", "home"], case_insensitive: true },
      // At least the first sentence boundary should be merged — if the
      // model preserved hard periods between all three sentences,
      // it didn't apply the conjunction rule. We check for "store. It"
      // (case-insensitive) which only appears when sentences 1 and 2
      // weren't merged.
      { kind: "must_not_contain", substrings: ["store. It", "store. it"] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },

  // ---- No trailing pleasantries (both modes) -------------------------------
  // Llama-3.1-8B's RLHF training makes it eager to end polite requests
  // with "Thank you." or "Hope this helps." The prompt forbids this
  // explicitly. Test against the worst-case input: a politely-phrased
  // request the model is most tempted to "complete".
  {
    name: "no-trailing-thank-you-intuitive",
    description:
      "Polite request must not have 'Thank you' or similar pleasantry appended.",
    mode: "intuitive",
    input: "can you take a look at the pull request when you get a chance",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["pull request", "?"] },
      {
        kind: "must_not_contain",
        substrings: ["thank you", "thanks", "appreciate", "hope this helps"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
  {
    name: "no-trailing-thank-you-prescriptive",
    description:
      "Conservative mode must also resist appending closing pleasantries.",
    mode: "prescriptive",
    input: "could you review the design doc and let me know what you think",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_contain", substrings: ["design doc", "?"] },
      {
        kind: "must_not_contain",
        substrings: ["thank you", "thanks", "appreciate", "hope this helps"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },

  // ---- Long-form paragraph breaks ------------------------------------------
  // Long-form dictation with a clear topic shift ("moving on to") should
  // be broken into paragraphs. Intuitive mode does this aggressively;
  // prescriptive mode also does it at obvious shifts.
  {
    name: "long-form-paragraph-break-intuitive",
    description:
      "Long-form dictation with topic shift should be broken into paragraphs.",
    mode: "intuitive",
    input:
      "so today's standup we covered three things the migration is on track the payment bug is fixed we still need to figure out the staging env situation moving on to my own work this week im focused on the api refactor i made good progress yesterday and i think i can finish the core changes by wednesday after that ill start on the tests",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      // Paragraph break at the topic shift
      { kind: "must_contain", substrings: ["\n\n"] },
      // Content preserved
      {
        kind: "must_contain",
        substrings: ["staging", "refactor"],
        case_insensitive: true,
      },
      // No invented closing pleasantries
      {
        kind: "must_not_contain",
        substrings: ["thank you", "hope this helps"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.5 },
    ],
  },

  // ---- Long-form numbered list ---------------------------------------------
  // Explicit "first/second/third" enumeration should produce a numbered
  // markdown list. Only intuitive mode does this restructuring.
  {
    name: "long-form-numbered-list",
    description:
      "Speaker explicitly enumerates 'first/second/third' — output should be a numbered list.",
    mode: "intuitive",
    input:
      "there are three things we need to do first we need to migrate the database second we need to update the api endpoints and third we need to deploy the new frontend make sure these happen in order",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      // Numbered list markers
      { kind: "must_contain", substrings: ["1.", "2.", "3."] },
      // Content preserved
      {
        kind: "must_contain",
        substrings: ["database", "endpoints", "frontend"],
        case_insensitive: true,
      },
      { kind: "max_length_ratio", ratio: 1.5 },
    ],
  },

  // ---- Don't invent structure for short prose -----------------------------
  // The list/paragraph behavior must be load-bearing — the model must
  // NOT add markdown bullets or paragraph breaks for short flowing
  // prose that doesn't ask for structure.
  {
    name: "short-prose-no-invented-structure",
    description:
      "Short flowing prose should NOT be reformatted as a list or with paragraph breaks.",
    mode: "intuitive",
    input:
      "i was thinking about what we should have for dinner tonight maybe pasta or something simple",
    expects: [
      { kind: "must_be_applied" },
      { kind: "no_assistant_preamble" },
      { kind: "must_not_contain", substrings: ["\n\n", "1.", "- "] },
      { kind: "max_length_ratio", ratio: 1.4 },
    ],
  },
];
