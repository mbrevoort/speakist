// Dashboard shell.
//
// Every /dashboard/* page renders inside this layout. Handles:
//   1. Gating on signed-in + provisioned-org state (redirects otherwise).
//   2. Laying out sidebar + topbar + main column.
//   3. Passing context down via a simple prop drill (Phase 3 doesn't have
//      enough depth to justify React context yet).

import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import { getAuth } from "@/lib/auth";

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

  const org = await getCurrentOrgForUser(user.id);
  if (!org) {
    // User has no membership. Two scenarios:
    //   1. Platform has allow_public_org_creation = false (dev/staging's
    //      invite-only mode) and they signed up without an invitation or
    //      matching auto-join domain → show "awaiting invitation".
    //   2. Provisioning failed for some reason (rare) — same screen is an
    //      OK fallback since both paths resolve by "someone invites you".
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center">
          <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-peach/15 text-peach-deep mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            Waiting for an invitation
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            You&apos;re signed in as <span className="font-mono text-foreground">{user.email}</span>,
            but you&apos;re not part of a Speakist organization yet. Ask whoever
            invited you to send a fresh invitation link, or contact
            <a href="mailto:hello@brevoortstudio.com" className="text-peach-deep hover:underline"> hello@brevoortstudio.com</a>.
          </p>
          <form action={async () => {
            "use server";
            const { signOut } = await getAuth();
            await signOut({ redirectTo: "/" });
          }} className="mt-6">
            <button type="submit" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Sign out
            </button>
          </form>
        </div>
      </div>
    );
  }

  const signOutAction = async () => {
    "use server";
    const { signOut } = await getAuth();
    await signOut({ redirectTo: "/" });
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar orgName={org.name} role={org.role} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userEmail={user.email}
          userDisplayName={user.displayName}
          isSuperAdmin={user.isSuperAdmin}
          signOutAction={signOutAction}
          orgName={org.name}
          role={org.role}
        />
        <main className="flex-1 px-6 py-8 sm:px-10 sm:py-10 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
