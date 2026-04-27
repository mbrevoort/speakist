// GET /api/me
//
// The Mac app calls this right after sign-in (and on launch if already signed
// in) to fetch enough user + org context to render the Settings → Account
// view: email, display name, org name/role, and the current balance so the
// Mac can surface low-credit hints proactively.
//
// Intentionally small payload — no usage history, no member list. The Mac
// doesn't render either.
//
// Auth: bearer (or session cookie for web debugging via /api/me in a
// browser tab). 401 on no session, 200 + body otherwise. If the user has no
// org (edge case after leaving/deleting the last one), `org` is null rather
// than error; the Mac shows a "set up a workspace" hint.

import { eq } from "drizzle-orm";
import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { resolvePromptForMode, type PolishMode } from "@/lib/transcription/polish";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const org = await getCurrentOrgForUser(user.id);
    const balance = org ? await getOrgCreditBalance(org.id) : 0;

    // Polish prefs — one extra row read, cheap. Mac caches the result
    // so Settings renders with the right state on launch without a
    // second round-trip.
    const db = getDb();
    const [prefs] = await db
      .select({
        enabled: users.polishEnabled,
        mode: users.polishMode,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    const mode: PolishMode = (prefs?.mode as PolishMode) ?? "prescriptive";
    const prompt = await resolvePromptForMode(mode);

    return Response.json({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      is_super_admin: user.isSuperAdmin,
      org: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: org.role,
            is_comped: org.isComped,
            balance_millicents: balance,
          }
        : null,
      polish: {
        enabled: !!prefs?.enabled,
        mode,
        // The active prompt the server will use given the selected
        // mode, including any super-admin override from app_settings.
        // End users can't customize the prompt anymore — `is_custom`
        // and `default_prompt` are kept in the payload so older
        // clients that read them don't crash, but is_custom is
        // permanently false now.
        system_prompt: prompt,
        is_custom: false,
        default_prompt: prompt,
      },
    });
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
