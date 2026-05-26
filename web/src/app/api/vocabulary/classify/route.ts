// POST /api/vocabulary/classify
//
// Reactive classifier for vocabulary entries the user has corrected
// ≥ 2 times. Decides whether the (find, replacement) pair should be
// promoted from `applies_to = 'local'` (client-side-only, the safe
// auto-ingest default) to `'stt'` (sent to the upstream STT provider
// as a keyterm bias + replace=find:replacement rule).
//
// Mac client flow:
//   1. CorrectionStore.ingest() bumps a row's count to 2.
//   2. Mac POSTs { find, replacement, context? } to this endpoint.
//   3. Endpoint returns { add, category, reason }.
//   4. If `add === true`, the Mac sets the local row's appliesTo
//      to `.stt` and pushes the change to /api/vocabulary; from
//      that point forward the rule rides on every transcribe call.
//      If `add === false`, the row stays local-only forever (the
//      user can still promote it manually in Settings).
//
// This endpoint deliberately doesn't write to the vocabulary table —
// it's a pure decision API. Keeps the server-side state machine
// simple (one canonical writer, /api/vocabulary's POST handler) and
// leaves the Mac free to apply or ignore the recommendation without
// a stale-data race.
//
// Auth: same as /api/vocabulary — user session bearer. The
// classifier itself runs on the Speakist-shared Groq key (resolved
// via the same `secrets.ts` path the polish pass uses).

import { z } from "zod";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import {
  runClassifier,
  CLASSIFIER_MODEL,
  type VocabClassifierResult,
} from "@/lib/transcription/classifier";
import { getDb } from "@/lib/db";
import { eq } from "drizzle-orm";
import { orgMembers } from "@/lib/db/schema";

const classifySchema = z.object({
  find: z.string().trim().min(1).max(200),
  replacement: z.string().trim().min(1).max(500),
  // Optional surrounding text from the transcript where the
  // correction was made. Helps the model distinguish a one-off
  // in-context fix from a true vocab item. Capped at 400 chars
  // server-side too (the lib also truncates).
  context: z.string().max(2000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const json = await req.json().catch(() => null);
  const parsed = classifySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  // Resolve the caller's org so the classifier's Groq key resolution
  // can consult the org-override path (matches the polish pass).
  // A missing org is unusual — every Speakist user belongs to exactly
  // one org per migration 0015 — but be defensive in case the lookup
  // races a partial signup state.
  const db = getDb();
  const [orgRow] = await db
    .select({ id: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, user.id))
    .limit(1);
  if (!orgRow) {
    return Response.json({ error: "no_org" }, { status: 400 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const result: VocabClassifierResult = await runClassifier(
    env as unknown as Parameters<typeof runClassifier>[0],
    orgRow.id,
    parsed.data
  );

  // Metadata-only log so we can grep prod for "classifier rejected /
  // accepted X → Y" without spilling raw transcript content.
  console.info(
    `[vocab/classify] add=${result.add} category=${result.category} ` +
      `applied=${result.applied} latencyMs=${result.latencyMs} ` +
      `find_len=${parsed.data.find.length} repl_len=${parsed.data.replacement.length}` +
      (result.errorReason ? ` errorReason=${result.errorReason}` : "")
  );

  return Response.json({
    add: result.add,
    category: result.category,
    reason: result.reason,
    applied: result.applied,
    error_reason: result.errorReason,
    latency_ms: result.latencyMs,
    model: CLASSIFIER_MODEL,
  });
}
