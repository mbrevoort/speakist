// Client-side billing UI. Handles:
//   * Top-up tiles → POST /api/billing/topup → window.location = session.url
//   * Payment method button → POST /api/billing/portal → redirect
//   * Auto-top-up form submits
//
// The page-level success/cancel toasts are derived from the ?topup= query
// param set on Stripe's return URL.
//
// User-facing balance is shown in WORDS (the utility unit), not dollars.
// See docs/pricing-strategy.md for the rationale. Dollars still appear in
// the ledger and the admin views.

"use client";

import { useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDollars, formatWords, millicentsToWords } from "@/lib/utils";
import { TOPUP_TIERS, type TopupTier } from "@/lib/billing/topupTiers";
import { updateAutoTopup, type ActionResult } from "./actions";

interface Props {
  balanceMillicents: number;
  pricePerWordMillicents: number;
  isComped: boolean;
  canAdmin: boolean;
  hasPaymentMethod: boolean;
  autoTopupEnabled: boolean;
  /** All three are surfaced as "words" in the form, but persisted as
   *  millicents server-side via the action. */
  autoTopupThresholdWords: number;
  autoTopupAmountWords: number;
  /** NULL ⇒ no cap set; the form lets the user toggle this on. */
  autoTopupMaxMonthlyWords: number | null;
  topupStatus: "success" | "cancel" | null;
}

export function BillingClient(props: Props) {
  const {
    balanceMillicents,
    pricePerWordMillicents,
    isComped,
    canAdmin,
    hasPaymentMethod,
    autoTopupEnabled,
    autoTopupThresholdWords,
    autoTopupAmountWords,
    autoTopupMaxMonthlyWords,
    topupStatus,
  } = props;

  const balanceWords = millicentsToWords(balanceMillicents, pricePerWordMillicents);

  return (
    <div className="space-y-10">
      {/* Success/cancel banner from query param */}
      {topupStatus === "success" && (
        <Banner kind="success">
          Top-up successful. It may take a few seconds for the balance to
          refresh.
        </Banner>
      )}
      {topupStatus === "cancel" && (
        <Banner kind="warn">Top-up cancelled. No charge was made.</Banner>
      )}

      {/* Balance — primary display in words. The dollar amount is shown as
       *  a sub-line because the billing page is admin-only and admins are
       *  the ones who reconcile against Stripe. Per docs/pricing-strategy.md
       *  the dollar number does NOT appear on the user-wide dashboard. */}
      <section className="rounded-2xl border border-peach/40 bg-background p-6 sm:p-8 shadow-sm shadow-peach/10">
        <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
          Words remaining
        </p>
        <p className="mt-2 text-5xl font-semibold tracking-tight tabular-nums">
          {balanceWords.toLocaleString("en-US")}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isComped
            ? "This workspace is comped — usage doesn't debit your balance."
            : "Debits in real time as your workspace transcribes."}
        </p>
        {!isComped && (
          <p className="mt-3 text-xs text-muted-foreground tabular-nums">
            Balance value: {formatDollars(balanceMillicents, { precision: 2 })}
          </p>
        )}
      </section>

      {/* Top-up tiers */}
      {!isComped && (
        <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Add words</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Larger packs include bonus words — secured by Stripe.
              </p>
            </div>
            {hasPaymentMethod && canAdmin && <PortalButton />}
          </div>

          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {TOPUP_TIERS.map((tier) => (
              <TopupTile
                key={tier.id}
                tier={tier}
                pricePerWordMillicents={pricePerWordMillicents}
                disabled={!canAdmin}
              />
            ))}
          </div>

          {!canAdmin && (
            <p className="mt-4 text-xs text-muted-foreground">
              Only admins and owners can top up.
            </p>
          )}
        </section>
      )}

      {/* Auto-topup */}
      {!isComped && (
        <AutoTopupCard
          canAdmin={canAdmin}
          hasPaymentMethod={hasPaymentMethod}
          enabled={autoTopupEnabled}
          thresholdWords={autoTopupThresholdWords}
          amountWords={autoTopupAmountWords}
          maxMonthlyWords={autoTopupMaxMonthlyWords}
        />
      )}
    </div>
  );
}

// --- sub-components --------------------------------------------------------

function Banner({
  kind,
  children,
}: {
  kind: "success" | "warn";
  children: React.ReactNode;
}) {
  const style =
    kind === "success"
      ? "bg-sage/10 text-sage border-sage/30"
      : "bg-mustard/10 text-mustard border-mustard/40";
  const Icon = kind === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div className={cn("rounded-xl border px-4 py-3 text-sm flex items-center gap-2", style)}>
      <Icon className="h-4 w-4" />
      <span>{children}</span>
    </div>
  );
}

function TopupTile({
  tier,
  pricePerWordMillicents,
  disabled,
}: {
  tier: TopupTier;
  pricePerWordMillicents: number;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const wordsGranted = millicentsToWords(tier.creditMillicents, pricePerWordMillicents);

  const onClick = () =>
    startTransition(async () => {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id }),
      });
      if (!res.ok) {
        alert("Couldn't start checkout. Try again.");
        return;
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    });

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className="group relative rounded-xl border-2 border-border/70 bg-background p-4 text-left hover:border-peach/50 hover:bg-peach/5 transition-colors disabled:opacity-50 disabled:pointer-events-none"
    >
      <div className="text-2xl font-semibold tracking-tight">
        ${tier.dollarAmount}
      </div>
      <div className="mt-1 text-sm font-medium tabular-nums">
        {formatWords(wordsGranted)}
      </div>
      {tier.bonusPct > 0 ? (
        <div className="mt-1 text-xs font-medium text-sage">
          +{tier.bonusPct}% bonus
        </div>
      ) : (
        <div className="mt-1 text-xs text-muted-foreground">Base rate</div>
      )}
      <Plus className="absolute top-3 right-3 h-4 w-4 text-muted-foreground group-hover:text-peach-deep" />
      {pending && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 rounded-xl text-sm">
          Loading…
        </div>
      )}
    </button>
  );
}

function PortalButton() {
  const [pending, startTransition] = useTransition();
  const onClick = () =>
    startTransition(async () => {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      if (!res.ok) {
        alert("Couldn't open billing portal.");
        return;
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    });
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      <ExternalLink className="h-3.5 w-3.5" />
      {pending ? "Opening…" : "Manage payment method"}
    </Button>
  );
}

function AutoTopupCard({
  canAdmin,
  hasPaymentMethod,
  enabled,
  thresholdWords,
  amountWords,
  maxMonthlyWords,
}: {
  canAdmin: boolean;
  hasPaymentMethod: boolean;
  enabled: boolean;
  thresholdWords: number;
  amountWords: number;
  maxMonthlyWords: number | null;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(enabled);
  const [capOn, setCapOn] = useState(maxMonthlyWords !== null);

  return (
    <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Auto top-up</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-lg">
            When your remaining words drop below the threshold, we
            automatically charge your saved payment method and add words
            so your workspace never stops transcribing. The monthly cap is the
            most we&apos;ll ever auto-charge in a calendar month.
          </p>
        </div>
      </div>

      {!hasPaymentMethod && (
        <p className="mt-4 text-xs rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground">
          Add a payment method by doing one manual top-up, then auto-top-up
          can be enabled.
        </p>
      )}

      <form
        action={(fd) => {
          fd.set("enabled", on ? "on" : "off");
          fd.set("capEnabled", capOn ? "on" : "off");
          setResult(null);
          startTransition(async () => setResult(await updateAutoTopup(fd)));
        }}
        className="mt-6 space-y-4"
      >
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
            disabled={!canAdmin || !hasPaymentMethod}
            className="h-4 w-4 rounded border-border text-peach focus:ring-ring"
          />
          <span className="text-sm">Enable auto top-up</span>
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <WordsField
            name="thresholdWords"
            label="Trigger when remaining words fall below"
            defaultValue={thresholdWords}
            disabled={!canAdmin || !on}
          />
          <WordsField
            name="amountWords"
            label="Words to add per top-up"
            defaultValue={amountWords}
            disabled={!canAdmin || !on}
            helper="At least the smallest pack ($5) of words. No bonus on auto-top-ups."
          />
        </div>

        <div className="space-y-3 pt-2">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={capOn}
              onChange={(e) => setCapOn(e.target.checked)}
              disabled={!canAdmin || !on}
              className="h-4 w-4 rounded border-border text-peach focus:ring-ring"
            />
            <span className="text-sm">
              Set a monthly maximum (recommended)
            </span>
          </label>
          {capOn && (
            <WordsField
              name="maxMonthlyWords"
              label="Never auto-add more than this many words per month"
              defaultValue={maxMonthlyWords ?? amountWords * 4}
              disabled={!canAdmin || !on}
              helper="If a top-up would push this month's auto-charges past the cap, we skip it and let your balance go negative until you top up manually."
            />
          )}
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!canAdmin || pending} size="default">
            {pending ? "Saving…" : "Save"}
          </Button>
          {result && (
            <p
              className={cn(
                "text-sm",
                result.ok ? "text-sage" : "text-destructive"
              )}
              role="status"
            >
              {result.ok ? "Saved." : result.error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function WordsField({
  name,
  label,
  defaultValue,
  disabled,
  helper,
}: {
  name: string;
  label: string;
  defaultValue: number;
  disabled?: boolean;
  helper?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1.5">{label}</span>
      <div
        className={cn(
          "flex items-center rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring",
          disabled && "opacity-60"
        )}
      >
        <input
          type="number"
          name={name}
          defaultValue={defaultValue}
          disabled={disabled}
          inputMode="numeric"
          step="500"
          min="0"
          className="flex-1 bg-transparent px-3 py-2.5 text-sm outline-none tabular-nums"
        />
        <span className="pr-3 pl-1 text-muted-foreground select-none text-xs">
          words
        </span>
      </div>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </label>
  );
}
