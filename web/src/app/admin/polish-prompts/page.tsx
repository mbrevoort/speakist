// Admin → Polish prompts.
//
// Per-mode (intuitive + prescriptive) view of:
//   * The currently active prompt — version, source, bench score, body
//     preview, full-body modal.
//   * Version history — newest first, with View body / Roll back per
//     row.
//   * "New version" editor — pre-fills with the current active body
//     so admins can tweak from where prod is rather than from scratch.
//
// Every mutation (admin edit, rollback) flows through
// lib/polish-prompts.ts so the active-row invariant and version
// counter stay correct, and (after PR 3) so the Slack notification
// fires.

import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import {
  getActivePrompt,
  listVersions,
  type PolishPromptMode,
  type PromptVersion,
} from "@/lib/polish-prompts";
import { bakedInPromptForMode } from "@/lib/transcription/polish";
import { PromptManager, type SerializedVersion } from "./prompt-manager";

export const metadata = { title: "Polish prompts — Admin" };

interface ModeBundle {
  mode: PolishPromptMode;
  active: SerializedVersion | null;
  history: SerializedVersion[];
  /** Used as the baseline body for the "Create new" textarea when
   *  there's no active version yet (fresh install). Surfaced as the
   *  "what's currently being served" reference. */
  bakedIn: string;
}

export default async function AdminPolishPromptsPage() {
  await requireSuperAdmin();

  const bundles: ModeBundle[] = await Promise.all(
    (["intuitive", "prescriptive"] as PolishPromptMode[]).map(
      async (mode) => {
        const [active, history] = await Promise.all([
          getActivePrompt(mode),
          listVersions(mode, { limit: 50 }),
        ]);
        return {
          mode,
          active: active ? serializeForClient(active) : null,
          history: history.map(serializeForClient),
          bakedIn: bakedInPromptForMode(mode),
        };
      }
    )
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader
        title="Polish prompts"
        description="Active learning loop seed + history. Every change — admin edit, agent proposal, rollback, cross-env mirror — creates a new version. The current active row is what /api/transcribe serves."
      />
      <PromptManager bundles={bundles} />
    </div>
  );
}

/** Server → client boundary: Date instances need to cross as ISO
 *  strings since the client component can't accept non-serializable
 *  values directly. bench_results stays as the parsed JSON object
 *  (or null) — it's already structurally cloneable. */
function serializeForClient(v: PromptVersion): SerializedVersion {
  return {
    id: v.id,
    mode: v.mode,
    version: v.version,
    body: v.body,
    notes: v.notes,
    source: v.source,
    isActive: v.isActive,
    rolledBackFromVersionId: v.rolledBackFromVersionId,
    benchScore: v.benchScore,
    benchResults: v.benchResults,
    createdAt: v.createdAt.toISOString(),
    createdByUserId: v.createdByUserId,
    createdByTokenId: v.createdByTokenId,
  };
}
