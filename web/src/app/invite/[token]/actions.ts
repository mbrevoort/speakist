// Server action for accepting an invitation.
//
// Must only be callable by an authenticated user. The invitation row is
// matched on token; we then verify the signed-in user's email matches the
// invitation's email (case-insensitive) and that the invite hasn't expired.
//
// One-org-per-user invariant: if the signed-in user is already in an org,
// accepting this invite first removes them from that org. Two cases:
//
//   * The user has co-owners or isn't an owner → just delete their
//     `org_members` row. The org persists.
//   * The user is the SOLE owner → the workspace has to be deleted
//     (no ownerless workspaces). We require the form to echo the
//     workspace's slug in `confirm_current_org_slug` to make sure they
//     understand; mismatch ⇒ rejected with the same error
//     settings/leaveOrg uses.
//
// All accept paths clean up sibling pending invitations for this email +
// new org. Token-not-found is idempotent (just redirects to /dashboard).

"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { invitations, orgMembers, organizations } from "@/lib/db/schema";
import { requireUser } from "@/lib/authz";

export type AcceptResult =
  | { ok: true }
  | { ok: false; error: string; needsSlugConfirmation?: { slug: string } };

export async function acceptInvitation(formData: FormData): Promise<void> {
  const result = await acceptInvitationInternal(formData);
  if (!result.ok) {
    // Throw so the form's surrounding error UI surfaces it. Page-level
    // form actions in Next.js render error.tsx; for the invite page we
    // bounce to a query-string error which the page reads. Cheap + good
    // enough for this surface.
    throw new Error(result.error);
  }
  redirect("/dashboard");
}

/**
 * Same logic as `acceptInvitation` but returns a structured result instead
 * of throwing/redirecting. Used by tests + by future UI that wants to show
 * the sole-owner-confirmation prompt inline rather than via a thrown error.
 */
export async function acceptInvitationInternal(
  formData: FormData
): Promise<AcceptResult> {
  const token = (formData.get("token") as string | null)?.trim();
  if (!token) return { ok: false, error: "Missing token" };

  const user = await requireUser();
  const db = getDb();

  const [inv] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);

  if (!inv) {
    // Already accepted (and deleted) or never existed. Treat as success;
    // the wrapper redirects to /dashboard.
    return { ok: true };
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "Invitation expired" };
  }
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, error: "Signed in as a different email" };
  }

  // Already a member of THIS org? (E.g. they accepted in another tab.)
  const [alreadyMember] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, inv.orgId), eq(orgMembers.userId, user.id)))
    .limit(1);
  if (alreadyMember) {
    // Idempotent — clean up duplicate invitations and call it done.
    await db
      .delete(invitations)
      .where(
        and(eq(invitations.orgId, inv.orgId), eq(invitations.email, inv.email))
      );
    return { ok: true };
  }

  // Existing membership in a DIFFERENT org? Resolve the leave/delete first.
  const [currentMembership] = await db
    .select({
      orgId: orgMembers.orgId,
      role: orgMembers.role,
      orgSlug: organizations.slug,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, user.id))
    .limit(1);

  if (currentMembership) {
    if (currentMembership.role === "owner") {
      const owners = await db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, currentMembership.orgId),
            eq(orgMembers.role, "owner")
          )
        );
      if (owners.length <= 1) {
        // Sole owner: deleting the org is the only way out. Require
        // them to type the slug, same UX as the settings deleteOrg
        // flow, so they don't blow away an org by accident.
        const confirmSlug = (
          formData.get("confirm_current_org_slug") as string | null
        )
          ?.trim()
          .toLowerCase();
        if (confirmSlug !== currentMembership.orgSlug.toLowerCase()) {
          return {
            ok: false,
            error: `You're the sole owner of ${currentMembership.orgSlug}. Type its slug to confirm deletion before joining the new org.`,
            needsSlugConfirmation: { slug: currentMembership.orgSlug },
          };
        }
        // Cascade clears their membership + everything else org-scoped.
        await db
          .delete(organizations)
          .where(eq(organizations.id, currentMembership.orgId));
      } else {
        // Co-owners: just leave.
        await db
          .delete(orgMembers)
          .where(
            and(
              eq(orgMembers.orgId, currentMembership.orgId),
              eq(orgMembers.userId, user.id)
            )
          );
      }
    } else {
      // Admin/member: leave the org.
      await db
        .delete(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, currentMembership.orgId),
            eq(orgMembers.userId, user.id)
          )
        );
    }
  }

  await db.insert(orgMembers).values({
    orgId: inv.orgId,
    userId: user.id,
    role: inv.role,
  });

  // Clean up every pending invitation for this email at the new org —
  // covers re-invite duplicates and the auto-join domain placeholder.
  await db
    .delete(invitations)
    .where(
      and(eq(invitations.orgId, inv.orgId), eq(invitations.email, inv.email))
    );

  return { ok: true };
}
