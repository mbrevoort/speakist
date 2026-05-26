// PATCH /api/admin/feedback/[id] — triage update
// DELETE /api/admin/feedback/[id] — permanent removal (row + audio)
//
// PATCH: super-admin triage action that updates status and/or resolution
// on a feedback row. Records who reviewed and when.
//
// PATCH body (JSON):
//   {
//     status?: "new" | "reviewed" | "resolved" | "dismissed" | "proposed",
//     resolution?: string  // free text; max 1000 chars
//   }
//
// At least one of `status` or `resolution` must be present. The
// reviewer (user_id) and reviewed_at timestamp are stamped server-side
// on every PATCH where status moves out of `new`.
//
// DELETE: super-admin escape hatch for rows that shouldn't be in the
// corpus at all — abuse, accidental sensitive content, etc. Drops the
// DB row first, then best-effort deletes the corresponding R2 audio
// object. The order matters: a DB delete failure is observable from
// the API, but a leftover R2 object after a successful DB delete is a
// bounded leak we can clean up out-of-band. The opposite order
// (delete R2 first, then DB) would orphan the row if R2 succeeded but
// the DB write failed, which is harder to detect.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AuthzError } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";
import { requireFeedbackAccess } from "@/lib/feedback-access";

const bodySchema = z
  .object({
    status: z
      .enum(["new", "reviewed", "resolved", "dismissed", "proposed"])
      .optional(),
    resolution: z.string().max(1000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.resolution !== undefined, {
    message: "must include status or resolution",
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Mutating operation — feedback:triage scope required.
  let principal;
  try {
    principal = await requireFeedbackAccess(req, "feedback:triage");
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || id.length < 8) {
    return Response.json({ error: "missing_id" }, { status: 400 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const updates: Partial<typeof transcriptionFeedback.$inferInsert> = {};
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.resolution !== undefined) {
    updates.resolution = parsed.data.resolution;
  }
  // Stamp the reviewer when the row leaves the `new` state. Idempotent
  // re-saves while already-reviewed don't overwrite the original
  // reviewer (they could; we just don't see a reason to). Service-
  // token-driven PATCHes leave `reviewedBy` unset since there's no
  // user identity behind the call — `reviewedAt` still records when.
  if (parsed.data.status && parsed.data.status !== "new") {
    updates.reviewedAt = new Date();
    if (principal.kind === "user") {
      updates.reviewedBy = principal.userId;
    }
  }

  const db = getDb();
  const result = await db
    .update(transcriptionFeedback)
    .set(updates)
    .where(eq(transcriptionFeedback.id, id))
    .returning({ id: transcriptionFeedback.id });
  if (result.length === 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ ok: true, id: result[0].id });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Mutating + destructive — feedback:triage scope required.
  try {
    await requireFeedbackAccess(req, "feedback:triage");
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || id.length < 8) {
    return Response.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  // Read the audio key BEFORE deleting so we know what to remove from
  // R2 after the DB row is gone.
  const [existing] = await db
    .select({ audioObjectKey: transcriptionFeedback.audioObjectKey })
    .from(transcriptionFeedback)
    .where(eq(transcriptionFeedback.id, id))
    .limit(1);
  if (!existing) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Drop the DB row. If this fails the audio is still around — that's
  // the safe ordering (see endpoint docstring).
  await db
    .delete(transcriptionFeedback)
    .where(eq(transcriptionFeedback.id, id));

  // Best-effort R2 delete. A 404 from R2.delete on a missing key is
  // not surfaced — typed `void` return — but we catch any thrown error
  // and log it without failing the request, since the row is already
  // gone from the user-facing perspective.
  if (existing.audioObjectKey) {
    try {
      const { env } = await getCloudflareContext({ async: true });
      if (env.FEEDBACK_AUDIO) {
        await env.FEEDBACK_AUDIO.delete(existing.audioObjectKey);
      }
    } catch (err) {
      console.warn(
        `[admin/feedback DELETE] R2 delete failed for ${existing.audioObjectKey}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return Response.json({ ok: true, id });
}
