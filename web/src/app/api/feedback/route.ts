// POST /api/feedback — "Report bad transcription" submission endpoint.
//
// Called from the Mac and iOS clients when a user clicks "Report" on a
// History entry. Stores the audio (if shared), raw STT text, polished
// text, what the user said it should have been, plus light metadata —
// the corpus we grow polish-fixtures.ts and vocabulary suggestions
// from. Indefinite retention.
//
// Privacy boundary:
//   * Normal /api/transcribe calls discard audio after STT; only the
//     debit row hits the DB.
//   * This endpoint is the *only* path that persists audio. It runs
//     exclusively when a user explicitly clicks Report.
//   * Org admins can flip `organizations.feedback_disabled` to 1 to
//     hide the button + 403 this endpoint for everyone in the org.
//
// Request: multipart/form-data with these parts (all required unless
// noted):
//   transcription_client_id  TEXT   matches the X-Transcription-Id
//                                   the client sent on the original
//                                   transcribe call. Validated to
//                                   belong to this user via
//                                   usage_events.
//   raw_text                 TEXT   raw STT output (pre-polish)
//   polished_text            TEXT   final delivered text
//   expected_text            TEXT   user's correction
//   failure_kind             TEXT   optional, one of:
//                                     wrong_word | punctuation |
//                                     both | other
//   user_note                TEXT   optional free-text note (≤500 chars)
//   audio                    FILE   optional audio file (WAV/MP3/OGG)

import { and, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import {
  organizations,
  orgMembers,
  transcriptionFeedback,
  usageEvents,
} from "@/lib/db/schema";
import { captureServerEvent } from "@/lib/posthog/server";

/** Same audio cap as /api/transcribe — keeps a single 5-min recording
 *  comfortably under the limit (16 kHz mono Int16 WAV ≈ 32 KB/s). */
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/** User notes capped to keep the DB column reasonable; nothing we do
 *  with the field needs more text than this. */
const MAX_NOTE_CHARS = 500;

/** Accepted values for failure_kind. NULL is also fine — it's
 *  optional. */
const FAILURE_KINDS = new Set([
  "wrong_word",
  "punctuation",
  "both",
  "other",
]);

export async function POST(req: Request): Promise<Response> {
  const { env } = await getCloudflareContext({ async: true });

  // 1. Auth.
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    const status = err instanceof AuthzError ? err.status : 401;
    return json({ error: "unauthorized" }, status);
  }

  // 2. Resolve org + check the org-level opt-out gate. The opt-out
  //    is the only thing that can refuse a submission outright.
  const db = getDb();
  const [orgRow] = await db
    .select({
      id: organizations.id,
      feedbackDisabled: organizations.feedbackDisabled,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, user.id))
    .limit(1);
  if (!orgRow) {
    return json({ error: "no_org" }, 400);
  }
  if (orgRow.feedbackDisabled) {
    return json({ error: "feedback_disabled_for_org" }, 403);
  }

  // 3. Parse multipart. Workers' Request supports formData() natively.
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return json(
      { error: "invalid_multipart", detail: err instanceof Error ? err.message : String(err) },
      400
    );
  }

  const transcriptionClientId = stringField(form, "transcription_client_id");
  const rawText = stringField(form, "raw_text");
  const polishedText = stringField(form, "polished_text");
  const expectedText = stringField(form, "expected_text");

  if (!transcriptionClientId || transcriptionClientId.length < 8) {
    return json({ error: "missing_transcription_client_id" }, 400);
  }
  // Texts can be empty (e.g. polish ate everything and the user is
  // reporting a missing transcription) but not absent — distinguishing
  // "user submitted blank" from "user forgot to send the field" matters
  // when reading the corpus later.
  if (rawText === null || polishedText === null || expectedText === null) {
    return json({ error: "missing_text_fields" }, 400);
  }

  const failureKindRaw = stringField(form, "failure_kind");
  const failureKind =
    failureKindRaw && FAILURE_KINDS.has(failureKindRaw)
      ? (failureKindRaw as "wrong_word" | "punctuation" | "both" | "other")
      : null;
  const userNoteRaw = stringField(form, "user_note");
  const userNote =
    userNoteRaw && userNoteRaw.length > 0
      ? userNoteRaw.slice(0, MAX_NOTE_CHARS)
      : null;

  // 4. Look up the original usage_events row to (a) verify the user
  //    actually owns this transcription_client_id, and (b) snapshot
  //    provider/model/audioMs/etc. so the feedback row is
  //    self-contained even if usage rows ever get archived.
  //
  //    We allow the lookup to miss — older clients may have submitted
  //    transcriptions before usage_events tracked everything we want
  //    here, OR the row could have been pruned. In that case we still
  //    accept the report; provider/model fall back to "unknown" and
  //    the audio metadata fields stay null. The transcription_client_id
  //    itself is enough to dedupe later.
  const [usage] = await db
    .select({
      providerId: usageEvents.providerId,
      model: usageEvents.model,
      polishApplied: usageEvents.polishApplied,
      audioMs: usageEvents.audioMs,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, user.id),
        eq(usageEvents.transcriptionClientId, transcriptionClientId)
      )
    )
    .limit(1);

  // 5. Audio (optional). Stream straight into R2 — Workers' R2.put
  //    accepts a ReadableStream so we never buffer the full file in
  //    memory. Object key is the feedback id we'll insert below.
  const audioFile = form.get("audio");
  let audioObjectKey: string | null = null;
  if (audioFile && audioFile instanceof File && audioFile.size > 0) {
    if (audioFile.size > MAX_AUDIO_BYTES) {
      return json(
        { error: "audio_too_large", limitBytes: MAX_AUDIO_BYTES },
        413
      );
    }
    if (!env.FEEDBACK_AUDIO) {
      // Local `next dev` won't have the binding wired. Fail loudly so
      // it's not a silent data-loss path.
      return json(
        { error: "feedback_audio_bucket_not_bound" },
        500
      );
    }
    const feedbackId = crypto.randomUUID();
    audioObjectKey = `feedback/${feedbackId}.${extensionFor(audioFile.type)}`;
    try {
      // ArrayBuffer rather than .stream() because Workers' R2 typings
      // don't accept Web-spec ReadableStream<Uint8Array> directly. Files
      // are capped at 100 MB so the in-memory buffer is bounded.
      const buffer = await audioFile.arrayBuffer();
      await env.FEEDBACK_AUDIO.put(audioObjectKey, buffer, {
        httpMetadata: {
          contentType: audioFile.type || "audio/wav",
        },
        customMetadata: {
          user_id: user.id,
          org_id: orgRow.id,
          transcription_client_id: transcriptionClientId,
        },
      });
    } catch (err) {
      console.error("[feedback] R2 put failed:", err);
      return json(
        {
          error: "audio_upload_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500
      );
    }
  }

  // 6. Insert the feedback row. UUID is generated here so we can
  //    reuse it as the audio key (above) when one is present.
  const id = audioObjectKey
    ? audioObjectKey.replace(/^feedback\//, "").replace(/\.[^.]+$/, "")
    : crypto.randomUUID();
  const now = new Date();
  await db.insert(transcriptionFeedback).values({
    id,
    userId: user.id,
    orgId: orgRow.id,
    createdAt: now,
    transcriptionClientId,
    rawText,
    polishedText,
    expectedText,
    provider: usage?.providerId ?? "unknown",
    model: usage?.model ?? "unknown",
    polishApplied: usage?.polishApplied ?? false,
    polishMode: null, // we don't record polish_mode on usage_events; future enhancement
    audioSeconds:
      typeof usage?.audioMs === "number" ? usage.audioMs / 1000 : null,
    language: null,
    failureKind,
    userNote,
    audioObjectKey,
    status: "new",
  });

  // 7. PostHog signal so we can graph submission rate, audio-share
  //    rate, and failure_kind distribution.
  captureServerEvent({
    distinctId: user.id,
    event: "feedback_submitted",
    groups: { organization: orgRow.id },
    properties: {
      feedback_id: id,
      failure_kind: failureKind ?? "unspecified",
      audio_shared: audioObjectKey !== null,
      raw_chars: rawText.length,
      polished_chars: polishedText.length,
      expected_chars: expectedText.length,
      has_note: userNote !== null,
    },
  });

  return json({ id, status: "received" });
}

// ---- helpers --------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Read a string form field; returns null when absent. Coerces File
 *  parts to null since this helper is only for text fields. */
function stringField(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}

/** Map a content-type to a sensible file extension for the R2 object
 *  key. We accept whatever the client sends (WAV/MP3/OGG/M4A) since
 *  the same content-type passes through /api/transcribe verbatim. The
 *  key only affects what super-admin downloads see — the bytes are
 *  unchanged. */
function extensionFor(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/webm":
      return "webm";
    case "audio/flac":
      return "flac";
    default:
      return "wav"; // safe fallback; clients overwhelmingly send WAV
  }
}
