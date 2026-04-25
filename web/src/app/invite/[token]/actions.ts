// Server action for accepting an invitation.
//
// Must only be callable by an authenticated user. The invitation row is
// matched on token; we then verify the signed-in user's email matches the
// invitation's email (case-insensitive), enforce expiry, create the
// org_members row, and DELETE the invitation (and any siblings — same
// email + same org — that were stacked up from re-invites). Idempotent
// on double-click: a missing invitation just redirects to /dashboard.

"use server";

import { and, eq } from "drizzle-orm";
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

  if (!inv) {
    // Already accepted (and deleted) or never existed. Redirecting is the
    // friendliest outcome — the user clicked an old link but ended up
    // signed in, so just put them in the dashboard.
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

  // Delete every pending invitation for this email at this org — covers
  // the case where the same email got invited multiple times before
  // accepting (each invite reuses the existing row, but defensively we
  // clean up any duplicates a future bug or admin tool might have left).
  await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.orgId, inv.orgId),
        eq(invitations.email, inv.email)
      )
    );

  redirect("/dashboard");
}
