// GET /api/admin/feedback/[id]/audio
//
// Streams the original audio for a feedback row from R2 back to the
// super-admin browser. Proxied (rather than handing out a presigned
// URL) so the only access path is gated by the super-admin session
// every time — no time-limited links, no token shareability.

import { eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { transcriptionFeedback } from "@/lib/db/schema";

export async function GET(
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

  const db = getDb();
  const [row] = await db
    .select({ audioObjectKey: transcriptionFeedback.audioObjectKey })
    .from(transcriptionFeedback)
    .where(eq(transcriptionFeedback.id, id))
    .limit(1);
  if (!row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!row.audioObjectKey) {
    return Response.json(
      { error: "no_audio", detail: "this feedback was submitted text-only" },
      { status: 404 }
    );
  }

  const { env } = await getCloudflareContext({ async: true });
  if (!env.FEEDBACK_AUDIO) {
    return Response.json(
      { error: "feedback_audio_bucket_not_bound" },
      { status: 500 }
    );
  }
  const obj = await env.FEEDBACK_AUDIO.get(row.audioObjectKey);
  if (!obj) {
    return Response.json(
      { error: "audio_missing_in_r2", key: row.audioObjectKey },
      { status: 410 }
    );
  }

  // Buffer through arrayBuffer rather than piping R2's stream — Workers
  // and standard ReadableStream typings disagree on the iterator
  // surface, and the audio is bounded at 100 MB by /api/feedback so
  // the in-memory copy is fine. We still set the original content-type
  // from R2's httpMetadata so the browser <audio> tag picks the right
  // codec.
  const buffer = await obj.arrayBuffer();
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "audio/wav",
      "Content-Length": String(buffer.byteLength),
      // Don't let CDNs / browsers cache audio that came out of a
      // super-admin gate.
      "Cache-Control": "private, no-store",
    },
  });
}
