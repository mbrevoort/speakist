// Deepgram API helpers. Specifically: minting short-lived scoped keys for
// the Mac app so the Mac talks to Deepgram directly (low latency + our
// privacy promise — the audio never touches our servers).
//
// Strategy: Deepgram's "project keys" API supports `time_to_live_in_seconds`.
// We mint a new key per Mac transcription (or reuse within TTL — the Mac
// decides; server side is stateless here), give it the minimum scope needed
// (`usage:write`, which covers /v1/listen), and let Deepgram auto-delete it
// after the TTL. Server-side this is a single POST; no cleanup job needed.
//
// Key lookup order (which Deepgram project pays for this transcription):
//   1. Org has deepgram_key_override_encrypted set → decrypt + use that key
//      (the org's own Deepgram project pays)
//   2. Else → app_settings.system_deepgram_key_encrypted
//      (our Deepgram project pays; org's credit_ledger is debited at
//      retail in /api/usage)
//   3. Else → error. Super admin hasn't configured the system key yet.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings, organizations } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";

export interface MintedDeepgramKey {
  key: string;
  expiresAt: Date;
  source: "org_override" | "system";
}

/** Default lifetime for an ephemeral key. Long enough for a 5-min recording
 *  plus retry window; short enough that a leaked key is quickly useless. */
const DEFAULT_TTL_SECONDS = 600;

/**
 * Resolve which long-lived Deepgram key to scope a temp token off of. Throws
 * if neither the org nor the system has a key configured.
 */
async function resolveProjectKey(
  orgId: string
): Promise<{ key: string; source: "org_override" | "system" }> {
  const db = getDb();

  const [org] = await db
    .select({ override: organizations.deepgramKeyOverrideEncrypted })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (org?.override) {
    return { key: await decryptSecret(org.override), source: "org_override" };
  }

  const [settings] = await db
    .select({ key: appSettings.systemDeepgramKeyEncrypted })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);

  if (settings?.key) {
    return { key: await decryptSecret(settings.key), source: "system" };
  }

  throw new Error(
    "No Deepgram key configured. Super admin needs to set the system key at /admin/system."
  );
}

/**
 * Mint a short-lived scoped Deepgram API key. Returns the plaintext key; the
 * Mac app sends it straight to Deepgram as `Authorization: Token <key>`.
 *
 * Requires DEEPGRAM_PROJECT_ID env var — the Deepgram project the keys live
 * under. Each org's override or the system key must belong to this project.
 */
export async function mintDeepgramKey(
  orgId: string,
  opts?: { ttlSeconds?: number; comment?: string }
): Promise<MintedDeepgramKey> {
  const projectId = process.env.DEEPGRAM_PROJECT_ID;
  if (!projectId) {
    throw new Error("DEEPGRAM_PROJECT_ID is not set");
  }

  const { key: projectKey, source } = await resolveProjectKey(orgId);
  const ttl = opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const res = await fetch(
    `https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${projectKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment: opts?.comment ?? `Speakist ephemeral key (org=${orgId})`,
        scopes: ["usage:write"],
        time_to_live_in_seconds: ttl,
        tags: ["speakist", "ephemeral"],
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `Deepgram key mint failed: ${res.status} ${res.statusText} ${body}`
    );
  }

  const json = (await res.json()) as { key?: string; api_key?: string };
  // Deepgram's response field name varies by account age — accept either.
  const key = json.key ?? json.api_key;
  if (!key) {
    throw new Error("Deepgram key mint response missing `key` field");
  }

  return {
    key,
    expiresAt: new Date(Date.now() + ttl * 1000),
    source,
  };
}
