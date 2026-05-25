// Authorization-header bearer parsing. Lives apart from `lib/authz.ts`
// because authz pulls in next-auth, and modules that just need to
// pluck a bearer value out of a header (MCP route, feedback-access
// helper) shouldn't have to drag the auth surface into their
// test-time import graph.

/** Pull the bearer-token value out of an `Authorization: Bearer …`
 *  header. Returns null when the header is absent or doesn't carry a
 *  bearer scheme. Both casings of the header name are checked since
 *  Workers / Node disagree on canonical case. */
export function extractBearer(req: Request): string | null {
  const auth =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
