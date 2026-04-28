// Dashboard shell.
//
// Every /dashboard/* page renders inside this layout. Handles:
//   1. Gating on signed-in + provisioned-org state (redirects otherwise).
//   2. Laying out sidebar + topbar + main column.
//   3. Surfacing the no-org panel (pending invites + create-workspace
//      CTA) when the user has just left/declined and isn't yet in an org.

import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { requireUser } from "@/lib/authz";
import {
  getCurrentOrgForUser,
  listPendingInvitationsForEmail,
} from "@/lib/orgs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";
import { NoOrgPanel } from "./no-org-panel";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // requireUser throws 401 (AuthzError) if not signed in. Middleware already
  // redirects unauthenticated requests on /dashboard/*, so in practice we
  // only hit the catch path for server-action calls or edge cases where the
  // session just expired. Catching here keeps the UX a redirect, not a 401
  // error page.
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect("/auth/signin?callbackUrl=/dashboard");
  }

  const signOutAction = async () => {
    "use server";
    const { signOut } = await getAuth();
    await signOut({ redirectTo: "/" });
  };

  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    // No-org landing. Surface every pending invitation addressed to this
    // user's email plus a "create your own workspace" CTA gated on the
    // platform's allow_public_org_creation flag.
    const [invites, settingsRow] = await Promise.all([
      listPendingInvitationsForEmail(user.email),
      readAllowPublicOrgCreation(),
    ]);
    return (
      <NoOrgPanel
        userEmail={user.email}
        invitations={invites}
        allowCreate={settingsRow}
        signOutAction={signOutAction}
      />
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar orgName={org.name} role={org.role} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userEmail={user.email}
          userDisplayName={user.displayName}
          isSuperAdmin={user.isSuperAdmin}
          signOutAction={signOutAction}
          mobileNav={<MobileNav orgName={org.name} role={org.role} />}
        />
        <main className="flex-1 px-6 py-8 sm:px-10 sm:py-10 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

async function readAllowPublicOrgCreation(): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ allow: appSettings.allowPublicOrgCreation })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  return row?.allow ?? true;
}
