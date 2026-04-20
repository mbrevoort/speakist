// POST /api/device/start
//
// Mac app calls this with no auth (it has no session yet). We return:
//   * user_code   — short human-typable ("7F3Q-X2K9"), shown to the user
//   * device_code — opaque, long; the Mac polls with this
//   * verification_url — where to send the user
//   * interval — suggested poll interval in seconds
//   * expires_in — seconds until the pair is dead (matches the DB row)
//
// No rate limiting in Phase 6; if device/start gets abused we'd cap by IP
// via Cloudflare's native tools. The flow itself is already rate-limited by
// the 10-minute expiry window + the human step.

import { z } from "zod";
import { getDb } from "@/lib/db";
import { deviceAuthCodes } from "@/lib/db/schema";
import { generateDeviceUserCode } from "@/lib/utils";

const DEVICE_CODE_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 3;

const bodySchema = z.object({
  deviceName: z.string().trim().max(120).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const json = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(json);
  const deviceName = parsed.success ? parsed.data.deviceName : undefined;

  const db = getDb();

  // device_code: 64 hex chars (256 bits). Long, opaque.
  const deviceBytes = new Uint8Array(32);
  crypto.getRandomValues(deviceBytes);
  const deviceCode = Array.from(deviceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // user_code: 8 base32-ish chars with a dash. Unambiguous alphabet.
  const userCode = generateDeviceUserCode();

  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);
  await db.insert(deviceAuthCodes).values({
    userCode,
    deviceCode,
    expiresAt,
    deviceName: deviceName ?? null,
  });

  const origin = new URL(req.url).origin;

  return Response.json({
    user_code: userCode,
    device_code: deviceCode,
    verification_url: `${origin}/link`,
    verification_url_with_code: `${origin}/link?code=${encodeURIComponent(userCode)}`,
    interval: POLL_INTERVAL_SECONDS,
    expires_in: DEVICE_CODE_TTL_SECONDS,
  });
}
