// PATCH /api/admin/feedback/[id]
//
// Super-admin triage action: update status and/or resolution on a
// feedback row. Records who reviewed and when.
//
// Body (JSON):
//   {
//     status?: "new" | "reviewed" | "resolved" | "dismissed" | "proposed",
//     resolution?: string  // free text; max 1000 chars
//   }
//
// At least one of `status` or `resolution` must be present. The
// reviewer (user_id) and reviewed_at timestamp are stamped server-side
// on every PATCH where status moves out of `new`.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";

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
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    const status = err instanceof AuthzError ? err.status : 401;
    return Response.json({ error: "unauthorized" }, { status });
  }
  if (!user.isSuperAdmin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
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
  // reviewer (they could; we just don't see a reason to).
  if (parsed.data.status && parsed.data.status !== "new") {
    updates.reviewedAt = new Date();
    updates.reviewedBy = user.id;
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
