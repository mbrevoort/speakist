// Inline bar chart for daily usage. No chart library — just SVG rects on a
// normalized scale. For the data volumes we show (14–30 bars) this is a
// few hundred bytes and hot-reloads instantly.

import { cn, formatDollars } from "@/lib/utils";
import type { DayPoint } from "@/lib/usage";

interface Props {
  points: DayPoint[];
  /** "words" scales the bar to word_count; "cost" to cost_millicents */
  metric: "words" | "cost";
  className?: string;
}

export function UsageChart({ points, metric, className }: Props) {
  const values = points.map((p) => (metric === "words" ? p.words : p.costMillicents));
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);

  const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  // Compact day label for x-axis ticks under each bar — just the day
  // number ("20"), since the month is rarely changing in a 14-day
  // window and we want each label to fit the narrow per-bar slot.
  const dayFmt = new Intl.DateTimeFormat("en-US", { day: "numeric" });

  return (
    <div className={cn("w-full", className)}>
      {/* `pt-5` reserves space above the bars for value labels —
          without it the tallest bar's label would clip into the
          section heading above. */}
      <div className="flex items-end gap-1 h-40 pt-5">
        {points.map((p) => {
          const v = metric === "words" ? p.words : p.costMillicents;
          const h = Math.max(2, (v / max) * 100); // percent; minimum 2% so zero bars are visible
          return (
            <div
              key={p.day}
              // `h-full` is load-bearing: parent has h-40 + items-end,
              // which prevents flex children from stretching to fill
              // the cross-axis. Without h-full the wrapper collapses
              // to content-height (the bar), and the bar's `height: %`
              // resolves against itself → 0, so bars never render.
              // h-full restores an explicit 160px so the % math works.
              className="flex-1 h-full group relative flex items-end"
              title={`${dateFmt.format(new Date(p.day))}: ${
                metric === "words"
                  ? `${p.words.toLocaleString()} words`
                  : formatDollars(p.costMillicents, { precision: 4 })
              }`}
            >
              <div
                className={cn(
                  "w-full rounded-t-sm transition-colors relative",
                  v === 0 ? "bg-border/40" : "bg-peach group-hover:bg-peach-deep"
                )}
                style={{ height: `${h}%` }}
              >
                {/* Value label sits just above the colored bar. We
                    only render it for non-zero bars to avoid a row
                    of "0"s on idle days, and use absolute positioning
                    so the bar's % height calculation isn't disturbed
                    by the label taking space inside the column. */}
                {v > 0 && (
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] tabular-nums text-foreground/80 leading-none whitespace-nowrap">
                    {metric === "words"
                      ? formatCompact(p.words)
                      : formatDollars(p.costMillicents, { precision: 2 })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* X-axis ticks under each bar so the user can read which day
          a bar represents without hovering. Day-of-month only — the
          month is mostly redundant in a 14-day window. */}
      <div className="mt-2 flex gap-1">
        {points.map((p, i) => {
          const v = metric === "words" ? p.words : p.costMillicents;
          const isToday = i === points.length - 1;
          return (
            <div
              key={p.day}
              className={cn(
                "flex-1 text-center text-[10px] tabular-nums leading-none",
                isToday
                  ? "text-foreground/70 font-medium"
                  : v > 0
                    ? "text-foreground/60"
                    : "text-muted-foreground/50"
              )}
            >
              {isToday ? "today" : dayFmt.format(new Date(p.day))}
            </div>
          );
        })}
      </div>
      {total === 0 && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No usage yet. Transcriptions will appear here once your workspace
          starts dictating.
        </p>
      )}
    </div>
  );
}

/** Compact word-count formatter for chart labels.
 *  Below 1k → full number ("440"), above → "1.0k" / "12.3k". */
function formatCompact(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
