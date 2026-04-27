// Top-up SKU ladder.
//
// Each tier defines what the user pays Stripe (`dollarAmount`) and what we
// credit to the ledger (`creditMillicents`). For tiers above $5 the credit
// is GREATER than the charged amount — that's the volume-discount bonus.
//
// Why store both numbers explicitly rather than computing the bonus at
// runtime: ledger writes happen in the Stripe webhook, far from the SKU
// definition. Putting the canonical credit amount here means a tier change
// is one file edit and a webhook replay if needed — no math drift across
// the codebase.
//
// IMPORTANT: tier ids are persisted in Stripe metadata so the webhook can
// look up the credit amount. Renaming an id breaks in-flight checkouts.
// Add new ids; never repurpose old ones.

export interface TopupTier {
  id: string;
  /** What Stripe charges the user, in whole dollars. */
  dollarAmount: number;
  /** What we add to the ledger on success, in millicents. For tiers >$5
   *  this exceeds dollarAmount * 100_000 — the difference is the bonus. */
  creditMillicents: number;
  /** Display-only "save X%" badge. Derived from creditMillicents but
   *  stored as a clean integer to avoid rounding-noise in the UI. */
  bonusPct: number;
}

/** Read order = display order in the UI grid. */
export const TOPUP_TIERS: readonly TopupTier[] = [
  { id: "t5",   dollarAmount: 5,   creditMillicents:    500_000, bonusPct: 0  },
  { id: "t10",  dollarAmount: 10,  creditMillicents:  1_050_000, bonusPct: 5  },
  { id: "t25",  dollarAmount: 25,  creditMillicents:  3_000_000, bonusPct: 20 },
  { id: "t50",  dollarAmount: 50,  creditMillicents:  6_500_000, bonusPct: 30 },
  { id: "t100", dollarAmount: 100, creditMillicents: 15_000_000, bonusPct: 50 },
] as const;

const TIERS_BY_ID = new Map(TOPUP_TIERS.map((t) => [t.id, t]));

/** Look up a tier by id; returns null if unknown. Used by the webhook. */
export function getTopupTier(id: string): TopupTier | null {
  return TIERS_BY_ID.get(id) ?? null;
}
