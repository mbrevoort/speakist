// Per-org transcription routing.
//
// Two responsibilities, both reading `organizations.allowed_models_json`:
//
//   1. `resolveProviderForOrg()` — figure out which (provider, model) to
//      dispatch a request to, given the user's chosen language. Default
//      routing is Groq-first: English → whisper-large-v3-turbo (fastest),
//      anything else → whisper-large-v3 (multilingual). When an org has
//      an allow-list, we either use the language-default (if it's in the
//      list) or fall back to the first allowed entry. This is how a super
//      admin pins an org to a specific (provider, model) pair: set the
//      allow-list to a single entry.
//
//   2. `checkOrgModelAccess()` — legacy gate for the old client-picked
//      model path. Kept so any caller still passing a model can be
//      checked, but `/api/transcribe` no longer drives via this.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { isProviderId, type ProviderId } from "./types";

/** "groq/whisper-large-v3-turbo" → ("groq", "whisper-large-v3-turbo") */
function parseSlug(slug: string): { providerId: ProviderId; model: string } | null {
  const idx = slug.indexOf("/");
  if (idx <= 0) return null;
  const providerId = slug.slice(0, idx).toLowerCase();
  const model = slug.slice(idx + 1);
  if (!isProviderId(providerId) || model.length === 0) return null;
  return { providerId, model };
}

/**
 * Default (provider, model) for a request, before the allow-list is
 * applied. English-detected requests route to the fastest Whisper
 * variant; everything else goes to the multilingual Whisper Large.
 *
 * `detectLanguage = true` (the auto-detect toggle) is treated as
 * not-English so we use the multilingual model — picking Turbo would
 * give worse accuracy on French/Spanish/etc. clips that auto-detect
 * is meant to handle.
 */
export function languageDefault(opts: {
  language?: string | null;
  detectLanguage?: boolean;
}): { providerId: ProviderId; model: string } {
  const isEnglish =
    !opts.detectLanguage &&
    typeof opts.language === "string" &&
    /^en(-|$)/i.test(opts.language.trim());
  return isEnglish
    ? { providerId: "groq", model: "whisper-large-v3-turbo" }
    : { providerId: "groq", model: "whisper-large-v3" };
}

export interface ResolvedProvider {
  providerId: ProviderId;
  model: string;
  /** Why we picked this — useful for logs and tests. */
  source: "language_default" | "allow_list_default" | "allow_list_fallback";
}

/**
 * Resolve which (provider, model) to dispatch this request to.
 *
 *   * No org allow-list, or empty/malformed → language default.
 *   * Allow-list contains the language default → use it.
 *   * Allow-list does not contain the language default → use the first
 *     entry in the allow-list (super admin's preferred override). Skips
 *     malformed entries; if every entry is malformed, falls back to
 *     language default.
 */
export async function resolveProviderForOrg(
  orgId: string,
  opts: { language?: string | null; detectLanguage?: boolean }
): Promise<ResolvedProvider> {
  const def = languageDefault(opts);

  const db = getDb();
  const [row] = await db
    .select({ list: organizations.allowedModelsJson })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const raw = row?.list;
  if (!raw) return { ...def, source: "language_default" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[orgAccess] malformed allowed_models_json for org ${orgId}:`, err);
    return { ...def, source: "language_default" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ...def, source: "language_default" };
  }

  const slugs = parsed.filter((s): s is string => typeof s === "string");
  const defaultSlug = `${def.providerId}/${def.model}`;
  if (slugs.includes(defaultSlug)) {
    return { ...def, source: "allow_list_default" };
  }

  for (const slug of slugs) {
    const parsedSlug = parseSlug(slug);
    if (parsedSlug) {
      return { ...parsedSlug, source: "allow_list_fallback" };
    }
  }
  // Allow-list contained only malformed entries — log + fall back to
  // language default rather than 500.
  console.warn(`[orgAccess] no parseable slugs in allowed_models_json for org ${orgId}; using language default`);
  return { ...def, source: "language_default" };
}

export interface OrgAccessCheck {
  allowed: boolean;
  /** Human-readable reason when `allowed = false`. */
  reason?: string;
  /** The parsed allow-list, for surfacing "here's what you can use" hints. */
  allowedSlugs?: string[];
}

/**
 * Check whether a (provider, model) is in an org's allow-list. Reads the
 * `allowed_models_json` column; returns `allowed: true` when the column
 * is NULL or an empty array (no restriction). Malformed JSON is treated
 * as "no restriction" with a console warn so we don't break transcription
 * on bad admin input.
 */
export async function checkOrgModelAccess(
  orgId: string,
  providerId: ProviderId,
  model: string
): Promise<OrgAccessCheck> {
  const db = getDb();
  const [row] = await db
    .select({ list: organizations.allowedModelsJson })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const raw = row?.list;
  if (!raw) return { allowed: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[orgAccess] malformed allowed_models_json for org ${orgId}:`, err);
    return { allowed: true };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { allowed: true };

  const allowedSlugs = parsed.filter((s): s is string => typeof s === "string");
  const wanted = `${providerId}/${model}`;
  if (allowedSlugs.includes(wanted)) {
    return { allowed: true, allowedSlugs };
  }
  return {
    allowed: false,
    reason: `Your organization has restricted transcription to: ${allowedSlugs.join(", ")}. Pick one of those in Mac Settings → Transcription.`,
    allowedSlugs,
  };
}
