// GET/PUT /api/me/cleanup
//
// Per-user cleanup preferences. Source of truth for whether
// /api/transcribe runs the LLM cleanup pass and what system prompt it
// uses. Mac calls this when the user flips the toggle or edits the
// prompt in Settings.
//
// Auth: bearer (Mac session) or cookie (web debugging).
//
// GET response:
//   { enabled: bool, system_prompt: string, is_custom: bool, default_prompt: string }
// PUT body:
//   { enabled?: bool, system_prompt?: string | null }
//   * `system_prompt: null` → clears the custom prompt, falls back to default
//   * `system_prompt: "<text>"` → sets a custom prompt
//   * Omit either field → no change to that field
// PUT response: same shape as GET.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { DEFAULT_CLEANUP_PROMPT } from "@/lib/transcription/cleanup";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    return Response.json(await readCleanup(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

// Accept either top-level or lightly-wrapped JSON. system_prompt = null
// is the explicit "clear custom prompt" signal — distinct from omitting
// the key, which leaves the existing value alone.
const bodySchema = z.object({
  enabled: z.boolean().optional(),
  system_prompt: z.string().max(4000).nullable().optional(),
});

export async function PUT(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return Response.json(
        { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const patch: Partial<{ cleanupEnabled: boolean; cleanupSystemPrompt: string | null }> = {};
    if (parsed.data.enabled !== undefined) patch.cleanupEnabled = parsed.data.enabled;
    if (parsed.data.system_prompt !== undefined) {
      // Treat whitespace-only as "clear" so users can't accidentally
      // commit a blank custom prompt (which would produce empty LLM
      // outputs at cleanup time).
      const trimmed = parsed.data.system_prompt?.trim() ?? null;
      patch.cleanupSystemPrompt = trimmed && trimmed.length > 0 ? trimmed : null;
    }

    if (Object.keys(patch).length > 0) {
      const db = getDb();
      await db.update(users).set(patch).where(eq(users.id, user.id));
    }

    return Response.json(await readCleanup(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

async function readCleanup(userId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      enabled: users.cleanupEnabled,
      prompt: users.cleanupSystemPrompt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    enabled: !!row?.enabled,
    system_prompt: row?.prompt ?? DEFAULT_CLEANUP_PROMPT,
    is_custom: !!row?.prompt,
    default_prompt: DEFAULT_CLEANUP_PROMPT,
  };
}

function errorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("[/api/me/cleanup] unexpected:", err);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
