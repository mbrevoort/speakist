// Regression fixtures for the vocab classifier prompt.
//
// Same shape as polish-fixtures.ts. Each case captures a behavior we
// want the model to produce on a specific class of input — a "yes,
// add to STT vocab" or a "no, keep this local-only / discard."
//
// Adding a case:
//   1. Pick a clear, kebab-case `name`.
//   2. Set `expectAdd` to true|false based on what's correct for the
//      user, not what the model currently does. A failing fixture
//      tells us the prompt needs work.
//   3. Optional `mustCategory`: when the *category* matters (e.g.
//      we care that "wanna → want to" is classified as `slang`,
//      not `common_word`). Most cases just care about add/skip.
//   4. Test locally: `pnpm bench:classifier -- --only your-name`.

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

export interface ClassifierFixture {
  /** Stable kebab-case identifier — referenced in bench output and
   *  `--only` filters. */
  name: string;
  /** One-line human description. */
  description: string;
  /** The misheard side. */
  find: string;
  /** The user's correction. */
  replacement: string;
  /** Optional surrounding-text context. */
  context?: string;
  /** Whether this pair SHOULD be added to STT vocab. */
  expectAdd: boolean;
  /** If set, the category the classifier MUST return. Use sparingly
   *  — most fixtures only care about add/skip, not the category
   *  label. Asserting a specific category for borderline cases just
   *  creates flaky CI. */
  mustCategory?: VocabCategory;
}

export const CLASSIFIER_FIXTURES: ClassifierFixture[] = [
  // ---- Should ADD --------------------------------------------------------

  {
    name: "kubernetes-capitalization",
    description: "Brand/product name capitalization — the canonical proper-noun case.",
    find: "kubernetes",
    replacement: "Kubernetes",
    expectAdd: true,
    mustCategory: "proper_noun",
  },
  {
    name: "personal-name-spelling",
    description: "Personal/proper name spelling correction.",
    find: "brevort",
    replacement: "Brevoort",
    expectAdd: true,
    mustCategory: "proper_noun",
  },
  {
    name: "company-name-with-y",
    description: "Made-up company name spelling fix.",
    find: "mitra",
    replacement: "Mytra",
    expectAdd: true,
    mustCategory: "proper_noun",
  },
  {
    name: "version-identifier",
    description: "Version string shorthand — 'v nine' → 'v9'.",
    find: "v nine",
    replacement: "v9",
    expectAdd: true,
  },
  {
    name: "slang-wanna",
    description: "Slang-to-writing substitution.",
    find: "wanna",
    replacement: "want to",
    expectAdd: true,
    mustCategory: "slang",
  },
  {
    name: "slang-gonna",
    description: "Another classic slang-to-writing case.",
    find: "gonna",
    replacement: "going to",
    expectAdd: true,
    mustCategory: "slang",
  },
  {
    name: "technical-javascript-casing",
    description: "Tech-term casing preference.",
    find: "javascript",
    replacement: "JavaScript",
    expectAdd: true,
    mustCategory: "technical_term",
  },
  {
    name: "abbreviation-okay-to-ok",
    description: "Spelled-out → abbreviation preference.",
    find: "okay",
    replacement: "OK",
    expectAdd: true,
    mustCategory: "abbreviation",
  },

  // ---- Should NOT ADD ---------------------------------------------------
  // The real-world failure modes the user reported — these are the
  // pairs that flooded their vocabulary under the old auto-ingest.

  {
    name: "common-word-swap-as-given",
    description:
      "Both 'as' and 'given' are common English words. Globally rewriting all 'as' to 'given' clobbers unrelated sentences.",
    find: "as",
    replacement: "given",
    expectAdd: false,
    mustCategory: "common_word",
  },
  {
    name: "article-agreement-a-an",
    description:
      "'a → an' is a grammar fix that depends on the next word's sound. Never a global rewrite.",
    find: "a",
    replacement: "an",
    expectAdd: false,
    mustCategory: "grammar",
  },
  {
    name: "function-word-this-to-is-a",
    description:
      "'this' is a function word. Globally rewriting it to 'is a' would corrupt many sentences.",
    find: "this",
    replacement: "is a",
    expectAdd: false,
  },
  {
    name: "homophone-our-or",
    description:
      "STT homophone error. Both are common English words — applying as a global rule is unsafe.",
    find: "our",
    replacement: "or",
    expectAdd: false,
  },
  {
    name: "self-correction-leak-leaky",
    description: "Both common English words; an in-context word choice, not vocab.",
    find: "leak",
    replacement: "leaky",
    expectAdd: false,
  },
  {
    name: "sentence-initial-cap-it",
    description:
      "Stray capital from STT at a sentence start — should not become a global capitalization rule.",
    find: "it",
    replacement: "It",
    expectAdd: false,
  },
  {
    name: "long-rewrite",
    description:
      "Edits spanning > 4 words are rewrites, not vocab items. " +
      "We assert only the add/skip binary; the model's category " +
      "choice for a long rewrite (`rewrite` vs `other`) is " +
      "subjective and not worth a flaky-CI assertion.",
    find: "i was thinking about maybe doing this thing",
    replacement: "I'd like to consider doing this differently",
    expectAdd: false,
  },

  // ---- Edge cases -------------------------------------------------------

  {
    name: "single-char-input",
    description: "Single-character find is almost never a vocab item.",
    find: "a",
    replacement: "A",
    expectAdd: false,
  },
  {
    name: "punctuation-only",
    description: "Adding a period is formatting, not vocab.",
    find: "test",
    replacement: "test.",
    expectAdd: false,
  },
];
