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
import type { ServiceScope } from "@/lib/service-tokens";
import { base64Encode } from "@/lib/base64";
import { truncate } from "@/lib/utils";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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
  handler: (args: unknown) => Promise<McpContent[]>;
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

// ---- registry -------------------------------------------------------------

export const ALL_TOOLS: McpToolDefinition[] = [
  listFeedbackTool,
  getFeedbackTool,
  getFeedbackAudioTool,
  markFeedbackProposedTool,
  markFeedbackResolutionTool,
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

