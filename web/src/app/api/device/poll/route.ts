// POST /api/device/poll
//
// Mac polls this with the device_code it received from /api/device/start.
// Three possible responses:
//
//   * 200 { status: "pending" }               — user hasn't approved yet
//   * 200 { status: "authorized", access_token, user: {...} }
//                                              — one-shot, consumed this call
//   * 410 { status: "expired" }                — 10 min elapsed or already
//                                              used; Mac should re-start the flow
//
// Authorization happens by the user visiting /link, signing in (or already
// signed in), and confirming the user_code. At that point our /link/actions
// path stamps device_auth_codes.user_id + approved_at. This handler flips
// approved_at → consumed_at, creates a mac_sessions row, and returns the
// plaintext bearer token exactly once.
//
// The returned token is NEVER stored in plaintext on our side — we keep its
// SHA-256 hash in mac_sessions.refresh_token_hash. If the Mac loses the
// token, the user has to sign in again (no recovery path by design — it's
// a refresh token, treat it like a password).

import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { deviceAuthCodes, macSessions } from "@/lib/db/schema";
import { hashToken } from "@/lib/authz";

const bodySchema = z.object({
  device_code: z.string().min(32).max(128),
});

export async function POST(req: Request): Promise<Response> {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date();

  const [row] = await db
    .select()
    .from(deviceAuthCodes)
    .where(eq(deviceAuthCodes.deviceCode, parsed.data.device_code))
    .limit(1);

  if (!row) {
    return Response.json({ status: "expired" }, { status: 410 });
  }
  if (row.consumedAt) {
    // Already exchanged — protect against replay.
    return Response.json({ status: "expired" }, { status: 410 });
  }
  if (row.expiresAt.getTime() < now.getTime()) {
    return Response.json({ status: "expired" }, { status: 410 });
  }
  if (!row.userId || !row.approvedAt) {
    return Response.json({ status: "pending" });
  }

  // Approved! Mint the session. Token is 48 hex chars (192 bits) — enough
  // entropy for a refresh token, short enough to fit in Authorization headers
  // without cluttering logs.
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  const accessToken = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hash = await hashToken(accessToken);

  // Atomicity note: we do consume-then-create as two statements. If the second
  // fails the device code is burned but no session was issued — the user
  // re-starts the flow. Preferable to the inverse (session issued but code
  // still reusable, which would allow replay). D1 doesn't expose
  // transactions via the binding API, so this is the safest order.
  await db
    .update(deviceAuthCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(deviceAuthCodes.deviceCode, parsed.data.device_code),
        isNull(deviceAuthCodes.consumedAt),
        isNotNull(deviceAuthCodes.approvedAt),
        gt(deviceAuthCodes.expiresAt, now)
      )
    );

  await db.insert(macSessions).values({
    userId: row.userId,
    refreshTokenHash: hash,
    deviceName: row.deviceName,
    lastUsedAt: now,
  });

  return Response.json({
    status: "authorized",
    access_token: accessToken,
    user: { id: row.userId },
  });
}
