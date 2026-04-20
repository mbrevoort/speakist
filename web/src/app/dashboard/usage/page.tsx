// Usage dashboard. Summary tiles for 7d/30d/all-time, per-day chart, top
// users table, recent events feed. All empty-state-friendly — until Phase 6
// wires the Mac app, there's no data; the page is still useful as a preview
// of what'll show up.

import { PageHeader } from "@/components/dashboard/page-header";
import { UsageChart } from "@/components/dashboard/usage-chart";
import { requireUser } from "@/lib/authz";
import { getCurrentOrgForUser } from "@/lib/orgs";
import {
  getRecentEvents,
  getTopUsers,
  getUsageByDay,
  getUsageSummary,
} from "@/lib/usage";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "Usage — Speakist" };

export default async function UsagePage() {
  const user = await requireUser();
  const org = (await getCurrentOrgForUser(user.id))!;

  const [summary, points, topUsers, recent] = await Promise.all([
    getUsageSummary(org.id),
    getUsageByDay(org.id, 14),
    getTopUsers(org.id, 10),
    getRecentEvents(org.id, 20),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <PageHeader
        title="Usage"
        description="See how your team's using their transcription credit."
      />

      {/* Summary tiles */}
      <section className="grid sm:grid-cols-3 gap-4">
        <StatTile
          label="Last 7 days"
          words={summary.last7Days.words}
          costMc={summary.last7Days.costMillicents}
          events={summary.last7Days.events}
        />
        <StatTile
          label="Last 30 days"
          words={summary.last30Days.words}
          costMc={summary.last30Days.costMillicents}
          events={summary.last30Days.events}
        />
        <StatTile
          label="All time"
          words={summary.allTime.words}
          costMc={summary.allTime.costMillicents}
          events={summary.allTime.events}
        />
      </section>

      {/* Daily chart */}
      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold tracking-tight">Words per day</h2>
          <span className="text-xs text-muted-foreground">Last 14 days</span>
        </div>
        <UsageChart points={points} metric="words" />
      </section>

      {/* Top users */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Top users
        </h2>
        {topUsers.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No one on your team has transcribed anything yet.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">Member</th>
                  <th className="px-5 py-3 font-medium text-right">Events</th>
                  <th className="px-5 py-3 font-medium text-right">Words</th>
                  <th className="px-5 py-3 font-medium text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {topUsers.map((u) => (
                  <tr key={u.userId} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium text-foreground">
                        {u.displayName ?? u.email.split("@")[0]}
                      </p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {u.events.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {u.words.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {formatDollars(u.costMillicents, { precision: 4 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent events */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Recent transcriptions
        </h2>
        {recent.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
            <p className="text-sm text-muted-foreground">
              Recent transcriptions will appear here. Only metadata —
              word count, duration, model — never the transcript itself.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Member</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium text-right">Words</th>
                  <th className="px-5 py-3 font-medium text-right">Duration</th>
                  <th className="px-5 py-3 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} className="border-b border-border/40 last:border-0">
                    <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">
                      {e.createdAt.toLocaleString()}
                    </td>
                    <td className="px-5 py-3">
                      {e.userDisplayName ?? e.userEmail.split("@")[0]}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground font-mono text-xs">
                      {e.model}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {e.wordCount.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {e.audioMs ? `${(e.audioMs / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {formatDollars(e.costMillicents, { precision: 4 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatTile({
  label,
  words,
  costMc,
  events,
}: {
  label: string;
  words: number;
  costMc: number;
  events: number;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background p-5">
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
        {words.toLocaleString()}
        <span className="ml-1 text-sm font-normal text-muted-foreground">words</span>
      </p>
      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
        <span>{events.toLocaleString()} events</span>
        <span className="font-mono">
          {formatDollars(costMc, { precision: costMc > 100_000 ? 2 : 4 })}
        </span>
      </div>
    </div>
  );
}
