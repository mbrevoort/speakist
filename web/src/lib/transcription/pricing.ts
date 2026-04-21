// Per-(provider, model) cost computation.
//
// `provider_pricing` is the source of truth; the dispatcher calls
// `getProviderPricing()` before the upstream fetch (to validate model is
// supported) and `computeCost()` after the fetch (to know what to debit).
//
// REAL column types for the rates — providers like Groq turbo price in
// fractions of a cent, and we don't want to round before applying the
// retail markup.

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { providerPricing } from "@/lib/db/schema";
import type { ProviderId } from "./types";

export interface ProviderPricingRow {
  providerId: ProviderId;
  model: string;
  costPerMinuteMillicents: number;
  retailPerMinuteMillicents: number;
  active: boolean;
}

/** Returns null if no row exists for (providerId, model). */
export async function getProviderPricing(
  providerId: ProviderId,
  model: string
): Promise<ProviderPricingRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(providerPricing)
    .where(and(eq(providerPricing.providerId, providerId), eq(providerPricing.model, model)))
    .limit(1);
  if (!row) return null;
  return {
    providerId: row.providerId as ProviderId,
    model: row.model,
    costPerMinuteMillicents: row.costPerMinuteMillicents,
    retailPerMinuteMillicents: row.retailPerMinuteMillicents,
    active: row.active,
  };
}

/**
 * Round both costs up to whole millicents. Rounding up is deliberate —
 * better to over-charge ourselves by <1 mC/transcription than to silently
 * float arbitrarily-precise values through the ledger, which is declared
 * INTEGER.
 */
export function computeCost(
  pricing: ProviderPricingRow,
  audioSeconds: number
): { upstreamMc: number; retailMc: number } {
  const minutes = audioSeconds / 60;
  return {
    upstreamMc: Math.ceil(pricing.costPerMinuteMillicents * minutes),
    retailMc: Math.ceil(pricing.retailPerMinuteMillicents * minutes),
  };
}
