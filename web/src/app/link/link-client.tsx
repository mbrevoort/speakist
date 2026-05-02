"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDeviceCode, type ConfirmResult } from "./actions";
import { deviceLabel, type DevicePlatform } from "./device-label";

// Authorization is gated on an explicit click EVERY time. Do not
// re-add a useEffect-based auto-submit here. The user_code in
// RFC 8628's device-code flow is a per-authorization match check
// — the user is supposed to compare the code on their device
// against the code on this page before granting access. A silent
// auto-submit (even one driven by a deep-link from the device)
// skips that step and turns the code into useless decoration.
//
// The URL still pre-fills the form (no retyping); the form just
// doesn't submit on its own. "Previously trusted" doesn't bypass
// — that's a fingerprint concept, not what user_code is for.
export function LinkClient({
  defaultCode,
  userEmail,
  platform,
}: {
  defaultCode: string;
  userEmail: string;
  /** Native-app platform from the verification URL — drives the
   *  "your Mac" / "your iPhone" / "your device" copy. `undefined`
   *  for older app builds that pre-date the platform field. */
  platform?: DevicePlatform;
}) {
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [pending, startTransition] = useTransition();
  const label = deviceLabel(platform);

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
      {/* Tunnel `platform` to the server action so error/success
          messages match the device-aware label. Hidden because the
          user has no business editing it. */}
      {platform && (
        <input type="hidden" name="platform" value={platform} />
      )}

      <div>
        <label htmlFor="user_code" className="block text-sm font-medium mb-1.5">
          Code from your {label}
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
        {pending ? "Confirming…" : `Authorize this ${label}`}
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
