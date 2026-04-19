// Client-side billing UI. Handles:
//   * Top-up tiles → POST /api/billing/topup → window.location = session.url
//   * Payment method button → POST /api/billing/portal → redirect
//   * Auto-top-up form submits
//
// The page-level success/cancel toasts are derived from the ?topup= query
// param set on Stripe's return URL.

"use client";

import { useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDollars } from "@/lib/utils";
import { updateAutoTopup, type ActionResult } from "./actions";

interface Props {
  balanceMillicents: number;
  isComped: boolean;
  canAdmin: boolean;
  hasPaymentMethod: boolean;
  autoTopupEnabled: boolean;
  autoTopupThresholdDollars: number;
  autoTopupAmountDollars: number;
  topupStatus: "success" | "cancel" | null;
}

const TOPUP_TIERS_MILLICENTS = [
  1_000_000, // $10
  2_500_000, // $25
  5_000_000, // $50
  10_000_000, // $100
];

export function BillingClient(props: Props) {
  const {
    balanceMillicents,
    isComped,
    canAdmin,
    hasPaymentMethod,
    autoTopupEnabled,
    autoTopupThresholdDollars,
    autoTopupAmountDollars,
    topupStatus,
  } = props;

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

      {/* Balance */}
      <section className="rounded-2xl border border-peach/40 bg-background p-6 sm:p-8 shadow-sm shadow-peach/10">
        <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium">
          Credit balance
        </p>
        <p className="mt-2 text-5xl font-semibold tracking-tight tabular-nums">
          {formatDollars(balanceMillicents, { precision: 2 })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isComped
            ? "This org is comped — usage doesn't debit this balance."
            : "Debits in real time as your team transcribes."}
        </p>
      </section>

      {/* Top-up */}
      {!isComped && (
        <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Add credit</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                One-time top-up. Secured by Stripe.
              </p>
            </div>
            {hasPaymentMethod && canAdmin && (
              <PortalButton />
            )}
          </div>

          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {TOPUP_TIERS_MILLICENTS.map((amount) => (
              <TopupTile key={amount} amountMillicents={amount} disabled={!canAdmin} />
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
          thresholdDollars={autoTopupThresholdDollars}
          amountDollars={autoTopupAmountDollars}
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
  amountMillicents,
  disabled,
}: {
  amountMillicents: number;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const dollars = amountMillicents / 100_000;

  const onClick = () =>
    startTransition(async () => {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMillicents }),
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
        ${dollars.toFixed(0)}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        ≈ {Math.round(dollars * 17_500).toLocaleString()} words
      </div>
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
  thresholdDollars,
  amountDollars,
}: {
  canAdmin: boolean;
  hasPaymentMethod: boolean;
  enabled: boolean;
  thresholdDollars: number;
  amountDollars: number;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(enabled);

  return (
    <section className="rounded-2xl border border-border/70 bg-background p-6 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Auto top-up</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-lg">
            When your balance drops below the threshold, we automatically
            charge your saved payment method and add credit. Your team
            never stops transcribing.
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
          <DollarField
            name="thresholdDollars"
            label="Trigger when balance falls below"
            defaultValue={thresholdDollars}
            disabled={!canAdmin || !on}
          />
          <DollarField
            name="amountDollars"
            label="Top-up amount"
            defaultValue={amountDollars}
            disabled={!canAdmin || !on}
            helper="Minimum $5."
          />
        </div>

        <div className="flex items-center gap-3">
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

function DollarField({
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
        <span className="pl-3 pr-1 text-muted-foreground select-none">$</span>
        <input
          type="text"
          name={name}
          defaultValue={defaultValue}
          disabled={disabled}
          inputMode="decimal"
          className="flex-1 bg-transparent px-2 py-2.5 text-sm outline-none"
        />
      </div>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </label>
  );
}
