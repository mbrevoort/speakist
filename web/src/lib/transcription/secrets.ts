// Per-(org, provider) API key resolution.
//
// Lookup order (in this order — first hit wins):
//   1. Org-specific override (encrypted in `organizations.<provider>_key_override_encrypted`).
//      Per-org override always trumps system defaults; lets a customer
//      bring their own provider account so usage hits their billing,
//      not ours.
//   2. System-wide key (encrypted in `app_settings.system_<provider>_key_encrypted`).
//      Configured by super admin at /admin/system. This is what most
//      orgs use — Groq is the default provider for new orgs, so the
//      system Groq key is load-bearing.
//   3. Env secret, read from the Cloudflare context env FIRST (deployed
//      Worker secrets land there), then process.env (`pnpm dev` reads
//      `.env.local` into process.env only). Mostly a local-dev fallback
//      so contributors don't need to run a system-key migration before
//      their first `pnpm dev`.
//   4. Throw — provider isn't configured at any level.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings, organizations } from "@/lib/db/schema";
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
  // 1. Org override + 2. system key — single round-trip joining
  //    organizations and app_settings. We need both for both providers
  //    (deepgram + groq), so one query is cheaper than two conditionals.
  if (providerId === "deepgram" || providerId === "groq") {
    const db = getDb();

    const [orgRow] = await db
      .select({
        deepgram: organizations.deepgramKeyOverrideEncrypted,
        groq: organizations.groqKeyOverrideEncrypted,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const orgOverride =
      providerId === "deepgram" ? orgRow?.deepgram : orgRow?.groq;
    if (orgOverride) {
      return decryptSecret(orgOverride);
    }

    const [systemRow] = await db
      .select({
        deepgram: appSettings.systemDeepgramKeyEncrypted,
        groq: appSettings.systemGroqKeyEncrypted,
      })
      .from(appSettings)
      .where(eq(appSettings.id, 1))
      .limit(1);

    const systemKey =
      providerId === "deepgram" ? systemRow?.deepgram : systemRow?.groq;
    if (systemKey) {
      return decryptSecret(systemKey);
    }
  }

  // 3. Environment secret. Local-dev fallback for contributors who
  //    haven't run the migration to populate the system key yet.
  const fieldName = ENV_KEY_FIELD[providerId];
  const envKey = env[fieldName] ?? process.env[fieldName];
  if (envKey && envKey.length > 0) return envKey;

  // 4. Not configured.
  throw new TranscriptionDispatchError(
    "no_key_configured",
    `No ${providerId} API key. Set the system key at /admin/system, ` +
      `or for local dev add ${fieldName}=... to web/.env.local.`
  );
}
