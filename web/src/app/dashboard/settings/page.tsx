// Combined account + org settings.
//   * Polish prompt + enabled toggle  — per-user
//   * Org name, auto-join domain      — admin+
//   * Leave / delete org              — situational

import { and, eq } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { getDb } from "@/lib/db";
import { orgMembers, users } from "@/lib/db/schema";
import type { PolishMode } from "@/lib/transcription/polish";
import { SettingsClient } from "./settings-client";

export const metadata = { title: "Settings — Speakist" };

export default async function SettingsPage() {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!;

  const canAdmin = org.role === "owner" || org.role === "admin";

  const db = getDb();

  // Am I the sole owner? If so, leave/delete flow changes.
  const owners = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, "owner")));
  const isSoleOwner = org.role === "owner" && owners.length === 1;

  // Polish prefs are per-user, not per-org. Pulled here so the client
  // form can hydrate without an API round-trip on render.
  const [polishRow] = await db
    .select({
      enabled: users.polishEnabled,
      mode: users.polishMode,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const polishMode: PolishMode = (polishRow?.mode as PolishMode) ?? "prescriptive";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Your account and your organization."
      />
      <SettingsClient
        orgName={org.name}
        orgSlug={org.slug}
        autoJoinDomain={org.autoJoinDomain}
        canAdmin={canAdmin}
        isSoleOwner={isSoleOwner}
        role={org.role}
        polishEnabled={!!polishRow?.enabled}
        polishMode={polishMode}
      />
    </div>
  );
}
