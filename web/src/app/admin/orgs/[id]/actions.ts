// Admin actions for a single org. All gated by requireSuperAdmin — a normal
// org admin does NOT have access to these (comp toggle, manual credit
// adjustment, Deepgram key override).

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { creditLedger, organizations } from "@/lib/db/schema";
import { requireSuperAdmin } from "@/lib/authz";
import { encryptSecret } from "@/lib/crypto";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

// --- comp toggle ----------------------------------------------------------

const compSchema = z.object({
  orgId: z.string().uuid(),
  enabled: z.enum(["on", "off"]),
});

export async function toggleComp(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = compSchema.safeParse({
      orgId: formData.get("orgId"),
      enabled: formData.get("enabled"),
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    await db
      .update(organizations)
      .set({ isComped: parsed.data.enabled === "on" })
      .where(eq(organizations.id, parsed.data.orgId));

    revalidatePath(`/admin/orgs/${parsed.data.orgId}`);
    revalidatePath("/admin/orgs");
    return {
      ok: true,
      message: parsed.data.enabled === "on" ? "Org comped." : "Comp removed.",
    };
  } catch (err) {
    console.error("toggleComp failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}

// --- manual credit adjustment ---------------------------------------------

const adjustSchema = z.object({
  orgId: z.string().uuid(),
  amountDollars: z.string(),
  note: z.string().trim().max(200).optional(),
});

export async function adjustCredit(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireSuperAdmin();
    const parsed = adjustSchema.safeParse({
      orgId: formData.get("orgId"),
      amountDollars: formData.get("amountDollars"),
      note: formData.get("note") || undefined,
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    // Allow negative — this is the "I just refunded a customer" path too.
    const dollars = Number(parsed.data.amountDollars.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(dollars) || dollars === 0) {
      return { ok: false, error: "Enter a non-zero dollar amount." };
    }
    const deltaMillicents = Math.round(dollars * 100_000);

    const db = getDb();
    await db.insert(creditLedger).values({
      orgId: parsed.data.orgId,
      deltaMillicents,
      reason: "adjustment",
      createdBy: user.id,
      note: parsed.data.note ?? `Manual adjustment by ${user.email}`,
    });

    revalidatePath(`/admin/orgs/${parsed.data.orgId}`);
    return { ok: true, message: `Adjusted ${dollars > 0 ? "+" : ""}$${dollars.toFixed(2)}.` };
  } catch (err) {
    console.error("adjustCredit failed:", err);
    return { ok: false, error: "Couldn't adjust." };
  }
}

// --- Deepgram override ----------------------------------------------------

const setKeySchema = z.object({
  orgId: z.string().uuid(),
  key: z.string().trim(),
});

export async function setDeepgramOverride(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = setKeySchema.safeParse({
      orgId: formData.get("orgId"),
      key: formData.get("key") || "",
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    if (parsed.data.key === "") {
      // Clear the override.
      await db
        .update(organizations)
        .set({ deepgramKeyOverrideEncrypted: null })
        .where(eq(organizations.id, parsed.data.orgId));
      revalidatePath(`/admin/orgs/${parsed.data.orgId}`);
      return { ok: true, message: "Override cleared." };
    }

    // Basic Deepgram key shape check — they're ~40-char hex-ish strings.
    if (!/^[A-Za-z0-9_-]{20,}$/.test(parsed.data.key)) {
      return { ok: false, error: "That doesn't look like a Deepgram key." };
    }

    const encrypted = await encryptSecret(parsed.data.key);
    await db
      .update(organizations)
      .set({ deepgramKeyOverrideEncrypted: encrypted })
      .where(eq(organizations.id, parsed.data.orgId));

    revalidatePath(`/admin/orgs/${parsed.data.orgId}`);
    return { ok: true, message: "Override saved." };
  } catch (err) {
    console.error("setDeepgramOverride failed:", err);
    if (String(err).includes("APP_ENCRYPTION_KEY")) {
      return {
        ok: false,
        error: "APP_ENCRYPTION_KEY not configured. Set it in .env.local first.",
      };
    }
    return { ok: false, error: "Couldn't save." };
  }
}
