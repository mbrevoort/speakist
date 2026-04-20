"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { confirmDeviceCode, type ConfirmResult } from "./actions";

export function LinkClient({
  defaultCode,
  userEmail,
}: {
  defaultCode: string;
  userEmail: string;
}) {
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.ok) {
    return (
      <div className="mt-6 rounded-xl bg-sage/10 border border-sage/30 p-5 text-center">
        <CheckCircle2 className="mx-auto size-8 text-sage" />
        <p className="mt-3 font-medium text-sage">{result.message}</p>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        setResult(null);
        startTransition(async () => setResult(await confirmDeviceCode(fd)));
      }}
      className="mt-6 space-y-4"
    >
      <div>
        <label htmlFor="user_code" className="block text-sm font-medium mb-1.5">
          Code from your Mac
        </label>
        <input
          id="user_code"
          name="user_code"
          defaultValue={defaultCode}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          required
          inputMode="text"
          className="block w-full rounded-xl border border-input bg-background px-4 py-3 text-center font-mono text-lg tracking-[0.15em] uppercase outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Confirming…" : "Link this Mac"}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        You&apos;ll be linking as{" "}
        <span className="font-mono text-foreground">{userEmail}</span>.
      </p>

      {result && !result.ok && (
        <p className="text-sm text-destructive text-center" role="status">
          {result.error}
        </p>
      )}
    </form>
  );
}
