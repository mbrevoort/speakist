"use client";

// Client UI for /admin/tokens. Two-part layout:
//   * Create form (label + scope checkboxes) → POST /api/admin/tokens
//   * One-shot plaintext reveal that persists until dismissed
//   * Token table with Revoke buttons → DELETE /api/admin/tokens/[id]
//
// All fetches go through the existing super-admin REST surface; this
// component owns no DB state. router.refresh() pulls the latest list
// from the server after mutations so revokes show up immediately.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Trash2, Triangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ServiceScope } from "@/lib/service-tokens";
import type { SerializedToken } from "./page";

const SCOPE_DESCRIPTIONS: Record<ServiceScope, string> = {
  "feedback:read": "List + fetch feedback rows + download audio",
  "feedback:triage": "Update status / resolution + delete rows",
};

interface Props {
  initialTokens: SerializedToken[];
  availableScopes: ServiceScope[];
}

export function TokenManager({ initialTokens, availableScopes }: Props) {
  const router = useRouter();
  const [revealed, setRevealed] = useState<{
    plaintext: string;
    label: string;
  } | null>(null);

  return (
    <div className="space-y-8">
      <CreateCard
        availableScopes={availableScopes}
        onCreated={(plaintext, label) => {
          setRevealed({ plaintext, label });
          router.refresh();
        }}
      />

      {revealed && (
        <RevealCard
          plaintext={revealed.plaintext}
          label={revealed.label}
          onDismiss={() => setRevealed(null)}
        />
      )}

      <TokenTable
        tokens={initialTokens}
        onRevoke={() => router.refresh()}
      />
    </div>
  );
}

// ---- create card ---------------------------------------------------------

function CreateCard({
  availableScopes,
  onCreated,
}: {
  availableScopes: ServiceScope[];
  onCreated: (plaintext: string, label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ServiceScope[]>(availableScopes); // default: all on
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleScope(s: ServiceScope) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }
    if (scopes.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/admin/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), scopes }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { id: string; plaintext: string };
      onCreated(data.plaintext, label.trim());
      setLabel("");
      setScopes(availableScopes); // reset to default
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border/70 bg-background p-5 sm:p-6">
      <h2 className="text-base font-semibold flex items-center gap-2">
        <KeyRound className="h-4 w-4" /> Create token
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The plaintext is shown exactly once after submit. Pick scopes
        narrowly — you can mint a read-only token for an agent that
        only needs to pull samples, separate from a triage-capable
        token if anything else needs to mark resolutions.
      </p>

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="token-label"
            className="block text-xs uppercase tracking-wide text-muted-foreground mb-1"
          >
            Label
          </label>
          <input
            id="token-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. polish-fixture-proposer (mike-laptop)"
            maxLength={80}
            className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <fieldset>
          <legend className="block text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Scopes
          </legend>
          <div className="space-y-2">
            {availableScopes.map((s) => (
              <label
                key={s}
                className="flex items-start gap-2 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <code className="font-mono text-xs">{s}</code>
                  <span className="ml-2 text-muted-foreground">
                    {SCOPE_DESCRIPTIONS[s]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-plum text-cream px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create token"}
        </button>
      </form>
    </section>
  );
}

// ---- one-shot plaintext reveal ------------------------------------------

function RevealCard({
  plaintext,
  label,
  onDismiss,
}: {
  plaintext: string;
  label: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Older browsers fall through; no fallback needed for a
      // super-admin context.
    }
  }
  return (
    <section className="rounded-2xl border border-mustard bg-mustard/10 p-5 sm:p-6">
      <h2 className="text-base font-semibold flex items-center gap-2">
        <Triangle className="h-4 w-4 fill-mustard text-mustard" /> Copy this now
      </h2>
      <p className="mt-1 text-sm">
        This is the only time we&rsquo;ll show the plaintext for{" "}
        <strong>{label}</strong>. Once you dismiss this panel, the
        value is unrecoverable — you&rsquo;ll have to mint a
        replacement.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 break-all rounded-lg bg-background border border-border/70 px-3 py-2 text-xs font-mono">
          {plaintext}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-xl border border-input px-3 py-2 text-xs flex items-center gap-1.5"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-3">
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          I&rsquo;ve copied it — dismiss
        </button>
      </div>
    </section>
  );
}

// ---- token table ---------------------------------------------------------

function TokenTable({
  tokens,
  onRevoke,
}: {
  tokens: SerializedToken[];
  onRevoke: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string, label: string) {
    if (!window.confirm(`Revoke "${label}"? Agents using this token will start getting 401s.`)) {
      return;
    }
    setPendingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(`Couldn't revoke (HTTP ${res.status}).`);
        return;
      }
      onRevoke();
    } finally {
      setPendingId(null);
    }
  }

  if (tokens.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-background p-10 text-center">
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-background overflow-x-auto">
      {error && (
        <p className="px-5 pt-3 text-sm text-destructive">{error}</p>
      )}
      <table className="w-full text-sm min-w-[720px]">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
            <th className="px-5 py-3 font-medium">Label · Scopes</th>
            <th className="px-5 py-3 font-medium">Created</th>
            <th className="px-5 py-3 font-medium">Last used</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3" aria-label="Revoke" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => {
            const revoked = t.revokedAt !== null;
            return (
              <tr
                key={t.id}
                className={cn(
                  "border-b border-border/40 last:border-0",
                  revoked && "opacity-60"
                )}
              >
                <td className="px-5 py-3 align-top">
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {t.scopes.join(" · ")}
                  </p>
                  {t.createdByEmail && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      by {t.createdByEmail}
                    </p>
                  )}
                </td>
                <td className="px-5 py-3 align-top text-xs text-muted-foreground tabular-nums">
                  {new Date(t.createdAt).toLocaleString()}
                </td>
                <td className="px-5 py-3 align-top text-xs text-muted-foreground tabular-nums">
                  {t.lastUsedAt
                    ? new Date(t.lastUsedAt).toLocaleString()
                    : "—"}
                </td>
                <td className="px-5 py-3 align-top">
                  {revoked ? (
                    <span className="text-xs text-muted-foreground">
                      Revoked{" "}
                      {t.revokedAt
                        ? new Date(t.revokedAt).toLocaleDateString()
                        : ""}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-sage">
                      Active
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 align-top text-right">
                  {!revoked && (
                    <button
                      type="button"
                      onClick={() => revoke(t.id, t.label)}
                      disabled={pendingId === t.id}
                      className="inline-flex items-center gap-1 text-xs text-destructive hover:underline disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      {pendingId === t.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
