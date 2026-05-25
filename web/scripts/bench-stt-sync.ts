#!/usr/bin/env node
//
// Pull bad-transcription feedback into local STT bench fixtures via the
// Speakist MCP server.
//
// The feedback corpus already pairs raw STT + user-corrected ground
// truth + (optionally) the original audio — exactly what we need to
// drive `bench-stt.ts`. Rather than rebuilding that elsewhere, this
// script calls /api/mcp with a service token, walks `list_feedback`,
// and writes audio + sidecar JSON pairs to `scripts/bench-stt-fixtures/`
// in the format the bench already understands.
//
// Idempotent: each feedback id maps to a single audio file +
// `feedback-<id>.json` sidecar; re-runs skip downloads when the audio
// is already cached locally, but always refresh the sidecar from the
// latest MCP response (so corrections to expected_text propagate).
//
// Auth + endpoint: pass `--endpoint <url>` and `--token <ssat_…>`, or
// set `SPEAKIST_MCP_ENDPOINT` and `SPEAKIST_MCP_TOKEN`. The service
// token only needs `feedback:read` scope — this script never mutates.
//
// Privacy: synced sidecars are gitignored by default (they may contain
// PII from the user's transcriptions). The bench-stt-fixtures/.gitignore
// excludes `feedback-*.json`; `git add -f` to commit a specific one.
//
// Usage:
//   pnpm bench:stt:sync
//   pnpm bench:stt:sync -- --endpoint https://speakist-dev.brevoortstudio.com --token ssat_...
//   pnpm bench:stt:sync -- --status new                # only newest un-triaged
//   pnpm bench:stt:sync -- --since 2026-04-01T00:00:00Z
//   pnpm bench:stt:sync -- --limit 50 --include-text-only
//   pnpm bench:stt:sync -- --dry-run

import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

interface CliArgs {
  endpoint: string;
  token: string;
  status: "new" | "reviewed" | "resolved" | "dismissed" | "proposed" | "all";
  since?: string;
  limit: number;
  includeTextOnly: boolean;
  output: string;
  dryRun: boolean;
  /** Default max_wer assertion ratio for auto-generated sidecars. */
  defaultMaxWer: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    endpoint: process.env.SPEAKIST_MCP_ENDPOINT ?? "",
    token: process.env.SPEAKIST_MCP_TOKEN ?? "",
    status: "all",
    limit: 200,
    includeTextOnly: false,
    output: join(__dirname, "bench-stt-fixtures"),
    dryRun: false,
    defaultMaxWer: 0.5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--endpoint":
        args.endpoint = argv[++i];
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--status":
        args.status = argv[++i] as CliArgs["status"];
        break;
      case "--since":
        args.since = argv[++i];
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10);
        break;
      case "--include-text-only":
        args.includeTextOnly = true;
        break;
      case "--output":
        args.output = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--default-max-wer":
        args.defaultMaxWer = parseFloat(argv[++i]);
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
  console.log(`Usage: pnpm bench:stt:sync -- [flags]

Pulls feedback rows from /api/mcp into local STT bench fixtures.

Flags:
  --endpoint <url>             MCP server base URL (e.g. https://speakist-dev.brevoortstudio.com).
                               Default: $SPEAKIST_MCP_ENDPOINT.
  --token <ssat_...>           Service token with feedback:read scope.
                               Default: $SPEAKIST_MCP_TOKEN. Mint at /admin/tokens.
  --status <bucket>            Filter by status (new|reviewed|resolved|dismissed|proposed|all).
                               Default: all.
  --since <iso>                Only pull rows created strictly after this UTC timestamp.
                               Use to incrementally advance a cursor across runs.
  --limit <n>                  Max rows to fetch (1–200; MCP server cap). Default: 200.
  --include-text-only          Also write sidecars for feedback rows with no shared audio.
                               These can't run in the STT bench but can drive a polish-only bench.
                               Default: skip text-only rows.
  --output <dir>               Where to write audio + sidecars.
                               Default: scripts/bench-stt-fixtures.
  --default-max-wer <ratio>    max_wer expectation seeded into each synced sidecar.
                               Default: 0.5 (generous; tighten by hand as fixtures stabilize).
  --dry-run                    List what would be synced; write nothing.

Env:
  SPEAKIST_MCP_ENDPOINT   default --endpoint
  SPEAKIST_MCP_TOKEN      default --token

After syncing, run \`pnpm bench:stt\` as usual — the bench harness scans
the same directory.
`);
}

// ---- MCP JSON-RPC client -------------------------------------------------

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

type ToolResult =
  | { content: Array<{ type: "text"; text: string }>; isError?: false }
  | { content: Array<{ type: "audio"; data: string; mimeType: string }>; isError?: false }
  | { isError: true; content: Array<{ type: "text"; text: string }> };

let nextRpcId = 1;

async function rpcCall<T>(args: {
  endpoint: string;
  token: string;
  method: string;
  params?: unknown;
}): Promise<T> {
  const body = {
    jsonrpc: "2.0" as const,
    id: nextRpcId++,
    method: args.method,
    params: args.params,
  };
  const url = args.endpoint.replace(/\/$/, "") + "/api/mcp";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new Error(`MCP response has neither result nor error`);
  }
  return json.result;
}

async function callTool(
  endpoint: string,
  token: string,
  name: string,
  args: unknown
): Promise<ToolResult> {
  const result = await rpcCall<ToolResult>({
    endpoint,
    token,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (result.isError) {
    const msg = result.content[0]?.text ?? "(no detail)";
    throw new Error(`tool ${name} returned isError: ${msg}`);
  }
  return result;
}

// ---- Tool-specific helpers (typed wrappers) ------------------------------

interface FeedbackListItem {
  id: string;
  created_at: string;
  user_email: string;
  org_name: string;
  status: string;
  failure_kind: string | null;
  provider: string;
  model: string;
  polish_applied: boolean;
  polish_mode: "intuitive" | "prescriptive" | null;
  audio_seconds: number | null;
  has_audio: boolean;
  polished_preview: string;
  expected_preview: string;
}

interface FeedbackFullRecord {
  id: string;
  created_at: string;
  user_email: string;
  org_name: string;
  transcription_client_id: string;
  raw_text: string;
  polished_text: string;
  expected_text: string;
  failure_kind: string | null;
  user_note: string | null;
  provider: string;
  model: string;
  polish_applied: boolean;
  polish_mode: "intuitive" | "prescriptive" | null;
  audio_seconds: number | null;
  has_audio: boolean;
  status: string;
  resolution: string | null;
  reviewed_at: string | null;
  language?: string | null;
}

async function listFeedback(
  endpoint: string,
  token: string,
  args: { status: CliArgs["status"]; since?: string; limit: number }
): Promise<FeedbackListItem[]> {
  const result = await callTool(endpoint, token, "list_feedback", args);
  const text = (result.content[0] as { type: "text"; text: string }).text;
  const parsed = JSON.parse(text) as { items: FeedbackListItem[]; count: number };
  return parsed.items;
}

async function getFeedback(
  endpoint: string,
  token: string,
  id: string
): Promise<FeedbackFullRecord> {
  const result = await callTool(endpoint, token, "get_feedback", { id });
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text) as FeedbackFullRecord;
}

interface AudioPayload {
  has_audio: true;
  data: Uint8Array;
  mimeType: string;
}
interface NoAudioPayload {
  has_audio: false;
}

async function getFeedbackAudio(
  endpoint: string,
  token: string,
  id: string
): Promise<AudioPayload | NoAudioPayload> {
  const result = await callTool(endpoint, token, "get_feedback_audio", { id });
  const first = result.content[0];
  if (first?.type === "audio") {
    return {
      has_audio: true,
      data: Buffer.from(first.data, "base64"),
      mimeType: first.mimeType,
    };
  }
  // text item with `{ has_audio: false, id }`
  if (first?.type === "text") {
    const parsed = JSON.parse(first.text) as { has_audio?: boolean };
    if (parsed.has_audio === false) return { has_audio: false };
  }
  throw new Error(`unexpected get_feedback_audio response for ${id}`);
}

// ---- File helpers --------------------------------------------------------

/** Map a MIME type to a file extension. Matches the production
 *  upload path's allowed types so we round-trip cleanly. */
function extForMimeType(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("flac")) return ".flac";
  if (m.includes("webm")) return ".webm";
  return ".wav";
}

/** True if any audio file `feedback-<id>.<ext>` already exists locally. */
function findCachedAudio(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null;
  const prefix = `feedback-${id}.`;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(prefix)) return join(dir, entry);
  }
  return null;
}

function sidecarPath(dir: string, id: string): string {
  return join(dir, `feedback-${id}.json`);
}

interface FeedbackSidecar {
  description: string;
  groundTruth: string;
  language?: string | null;
  /** Original transcription context. Not consumed by bench-stt.ts but
   *  preserved for human triage and for future bench enhancements
   *  (e.g. "replay this fixture against the same provider/model"). */
  feedback: {
    id: string;
    createdAt: string;
    failureKind: string | null;
    provider: string;
    model: string;
    polishApplied: boolean;
    polishMode: "intuitive" | "prescriptive" | null;
    rawText: string;
    polishedText: string;
    audioSeconds: number | null;
    userNote: string | null;
    transcriptionClientId: string;
  };
  expects: Array<{ kind: string; [k: string]: unknown }>;
}

function buildSidecar(full: FeedbackFullRecord, defaultMaxWer: number): FeedbackSidecar {
  const description = [
    `feedback ${full.id.slice(0, 8)}`,
    full.failure_kind ? `[${full.failure_kind}]` : null,
    full.user_note ? `— ${full.user_note.slice(0, 80)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    description,
    groundTruth: full.expected_text,
    language: full.language ?? undefined,
    feedback: {
      id: full.id,
      createdAt: full.created_at,
      failureKind: full.failure_kind,
      provider: full.provider,
      model: full.model,
      polishApplied: full.polish_applied,
      polishMode: full.polish_mode,
      rawText: full.raw_text,
      polishedText: full.polished_text,
      audioSeconds: full.audio_seconds,
      userNote: full.user_note,
      transcriptionClientId: full.transcription_client_id,
    },
    expects: [{ kind: "max_wer", ratio: defaultMaxWer }],
  };
}

// ---- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.endpoint || !args.token) {
    console.error(
      "Missing --endpoint or --token (or SPEAKIST_MCP_ENDPOINT / SPEAKIST_MCP_TOKEN).\n" +
        "Mint a service token at /admin/tokens with the feedback:read scope.\n" +
        "Run `pnpm bench:stt:sync -- --help` for full usage."
    );
    process.exit(2);
  }

  if (!args.dryRun && !existsSync(args.output)) {
    mkdirSync(args.output, { recursive: true });
  }

  console.log(`Endpoint: ${args.endpoint}`);
  console.log(`Status:   ${args.status}${args.since ? ` (since ${args.since})` : ""}`);
  console.log(`Output:   ${args.output}${args.dryRun ? " (DRY RUN)" : ""}`);
  console.log("");

  // ---- Listing pass ------------------------------------------------------
  const items = await listFeedback(args.endpoint, args.token, {
    status: args.status,
    since: args.since,
    limit: args.limit,
  });
  console.log(`Listing returned ${items.length} feedback row(s).`);

  let synced = 0;
  let audioCached = 0;
  let textOnlySynced = 0;
  let textOnlySkipped = 0;
  let errors = 0;

  for (const item of items) {
    const label = `${item.id.slice(0, 8)}  ${item.failure_kind ?? "—".padEnd(11)}  has_audio=${item.has_audio}`;
    try {
      if (!item.has_audio && !args.includeTextOnly) {
        textOnlySkipped++;
        console.log(`  SKIP  ${label}  (text-only; pass --include-text-only to keep)`);
        continue;
      }

      // Pull the full record for ground-truth text + language + raw_text.
      const full = await getFeedback(args.endpoint, args.token, item.id);

      let audioStatus = "no audio";
      if (item.has_audio) {
        const cached = findCachedAudio(args.output, item.id);
        if (cached) {
          audioCached++;
          audioStatus = `cached (${cached.split("/").pop()})`;
        } else if (args.dryRun) {
          audioStatus = "would-download";
        } else {
          const audio = await getFeedbackAudio(args.endpoint, args.token, item.id);
          if (audio.has_audio) {
            const ext = extForMimeType(audio.mimeType);
            const audioPath = join(args.output, `feedback-${item.id}${ext}`);
            writeFileSync(audioPath, audio.data);
            audioStatus = `downloaded ${audio.data.byteLength}B as ${ext}`;
          } else {
            audioStatus = "audio listed but missing";
          }
        }
      }

      if (!args.dryRun) {
        const sidecar = buildSidecar(full, args.defaultMaxWer);
        writeFileSync(sidecarPath(args.output, item.id), JSON.stringify(sidecar, null, 2) + "\n");
      }

      if (item.has_audio) synced++;
      else textOnlySynced++;
      console.log(`  OK    ${label}  ${audioStatus}`);
    } catch (err) {
      errors++;
      console.error(`  ERR   ${label}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  console.log("Summary:");
  console.log(`  audio synced:     ${synced}`);
  console.log(`  audio cached:     ${audioCached} (re-used local copy)`);
  if (args.includeTextOnly) {
    console.log(`  text-only synced: ${textOnlySynced}`);
  } else {
    console.log(`  text-only skipped: ${textOnlySkipped}`);
  }
  console.log(`  errors:           ${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("bench-stt-sync failed:", err);
  process.exit(1);
});
