// Admin → users list.

import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { listAllUsers } from "@/lib/admin";
import { UsersTable } from "./users-client";

export const metadata = { title: "Users — Admin" };

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const caller = await requireSuperAdmin();
  const { q } = await searchParams;
  const users = await listAllUsers(q?.trim() || undefined);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Users"
        description="Everyone with a Speakist account. Promote trusted people to super admin from here."
      />

      <form className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by email or name…"
          className="w-full sm:w-96 rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </form>

      {users.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {q ? `No users match "${q}".` : "No users yet."}
          </p>
        </div>
      ) : (
        <UsersTable users={users} currentUserId={caller.id} />
      )}
    </div>
  );
}
