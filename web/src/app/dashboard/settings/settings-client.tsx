// Client bits for Settings. The page (RSC) fetches the current workspace state and
// passes values as defaults; this component handles submission + feedback.
//
// Layout: two top-level groups so the scope of each setting is obvious at
// a glance.
//   * Personal     — polish prefs + the user's vocabulary
//   * Workspace — name, auto-invite, leave/delete (admin gating)
// Card titles within each group are h3; the group label itself is h2,
// keeping the heading hierarchy semantic for screen readers.

"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  updateOrgName,
  updateAutoJoinDomain,
  setWorkspaceFeedback,
  leaveOrg,
  deleteOrg,
  setPolishEnabled,
  type ActionResult,
} from "./actions";
import { VocabularyCard, type VocabEntry } from "./vocabulary-card";


interface Props {
  orgName: string;
  orgSlug: string;
  autoJoinDomain: string | null;
  /** Current value of `organizations.feedback_disabled`. True = the
   *  Report bad transcription feature is OFF for this workspace. */
  feedbackDisabled: boolean;
  canAdmin: boolean;
  isSoleOwner: boolean;
  role: "owner" | "admin" | "member";
  /** Polish pref is per-user; passed from the server so first paint
   *  has the right value without a client-side fetch. */
  polishEnabled: boolean;
  vocabEntries: VocabEntry[];
}

export function SettingsClient({
  orgName,
  orgSlug,
  autoJoinDomain,
  feedbackDisabled,
  canAdmin,
  isSoleOwner,
  role,
  polishEnabled,
  vocabEntries,
}: Props) {
  return (
    <div className="space-y-12">
      <Group
        label="Personal"
        description="Settings that apply only to your cloud account and sync to your Mac on next launch."
      >
        <PolishCard enabled={polishEnabled} />
        <VocabularyCard entries={vocabEntries} />
      </Group>

      <Group
        label="Workspace"
        description="Settings that apply to everyone in this workspace."
      >
        <Card
          title="Workspace name"
          description="Shown in the sidebar and on invitation emails."
        >
          <TextFieldForm
            name="name"
            defaultValue={orgName}
            action={updateOrgName}
            disabled={!canAdmin}
            disabledNote={!canAdmin ? "Only owners and admins can edit." : undefined}
          />
        </Card>

        <Card
          title="Auto-invite by email domain"
          description="Anyone signing up with a matching email domain receives a pending invitation to this workspace and chooses Accept or Decline on first sign-in. Leave blank to turn off."
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

        <FeedbackCard
          disabled={feedbackDisabled}
          canAdmin={canAdmin}
        />

        <Card
          title="Leave workspace"
          description={
            isSoleOwner
              ? "You're the only owner. Promote someone else first, or delete the workspace below."
              : "Remove yourself from this workspace. Your transcription history on your Mac isn't affected."
          }
          danger
        >
          <LeaveButton disabled={isSoleOwner} />
        </Card>

        {role === "owner" && (
          <Card
            title="Delete workspace"
            description="Permanently removes the workspace, every member, every invitation, and all usage history. Cannot be undone."
            danger
          >
            <DeleteForm orgSlug={orgSlug} />
          </Card>
        )}
      </Group>
    </div>
  );
}

// --- building blocks -------------------------------------------------------

function Group({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="border-b border-border/60 pb-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-peach-deep">
          {label}
        </h2>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground max-w-2xl">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

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
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
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
        if (!window.confirm("Leave this workspace? You can be re-invited later.")) return;
        startTransition(async () => {
          await leaveOrg();
        });
      }}
    >
      {pending ? "Leaving…" : "Leave workspace"}
    </Button>
  );
}

// --- polish ---------------------------------------------------------------

function PolishCard({ enabled: serverEnabled }: { enabled: boolean }) {
  // Local mirror of the server state so the toggle shows optimistic
  // feedback without re-rendering the whole page from the RSC tree.
  // Polish is single-behavior now (the intuitive/prescriptive mode split
  // was retired — the server always uses the intuitive prompt), so the
  // only control is on/off.
  const [enabled, setEnabled] = useState(serverEnabled);
  const [toggleResult, setToggleResult] = useState<ActionResult | null>(null);
  const [togglePending, startToggleTransition] = useTransition();

  // Re-sync from server on revalidatePath so a second save picks up the
  // fresh state instead of the locally-stomped one.
  useEffect(() => {
    setEnabled(serverEnabled);
  }, [serverEnabled]);

  function handleToggle(next: boolean) {
    if (next === enabled) return;
    const fd = new FormData();
    fd.set("enabled", next ? "on" : "off");
    setToggleResult(null);
    // Optimistic flip so the switch animates immediately. Roll back on
    // server failure so the UI doesn't lie about persisted state.
    const previous = enabled;
    setEnabled(next);
    startToggleTransition(async () => {
      const r = await setPolishEnabled(fd);
      setToggleResult(r);
      if (!r.ok) setEnabled(previous);
    });
  }

  return (
    <Card
      title="Polish"
      description="A second pass that applies your spoken self-corrections (“I mean…”, “scratch that…”), removes false starts, and breaks long dictations into paragraphs. Adds a moment of processing after each dictation."
    >
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="polish-toggle"
          className="flex items-center gap-3 cursor-pointer select-none"
        >
          <Switch
            id="polish-toggle"
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={togglePending}
            aria-label="Polish each transcription"
          />
          <span className="text-sm font-medium">
            Polish each transcription
          </span>
        </label>
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
    </Card>
  );
}

// Workspace-scoped opt-out for "Report bad transcription". The
// underlying column is `feedback_disabled` (negative polarity) but the
// UI flips it so the toggle reads "Reporting" being on/off in plain
// terms. Members see the current state read-only; admins/owners get
// the toggle. Optimistic update with revert on action failure mirrors
// the polish toggle.
function FeedbackCard({
  disabled,
  canAdmin,
}: {
  disabled: boolean;
  canAdmin: boolean;
}) {
  const [reportingEnabled, setReportingEnabled] = useState<boolean>(!disabled);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function handleToggle(next: boolean) {
    if (next === reportingEnabled) return;
    setResult(null);
    const previous = reportingEnabled;
    setReportingEnabled(next); // optimistic
    const fd = new FormData();
    fd.set("enabled", next ? "on" : "off");
    startTransition(async () => {
      const r = await setWorkspaceFeedback(fd);
      setResult(r);
      if (!r.ok) setReportingEnabled(previous);
    });
  }

  return (
    <Card
      title="Report bad transcription"
      description="When on, users in this workspace can submit a transcription for quality review from History in the Mac app. Audio + texts are sent to Speakist support and used only for transcription accuracy improvements. Turn off to hide the Report button and refuse new submissions for everyone in the workspace."
    >
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="feedback-toggle"
          className={
            "flex items-center gap-3 select-none " +
            (canAdmin ? "cursor-pointer" : "cursor-not-allowed opacity-70")
          }
        >
          <Switch
            id="feedback-toggle"
            checked={reportingEnabled}
            onCheckedChange={handleToggle}
            disabled={!canAdmin || pending}
            aria-label="Allow workspace members to report bad transcriptions"
          />
          <span className="text-sm font-medium">
            {reportingEnabled
              ? "Reporting is on for this workspace"
              : "Reporting is off for this workspace"}
          </span>
        </label>
        {result && (
          <p
            className={cn(
              "text-sm",
              result.ok ? "text-sage" : "text-destructive"
            )}
            role="status"
          >
            {result.ok ? result.message : result.error}
          </p>
        )}
      </div>
      {!canAdmin && (
        <p className="mt-3 text-xs text-muted-foreground">
          Only owners and admins can change this.
        </p>
      )}
    </Card>
  );
}

// Radio-style card pair for the polish mode picker. Visually highlights
// the selected mode with the peach accent; full-card tap target so the
// click region is generous on mobile.
function DeleteForm({ orgSlug }: { orgSlug: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(fd) => {
        if (
          !window.confirm(
            "This deletes your workspace, members, invitations, and history. Continue?"
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
        {pending ? "Deleting…" : "Delete workspace"}
      </Button>
      {result && !result.ok && (
        <p className="text-sm text-destructive basis-full">{result.error}</p>
      )}
    </form>
  );
}
