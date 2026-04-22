// Per-org access gating for transcription.
//
// If an org has set `allowed_models_json`, every /api/transcribe request
// for that org is checked against the list. Anything outside → 403 so the
// Mac surfaces the restriction rather than silently coercing to a default
// (silent coercion is worse UX: user picks Groq, gets Deepgram, sees the
// Deepgram bill, and has to guess why).
//
// NULL/empty list ⇒ no restriction. Every active `provider_pricing` row
// is dispatchable.

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import type { ProviderId } from "./types";

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
