// Members page. Server component — fetches members + pending invitations,
// passes to the client component for the interactive bits (invite form,
// role changer, revoke/remove buttons).

import { PageHeader } from "@/components/dashboard/page-header";
import { requireOrgMember } from "@/lib/authz";
import {
  getCurrentOrgForUser,
  listOrgMembers,
  listPendingInvitations,
} from "@/lib/orgs";
import { MembersClient } from "./members-client";

export const metadata = { title: "Members — Speakist" };

export default async function MembersPage() {
  // Layout already gated on signed-in + has-org. Still requireOrgMember so
  // the role comes through cleanly and so this page is self-contained if
  // someone ever lifts the layout gate.
  const { user } = await requireOrgMemberForCurrentOrg();
  const org = (await getCurrentOrgForUser(user.id))!;

  const [members, pending] = await Promise.all([
    listOrgMembers(org.id),
    listPendingInvitations(org.id),
  ]);

  const { role } = await requireOrgMember(org.id);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Members"
        description="Invite teammates, manage roles, and see who's pending."
      />
      <MembersClient
        orgId={org.id}
        currentUserId={user.id}
        currentUserRole={role}
        members={members}
        pending={pending}
      />
    </div>
  );
}

async function requireOrgMemberForCurrentOrg() {
  const { requireUser } = await import("@/lib/authz");
  const user = await requireUser();
  const org = await getCurrentOrgForUser(user.id);
  if (!org) throw new Error("No current org");
  return requireOrgMember(org.id);
}
