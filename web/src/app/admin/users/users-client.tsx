"use client";

import { useTransition } from "react";
import { Shield } from "lucide-react";
import type { AdminUserRow } from "@/lib/admin";
import { toggleSuperAdmin } from "./actions";

export function UsersTable({
  users,
  currentUserId,
}: {
  users: AdminUserRow[];
  currentUserId: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
            <th className="px-5 py-3 font-medium">User</th>
            <th className="px-5 py-3 font-medium">Orgs</th>
            <th className="px-5 py-3 font-medium">Joined</th>
            <th className="px-5 py-3 font-medium">Role</th>
            <th className="px-5 py-3" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <UserRow key={u.id} user={u} isSelf={u.id === currentUserId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({ user, isSelf }: { user: AdminUserRow; isSelf: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="px-5 py-3">
        <p className="font-medium">
          {user.displayName ?? user.email.split("@")[0]}
          {isSelf && <span className="text-muted-foreground font-normal"> (you)</span>}
        </p>
        <p className="text-xs text-muted-foreground">{user.email}</p>
      </td>
      <td className="px-5 py-3 text-muted-foreground tabular-nums">
        {user.orgCount}
      </td>
      <td className="px-5 py-3 text-muted-foreground text-xs">
        {user.createdAt.toLocaleDateString()}
      </td>
      <td className="px-5 py-3">
        {user.isSuperAdmin ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-plum/10 text-plum text-xs font-semibold px-2.5 py-0.5">
            <Shield className="h-3 w-3" />
            Super admin
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Standard</span>
        )}
      </td>
      <td className="px-5 py-3 text-right">
        {!isSelf && (
          <form
            action={(fd) => {
              fd.set("userId", user.id);
              fd.set("enabled", user.isSuperAdmin ? "off" : "on");
              const verb = user.isSuperAdmin
                ? `Remove super-admin from ${user.email}?`
                : `Promote ${user.email} to super admin?`;
              if (!window.confirm(verb)) return;
              startTransition(async () => {
                await toggleSuperAdmin(fd);
              });
            }}
            className="inline-block"
          >
            <button
              type="submit"
              disabled={pending}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {pending ? "Saving…" : user.isSuperAdmin ? "Demote" : "Promote"}
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}
