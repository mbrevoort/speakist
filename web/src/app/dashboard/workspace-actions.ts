// Workspace switcher action — separated from settings/actions.ts so the
// dashboard layout (which renders the topbar switcher on every page) can
// import it without pulling the rest of the settings stack into the
// global tree.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/authz";
import { setActiveOrgForUser } from "@/lib/orgs";

export type SwitchResult =
  | { ok: true; orgId: string }
  | { ok: false; error: string };

const schema = z.object({ org_id: z.string().min(1) });

export async function switchActiveWorkspace(
  formData: FormData
): Promise<SwitchResult> {
  try {
    const user = await requireUser();
    const parsed = schema.safeParse({ org_id: formData.get("org_id") });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const r = await setActiveOrgForUser(user.id, parsed.data.org_id);
    if (!r.ok) {
      return {
        ok: false,
        error: "That workspace isn't one of yours.",
      };
    }

    // Revalidate every dashboard route — they all depend on
    // getCurrentOrgForUser, which now resolves to the new org.
    revalidatePath("/dashboard", "layout");
    return { ok: true, orgId: parsed.data.org_id };
  } catch (err) {
    console.error("switchActiveWorkspace failed:", err);
    return { ok: false, error: "Couldn't switch workspaces." };
  }
}
