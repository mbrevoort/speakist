// Renders a date in the *browser's* timezone and locale. The dashboard
// is server-rendered, so calling `Date.toLocaleString()` directly in an
// RSC formats with the Worker's locale (UTC), not the user's — this
// component fixes that without giving up SSR.
//
// SSR strategy: we render a UTC-pinned formatted string on first render
// (both server and client produce the same text, so no hydration
// mismatch) and then swap to the browser's locale in a `useEffect`.
// During that brief window the user may see UTC text; that's acceptable
// for a static dashboard table — the text settles to local time as soon
// as React hydrates.
//
// Both `<LocalTime>` and `<Greeting>` live here because they share the
// same SSR-vs-client-locale concern.

"use client";

import { useEffect, useMemo, useState } from "react";

interface Props {
  /** ISO string, Date, or epoch milliseconds. */
  value: string | Date | number;
  /** "date" — date only. "datetime" — date + time. Default: "datetime". */
  mode?: "date" | "datetime";
  className?: string;
}

export function LocalTime({ value, mode = "datetime", className }: Props) {
  // Memoize on the underlying instant so a fresh Date object on every
  // parent render doesn't churn the effect below.
  const ms = useMemo(() => {
    const d = value instanceof Date ? value : new Date(value);
    return d.getTime();
  }, [value]);

  // Initial render uses UTC + en-US so server and client agree on the
  // exact bytes — avoids the hydration warning that would fire if we
  // called `toLocaleString()` directly (server returns UTC, client
  // returns local).
  const initial =
    mode === "date"
      ? new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC" })
      : `${new Date(ms).toLocaleString("en-US", { timeZone: "UTC" })} UTC`;

  const [text, setText] = useState(initial);

  useEffect(() => {
    const d = new Date(ms);
    setText(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
  }, [ms, mode]);

  return (
    <time dateTime={new Date(ms).toISOString()} className={className}>
      {text}
    </time>
  );
}

/** Time-of-day greeting computed from the *browser's* clock, not the
 *  Worker's. Falls back to "Hello" during SSR so server and client
 *  agree on the initial markup. */
export function Greeting() {
  const [text, setText] = useState("Hello");
  useEffect(() => {
    const h = new Date().getHours();
    if (h < 5) setText("Late night");
    else if (h < 12) setText("Good morning");
    else if (h < 18) setText("Good afternoon");
    else setText("Good evening");
  }, []);
  return <>{text}</>;
}
