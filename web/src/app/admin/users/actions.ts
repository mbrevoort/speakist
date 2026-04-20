// Admin user actions. Only one for now: toggle the is_super_admin flag.

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireSuperAdmin } from "@/lib/authz";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const schema = z.object({
  userId: z.string().uuid(),
  enabled: z.enum(["on", "off"]),
});

export async function toggleSuperAdmin(formData: FormData): Promise<ActionResult> {
  try {
    const caller = await requireSuperAdmin();
    const parsed = schema.safeParse({
      userId: formData.get("userId"),
      enabled: formData.get("enabled"),
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    // Prevent accidental self-demotion — the UI hides the button for self,
    // but the action also enforces it so a crafted request can't accidentally
    // lock us out.
    if (parsed.data.userId === caller.id && parsed.data.enabled === "off") {
      return { ok: false, error: "You can't remove your own super-admin access." };
    }

    const db = getDb();
    await db
      .update(users)
      .set({ isSuperAdmin: parsed.data.enabled === "on" })
      .where(eq(users.id, parsed.data.userId));

    revalidatePath("/admin/users");
    return {
      ok: true,
      message: parsed.data.enabled === "on" ? "Promoted." : "Demoted.",
    };
  } catch (err) {
    console.error("toggleSuperAdmin failed:", err);
    return { ok: false, error: "Couldn't save." };
  }
}
