#!/usr/bin/env node
//
// STT regression harness — A/B Deepgram vs Groq Whisper on real audio.
//
// Mirrors the shape of `bench-polish.ts` but operates one stage upstream:
// audio in, text out. Each fixture is a paired audio file + JSON sidecar
// under `scripts/bench-stt-fixtures/`. The harness loads every fixture,
// calls every enabled provider/model combination, and reports
// per-case + aggregate pass/fail and word-error rate (WER).
//
// **Fixture format** — see `scripts/bench-stt-fixtures/README.md` for
// the full schema. TL;DR: drop a `.wav`/`.mp3`/`.flac`/`.ogg` file and a
// same-name `.json` sidecar with `{ groundTruth, keyterms?, language?,
// expects? }` next to it. No central manifest to edit.
//
// **Optional polish pass** — `--polish` pipes the raw STT output through
// the polish LLM before scoring. Use this to answer: "does the polish
// pass mask the vocab-bleed, or does it propagate?"
//
// Auth: needs DEEPGRAM_API_KEY and/or GROQ_API_KEY in env. A provider
// without a key is skipped (the bench still runs for whichever providers
// are configured).
//
// Usage:
//   GROQ_API_KEY=... DEEPGRAM_API_KEY=... pnpm bench:stt
//   pnpm bench:stt -- --providers deepgram
//   pnpm bench:stt -- --providers groq --model whisper-large-v3
//   pnpm bench:stt -- --polish --polish-mode intuitive
//   pnpm bench:stt -- --only vocab-bleed-stripe
//   pnpm bench:stt -- -n 3   (3 iterations to smooth provider noise)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, basename } from "node:path";
import { deepgramAdapter } from "../src/lib/transcription/adapters/deepgram";
import { groqAdapter } from "../src/lib/transcription/adapters/groq";
import type { ProviderAdapter, TranscriptionInput } from "../src/lib/transcription/types";
import { polishWithApiKey, bakedInPromptForMode, POLISH_MODEL, type PolishMode } from "../src/lib/transcription/polish";

// ---- CLI -----------------------------------------------------------------

interface CliArgs {
  providers: string[];      // e.g. ["deepgram", "groq"]
  model?: string;           // overrides default for the chosen provider; only valid with --providers <single>
  only?: string;            // fixture name filter
  iterations: number;       // n runs per case
  polish: boolean;          // pipe STT output through polish before scoring
  polishMode: PolishMode;   // which polish prompt to use
  fixturesDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    providers: ["deepgram", "groq"],
    iterations: 1,
    polish: false,
    polishMode: "intuitive",
    fixturesDir: join(__dirname, "bench-stt-fixtures"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--providers":
        args.providers = argv[++i].split(",").map((s) => s.trim());
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--only":
        args.only = argv[++i];
        break;
      case "-n":
      case "--iterations":
        args.iterations = parseInt(argv[++i], 10);
        break;
      case "--polish":
        args.polish = true;
        break;
      case "--polish-mode":
        args.polishMode = argv[++i] as PolishMode;
        break;
      case "--fixtures-dir":
        args.fixturesDir = argv[++i];
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
  console.log(`Usage: pnpm bench:stt -- [flags]

Flags:
  --providers <list>           Comma-separated provider ids (default: deepgram,groq).
                               Skipped silently if API key not configured.
  --model <id>                 Override default model. Only valid with --providers <single>.
                               Defaults: deepgram=nova-3, groq=whisper-large-v3-turbo.
  --only <name>                Run only one fixture by its 'name' (basename without ext).
  -n, --iterations <n>         Run each case n times. Averages out provider noise.
  --polish                     Pipe STT output through the polish LLM before scoring.
                               Useful to see if polish hides the STT failure.
  --polish-mode <mode>         intuitive | prescriptive (default: intuitive).
  --fixtures-dir <path>        Override fixtures directory (default: scripts/bench-stt-fixtures).

Env:
  DEEPGRAM_API_KEY  required for deepgram provider (skipped silently if missing)
  GROQ_API_KEY      required for groq provider AND for --polish (skipped silently if missing)

Fixture format: see scripts/bench-stt-fixtures/README.md
`);
}

// ---- Fixture loading -----------------------------------------------------

interface SttExpectation {
  kind: "must_contain" | "must_not_contain" | "max_wer";
  // Discriminated union — at runtime we accept either substrings+case_insensitive
  // or ratio depending on `kind`. Keep validation light; bad sidecars surface
  // as a per-case error.
  substrings?: string[];
  case_insensitive?: boolean;
  ratio?: number;
}

interface SttFixture {
  /** Basename without extension. Used as the fixture identifier. */
  name: string;
  /** Absolute path to the audio file. */
  audioPath: string;
  /** Lowercased extension (".wav"/".mp3"/etc.) — used for Content-Type. */
  audioExt: string;
  /** Free-text description from the sidecar. */
  description: string;
  /** Expected transcription (lowercase prose, no punctuation requirements). */
  groundTruth: string;
  /** Vocab terms to send to the provider, mimicking real per-user vocab. */
  keyterms?: string[];
  /** ISO language code; omit for auto-detect. */
  language?: string;
  /** Structural assertions to check on the transcribed text. */
  expects: SttExpectation[];
}

const AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm"]);

function loadFixtures(dir: string): SttFixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`Cannot read fixtures dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fixtures: SttFixture[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    const name = basename(entry, ext);
    const audioPath = join(dir, entry);
    const sidecarPath = join(dir, `${name}.json`);
    let sidecar: Partial<SttFixture>;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    } catch (err) {
      console.warn(`[warn] skipping ${entry}: no readable sidecar ${name}.json (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!sidecar.groundTruth) {
      console.warn(`[warn] skipping ${entry}: sidecar missing 'groundTruth'`);
      continue;
    }
    fixtures.push({
      name,
      audioPath,
      audioExt: ext,
      description: sidecar.description ?? "",
      groundTruth: sidecar.groundTruth,
      keyterms: sidecar.keyterms,
      language: sidecar.language,
      expects: sidecar.expects ?? [],
    });
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".flac": return "audio/flac";
    case ".ogg": return "audio/ogg";
    case ".webm": return "audio/webm";
    case ".wav":
    default:
      return "audio/wav";
  }
}

// ---- Provider plumbing ---------------------------------------------------

interface ProviderConfig {
  adapter: ProviderAdapter;
  envKey: string;
  defaultModel: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  deepgram: {
    adapter: deepgramAdapter,
    envKey: "DEEPGRAM_API_KEY",
    defaultModel: "nova-3",
  },
  groq: {
    adapter: groqAdapter,
    envKey: "GROQ_API_KEY",
    defaultModel: "whisper-large-v3-turbo",
  },
};

async function runTranscription(
  cfg: ProviderConfig,
  apiKey: string,
  model: string,
  fixture: SttFixture
): Promise<{ text: string; latencyMs: number; errorReason?: string }> {
  const startedAt = Date.now();
  const audioBytes = readFileSync(fixture.audioPath);
  // Convert Buffer to ArrayBuffer (Buffer is a Uint8Array view, but
  // we want a clean ArrayBuffer to match TranscriptionInput).
  const audioBody = audioBytes.buffer.slice(
    audioBytes.byteOffset,
    audioBytes.byteOffset + audioBytes.byteLength
  );

  const input: TranscriptionInput = {
    providerId: cfg.adapter.id,
    model,
    audioBody,
    audioContentType: contentTypeForExt(fixture.audioExt),
    transcriptionClientId: `bench-${fixture.name}-${Date.now()}`,
    keyterms: fixture.keyterms,
    language: fixture.language,
    detectLanguage: !fixture.language,
    // Sensible defaults for the dictation use-case. Could be made
    // per-fixture if we ever need to bench the toggles themselves.
    dictation: true,
    fillerWords: false,
    measurements: false,
    profanityFilter: false,
  };

  const req = cfg.adapter.buildRequest(input, apiKey);
  let res: Response;
  try {
    res = await fetch(req, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return {
      text: "",
      latencyMs: Date.now() - startedAt,
      errorReason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    return {
      text: "",
      latencyMs: Date.now() - startedAt,
      errorReason: `http_${res.status}: ${body.slice(0, 200)}`,
    };
  }
  const out = await cfg.adapter.parseResponse(res);
  return { text: out.text, latencyMs: Date.now() - startedAt };
}

// ---- Scoring -------------------------------------------------------------

/**
 * Normalize a transcript for fair comparison: lowercase, strip punctuation
 * (which Deepgram adds via smart_format and Whisper sometimes doesn't),
 * collapse internal whitespace. We tokenize on whitespace for WER.
 */
function normalizeForScoring(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

/**
 * Word-Error Rate via Levenshtein on word arrays.
 * WER = (substitutions + deletions + insertions) / reference_word_count
 * Standard speech-recognition metric. Lower is better; 0 = perfect.
 */
function computeWER(reference: string, hypothesis: string): number {
  const ref = normalizeForScoring(reference);
  const hyp = normalizeForScoring(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  // Classic edit-distance DP. O(|ref|*|hyp|) which is fine for fixtures
  // up to a few hundred words.
  const m = ref.length;
  const n = hyp.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }
  return dp[m][n] / m;
}

function checkExpectations(f: SttFixture, output: string): string[] {
  const failed: string[] = [];
  for (const e of f.expects) {
    const failure = checkOne(e, output, f);
    if (failure) failed.push(failure);
  }
  return failed;
}

function checkOne(e: SttExpectation, output: string, f: SttFixture): string | null {
  switch (e.kind) {
    case "must_contain": {
      const haystack = e.case_insensitive ? output.toLowerCase() : output;
      for (const sub of e.substrings ?? []) {
        const needle = e.case_insensitive ? sub.toLowerCase() : sub;
        if (!haystack.includes(needle)) return `must_contain: missing "${sub}"`;
      }
      return null;
    }
    case "must_not_contain": {
      const haystack = e.case_insensitive ? output.toLowerCase() : output;
      for (const sub of e.substrings ?? []) {
        const needle = e.case_insensitive ? sub.toLowerCase() : sub;
        if (haystack.includes(needle)) return `must_not_contain: contains "${sub}"`;
      }
      return null;
    }
    case "max_wer": {
      const wer = computeWER(f.groundTruth, output);
      if (wer > (e.ratio ?? 1)) {
        return `max_wer: ${wer.toFixed(3)} > ${e.ratio}`;
      }
      return null;
    }
  }
}

// ---- Main ----------------------------------------------------------------

interface RunResult {
  fixture: SttFixture;
  provider: string;
  model: string;
  iteration: number;
  rawText: string;
  polishedText?: string;
  scoredText: string;   // whichever of raw/polished we score against
  latencyMs: number;
  polishLatencyMs?: number;
  errorReason?: string;
  wer: number;
  failedExpectations: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.model && args.providers.length !== 1) {
    console.error("--model requires --providers with a single provider");
    process.exit(2);
  }

  // Filter to configured providers (those with keys present).
  const activeProviders: { id: string; cfg: ProviderConfig; apiKey: string; model: string }[] = [];
  for (const id of args.providers) {
    const cfg = PROVIDER_CONFIGS[id];
    if (!cfg) {
      console.error(`Unknown provider: ${id}`);
      process.exit(2);
    }
    const apiKey = process.env[cfg.envKey];
    if (!apiKey) {
      console.warn(`[warn] ${id} skipped: ${cfg.envKey} not set`);
      continue;
    }
    activeProviders.push({
      id,
      cfg,
      apiKey,
      model: args.model ?? cfg.defaultModel,
    });
  }
  if (activeProviders.length === 0) {
    console.error("No providers configured. Set DEEPGRAM_API_KEY and/or GROQ_API_KEY.");
    process.exit(1);
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (args.polish && !groqApiKey) {
    console.error("--polish requires GROQ_API_KEY");
    process.exit(1);
  }
  const polishPrompt = args.polish ? bakedInPromptForMode(args.polishMode) : "";

  // Load fixtures.
  let fixtures: SttFixture[];
  try {
    fixtures = loadFixtures(args.fixturesDir);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (args.only) fixtures = fixtures.filter((f) => f.name === args.only);
  if (fixtures.length === 0) {
    console.error(`No fixtures found. Add audio files + sidecars under ${args.fixturesDir}`);
    console.error(`See ${args.fixturesDir}/README.md for the format.`);
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s) × ${activeProviders.length} provider(s) × ${args.iterations} iter(s)`);
  console.log(`  providers: ${activeProviders.map((p) => `${p.id}@${p.model}`).join(", ")}`);
  console.log(`  polish:    ${args.polish ? args.polishMode : "off"}`);
  console.log("");

  const results: RunResult[] = [];

  for (const f of fixtures) {
    for (const p of activeProviders) {
      for (let iter = 1; iter <= args.iterations; iter++) {
        const stt = await runTranscription(p.cfg, p.apiKey, p.model, f);
        let polishedText: string | undefined;
        let polishLatencyMs: number | undefined;
        let scoredText = stt.text;
        let polishErrorReason: string | undefined;
        if (args.polish && stt.text && groqApiKey) {
          const polishResult = await polishWithApiKey({
            apiKey: groqApiKey,
            model: POLISH_MODEL,
            systemPrompt: polishPrompt,
            rawText: stt.text,
          });
          polishedText = polishResult.text;
          polishLatencyMs = polishResult.latencyMs;
          scoredText = polishedText;
          if (!polishResult.applied) {
            polishErrorReason = `polish_${polishResult.errorReason}`;
          }
        }
        const wer = stt.text ? computeWER(f.groundTruth, scoredText) : 1;
        const failed = stt.text ? checkExpectations(f, scoredText) : [];
        const errorReason = stt.errorReason ?? polishErrorReason;

        results.push({
          fixture: f,
          provider: p.id,
          model: p.model,
          iteration: iter,
          rawText: stt.text,
          polishedText,
          scoredText,
          latencyMs: stt.latencyMs,
          polishLatencyMs,
          errorReason,
          wer,
          failedExpectations: failed,
        });

        const status =
          stt.errorReason ? "ERROR" :
          failed.length === 0 ? "PASS" : "FAIL";
        const itLabel = args.iterations > 1 ? ` [${iter}/${args.iterations}]` : "";
        const lat = polishLatencyMs ? `${stt.latencyMs}+${polishLatencyMs}ms` : `${stt.latencyMs}ms`;
        console.log(
          `  ${status.padEnd(5)}  ${p.id.padEnd(8)}  ${f.name.padEnd(32)}  ` +
          `wer=${wer.toFixed(3)}  ${lat.padStart(10)}${itLabel}`
        );
        if (status !== "PASS") {
          if (errorReason) console.log(`         reason:    ${errorReason}`);
          if (failed.length > 0) console.log(`         failed:    ${failed.join("; ")}`);
          console.log(`         ground:    ${truncate(f.groundTruth, 100)}`);
          if (polishedText !== undefined) {
            console.log(`         raw stt:   ${truncate(stt.text, 100)}`);
            console.log(`         polished:  ${truncate(polishedText, 100)}`);
          } else {
            console.log(`         output:    ${truncate(stt.text, 100)}`);
          }
        }
      }
    }
  }

  // ---- Aggregate per provider ----
  console.log("");
  console.log(`Aggregate (${results.length} runs):`);
  for (const p of activeProviders) {
    const pr = results.filter((r) => r.provider === p.id);
    const passes = pr.filter((r) => !r.errorReason && r.failedExpectations.length === 0).length;
    const errors = pr.filter((r) => r.errorReason).length;
    const validResults = pr.filter((r) => !r.errorReason);
    const meanWer = validResults.length > 0
      ? validResults.reduce((s, r) => s + r.wer, 0) / validResults.length
      : 0;
    const sttLats = pr.filter((r) => !r.errorReason).map((r) => r.latencyMs).sort((a, b) => a - b);
    console.log(`  ${p.id.padEnd(10)} ${p.model}`);
    console.log(`    pass:        ${passes}/${pr.length} (${pct(passes, pr.length)})`);
    console.log(`    errors:      ${errors}/${pr.length} (${pct(errors, pr.length)})`);
    console.log(`    mean WER:    ${meanWer.toFixed(3)}`);
    console.log(`    stt p50:     ${pickPct(sttLats, 0.5)}ms`);
    console.log(`    stt p95:     ${pickPct(sttLats, 0.95)}ms`);
  }

  // Non-zero exit if any case failed — CI gate friendly.
  const anyFail = results.some((r) => r.errorReason || r.failedExpectations.length > 0);
  if (anyFail) process.exit(1);
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

main().catch((err) => {
  console.error("bench-stt failed:", err);
  process.exit(1);
});
