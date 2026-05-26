"use client";

// Client UI for /admin/polish-prompts.
//
// Two cards per mode (intuitive + prescriptive). Each card contains:
//
//   * Status row: active version number, source badge, bench score
//     (with delta-vs-previous when known), created_at.
//   * Body preview + "View full body" expander.
//   * "Edit new version" toggle that reveals a textarea pre-filled
//     with the active body (or the baked-in baseline if no active
//     row exists). Submitting it creates a new admin version.
//   * Version history table — newest first, with View body / Roll
//     back per row.
//
// Body modal is intentionally simple — `<dialog>` with a close
// button. No diff-view yet (deferred to a future PR if it earns
// its complexity).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  History,
  Pencil,
  RotateCcw,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PolishPromptMode,
  PolishPromptSource,
} from "@/lib/polish-prompts";
import {
  mirrorActivePolishPromptToDev,
  rollbackPolishPromptVersion,
  saveNewPolishPromptVersion,
  type ActionResult,
} from "./actions";

/** Plain-JSON shape that crosses the server → client boundary. */
export interface SerializedVersion {
  id: string;
  mode: PolishPromptMode;
  version: number;
  body: string;
  notes: string | null;
  source: PolishPromptSource;
  isActive: boolean;
  rolledBackFromVersionId: string | null;
  benchScore: number | null;
  benchResults: unknown | null;
  createdAt: string;
  createdByUserId: string | null;
  createdByTokenId: string | null;
}

interface ModeBundle {
  mode: PolishPromptMode;
  active: SerializedVersion | null;
  history: SerializedVersion[];
  bakedIn: string;
}

interface Props {
  bundles: ModeBundle[];
  /** True when DEV_MIRROR_BACKEND_URL + DEV_MIRROR_TOKEN are both
   *  set on this Worker — i.e. prod after the one-time setup. False
   *  on dev (which never has the secret) and on prod before setup. */
  mirrorAvailable: boolean;
}

export function PromptManager({ bundles, mirrorAvailable }: Props) {
  return (
    <div className="space-y-10">
      {bundles.map((b) => (
        <ModeCard
          key={b.mode}
          bundle={b}
          mirrorAvailable={mirrorAvailable}
        />
      ))}
    </div>
  );
}

// ---- per-mode card --------------------------------------------------------

function ModeCard({
  bundle,
  mirrorAvailable,
}: {
  bundle: ModeBundle;
  mirrorAvailable: boolean;
}) {
  const { mode, active, history, bakedIn } = bundle;
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<SerializedVersion | null>(null);
  const [mirrorResult, setMirrorResult] = useState<ActionResult | null>(null);
  const [mirrorPending, startMirrorTransition] = useTransition();

  function onMirror() {
    if (!active) return;
    const confirmed = window.confirm(
      `Mirror ${mode} v${active.version} to dev? This creates a new version on dev with source='mirror'. Dev's active prompt will change.`
    );
    if (!confirmed) return;
    const fd = new FormData();
    fd.set("mode", mode);
    setMirrorResult(null);
    startMirrorTransition(async () => {
      const r = await mirrorActivePolishPromptToDev(fd);
      setMirrorResult(r);
    });
  }

  // Bench-score delta — how this version compares to the previous
  // *active* one. We walk `history` (newest first) for the most
  // recent non-active row to compute it. Surfaced to the operator
  // as a quick "did the loop move?" indicator.
  const prevActive = history.find(
    (h) => !h.isActive && h.benchScore !== null
  );
  const benchDelta =
    active?.benchScore != null && prevActive?.benchScore != null
      ? active.benchScore - prevActive.benchScore
      : null;

  return (
    <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold tracking-tight capitalize">
            {mode}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {active
              ? `Currently serving v${active.version}.`
              : "No version yet — /api/transcribe is serving the baked-in baseline."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {editing ? "Cancel" : "New version"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <History className="h-3.5 w-3.5" />
            History ({history.length})
            {historyOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
          {/* Mirror button: rendered only on envs configured for it
              (prod, after one-time setup). active === null also
              disables it because there's nothing to mirror — admins
              shouldn't be able to push "no version" to dev. */}
          {mirrorAvailable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onMirror}
              disabled={!active || mirrorPending}
              title={
                !active
                  ? "No active version on this env yet — nothing to mirror."
                  : "Push this env's active prompt to dev as a new version."
              }
            >
              <Share2 className="h-3.5 w-3.5" />
              {mirrorPending ? "Mirroring…" : "Mirror → dev"}
            </Button>
          )}
        </div>
      </header>

      {mirrorResult && (
        <p
          className={cn(
            "mt-3 text-sm",
            mirrorResult.ok ? "text-sage" : "text-destructive"
          )}
          role="status"
        >
          {mirrorResult.ok
            ? mirrorResult.message ?? "Mirrored."
            : mirrorResult.error}
        </p>
      )}

      {active && (
        <ActiveSummary
          version={active}
          benchDelta={benchDelta}
          onViewBody={() => setViewing(active)}
        />
      )}

      {editing && (
        <NewVersionForm
          mode={mode}
          startingBody={active?.body ?? bakedIn}
          onDone={() => setEditing(false)}
        />
      )}

      {historyOpen && (
        <VersionTable
          rows={history}
          activeId={active?.id ?? null}
          onView={(v) => setViewing(v)}
          mode={mode}
        />
      )}

      {viewing && (
        <BodyDialog
          version={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}

// ---- active summary -------------------------------------------------------

function ActiveSummary({
  version,
  benchDelta,
  onViewBody,
}: {
  version: SerializedVersion;
  benchDelta: number | null;
  onViewBody: () => void;
}) {
  return (
    <div className="mt-5 rounded-xl border border-border/70 bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">v{version.version}</span>
        <SourceBadge source={version.source} />
        <BenchBadge score={version.benchScore} delta={benchDelta} />
        <span className="text-xs text-muted-foreground tabular-nums ml-auto">
          {new Date(version.createdAt).toLocaleString()}
        </span>
      </div>
      {version.notes && (
        <p className="mt-2 text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
          {version.notes}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <pre className="flex-1 min-w-0 text-xs font-mono text-muted-foreground line-clamp-3 whitespace-pre-wrap break-words">
          {version.body.slice(0, 320)}
          {version.body.length > 320 ? "…" : ""}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onViewBody}
        >
          View full
        </Button>
      </div>
    </div>
  );
}

// ---- new-version form -----------------------------------------------------

function NewVersionForm({
  mode,
  startingBody,
  onDone,
}: {
  mode: PolishPromptMode;
  startingBody: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [body, setBody] = useState(startingBody);
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("body", body);
    if (notes.trim()) fd.set("notes", notes.trim());
    startTransition(async () => {
      const r = await saveNewPolishPromptVersion(fd);
      setResult(r);
      if (r.ok) {
        router.refresh();
        onDone();
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3">
      <div>
        <label
          htmlFor={`body-${mode}`}
          className="block text-xs uppercase tracking-wide text-muted-foreground mb-1"
        >
          Body
        </label>
        <textarea
          id={`body-${mode}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={18}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring resize-y"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {body.length} chars
        </p>
      </div>
      <div>
        <label
          htmlFor={`notes-${mode}`}
          className="block text-xs uppercase tracking-wide text-muted-foreground mb-1"
        >
          Notes (why this version exists)
        </label>
        <textarea
          id={`notes-${mode}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. Tightened the trap-question framing after #142 / #156."
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save as new version"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={pending}
        >
          Cancel
        </Button>
        {result && <InlineResult result={result} />}
      </div>
    </form>
  );
}

// ---- version table --------------------------------------------------------

function VersionTable({
  rows,
  activeId,
  onView,
  mode,
}: {
  rows: SerializedVersion[];
  activeId: string | null;
  onView: (v: SerializedVersion) => void;
  mode: PolishPromptMode;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRollback(target: SerializedVersion) {
    const confirmed = window.confirm(
      `Roll back ${mode} to v${target.version}? This creates a new version with v${target.version}'s body. ` +
        `The current active version will move to the history.`
    );
    if (!confirmed) return;
    const note = window.prompt(
      "Optional note (e.g. why are we rolling back?). Leave blank to skip:",
      ""
    );
    if (note === null) return; // cancel
    setError(null);
    setPendingId(target.id);
    try {
      const fd = new FormData();
      fd.set("mode", mode);
      fd.set("targetVersionId", target.id);
      if (note.trim()) fd.set("notes", note.trim());
      const r = await rollbackPolishPromptVersion(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="mt-5 rounded-xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
        No versions yet.
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-border/70 overflow-x-auto">
      {error && (
        <p className="px-4 pt-3 text-sm text-destructive">{error}</p>
      )}
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/70">
            <th className="px-4 py-2.5 font-medium">Version</th>
            <th className="px-4 py-2.5 font-medium">Source</th>
            <th className="px-4 py-2.5 font-medium">Bench</th>
            <th className="px-4 py-2.5 font-medium">Created</th>
            <th className="px-4 py-2.5 font-medium">Notes</th>
            <th className="px-4 py-2.5" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const isActive = v.id === activeId;
            return (
              <tr
                key={v.id}
                className="border-b border-border/40 last:border-0"
              >
                <td className="px-4 py-2.5 align-top">
                  <span className="font-semibold">v{v.version}</span>
                  {isActive && (
                    <span className="ml-2 text-xs font-semibold text-sage">
                      active
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top">
                  <SourceBadge source={v.source} />
                </td>
                <td className="px-4 py-2.5 align-top tabular-nums text-xs">
                  {v.benchScore != null
                    ? v.benchScore.toFixed(2)
                    : "—"}
                </td>
                <td className="px-4 py-2.5 align-top text-xs text-muted-foreground tabular-nums">
                  {new Date(v.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 align-top text-xs text-muted-foreground max-w-[280px]">
                  <span className="line-clamp-2 whitespace-pre-wrap">
                    {v.notes ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5 align-top text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onView(v)}
                    className="text-xs underline-offset-2 hover:underline mr-3"
                  >
                    View
                  </button>
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => onRollback(v)}
                      disabled={pendingId === v.id}
                      className="inline-flex items-center gap-1 text-xs text-plum hover:underline disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {pendingId === v.id ? "…" : "Roll back"}
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

// ---- body modal -----------------------------------------------------------

function BodyDialog({
  version,
  onClose,
}: {
  version: SerializedVersion;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] rounded-2xl border border-border/70 bg-background shadow-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold capitalize">
              {version.mode} v{version.version}
            </span>
            <SourceBadge source={version.source} />
            <BenchBadge score={version.benchScore} delta={null} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-input px-3 py-1.5 text-xs hover:bg-muted"
          >
            Close
          </button>
        </header>
        {version.notes && (
          <p className="px-5 pt-3 text-sm text-muted-foreground whitespace-pre-wrap">
            {version.notes}
          </p>
        )}
        <pre className="flex-1 overflow-auto px-5 py-4 text-xs font-mono whitespace-pre-wrap break-words">
          {version.body}
        </pre>
      </div>
    </div>
  );
}

// ---- badges + inline result ----------------------------------------------

function SourceBadge({ source }: { source: PolishPromptSource }) {
  const tone: Record<PolishPromptSource, string> = {
    seed: "bg-muted text-muted-foreground",
    admin: "bg-plum/10 text-plum",
    agent: "bg-sage/10 text-sage",
    rollback: "bg-mustard/15 text-mustard-foreground",
    mirror: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tone[source]
      )}
    >
      {source}
    </span>
  );
}

function BenchBadge({
  score,
  delta,
}: {
  score: number | null;
  delta: number | null;
}) {
  if (score == null) {
    return (
      <span className="text-xs text-muted-foreground">no bench</span>
    );
  }
  const deltaSign = delta == null ? null : delta >= 0 ? "+" : "";
  const deltaText =
    delta == null ? "" : ` (${deltaSign}${delta.toFixed(2)})`;
  const tone =
    delta == null
      ? "text-muted-foreground"
      : delta >= 0
        ? "text-sage"
        : "text-destructive";
  return (
    <span className={cn("text-xs tabular-nums font-medium", tone)}>
      bench {score.toFixed(2)}
      {deltaText}
    </span>
  );
}

function InlineResult({ result }: { result: ActionResult }) {
  return (
    <span
      className={cn(
        "text-xs",
        result.ok ? "text-sage" : "text-destructive"
      )}
    >
      {result.ok ? result.message ?? "Saved." : result.error}
    </span>
  );
}
