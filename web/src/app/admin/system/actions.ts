// Admin → system settings action. One thing: set or clear the encrypted
// system-wide Deepgram key. This is the fallback key used by any org that
// doesn't have its own override.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { requireSuperAdmin } from "@/lib/authz";
import { encryptSecret } from "@/lib/crypto";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

// --- Deepgram system key --------------------------------------------------

const schema = z.object({ key: z.string().trim() });

export async function setSystemDeepgramKey(formData: FormData): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = schema.safeParse({ key: formData.get("key") || "" });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();

    if (parsed.data.key === "") {
      await db
        .update(appSettings)
        .set({ systemDeepgramKeyEncrypted: null })
        .where(eq(appSettings.id, 1));
      revalidatePath("/admin/system");
      return { ok: true, message: "System key cleared." };
    }

    if (!/^[A-Za-z0-9_-]{20,}$/.test(parsed.data.key)) {
      return { ok: false, error: "That doesn't look like a Deepgram key." };
    }

    const encrypted = await encryptSecret(parsed.data.key);
    await db
      .update(appSettings)
      .set({ systemDeepgramKeyEncrypted: encrypted })
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return { ok: true, message: "System key saved." };
  } catch (err) {
    console.error("setSystemDeepgramKey failed:", err);
    if (String(err).includes("APP_ENCRYPTION_KEY")) {
      return {
        ok: false,
        error: "APP_ENCRYPTION_KEY not configured. Set it in .env.local first.",
      };
    }
    return { ok: false, error: "Couldn't save." };
  }
}

// --- allow_public_org_creation toggle -------------------------------------

const toggleSchema = z.object({ enabled: z.enum(["on", "off"]) });

export async function setAllowPublicOrgCreation(
  formData: FormData
): Promise<ActionResult> {
  try {
    await requireSuperAdmin();
    const parsed = toggleSchema.safeParse({ enabled: formData.get("enabled") ?? "off" });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    await db
      .update(appSettings)
      .set({ allowPublicOrgCreation: parsed.data.enabled === "on" })
      .where(eq(appSettings.id, 1));

    revalidatePath("/admin/system");
    return {
      ok: true,
      message:
        parsed.data.enabled === "on"
          ? "Public signup re-enabled — new users get a workspace auto-created."
          : "Public signup disabled — new users without an invitation land on the waiting screen.",
    };
  } catch (err) {
    console.error("setAllowPublicOrgCreation failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}
