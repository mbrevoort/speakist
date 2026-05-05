// GET /api/admin/feedback — super-admin triage list.
//
// Lists transcription_feedback rows newest-first, filterable by status.
// Used by the /admin/feedback page (server component reads via this
// endpoint OR a direct DB call — both work; we expose this route too
// for the rare case a script wants to scrape the queue).

import { desc, eq } from "drizzle-orm";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { transcriptionFeedback, users } from "@/lib/db/schema";

const ALLOWED_STATUSES = new Set([
  "new",
  "reviewed",
  "resolved",
  "dismissed",
  "proposed",
  "all",
]);

export async function GET(req: Request): Promise<Response> {
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

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "new";
  if (!ALLOWED_STATUSES.has(statusParam)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200
  );

  const db = getDb();
  const baseSelect = db
    .select({
      id: transcriptionFeedback.id,
      createdAt: transcriptionFeedback.createdAt,
      userEmail: users.email,
      userId: transcriptionFeedback.userId,
      orgId: transcriptionFeedback.orgId,
      transcriptionClientId: transcriptionFeedback.transcriptionClientId,
      rawText: transcriptionFeedback.rawText,
      polishedText: transcriptionFeedback.polishedText,
      expectedText: transcriptionFeedback.expectedText,
      provider: transcriptionFeedback.provider,
      model: transcriptionFeedback.model,
      polishApplied: transcriptionFeedback.polishApplied,
      polishMode: transcriptionFeedback.polishMode,
      audioSeconds: transcriptionFeedback.audioSeconds,
      failureKind: transcriptionFeedback.failureKind,
      userNote: transcriptionFeedback.userNote,
      hasAudio: transcriptionFeedback.audioObjectKey,
      status: transcriptionFeedback.status,
      resolution: transcriptionFeedback.resolution,
      reviewedAt: transcriptionFeedback.reviewedAt,
    })
    .from(transcriptionFeedback)
    .innerJoin(users, eq(users.id, transcriptionFeedback.userId))
    .orderBy(desc(transcriptionFeedback.createdAt))
    .limit(limit);

  const rows =
    statusParam === "all"
      ? await baseSelect
      : await baseSelect.where(
          eq(
            transcriptionFeedback.status,
            statusParam as
              | "new"
              | "reviewed"
              | "resolved"
              | "dismissed"
              | "proposed"
          )
        );

  // hasAudio is just a presence flag for the UI — strip the object key.
  return Response.json({
    items: rows.map((r) => ({ ...r, hasAudio: r.hasAudio !== null })),
  });
}
