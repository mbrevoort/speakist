// Unit tests for the structural anti-answer backstop in polish.ts.
//
// `rejectionReason` runs after every Groq polish call and rejects the
// output (falling back to the raw transcript) when it doesn't look like
// a formatted version of the input. The three signals are:
//   1. output_too_long — >2x input length
//   2. assistant_preamble — starts with a banned chat-opener
//   3. novel_content — output contains content words not in the input,
//      which is the structural signature of the model answering the
//      dictation rather than formatting it
//
// These tests lock in (3) — the new check. (1) and (2) are exercised
// indirectly by the bench-polish regression harness but we want a
// fast, network-free assertion that the novel-content rule fires on
// the cases that motivated it (math/trivia answers, explanation
// generation) and does NOT fire on legitimate polish output
// (punctuation, casing, conjunction merges, list conversion, the
// self-correction patterns intuitive mode applies).

import { describe, expect, it } from "vitest";
import { __testing } from "@/lib/transcription/polish";

const { rejectionReason, novelContentReason, contentWords } = __testing;

describe("contentWords (tokenization helper)", () => {
  it("drops stopwords, short tokens, and pure-digit tokens", () => {
    expect(contentWords("I will be at your house at 2pm")).toEqual(["house", "2pm"]);
  });

  it("collapses apostrophes so I'm and im tokenize identically", () => {
    expect(contentWords("I'm running late")).toEqual(["running", "late"]);
    expect(contentWords("im running late")).toEqual(["running", "late"]);
  });

  it("digit-only tokens (list markers, time formats) are not content", () => {
    expect(contentWords("step 1. step 2. step 3.")).toEqual(["step", "step", "step"]);
    expect(contentWords("meeting at 3:30 with the team")).toEqual(["meeting", "team"]);
  });
});

describe("novelContentReason — the anti-answer structural rule", () => {
  it("returns null when input and output share their content words", () => {
    expect(
      novelContentReason(
        "what's the weather like in tokyo today",
        "What's the weather like in Tokyo today?"
      )
    ).toBeNull();
  });

  it("returns null when polish only adds punctuation + casing", () => {
    expect(
      novelContentReason(
        "send an email to john saying im running late",
        "Send an email to John saying I'm running late."
      )
    ).toBeNull();
  });

  it("returns null when intuitive mode merges with connectives", () => {
    // "but" and "so" are stopword-filtered, so they don't contribute
    // to the novel count.
    expect(
      novelContentReason(
        "i went to the store. it was closed. i came back home.",
        "I went to the store, but it was closed, so I came back home."
      )
    ).toBeNull();
  });

  it("returns null when intuitive mode converts to a numbered list", () => {
    // Digit tokens are filtered, so "1.", "2.", "3." don't count as novel.
    expect(
      novelContentReason(
        "first migrate the database second update the api endpoints third deploy the new frontend",
        "1. Migrate the database. 2. Update the API endpoints. 3. Deploy the new frontend."
      )
    ).toBeNull();
  });

  it("returns null when intuitive mode collapses a self-correction", () => {
    expect(
      novelContentReason(
        "i will be at your house at 2pm i mean ill be there at 3 30 be ready",
        "I'll be there at 3:30. Be ready."
      )
    ).toBeNull();
  });

  it("REJECTS the single-word math answer slip (the original bug)", () => {
    const reason = novelContentReason("what is two plus two", "What is two plus two? Four.");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/novel_content/);
    expect(reason).toContain("four");
  });

  it("REJECTS a trivia answer appended to the question", () => {
    const reason = novelContentReason(
      "what is the capital of australia",
      "What is the capital of Australia? Canberra."
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/novel_content/);
    expect(reason).toContain("canberra");
  });

  it("REJECTS an explanation produced for an 'explain' prompt", () => {
    const reason = novelContentReason(
      "explain how photosynthesis works in plants",
      "Photosynthesis is how plants convert sunlight, water, and carbon dioxide into glucose and oxygen."
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/novel_content/);
  });

  it("REJECTS an answer that adds 'yes' to a yes/no question", () => {
    const reason = novelContentReason(
      "is the sky blue",
      "Is the sky blue? Yes."
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/novel_content/);
  });

  it("REJECTS the 'helpful suggestion' failure mode", () => {
    const reason = novelContentReason(
      "what should i do about my coworker who is always late",
      "What should I do about my coworker who is always late? Have a direct conversation with them."
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/novel_content/);
  });

  it("returns null when output is empty (degenerate; handled elsewhere)", () => {
    expect(novelContentReason("anything", "")).toBeNull();
  });
});

describe("rejectionReason — full backstop integration", () => {
  it("does not reject a well-formed polish output", () => {
    expect(
      rejectionReason(
        "tell me about the history of rome",
        "Tell me about the history of Rome."
      )
    ).toBeNull();
  });

  it("rejects the math-answer regression even when length is OK", () => {
    // 20 char input → 26 char output (1.3x), so length check passes;
    // novel-content check is what catches it.
    const r = rejectionReason("what is two plus two", "What is two plus two? Four.");
    expect(r).not.toBeNull();
    expect(r).toMatch(/novel_content/);
  });

  it("still rejects on length blow-up (existing 2x rule)", () => {
    const r = rejectionReason(
      "hi",
      "Hi! Here's a longer response that the model produced — way past 2x."
    );
    expect(r).not.toBeNull();
    // Could trip either output_too_long or assistant_preamble — both
    // are legitimate rejection signals for this input.
    expect(r).toMatch(/output_too_long|assistant_preamble/);
  });

  it("still rejects on assistant preamble (existing rule)", () => {
    // Longer input so the output_too_long check doesn't preempt the
    // preamble check — both are legitimate rejection signals, but we
    // want to verify the preamble rule fires when length is OK.
    const r = rejectionReason(
      "please review the design doc and let me know what you think when you have a moment",
      "Sure, please review the design doc and let me know what you think when you have a moment."
    );
    expect(r).not.toBeNull();
    expect(r).toMatch(/assistant_preamble/);
  });
});
