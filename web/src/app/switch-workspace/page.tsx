// Public switch-workspace page. The Mac/iOS Settings → Workspace row
// opens this URL in the user's browser when they tap "Switch workspace".
// They pick an org here, the server persists `users.last_active_org_id`,
// the page shows a "you're done — return to Speakist" confirmation, and
// the next /api/me sync from the native app picks up the new active org.
//
// Single-membership users never have a reason to land here — but we
// handle the case anyway with a "you're only in one workspace" message
// to avoid a confusing dead-end.
//
// Auth: redirects unsigned users to /auth/signin first.

import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Building2 } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getOrgsForUser } from "@/lib/orgs";
import { SwitchWorkspaceClient } from "./switch-client";

export const metadata = { title: "Switch workspace — Speakist" };

export default async function SwitchWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ return?: string }>;
}) {
  const { auth } = await getAuth();
  const session = await auth();
  const { return: returnTo } = await searchParams;

  if (!session?.user) {
    const target = returnTo
      ? `/switch-workspace?return=${encodeURIComponent(returnTo)}`
      : "/switch-workspace";
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(target)}`);
  }

  const userId = (session.user as { id?: string }).id;
  const orgs = userId ? await getOrgsForUser(userId) : [];

  let activeOrgId: string | null = null;
  if (userId) {
    const db = getDb();
    const [row] = await db
      .select({ lastActiveOrgId: users.lastActiveOrgId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    activeOrgId =
      (row?.lastActiveOrgId &&
        orgs.find((o) => o.id === row.lastActiveOrgId)?.id) ||
      orgs[0]?.id ||
      null;
  }

  // The native-app return flag is informational — the server can't
  // close the user's tab for them. Used by the client to swap the
  // post-save copy to "Return to Speakist on your <device>" instead
  // of "Back to dashboard".
  const isFromNative = returnTo === "mac-app" || returnTo === "ios-app";

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

      <div className="relative w-full max-w-md rounded-2xl border border-border/70 bg-background/95 backdrop-blur-sm shadow-xl shadow-peach/5 p-8 sm:p-10">
        <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-peach/15 text-peach-deep mb-5">
          <Building2 className="size-6" />
        </div>
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          Switch workspace
        </h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Pick which workspace Speakist should use for transcripts and billing.
        </p>

        {orgs.length === 0 ? (
          <div className="mt-6 rounded-xl bg-mustard/10 border border-mustard/30 p-5 text-center text-sm">
            You aren&apos;t a member of any workspace yet.
          </div>
        ) : orgs.length === 1 ? (
          <div className="mt-6 rounded-xl bg-muted/30 border border-border/70 p-5 text-center text-sm">
            <p className="font-medium">{orgs[0].name}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              You&apos;re only a member of one workspace, so there&apos;s nothing to switch to.
            </p>
          </div>
        ) : (
          <SwitchWorkspaceClient
            orgs={orgs}
            initialActiveOrgId={activeOrgId}
            isFromNative={isFromNative}
          />
        )}
      </div>

      {!isFromNative && (
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to dashboard
        </Link>
      )}
    </div>
  );
}
