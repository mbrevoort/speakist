"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { updatePricing, type ActionResult } from "./actions";

interface Props {
  pricePerWordMillicents: number;
  deepgramPerMinuteMillicents: number;
  signupBonusDollars: number;
  defaultAutoTopupAmountDollars: number;
  defaultAutoTopupThresholdDollars: number;
}

export function PricingEditor(p: Props) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Derived preview: $/1000 words for the current input value.
  const [perWordMc, setPerWordMc] = useState(p.pricePerWordMillicents);
  const per1000 = (perWordMc / 100_000) * 1000;

  return (
    <form
      action={(fd) => {
        setResult(null);
        startTransition(async () => setResult(await updatePricing(fd)));
      }}
      className="space-y-6"
    >
      <Field
        label="Price per word (millicents)"
        name="pricePerWordMillicents"
        defaultValue={p.pricePerWordMillicents}
        onChange={(v) => setPerWordMc(Number(v) || 0)}
        helper={`$${per1000.toFixed(2)} / 1,000 words on the landing page.`}
        step="0.01"
      />
      <Field
        label="Deepgram per-minute cost (millicents)"
        name="deepgramPerMinuteMillicents"
        defaultValue={p.deepgramPerMinuteMillicents}
        helper="Only used for margin display on admin overview. Default 430 ≈ $0.0043/min for Nova-3."
        step="0.01"
      />

      <hr className="border-border/60" />

      <Field
        label="Signup bonus ($)"
        name="signupBonusDollars"
        defaultValue={p.signupBonusDollars}
        helper="Granted to every new org on first provisioning."
        prefix="$"
        step="0.01"
      />
      <Field
        label="Default auto-topup amount ($)"
        name="defaultAutoTopupAmountDollars"
        defaultValue={p.defaultAutoTopupAmountDollars}
        helper="Default when an org enables auto-topup without setting their own amount. Minimum $5."
        prefix="$"
        step="1"
      />
      <Field
        label="Default auto-topup threshold ($)"
        name="defaultAutoTopupThresholdDollars"
        defaultValue={p.defaultAutoTopupThresholdDollars}
        helper="Balance below this triggers auto-topup. Default $5."
        prefix="$"
        step="1"
      />

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save pricing"}
        </Button>
        {result && (
          <p
            className={cn(
              "text-sm",
              result.ok ? "text-sage" : "text-destructive"
            )}
            role="status"
          >
            {result.ok ? result.message ?? "Saved." : result.error}
          </p>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  helper,
  prefix,
  step,
  onChange,
}: {
  label: string;
  name: string;
  defaultValue: number;
  helper?: string;
  prefix?: string;
  step?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1.5">{label}</span>
      <div className="flex items-center rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring max-w-xs">
        {prefix && (
          <span className="pl-3 pr-1 text-muted-foreground select-none">{prefix}</span>
        )}
        <input
          type="number"
          name={name}
          defaultValue={defaultValue}
          step={step}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          className="flex-1 bg-transparent px-3 py-2 text-sm outline-none"
        />
      </div>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </label>
  );
}
