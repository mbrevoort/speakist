"use client";

// Super-admin "delete this feedback" button. Fires DELETE on
// /api/admin/feedback/[id] which drops the DB row and best-effort
// removes the audio object from R2. Confirms first because this is
// permanent — there's no soft-delete column. After a successful
// delete, navigates back to the list page.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

interface Props {
  id: string;
}

export function DeleteFeedbackButton({ id }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  async function onDelete() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/feedback/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        setPending(false);
        return;
      }
      // Hard nav back to the list — don't router.replace because the
      // detail page we're sitting on no longer exists, and Next.js's
      // soft refresh would render a 404 chrome before redirecting.
      router.push("/admin/feedback");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/40 text-destructive hover:bg-destructive/10 px-3 py-1.5 text-xs font-medium"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete report
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        This permanently removes the row + audio file. Cannot be undone.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="rounded-xl bg-destructive text-cream px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Yes, delete"}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={pending}
          className="rounded-xl border border-input px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}
