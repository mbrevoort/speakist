"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDeviceCode, type ConfirmResult } from "./actions";

/// Sign-in confirmation step for the OAuth-style device-code flow.
///
/// Why we don't auto-submit: this page exists specifically so the user
/// can VISUALLY MATCH the code displayed by the Mac/iOS app against
/// the code displayed in the browser before authorizing. That's the
/// security purpose of `user_code` in RFC 8628 — it gives the user
/// a moment to confirm they're authorizing the device they think
/// they're authorizing, on the account they think they're authorizing.
///
/// A previous version of this component auto-submitted whenever the
/// `?code=…` query param was present "so the user shouldn't have to
/// retype anything." That intent is fine, but it skipped the match
/// step entirely — the code was POSTed silently and the page never
/// even displayed it. The result: a security feature that did nothing,
/// and a code shown on the device with no apparent role.
///
/// New behavior:
///   * Code from the URL pre-fills the form (no retyping)
///   * The code is shown prominently with explicit "match this against
///     your device" framing
///   * Authorization requires one explicit click — no useEffect tricks
///   * The signed-in email is shown so a paste-into-the-wrong-profile
///     mistake is caught before it grants access
///
/// This is the canonical device-code UX (see GitHub, Cloudflare, AWS).
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
      className="mt-6 space-y-5"
    >
      <div>
        <label
          htmlFor="user_code"
          className="block text-sm font-medium mb-2"
        >
          Confirm this code matches the one shown in the Speakist app on
          your Mac or iPhone
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
          className="block w-full rounded-xl border border-input bg-background px-4 py-4 text-center font-mono text-2xl font-semibold tracking-[0.25em] uppercase outline-none focus:ring-2 focus:ring-ring"
        />
        {defaultCode ? (
          <p className="mt-2 text-xs text-muted-foreground text-center">
            We pre-filled this from the link your device gave you. Verify it
            matches before authorizing.
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground text-center">
            Type the code from the device&apos;s sign-in window.
          </p>
        )}
      </div>

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={pending}
      >
        {pending ? "Authorizing…" : "Authorize this device"}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        You&apos;ll be authorizing as{" "}
        <span className="font-mono text-foreground">{userEmail}</span>. If
        that&apos;s the wrong account,{" "}
        <a
          href="/auth/signout"
          className="underline underline-offset-2 hover:text-foreground"
        >
          sign out first
        </a>
        .
      </p>

      {result && !result.ok && (
        <p className="text-sm text-destructive text-center" role="status">
          {result.error}
        </p>
      )}
    </form>
  );
}
