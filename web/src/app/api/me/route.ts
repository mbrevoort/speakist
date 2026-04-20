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

import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUserFromRequest(req);
    const org = await getCurrentOrgForUser(user.id);
    const balance = org ? await getOrgCreditBalance(org.id) : 0;

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
    });
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
