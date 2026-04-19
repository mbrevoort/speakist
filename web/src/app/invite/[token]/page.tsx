// Public invitation accept page.
//
// The user arrives via a link in the invitation email:
//     {SITE_URL}/invite/{token}
//
// Flow, in order of the ifs:
//   1. Invitation missing / expired / already-accepted → friendly dead-end UI
//   2. User not signed in → show org info + "Sign in as {email} to accept"
//      button that hops to /auth/signin with this URL as callback
//   3. User signed in but with a different email → show a sign-out + retry
//      prompt (the invitation is email-locked)
//   4. Everything matches → show "Join {Org}" button that calls the server
//      action and redirects to /dashboard
//
// Security note: the token is a 48-char hex. We scope every DB query by the
// token, so even though this page is public, the only thing an unauth
// visitor can see is the org name + inviter email for a token they already
// possess.

import Link from "next/link";
import { eq } from "drizzle-orm";
import { CheckCircle2, MailWarning, XCircle } from "lucide-react";
import { getDb } from "@/lib/db";
import { invitations, organizations, users } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/logo";
import { getAuth } from "@/lib/auth";
import { acceptInvitation } from "./actions";

export const metadata = { title: "Invitation — Speakist" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = getDb();

  const [row] = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      orgName: organizations.name,
      orgId: invitations.orgId,
      inviterEmail: users.email,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      token: invitations.token,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .innerJoin(users, eq(users.id, invitations.invitedBy))
    .where(eq(invitations.token, token))
    .limit(1);

  // 1a. No such invitation.
  if (!row) {
    return (
      <Shell>
        <StatusIcon kind="error" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          Invitation not found.
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This link isn&apos;t valid. It may have been revoked — ask the person
          who sent it to invite you again.
        </p>
      </Shell>
    );
  }

  // 1b. Expired.
  if (row.expiresAt.getTime() < Date.now() && !row.acceptedAt) {
    return (
      <Shell>
        <StatusIcon kind="error" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          This invitation has expired.
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Invitations are good for 14 days. Ask {row.inviterEmail} to send a
          fresh one.
        </p>
      </Shell>
    );
  }

  // 1c. Already accepted.
  if (row.acceptedAt) {
    return (
      <Shell>
        <StatusIcon kind="success" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          You&apos;re already in.
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You accepted this invitation on{" "}
          {row.acceptedAt.toLocaleDateString()}.
        </p>
        <div className="mt-6">
          <Button asChild size="lg" className="w-full">
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  // Pull the current session (if any).
  const { auth } = await getAuth();
  const session = await auth();
  const signedInEmail = session?.user?.email ?? null;

  // 2. Not signed in → send to signin, callback back here.
  if (!signedInEmail) {
    return (
      <Shell>
        <InvitationSummary
          orgName={row.orgName}
          inviterEmail={row.inviterEmail}
          role={row.role}
        />
        <div className="mt-6 space-y-2">
          <p className="text-sm text-muted-foreground">
            This invitation is addressed to{" "}
            <span className="font-medium text-foreground">{row.email}</span>.
            Sign in with that email to accept.
          </p>
          <Button asChild size="lg" className="w-full mt-4">
            <Link
              href={`/auth/signin?callbackUrl=${encodeURIComponent(
                `/invite/${token}`
              )}`}
            >
              Sign in to accept
            </Link>
          </Button>
        </div>
      </Shell>
    );
  }

  // 3. Signed in with the wrong email.
  if (signedInEmail.toLowerCase() !== row.email.toLowerCase()) {
    return (
      <Shell>
        <StatusIcon kind="warn" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          Wrong email signed in.
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You&apos;re signed in as{" "}
          <span className="font-mono text-foreground">{signedInEmail}</span>,
          but this invitation is for{" "}
          <span className="font-mono text-foreground">{row.email}</span>.
        </p>
        <div className="mt-6 flex gap-2">
          <Button asChild variant="outline" className="flex-1">
            <Link href="/api/auth/signout">Sign out</Link>
          </Button>
          <Button asChild className="flex-1">
            <Link href="/dashboard">Continue as current user</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  // 4. Signed in as the right email → accept.
  return (
    <Shell>
      <InvitationSummary
        orgName={row.orgName}
        inviterEmail={row.inviterEmail}
        role={row.role}
      />
      <form action={acceptInvitation} className="mt-6">
        <input type="hidden" name="token" value={row.token} />
        <Button type="submit" size="lg" className="w-full">
          Join {row.orgName}
        </Button>
      </form>
    </Shell>
  );
}

// --- pieces ----------------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at top, rgba(255, 138, 101, 0.25), transparent 70%)",
        }}
      />
      <Link href="/" aria-label="Speakist home" className="relative mb-8">
        <Wordmark markClassName="w-8 h-8" className="text-xl" />
      </Link>
      <div className="relative w-full max-w-md rounded-2xl border border-border/70 bg-background/95 backdrop-blur-sm shadow-xl shadow-peach/5 p-8 sm:p-10 text-center">
        {children}
      </div>
    </div>
  );
}

function InvitationSummary({
  orgName,
  inviterEmail,
  role,
}: {
  orgName: string;
  inviterEmail: string;
  role: string;
}) {
  return (
    <>
      <p className="text-sm uppercase tracking-[0.15em] text-peach-deep font-medium">
        You&apos;re invited
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Join {orgName} on Speakist
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {inviterEmail} invited you as{" "}
        <span className="font-medium text-foreground capitalize">{role}</span>.
      </p>
    </>
  );
}

function StatusIcon({ kind }: { kind: "success" | "error" | "warn" }) {
  const Icon =
    kind === "success" ? CheckCircle2 : kind === "warn" ? MailWarning : XCircle;
  const tint =
    kind === "success"
      ? "bg-sage/15 text-sage"
      : kind === "warn"
      ? "bg-mustard/15 text-mustard"
      : "bg-destructive/10 text-destructive";
  return (
    <div className={`mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl ${tint}`}>
      <Icon className="size-6" />
    </div>
  );
}
