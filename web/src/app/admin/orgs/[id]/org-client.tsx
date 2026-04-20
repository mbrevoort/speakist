// Client bits for the org detail page: forms for comp toggle, manual credit
// adjustment, Deepgram key override. Server page passes in the current state.

"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Gift, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  adjustCredit,
  setDeepgramOverride,
  toggleComp,
  type ActionResult,
} from "./actions";

interface Props {
  orgId: string;
  isComped: boolean;
  hasDeepgramOverride: boolean;
}

export function OrgAdminActions(props: Props) {
  return (
    <div className="space-y-8">
      <CompCard orgId={props.orgId} isComped={props.isComped} />
      <CreditAdjustCard orgId={props.orgId} />
      <DeepgramOverrideCard
        orgId={props.orgId}
        hasOverride={props.hasDeepgramOverride}
      />
    </div>
  );
}

// --- comp card -------------------------------------------------------------

function CompCard({ orgId, isComped }: { orgId: string; isComped: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card
      title="Comp this org"
      description="When comped, usage_events don't debit credit_ledger for this org. Pair with a Deepgram override if you want them billing through their own project."
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
          {pending ? "Saving…" : isComped ? "Remove comp" : "Comp this org"}
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
      description="Point this org at its own Deepgram project key. Usage events for this org will still be recorded in our DB for billing purposes, but transcription traffic goes through their Deepgram billing, not ours."
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
        if (!window.confirm("Clear the Deepgram override for this org?")) return;
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
