// Tool definitions for the Speakist MCP server.
//
// These power both `tools/list` (clients introspect what's available)
// and `tools/call` (we dispatch to the implementation by name). Each
// tool keeps its description, JSON-Schema input shape, and required
// service-token scope co-located with the implementation so adding a
// new tool is one place to edit.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";
import {
  getFeedbackById,
  listFeedback,
  type FeedbackStatus,
} from "@/lib/feedback";
import {
  ALL_MODES,
  createVersion,
  getActivePrompt,
  getPromptById,
  getPromptByVersion,
  listVersions,
  type PolishPromptMode,
  type PromptVersion,
} from "@/lib/polish-prompts";
import type { ServiceScope } from "@/lib/service-tokens";
import { base64Encode } from "@/lib/base64";
import { truncate } from "@/lib/utils";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Execution context the dispatcher hands to each tool. Today: just
 *  the verified service token's row id, which prompt-write tools need
 *  to attribute the new version (createdByTokenId). Most handlers
 *  ignore it. Keep additions to this surface narrow — anything richer
 *  belongs on the args input or is fetched from the DB by the handler. */
export interface McpExecutionContext {
  tokenId: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for `arguments`. MCP clients show this to the LLM. */
  inputSchema: Record<string, unknown>;
  /** Service-token scope a caller must hold. */
  scope: ServiceScope;
  /** Zod schema mirrors `inputSchema` for runtime validation. Source
   *  of truth for the dispatcher; the JSON Schema above is what we
   *  hand to MCP clients. Keep them in sync. */
  argsSchema: z.ZodTypeAny;
  handler: (
    args: unknown,
    ctx: McpExecutionContext
  ) => Promise<McpContent[]>;
}

/** Subset of the MCP content union we actually emit. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "audio"; data: string; mimeType: string };

// ---- list_feedback --------------------------------------------------------

const listArgsSchema = z.object({
  status: z
    .enum([
      "new",
      "reviewed",
      "resolved",
      "dismissed",
      "proposed",
      "all",
    ])
    .default("new"),
  /** ISO 8601. Only return rows created strictly after this timestamp.
   *  Lets the agent advance a cursor across runs without re-fetching
   *  rows it's already seen. */
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const listFeedbackTool: McpToolDefinition = {
  name: "list_feedback",
  description:
    "List bad-transcription reports newest-first. Default status is 'new' so a cron-driven agent sees only its un-triaged work. Pass `status: 'all'` to ignore the filter, or `since` to advance a cursor across runs.",
  scope: "feedback:read",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: [
          "new",
          "reviewed",
          "resolved",
          "dismissed",
          "proposed",
          "all",
        ],
        default: "new",
      },
      since: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  argsSchema: listArgsSchema,
  handler: async (rawArgs) => {
    const args = listArgsSchema.parse(rawArgs ?? {});
    const rows =
      args.status === "all"
        ? await listFeedback({ limit: args.limit })
        : await listFeedback({
            status: args.status as FeedbackStatus,
            limit: args.limit,
          });
    const filtered = args.since
      ? rows.filter((r) => r.createdAt > new Date(args.since!))
      : rows;
    // Project the heavy text fields out — the agent calls
    // `get_feedback` for full bodies. Keeps the listing tool's
    // payload compact.
    const projected = filtered.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      user_email: r.userEmail,
      org_name: r.orgName,
      status: r.status,
      failure_kind: r.failureKind,
      provider: r.provider,
      model: r.model,
      polish_applied: r.polishApplied,
      polish_mode: r.polishMode,
      audio_seconds: r.audioSeconds,
      has_audio: r.hasAudio,
      polished_preview: truncate(r.polishedText, 120),
      expected_preview: truncate(r.expectedText, 120),
    }));
    return [
      {
        type: "text",
        text: JSON.stringify({ items: projected, count: projected.length }, null, 2),
      },
    ];
  },
};

// ---- get_feedback ---------------------------------------------------------

const getArgsSchema = z.object({ id: z.string().min(1) });

export const getFeedbackTool: McpToolDefinition = {
  name: "get_feedback",
  description:
    "Fetch full detail for one feedback report: raw STT (pre-polish), polished delivered text, what the user said it should be, plus provider/model/polish_mode/language/audio metadata AND the per-request context snapshot (keyterms + transcription_options) that was active at the original /api/transcribe call. The 3 text fields drive polish-prompt edits; the context snapshot lets the STT bench replay the audio in the same config the user had.",
  scope: "feedback:read",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  argsSchema: getArgsSchema,
  handler: async (rawArgs) => {
    const args = getArgsSchema.parse(rawArgs);
    const row = await getFeedbackById(args.id);
    if (!row) {
      throw new McpError(`feedback ${args.id} not found`, "not_found");
    }
    return [
      {
        type: "text",
        text: JSON.stringify(
          {
            id: row.id,
            created_at: row.createdAt.toISOString(),
            user_email: row.userEmail,
            org_name: row.orgName,
            transcription_client_id: row.transcriptionClientId,
            raw_text: row.rawText,
            polished_text: row.polishedText,
            expected_text: row.expectedText,
            failure_kind: row.failureKind,
            user_note: row.userNote,
            provider: row.provider,
            model: row.model,
            polish_applied: row.polishApplied,
            polish_mode: row.polishMode,
            audio_seconds: row.audioSeconds,
            language: row.language,
            // Request-context snapshot from the original transcribe
            // call. `keyterms === null` means the submitting client
            // didn't report a list (older builds, current iOS).
            // `keyterms === []` means it explicitly said "empty".
            // `transcription_options === null` likewise distinguishes
            // "not reported" from "reported as empty object".
            keyterms: row.keyterms,
            transcription_options: row.transcriptionOptions,
            has_audio: row.hasAudio,
            status: row.status,
            resolution: row.resolution,
            reviewed_at: row.reviewedAt?.toISOString() ?? null,
          },
          null,
          2
        ),
      },
    ];
  },
};

// ---- get_feedback_audio ---------------------------------------------------

export const getFeedbackAudioTool: McpToolDefinition = {
  name: "get_feedback_audio",
  description:
    "Fetch the audio recording for a feedback report (when the user shared one). Returns base64-encoded WAV/MP3 bytes via MCP's `audio` content type. Useful for diagnosing STT-side issues; not normally needed for polish-prompt iteration which is text-only.",
  scope: "feedback:read",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  argsSchema: getArgsSchema,
  handler: async (rawArgs) => {
    const args = getArgsSchema.parse(rawArgs);
    const row = await getFeedbackById(args.id);
    if (!row) {
      throw new McpError(`feedback ${args.id} not found`, "not_found");
    }
    if (!row.audioObjectKey) {
      // Text-only report. Return a text content item explaining
      // rather than throwing — the agent should treat this as a
      // normal "no audio for this one" and move on.
      return [
        {
          type: "text",
          text: JSON.stringify({ has_audio: false, id: row.id }),
        },
      ];
    }
    const { env } = await getCloudflareContext({ async: true });
    if (!env.FEEDBACK_AUDIO) {
      throw new McpError(
        "FEEDBACK_AUDIO bucket not bound; this only works on a deployed Worker",
        "not_configured"
      );
    }
    const obj = await env.FEEDBACK_AUDIO.get(row.audioObjectKey);
    if (!obj) {
      throw new McpError(
        `audio object missing in R2: ${row.audioObjectKey}`,
        "audio_missing"
      );
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const mimeType = obj.httpMetadata?.contentType ?? "audio/wav";
    return [
      {
        type: "audio",
        data: base64Encode(bytes),
        mimeType,
      },
    ];
  },
};

// ---- mark_feedback_proposed ----------------------------------------------

const proposedArgsSchema = z.object({
  id: z.string().min(1),
  pr_url: z.string().url(),
  summary: z.string().trim().min(1).max(500).optional(),
});

export const markFeedbackProposedTool: McpToolDefinition = {
  name: "mark_feedback_proposed",
  description:
    "Move a feedback report to status='proposed' once the agent has opened a PR for it. Stores the PR URL (and an optional one-line summary) in the resolution field for traceability. Idempotent — re-calling on an already-proposed row updates the resolution.",
  scope: "feedback:triage",
  inputSchema: {
    type: "object",
    required: ["id", "pr_url"],
    properties: {
      id: { type: "string" },
      pr_url: { type: "string", format: "uri" },
      summary: { type: "string", maxLength: 500 },
    },
  },
  argsSchema: proposedArgsSchema,
  handler: async (rawArgs) => {
    const args = proposedArgsSchema.parse(rawArgs);
    const resolution = args.summary
      ? `${args.summary}\n${args.pr_url}`
      : args.pr_url;
    const db = getDb();
    const result = await db
      .update(transcriptionFeedback)
      .set({
        status: "proposed",
        resolution,
        reviewedAt: new Date(),
        // reviewedBy stays NULL for service-token-driven updates —
        // the column is FK→users and there's no user behind this call.
      })
      .where(eq(transcriptionFeedback.id, args.id))
      .returning({ id: transcriptionFeedback.id });
    if (result.length === 0) {
      throw new McpError(`feedback ${args.id} not found`, "not_found");
    }
    return [
      {
        type: "text",
        text: JSON.stringify({ ok: true, id: result[0].id, status: "proposed" }),
      },
    ];
  },
};

// ---- mark_feedback_resolution --------------------------------------------

const resolutionArgsSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["new", "reviewed", "resolved", "dismissed", "proposed"]),
  resolution: z.string().max(1000).optional(),
});

export const markFeedbackResolutionTool: McpToolDefinition = {
  name: "mark_feedback_resolution",
  description:
    "General-purpose status / resolution update for a feedback report. Use this for dismissals or for resolving outside the proposed-PR flow. Use `mark_feedback_proposed` instead when opening a PR.",
  scope: "feedback:triage",
  inputSchema: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      status: {
        type: "string",
        enum: ["new", "reviewed", "resolved", "dismissed", "proposed"],
      },
      resolution: { type: "string", maxLength: 1000 },
    },
  },
  argsSchema: resolutionArgsSchema,
  handler: async (rawArgs) => {
    const args = resolutionArgsSchema.parse(rawArgs);
    const db = getDb();
    const updates: Record<string, unknown> = { status: args.status };
    if (args.resolution !== undefined) updates.resolution = args.resolution;
    if (args.status !== "new") {
      updates.reviewedAt = new Date();
    }
    const result = await db
      .update(transcriptionFeedback)
      .set(updates)
      .where(eq(transcriptionFeedback.id, args.id))
      .returning({ id: transcriptionFeedback.id });
    if (result.length === 0) {
      throw new McpError(`feedback ${args.id} not found`, "not_found");
    }
    return [
      {
        type: "text",
        text: JSON.stringify({ ok: true, id: result[0].id, status: args.status }),
      },
    ];
  },
};

// ---- get_active_polish_prompt --------------------------------------------

const promptModeSchema = z.enum(ALL_MODES as readonly [PolishPromptMode, ...PolishPromptMode[]]);

const getActivePromptArgsSchema = z.object({ mode: promptModeSchema });

export const getActivePolishPromptTool: McpToolDefinition = {
  name: "get_active_polish_prompt",
  description:
    "Return the currently active polish prompt for a mode ('intuitive' or 'prescriptive') — the exact body /api/transcribe is serving right now. Includes version, source ('seed'/'admin'/'agent'/'rollback'/'mirror'), bench_score if known, notes, and created_at. Use this as the starting point for a candidate iteration.",
  scope: "prompts:read",
  inputSchema: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: [...ALL_MODES] },
    },
  },
  argsSchema: getActivePromptArgsSchema,
  handler: async (rawArgs) => {
    const args = getActivePromptArgsSchema.parse(rawArgs);
    const v = await getActivePrompt(args.mode);
    if (!v) {
      // No active row — resolver is serving the deprecated
      // app_settings override or the baked-in baseline. Tell the
      // agent explicitly rather than silently returning empty.
      return [
        {
          type: "text",
          text: JSON.stringify({
            active: null,
            note: "No active version yet for this mode. /api/transcribe is falling back through app_settings (deprecated) and finally to the baked-in baseline. Propose a new version to start the loop.",
          }),
        },
      ];
    }
    return [
      {
        type: "text",
        text: JSON.stringify(serializeFullVersion(v), null, 2),
      },
    ];
  },
};

// ---- list_polish_prompt_versions -----------------------------------------

const listPromptVersionsArgsSchema = z.object({
  mode: promptModeSchema,
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().datetime().optional(),
});

export const listPolishPromptVersionsTool: McpToolDefinition = {
  name: "list_polish_prompt_versions",
  description:
    "List polish-prompt versions for a mode, newest first. Body is omitted to keep the payload compact — call get_polish_prompt_version for the full text of any single row. Use `since` (ISO 8601) to advance a cursor across agent runs.",
  scope: "prompts:read",
  inputSchema: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: [...ALL_MODES] },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      since: { type: "string", format: "date-time" },
    },
  },
  argsSchema: listPromptVersionsArgsSchema,
  handler: async (rawArgs) => {
    const args = listPromptVersionsArgsSchema.parse(rawArgs ?? {});
    const rows = await listVersions(args.mode, {
      limit: args.limit,
      since: args.since ? new Date(args.since) : undefined,
    });
    return [
      {
        type: "text",
        text: JSON.stringify(
          {
            items: rows.map(serializeListingVersion),
            count: rows.length,
          },
          null,
          2
        ),
      },
    ];
  },
};

// ---- get_polish_prompt_version -------------------------------------------

const getPromptVersionArgsSchema = z
  .object({
    mode: promptModeSchema.optional(),
    version: z.number().int().min(1).optional(),
    id: z.string().min(1).optional(),
  })
  .refine(
    (a) => Boolean(a.id) || (Boolean(a.mode) && Boolean(a.version)),
    "pass either `id` or both `mode` and `version`"
  );

export const getPolishPromptVersionTool: McpToolDefinition = {
  name: "get_polish_prompt_version",
  description:
    "Fetch a single polish-prompt version's full body + metadata. Look up by `id` OR by `(mode, version)` — pass one or the other. Use this to diff candidate iterations against history, or to confirm what a rollback would restore.",
  scope: "prompts:read",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...ALL_MODES] },
      version: { type: "integer", minimum: 1 },
      id: { type: "string" },
    },
  },
  argsSchema: getPromptVersionArgsSchema,
  handler: async (rawArgs) => {
    const args = getPromptVersionArgsSchema.parse(rawArgs);
    const v = args.id
      ? await getPromptById(args.id)
      : await getPromptByVersion(args.mode!, args.version!);
    if (!v) {
      throw new McpError("polish prompt version not found", "not_found");
    }
    return [
      {
        type: "text",
        text: JSON.stringify(serializeFullVersion(v), null, 2),
      },
    ];
  },
};

// ---- propose_polish_prompt -----------------------------------------------

const proposePromptArgsSchema = z.object({
  mode: promptModeSchema,
  /** Lower bound matches the baseline prompt's anti-response framing
   *  — anything shorter than 50 chars cannot plausibly carry the
   *  required <dictation>-tag + never-respond contract. The domain
   *  layer also rejects whitespace-only, but a soft lower bound
   *  surfaces the issue at args validation instead of after the DB
   *  round-trip. */
  body: z.string().min(50).max(20_000),
  notes: z.string().min(1).max(2000),
  bench_score: z.number().min(0).max(1).optional(),
  bench_results: z.record(z.unknown()).optional(),
});

export const proposePolishPromptTool: McpToolDefinition = {
  name: "propose_polish_prompt",
  description:
    "Promote a candidate prompt body to the active version for a mode. Creates a new row with source='agent', attributed to the calling service token. The agent should ONLY call this after running the local regression bench against polish-fixtures.ts and including the resulting score + per-fixture results — those are surfaced in the admin UI and in the Slack notification this triggers, and let humans verify the agent's quality bar. Always include `notes` explaining WHY this version exists (which feedback IDs prompted it, what the candidate changes).",
  scope: "prompts:write",
  inputSchema: {
    type: "object",
    required: ["mode", "body", "notes"],
    properties: {
      mode: { type: "string", enum: [...ALL_MODES] },
      body: { type: "string", minLength: 50, maxLength: 20000 },
      notes: { type: "string", minLength: 1, maxLength: 2000 },
      bench_score: { type: "number", minimum: 0, maximum: 1 },
      bench_results: { type: "object", additionalProperties: true },
    },
  },
  argsSchema: proposePromptArgsSchema,
  handler: async (rawArgs, ctx) => {
    const args = proposePromptArgsSchema.parse(rawArgs);
    const v = await createVersion({
      mode: args.mode,
      body: args.body,
      notes: args.notes,
      source: "agent",
      createdByTokenId: ctx.tokenId,
      benchScore: args.bench_score,
      benchResults: args.bench_results,
    });
    return [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            id: v.id,
            mode: v.mode,
            version: v.version,
            is_active: v.isActive,
            bench_score: v.benchScore,
          },
          null,
          2
        ),
      },
    ];
  },
};

// ---- polish-prompt projections (shared by the three read tools) ----------

function serializeFullVersion(v: PromptVersion) {
  return {
    id: v.id,
    mode: v.mode,
    version: v.version,
    body: v.body,
    notes: v.notes,
    source: v.source,
    is_active: v.isActive,
    rolled_back_from_version_id: v.rolledBackFromVersionId,
    bench_score: v.benchScore,
    bench_results: v.benchResults,
    created_at: v.createdAt.toISOString(),
    created_by_user_id: v.createdByUserId,
    created_by_token_id: v.createdByTokenId,
  };
}

function serializeListingVersion(v: PromptVersion) {
  return {
    id: v.id,
    version: v.version,
    source: v.source,
    is_active: v.isActive,
    rolled_back_from_version_id: v.rolledBackFromVersionId,
    bench_score: v.benchScore,
    notes_preview: v.notes ? truncate(v.notes, 160) : null,
    created_at: v.createdAt.toISOString(),
    created_by_user_id: v.createdByUserId,
    created_by_token_id: v.createdByTokenId,
  };
}

// ---- registry -------------------------------------------------------------

export const ALL_TOOLS: McpToolDefinition[] = [
  listFeedbackTool,
  getFeedbackTool,
  getFeedbackAudioTool,
  markFeedbackProposedTool,
  markFeedbackResolutionTool,
  getActivePolishPromptTool,
  listPolishPromptVersionsTool,
  getPolishPromptVersionTool,
  proposePolishPromptTool,
];

export function findTool(name: string): McpToolDefinition | null {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}

// ---- helpers --------------------------------------------------------------

/** Tool errors the dispatcher knows how to format as MCP error
 *  responses. Anything else is a 500-equivalent. */
export class McpError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "audio_missing" | "not_configured"
  ) {
    super(message);
  }
}

