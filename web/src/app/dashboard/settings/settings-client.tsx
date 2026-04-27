// Client bits for Settings. The page (RSC) fetches the current org state and
// passes values as defaults; this component handles submission + feedback.

"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  updateOrgName,
  updateAutoJoinDomain,
  leaveOrg,
  deleteOrg,
  setPolishEnabled,
  setPolishMode,
  type ActionResult,
} from "./actions";

type PolishMode = "intuitive" | "prescriptive";

interface Props {
  orgName: string;
  orgSlug: string;
  autoJoinDomain: string | null;
  canAdmin: boolean;
  isSoleOwner: boolean;
  role: "owner" | "admin" | "member";
  /** Polish prefs are per-user; passed from the server so first paint
   *  has the right values without a client-side fetch. */
  polishEnabled: boolean;
  polishMode: PolishMode;
}

export function SettingsClient({
  orgName,
  orgSlug,
  autoJoinDomain,
  canAdmin,
  isSoleOwner,
  role,
  polishEnabled,
  polishMode,
}: Props) {
  return (
    <div className="space-y-10">
      <PolishCard enabled={polishEnabled} mode={polishMode} />

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

// --- polish ---------------------------------------------------------------

function PolishCard({
  enabled: serverEnabled,
  mode: serverMode,
}: {
  enabled: boolean;
  mode: PolishMode;
}) {
  // Local mirrors of the server state so toggle / mode-change show
  // optimistic feedback without re-rendering the whole page from the
  // RSC tree.
  const [enabled, setEnabled] = useState(serverEnabled);
  const [mode, setMode] = useState<PolishMode>(serverMode);

  const [toggleResult, setToggleResult] = useState<ActionResult | null>(null);
  const [modeResult, setModeResult] = useState<ActionResult | null>(null);
  const [togglePending, startToggleTransition] = useTransition();
  const [modePending, startModeTransition] = useTransition();

  // Re-sync from server on revalidatePath so a second save picks up the
  // fresh state instead of the locally-stomped one.
  useEffect(() => {
    setEnabled(serverEnabled);
    setMode(serverMode);
  }, [serverEnabled, serverMode]);

  function handleToggle() {
    const next = !enabled;
    const fd = new FormData();
    fd.set("enabled", next ? "on" : "off");
    setToggleResult(null);
    startToggleTransition(async () => {
      const r = await setPolishEnabled(fd);
      setToggleResult(r);
      if (r.ok) setEnabled(next);
    });
  }

  function handleModeChange(next: PolishMode) {
    if (next === mode) return;
    const fd = new FormData();
    fd.set("mode", next);
    setModeResult(null);
    const previous = mode;
    setMode(next); // optimistic
    startModeTransition(async () => {
      const r = await setPolishMode(fd);
      setModeResult(r);
      if (!r.ok) setMode(previous);
    });
  }

  return (
    <Card
      title="Polish"
      description="Cleans up every transcription before it lands — adds punctuation, capitalization, and clear grammar fixes."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={enabled ? "outline" : "default"}
            disabled={togglePending}
            onClick={handleToggle}
          >
            {togglePending ? "Saving…" : enabled ? "Polish is ON · Turn off" : "Polish is OFF · Turn on"}
          </Button>
          {toggleResult && (
            <p
              className={cn(
                "text-sm",
                toggleResult.ok ? "text-sage" : "text-destructive"
              )}
              role="status"
            >
              {toggleResult.ok ? toggleResult.message : toggleResult.error}
            </p>
          )}
        </div>

        {/* Mode picker — visible always so the user can configure
            their preferred mode before turning polish on, disabled
            when off so the choice doesn't go off into the void. */}
        <fieldset className="space-y-3" disabled={modePending || !enabled}>
          <legend className="text-sm font-medium">Mode</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <ModeOption
              label="Intuitive"
              description="Tries to understand your intent and applies explicit self-corrections (“I mean…”, “scratch that…”). Best when you talk through a thought and want the polished result."
              value="intuitive"
              selected={mode === "intuitive"}
              onSelect={() => handleModeChange("intuitive")}
              disabled={modePending || !enabled}
            />
            <ModeOption
              label="Prescriptive"
              description="Conservative — only fixes punctuation, capitalization, and clear grammar. Never changes meaning or removes content. Best when you want verbatim with formatting."
              value="prescriptive"
              selected={mode === "prescriptive"}
              onSelect={() => handleModeChange("prescriptive")}
              disabled={modePending || !enabled}
            />
          </div>
          {modeResult && (
            <p
              className={cn(
                "text-sm",
                modeResult.ok ? "text-sage" : "text-destructive"
              )}
              role="status"
            >
              {modeResult.ok ? modeResult.message : modeResult.error}
            </p>
          )}
        </fieldset>
      </div>
    </Card>
  );
}

// Radio-style card pair for the polish mode picker. Visually highlights
// the selected mode with the peach accent; full-card tap target so the
// click region is generous on mobile.
function ModeOption({
  label,
  description,
  value,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  description: string;
  value: "intuitive" | "prescriptive";
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
      className={cn(
        "text-left rounded-xl border p-4 transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-peach-deep bg-peach/10"
          : "border-border/70 bg-background hover:bg-muted/50",
        disabled && "opacity-60 cursor-not-allowed"
      )}
    >
      <div className="flex items-center gap-2 font-medium text-sm">
        <span
          className={cn(
            "inline-block h-3 w-3 rounded-full border",
            selected ? "border-peach-deep bg-peach-deep" : "border-muted-foreground/40"
          )}
          aria-hidden
        />
        {label}
        <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {value}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{description}</p>
    </button>
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
