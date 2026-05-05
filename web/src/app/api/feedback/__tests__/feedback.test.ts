// Tests for POST /api/feedback.
//
// Covers the four reasons a submission can be rejected (auth, no-org,
// org opt-out, missing required fields), plus the two happy paths
// (with audio / text-only) and the snapshot-from-usage_events join.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDbHandle } from "@/test/db";
import { makeMembership, makeOrg, makeUser } from "@/test/factories";
import { getDb } from "@/lib/db";
import {
  organizations,
  transcriptionFeedback,
  usageEvents,
} from "@/lib/db/schema";
import type { AuthedUser } from "@/lib/authz";

// Mocks shared across tests. Each test seeds these before calling POST().
const state: {
  user: AuthedUser | null;
  authError: boolean;
  putRecord: { key: string; bytes: number; type: string } | null;
} = { user: null, authError: false, putRecord: null };

// Minimal authz mock. We don't `importActual` because next-auth's
// transitive imports include `next/server` which Vitest can't resolve
// in our test runtime. The route's auth fallback returns 401 for any
// thrown error, so the AuthzError-class fidelity isn't load-bearing
// for these tests — a plain Error reaches the same code path.
vi.mock("@/lib/authz", () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireUserFromRequest: async () => {
      if (state.authError) {
        throw new AuthzError(401, "no session");
      }
      if (!state.user) {
        throw new AuthzError(401, "no user set in test state");
      }
      return state.user;
    },
  };
});

// Fake R2 bucket. Records the last put call so tests can assert key
// formatting and that the audio bytes flowed through.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: {
      FEEDBACK_AUDIO: {
        async put(
          key: string,
          body: ArrayBuffer,
          opts?: { httpMetadata?: { contentType?: string } }
        ) {
          state.putRecord = {
            key,
            bytes: body.byteLength,
            type: opts?.httpMetadata?.contentType ?? "",
          };
          return { key };
        },
      },
    },
  }),
}));

// PostHog server helper is a no-op in tests — env.public.NEXT_PUBLIC_
// _POSTHOG_KEY is unset so getClient() returns null. Nothing to mock.

let handle: TestDbHandle;
let POST: typeof import("../route").POST;

beforeEach(async () => {
  handle = setupTestDb();
  state.user = null;
  state.authError = false;
  state.putRecord = null;
  // Import the route AFTER the test DB + mocks are wired so the route
  // module's top-level imports see the mocked authz/cloudflare.
  ({ POST } = await import("../route"));
});

afterEach(() => {
  handle.close();
  vi.resetModules();
});

// Helper: build a multipart Request body the route expects.
function makeRequest(opts: {
  transcriptionClientId?: string;
  rawText?: string | null;
  polishedText?: string | null;
  expectedText?: string | null;
  failureKind?: string;
  userNote?: string;
  audio?: { bytes: Uint8Array; type: string } | null;
}): Request {
  const form = new FormData();
  if (opts.transcriptionClientId !== undefined) {
    form.set("transcription_client_id", opts.transcriptionClientId);
  }
  if (opts.rawText !== undefined && opts.rawText !== null) {
    form.set("raw_text", opts.rawText);
  }
  if (opts.polishedText !== undefined && opts.polishedText !== null) {
    form.set("polished_text", opts.polishedText);
  }
  if (opts.expectedText !== undefined && opts.expectedText !== null) {
    form.set("expected_text", opts.expectedText);
  }
  if (opts.failureKind !== undefined) {
    form.set("failure_kind", opts.failureKind);
  }
  if (opts.userNote !== undefined) {
    form.set("user_note", opts.userNote);
  }
  if (opts.audio) {
    // Cast through `as BlobPart` because TS5 narrows
    // Uint8Array<ArrayBufferLike> away from File's expected
    // ArrayBufferView<ArrayBuffer>; runtime-correct, types are just
    // overly strict in this corner.
    const blob = new Blob([opts.audio.bytes as BlobPart], {
      type: opts.audio.type,
    });
    form.set("audio", new File([blob], "rec.wav", { type: opts.audio.type }));
  }
  return new Request("https://example.test/api/feedback", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/feedback", () => {
  it("returns 401 when no user is signed in", async () => {
    state.authError = true;
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the user has no org", async () => {
    const u = await makeUser({ email: "noorg@example.com" });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "abc12345",
        rawText: "raw",
        polishedText: "Polished.",
        expectedText: "Expected.",
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_org" });
  });

  it("returns 403 when the org has feedback disabled", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg({ name: "Off Org" });
    await getDb()
      .update(organizations)
      .set({ feedbackDisabled: true })
      .where(eq(organizations.id, org.id));
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "abc12345",
        rawText: "raw",
        polishedText: "Polished.",
        expectedText: "Expected.",
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "feedback_disabled_for_org",
    });
  });

  it("rejects requests missing transcription_client_id", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        rawText: "raw",
        polishedText: "Polished.",
        expectedText: "Expected.",
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "missing_transcription_client_id",
    });
  });

  it("rejects requests missing required text fields", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "abc12345",
        rawText: "raw",
        polishedText: "Polished.",
        // expectedText omitted
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_text_fields" });
  });

  it("accepts a text-only submission and stores it as new", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "tcli12345",
        rawText: "hi this is mike brevort",
        polishedText: "Hi, this is Mike Brevort.",
        expectedText: "Hi, this is Mike Brevoort.",
        failureKind: "wrong_word",
        userNote: "proper noun mishear",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status?: string };
    expect(body).toMatchObject({ status: "received" });
    expect(typeof body.id).toBe("string");

    const rows = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: u.id,
      orgId: org.id,
      transcriptionClientId: "tcli12345",
      rawText: "hi this is mike brevort",
      polishedText: "Hi, this is Mike Brevort.",
      expectedText: "Hi, this is Mike Brevoort.",
      failureKind: "wrong_word",
      userNote: "proper noun mishear",
      audioObjectKey: null,
      status: "new",
      provider: "unknown", // no usage_events row to join from
      model: "unknown",
    });
    expect(state.putRecord).toBeNull(); // no R2 put for text-only
  });

  it("accepts an audio submission and uploads to R2", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]); // RIFF header bytes
    const res = await POST(
      makeRequest({
        transcriptionClientId: "tcli99999",
        rawText: "raw",
        polishedText: "Polished.",
        expectedText: "Expected.",
        audio: { bytes: audioBytes, type: "audio/wav" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status?: string };

    const [row] = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, body.id));
    expect(row.audioObjectKey).toBe(`feedback/${body.id}.wav`);

    expect(state.putRecord).toEqual({
      key: `feedback/${body.id}.wav`,
      bytes: audioBytes.byteLength,
      type: "audio/wav",
    });
  });

  it("snapshots provider/model from a matching usage_events row", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    // Seed a usage event the feedback row should join against.
    await getDb().insert(usageEvents).values({
      orgId: org.id,
      userId: u.id,
      transcriptionClientId: "tcli77777",
      providerId: "groq",
      model: "whisper-large-v3-turbo",
      wordCount: 5,
      audioMs: 3200,
      polishApplied: true,
    });

    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "tcli77777",
        rawText: "x",
        polishedText: "x",
        expectedText: "y",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status?: string };

    const [row] = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, body.id));
    expect(row.provider).toBe("groq");
    expect(row.model).toBe("whisper-large-v3-turbo");
    expect(row.polishApplied).toBe(true);
    expect(row.audioSeconds).toBe(3.2);
  });

  it("ignores invalid failure_kind values rather than 400ing", async () => {
    const u = await makeUser({ email: "u@example.com" });
    const org = await makeOrg();
    await makeMembership({ orgId: org.id, userId: u.id });
    state.user = {
      id: u.id,
      email: u.email,
      displayName: null,
      isSuperAdmin: false,
    };
    const res = await POST(
      makeRequest({
        transcriptionClientId: "tcli12345",
        rawText: "x",
        polishedText: "x",
        expectedText: "y",
        failureKind: "totally-invalid",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status?: string };
    const [row] = await getDb()
      .select()
      .from(transcriptionFeedback)
      .where(eq(transcriptionFeedback.id, body.id));
    expect(row.failureKind).toBeNull();
  });
});
