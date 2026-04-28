// Render a Date in the user's local timezone.
//
// Server components render in the Cloudflare Worker, where `Date`'s
// locale + timezone defaults are UTC — so a server-side
// `date.toLocaleString()` produces UTC text for every visitor
// regardless of where they are. To render a real local time we have
// to format on the client, where `Intl.DateTimeFormat` picks up the
// browser's timezone for free.
//
// To avoid a hydration warning when the server's UTC text doesn't
// match the client's localized text, we render an ISO-derived
// placeholder in `<time dateTime>` on the server and swap in the
// localized string after mount. `suppressHydrationWarning` keeps
// React from yelling about the diff. The semantic markup (the
// `<time>` element with a stable `dateTime` ISO attribute) stays
// machine-readable either way.

"use client";

import { useEffect, useState } from "react";

export type LocalTimeFormat =
  | "date" // 4/28/2026
  | "datetime" // 4/28/2026, 11:42:13 AM
  | "time" // 11:42:13 AM
  | "relative"; // 5m ago / 3h ago / 2d ago / fallback to localeDate

interface LocalTimeProps {
  /** Date | ISO string | epoch ms. Anything `new Date(value)` accepts. */
  value: Date | string | number;
  /** Default `"datetime"`. */
  format?: LocalTimeFormat;
  /** Optional className for the `<time>` element. */
  className?: string;
}

export function LocalTime({
  value,
  format = "datetime",
  className,
}: LocalTimeProps) {
  // Normalize once so SSR and CSR feed the same number into the
  // formatters; otherwise an ISO string with sub-millisecond drift
  // could re-render with a different value on hydration.
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(value).getTime();

  const iso = new Date(ms).toISOString();
  const [text, setText] = useState<string>(() =>
    serverFallback(iso, format)
  );

  useEffect(() => {
    setText(formatLocal(ms, format));
  }, [ms, format]);

  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}

/**
 * Pre-hydration text. Picks shapes that match each format's expected
 * display width so the layout doesn't reflow when the client takes
 * over. Always UTC — appended "Z" / "UTC" so a reader who happens to
 * see this slice in flight isn't misled into thinking it's local.
 */
function serverFallback(iso: string, format: LocalTimeFormat): string {
  switch (format) {
    case "date":
      return iso.slice(0, 10);
    case "time":
      return `${iso.slice(11, 16)} UTC`;
    case "relative":
      return iso.slice(0, 10);
    case "datetime":
    default:
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }
}

function formatLocal(ms: number, format: LocalTimeFormat): string {
  const d = new Date(ms);
  switch (format) {
    case "date":
      return d.toLocaleDateString();
    case "time":
      return d.toLocaleTimeString();
    case "relative":
      return formatRelative(d);
    case "datetime":
    default:
      return d.toLocaleString();
  }
}

/**
 * Friendly "x ago" formatter for the "last active" column. Same shape
 * as the previous server- and client-side helpers; consolidating here
 * so they don't drift.
 *
 *   * within the last hour → "5m ago"
 *   * same day             → "3h ago"
 *   * within 30 days       → "12d ago"
 *   * older                → toLocaleDateString
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
