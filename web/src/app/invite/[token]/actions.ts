// Server action for accepting an invitation.
//
// Must only be callable by an authenticated user. The invitation row is
// matched on token; we then verify the signed-in user's email matches the
// invitation's email (case-insensitive), enforce expiry, and create the
// org_members row + mark the invitation accepted. Idempotent on double-
// click: already-accepted invitations just redirect to /dashboard.

"use server";

import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { invitations, orgMembers } from "@/lib/db/schema";
import { requireUser } from "@/lib/authz";

export async function acceptInvitation(formData: FormData): Promise<void> {
  const token = (formData.get("token") as string | null)?.trim();
  if (!token) throw new Error("Missing token");

  const user = await requireUser();
  const db = getDb();

  const [inv] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);

  if (!inv) throw new Error("Invitation not found");
  if (inv.acceptedAt) {
    // Already accepted previously — send the user to the dashboard so they
    // end up in the same place as a successful accept.
    redirect("/dashboard");
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    throw new Error("Invitation expired");
  }
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error("Signed in as a different email");
  }

  // Already a member? (E.g. they accepted this invitation in another tab.)
  const existing = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, inv.orgId), eq(orgMembers.userId, user.id)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(orgMembers).values({
      orgId: inv.orgId,
      userId: user.id,
      role: inv.role,
    });
  }

  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt)));

  redirect("/dashboard");
}
