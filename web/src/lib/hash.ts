// Tiny dependency-free hashing primitives. Lives apart from
// `lib/authz.ts` because authz pulls in next-auth, and modules that
// just need a SHA-256 (service-tokens, future signing helpers)
// shouldn't have to drag the auth surface into their test-time
// import graph.

/** Hex-encoded SHA-256 of `input`. Stable across Workers + Node;
 *  uses Web Crypto. Used by:
 *    * authz.userFromBearer  — Mac session refresh-token lookup
 *    * service-tokens        — bearer service-token lookup
 */
export async function hashToken(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
