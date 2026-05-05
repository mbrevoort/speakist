// Authorization — the thing Supabase RLS gave us for free that we now enforce
// in code. **Every server action and route handler that touches user data
// MUST go through one of these helpers.** If you find yourself calling
// getDb() directly in a route, stop — add a helper here instead.
//
// Two auth surfaces:
//   * Web (Auth.js session cookie) — requireUser() and friends. Used by
//     dashboard RSC pages + server actions.
//   * Mac app (Bearer <token>) — requireUserFromRequest(req). Used by API
//     routes the Mac app calls. The bearer is a plaintext token; we hash
//     it and look up in mac_sessions for user_id. Every successful lookup
//     bumps mac_sessions.last_used_at so idle sessions surface in the
//     "revoke session" UI.
//
// API routes that need to accept *either* shape (like /api/usage, called by
// the Mac normally but usable from a web session for testing) use
// requireUserFromRequest — it tries bearer first, falls back to cookie.

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { macSessions, orgMembers, users, type OrgRole } from "@/lib/db/schema";
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

// --- bearer token support --------------------------------------------------

// `hashToken` lives in `lib/hash.ts` so service-tokens (and any other
// non-authz consumer) can import it without pulling next-auth into
// the test-time module graph. Re-exported here for back-compat with
// callers that already imported it from authz.
export { hashToken } from "@/lib/hash";
import { hashToken } from "@/lib/hash";

/**
 * Resolve a Mac-app bearer token to a user. Updates last_used_at on success.
 * Returns null if the token isn't recognized or the session is revoked.
 */
async function userFromBearer(bearerToken: string): Promise<AuthedUser | null> {
  if (bearerToken.length < 16) return null;
  const hash = await hashToken(bearerToken);
  const db = getDb();
  const rows = await db
    .select({
      sessionId: macSessions.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      isSuperAdmin: users.isSuperAdmin,
    })
    .from(macSessions)
    .innerJoin(users, eq(users.id, macSessions.userId))
    .where(and(eq(macSessions.refreshTokenHash, hash), isNull(macSessions.revokedAt)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;

  // Bump last_used_at. Fire-and-forget — if it fails we still authorize this
  // request; the user just won't see a fresh timestamp in their sessions UI.
  db.update(macSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(macSessions.id, r.sessionId))
    .catch((err) => console.error("[authz] failed to bump last_used_at:", err));

  return {
    id: r.userId,
    email: r.email,
    displayName: r.displayName,
    isSuperAdmin: r.isSuperAdmin,
  };
}

// --- cookie-based helpers (web) -------------------------------------------

/** Throws 401 if not signed in (via Auth.js cookie). */
export async function requireUser(): Promise<AuthedUser> {
  const { auth } = await getAuth();
  const session = await auth();
  if (!session?.user?.id) {
    throw new AuthzError(401, "Not signed in");
  }

  // Hydrate from DB so `isSuperAdmin` reflects current state even on a
  // long-lived session issued before promotion.
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  const user = rows[0];
  if (!user) {
    throw new AuthzError(401, "User no longer exists");
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isSuperAdmin: user.isSuperAdmin,
  };
}

// --- request-aware helper (API routes) ------------------------------------

/**
 * API-route authentication. Tries Bearer (Mac sessions) first, falls back to
 * Auth.js session cookie (web). Throws 401 if neither succeeds.
 */
// Bearer extraction lives in `lib/bearer.ts` so non-auth modules can
// parse the header without dragging the next-auth surface into their
// import graph. Re-exported here for back-compat.
export { extractBearer } from "@/lib/bearer";
import { extractBearer } from "@/lib/bearer";

export async function requireUserFromRequest(req: Request): Promise<AuthedUser> {
  const token = extractBearer(req);
  if (token !== null) {
    const user = await userFromBearer(token);
    if (user) return user;
    // Explicit 401 — don't silently fall through to cookie auth for a
    // malformed Bearer; that would mask Mac-app misconfig.
    throw new AuthzError(401, "Invalid bearer token");
  }
  return requireUser();
}

// --- role/membership helpers (shared; both auth paths converge on AuthedUser)

export async function requireSuperAdmin(): Promise<AuthedUser> {
  const user = await requireUser();
  if (!user.isSuperAdmin) {
    throw new AuthzError(403, "Super admin required");
  }
  return user;
}

/** Bearer/cookie-aware super-admin gate. Resolves the caller, verifies
 *  super-admin, and throws AuthzError(403) otherwise. Used by
 *  /api/admin/* routes that need to support both web sessions and the
 *  Mac-app bearer (e.g., super-admin-only token-management
 *  endpoints). */
export async function requireSuperAdminFromRequest(req: Request): Promise<AuthedUser> {
  const user = await requireUserFromRequest(req);
  if (!user.isSuperAdmin) {
    throw new AuthzError(403, "Super admin required");
  }
  return user;
}

export async function requireOrgMember(orgId: string): Promise<{
  user: AuthedUser;
  role: OrgRole;
}> {
  const user = await requireUser();
  if (user.isSuperAdmin) {
    return { user, role: "owner" };
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
