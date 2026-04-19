// Authorization — the thing Supabase RLS gave us for free that we now enforce
// in code. **Every server action and route handler that touches user data
// MUST go through one of these helpers.** If you find yourself calling
// getDb() directly in a route, stop — add a helper here instead.
//
// Mental model:
//   * `requireUser()` throws 401 if not signed in, returns the user.
//   * `requireSuperAdmin()` adds 403 if the user isn't a super admin.
//   * `requireOrgMember(orgId)` adds 403 if the user isn't a member of that
//     org (super admins bypass).
//   * `requireOrgAdmin(orgId)` requires owner|admin role (super admins bypass).
//
// The thrown errors are typed `AuthzError` with a `status` field; wrap your
// handler with `handleAuthz()` to turn them into the right HTTP response.

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgMembers, users, type OrgRole } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";

export class AuthzError extends Error {
  constructor(
    public status: 401 | 403 | 404,
    message: string
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
}

/** Throws 401 if not signed in. */
export async function requireUser(): Promise<AuthedUser> {
  const { auth } = await getAuth();
  const session = await auth();
  if (!session?.user?.id) {
    throw new AuthzError(401, "Not signed in");
  }

  // Session only carries email/name/image from Auth.js core. We hydrate the
  // rest from `users`. This is one D1 read per request and worth the
  // consistency — a user could be promoted to super admin and their existing
  // session should reflect that on next navigation.
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  const user = rows[0];
  if (!user) {
    // Session references a user that no longer exists — treat as signed out.
    throw new AuthzError(401, "User no longer exists");
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isSuperAdmin: user.isSuperAdmin,
  };
}

/** 401 if not signed in; 403 if not super admin. */
export async function requireSuperAdmin(): Promise<AuthedUser> {
  const user = await requireUser();
  if (!user.isSuperAdmin) {
    throw new AuthzError(403, "Super admin required");
  }
  return user;
}

/** 401 if not signed in; 403 if not a member of `orgId` (super admins pass). */
export async function requireOrgMember(orgId: string): Promise<{
  user: AuthedUser;
  role: OrgRole;
}> {
  const user = await requireUser();
  if (user.isSuperAdmin) {
    return { user, role: "owner" };  // super admins act as owners
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, user.id), eq(orgMembers.orgId, orgId)))
    .limit(1);
  const m = rows[0];
  if (!m) {
    throw new AuthzError(403, "Not a member of this org");
  }
  return { user, role: m.role };
}

/** 401; 403 if not an owner/admin of `orgId` (super admins pass). */
export async function requireOrgAdmin(orgId: string): Promise<{
  user: AuthedUser;
  role: OrgRole;
}> {
  const { user, role } = await requireOrgMember(orgId);
  if (role !== "owner" && role !== "admin") {
    throw new AuthzError(403, "Org admin required");
  }
  return { user, role };
}

/**
 * Wrap a route handler to translate `AuthzError` into a proper HTTP response.
 * Other thrown errors are re-thrown so Next.js renders the error boundary.
 *
 *     export const POST = handleAuthz(async (req) => {
 *       const user = await requireSuperAdmin();
 *       // ...
 *       return Response.json({ ok: true });
 *     });
 */
export function handleAuthz<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof AuthzError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
