"use client";

import Link from "next/link";
import { useTransition } from "react";
import { ArrowRight, Shield } from "lucide-react";
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
            <th className="px-5 py-3 font-medium">Last active</th>
            <th className="px-5 py-3 font-medium text-right">Events 30d</th>
            <th className="px-5 py-3 font-medium text-right">Words 30d</th>
            <th className="px-5 py-3 font-medium">Role</th>
            <th className="px-5 py-3" aria-label="Actions" />
            <th className="px-5 py-3" aria-label="Open" />
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
  const detailHref = `/admin/users/${user.id}`;

  return (
    <tr className="border-b border-border/40 last:border-0 hover:bg-muted/30">
      <td className="px-5 py-3">
        <Link href={detailHref} className="block group">
          <p className="font-medium text-foreground group-hover:underline">
            {user.displayName ?? user.email.split("@")[0]}
            {isSelf && (
              <span className="text-muted-foreground font-normal"> (you)</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{user.email}</p>
        </Link>
      </td>
      <td className="px-5 py-3 text-xs text-muted-foreground">
        {user.lastActiveAt ? (
          <span title={user.lastActiveAt.toLocaleString()}>
            {formatRelative(user.lastActiveAt)}
          </span>
        ) : (
          <span className="text-muted-foreground/50">never</span>
        )}
      </td>
      <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
        {user.last30dEvents.toLocaleString()}
      </td>
      <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
        {user.last30dWords.toLocaleString()}
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
      <td className="px-5 py-3 text-right">
        <Link
          href={detailHref}
          className="inline-flex items-center text-muted-foreground hover:text-foreground"
          aria-label={`Open ${user.email}`}
        >
          <ArrowRight className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  );
}

/**
 * Friendly relative-time formatter for the "last active" column.
 *   * within the last hour → "5m ago"
 *   * same day             → "3h ago"
 *   * within 7 days        → "2d ago"
 *   * within 30 days       → "12d ago"
 *   * older                → toLocaleDateString
 */
function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / (1000 * 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diffMs / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
