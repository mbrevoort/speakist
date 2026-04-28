// Combined account + org settings, grouped into:
//   * Personal     — polish prefs + the user's dictionary (vocabulary)
//   * Organization — name, auto-join domain, leave/delete (admin gating)
//
// The vocabulary editor mirrors the Mac app's Settings → Dictionary tab
// so users can manage the same per-user list of corrections from either
// surface. Source of truth is the `vocabulary_entries` table, the same
// rows the Mac syncs to via /api/vocabulary.

import { and, desc, eq, isNull } from "drizzle-orm";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { getDb } from "@/lib/db";
import { orgMembers, users, vocabularyEntries } from "@/lib/db/schema";
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

  // Live (non-tombstoned) dictionary entries for this user, newest-used
  // first. Same row scope the Mac app fetches via GET /api/vocabulary.
  const vocabRows = await db
    .select({
      id: vocabularyEntries.id,
      fromText: vocabularyEntries.fromText,
      toText: vocabularyEntries.toText,
      count: vocabularyEntries.count,
      isProperNoun: vocabularyEntries.isProperNoun,
    })
    .from(vocabularyEntries)
    .where(
      and(
        eq(vocabularyEntries.userId, user.id),
        isNull(vocabularyEntries.deletedAt)
      )
    )
    .orderBy(desc(vocabularyEntries.lastSeen));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Your personal preferences and your organization."
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
        vocabEntries={vocabRows}
      />
    </div>
  );
}
