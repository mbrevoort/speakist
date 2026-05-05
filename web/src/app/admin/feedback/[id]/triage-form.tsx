"use client";

// Status + resolution editor for one feedback row. PATCHes
// /api/admin/feedback/[id] when the user clicks Save. Optimistic-ish
// — disables the button while in-flight and refreshes the page on
// success so the row's reviewer stamp + new status show up.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Status = "new" | "reviewed" | "resolved" | "dismissed" | "proposed";

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "new", label: "New" },
  { value: "reviewed", label: "Reviewed" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "proposed", label: "Proposed (PR open)" },
];

interface TriageFormProps {
  id: string;
  status: Status;
  resolution: string | null;
  reviewedAt: Date | null;
}

export function TriageForm({
  id,
  status: initialStatus,
  resolution: initialResolution,
  reviewedAt,
}: TriageFormProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [resolution, setResolution] = useState<string>(initialResolution ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty =
    status !== initialStatus || resolution !== (initialResolution ?? "");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      status,
      resolution: resolution.trim() === "" ? null : resolution.trim(),
    };
    const res = await fetch(`/api/admin/feedback/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `HTTP ${res.status}`);
      return;
    }
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label
          htmlFor="status"
          className="block text-xs uppercase tracking-wide text-muted-foreground mb-1"
        >
          Status
        </label>
        <select
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
          className="w-full sm:w-64 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="resolution"
          className="block text-xs uppercase tracking-wide text-muted-foreground mb-1"
        >
          Resolution note
        </label>
        <textarea
          id="resolution"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="e.g. added to polish-fixtures.ts as `proper-noun-brevoort`"
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {reviewedAt && (
        <p className="text-xs text-muted-foreground">
          Last reviewed: {reviewedAt.toLocaleString()}
        </p>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !dirty}
          className="rounded-xl bg-plum text-cream px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {!dirty && (
          <span className="text-xs text-muted-foreground">No changes</span>
        )}
      </div>
    </form>
  );
}
