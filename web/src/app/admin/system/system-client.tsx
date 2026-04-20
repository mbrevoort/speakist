"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  setAllowPublicOrgCreation,
  setSystemDeepgramKey,
  type ActionResult,
} from "./actions";

// Both widgets below follow the same visual pattern:
//   ┌─────────────────────────────────────┐
//   │ Status line (sage / mustard color)  │
//   │ Description paragraph               │
//   │                                     │
//   │ [Action button(s)]  [result text]   │
//   └─────────────────────────────────────┘
//
// Keeping description and action on separate rows avoids the ugly
// three-way flex squeeze we had before where the description column
// collapsed into a one-word-wide column when the result message showed up.

export function SystemDeepgramKey({ hasKey }: { hasKey: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "edit">("view");

  if (mode === "view") {
    return (
      <div className="space-y-4">
        <div>
          <p
            className={cn(
              "text-sm font-semibold",
              hasKey ? "text-sage" : "text-mustard"
            )}
          >
            {hasKey ? "System key is set" : "No system key configured"}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
            {hasKey
              ? "Stored encrypted. We can't show it back; to rotate, paste a fresh one. Orgs without their own override use this key."
              : "Without a system key, orgs without overrides can't transcribe. Set one before inviting production users."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
            {hasKey ? "Rotate key" : "Set key"}
          </Button>
          {hasKey && (
            <form
              action={async (fd) => {
                if (!window.confirm("Clear the system Deepgram key? Transcription will break for orgs without their own override.")) {
                  return;
                }
                fd.set("key", "");
                startTransition(async () => setResult(await setSystemDeepgramKey(fd)));
              }}
            >
              <Button type="submit" variant="outline" size="sm" disabled={pending}>
                Clear
              </Button>
            </form>
          )}
          {result && <InlineResult result={result} />}
        </div>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        setResult(null);
        startTransition(async () => {
          const r = await setSystemDeepgramKey(fd);
          setResult(r);
          if (r.ok) setMode("view");
        });
      }}
      className="space-y-4"
    >
      <input
        type="password"
        name="key"
        autoComplete="off"
        required
        placeholder="Deepgram API key"
        className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setMode("view")}
          disabled={pending}
        >
          Cancel
        </Button>
        {result && <InlineResult result={result} />}
      </div>
    </form>
  );
}

// --- allow_public_org_creation toggle --------------------------------------

export function AllowPublicOrgToggle({ initiallyEnabled }: { initiallyEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => {
        const next = !enabled;
        fd.set("enabled", next ? "on" : "off");
        setResult(null);
        startTransition(async () => {
          const r = await setAllowPublicOrgCreation(fd);
          setResult(r);
          if (r.ok) setEnabled(next);
        });
      }}
      className="space-y-4"
    >
      <div>
        <p
          className={cn(
            "text-sm font-semibold",
            enabled ? "text-sage" : "text-mustard"
          )}
        >
          {enabled ? "Public signup is ON" : "Public signup is OFF — invite-only"}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
          {enabled
            ? "Anyone who signs in gets a workspace auto-created and $5 in signup credit. This is the production default."
            : "New signups without an invitation or matching auto-join domain won\u2019t get a workspace; they land on an \u201Cawaiting invitation\u201D screen. Existing orgs can still invite members and auto-join by email domain."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant={enabled ? "outline" : "default"}
          disabled={pending}
        >
          {pending ? "Saving…" : enabled ? "Turn OFF" : "Turn ON"}
        </Button>
        {result && <InlineResult result={result} />}
      </div>
    </form>
  );
}

// --- shared success/error line --------------------------------------------

function InlineResult({ result }: { result: ActionResult }) {
  return (
    <p
      className={cn(
        "text-sm",
        result.ok ? "text-sage" : "text-destructive"
      )}
      role="status"
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}
