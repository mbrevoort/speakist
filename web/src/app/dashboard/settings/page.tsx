// Org settings. Phase 3 surface: name, auto-join domain, leave/delete.
// Phase 5 adds the Deepgram key override panel for super-admin-flagged
// orgs (on a separate super-admin route, not here).

import { and, eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { getDb } from "@/lib/db";
import { orgMembers } from "@/lib/db/schema";
import { SettingsClient } from "./settings-client";

export const metadata = { title: "Settings — Speakist" };

export default async function SettingsPage() {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!;

  const canAdmin = org.role === "owner" || org.role === "admin";

  // Am I the sole owner? If so, leave/delete flow changes.
  const db = getDb();
  const owners = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, "owner")));
  const isSoleOwner = org.role === "owner" && owners.length === 1;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Manage your organization's details and membership."
      />
      <SettingsClient
        orgName={org.name}
        orgSlug={org.slug}
        autoJoinDomain={org.autoJoinDomain}
        canAdmin={canAdmin}
        isSoleOwner={isSoleOwner}
        role={org.role}
      />
    </div>
  );
}
