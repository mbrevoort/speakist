// Server actions for the no-org dashboard panel.
//
// Two thin wrappers + one delete:
//   * createOwnWorkspaceFromNoOrg — calls the lib helper that creates an
//     org for an existing user and grants the signup bonus only on the
//     user's first lifetime org.
//   * declineInvitationFromNoOrg — deletes a pending invitation by id.
//     Email-locked: an invitation can only be declined by the user it was
//     addressed to.
//
// Accepting from this panel reuses the existing /invite/[token] action;
// no separate "accept-from-dashboard" path needed.

"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { invitations } from "@/lib/db/schema";
import { requireUser } from "@/lib/authz";
import { createOwnWorkspaceForExistingUser } from "@/lib/orgs";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

export async function createOwnWorkspaceFromNoOrg(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const r = await createOwnWorkspaceForExistingUser(user.id);
    if (!r.ok) {
      if (r.error === "already_in_org") {
        return {
          ok: false,
          error: "You already belong to a workspace. Refresh the page.",
        };
      }
      return { ok: false, error: "Couldn't create the workspace." };
    }
    revalidatePath("/dashboard", "layout");
    return { ok: true, message: "Workspace created." };
  } catch (err) {
    console.error("createOwnWorkspaceFromNoOrg failed:", err);
    return { ok: false, error: "Couldn't create the workspace." };
  }
}

const declineSchema = z.object({ invitation_id: z.string().min(1) });

export async function declineInvitationFromNoOrg(
  formData: FormData
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = declineSchema.safeParse({
      invitation_id: formData.get("invitation_id"),
    });
    if (!parsed.success) return { ok: false, error: "Bad input." };

    const db = getDb();
    const [inv] = await db
      .select({ id: invitations.id, email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, parsed.data.invitation_id),
          isNull(invitations.acceptedAt)
        )
      )
      .limit(1);
    if (!inv) {
      // Already accepted or removed — treat as a success so the UI just
      // refreshes and the card disappears.
      revalidatePath("/dashboard", "layout");
      return { ok: true };
    }
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      return {
        ok: false,
        error: "That invitation isn't addressed to you.",
      };
    }

    await db.delete(invitations).where(eq(invitations.id, inv.id));
    revalidatePath("/dashboard", "layout");
    return { ok: true, message: "Invitation declined." };
  } catch (err) {
    console.error("declineInvitationFromNoOrg failed:", err);
    return { ok: false, error: "Couldn't decline." };
  }
}
