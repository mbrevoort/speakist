#!/usr/bin/env node
//
// Classifier regression harness.
//
// Runs every fixture in `src/lib/transcription/classifier-fixtures.ts`
// against `classifyWithApiKey()` (env-free Groq path) and reports
// per-case pass/fail + aggregate accuracy + per-class confusion.
//
// Modeled on `bench-polish.ts` — same shape, same rate-limit retry
// behavior, same CLI conventions. Cheap to run (~$0.001 for the
// full ~17-case fixture set at the default 1 iteration).
//
// Auth: needs a Groq API key. Reads from $GROQ_API_KEY.
//
// Usage:
//   GROQ_API_KEY=... pnpm bench:classifier
//   pnpm bench:classifier -- --only kubernetes-capitalization
//   pnpm bench:classifier -- -n 3   (smoke out flaky cases)
//   pnpm bench:classifier -- --model openai/gpt-oss-20b   (A/B alternates)

import {
  classifyWithApiKey,
  CLASSIFIER_MODEL,
} from "../src/lib/transcription/classifier";
import {
  CLASSIFIER_FIXTURES,
  type ClassifierFixture,
} from "../src/lib/transcription/classifier-fixtures";

interface CliArgs {
  model: string;
  iterations: number;
  only?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: CLASSIFIER_MODEL,
    iterations: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--model":
        args.model = argv[++i];
        break;
      case "-n":
      case "--iterations":
        args.iterations = parseInt(argv[++i], 10);
        break;
      case "--only":
        args.only = argv[++i];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm bench:classifier [-- flags]

Flags:
  --model <id>            Model to bench (default: ${CLASSIFIER_MODEL})
  -n, --iterations <n>    Run each case n times (default: 1)
  --only <name>           Run only one fixture by its 'name' field

Env:
  GROQ_API_KEY            required — passed straight to Groq's
                          /chat/completions endpoint.

The classifier prompt is baked into classifier.ts — there's no
override mechanism today. To A/B prompt variants, edit
classifier.ts on a branch and re-run the bench against the same
fixtures.
`);
}

interface CaseResult {
  fixture: ClassifierFixture;
  iteration: number;
  add: boolean;
  category: string;
  reason: string;
  applied: boolean;
  errorReason?: string;
  latencyMs: number;
  passed: boolean;
  failure?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY not set in env.");
    process.exit(1);
  }

  const fixtures = args.only
    ? CLASSIFIER_FIXTURES.filter((f) => f.name === args.only)
    : CLASSIFIER_FIXTURES;
  if (fixtures.length === 0) {
    console.error("No fixtures matched the filter.");
    process.exit(1);
  }

  console.log(
    `Running ${fixtures.length} fixture(s) × ${args.iterations} iteration(s)`
  );
  console.log(`  model: ${args.model}`);
  console.log("");

  const results: CaseResult[] = [];

  for (const f of fixtures) {
    for (let iter = 1; iter <= args.iterations; iter++) {
      // Same retry-with-jittered-backoff as the polish bench — Groq's
      // free-tier TPM cap will throttle this at moderate fixture
      // volumes if we don't yield.
      let r = await classifyWithApiKey({
        apiKey,
        model: args.model,
        systemPrompt: "", // unused at this layer; classifier.ts owns it
        input: { find: f.find, replacement: f.replacement, context: f.context },
      });
      let retries = 0;
      while (
        !r.applied &&
        r.errorReason?.startsWith("http_429") &&
        retries < 4
      ) {
        const backoff = 4_000 * Math.pow(1.5, retries) + Math.random() * 1_000;
        await sleep(backoff);
        retries++;
        r = await classifyWithApiKey({
          apiKey,
          model: args.model,
          systemPrompt: "",
          input: { find: f.find, replacement: f.replacement, context: f.context },
        });
      }

      const failure = checkExpectation(f, r);
      const passed = failure === null && r.applied;
      results.push({
        fixture: f,
        iteration: iter,
        add: r.add,
        category: r.category,
        reason: r.reason,
        applied: r.applied,
        errorReason: r.errorReason,
        latencyMs: r.latencyMs,
        passed,
        failure: failure ?? undefined,
      });

      const status = passed ? "PASS" : r.applied ? "FAIL" : "ERROR";
      const itLabel = args.iterations > 1 ? ` [${iter}/${args.iterations}]` : "";
      const decision = `${r.add ? "add" : "skip"}/${r.category}`;
      console.log(
        `  ${status.padEnd(5)}  ${decision.padEnd(28)}  ${f.name.padEnd(36)}  ${String(r.latencyMs).padStart(4)}ms${itLabel}`
      );
      if (!passed) {
        if (r.errorReason) console.log(`         reason:    ${r.errorReason}`);
        if (failure) console.log(`         expected:  ${failure}`);
        console.log(`         find:      ${truncate(f.find, 80)}`);
        console.log(`         repl:      ${truncate(f.replacement, 80)}`);
        if (r.applied) {
          console.log(`         model:     add=${r.add} category=${r.category}`);
          console.log(`         said:      ${truncate(r.reason, 100)}`);
        }
      }
    }
  }

  // ---- Aggregate ---------------------------------------------------------
  console.log("");
  console.log(`Aggregate (${results.length} runs across ${fixtures.length} cases):`);

  const passes = results.filter((r) => r.passed).length;
  const errors = results.filter((r) => !r.applied).length;
  const fails = results.length - passes - errors;
  console.log(`  pass rate:      ${passes}/${results.length}  (${pct(passes, results.length)})`);
  console.log(`  fail rate:      ${fails}/${results.length}  (${pct(fails, results.length)})`);
  console.log(`  error rate:     ${errors}/${results.length}  (${pct(errors, results.length)})`);

  const lats = results.filter((r) => r.applied).map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`  latency p50:    ${pickPct(lats, 0.5)}ms`);
  console.log(`  latency p95:    ${pickPct(lats, 0.95)}ms`);

  // Confusion summary — when the model said "add" vs the fixture's
  // expectAdd. Useful to spot a one-directional bias (e.g. the prompt
  // is too eager / too conservative).
  let truePos = 0, falsePos = 0, trueNeg = 0, falseNeg = 0;
  for (const r of results) {
    if (!r.applied) continue;
    if (r.fixture.expectAdd && r.add) truePos++;
    else if (r.fixture.expectAdd && !r.add) falseNeg++;
    else if (!r.fixture.expectAdd && r.add) falsePos++;
    else trueNeg++;
  }
  console.log("");
  console.log("  confusion (expected vs actual ADD):");
  console.log(`                    actual: ADD   actual: SKIP`);
  console.log(`    expected ADD:   ${String(truePos).padStart(3)}            ${String(falseNeg).padStart(3)}`);
  console.log(`    expected SKIP:  ${String(falsePos).padStart(3)}            ${String(trueNeg).padStart(3)}`);
  console.log(
    `    precision (add): ${truePos === 0 ? "n/a" : ((100 * truePos) / (truePos + falsePos)).toFixed(1) + "%"}` +
      ` — fraction of model "add" verdicts that are correct`
  );
  console.log(
    `    recall (add):    ${truePos === 0 ? "n/a" : ((100 * truePos) / (truePos + falseNeg)).toFixed(1) + "%"}` +
      ` — fraction of true-vocab pairs the model caught`
  );

  if (fails > 0 || errors > 0) process.exit(1);
}

function checkExpectation(
  f: ClassifierFixture,
  r: { add: boolean; category: string; applied: boolean }
): string | null {
  if (!r.applied) return null; // separately reported as ERROR
  if (r.add !== f.expectAdd) {
    return `expected add=${f.expectAdd}, got add=${r.add}`;
  }
  if (f.mustCategory && r.category !== f.mustCategory) {
    return `expected category=${f.mustCategory}, got ${r.category}`;
  }
  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((100 * n) / d).toFixed(1)}%`;
}

function pickPct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("bench-classifier failed:", err);
  process.exit(1);
});
