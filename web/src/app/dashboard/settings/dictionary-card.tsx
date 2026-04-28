// Dictionary editor for the Settings page. Mirrors the Mac app's
// Vocabulary tab: a list of (from, to) corrections plus a row to add new
// ones. Each entry can flip "proper noun" — that flag biases the
// transcription engine's keyterm boost in addition to the post-transcript
// find/replace pass that every entry contributes to.
//
// Source of truth is `vocabulary_entries`. Server actions live alongside
// the rest of the settings actions so the policy (ownership scope, soft
// delete, unique-constraint handling) is in one place.
//
// Edit UX: From/To are inline text inputs that save on blur when their
// value actually changes. Proper-noun is a Switch that saves on every
// flip. Delete is a single click — the row tombstones immediately and
// disappears from the list.

"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addVocabEntry,
  deleteVocabEntry,
  updateVocabEntry,
  type ActionResult,
} from "./actions";

export interface VocabEntry {
  id: string;
  fromText: string;
  toText: string;
  count: number;
  isProperNoun: boolean;
}

export function DictionaryCard({ entries }: { entries: VocabEntry[] }) {
  return (
    <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
      <h3 className="text-lg font-semibold tracking-tight">Dictionary</h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
        Corrections apply two ways per transcription: proper-noun entries
        bias the transcription engine when it supports keyterm boosts (so
        the mistake is less likely to happen in the first place), and
        every entry runs as a post-transcription find/replace so any
        remaining miss still gets fixed in the final text. Edits sync to
        the Mac app on next launch.
      </p>

      <div className="mt-6 rounded-xl border border-border/60 overflow-hidden">
        <Header />
        <ul className="divide-y divide-border/60">
          {entries.length === 0 && <EmptyState />}
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </ul>
        <AddRow />
      </div>
    </section>
  );
}

// ---- table parts ---------------------------------------------------------

function Header() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_110px_44px] items-center gap-3 bg-muted/30 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <span>From (misheard)</span>
      <span>To (correct)</span>
      <span className="text-right">Count</span>
      <span>Proper noun</span>
      <span className="sr-only">Delete</span>
    </div>
  );
}

function EmptyState() {
  return (
    <li className="px-4 py-8 text-center text-sm text-muted-foreground">
      No corrections yet. Add one below — typically a name, an acronym, or
      a word the transcription regularly mishears.
    </li>
  );
}

function EntryRow({ entry }: { entry: VocabEntry }) {
  // Mirror the server-known values in local state so optimistic edits
  // can roll back on conflict (e.g. uniqueness collision).
  const [from, setFrom] = useState(entry.fromText);
  const [to, setTo] = useState(entry.toText);
  const [isProperNoun, setIsProperNoun] = useState(entry.isProperNoun);

  // If the parent prop changes (revalidatePath after a save) re-sync so
  // we don't show stale local copies.
  useEffect(() => {
    setFrom(entry.fromText);
    setTo(entry.toText);
    setIsProperNoun(entry.isProperNoun);
  }, [entry.fromText, entry.toText, entry.isProperNoun]);

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function persist(nextFrom: string, nextTo: string, nextIsPN: boolean) {
    const fd = new FormData();
    fd.set("id", entry.id);
    fd.set("from", nextFrom);
    fd.set("to", nextTo);
    fd.set("isProperNoun", nextIsPN ? "on" : "off");
    setError(null);
    startTransition(async () => {
      const r = await updateVocabEntry(fd);
      if (!r.ok) {
        setError(r.error);
        // Roll back local state to the last server-confirmed values.
        setFrom(entry.fromText);
        setTo(entry.toText);
        setIsProperNoun(entry.isProperNoun);
      }
    });
  }

  function handleFromBlur() {
    const trimmed = from.trim();
    if (trimmed === entry.fromText) return;
    if (!trimmed) {
      setFrom(entry.fromText); // empty is invalid; revert silently
      return;
    }
    setFrom(trimmed);
    persist(trimmed, to.trim() || entry.toText, isProperNoun);
  }

  function handleToBlur() {
    const trimmed = to.trim();
    if (trimmed === entry.toText) return;
    if (!trimmed) {
      setTo(entry.toText);
      return;
    }
    setTo(trimmed);
    persist(from.trim() || entry.fromText, trimmed, isProperNoun);
  }

  function handlePNToggle(next: boolean) {
    if (next === isProperNoun) return;
    setIsProperNoun(next);
    persist(from.trim() || entry.fromText, to.trim() || entry.toText, next);
  }

  function handleDelete() {
    const fd = new FormData();
    fd.set("id", entry.id);
    setError(null);
    startTransition(async () => {
      const r = await deleteVocabEntry(fd);
      if (!r.ok) setError(r.error);
    });
  }

  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_110px_44px] items-center gap-3 px-4 py-2",
        pending && "opacity-70"
      )}
    >
      <CellInput
        value={from}
        onChange={setFrom}
        onBlur={handleFromBlur}
        ariaLabel="From"
      />
      <CellInput
        value={to}
        onChange={setTo}
        onBlur={handleToBlur}
        ariaLabel="To"
      />
      <span className="text-right text-sm tabular-nums text-muted-foreground">
        {entry.count}
      </span>
      <Switch
        checked={isProperNoun}
        onCheckedChange={handlePNToggle}
        aria-label="Proper noun"
        disabled={pending}
      />
      <button
        type="button"
        onClick={handleDelete}
        disabled={pending}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        aria-label={`Delete correction ${entry.fromText} → ${entry.toText}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {error && (
        <p className="col-span-5 text-xs text-destructive" role="status">
          {error}
        </p>
      )}
    </li>
  );
}

function CellInput({
  value,
  onChange,
  onBlur,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
      autoComplete="off"
      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm outline-none hover:border-border focus:border-ring focus:bg-background"
    />
  );
}

// ---- add row -------------------------------------------------------------

function AddRow() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [isProperNoun, setIsProperNoun] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const canSubmit = useMemo(
    () => from.trim().length > 0 && to.trim().length > 0,
    [from, to]
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const fd = new FormData();
    fd.set("from", from.trim());
    fd.set("to", to.trim());
    fd.set("isProperNoun", isProperNoun ? "on" : "off");
    setResult(null);
    startTransition(async () => {
      const r = await addVocabEntry(fd);
      setResult(r);
      if (r.ok) {
        setFrom("");
        setTo("");
        setIsProperNoun(false);
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_110px_44px] items-center gap-3 border-t border-border/60 bg-muted/20 px-4 py-3"
    >
      <input
        type="text"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        placeholder="From (misheard)"
        autoComplete="off"
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        type="text"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="To (correct)"
        autoComplete="off"
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <span aria-hidden />
      <Switch
        checked={isProperNoun}
        onCheckedChange={setIsProperNoun}
        aria-label="Proper noun"
        disabled={pending}
      />
      <Button
        type="submit"
        size="sm"
        disabled={!canSubmit || pending}
        className="justify-self-end"
      >
        {pending ? "…" : "Add"}
      </Button>
      {result && !result.ok && (
        <p className="col-span-5 text-xs text-destructive" role="status">
          {result.error}
        </p>
      )}
    </form>
  );
}
