"use client";

// "Copy as fixture seeds" button. Drops a single feedback row into
// the clipboard as a JSON array entry suitable for hand-curating
// into polish-fixtures.ts. Bigger workflow (the future Phase-3
// agent) reads the same `transcription_feedback` rows directly and
// won't go through this UI.

import { useState } from "react";
import type { FixtureExportEntry } from "@/lib/feedback";

interface Props {
  seed: FixtureExportEntry;
}

export function FixtureExportButton({ seed }: Props) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    const text = JSON.stringify([seed], null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Older browsers / restricted contexts: drop into a textarea
      // fallback so the operator can manual-copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <div className="space-y-3">
      <pre className="text-xs font-mono bg-muted/50 rounded-lg p-3 overflow-x-auto max-h-64">
        {JSON.stringify([seed], null, 2)}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        className="rounded-xl border border-plum/40 text-plum hover:bg-plum/10 px-4 py-2 text-sm font-medium"
      >
        {copied ? "Copied!" : "Copy JSON"}
      </button>
    </div>
  );
}
