"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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

  // #3 deep-link end-to-end: if we arrived here with a ?code=… in the URL
  // *and* the user is signed in (they wouldn't be rendering this client
  // component otherwise — the server component redirects to /auth/signin
  // first), auto-submit the code. The user just clicked the magic link in
  // their email; asking them to also click "Link this Mac" is a pointless
  // extra step. If the code is expired or wrong we still render the form
  // so they can retry by hand.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    if (!defaultCode || defaultCode.length < 8) return;
    autoRan.current = true;
    const fd = new FormData();
    fd.set("user_code", defaultCode);
    startTransition(async () => setResult(await confirmDeviceCode(fd)));
  }, [defaultCode]);

  if (result?.ok) {
    return (
      <div className="mt-6 rounded-xl bg-sage/10 border border-sage/30 p-5 text-center">
        <CheckCircle2 className="mx-auto size-8 text-sage" />
        <p className="mt-3 font-medium text-sage">{result.message}</p>
      </div>
    );
  }

  // While the auto-submit is in flight and we have a default code, show a
  // loading state rather than the bare form — feels smoother than flashing
  // the empty form briefly.
  if (pending && defaultCode && !result) {
    return (
      <div className="mt-6 rounded-xl bg-muted/30 border border-border/70 p-6 text-center">
        <p className="text-sm text-muted-foreground">Linking your Mac…</p>
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
