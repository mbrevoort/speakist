// Super-admin shell. Gated on users.is_super_admin — non-admins get
// redirected to /dashboard (not /auth/signin, because they're already
// signed in; they just lack the flag).

import { redirect } from "next/navigation";
import { AdminSidebar } from "@/components/admin/sidebar";
import { AdminMobileNav } from "@/components/admin/mobile-nav";
import { Topbar } from "@/components/dashboard/topbar";
import { AuthzError, requireUser } from "@/lib/authz";
import { getAuth } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthzError) {
      redirect("/auth/signin?callbackUrl=/admin");
    }
    throw err;
  }
  if (!user.isSuperAdmin) {
    redirect("/dashboard");
  }

  const signOutAction = async () => {
    "use server";
    const { signOut } = await getAuth();
    await signOut({ redirectTo: "/" });
  };

  return (
    <div className="flex min-h-screen">
      <AdminSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userEmail={user.email}
          userDisplayName={user.displayName}
          isSuperAdmin={user.isSuperAdmin}
          signOutAction={signOutAction}
          mobileNav={<AdminMobileNav />}
        />
        <main className="flex-1 px-6 py-8 sm:px-10 sm:py-10 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
