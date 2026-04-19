// Server actions for billing settings.
//
// Actions:
//   * updateAutoTopup — on/off + threshold + amount. Admins only.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { requireOrgAdmin, requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Convert "20" in the form → 20 * 100_000 millicents ($20).
function dollarsToMillicents(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const n = Number(input.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100_000);
}

const toggleSchema = z.object({ enabled: z.enum(["on", "off"]) });

export async function updateAutoTopup(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const org = await getCurrentOrgForUser(user.id);
    if (!org) return { ok: false, error: "No current org." };
    await requireOrgAdmin(org.id);

    const enabled = toggleSchema.safeParse({ enabled: formData.get("enabled") ?? "off" });
    if (!enabled.success) return { ok: false, error: "Bad input." };

    const threshold = dollarsToMillicents(formData.get("thresholdDollars"));
    const amount = dollarsToMillicents(formData.get("amountDollars"));
    if (!threshold || !amount) {
      return { ok: false, error: "Enter threshold and amount in dollars (e.g. 5, 20)." };
    }
    if (amount < 500_000) {
      // $5 minimum — covers Stripe's $0.50 min plus a little headroom.
      return { ok: false, error: "Amount must be at least $5." };
    }

    // Block enabling if there's no saved payment method. Checkout flow
    // captures one on the first manual top-up; until then auto-topup can't
    // charge anything off-session.
    if (enabled.data.enabled === "on") {
      const db = getDb();
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

    const db = getDb();
    await db
      .update(organizations)
      .set({
        autoTopupEnabled: enabled.data.enabled === "on",
        autoTopupThresholdMillicents: threshold,
        autoTopupAmountMillicents: amount,
      })
      .where(eq(organizations.id, org.id));

    revalidatePath("/dashboard/billing");
    return { ok: true };
  } catch (err) {
    console.error("updateAutoTopup failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}
