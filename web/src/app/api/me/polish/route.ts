// GET/PUT /api/me/polish
//
// Per-user polish preferences. Source of truth for whether /api/transcribe
// runs the LLM polish pass, what mode it runs in, and what system prompt
// it uses. Mac/iOS/web all call this when the user flips a toggle or
// edits the prompt in their Settings UI.
//
// Auth: bearer (Mac session) or cookie (web debugging).
//
// GET response:
//   {
//     enabled: bool,
//     mode: "intuitive" | "prescriptive",
//     system_prompt: string,        // currently-effective prompt
//     is_custom: bool,              // true when system_prompt is a user override
//     default_prompt: string        // mode's baked-in default (read-only)
//   }
// PUT body (any combination, all optional):
//   { enabled?: bool, mode?: "intuitive" | "prescriptive", system_prompt?: string | null }
//   * `system_prompt: null` → clears the custom prompt, falls back to mode default
//   * `system_prompt: "<text>"` → sets a custom prompt
//   * Omit a field → no change to that field
// PUT response: same shape as GET.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { defaultPromptForMode, type PolishMode } from "@/lib/transcription/polish";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    return Response.json(await readPolish(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

// Accept either top-level or lightly-wrapped JSON. system_prompt = null
// is the explicit "clear custom prompt" signal — distinct from omitting
// the key, which leaves the existing value alone.
const bodySchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["intuitive", "prescriptive"]).optional(),
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

    const patch: Partial<{
      polishEnabled: boolean;
      polishMode: PolishMode;
      polishSystemPrompt: string | null;
    }> = {};
    if (parsed.data.enabled !== undefined) patch.polishEnabled = parsed.data.enabled;
    if (parsed.data.mode !== undefined) patch.polishMode = parsed.data.mode;
    if (parsed.data.system_prompt !== undefined) {
      // Treat whitespace-only as "clear" so users can't accidentally
      // commit a blank custom prompt (which would produce empty LLM
      // outputs at polish time).
      const trimmed = parsed.data.system_prompt?.trim() ?? null;
      patch.polishSystemPrompt = trimmed && trimmed.length > 0 ? trimmed : null;
    }

    if (Object.keys(patch).length > 0) {
      const db = getDb();
      await db.update(users).set(patch).where(eq(users.id, user.id));
    }

    return Response.json(await readPolish(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

async function readPolish(userId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      enabled: users.polishEnabled,
      mode: users.polishMode,
      prompt: users.polishSystemPrompt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const mode: PolishMode = (row?.mode as PolishMode) ?? "prescriptive";
  const modeDefault = defaultPromptForMode(mode);
  return {
    enabled: !!row?.enabled,
    mode,
    system_prompt: row?.prompt ?? modeDefault,
    is_custom: !!row?.prompt,
    default_prompt: modeDefault,
  };
}

function errorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("[/api/me/polish] unexpected:", err);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
