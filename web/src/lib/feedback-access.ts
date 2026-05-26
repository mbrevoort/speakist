// Auth gate for /api/admin/feedback* and /api/mcp.
//
// Two valid bearers reach these endpoints:
//
//   1. A super-admin's regular session (Auth.js cookie OR Mac/iOS
//      bearer that resolves to a user via `requireUserFromRequest`).
//      Implicitly grants every scope.
//   2. A service token (`Authorization: Bearer ssat_<value>`),
//      created at /admin/tokens. Carries an explicit scope set.
//
// `requireFeedbackAccess` returns a discriminated union the caller
// can branch on if they need the human-readable identity for
// logging. Most call sites just await it for the side effect of
// "throw 401/403 if not allowed."

import { AuthzError, requireUserFromRequest } from "@/lib/authz";
import { extractBearer } from "@/lib/bearer";
import {
  TOKEN_PREFIX,
  verifyServiceToken,
  type ServiceScope,
} from "@/lib/service-tokens";

export type FeedbackPrincipal =
  | {
      kind: "user";
      userId: string;
      email: string;
    }
  | {
      kind: "service";
      tokenId: string;
      scopes: ServiceScope[];
    };

/**
 * Return a verified principal that's allowed to call a feedback
 * endpoint requiring `scope`, or throw an AuthzError. Service tokens
 * gate per-scope; super-admin sessions are super-set and pass any
 * scope check.
 *
 * The bearer is sniffed first because routing through
 * `requireUserFromRequest` would prefer a cookie session over the
 * bearer when both are present — letting a cookie silently grant
 * super-admin scope to a request that explicitly chose to authenticate
 * with a narrower service token.
 */
export async function requireFeedbackAccess(
  req: Request,
  scope: ServiceScope
): Promise<FeedbackPrincipal> {
  const bearer = extractBearer(req);
  if (bearer && bearer.startsWith(TOKEN_PREFIX)) {
    const verified = await verifyServiceToken(bearer);
    if (!verified) {
      throw new AuthzError(401, "invalid or revoked service token");
    }
    if (!verified.scopes.includes(scope)) {
      throw new AuthzError(
        403,
        `service token missing required scope: ${scope}`
      );
    }
    return {
      kind: "service",
      tokenId: verified.id,
      scopes: verified.scopes,
    };
  }

  const user = await requireUserFromRequest(req);
  if (!user.isSuperAdmin) {
    throw new AuthzError(403, "super-admin required");
  }
  return { kind: "user", userId: user.id, email: user.email };
}
