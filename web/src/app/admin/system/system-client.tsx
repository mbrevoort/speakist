"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  setAllowPublicOrgCreation,
  setSystemDeepgramKey,
  type ActionResult,
} from "./actions";

export function SystemDeepgramKey({ hasKey }: { hasKey: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "edit">("view");

  if (mode === "view") {
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <p
            className={cn(
              "text-sm font-semibold",
              hasKey ? "text-sage" : "text-mustard"
            )}
          >
            {hasKey ? "System key is set" : "No system key configured"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground max-w-xl">
            {hasKey
              ? "Stored encrypted. We can't show it back; to rotate, paste a fresh one below. Orgs without their own override use this key."
              : "Without a system key, orgs without overrides can't transcribe. Set one before inviting production users."}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
            {hasKey ? "Rotate" : "Set key"}
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
        </div>
        {result && (
          <p
            className={cn(
              "basis-full text-sm",
              result.ok ? "text-sage" : "text-destructive"
            )}
          >
            {result.ok ? result.message : result.error}
          </p>
        )}
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
      className="flex flex-col sm:flex-row gap-3 items-start"
    >
      <input
        type="password"
        name="key"
        autoComplete="off"
        required
        placeholder="Deepgram API key"
        className="flex-1 w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setMode("view")}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {result && (
        <p
          className={cn(
            "basis-full text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
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
      className="flex items-center justify-between gap-4"
    >
      <div className="flex-1">
        <p
          className={cn(
            "text-sm font-semibold",
            enabled ? "text-sage" : "text-mustard"
          )}
        >
          {enabled
            ? "Public signup is ON"
            : "Public signup is OFF — invite-only"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground max-w-xl">
          {enabled
            ? "Anyone who signs in gets a workspace auto-created and $5 in signup credit. This is the production default."
            : "New signups without an invitation or matching auto-join domain won't get a workspace; they land on an \u201Cawaiting invitation\u201D screen. Existing orgs can still invite members and auto-join by email domain."}
        </p>
      </div>
      <Button
        type="submit"
        variant={enabled ? "outline" : "default"}
        disabled={pending}
      >
        {pending ? "Saving…" : enabled ? "Turn OFF" : "Turn ON"}
      </Button>
      {result && (
        <p
          className={cn(
            "basis-full text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </form>
  );
}
