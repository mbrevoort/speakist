#!/usr/bin/env node
//
// Polish regression harness.
//
// Runs every fixture in `src/lib/transcription/polish-fixtures.ts`
// against `polishWithApiKey()` (env-free Groq path) and reports
// per-case pass/fail plus aggregate metrics. Use it to:
//
//   * Validate prompt changes don't regress any existing case
//   * A/B different models (--model openai/gpt-oss-20b)
//   * A/B different prompts (--system-prompt-file path/to/alt.txt)
//   * Measure rejection rate before/after a change (-n 5 averages over
//     5 runs per case to smooth out provider noise)
//
// Auth: needs a Groq API key. Reads from $GROQ_API_KEY in the
// environment — same key your Worker uses in production. The DB-side
// override path (resolveProviderKey) isn't exercised because this is
// the env-free function.
//
// Usage:
//   GROQ_API_KEY=... pnpm bench:polish
//   GROQ_API_KEY=... pnpm bench:polish -- --model openai/gpt-oss-20b -n 3
//   GROQ_API_KEY=... pnpm bench:polish -- --only weather-question
//   GROQ_API_KEY=... pnpm bench:polish -- --mode intuitive
//
// Output:
//   * Per-case line: PASS/FAIL/REJECTED, latency, expectation results
//   * Aggregate: overall pass rate, rejection rate, p50/p95 latency,
//     per-mode breakdown.

import { polishWithApiKey, bakedInPromptForMode, POLISH_MODEL } from "../src/lib/transcription/polish";
import {
  POLISH_FIXTURES,
  preambleBannedList,
  type PolishExpectation,
  type PolishFixture,
} from "../src/lib/transcription/polish-fixtures";
import { readFileSync } from "node:fs";

interface CliArgs {
  model: string;
  iterations: number;
  only?: string;
  mode?: "intuitive" | "prescriptive";
  /** Filter to fixtures of one tier. Default 'all'. `baseline` is
   *  what the shipped default-polish-prompts.ts should pass;
   *  `advanced` is the regression bench for the iterated active
   *  row in polish_prompt_versions. */
  tier?: "baseline" | "advanced" | "all";
  systemPromptFileIntuitive?: string;
  systemPromptFilePrescriptive?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: POLISH_MODEL,
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
      case "--mode":
        args.mode = argv[++i] as "intuitive" | "prescriptive";
        break;
      case "--tier":
        args.tier = argv[++i] as "baseline" | "advanced" | "all";
        if (!["baseline", "advanced", "all"].includes(args.tier!)) {
          console.error(`--tier must be baseline | advanced | all`);
          process.exit(2);
        }
        break;
      case "--system-prompt-file-intuitive":
        args.systemPromptFileIntuitive = argv[++i];
        break;
      case "--system-prompt-file-prescriptive":
        args.systemPromptFilePrescriptive = argv[++i];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
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

function printHelp(): void {
  console.log(`Usage: pnpm bench:polish -- [flags]

Flags:
  --model <id>                  Model to bench (default: ${POLISH_MODEL})
  -n, --iterations <n>          Run each case n times (default: 1) — averages out
                                provider variance and surfaces flaky cases
  --only <name>                 Run only one fixture by its 'name' field
  --mode <intuitive|prescriptive>  Run only fixtures of this mode
  --tier <baseline|advanced|all>   Filter by tier; default 'all'. 'baseline'
                                   is the subset the shipped distilled defaults
                                   should pass; 'advanced' is the regression
                                   bench for the iterated active row in
                                   polish_prompt_versions.
  --system-prompt-file-intuitive <path>     Override the intuitive system prompt
  --system-prompt-file-prescriptive <path>  Override the prescriptive system prompt

Env:
  GROQ_API_KEY  required — passed straight to the Groq /chat/completions endpoint.
`);
}

interface CaseResult {
  fixture: PolishFixture;
  iteration: number;
  applied: boolean;
  output: string;
  latencyMs: number;
  errorReason?: string;
  failedExpectations: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY not set in env.");
    process.exit(1);
  }

  // Optional prompt overrides — handy for A/B'ing prompt rewrites
  // without touching polish.ts.
  const promptIntuitive = args.systemPromptFileIntuitive
    ? readFileSync(args.systemPromptFileIntuitive, "utf-8")
    : bakedInPromptForMode("intuitive");
  const promptPrescriptive = args.systemPromptFilePrescriptive
    ? readFileSync(args.systemPromptFilePrescriptive, "utf-8")
    : bakedInPromptForMode("prescriptive");

  // Filter fixture list by --only / --mode / --tier. Default tier
  // is 'all' so existing invocations keep their behavior; the
  // baseline/advanced split is opt-in.
  const tier = args.tier ?? "all";
  const fixtures = POLISH_FIXTURES.filter((f) => {
    if (args.only && f.name !== args.only) return false;
    if (args.mode && f.mode !== args.mode) return false;
    if (tier !== "all") {
      const fixtureTier = f.tier ?? "advanced";
      if (fixtureTier !== tier) return false;
    }
    return true;
  });
  if (fixtures.length === 0) {
    console.error("No fixtures matched the filters.");
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s) × ${args.iterations} iteration(s)`);
  console.log(`  model:  ${args.model}`);
  console.log(`  prompt: ${args.systemPromptFileIntuitive || args.systemPromptFilePrescriptive ? "OVERRIDE" : "baked-in"}`);
  console.log("");

  const results: CaseResult[] = [];

  for (const f of fixtures) {
    const systemPrompt = f.mode === "intuitive" ? promptIntuitive : promptPrescriptive;
    for (let iter = 1; iter <= args.iterations; iter++) {
      // Groq's free tier caps `llama-3.1-8b-instant` at 6000 TPM. Our
      // system prompt is ~3000 tokens so without backoff every other
      // call hits 429. Retry-with-jittered-backoff keeps the suite
      // running unattended.
      let r = await polishWithApiKey({
        apiKey,
        model: args.model,
        systemPrompt,
        rawText: f.input,
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
        r = await polishWithApiKey({
          apiKey,
          model: args.model,
          systemPrompt,
          rawText: f.input,
        });
      }
      const failed = checkExpectations(f, r.text, r.applied);
      results.push({
        fixture: f,
        iteration: iter,
        applied: r.applied,
        output: r.text,
        latencyMs: r.latencyMs,
        errorReason: r.errorReason,
        failedExpectations: failed,
      });

      const status =
        failed.length === 0 && r.applied
          ? "PASS"
          : !r.applied
          ? "REJECT"
          : "FAIL";
      const itLabel = args.iterations > 1 ? ` [${iter}/${args.iterations}]` : "";
      console.log(
        `  ${status.padEnd(6)}  ${f.mode.padEnd(12)}  ${f.name.padEnd(32)}  ` +
          `${String(r.latencyMs).padStart(4)}ms${itLabel}`
      );
      if (status !== "PASS") {
        if (r.errorReason) console.log(`           reason: ${r.errorReason}`);
        if (failed.length > 0) console.log(`           failed: ${failed.join("; ")}`);
        console.log(`           input:  ${truncate(f.input, 100)}`);
        console.log(`           output: ${truncate(r.text, 100)}`);
      }
    }
  }

  // ---- Aggregate ----------------------------------------------------------
  console.log("");
  console.log(`Aggregate (${results.length} runs across ${fixtures.length} cases):`);

  const total = results.length;
  const passes = results.filter(
    (r) => r.applied && r.failedExpectations.length === 0
  ).length;
  const rejects = results.filter((r) => !r.applied).length;
  const fails = total - passes - rejects;

  console.log(`  pass rate:      ${passes}/${total}  (${pct(passes, total)})`);
  console.log(`  rejection rate: ${rejects}/${total}  (${pct(rejects, total)})`);
  console.log(`  fail rate:      ${fails}/${total}  (${pct(fails, total)})`);

  const lats = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`  latency p50:    ${pickPercentile(lats, 0.5)}ms`);
  console.log(`  latency p95:    ${pickPercentile(lats, 0.95)}ms`);

  // Per-mode breakdown — useful when intuitive and prescriptive
  // diverge in quality.
  for (const mode of ["intuitive", "prescriptive"] as const) {
    const modeResults = results.filter((r) => r.fixture.mode === mode);
    if (modeResults.length === 0) continue;
    const modePasses = modeResults.filter(
      (r) => r.applied && r.failedExpectations.length === 0
    ).length;
    console.log(
      `  ${mode.padEnd(12)} pass: ${modePasses}/${modeResults.length} (${pct(
        modePasses,
        modeResults.length
      )})`
    );
  }

  // Failure-mode histogram — which kind of error is biting us.
  const reasons = new Map<string, number>();
  for (const r of results) {
    if (r.applied && r.failedExpectations.length === 0) continue;
    const key =
      r.errorReason?.split(":")[0] ??
      (r.failedExpectations[0]?.split(":")[0] ?? "unknown");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    console.log("");
    console.log("  failure modes:");
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(3)}  ${reason}`);
    }
  }

  // Non-zero exit if any case failed — lets CI gate on the suite.
  if (fails > 0 || rejects > 0) process.exit(1);
}

function checkExpectations(
  f: PolishFixture,
  output: string,
  applied: boolean
): string[] {
  const failed: string[] = [];
  for (const expect of f.expects) {
    const failure = checkOne(expect, output, applied, f.input);
    if (failure) failed.push(failure);
  }
  return failed;
}

function checkOne(
  expect: PolishExpectation,
  output: string,
  applied: boolean,
  input: string
): string | null {
  switch (expect.kind) {
    case "no_assistant_preamble": {
      // Mirror the production-side false-positive guard: if the
      // polished output's first word matches the input's first word,
      // the model is just echoing the user's start, not preambling.
      // (See `rejectionReason` in polish.ts.)
      const firstOutputWord = output.toLowerCase().match(/^[a-z]+/)?.[0];
      const firstInputWord = input.toLowerCase().match(/^[a-z]+/)?.[0];
      const echoesInputStart =
        !!firstOutputWord && firstOutputWord === firstInputWord;
      const lower = output.toLowerCase().trimStart();
      const banned = preambleBannedList();
      for (const p of banned) {
        if (lower.startsWith(p)) {
          if (echoesInputStart) continue;
          return `assistant_preamble: starts with "${p}"`;
        }
      }
      return null;
    }
    case "must_contain": {
      const haystack = expect.case_insensitive ? output.toLowerCase() : output;
      for (const sub of expect.substrings) {
        const needle = expect.case_insensitive ? sub.toLowerCase() : sub;
        if (!haystack.includes(needle)) {
          return `must_contain: missing "${sub}"`;
        }
      }
      return null;
    }
    case "must_not_contain": {
      const haystack = expect.case_insensitive ? output.toLowerCase() : output;
      for (const sub of expect.substrings) {
        const needle = expect.case_insensitive ? sub.toLowerCase() : sub;
        if (haystack.includes(needle)) {
          return `must_not_contain: contains "${sub}"`;
        }
      }
      return null;
    }
    case "max_length_ratio": {
      if (input.length === 0) return null;
      const ratio = output.length / input.length;
      if (ratio > expect.ratio) {
        return `max_length_ratio: ${ratio.toFixed(2)} > ${expect.ratio}`;
      }
      return null;
    }
    case "must_be_applied":
      return applied ? null : `must_be_applied: rejected`;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((100 * n) / d).toFixed(1)}%`;
}

function pickPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("bench-polish failed:", err);
  process.exit(1);
});
