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
import { DEFAULT_CLEANUP_PROMPT } from "@/lib/transcription/cleanup";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const org = await getCurrentOrgForUser(user.id);
    const balance = org ? await getOrgCreditBalance(org.id) : 0;

    // Cleanup prefs — one extra row read, cheap. Mac caches the result
    // so Settings renders with the right state on launch without a
    // second round-trip.
    const db = getDb();
    const [prefs] = await db
      .select({
        enabled: users.cleanupEnabled,
        prompt: users.cleanupSystemPrompt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

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
      cleanup: {
        enabled: !!prefs?.enabled,
        // `null` on the user row → return the default so Mac shows it
        // pre-filled in the Settings editor. `isCustom` tells the Mac
        // whether the prompt on the user row is a custom override or
        // the server default baked into the response.
        system_prompt: prefs?.prompt ?? DEFAULT_CLEANUP_PROMPT,
        is_custom: !!prefs?.prompt,
        default_prompt: DEFAULT_CLEANUP_PROMPT,
      },
    });
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
