// Two stacked bar charts for the admin overview: one bar per day, two
// metrics on a shared x-axis. Top chart is words transcribed, bottom is
// distinct active users (anyone with at least one usage_event that day).
//
// No chart library — same SVG-free flexbox approach as
// components/dashboard/usage-chart.tsx. For 30 bars this is well under a
// kilobyte of markup and hot-reloads instantly.

import { cn } from "@/lib/utils";
import type { PlatformDayPoint } from "@/lib/admin";

interface Props {
  points: PlatformDayPoint[];
  className?: string;
}

export function PlatformActivityChart({ points, className }: Props) {
  const totalWords = points.reduce((sum, p) => sum + p.words, 0);
  const totalEvents = points.length; // for the empty-state check
  const peakActiveUsers = points.reduce(
    (max, p) => (p.activeUsers > max ? p.activeUsers : max),
    0
  );
  // Average daily active users over days that had at least one user.
  const activeDays = points.filter((p) => p.activeUsers > 0).length;
  const avgActiveUsers =
    activeDays > 0
      ? Math.round(
          points.reduce((sum, p) => sum + p.activeUsers, 0) / activeDays
        )
      : 0;

  return (
    <div className={cn("space-y-8", className)}>
      <Series
        label="Words transcribed"
        sublabel={`${totalWords.toLocaleString()} total in ${points.length} days`}
        accent="peach"
        points={points}
        valueFor={(p) => p.words}
        formatLabel={formatCompactNumber}
        formatTooltip={(p) =>
          `${p.words.toLocaleString()} word${p.words === 1 ? "" : "s"}`
        }
      />
      <Series
        label="Active users"
        sublabel={
          peakActiveUsers === 0
            ? "No active users yet"
            : `Peak ${peakActiveUsers} · avg ${avgActiveUsers} on active days`
        }
        accent="plum"
        points={points}
        valueFor={(p) => p.activeUsers}
        formatLabel={(n) => n.toString()}
        formatTooltip={(p) =>
          `${p.activeUsers} active user${p.activeUsers === 1 ? "" : "s"}`
        }
      />
      {totalWords === 0 && totalEvents > 0 && (
        <p className="text-center text-sm text-muted-foreground">
          No platform activity yet. Charts populate once workspaces start
          transcribing.
        </p>
      )}
    </div>
  );
}

// --- one chart row --------------------------------------------------------

interface SeriesProps {
  label: string;
  sublabel: string;
  accent: "peach" | "plum";
  points: PlatformDayPoint[];
  valueFor: (p: PlatformDayPoint) => number;
  formatLabel: (n: number) => string;
  formatTooltip: (p: PlatformDayPoint) => string;
}

function Series({
  label,
  sublabel,
  accent,
  points,
  valueFor,
  formatLabel,
  formatTooltip,
}: SeriesProps) {
  const values = points.map(valueFor);
  const max = Math.max(1, ...values);

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  });
  const dayFmt = new Intl.DateTimeFormat("en-US", { day: "numeric" });

  const barClass =
    accent === "peach"
      ? "bg-peach group-hover:bg-peach-deep"
      : "bg-plum/80 group-hover:bg-plum";

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-tight">{label}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {sublabel}
        </span>
      </div>

      {/* Bars. pt-5 leaves room for the value labels above the tallest bar. */}
      <div className="flex items-end gap-1 h-32 pt-5">
        {points.map((p) => {
          const v = valueFor(p);
          const h = Math.max(2, (v / max) * 100);
          return (
            <div
              key={p.day}
              className="flex-1 h-full group relative flex items-end"
              title={`${dateFmt.format(new Date(p.day))}: ${formatTooltip(p)}`}
            >
              <div
                className={cn(
                  "w-full rounded-t-sm transition-colors relative",
                  v === 0 ? "bg-border/40" : barClass
                )}
                style={{ height: `${h}%` }}
              >
                {v > 0 && (
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] tabular-nums text-foreground/80 leading-none whitespace-nowrap">
                    {formatLabel(v)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Day-of-month ticks. Only render every Nth label when there are
       *  more than a couple weeks of bars, to avoid label collisions on
       *  narrow screens. */}
      <div className="mt-2 flex gap-1">
        {points.map((p, i) => {
          const v = valueFor(p);
          const isToday = i === points.length - 1;
          const everyN = points.length > 21 ? 3 : 1;
          const showLabel = isToday || i % everyN === 0;
          return (
            <div
              key={p.day}
              className={cn(
                "flex-1 text-center text-[10px] tabular-nums leading-none",
                isToday
                  ? "text-foreground/70 font-medium"
                  : v > 0
                    ? "text-foreground/60"
                    : "text-muted-foreground/40"
              )}
            >
              {showLabel ? (isToday ? "today" : dayFmt.format(new Date(p.day))) : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact number formatter for chart labels.
 *  Below 1k → full number ("440"); 1k–10k → "1.0k" / "9.4k"; above → "12k". */
function formatCompactNumber(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
