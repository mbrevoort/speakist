// Client-side interactivity for the members page. Receives server-fetched
// data as props and renders the invite form + member/invitation tables.
// The actions are imported from ./actions (all "use server") and called
// via form `action={...}`.

"use client";

import { useFormStatus } from "react-dom";
import { useState, useTransition } from "react";
import { X, Mail, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDollars } from "@/lib/utils"; // cn used; formatDollars re-export for parity (keep)
import type { OrgMemberRow, PendingInvitation } from "@/lib/orgs";
import type { OrgRole } from "@/lib/db/schema";
import {
  inviteMember,
  revokeInvitation,
  removeMember,
  changeMemberRole,
  type ActionResult,
} from "./actions";

// Re-export to preserve the import (lint fix):
void formatDollars;

interface Props {
  orgId: string;
  currentUserId: string;
  currentUserRole: OrgRole;
  members: OrgMemberRow[];
  pending: PendingInvitation[];
}

export function MembersClient({
  currentUserId,
  currentUserRole,
  members,
  pending,
}: Props) {
  const isOwner = currentUserRole === "owner";

  return (
    <div className="space-y-10">
      {/* Invite form */}
      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">Invite by email</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          We&apos;ll send a magic link. They sign in with the same email to
          accept.
        </p>
        <InviteForm isOwner={isOwner} />
      </section>

      {/* Pending invitations */}
      {pending.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight mb-3">
            Pending invitations
          </h2>
          <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">Email</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Invited by</th>
                  <th className="px-5 py-3 font-medium">Expires</th>
                  <th className="px-5 py-3" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pending.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3 font-medium flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      {inv.email}
                    </td>
                    <td className="px-5 py-3">
                      <RoleBadge role={inv.role} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {inv.invitedByEmail}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {inv.expiresAt.toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <ActionIconForm action={revokeInvitation} extra={{ invitationId: inv.id }} confirm={`Revoke invitation to ${inv.email}?`}>
                        <X className="h-4 w-4" />
                      </ActionIconForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Active members */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Members <span className="text-sm text-muted-foreground font-normal">({members.length})</span>
        </h2>
        <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                <th className="px-5 py-3 font-medium">Member</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Joined</th>
                <th className="px-5 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.userId === currentUserId;
                return (
                  <tr key={m.userId} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-peach/20 text-peach-deep text-sm font-semibold">
                          {(m.displayName?.[0] ?? m.email[0]).toUpperCase()}
                        </span>
                        <div>
                          <p className="font-medium text-foreground">
                            {m.displayName ?? m.email.split("@")[0]}
                            {isSelf && <span className="text-muted-foreground font-normal"> (you)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {isOwner && !isSelf ? (
                        <RoleChanger userId={m.userId} currentRole={m.role} />
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {m.joinedAt.toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!isSelf && (
                        <ActionIconForm
                          action={removeMember}
                          extra={{ userId: m.userId }}
                          confirm={`Remove ${m.email} from this org?`}
                        >
                          <X className="h-4 w-4" />
                        </ActionIconForm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// --- form helpers ----------------------------------------------------------

function InviteForm({ isOwner }: { isOwner: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-5 flex flex-col sm:flex-row gap-3"
      action={(formData) => {
        setResult(null);
        startTransition(async () => {
          const r = await inviteMember(formData);
          setResult(r);
          if (r.ok) {
            const form = document.getElementById("invite-form") as HTMLFormElement | null;
            form?.reset();
          }
        });
      }}
      id="invite-form"
    >
      <input
        required
        type="email"
        name="email"
        placeholder="teammate@example.com"
        autoComplete="off"
        className="flex-1 rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <select
        name="role"
        defaultValue="member"
        className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        {isOwner && <option value="owner">Owner</option>}
      </select>
      <Button type="submit" disabled={pending} size="default">
        {pending ? "Sending…" : "Send invite"}
      </Button>

      {result && (
        <p
          className={cn(
            "mt-2 text-sm basis-full",
            result.ok ? "text-sage" : "text-destructive"
          )}
          role="status"
        >
          {result.ok ? result.message ?? "Sent." : result.error}
        </p>
      )}
    </form>
  );
}

function ActionIconForm({
  action,
  extra,
  confirm,
  children,
}: {
  action: (f: FormData) => Promise<ActionResult>;
  extra: Record<string, string>;
  confirm: string;
  children: React.ReactNode;
}) {
  return (
    <form
      action={async (fd) => {
        if (!window.confirm(confirm)) return;
        for (const [k, v] of Object.entries(extra)) fd.set(k, v);
        await action(fd);
      }}
      className="inline-block"
    >
      <SubmitIconButton>{children}</SubmitIconButton>
    </form>
  );
}

function SubmitIconButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive transition-colors disabled:opacity-50"
      aria-label="Remove"
    >
      {children}
    </button>
  );
}

function RoleChanger({ userId, currentRole }: { userId: string; currentRole: OrgRole }) {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(fd) => {
        fd.set("userId", userId);
        startTransition(async () => {
          await changeMemberRole(fd);
        });
      }}
      className="inline-flex"
    >
      <select
        name="role"
        defaultValue={currentRole}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </select>
    </form>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  const palette =
    role === "owner"
      ? "bg-peach/15 text-peach-deep border-peach/30"
      : role === "admin"
      ? "bg-plum/10 text-plum border-plum/30"
      : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        palette
      )}
    >
      {role === "owner" && <Shield className="h-3 w-3" />}
      {role}
    </span>
  );
}
