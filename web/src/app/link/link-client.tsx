"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { confirmDeviceCode, type ConfirmResult } from "./actions";

interface MembershipOption {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
}

export function LinkClient({
  defaultCode,
  userEmail,
  orgs,
  defaultOrgId,
}: {
  defaultCode: string;
  userEmail: string;
  /** All orgs the user belongs to. When length >= 2, a workspace picker
   *  is shown above the form so the user explicitly chooses which org
   *  this device signs into. When length is 0 or 1 the picker is
   *  hidden — same UX as before this feature shipped. */
  orgs: MembershipOption[];
  /** Which org should be pre-selected. Server passes the user's
   *  `last_active_org_id` when valid, else the earliest-joined. */
  defaultOrgId: string | null;
}) {
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [pending, startTransition] = useTransition();
  const multiOrg = orgs.length >= 2;
  const [chosenOrg, setChosenOrg] = useState<string>(
    defaultOrgId ?? orgs[0]?.id ?? ""
  );

  // Auto-submit when ?code=… is present in the URL is only safe for
  // single-org users — multi-org users must consciously pick a
  // workspace first. For them we leave the form unsubmitted and let
  // them hit "Authorize this Mac" themselves.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    if (!defaultCode || defaultCode.length < 8) return;
    if (multiOrg) return;
    autoRan.current = true;
    const fd = new FormData();
    fd.set("user_code", defaultCode);
    if (orgs.length === 1) fd.set("workspace_org_id", orgs[0].id);
    startTransition(async () => setResult(await confirmDeviceCode(fd)));
  }, [defaultCode, multiOrg, orgs]);

  if (result?.ok) {
    return (
      <div className="mt-6 rounded-xl bg-sage/10 border border-sage/30 p-5 text-center">
        <CheckCircle2 className="mx-auto size-8 text-sage" />
        <p className="mt-3 font-medium text-sage">{result.message}</p>
      </div>
    );
  }

  if (pending && defaultCode && !result && !multiOrg) {
    return (
      <div className="mt-6 rounded-xl bg-muted/30 border border-border/70 p-6 text-center">
        <p className="text-sm text-muted-foreground">Linking your Mac…</p>
      </div>
    );
  }

  return (
    <form
      action={(fd) => {
        if (multiOrg) fd.set("workspace_org_id", chosenOrg);
        else if (orgs.length === 1) fd.set("workspace_org_id", orgs[0].id);
        setResult(null);
        startTransition(async () => setResult(await confirmDeviceCode(fd)));
      }}
      className="mt-6 space-y-4"
    >
      {multiOrg && (
        <fieldset className="space-y-2">
          <legend className="block text-sm font-medium mb-1.5">
            Which workspace should this Mac use?
          </legend>
          <div className="space-y-2">
            {orgs.map((org) => (
              <label
                key={org.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 cursor-pointer transition-colors",
                  chosenOrg === org.id
                    ? "border-peach-deep bg-peach/10"
                    : "border-border/70 bg-background hover:bg-muted/50"
                )}
              >
                <input
                  type="radio"
                  name="workspace_org_id_radio"
                  value={org.id}
                  checked={chosenOrg === org.id}
                  onChange={() => setChosenOrg(org.id)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    "inline-block h-3 w-3 rounded-full border shrink-0",
                    chosenOrg === org.id
                      ? "border-peach-deep bg-peach-deep"
                      : "border-muted-foreground/40"
                  )}
                  aria-hidden
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{org.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {org.slug} · {org.role}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            You can switch workspaces later from your dashboard or your Mac&apos;s Settings.
          </p>
        </fieldset>
      )}

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
        {pending ? "Confirming…" : "Authorize this Mac"}
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
