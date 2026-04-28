// No-org landing.
//
// Rendered by the dashboard layout when the signed-in user has no
// `org_members` row. Three things happen here:
//
//   1. Lists every pending invitation for the user's email, each as a
//      card with Accept / Decline buttons. Accept submits to the
//      existing /invite/[token] action (so the same code path handles
//      the "switch from existing org" branch later — irrelevant here
//      since the user has no current org). Decline calls the local
//      `declineInvitationFromNoOrg` server action and the card
//      disappears on revalidate.
//   2. Falls back to a "Create your own workspace" CTA when there are
//      no invites, or as an alternative below the invite list. Gated
//      on `appSettings.allowPublicOrgCreation`.
//   3. Sign-out button preserved so the user has an escape hatch.
//
// The component is a client component because the buttons need
// useTransition for pending state. Server props get passed straight
// through.

"use client";

import { useTransition } from "react";
import { Building2, MailOpen, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  acceptInvitation,
} from "@/app/invite/[token]/actions";
import {
  createOwnWorkspaceFromNoOrg,
  declineInvitationFromNoOrg,
} from "./no-org-actions";
import type { PendingInvitationForUser } from "@/lib/orgs";

export function NoOrgPanel({
  userEmail,
  invitations,
  allowCreate,
  signOutAction,
}: {
  userEmail: string;
  invitations: PendingInvitationForUser[];
  allowCreate: boolean;
  signOutAction: () => Promise<void>;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-5">
        <header className="text-center">
          <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-peach/15 text-peach-deep mb-4">
            <Building2 className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            What&apos;s next?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You&apos;re signed in as{" "}
            <span className="font-mono text-foreground">{userEmail}</span>{" "}
            but not yet part of a workspace.
          </p>
        </header>

        {invitations.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs uppercase tracking-[0.15em] font-medium text-muted-foreground">
              {invitations.length === 1
                ? "You have an invitation"
                : "You have invitations"}
            </h2>
            {invitations.map((inv) => (
              <InvitationCard key={inv.invitationId} invitation={inv} />
            ))}
          </section>
        )}

        {allowCreate && (
          <section
            className={
              invitations.length === 0
                ? "rounded-2xl border border-border/70 bg-background p-6"
                : "rounded-2xl border border-border/70 bg-muted/30 p-6"
            }
          >
            <div className="flex items-start gap-3">
              <div className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-peach/15 text-peach-deep shrink-0">
                <Plus className="size-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold">
                  {invitations.length === 0
                    ? "Create your own workspace"
                    : "Or create your own workspace"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Skips the invitations and gives you a fresh workspace
                  you control. You can invite teammates afterward.
                </p>
                <CreateButton hasInvites={invitations.length > 0} />
              </div>
            </div>
          </section>
        )}

        {!allowCreate && invitations.length === 0 && (
          <section className="rounded-2xl border border-border/70 bg-background p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Public sign-up is currently disabled. Ask whoever set up
              Speakist to send you an invitation.
            </p>
          </section>
        )}

        <div className="text-center">
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function InvitationCard({
  invitation,
}: {
  invitation: PendingInvitationForUser;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="rounded-2xl border border-border/70 bg-background p-5">
      <div className="flex items-start gap-3">
        <div className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-sage/15 text-sage shrink-0">
          <MailOpen className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">
            Join <span className="text-foreground">{invitation.orgName}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Invited by {invitation.invitedByEmail} · role{" "}
            <span className="capitalize">{invitation.role}</span>
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <form
          action={(fd) => {
            fd.set("token", invitation.token);
            startTransition(async () => acceptInvitation(fd));
          }}
        >
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Accepting…" : "Accept"}
          </Button>
        </form>
        <form
          action={(fd) => {
            fd.set("invitation_id", invitation.invitationId);
            startTransition(() => {
              void declineInvitationFromNoOrg(fd);
            });
          }}
        >
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            <X className="size-3" />
            Decline
          </Button>
        </form>
      </div>
    </div>
  );
}

function CreateButton({ hasInvites }: { hasInvites: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-4">
      <form
        action={async () => {
          startTransition(() => {
            void createOwnWorkspaceFromNoOrg();
          });
        }}
      >
        <Button
          type="submit"
          size="sm"
          variant={hasInvites ? "outline" : "default"}
          disabled={pending}
        >
          {pending ? "Creating…" : "Create new workspace"}
        </Button>
      </form>
    </div>
  );
}
