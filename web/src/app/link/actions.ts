// /link page server actions.
//
// confirmDeviceCode validates the user_code against device_auth_codes,
// stamps user_id + approved_at on success. /api/device/poll then hands
// out an access token on the next Mac poll. Pre-condition: the signed-in
// user has exactly one org (one-org-per-user invariant). If they have
// none, we surface a friendly "set up a workspace first" error so the
// Mac can show the right hint.

"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { deviceAuthCodes } from "@/lib/db/schema";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";

export type ConfirmResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const schema = z.object({
  // Normalize to the "XXXX-XXXX" format we generate; strip whitespace and
  // ensure uppercase so users pasting from anywhere aren't tripped by case.
  user_code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase().replace(/\s+/g, ""))
    .pipe(z.string().min(8).max(16)),
});

export async function confirmDeviceCode(
  formData: FormData
): Promise<ConfirmResult> {
  const user = await requireUser();

  const parsed = schema.safeParse({
    user_code: formData.get("user_code"),
  });
  if (!parsed.success) {
    return { ok: false, error: "That doesn't look like a valid code." };
  }
  const userCode = parsed.data.user_code;

  // No-org guard. With one-org-per-user, anyone authorizing a device must
  // already be in an org — otherwise the Mac wouldn't have anywhere to
  // bill against. Send them back to /dashboard where the no-org panel
  // will offer to create a workspace or accept a pending invite.
  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    return {
      ok: false,
      error:
        "You don't have a workspace yet. Set one up on the dashboard first, then try linking again.",
    };
  }

  const db = getDb();
  const now = new Date();
  const [row] = await db
    .select()
    .from(deviceAuthCodes)
    .where(eq(deviceAuthCodes.userCode, userCode))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      error: "We couldn't find that code. Double-check what your Mac is showing.",
    };
  }
  if (row.expiresAt.getTime() < now.getTime()) {
    return {
      ok: false,
      error: "This code expired. Go back to your Mac and try again.",
    };
  }
  if (row.consumedAt) {
    return {
      ok: false,
      error: "This code was already used.",
    };
  }
  if (row.userId && row.approvedAt) {
    return { ok: true, message: "You're already approved — return to your Mac." };
  }

  await db
    .update(deviceAuthCodes)
    .set({ userId: user.id, approvedAt: now })
    .where(
      and(
        eq(deviceAuthCodes.userCode, userCode),
        isNull(deviceAuthCodes.approvedAt),
        gt(deviceAuthCodes.expiresAt, now)
      )
    );

  return {
    ok: true,
    message:
      "You're approved — return to your Mac. The app should sign in within a few seconds.",
  };
}
