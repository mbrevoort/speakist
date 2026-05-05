// Client bits for the org detail page: forms for comp toggle, manual credit
// adjustment, Deepgram key override. Server page passes in the current state.

"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckSquare, Flag, Gift, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  adjustCredit,
  setAllowedModels,
  setDeepgramOverride,
  setGroqOverride,
  toggleComp,
  toggleFeedback,
  type ActionResult,
} from "./actions";

interface ProviderModel {
  providerId: string;
  model: string;
  retailPerMinuteMillicents: number;
}

interface Props {
  orgId: string;
  isComped: boolean;
  feedbackDisabled: boolean;
  hasDeepgramOverride: boolean;
  hasGroqOverride: boolean;
  allowedModels: string[];
  availableModels: ProviderModel[];
}

export function OrgAdminActions(props: Props) {
  return (
    <div className="space-y-8">
      <CompCard orgId={props.orgId} isComped={props.isComped} />
      <FeedbackCard
        orgId={props.orgId}
        feedbackDisabled={props.feedbackDisabled}
      />
      <CreditAdjustCard orgId={props.orgId} />
      <AllowedModelsCard
        orgId={props.orgId}
        allowed={props.allowedModels}
        available={props.availableModels}
      />
      <DeepgramOverrideCard
        orgId={props.orgId}
        hasOverride={props.hasDeepgramOverride}
      />
      <GroqOverrideCard
        orgId={props.orgId}
        hasOverride={props.hasGroqOverride}
      />
    </div>
  );
}

// --- feedback opt-out toggle ----------------------------------------------

function FeedbackCard({
  orgId,
  feedbackDisabled,
}: {
  orgId: string;
  feedbackDisabled: boolean;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const enabled = !feedbackDisabled;

  return (
    <Card
      title="Report bad transcription"
      description="When enabled (the default), users in this workspace can submit reports — audio + texts go to /api/feedback for quality control. Turn off to hide the button in the apps and reject submissions."
      accent="plum"
      icon={<Flag className="h-4 w-4" />}
    >
      <form
        action={(fd) => {
          setResult(null);
          fd.set("orgId", orgId);
          // Toggle: button click flips current state.
          fd.set("enabled", enabled ? "off" : "on");
          startTransition(async () => setResult(await toggleFeedback(fd)));
        }}
        className="flex items-center justify-between"
      >
        <span className="text-sm">
          Currently{" "}
          <span
            className={cn(
              "font-semibold",
              enabled ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {enabled ? "enabled" : "disabled"}
          </span>
        </span>
        <Button
          type="submit"
          variant={enabled ? "outline" : "default"}
          disabled={pending}
        >
          {pending
            ? "Saving…"
            : enabled
              ? "Disable feedback"
              : "Enable feedback"}
        </Button>
      </form>
      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

// --- comp card -------------------------------------------------------------

function CompCard({ orgId, isComped }: { orgId: string; isComped: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card
      title="Comp this workspace"
      description="When comped, usage_events don't debit credit_ledger for this workspace. Pair with a Deepgram override if you want them billing through their own project."
      accent="peach"
      icon={<Gift className="h-4 w-4" />}
    >
      <form
        action={(fd) => {
          setResult(null);
          fd.set("orgId", orgId);
          fd.set("enabled", isComped ? "off" : "on");
          startTransition(async () => setResult(await toggleComp(fd)));
        }}
        className="flex items-center justify-between"
      >
        <span className="text-sm">
          Currently{" "}
          <span
            className={cn(
              "font-semibold",
              isComped ? "text-peach-deep" : "text-muted-foreground"
            )}
          >
            {isComped ? "comped" : "not comped"}
          </span>
        </span>
        <Button
          type="submit"
          variant={isComped ? "outline" : "default"}
          disabled={pending}
        >
          {pending ? "Saving…" : isComped ? "Remove comp" : "Comp this workspace"}
        </Button>
      </form>
      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

// --- credit adjust --------------------------------------------------------

function CreditAdjustCard({ orgId }: { orgId: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card
      title="Manual credit adjustment"
      description="Positive amounts add credit; negative amounts remove it. Always writes an immutable ledger row tagged to you — safe to scrub via a corrective entry, never via delete."
      accent="plum"
      icon={<AlertTriangle className="h-4 w-4" />}
    >
      <form
        action={(fd) => {
          setResult(null);
          fd.set("orgId", orgId);
          startTransition(async () => {
            const r = await adjustCredit(fd);
            setResult(r);
            if (r.ok) {
              const form = document.getElementById("adjust-form") as HTMLFormElement | null;
              form?.reset();
            }
          });
        }}
        id="adjust-form"
        className="grid sm:grid-cols-[120px_1fr_auto] gap-3 items-start"
      >
        <div className="flex items-center rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
          <span className="pl-3 pr-1 text-muted-foreground text-sm select-none">
            $
          </span>
          <input
            type="text"
            name="amountDollars"
            placeholder="10"
            inputMode="decimal"
            className="flex-1 bg-transparent px-2 py-2.5 text-sm outline-none"
          />
        </div>
        <input
          type="text"
          name="note"
          placeholder="Note (optional, e.g. 'refund for outage 2026-04-18')"
          className="rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Apply"}
        </Button>
      </form>
      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

// --- deepgram override ----------------------------------------------------

function DeepgramOverrideCard({
  orgId,
  hasOverride,
}: {
  orgId: string;
  hasOverride: boolean;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "edit">("view");

  return (
    <Card
      title="Deepgram key override"
      description="Point this workspace at its own Deepgram project key. Usage events for this workspace will still be recorded in our DB for billing purposes, but transcription traffic goes through their Deepgram billing, not ours."
      accent="plum"
      icon={<KeyRound className="h-4 w-4" />}
    >
      {mode === "view" ? (
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <span
              className={cn(
                "font-semibold",
                hasOverride ? "text-plum" : "text-muted-foreground"
              )}
            >
              {hasOverride ? "Override set" : "No override — using system key"}
            </span>
            {hasOverride && (
              <p className="mt-1 text-xs text-muted-foreground">
                Key is stored encrypted. We can&apos;t show it back; to rotate,
                paste a fresh one below.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
              {hasOverride ? "Rotate" : "Set key"}
            </Button>
            {hasOverride && (
              <ClearButton
                orgId={orgId}
                onDone={(r) => setResult(r)}
                pending={pending}
                startTransition={startTransition}
              />
            )}
          </div>
        </div>
      ) : (
        <form
          action={(fd) => {
            setResult(null);
            fd.set("orgId", orgId);
            startTransition(async () => {
              const r = await setDeepgramOverride(fd);
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
        </form>
      )}
      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

// --- groq override --------------------------------------------------------

function GroqOverrideCard({
  orgId,
  hasOverride,
}: {
  orgId: string;
  hasOverride: boolean;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "edit">("view");

  return (
    <Card
      title="Groq key override"
      description="Point this workspace's Groq Whisper transcriptions at their own Groq project. Usage is still billed through our credit ledger at retail; the provider-side cost goes to them."
      accent="plum"
      icon={<KeyRound className="h-4 w-4" />}
    >
      {mode === "view" ? (
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <span
              className={cn(
                "font-semibold",
                hasOverride ? "text-plum" : "text-muted-foreground"
              )}
            >
              {hasOverride ? "Override set" : "No override — using system key"}
            </span>
            {hasOverride && (
              <p className="mt-1 text-xs text-muted-foreground">
                Key is stored encrypted. We can&apos;t show it back; to rotate,
                paste a fresh one below.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
              {hasOverride ? "Rotate" : "Set key"}
            </Button>
            {hasOverride && (
              <ClearGroqButton
                orgId={orgId}
                onDone={(r) => setResult(r)}
                pending={pending}
                startTransition={startTransition}
              />
            )}
          </div>
        </div>
      ) : (
        <form
          action={(fd) => {
            setResult(null);
            fd.set("orgId", orgId);
            startTransition(async () => {
              const r = await setGroqOverride(fd);
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
            placeholder="gsk_…"
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
        </form>
      )}
      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

function ClearGroqButton({
  orgId,
  onDone,
  pending,
  startTransition,
}: {
  orgId: string;
  onDone: (r: ActionResult) => void;
  pending: boolean;
  startTransition: (fn: () => Promise<void>) => void;
}) {
  return (
    <form
      action={async (fd) => {
        if (!window.confirm("Clear the Groq override for this workspace?")) return;
        fd.set("orgId", orgId);
        fd.set("key", "");
        startTransition(async () => {
          const r = await setGroqOverride(fd);
          onDone(r);
        });
      }}
    >
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Clear
      </Button>
    </form>
  );
}

// --- allowed models whitelist --------------------------------------------

function AllowedModelsCard({
  orgId,
  allowed,
  available,
}: {
  orgId: string;
  allowed: string[];
  available: ProviderModel[];
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  // Local state mirrors the server truth; the form POST overwrites it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allowed));

  const restricted = allowed.length > 0;

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function reset() {
    setSelected(new Set());
  }

  return (
    <Card
      title="Allowed transcription models"
      description="Restrict which (provider, model) pairs this workspace's users can dispatch from /api/transcribe. Leave everything unchecked to keep the default — no restriction, every active model is usable."
      accent="peach"
      icon={<CheckSquare className="h-4 w-4" />}
    >
      <form
        action={(fd) => {
          setResult(null);
          fd.set("orgId", orgId);
          for (const slug of selected) {
            fd.append("slugs", slug);
          }
          startTransition(async () => setResult(await setAllowedModels(fd)));
        }}
      >
        <div className="space-y-2">
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active provider_pricing rows. Seed some before restricting.
            </p>
          ) : (
            available.map((row) => {
              const slug = `${row.providerId}/${row.model}`;
              const isChecked = selected.has(slug);
              return (
                <label
                  key={slug}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background px-4 py-2.5 cursor-pointer hover:border-border transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggle(slug)}
                      className="h-4 w-4 rounded border-input"
                    />
                    <div>
                      <div className="text-sm font-mono">{slug}</div>
                      <div className="text-xs text-muted-foreground">
                        ${(row.retailPerMinuteMillicents / 100_000).toFixed(4)}/min retail
                      </div>
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {selected.size === 0
              ? restricted
                ? "Saving with nothing checked clears the restriction (all models allowed)."
                : "No restriction — all active models usable."
              : `${selected.size} of ${available.length} selected.`}
          </div>
          <div className="flex gap-2">
            {selected.size > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reset}
                disabled={pending}
              >
                Clear selection
              </Button>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>

      {result && (
        <p
          className={cn(
            "mt-3 text-sm",
            result.ok ? "text-sage" : "text-destructive"
          )}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}

function ClearButton({
  orgId,
  onDone,
  pending,
  startTransition,
}: {
  orgId: string;
  onDone: (r: ActionResult) => void;
  pending: boolean;
  startTransition: (fn: () => Promise<void>) => void;
}) {
  return (
    <form
      action={async (fd) => {
        if (!window.confirm("Clear the Deepgram override for this workspace?")) return;
        fd.set("orgId", orgId);
        fd.set("key", "");
        startTransition(async () => {
          const r = await setDeepgramOverride(fd);
          onDone(r);
        });
      }}
    >
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Clear
      </Button>
    </form>
  );
}

// --- card wrapper ----------------------------------------------------------

function Card({
  title,
  description,
  accent,
  icon,
  children,
}: {
  title: string;
  description: string;
  accent: "peach" | "plum";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tint =
    accent === "peach"
      ? "border-peach/30 bg-peach/[0.04]"
      : "border-plum/20 bg-plum/[0.03]";
  const iconTint =
    accent === "peach"
      ? "bg-peach/15 text-peach-deep"
      : "bg-plum/15 text-plum";
  return (
    <section className={`rounded-2xl border ${tint} p-6 sm:p-8`}>
      <div className="flex items-start gap-3">
        <div
          className={`inline-flex h-9 w-9 items-center justify-center rounded-xl shrink-0 ${iconTint}`}
        >
          {icon}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}
