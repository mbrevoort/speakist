// Admin → Feedback list.
//
// Triage queue for "Report bad transcription" submissions. Default
// filter is `new` so the operator sees the work to do; switch to
// `all` (or any specific status) via the filter chips. Newest-first.
// Click a row to triage; the detail page handles status/resolution
// edits and audio playback.
//
// JSON export: a "Copy as fixture seeds" button on the detail page
// builds a polish-fixtures.ts-shaped JSON for hand-curation. The
// future Phase-3 agent reads the same `transcription_feedback` rows
// directly and won't go through this page.

import Link from "next/link";
import { ArrowRight, FlagIcon, Mic } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import {
  getFeedbackStatusCounts,
  listFeedback,
  type FeedbackStatus,
} from "@/lib/feedback";
import { cn } from "@/lib/utils";

export const metadata = { title: "Feedback — Admin" };

const STATUSES: { value: FeedbackStatus | "all"; label: string }[] = [
  { value: "new", label: "New" },
  { value: "reviewed", label: "Reviewed" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "proposed", label: "Proposed" },
  { value: "all", label: "All" },
];

function isStatus(value: string | undefined): value is FeedbackStatus {
  return value === "new" ||
    value === "reviewed" ||
    value === "resolved" ||
    value === "dismissed" ||
    value === "proposed";
}

export default async function AdminFeedbackList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireSuperAdmin();
  const { status: statusParam } = await searchParams;
  const counts = await getFeedbackStatusCounts();
  // Default to `new` rather than `all` so the page surfaces work to do
  // first. Operators can flip to `all` via the chips.
  const activeStatus: FeedbackStatus | "all" = isStatus(statusParam)
    ? statusParam
    : statusParam === "all"
      ? "all"
      : "new";

  const rows = await listFeedback(
    activeStatus === "all" ? {} : { status: activeStatus }
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Feedback"
        description="User-reported bad transcriptions. Triage to feed polish-fixtures.ts and the vocabulary suggestions list."
      />

      {/* Filter chips. Each chip preserves its own count so the
          operator can see where the queue volume is. */}
      <nav className="mb-6 flex flex-wrap items-center gap-2" aria-label="Status filter">
        {STATUSES.map((s) => {
          const active = activeStatus === s.value;
          const count =
            s.value === "all" ? counts.total : counts[s.value as FeedbackStatus];
          return (
            <Link
              key={s.value}
              href={
                s.value === "new"
                  ? "/admin/feedback"
                  : `/admin/feedback?status=${s.value}`
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-plum bg-plum text-cream"
                  : "border-border bg-background text-muted-foreground hover:border-plum/40 hover:text-plum"
              )}
            >
              <span>{s.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  active ? "bg-cream/20 text-cream" : "bg-muted text-foreground/70"
                )}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No feedback in the {activeStatus === "all" ? "system" : `${activeStatus} bucket`} yet.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
          <table className="w-full text-sm min-w-[960px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
                <th className="px-5 py-3 font-medium">Reported</th>
                <th className="px-5 py-3 font-medium">User · Org</th>
                <th className="px-5 py-3 font-medium">Polished → Expected</th>
                <th className="px-5 py-3 font-medium">Kind</th>
                <th className="px-5 py-3 font-medium text-center" aria-label="Audio">
                  <Mic className="inline h-3.5 w-3.5" />
                </th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/40 last:border-0 hover:bg-muted/30"
                >
                  <td className="px-5 py-3 align-top">
                    <Link href={`/admin/feedback/${r.id}`} className="block">
                      <p className="text-foreground font-mono tabular-nums text-xs">
                        {r.createdAt.toLocaleString()}
                      </p>
                    </Link>
                  </td>
                  <td className="px-5 py-3 align-top">
                    <p className="text-foreground">{r.userEmail}</p>
                    <p className="text-xs text-muted-foreground">{r.orgName}</p>
                  </td>
                  <td className="px-5 py-3 align-top max-w-md">
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      <span className="font-mono">{truncate(r.polishedText)}</span>
                    </p>
                    <p className="text-foreground line-clamp-2">
                      → {truncate(r.expectedText)}
                    </p>
                  </td>
                  <td className="px-5 py-3 align-top text-xs text-muted-foreground">
                    {r.failureKind ?? "—"}
                  </td>
                  <td className="px-5 py-3 align-top text-center">
                    {r.hasAudio ? (
                      <Mic className="inline h-4 w-4 text-plum" />
                    ) : (
                      <span className="text-muted-foreground/50 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 align-top">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-5 py-3 align-top text-right">
                    <Link
                      href={`/admin/feedback/${r.id}`}
                      className="inline-flex items-center gap-1 text-xs text-plum hover:underline"
                    >
                      Open <ArrowRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const palette: Record<FeedbackStatus, string> = {
    new: "bg-peach/20 text-peach-deep",
    reviewed: "bg-mustard/20 text-mustard",
    resolved: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400",
    dismissed: "bg-muted text-muted-foreground",
    proposed: "bg-plum/15 text-plum",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
        palette[status]
      )}
    >
      {status === "new" && <FlagIcon className="h-3 w-3" />}
      {status}
    </span>
  );
}
