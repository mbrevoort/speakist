// POST /api/admin/releases/publish
//
// Called by scripts/release.sh after it's uploaded a DMG to R2. Writes a
// row to the `releases` table so the dynamic appcast + download endpoints
// pick up the new version immediately.
//
// Auth: shared-secret bearer token set as the RELEASE_PUBLISH_TOKEN
// Worker secret. Not Auth.js session — this is called from the release
// machine's shell, not from a browser.
//
// Body (JSON):
//   {
//     channel: "stable" | "beta" | "dev",
//     version: "0.2.0",
//     buildNumber: 7,
//     dmgUrl: "https://downloads.speakist.ai/Speakist-0.2.0.dmg",
//     dmgSizeBytes: 18234567,
//     sparkleSignature: "sparkle:edSignature=\"...\" length=\"...\"",
//     minimumSystemVersion?: "14.0",
//     releaseNotes?: "..."
//   }
//
// Responses:
//   200 { ok: true, id } — inserted, or already existed (idempotent)
//   401 { error: "unauthorized" } — bad or missing bearer
//   400 { error: "bad_body", issues } — zod validation
//
// Idempotent on (channel, version, build_number) — safe to retry.

import { z } from "zod";
import { publishRelease } from "@/lib/releases";

const bodySchema = z.object({
  channel: z.enum(["stable", "beta", "dev"]),
  version: z.string().min(1).max(32),
  buildNumber: z.number().int().positive(),
  dmgUrl: z.string().url(),
  dmgSizeBytes: z.number().int().positive(),
  // The full `sparkle:edSignature="..." length="..."` pair from sign_update.
  sparkleSignature: z.string().min(20).max(500),
  minimumSystemVersion: z.string().optional(),
  releaseNotes: z.string().max(10_000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.RELEASE_PUBLISH_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "RELEASE_PUBLISH_TOKEN not configured on this Worker" },
      { status: 503 }
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const presented = authHeader.slice("Bearer ".length).trim();
  // Constant-time compare. The `if (a.length !== b.length)` short-circuit is
  // fine — length doesn't leak useful info for this kind of token.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  try {
    const release = await publishRelease(parsed.data);
    return Response.json({
      ok: true,
      id: release.id,
      channel: release.channel,
      version: release.version,
      buildNumber: release.buildNumber,
    });
  } catch (err) {
    console.error("[releases/publish] failed:", err);
    return Response.json(
      { error: "publish_failed", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
