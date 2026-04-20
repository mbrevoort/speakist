// Admin overview. Platform-wide stats at a glance. No deep interactivity
// here — this is a "what's the state of the business" page.

import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getPlatformTotals } from "@/lib/admin";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Admin — Speakist" };

export default async function AdminOverview() {
  await requireSuperAdmin();
  const totals = await getPlatformTotals();

  // Revenue = gross top-ups. Cost = what Deepgram charged us (reported on
  // each usage_event). Margin = revenue - cost (approximation — ignores
  // outstanding credit liability + refunds).
  const margin30d =
    totals.usage30dCostMillicents - totals.usage30dDeepgramCostMillicents;
  const marginPct =
    totals.usage30dCostMillicents > 0
      ? (margin30d / totals.usage30dCostMillicents) * 100
      : 0;

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

      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight">
          Last 30 days — revenue vs. Deepgram cost
        </h2>
        <div className="mt-6 grid sm:grid-cols-3 gap-6">
          <BigNumber
            label="Retail cost to orgs"
            value={formatDollars(totals.usage30dCostMillicents)}
          />
          <BigNumber
            label="Deepgram cost to us"
            value={formatDollars(totals.usage30dDeepgramCostMillicents)}
            muted
          />
          <BigNumber
            label="Gross margin"
            value={formatDollars(margin30d)}
            hint={`${marginPct.toFixed(1)}%`}
            tint={margin30d >= 0 ? "sage" : "destructive"}
          />
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Deepgram cost is reported per-transcription by the Mac app (Phase 6)
          — shows $0 until Mac integration reports real per-call costs.
        </p>
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

function BigNumber({
  label,
  value,
  hint,
  muted,
  tint,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  tint?: "sage" | "destructive";
}) {
  const color =
    tint === "sage" ? "text-sage" : tint === "destructive" ? "text-destructive" : "text-foreground";
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <p
        className={`mt-2 text-4xl font-semibold tracking-tight tabular-nums ${
          muted ? "text-muted-foreground" : color
        }`}
      >
        {value}
      </p>
      {hint && <p className={`mt-1 text-sm ${color}`}>{hint}</p>}
    </div>
  );
}
