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

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-end gap-1 h-40">
        {points.map((p) => {
          const v = metric === "words" ? p.words : p.costMillicents;
          const h = Math.max(2, (v / max) * 100); // percent; minimum 2% so zero bars are visible
          return (
            <div
              key={p.day}
              className="flex-1 group relative flex items-end"
              title={`${dateFmt.format(new Date(p.day))}: ${
                metric === "words"
                  ? `${p.words.toLocaleString()} words`
                  : formatDollars(p.costMillicents, { precision: 4 })
              }`}
            >
              <div
                className={cn(
                  "w-full rounded-t-sm transition-colors",
                  v === 0 ? "bg-border/40" : "bg-peach group-hover:bg-peach-deep"
                )}
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{dateFmt.format(new Date(points[0]?.day ?? Date.now()))}</span>
        <span>Today</span>
      </div>
      {total === 0 && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No usage yet. Transcriptions will appear here once your team starts
          dictating.
        </p>
      )}
    </div>
  );
}
