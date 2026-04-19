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
    // Either provisioning is still in flight (unlikely — the createUser hook
    // is synchronous before the session is minted) or it failed. Ask the
    // user to sign out and back in so the hook runs again.
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-border bg-background p-8 text-center">
          <h1 className="text-xl font-semibold">We couldn&apos;t set up your workspace</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            This is rare. Sign out and back in to retry; if it still doesn&apos;t
            work, email us at hello@speakist.brevoort.com.
          </p>
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
      <Sidebar orgName={org.name} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userEmail={user.email}
          userDisplayName={user.displayName}
          isSuperAdmin={user.isSuperAdmin}
          signOutAction={signOutAction}
        />
        <main className="flex-1 px-6 py-8 sm:px-10 sm:py-10 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
