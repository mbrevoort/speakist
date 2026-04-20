// POST /api/deepgram/token
//
// The Mac app hits this right before every transcription (or reuses a still-
// valid key from the previous call). We return a short-lived scoped Deepgram
// API key the Mac uses directly as `Authorization: Token <key>` against
// `https://api.deepgram.com/v1/listen`.
//
// Important privacy detail: the *audio* never touches this server. The Mac
// → Deepgram request carries the audio; we only mint the token that
// authorizes it. That's the "your voice stays on your Mac" claim on the
// landing page — load-bearing.
//
// Auth: bearer (Mac session). Returns 401 on bad or missing token.
//
// Response shape matches what the Mac's SpeakistAPIClient expects:
//   { key: string, expires_at: ISO8601 }
//
// Failure modes:
//   * 401 — not signed in / bad bearer
//   * 402 — org balance is ≤ 0 and not comped → Mac should refuse to
//           record (Phase 6 Mac-side enforcement is permissive; Phase 7
//           will tighten this)
//   * 500 — Deepgram mint failed or no system/override key configured

import { requireUserFromRequest, AuthzError } from "@/lib/authz";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { mintDeepgramKey } from "@/lib/deepgram";

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    return Response.json({ error: "no_org" }, { status: 400 });
  }

  // Balance gate. Comped orgs bypass. Zero-balance orgs get a 402 so the Mac
  // can show a friendly "top up to continue" state instead of a cryptic
  // Deepgram error mid-transcription. We don't block negative balances
  // hard in Phase 6 — the business may want to extend credit to trusted
  // users. The Mac treats 402 as a hint, not a hard stop.
  if (!org.isComped) {
    const balance = await getOrgCreditBalance(org.id);
    if (balance <= 0) {
      return Response.json(
        { error: "insufficient_credit", balance_millicents: balance },
        { status: 402 }
      );
    }
  }

  try {
    const minted = await mintDeepgramKey(org.id, {
      comment: `Speakist user=${user.email} session`,
    });
    return Response.json({
      key: minted.key,
      expires_at: minted.expiresAt.toISOString(),
      source: minted.source,
    });
  } catch (err) {
    console.error("[deepgram/token] mint failed:", err);
    const msg = err instanceof Error ? err.message : "mint failed";
    return Response.json(
      { error: "mint_failed", detail: msg },
      { status: 500 }
    );
  }
}
