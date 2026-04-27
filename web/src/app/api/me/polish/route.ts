// GET/PUT /api/me/polish
//
// Per-user polish preferences. Source of truth for whether
// /api/transcribe runs the LLM polish pass and what mode it runs in.
// Mac/iOS/web all call this when the user flips the toggle or changes
// the mode in their Settings UI.
//
// End users no longer customize the system prompt — that's now a
// super-admin-only setting at /admin/system. The endpoint still returns
// the active prompt for read-only display in older clients (and so
// `/api/me` payload shape doesn't shift), but ignores any inbound
// `system_prompt` field.
//
// Auth: bearer (Mac session) or cookie (web debugging).
//
// GET response:
//   {
//     enabled: bool,
//     mode: "intuitive" | "prescriptive",
//     system_prompt: string,        // currently-effective prompt (read-only)
//     is_custom: false,             // legacy field; always false now
//     default_prompt: string        // same as system_prompt
//   }
// PUT body (any combination, all optional):
//   { enabled?: bool, mode?: "intuitive" | "prescriptive" }
//   Older clients may send `system_prompt`; we accept the field so the
//   request doesn't 400 but ignore the value.
// PUT response: same shape as GET.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { resolvePromptForMode, type PolishMode } from "@/lib/transcription/polish";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    return Response.json(await readPolish(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

const bodySchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["intuitive", "prescriptive"]).optional(),
  // Accepted for forward/backward compat with older clients that may
  // still send it; intentionally ignored server-side.
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

    const patch: Partial<{ polishEnabled: boolean; polishMode: PolishMode }> = {};
    if (parsed.data.enabled !== undefined) patch.polishEnabled = parsed.data.enabled;
    if (parsed.data.mode !== undefined) patch.polishMode = parsed.data.mode;
    // `system_prompt` is intentionally ignored — see header comment.

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
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const mode: PolishMode = (row?.mode as PolishMode) ?? "prescriptive";
  const prompt = await resolvePromptForMode(mode);
  return {
    enabled: !!row?.enabled,
    mode,
    system_prompt: prompt,
    // Legacy fields — kept in the response so older clients that read
    // them don't blow up. End users can no longer customize, so
    // is_custom is permanently false and default_prompt mirrors the
    // active prompt.
    is_custom: false,
    default_prompt: prompt,
  };
}

function errorResponse(err: unknown): Response {
  if (err instanceof AuthzError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error("[/api/me/polish] unexpected:", err);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
