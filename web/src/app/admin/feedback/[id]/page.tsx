// Admin → Feedback detail.
//
// Side-by-side diff (raw → polished → expected), audio playback when
// the user shared it, kind/note, and the triage editor (status +
// resolution). The form posts to PATCH /api/admin/feedback/[id]
// rather than running a server action so we can cleanly reuse the
// same path the future Phase-3 agent will use.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import { getFeedbackById, exportToFixtureSeeds } from "@/lib/feedback";
import { TriageForm } from "./triage-form";
import { FixtureExportButton } from "./fixture-export-button";
import { DeleteFeedbackButton } from "./delete-button";

export const metadata = { title: "Feedback report — Admin" };

export default async function AdminFeedbackDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const row = await getFeedbackById(id);
  if (!row) {
    notFound();
  }

  const [seed] = exportToFixtureSeeds([
    {
      id: row.id,
      createdAt: row.createdAt,
      rawText: row.rawText,
      polishedText: row.polishedText,
      expectedText: row.expectedText,
      failureKind: row.failureKind,
      userNote: row.userNote,
    },
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admin/feedback"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to feedback
      </Link>

      <PageHeader
        title="Feedback report"
        description={`Submitted by ${row.userEmail} · ${row.orgName} · ${row.createdAt.toLocaleString()}`}
      />

      {/* Texts side-by-side. Raw / polished / expected rendered as
          monospace blocks so whitespace differences are visible. */}
      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <TextBlock title="Raw STT" body={row.rawText} />
        <TextBlock title="Polished (delivered)" body={row.polishedText} />
        <TextBlock
          title="Expected (user)"
          body={row.expectedText}
          highlight
        />
      </div>

      {/* Context strip — provider / model / kind / note / audio */}
      <div className="rounded-2xl border border-border/70 bg-background p-5 mb-6">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <Field label="Provider · Model" value={`${row.provider} · ${row.model}`} />
          <Field
            label="Polish"
            value={
              row.polishApplied
                ? `applied (${row.polishMode ?? "?"})`
                : "skipped"
            }
          />
          <Field
            label="Audio length"
            value={
              row.audioSeconds !== null
                ? `${row.audioSeconds.toFixed(1)}s`
                : "—"
            }
          />
          <Field label="Failure kind" value={row.failureKind ?? "—"} />
          <Field
            label="X-Transcription-Id"
            value={row.transcriptionClientId}
            mono
          />
          <Field
            label="Note"
            value={row.userNote ?? "—"}
            full
          />
        </dl>
      </div>

      {row.hasAudio && (
        <div className="rounded-2xl border border-border/70 bg-background p-5 mb-6">
          <h3 className="text-sm font-semibold mb-3">Audio recording</h3>
          {/* Browser <audio> hits /api/admin/feedback/[id]/audio,
              which streams from R2 through the super-admin gate. No
              presigned URL — every fetch is session-checked. */}
          <audio
            controls
            preload="none"
            className="w-full"
            src={`/api/admin/feedback/${row.id}/audio`}
          >
            Your browser doesn&apos;t support audio playback.
          </audio>
        </div>
      )}

      {/* Triage editor */}
      <div className="rounded-2xl border border-border/70 bg-background p-5 mb-6">
        <h3 className="text-sm font-semibold mb-3">Triage</h3>
        <TriageForm
          id={row.id}
          status={row.status}
          resolution={row.resolution}
          reviewedAt={row.reviewedAt}
        />
      </div>

      {/* Fixture-seed export. Single-row download / copy so the
          operator can bring the feedback into polish-fixtures.ts on
          their own machine. The Phase-3 agent will read directly
          from the DB and won't need this path. */}
      <div className="rounded-2xl border border-border/70 bg-background p-5">
        <h3 className="text-sm font-semibold mb-3">
          Export as polish-fixtures seed
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Hand-curate this into a fixture entry, run{" "}
          <code className="font-mono text-xs">pnpm bench:polish</code>, then
          open a PR with the prompt edit.
        </p>
        <FixtureExportButton seed={seed} />
      </div>

      {/* Danger zone — escape hatch for reports that shouldn't have
          been kept (abuse, accidental sensitive content, "loot"
          submissions). Drops the DB row + R2 audio object. */}
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 mt-6">
        <h3 className="text-sm font-semibold mb-1 text-destructive">
          Danger zone
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Permanently removes this report from the corpus, including the
          audio recording. Use for spam, abuse, or accidentally-shared
          sensitive content.
        </p>
        <DeleteFeedbackButton id={row.id} />
      </div>
    </div>
  );
}

function TextBlock({
  title,
  body,
  highlight,
}: {
  title: string;
  body: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background p-4">
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h4>
      <pre
        className={
          "whitespace-pre-wrap break-words text-xs font-mono " +
          (highlight ? "text-foreground" : "text-foreground/80")
        }
      >
        {body || "(empty)"}
      </pre>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? "lg:col-span-4 sm:col-span-2" : ""}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          "mt-0.5 text-sm break-words " + (mono ? "font-mono" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}
