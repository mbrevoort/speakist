// Client bits for Settings. The page (RSC) fetches the current org state and
// passes values as defaults; this component handles submission + feedback.

"use client";

import { useEffect, useState, useTransition } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  updateOrgName,
  updateAutoJoinDomain,
  leaveOrg,
  deleteOrg,
  setPolishEnabled,
  setPolishMode,
  setPolishPrompt,
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
  polishPrompt: string;
  polishIsCustom: boolean;
  polishDefaultPrompt: string;
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
  polishPrompt,
  polishIsCustom,
  polishDefaultPrompt,
}: Props) {
  return (
    <div className="space-y-10">
      <PolishCard
        enabled={polishEnabled}
        mode={polishMode}
        prompt={polishPrompt}
        isCustom={polishIsCustom}
        defaultPrompt={polishDefaultPrompt}
      />

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
  prompt: serverPrompt,
  isCustom: serverIsCustom,
  defaultPrompt,
}: {
  enabled: boolean;
  mode: PolishMode;
  prompt: string;
  isCustom: boolean;
  defaultPrompt: string;
}) {
  // Local mirrors of the server state so toggle / save / reset can show
  // optimistic feedback without re-rendering the whole page from the RSC
  // tree. Each successful action mutates these in-place.
  const [enabled, setEnabled] = useState(serverEnabled);
  const [mode, setMode] = useState<PolishMode>(serverMode);
  const [isCustom, setIsCustom] = useState(serverIsCustom);
  const [draft, setDraft] = useState(serverPrompt);
  const [savedPrompt, setSavedPrompt] = useState(serverPrompt);

  const [toggleResult, setToggleResult] = useState<ActionResult | null>(null);
  const [modeResult, setModeResult] = useState<ActionResult | null>(null);
  const [promptResult, setPromptResult] = useState<ActionResult | null>(null);
  const [togglePending, startToggleTransition] = useTransition();
  const [modePending, startModeTransition] = useTransition();
  const [promptPending, startPromptTransition] = useTransition();

  // If the page is re-rendered server-side (e.g. revalidatePath), pick up
  // the new server values. Without this, the second save in a row would
  // get the stale server state if React decided to re-mount.
  useEffect(() => {
    setEnabled(serverEnabled);
    setMode(serverMode);
    setIsCustom(serverIsCustom);
    setSavedPrompt(serverPrompt);
    // Only stomp the editor when the user hasn't started a fresh edit;
    // otherwise we'd lose in-flight changes on every revalidate.
    setDraft((current) =>
      current === savedPrompt ? serverPrompt : current
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverEnabled, serverMode, serverIsCustom, serverPrompt]);

  const draftIsDirty = draft !== savedPrompt;
  const draftIsBlank = draft.trim().length === 0;

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
    // Optimistic — flip the local state immediately so the UI reflects
    // the choice instantly. If the action fails, we roll back below.
    const previous = mode;
    setMode(next);
    startModeTransition(async () => {
      const r = await setPolishMode(fd);
      setModeResult(r);
      if (!r.ok) setMode(previous);
    });
  }

  function handleSave() {
    const fd = new FormData();
    fd.set("prompt", draft);
    setPromptResult(null);
    startPromptTransition(async () => {
      const r = await setPolishPrompt(fd);
      setPromptResult(r);
      if (r.ok) {
        setSavedPrompt(draft);
        setIsCustom(true);
      }
    });
  }

  function handleReset() {
    if (!isCustom) return;
    if (!window.confirm("Reset to the default polish prompt? Your customizations will be lost.")) {
      return;
    }
    const fd = new FormData();
    fd.set("prompt", "");
    setPromptResult(null);
    startPromptTransition(async () => {
      const r = await setPolishPrompt(fd);
      setPromptResult(r);
      if (r.ok) {
        setDraft(defaultPrompt);
        setSavedPrompt(defaultPrompt);
        setIsCustom(false);
      }
    });
  }

  return (
    <Card
      title="Polish"
      description="Routes every transcription through a small LLM to add punctuation, capitalization, and clear grammar fixes. Pick a mode below to control how aggressive the cleanup is."
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

        {/* Mode picker — only relevant when polish is enabled, but
            still shown when off so the user can configure their
            preferred mode before flipping it on. */}
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

        <div>
          <label className="text-sm font-medium" htmlFor="polish-prompt">
            System prompt
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {isCustom
              ? "You're using a custom prompt — applied regardless of mode. Reset below to go back to the mode's server default."
              : "You're using the server default for the selected mode. Switching modes above swaps the default prompt; editing and saving below pins a custom prompt that overrides both modes."}
          </p>
          <textarea
            id="polish-prompt"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!enabled || promptPending}
            rows={14}
            className={cn(
              "mt-2 w-full rounded-xl border border-input bg-background px-4 py-3 text-sm font-mono leading-relaxed",
              "outline-none focus:ring-2 focus:ring-ring",
              "disabled:opacity-60"
            )}
            spellCheck={false}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleSave}
              disabled={!enabled || promptPending || !draftIsDirty || draftIsBlank}
            >
              {promptPending ? "Saving…" : "Save prompt"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleReset}
              disabled={!isCustom || promptPending}
            >
              <RotateCcw className="h-4 w-4" />
              Reset to default
            </Button>
            {promptResult && (
              <p
                className={cn(
                  "text-sm",
                  promptResult.ok ? "text-sage" : "text-destructive"
                )}
                role="status"
              >
                {promptResult.ok ? promptResult.message : promptResult.error}
              </p>
            )}
          </div>
        </div>
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
