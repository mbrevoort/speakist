// Admin overview. Platform-wide stats at a glance. No deep interactivity
// here — this is a "what's the state of the business" page.

import { PageHeader } from "@/components/dashboard/page-header";
import { PlatformActivityChart } from "@/components/dashboard/platform-activity-chart";
import { requireSuperAdmin } from "@/lib/authz";
import {
  getPlatformDailyUsage,
  getPlatformTotals,
  getTableRowCounts,
} from "@/lib/admin";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Admin — Speakist" };

/** D1's hard ceiling on per-database storage. The high-volume tables
 *  approach this at ~25M rows each (≈150 bytes/row). Surfacing the
 *  current counts on the overview is the simplest "are we headed
 *  toward the wall" instrument we can add today. */
const D1_ROW_HEADROOM_WARN = 5_000_000; // half-yellow at 5M rows/table

export default async function AdminOverview() {
  await requireSuperAdmin();
  const [totals, daily, rowCounts] = await Promise.all([
    getPlatformTotals(),
    getPlatformDailyUsage(30),
    getTableRowCounts(),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PageHeader
        title="Platform overview"
        description="Live platform stats. Everything here updates in real time."
      />

      {/* Counts row */}
      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Workspaces" value={totals.orgs.toLocaleString()} />
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
          subtitle="Total credits held across all workspaces"
          tint="plum"
        />
        <Stat
          label="Top-ups (all time)"
          value={formatDollars(totals.topupsAllTimeMillicents)}
          subtitle="Gross Stripe payments received"
          tint="sage"
        />
      </section>

      {/* High-volume table row counts. Approaches D1's 10 GB ceiling
          at ~25M rows for the raw tables; the rollup is bounded by
          (active users × days). Tinted mustard once any table crosses
          the half-yellow threshold so the warning is glanceable. */}
      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">
            Storage
          </h2>
          <span className="text-xs text-muted-foreground">
            D1 hard cap is 10 GB / ≈ 25M rows on the raw tables
          </span>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <RowCountTile
            label="usage_events"
            count={rowCounts.usageEvents}
            warnAt={D1_ROW_HEADROOM_WARN}
          />
          <RowCountTile
            label="credit_ledger"
            count={rowCounts.creditLedger}
            warnAt={D1_ROW_HEADROOM_WARN}
          />
          <RowCountTile
            label="usage_daily (rollup)"
            count={rowCounts.usageDaily}
            warnAt={D1_ROW_HEADROOM_WARN}
          />
        </div>
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

function RowCountTile({
  label,
  count,
  warnAt,
}: {
  label: string;
  count: number;
  warnAt: number;
}) {
  const warn = count >= warnAt;
  const border = warn ? "border-mustard/40" : "border-border/60";
  const tint = warn ? "text-mustard" : "text-foreground";
  return (
    <div className={`rounded-xl border ${border} bg-muted/20 p-4`}>
      <p className="text-xs font-mono text-muted-foreground">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${tint}`}>
        {count.toLocaleString()}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">rows</p>
    </div>
  );
}
