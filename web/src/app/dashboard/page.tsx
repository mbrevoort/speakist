// Dashboard home. Shows org status, credit balance, and next-steps hints.
// No widgets/charts yet — those land in Phase 4 once we have real usage to
// chart. Phase 3's home is deliberately a "welcome + where to go next" page.

import { eq } from "drizzle-orm";
import Link from "next/link";
import { ArrowRight, Apple, BarChart3, CreditCard, Download, ExternalLink, Users as UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser, getOrgCreditBalance } from "@/lib/orgs";
import { getDb } from "@/lib/db";
import { pricingConfig } from "@/lib/db/schema";
import { millicentsToWords } from "@/lib/utils";

export const metadata = { title: "Dashboard — Speakist" };

export default async function DashboardHome() {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!; // layout guarantees non-null
  const db = getDb();
  const [balanceMc, [cfg]] = await Promise.all([
    getOrgCreditBalance(org.id),
    db
      .select({ perWordMc: pricingConfig.pricePerWordMillicents })
      .from(pricingConfig)
      .where(eq(pricingConfig.id, 1))
      .limit(1),
  ]);
  const balanceWords = millicentsToWords(balanceMc, cfg?.perWordMc ?? 20);

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
          Your team is set up. Install Speakist on Mac or iPhone and start
          dictating — every transcription draws from your word balance below.
        </p>
      </header>

      {/* Credit + org status cards */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Words remaining" primary>
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            {balanceWords.toLocaleString("en-US")}
            <span className="ml-1 text-base font-normal text-muted-foreground">words</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {org.isComped
              ? "Comped — usage won't debit this balance."
              : "Debits in real time as your team transcribes."}
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
              href="/dashboard/billing"
              className="flex items-center justify-between hover:text-foreground text-muted-foreground"
            >
              <span className="flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Add words
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href="/dashboard/usage"
              className="flex items-center justify-between hover:text-foreground text-muted-foreground"
            >
              <span className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                See usage
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
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
          </div>
        </StatCard>
      </section>

      {/* Download CTA — Mac + iOS, same account works on both. */}
      <section className="rounded-2xl border-2 border-dashed border-border/70 bg-white/30 p-8 sm:p-10">
        <div className="flex flex-col sm:flex-row items-start gap-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-plum text-cream">
            <Apple className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold tracking-tight">
              Get Speakist on Mac and iPhone
            </h2>
            <p className="mt-2 text-muted-foreground">
              Same account, same balance, both devices. On Mac, hold{" "}
              <kbd className="font-mono rounded border border-border bg-muted px-1.5 py-0.5 text-xs">⌃⌘X</kbd>.
              On iPhone, switch to the Speakist keyboard and tap-and-hold.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button asChild>
                <a href="/api/download/mac" download className="gap-2">
                  <Download className="size-4" aria-hidden />
                  Download for Mac
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href="https://testflight.apple.com/join/5jqHKMnu"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gap-2"
                >
                  iPhone Beta (TestFlight)
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              </Button>
              <span className="text-xs text-muted-foreground">
                Requires macOS 14+ or iOS 17+. Free to install — you only pay
                per word transcribed.
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
