// Server actions for billing settings.
//
// Actions:
//   * updateAutoTopup — on/off + threshold + amount + optional monthly cap.
//                       Inputs come in as WORDS from the form; we convert
//                       to millicents using pricingConfig.pricePerWordMillicents
//                       so the stored value is rate-independent. Admins only.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { organizations, pricingConfig } from "@/lib/db/schema";
import { requireOrgAdmin, requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Convert a words-numeric form field → integer millicents. Returns null
 *  for missing / invalid / non-positive input. */
function wordsFieldToMc(input: unknown, perWordMc: number): number | null {
  if (typeof input !== "string") return null;
  const n = Number(input.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * perWordMc);
}

const toggleSchema = z.object({
  enabled: z.enum(["on", "off"]),
  capEnabled: z.enum(["on", "off"]),
});

export async function updateAutoTopup(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    await requireOrgAdmin(org.id);

    const parsed = toggleSchema.safeParse({
      enabled: formData.get("enabled") ?? "off",
      capEnabled: formData.get("capEnabled") ?? "off",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();

    // Look up the per-word rate so the words → mc conversion uses the
    // current display rate. This must be stable across the form submit;
    // if a super-admin changes the rate mid-submit the user just sees a
    // slightly different mc figure than they expected — acceptable.
    const [cfg] = await db
      .select({ perWordMc: pricingConfig.pricePerWordMillicents })
      .from(pricingConfig)
      .where(eq(pricingConfig.id, 1))
      .limit(1);
    const perWordMc = cfg?.perWordMc ?? 20;

    const thresholdMc = wordsFieldToMc(formData.get("thresholdWords"), perWordMc);
    const amountMc = wordsFieldToMc(formData.get("amountWords"), perWordMc);
    if (!thresholdMc || !amountMc) {
      return {
        ok: false,
        error: "Enter threshold and amount in words (e.g. 5000, 16500).",
      };
    }
    // Auto-top-up amount must clear the smallest manual tier ($5 = 500K mc)
    // so we never trigger a charge below Stripe's $0.50 minimum and so
    // auto-top-up always buys at least the smallest pack worth of words.
    if (amountMc < 500_000) {
      return {
        ok: false,
        error: "Amount must be at least the smallest top-up pack worth of words.",
      };
    }

    let maxMonthlyMc: number | null = null;
    if (parsed.data.capEnabled === "on") {
      maxMonthlyMc = wordsFieldToMc(formData.get("maxMonthlyWords"), perWordMc);
      if (!maxMonthlyMc) {
        return { ok: false, error: "Enter a positive monthly cap in words." };
      }
      if (maxMonthlyMc < amountMc) {
        return {
          ok: false,
          error: "Monthly cap must be at least one top-up's worth of words.",
        };
      }
    }

    // Block enabling if there's no saved payment method. Checkout flow
    // captures one on the first manual top-up; until then auto-topup can't
    // charge anything off-session.
    if (parsed.data.enabled === "on") {
      const [row] = await db
        .select({ pmId: organizations.stripeDefaultPaymentMethodId })
        .from(organizations)
        .where(eq(organizations.id, org.id))
        .limit(1);
      if (!row?.pmId) {
        return {
          ok: false,
          error:
            "Add a payment method first — do one manual top-up, then turn on auto-top-up.",
        };
      }
    }

    await db
      .update(organizations)
      .set({
        autoTopupEnabled: parsed.data.enabled === "on",
        autoTopupThresholdMillicents: thresholdMc,
        autoTopupAmountMillicents: amountMc,
        autoTopupMaxMonthlyMillicents: maxMonthlyMc,
      })
      .where(eq(organizations.id, org.id));

    revalidatePath("/dashboard/billing");
    return { ok: true };
  } catch (err) {
    console.error("updateAutoTopup failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}
