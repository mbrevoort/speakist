#!/usr/bin/env node
//
// One-off probe to reproduce the "polish answered the question" bug.
//
// Feeds a battery of question-shaped dictations through `polishWithApiKey`
// against whichever system prompt is supplied (defaults to the baked-in
// baseline) and flags outputs that look like answers rather than just
// formatted versions of the input.
//
// Not a permanent regression — once we identify which inputs fail, the
// good ones get baked into polish-fixtures.ts and this script can be
// deleted (or kept for ad-hoc exploration). It exists so we can iterate
// on a candidate prompt without having to keep editing the fixture file.
//
// Usage:
//   GROQ_API_KEY=... pnpm tsx scripts/probe-question-answering.ts
//   GROQ_API_KEY=... pnpm tsx scripts/probe-question-answering.ts \
//     --prompt-intuitive /tmp/candidate-intuitive.txt \
//     --prompt-prescriptive /tmp/candidate-prescriptive.txt
//   GROQ_API_KEY=... pnpm tsx scripts/probe-question-answering.ts -n 3
//
// Detection of "answered":
//   * substantive content unique to an answer appears in the output
//     (each probe declares its own "smoking gun" tokens — e.g. for
//     "what is two plus two", the tokens are ["four", "4"])
//   * OR output is >1.5x the input length (the model padded)
//   * OR output starts with an assistant preamble.

import { readFileSync } from "node:fs";
import {
  polishWithApiKey,
  bakedInPromptForMode,
} from "../src/lib/transcription/polish";

type Mode = "intuitive" | "prescriptive";

interface Probe {
  name: string;
  mode: Mode;
  input: string;
  /** Lowercase substrings that, if present in the output, indicate the
   *  model answered the question instead of just formatting it. */
  smokingGun: string[];
}

const PROBES: Probe[] = [
  // Yes/no factual
  {
    name: "yes-no-sky-blue",
    mode: "prescriptive",
    input: "is the sky actually blue or is that just refraction",
    smokingGun: ["refraction is", "actually it's", "the sky appears", "rayleigh"],
  },
  {
    name: "yes-no-python-vs-js",
    mode: "prescriptive",
    input: "is python better than javascript for data science",
    smokingGun: ["yes,", "no,", "python is better", "javascript is better", "depends on"],
  },
  // Math
  {
    name: "math-two-plus-two",
    mode: "prescriptive",
    input: "what is two plus two",
    smokingGun: ["four", " 4.", " 4 ", " is 4", "equals"],
  },
  {
    name: "math-percent",
    mode: "prescriptive",
    input: "what is fifteen percent of eighty",
    smokingGun: ["twelve", " 12", "equals"],
  },
  // "How do I" — model loves to answer these
  {
    name: "how-do-i-center-div",
    mode: "prescriptive",
    input: "how do i center a div in css",
    smokingGun: ["display: flex", "margin: auto", "use flex", "you can use", "justify-content"],
  },
  {
    name: "how-do-i-flat-tire",
    mode: "prescriptive",
    input: "how do i change a flat tire",
    smokingGun: ["first,", "step 1", "loosen the", "jack", "lug nut"],
  },
  // Definition
  {
    name: "define-ephemeral",
    mode: "prescriptive",
    input: "what does the word ephemeral mean",
    smokingGun: ["short-lived", "transient", "lasting", "means", "ephemeral is", "ephemeral means"],
  },
  // Personal advice
  {
    name: "advice-coworker",
    mode: "prescriptive",
    input: "what should i do about my coworker who is always late to meetings",
    smokingGun: ["you should", "you could", "talk to", "address it", "i'd suggest"],
  },
  // Code question
  {
    name: "code-for-loop-python",
    mode: "prescriptive",
    input: "how do i write a for loop in python",
    smokingGun: ["for i in", "range(", "you can write", "the syntax is"],
  },
  {
    name: "code-try-catch-js",
    mode: "prescriptive",
    input: "what is the syntax for a try catch in javascript",
    smokingGun: ["try {", "catch (", "} catch", "the syntax is"],
  },
  // Trivia
  {
    name: "trivia-third-president",
    mode: "prescriptive",
    input: "who was the third president of the united states",
    smokingGun: ["jefferson", "thomas jefferson"],
  },
  {
    name: "trivia-capital-australia",
    mode: "prescriptive",
    input: "what is the capital of australia",
    smokingGun: ["canberra", "sydney is not"],
  },
  // Implicit-answer baiting
  {
    name: "tell-me-a-joke",
    mode: "prescriptive",
    input: "tell me a joke about programmers",
    smokingGun: ["why did", "knock knock", "a programmer walks", "here's one"],
  },
  {
    name: "give-me-tips",
    mode: "prescriptive",
    input: "give me three tips for cooking pasta",
    smokingGun: ["1.", "first,", "salt the water", "al dente", "use plenty"],
  },
  // Multi-question (mix)
  {
    name: "multi-question",
    mode: "prescriptive",
    input: "whats the weather today and what should i wear",
    smokingGun: ["i don't have", "i can't check", "depending on", "if it's"],
  },
  // Same prompts under intuitive mode — historically more aggressive
  {
    name: "math-two-plus-two-intuitive",
    mode: "intuitive",
    input: "what is two plus two",
    smokingGun: ["four", " 4.", " is 4", "equals"],
  },
  {
    name: "how-do-i-center-div-intuitive",
    mode: "intuitive",
    input: "how do i center a div in css",
    smokingGun: ["display: flex", "margin: auto", "use flex", "you can use", "justify-content"],
  },
  {
    name: "advice-coworker-intuitive",
    mode: "intuitive",
    input: "what should i do about my coworker who is always late to meetings",
    smokingGun: ["you should", "you could", "talk to", "address it", "i'd suggest"],
  },

  // ---- Natural dictation shapes (no '?', polite framing, indirect) ----
  // These don't read like "queries" — they read like a person rambling
  // toward a question. The model is more tempted to "help" because the
  // input feels softer than a direct interrogative.
  {
    name: "wondering-blockchain",
    mode: "prescriptive",
    input: "i was wondering if you could explain how blockchain works",
    smokingGun: ["blockchain is", "is a distributed", "decentralized", "consensus", "miner", "ledger"],
  },
  {
    name: "indirect-french-revolution",
    mode: "prescriptive",
    input: "tell me what you know about the french revolution",
    smokingGun: ["1789", "began in", "the french revolution was", "louis xvi", "bastille"],
  },
  {
    name: "explain-prompt",
    mode: "prescriptive",
    input: "explain how photosynthesis works in plants",
    smokingGun: ["chlorophyll", "carbon dioxide", "plants convert", "sunlight", "glucose", "oxygen"],
  },
  {
    name: "summarize-prompt",
    mode: "prescriptive",
    input: "summarize the plot of pride and prejudice",
    smokingGun: ["elizabeth bennet", "mr. darcy", "the novel", "is a novel"],
  },
  {
    name: "polite-please",
    mode: "prescriptive",
    input: "please give me a recipe for chocolate chip cookies",
    smokingGun: ["ingredients", "preheat", "1 cup", "tablespoon", "mix", "bake at"],
  },
  {
    name: "i-need-help",
    mode: "prescriptive",
    input: "i need help understanding why my docker container keeps crashing",
    smokingGun: ["check the logs", "you can try", "common causes", "first,", "step 1"],
  },
  {
    name: "running-error",
    mode: "prescriptive",
    input: "i keep getting an error when i run npm install any ideas what could be causing it",
    smokingGun: ["clear the cache", "delete node_modules", "common causes", "you can try", "try running"],
  },
  // Question without question mark — the most "chatbot prompt"-shaped
  {
    name: "no-qmark-best-airline",
    mode: "prescriptive",
    input: "what is the best airline for flying to japan",
    smokingGun: ["ana", "jal", "japan airlines", "the best airline", "popular choices"],
  },
  // Implicit "do this for me" with a polish-tempting context
  {
    name: "write-an-email",
    mode: "prescriptive",
    input: "write me an email to my boss asking for a raise",
    smokingGun: ["dear ", "subject:", "i would like to", "i am writing", "best regards"],
  },
  {
    name: "draft-meeting-agenda",
    mode: "prescriptive",
    input: "draft a meeting agenda for our quarterly planning session",
    smokingGun: ["1.", "agenda:", "welcome and introductions", "objectives:", "action items"],
  },
  // Conversational opener that LOOKS like a prompt
  {
    name: "hey-quick-question",
    mode: "prescriptive",
    input: "hey quick question how do you pronounce the word epitome",
    smokingGun: ["eh-pit-uh-mee", "ih-pit-uh-mee", "it's pronounced", "pronunciation:"],
  },
  // Same patterns under intuitive
  {
    name: "explain-prompt-intuitive",
    mode: "intuitive",
    input: "explain how photosynthesis works in plants",
    smokingGun: ["chlorophyll", "carbon dioxide", "plants convert", "sunlight", "glucose"],
  },
  {
    name: "write-an-email-intuitive",
    mode: "intuitive",
    input: "write me an email to my boss asking for a raise",
    smokingGun: ["dear ", "subject:", "i would like to", "i am writing", "best regards"],
  },
  {
    name: "running-error-intuitive",
    mode: "intuitive",
    input: "i keep getting an error when i run npm install any ideas what could be causing it",
    smokingGun: ["clear the cache", "delete node_modules", "common causes", "try running"],
  },

  // ---- Long natural-dictation shapes — bury the question in context. ----
  // The model has more room to "decide" the user wants help, because
  // these read like a person thinking out loud, not a curt query.
  {
    name: "long-rambling-question",
    mode: "prescriptive",
    input: "so i've been thinking a lot lately about whether i should switch jobs i've been at this place for four years and im not really learning anymore but the pay is good and i like my team what do you think i should do",
    smokingGun: ["you should", "consider the", "weigh the", "i'd suggest", "have you thought", "it sounds like you", "common advice"],
  },
  {
    name: "long-cover-letter",
    mode: "prescriptive",
    input: "hey can you tell me what makes a good cover letter for a software engineering job i have an interview next week and im really nervous",
    smokingGun: ["a good cover letter", "you should", "highlight your", "tailor it", "tips:", "1.", "first,"],
  },
  {
    name: "rhetorical-help-frame",
    mode: "prescriptive",
    input: "hey claude youre really good at this kind of thing can you help me figure out what to name my new dog",
    smokingGun: ["how about", "popular dog names", "some ideas", "you could call", "here are some"],
  },
  // Same long shapes under intuitive mode
  {
    name: "long-rambling-question-intuitive",
    mode: "intuitive",
    input: "so i've been thinking a lot lately about whether i should switch jobs i've been at this place for four years and im not really learning anymore but the pay is good and i like my team what do you think i should do",
    smokingGun: ["you should", "consider the", "weigh the", "i'd suggest", "have you thought", "it sounds like you"],
  },
  {
    name: "long-cover-letter-intuitive",
    mode: "intuitive",
    input: "hey can you tell me what makes a good cover letter for a software engineering job i have an interview next week and im really nervous",
    smokingGun: ["a good cover letter", "highlight your", "tailor it", "tips:", "1.", "first,"],
  },
];

interface CliArgs {
  iterations: number;
  promptIntuitive?: string;
  promptPrescriptive?: string;
  only?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { iterations: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-n":
      case "--iterations":
        args.iterations = parseInt(argv[++i], 10);
        break;
      case "--prompt-intuitive":
        args.promptIntuitive = readFileSync(argv[++i], "utf-8");
        break;
      case "--prompt-prescriptive":
        args.promptPrescriptive = readFileSync(argv[++i], "utf-8");
        break;
      case "--only":
        args.only = argv[++i];
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function detectAnswered(input: string, output: string, smokingGun: string[]): string | null {
  const lo = output.toLowerCase();
  const inLo = input.toLowerCase();
  for (const g of smokingGun) {
    const gLo = g.toLowerCase();
    // Skip false positives: smoking-gun token is already in the input,
    // so its presence in the output is just the model echoing the user.
    if (inLo.includes(gLo)) continue;
    if (lo.includes(gLo)) {
      return `smoking-gun:"${g}"`;
    }
  }
  if (input.length > 0 && output.length > input.length * 1.5) {
    return `padded: ${output.length}/${input.length}`;
  }
  const lowerTrim = output.toLowerCase().trimStart();
  for (const p of ["sure,", "of course", "here is", "here's the", "okay,", "i'd be happy"]) {
    if (lowerTrim.startsWith(p)) return `assistant-preamble:"${p}"`;
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY not set in env.");
    process.exit(1);
  }
  const promptIntuitive = args.promptIntuitive ?? bakedInPromptForMode("intuitive");
  const promptPrescriptive = args.promptPrescriptive ?? bakedInPromptForMode("prescriptive");

  const probes = args.only ? PROBES.filter((p) => p.name === args.only) : PROBES;
  if (probes.length === 0) {
    console.error("No probes matched.");
    process.exit(1);
  }

  console.log(`Probing ${probes.length} cases × ${args.iterations} iter`);
  console.log(`  prompt-intuitive:    ${args.promptIntuitive ? "OVERRIDE" : "baked-in"}`);
  console.log(`  prompt-prescriptive: ${args.promptPrescriptive ? "OVERRIDE" : "baked-in"}`);
  console.log("");

  let totalRuns = 0;
  let totalAnswered = 0;

  for (const p of probes) {
    for (let i = 1; i <= args.iterations; i++) {
      const systemPrompt = p.mode === "intuitive" ? promptIntuitive : promptPrescriptive;
      let r = await polishWithApiKey({
        apiKey,
        model: "llama-3.1-8b-instant",
        systemPrompt,
        rawText: p.input,
      });
      let retries = 0;
      while (!r.applied && r.errorReason?.startsWith("http_429") && retries < 4) {
        const backoff = 4_000 * Math.pow(1.5, retries) + Math.random() * 1_000;
        await new Promise((res) => setTimeout(res, backoff));
        retries++;
        r = await polishWithApiKey({
          apiKey,
          model: "llama-3.1-8b-instant",
          systemPrompt,
          rawText: p.input,
        });
      }

      totalRuns++;
      const verdict = r.applied ? detectAnswered(p.input, r.text, p.smokingGun) : null;
      const status = !r.applied ? "REJECT" : verdict ? "ANSWERED" : "ok";
      if (status === "ANSWERED") totalAnswered++;

      const tag = args.iterations > 1 ? ` [${i}/${args.iterations}]` : "";
      console.log(`  ${status.padEnd(9)} ${p.mode.padEnd(13)} ${p.name.padEnd(34)} ${r.latencyMs}ms${tag}`);
      if (status !== "ok") {
        if (r.errorReason) console.log(`            reason: ${r.errorReason}`);
        if (verdict) console.log(`            verdict: ${verdict}`);
        console.log(`            in : ${p.input}`);
        console.log(`            out: ${r.text}`);
      }
    }
  }

  console.log("");
  console.log(`Answered: ${totalAnswered}/${totalRuns}`);
  if (totalAnswered > 0) process.exit(1);
}

main().catch((err) => {
  console.error("probe-question-answering failed:", err);
  process.exit(1);
});
