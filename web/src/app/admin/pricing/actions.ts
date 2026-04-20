// Pricing config editor action. The singleton row (id=1) is updated in
// place — it's the same row the landing page's Pricing component reads.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { pricingConfig } from "@/lib/db/schema";
import { requireSuperAdmin } from "@/lib/authz";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

// Accept dollars on the form side, convert to millicents for storage.
// The one float is price_per_word_millicents which can be fractional.
const schema = z.object({
  pricePerWordMillicents: z.coerce.number().min(0).max(1000),
  deepgramPerMinuteMillicents: z.coerce.number().min(0).max(100_000),
  signupBonusDollars: z.coerce.number().min(0).max(1000),
  defaultAutoTopupAmountDollars: z.coerce.number().min(5).max(1000),
  defaultAutoTopupThresholdDollars: z.coerce.number().min(0).max(1000),
});

export async function updatePricing(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = schema.safeParse({
      pricePerWordMillicents: formData.get("pricePerWordMillicents"),
      deepgramPerMinuteMillicents: formData.get("deepgramPerMinuteMillicents"),
      signupBonusDollars: formData.get("signupBonusDollars"),
      defaultAutoTopupAmountDollars: formData.get("defaultAutoTopupAmountDollars"),
      defaultAutoTopupThresholdDollars: formData.get("defaultAutoTopupThresholdDollars"),
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: "One or more fields are out of range. See inline hints.",
      };
    }

    const db = getDb();
    await db
      .update(pricingConfig)
      .set({
        pricePerWordMillicents: parsed.data.pricePerWordMillicents,
        deepgramPerMinuteMillicents: parsed.data.deepgramPerMinuteMillicents,
        signupBonusMillicents: Math.round(parsed.data.signupBonusDollars * 100_000),
        defaultAutoTopupAmountMillicents: Math.round(
          parsed.data.defaultAutoTopupAmountDollars * 100_000
        ),
        defaultAutoTopupThresholdMillicents: Math.round(
          parsed.data.defaultAutoTopupThresholdDollars * 100_000
        ),
      })
      .where(eq(pricingConfig.id, 1));

    revalidatePath("/admin/pricing");
    revalidatePath("/"); // landing page reads this
    return { ok: true, message: "Saved." };
  } catch (err) {
    console.error("updatePricing failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}
