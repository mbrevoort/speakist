// Admin overview. Platform-wide stats at a glance. No deep interactivity
// here — this is a "what's the state of the business" page.

import { PageHeader } from "@/components/dashboard/page-header";
import { PlatformActivityChart } from "@/components/dashboard/platform-activity-chart";
import { requireSuperAdmin } from "@/lib/authz";
import { getPlatformDailyUsage, getPlatformTotals } from "@/lib/admin";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Admin — Speakist" };

export default async function AdminOverview() {
  await requireSuperAdmin();
  const [totals, daily] = await Promise.all([
    getPlatformTotals(),
    getPlatformDailyUsage(30),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PageHeader
        title="Platform overview"
        description="Live platform stats. Everything here updates in real time."
      />

      {/* Counts row */}
      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Organizations" value={totals.orgs.toLocaleString()} />
        <Stat label="Users" value={totals.users.toLocaleString()} />
        <Stat label="Events (30d)" value={totals.usage30dEvents.toLocaleString()} />
        <Stat
          label="Words transcribed (30d)"
          value={totals.usage30dWords.toLocaleString()}
        />
      </section>

      {/* Money row */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Stat
          label="Outstanding credit liability"
          value={formatDollars(totals.balanceAllOrgsMillicents)}
          subtitle="Total credits held across all orgs"
          tint="plum"
        />
        <Stat
          label="Top-ups (all time)"
          value={formatDollars(totals.topupsAllTimeMillicents)}
          subtitle="Gross Stripe payments received"
          tint="sage"
        />
      </section>

      {/* Daily activity — words transcribed + active users, both per day. */}
      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-lg font-semibold tracking-tight">
            Daily activity
          </h2>
          <span className="text-xs text-muted-foreground">
            Last 30 days
          </span>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Words transcribed and distinct active users per day. An active user
          is anyone with at least one dictation event that day.
        </p>
        <PlatformActivityChart points={daily} />
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  subtitle,
  tint,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tint?: "plum" | "sage";
}) {
  const border =
    tint === "plum" ? "border-plum/30" : tint === "sage" ? "border-sage/30" : "border-border/70";
  return (
    <div className={`rounded-2xl border ${border} bg-background p-5`}>
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}
