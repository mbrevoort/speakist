// Admin → single-user detail page.
//
// Shows: identity + super-admin status, 30-day activity summary, the
// org memberships this user belongs to, a daily-words bar chart for the
// last 30 days, and the most recent dictation events with the org each
// one came from.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Shield } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { UsageChart } from "@/components/dashboard/usage-chart";
import { requireSuperAdmin } from "@/lib/authz";
import { getUserDetail } from "@/lib/admin";
import { formatDollars } from "@/lib/utils";

export const metadata = { title: "User — Admin" };

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const user = await getUserDetail(id);
  if (!user) notFound();

  // The recent-events table is hidden when there are zero events to keep
  // the page from rendering an empty card.
  const hasActivity = user.recentEvents.length > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div>
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All users
        </Link>
        <PageHeader
          title={user.displayName ?? user.email.split("@")[0]}
          description={`${user.email} · joined ${user.createdAt.toLocaleDateString()}${
            user.lastActiveAt
              ? ` · last active ${formatRelative(user.lastActiveAt)}`
              : " · never active"
          }`}
          actions={
            user.isSuperAdmin ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-plum/10 text-plum text-xs font-semibold px-2.5 py-0.5">
                <Shield className="h-3 w-3" />
                Super admin
              </span>
            ) : null
          }
        />
      </div>

      {/* 30-day stat tiles */}
      <section className="grid sm:grid-cols-4 gap-3">
        <StatTile
          label="Events (30d)"
          value={user.last30d.events.toLocaleString()}
        />
        <StatTile
          label="Words (30d)"
          value={user.last30d.words.toLocaleString()}
        />
        <StatTile
          label="Audio (30d)"
          value={formatAudioDuration(user.last30d.audioMs)}
        />
        <StatTile
          label="Cost (30d)"
          value={formatDollars(user.last30d.costMillicents, { precision: 2 })}
        />
      </section>

      {/* Daily activity */}
      <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">
            Words per day
          </h2>
          <span className="text-xs text-muted-foreground">Last 30 days</span>
        </div>
        <UsageChart
          points={user.daily.map((d) => ({
            day: d.day,
            words: d.words,
            costMillicents: d.costMillicents,
          }))}
          metric="words"
        />
      </section>

      {/* Org memberships */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Organizations{" "}
          <span className="text-muted-foreground font-normal">
            ({user.memberships.length})
          </span>
        </h2>
        {user.memberships.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background p-8 text-center">
            <p className="text-sm text-muted-foreground">
              This user isn&apos;t a member of any organization.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {user.memberships.map((m) => (
                  <tr
                    key={m.orgId}
                    className="border-b border-border/40 last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/orgs/${m.orgId}`}
                        className="font-medium hover:underline"
                      >
                        {m.orgName}
                      </Link>
                      <p className="text-xs text-muted-foreground font-mono">
                        {m.orgSlug}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-right text-xs font-mono uppercase tracking-wider text-muted-foreground">
                      {m.role}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                      joined {m.joinedAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent transcription events */}
      {hasActivity && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight mb-3">
            Recent transcriptions{" "}
            <span className="text-muted-foreground font-normal">
              (last {user.recentEvents.length})
            </span>
          </h2>
          <div className="rounded-2xl border border-border/70 bg-background overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Org</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium text-right">Words</th>
                  <th className="px-5 py-3 font-medium text-right">Audio</th>
                  <th className="px-5 py-3 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {user.recentEvents.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className="px-5 py-3 text-muted-foreground whitespace-nowrap">
                      {e.createdAt.toLocaleString()}
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/orgs/${e.orgId}`}
                        className="hover:underline"
                      >
                        {e.orgName}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-xs font-mono text-muted-foreground">
                      <span>{e.providerId}</span> <span>{e.model}</span>
                      {e.polishApplied && (
                        <span
                          className="ml-2 inline-flex items-center rounded-full bg-peach/10 text-peach-deep text-[10px] font-semibold px-1.5 py-0.5 uppercase"
                          title="Polish pass applied"
                        >
                          polished
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {e.wordCount.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {e.audioMs ? formatAudioDuration(e.audioMs) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {formatDollars(e.costMillicents, { precision: 4 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background p-4">
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
    </div>
  );
}

/** Format milliseconds → "1m 23s" / "8.4s". Returns "—" for zero. */
function formatAudioDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec - m * 60);
  return `${m}m ${s}s`;
}

/**
 * Same shape as the relative-time formatter in users-client.tsx, kept
 * separately because this page is a server component and can't import a
 * "use client" file's helpers cleanly.
 */
function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / (1000 * 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diffMs / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
