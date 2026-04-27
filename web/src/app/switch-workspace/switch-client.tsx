"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { switchActiveWorkspace } from "@/app/dashboard/workspace-actions";

interface OrgOption {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
}

export function SwitchWorkspaceClient({
  orgs,
  initialActiveOrgId,
  isFromNative,
}: {
  orgs: OrgOption[];
  initialActiveOrgId: string | null;
  /** True when arrived from a native app (return=mac-app|ios-app).
   *  Drives post-save copy: "Return to Speakist on your Mac/iPhone"
   *  instead of "Back to dashboard". */
  isFromNative: boolean;
}) {
  const [chosen, setChosen] = useState<string>(
    initialActiveOrgId ?? orgs[0]?.id ?? ""
  );
  const [pending, startTransition] = useTransition();
  const [savedOrgId, setSavedOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!chosen) return;
    if (chosen === savedOrgId) return;
    const fd = new FormData();
    fd.set("org_id", chosen);
    setError(null);
    startTransition(async () => {
      const r = await switchActiveWorkspace(fd);
      if (r.ok) setSavedOrgId(r.orgId);
      else setError(r.error);
    });
  }

  if (savedOrgId) {
    const saved = orgs.find((o) => o.id === savedOrgId);
    return (
      <div className="mt-6 rounded-xl bg-sage/10 border border-sage/30 p-6 text-center">
        <CheckCircle2 className="mx-auto size-8 text-sage" />
        <p className="mt-3 font-medium text-sage">
          Switched to {saved?.name ?? "workspace"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isFromNative
            ? "You can return to Speakist now — the new workspace will sync the next time the app comes to the foreground."
            : "Your dashboard will reflect the new workspace."}
        </p>
        {!isFromNative && (
          <Button asChild size="sm" className="mt-4">
            <a href="/dashboard">Back to dashboard</a>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="space-y-2">
        {orgs.map((org) => {
          const selected = chosen === org.id;
          return (
            <label
              key={org.id}
              className={cn(
                "flex items-center gap-3 rounded-xl border p-3 cursor-pointer transition-colors",
                selected
                  ? "border-peach-deep bg-peach/10"
                  : "border-border/70 bg-background hover:bg-muted/50"
              )}
            >
              <input
                type="radio"
                name="workspace"
                value={org.id}
                checked={selected}
                onChange={() => setChosen(org.id)}
                className="sr-only"
              />
              <span
                className={cn(
                  "inline-block h-3 w-3 rounded-full border shrink-0",
                  selected
                    ? "border-peach-deep bg-peach-deep"
                    : "border-muted-foreground/40"
                )}
                aria-hidden
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">{org.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {org.slug} · {org.role}
                </span>
              </span>
              {org.id === initialActiveOrgId && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  current
                </span>
              )}
            </label>
          );
        })}
      </div>

      <Button
        onClick={save}
        disabled={pending || !chosen || chosen === initialActiveOrgId}
        size="lg"
        className="w-full"
      >
        {pending ? "Switching…" : "Use this workspace"}
      </Button>

      {error && (
        <p className="text-sm text-destructive text-center" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
