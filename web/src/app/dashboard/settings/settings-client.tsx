// Client bits for Settings. The page (RSC) fetches the current org state and
// passes values as defaults; this component handles submission + feedback.

"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  updateOrgName,
  updateAutoJoinDomain,
  leaveOrg,
  deleteOrg,
  type ActionResult,
} from "./actions";

interface Props {
  orgName: string;
  orgSlug: string;
  autoJoinDomain: string | null;
  canAdmin: boolean;
  isSoleOwner: boolean;
  role: "owner" | "admin" | "member";
}

export function SettingsClient({
  orgName,
  orgSlug,
  autoJoinDomain,
  canAdmin,
  isSoleOwner,
  role,
}: Props) {
  return (
    <div className="space-y-10">
      <Card title="Organization name" description="Shown in the sidebar and on invitation emails.">
        <TextFieldForm
          name="name"
          defaultValue={orgName}
          action={updateOrgName}
          disabled={!canAdmin}
          disabledNote={!canAdmin ? "Only owners and admins can edit." : undefined}
        />
      </Card>

      <Card
        title="Auto-join by email domain"
        description="Anyone signing up with a matching email domain is automatically added to this org as a member. Leave blank to turn off."
      >
        <TextFieldForm
          name="domain"
          defaultValue={autoJoinDomain ?? ""}
          placeholder="acme.com"
          action={updateAutoJoinDomain}
          disabled={!canAdmin}
          disabledNote={!canAdmin ? "Only owners and admins can edit." : undefined}
          prefix="@"
        />
      </Card>

      <Card
        title="Leave organization"
        description={
          isSoleOwner
            ? "You're the only owner. Promote someone else first, or delete the org below."
            : "Remove yourself from this org. Your transcription history on your Mac isn't affected."
        }
        danger
      >
        <LeaveButton disabled={isSoleOwner} />
      </Card>

      {role === "owner" && (
        <Card
          title="Delete organization"
          description="Permanently removes the org, every member, every invitation, and all usage history. Cannot be undone."
          danger
        >
          <DeleteForm orgSlug={orgSlug} />
        </Card>
      )}
    </div>
  );
}

// --- building blocks -------------------------------------------------------

function Card({
  title,
  description,
  danger,
  children,
}: {
  title: string;
  description?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border p-6 sm:p-8",
        danger ? "border-destructive/30 bg-destructive/[0.02]" : "border-border/70 bg-background"
      )}
    >
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground max-w-xl">{description}</p>
      )}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function TextFieldForm({
  name,
  defaultValue,
  placeholder,
  action,
  disabled,
  disabledNote,
  prefix,
}: {
  name: string;
  defaultValue: string;
  placeholder?: string;
  action: (fd: FormData) => Promise<ActionResult>;
  disabled?: boolean;
  disabledNote?: string;
  prefix?: string;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => {
        setResult(null);
        startTransition(async () => setResult(await action(fd)));
      }}
      className="flex flex-col sm:flex-row gap-3 items-start"
    >
      <div
        className={cn(
          "flex items-center flex-1 rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring",
          disabled && "opacity-60"
        )}
      >
        {prefix && (
          <span className="pl-3 pr-1 text-muted-foreground text-sm select-none">
            {prefix}
          </span>
        )}
        <input
          type="text"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className="flex-1 bg-transparent px-3 py-2.5 text-sm outline-none"
        />
      </div>
      <Button type="submit" disabled={disabled || pending} size="default">
        {pending ? "Saving…" : "Save"}
      </Button>
      {(result || disabledNote) && (
        <p
          className={cn(
            "text-sm basis-full",
            result?.ok === true && "text-sage",
            result?.ok === false && "text-destructive",
            !result && disabledNote && "text-muted-foreground"
          )}
          role="status"
        >
          {result?.ok === true ? result.message ?? "Saved." : result?.error ?? disabledNote}
        </p>
      )}
    </form>
  );
}

function LeaveButton({ disabled }: { disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={disabled || pending}
      onClick={() => {
        if (!window.confirm("Leave this organization? You can be re-invited later.")) return;
        startTransition(async () => {
          await leaveOrg();
        });
      }}
    >
      {pending ? "Leaving…" : "Leave organization"}
    </Button>
  );
}

function DeleteForm({ orgSlug }: { orgSlug: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(fd) => {
        if (
          !window.confirm(
            "This deletes your org, members, invitations, and history. Continue?"
          )
        ) {
          return;
        }
        setResult(null);
        startTransition(async () => setResult(await deleteOrg(fd)));
      }}
      className="flex flex-col sm:flex-row gap-3 items-start"
    >
      <input
        type="text"
        name="confirm"
        placeholder={`Type "${orgSlug}" to confirm`}
        autoComplete="off"
        className="flex-1 rounded-xl border border-input bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-destructive"
      />
      <Button type="submit" variant="destructive" disabled={pending}>
        <Trash2 className="h-4 w-4" />
        {pending ? "Deleting…" : "Delete org"}
      </Button>
      {result && !result.ok && (
        <p className="text-sm text-destructive basis-full">{result.error}</p>
      )}
    </form>
  );
}
