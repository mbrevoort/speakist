"use client";

import { useEffect, useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  sendSlackWebhookTest,
  setAllowPublicOrgCreation,
  setPolishPrompt,
  setSlackWebhookEnabled,
  setSlackWebhookUrl,
  setSystemDeepgramKey,
  setSystemGroqKey,
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

interface SystemProviderKeyProps {
  /** Human-readable provider name shown in copy ("Deepgram", "Groq"). */
  providerLabel: string;
  /** Whether a system key is currently set on this provider. */
  hasKey: boolean;
  /** Server action that persists the key (or clears it when "" is passed). */
  saveAction: (formData: FormData) => Promise<ActionResult>;
  /** When-not-set explanation rendered above the action row. Provider-
   *  specific because the consequence of "no key" differs per provider:
   *  Groq is the default for new orgs, Deepgram is opt-in via super admin. */
  emptyStateExplainer: string;
  /** Confirm-prompt text shown in window.confirm() before clearing. */
  clearConfirmPrompt: string;
  /** Placeholder text inside the password input. */
  placeholder: string;
}

/**
 * Generic "system-wide encrypted API key" widget. The DeepGram and Groq
 * cards are thin wrappers passing provider-specific copy + the matching
 * server action. Single component avoids the two-cards-go-out-of-sync
 * failure mode where one provider's UX gets a tweak the other doesn't.
 */
function SystemProviderKey({
  providerLabel,
  hasKey,
  saveAction,
  emptyStateExplainer,
  clearConfirmPrompt,
  placeholder,
}: SystemProviderKeyProps) {
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
              ? `Stored encrypted. We can't show it back; to rotate, paste a fresh one. Orgs without their own ${providerLabel} override use this key.`
              : emptyStateExplainer}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
            {hasKey ? "Rotate key" : "Set key"}
          </Button>
          {hasKey && (
            <form
              action={async (fd) => {
                if (!window.confirm(clearConfirmPrompt)) {
                  return;
                }
                fd.set("key", "");
                startTransition(async () => setResult(await saveAction(fd)));
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
          const r = await saveAction(fd);
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
        placeholder={placeholder}
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

export function SystemDeepgramKey({ hasKey }: { hasKey: boolean }) {
  return (
    <SystemProviderKey
      providerLabel="Deepgram"
      hasKey={hasKey}
      saveAction={setSystemDeepgramKey}
      emptyStateExplainer="Without a Deepgram system key, only workspaces with their own per-workspace override can use Deepgram models. Default-routed workspaces use Groq, so this is optional unless a super admin specifically points a workspace at Deepgram via the allowed-models list."
      clearConfirmPrompt="Clear the system Deepgram key? Any workspace routed to Deepgram without its own override will fail to transcribe."
      placeholder="Deepgram API key"
    />
  );
}

export function SystemGroqKey({ hasKey }: { hasKey: boolean }) {
  return (
    <SystemProviderKey
      providerLabel="Groq"
      hasKey={hasKey}
      saveAction={setSystemGroqKey}
      emptyStateExplainer="Without a Groq system key, every workspace without its own Groq override will fail to transcribe. Groq is the default provider for new workspaces, so set this before inviting production users."
      clearConfirmPrompt="Clear the system Groq key? Default-routed workspaces (English → Groq Whisper Turbo, other languages → Groq Whisper Large) will fail to transcribe until you set it again."
      placeholder="Groq API key (gsk_...)"
    />
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
            ? "New users without a pending invitation get their own workspace plus the signup credit. Users with a pending invitation always see Accept/Decline first. Production default."
            : "New users without a pending invitation see the “awaiting invitation” screen instead of getting a workspace auto-created. Manual invites and per-workspace auto-invite domains still work."}
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

// --- polish prompt editor (super admin only) -----------------------------

/**
 * Edit the system prompt for one polish mode. Saves to
 * `app_settings.polish_<mode>_prompt`; saving an empty string clears it
 * (NULL), which falls back to the baked-in constant in
 * `lib/transcription/polish.ts`. The baked-in default is shown in a
 * read-only collapsible underneath so admins can copy/paste it as a
 * starting point or compare against their override.
 */
export function PolishPromptEditor({
  mode,
  current,
  bakedInDefault,
}: {
  mode: "intuitive" | "prescriptive";
  /** What's stored in the DB. NULL means "using baked-in". */
  current: string | null;
  bakedInDefault: string;
}) {
  // The textarea hydrates with the saved override; if there is none,
  // it starts blank to make "no override" obvious. The baked-in
  // default is shown in a read-only viewer below the editor so admins
  // can grab it as a starting point.
  const [draft, setDraft] = useState(current ?? "");
  const [savedValue, setSavedValue] = useState<string | null>(current);
  const [showBakedIn, setShowBakedIn] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Sync from server on revalidatePath. Don't stomp an in-flight edit.
  useEffect(() => {
    setSavedValue(current);
    setDraft((d) => (d === (savedValue ?? "") ? current ?? "" : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const isOverride = savedValue !== null;
  const draftIsDirty = draft !== (savedValue ?? "");

  function handleSave() {
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("prompt", draft);
    setResult(null);
    startTransition(async () => {
      const r = await setPolishPrompt(fd);
      setResult(r);
      if (r.ok) setSavedValue(draft.trim().length > 0 ? draft : null);
    });
  }

  function handleResetToDefault() {
    if (!window.confirm(`Clear the ${mode} prompt override? Polish will fall back to the baked-in default.`)) {
      return;
    }
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("prompt", "");
    setResult(null);
    startTransition(async () => {
      const r = await setPolishPrompt(fd);
      setResult(r);
      if (r.ok) {
        setSavedValue(null);
        setDraft("");
      }
    });
  }

  function handleSeedFromDefault() {
    setDraft(bakedInDefault);
  }

  return (
    <div className="space-y-4">
      <div>
        <p
          className={cn(
            "text-sm font-semibold",
            isOverride ? "text-sage" : "text-mustard"
          )}
        >
          {isOverride
            ? "Custom prompt is active"
            : "Using the baked-in default"}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
          {isOverride
            ? "Polish for this mode is using the saved override below. Clear it to revert to the baked-in default."
            : "No override saved. Polish for this mode is using the baked-in default. Edit and save below to override."}
        </p>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
        spellCheck={false}
        className={cn(
          "w-full rounded-xl border border-input bg-background px-4 py-3 text-sm font-mono leading-relaxed",
          "outline-none focus:ring-2 focus:ring-ring",
          "disabled:opacity-60"
        )}
        disabled={pending}
        placeholder="Empty = use the baked-in default below."
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={pending || !draftIsDirty}>
          {pending ? "Saving…" : "Save prompt"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleResetToDefault}
          disabled={pending || !isOverride}
        >
          <RotateCcw className="h-4 w-4" />
          Clear override
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleSeedFromDefault}
          disabled={pending}
          title="Copy the baked-in default into the editor as a starting point"
        >
          Seed from default
        </Button>
        {result && (
          <p
            className={cn(
              "text-sm",
              result.ok ? "text-sage" : "text-destructive"
            )}
            role="status"
          >
            {result.ok ? result.message : result.error}
          </p>
        )}
      </div>

      <details
        className="mt-4 rounded-lg border border-border/50 bg-muted/30"
        open={showBakedIn}
        onToggle={(e) => setShowBakedIn((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          Baked-in default
        </summary>
        <pre className="px-4 pb-4 text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground max-h-[400px] overflow-y-auto">
          {bakedInDefault}
        </pre>
      </details>
    </div>
  );
}

// --- Slack webhook card ---------------------------------------------------
//
// One destination per card. Three pieces of state:
//   * URL: encrypted-at-rest; we only know whether one is set, never the
//     value. Rotating means pasting a new one.
//   * Enabled: independent toggle so the URL stays put while paused.
//   * Test: posts a one-off message bypassing the enable flag — lets an
//     admin verify the URL before flipping the toggle on.
//
// The view/edit split mirrors SystemProviderKey above for consistency.

interface SlackWebhookCardProps {
  destination: "new_user" | "topup" | "feedback";
  title: string;
  description: string;
  hasUrl: boolean;
  enabled: boolean;
}

export function SlackWebhookCard({
  destination,
  title,
  description,
  hasUrl,
  enabled,
}: SlackWebhookCardProps) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p
          className={cn(
            "text-xs font-medium",
            !hasUrl
              ? "text-mustard"
              : enabled
                ? "text-sage"
                : "text-muted-foreground"
          )}
        >
          {!hasUrl
            ? "No URL configured"
            : enabled
              ? "Enabled"
              : "Paused"}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
        {description}
      </p>

      {mode === "view" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setResult(null);
              setMode("edit");
            }}
          >
            {hasUrl ? "Rotate URL" : "Set URL"}
          </Button>
          {hasUrl && (
            <form
              action={(fd) => {
                fd.set("destination", destination);
                fd.set("enabled", enabled ? "off" : "on");
                setResult(null);
                startTransition(async () =>
                  setResult(await setSlackWebhookEnabled(fd))
                );
              }}
            >
              <Button
                type="submit"
                size="sm"
                variant={enabled ? "outline" : "default"}
                disabled={pending}
              >
                {pending ? "Saving…" : enabled ? "Pause" : "Enable"}
              </Button>
            </form>
          )}
          {hasUrl && (
            <form
              action={(fd) => {
                fd.set("destination", destination);
                setResult(null);
                startTransition(async () =>
                  setResult(await sendSlackWebhookTest(fd))
                );
              }}
            >
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                {pending ? "Sending…" : "Send test"}
              </Button>
            </form>
          )}
          {hasUrl && (
            <form
              action={(fd) => {
                if (
                  !window.confirm(
                    "Clear this webhook URL? Notifications will stop until a new one is saved."
                  )
                ) {
                  return;
                }
                fd.set("destination", destination);
                fd.set("url", "");
                setResult(null);
                startTransition(async () =>
                  setResult(await setSlackWebhookUrl(fd))
                );
              }}
            >
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                Clear
              </Button>
            </form>
          )}
          {result && <InlineResult result={result} />}
        </div>
      ) : (
        <form
          action={(fd) => {
            fd.set("destination", destination);
            setResult(null);
            startTransition(async () => {
              const r = await setSlackWebhookUrl(fd);
              setResult(r);
              if (r.ok) setMode("view");
            });
          }}
          className="mt-4 space-y-3"
        >
          <input
            type="url"
            name="url"
            autoComplete="off"
            required
            placeholder="https://hooks.slack.com/services/T0…/B0…/…"
            className="w-full rounded-xl border border-input bg-background px-4 py-2.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save URL"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMode("view")}
              disabled={pending}
            >
              Cancel
            </Button>
            {result && <InlineResult result={result} />}
          </div>
        </form>
      )}
    </div>
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
