// Dashboard home. Shows org status, credit balance, and next-steps hints.
// No widgets/charts yet — those land in Phase 4 once we have real usage to
// chart. Phase 3's home is deliberately a "welcome + where to go next" page.

import Link from "next/link";
import { ArrowRight, Apple, Users as UsersIcon, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Dashboard — Speakist" };

export default async function DashboardHome() {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!; // layout guarantees non-null
  const balanceMc = await getOrgCreditBalance(org.id);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting()}, {user.displayName ?? user.email.split("@")[0]}.
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Welcome to Speakist.
        </h1>
        <p className="mt-2 text-muted-foreground max-w-xl">
          Your team is set up. Download the Mac app and start dictating — every
          transcription debits the credits below.
        </p>
      </header>

      {/* Credit + org status cards */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Credit balance" primary>
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            {formatDollars(balanceMc, { precision: 2 })}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {org.isComped
              ? "Comped — usage won't debit this balance."
              : "Usage-based. Debits in real time as your team transcribes."}
          </p>
        </StatCard>

        <StatCard label="Organization">
          <p className="text-2xl font-semibold tracking-tight truncate">
            {org.name}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            You&apos;re the <span className="font-mono text-foreground">{org.role}</span>
            {org.autoJoinDomain ? (
              <>
                {" "}· <span className="font-mono">@{org.autoJoinDomain}</span> auto-join on
              </>
            ) : null}
          </p>
        </StatCard>

        <StatCard label="Quick links">
          <div className="space-y-1.5 text-sm">
            <Link
              href="/dashboard/members"
              className="flex items-center justify-between hover:text-foreground text-muted-foreground"
            >
              <span className="flex items-center gap-2">
                <UsersIcon className="h-4 w-4" />
                Invite your team
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href="/dashboard/settings"
              className="flex items-center justify-between hover:text-foreground text-muted-foreground"
            >
              <span className="flex items-center gap-2">
                <ReceiptText className="h-4 w-4" />
                Org settings
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </StatCard>
      </section>

      {/* Download CTA placeholder — wired in Phase 6 */}
      <section className="rounded-2xl border-2 border-dashed border-border/70 bg-white/30 p-8 sm:p-10">
        <div className="flex flex-col sm:flex-row items-start gap-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-plum text-cream">
            <Apple className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold tracking-tight">
              Download Speakist for Mac
            </h2>
            <p className="mt-2 text-muted-foreground">
              Install the native app, sign in with your Speakist account, and
              hold <kbd className="font-mono rounded border border-border bg-muted px-1.5 py-0.5 text-xs">⌃⌘X</kbd> anywhere to dictate.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Button disabled title="Available in Phase 6">
                Download · Coming soon
              </Button>
              <span className="text-xs text-muted-foreground">
                v1 download lands with Mac sign-in support (Phase 6).
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  primary,
  children,
}: {
  label: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "rounded-2xl border p-6 " +
        (primary
          ? "border-peach/40 bg-background shadow-sm shadow-peach/10"
          : "border-border/70 bg-background")
      }
    >
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
