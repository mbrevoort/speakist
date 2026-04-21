// Per-(org, provider) API key resolution.
//
// Lookup order:
//   1. Org-specific override (encrypted in the DB).
//      For Phase A only Deepgram has an override column — we reuse the
//      existing `organizations.deepgramKeyOverrideEncrypted`. Phase B adds
//      a `providerKeysEncrypted` JSON envelope column covering all providers.
//   2. Environment secret (wrangler secret put X --env dev|production).
//   3. Throw — admin hasn't configured this provider yet.
//
// The Worker's env is passed explicitly rather than pulled via
// `getCloudflareContext()` to keep this module pure-ish and testable.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { TranscriptionDispatchError, type ProviderId } from "./types";

/**
 * Minimal shape of the Cloudflare env we care about. Listed as optional so
 * a missing secret surfaces as `TranscriptionDispatchError` rather than
 * a runtime "undefined is not a function" kind of crash.
 */
export interface ProviderKeyEnv {
  DEEPGRAM_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
}

const ENV_KEY_FIELD: Record<ProviderId, keyof ProviderKeyEnv> = {
  deepgram: "DEEPGRAM_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
};

export async function resolveProviderKey(
  env: ProviderKeyEnv,
  orgId: string,
  providerId: ProviderId
): Promise<string> {
  // 1. Org override (Deepgram only in Phase A).
  if (providerId === "deepgram") {
    const db = getDb();
    const [row] = await db
      .select({ override: organizations.deepgramKeyOverrideEncrypted })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (row?.override) {
      return decryptSecret(row.override);
    }
  }

  // 2. Environment secret.
  const envKey = env[ENV_KEY_FIELD[providerId]];
  if (envKey && envKey.length > 0) return envKey;

  // 3. Not configured.
  throw new TranscriptionDispatchError(
    "no_key_configured",
    `No ${providerId} API key. Set ${ENV_KEY_FIELD[providerId]} via ` +
      `\`wrangler secret put ${ENV_KEY_FIELD[providerId]} --env <dev|production>\`.`
  );
}
