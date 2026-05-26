// POST /api/admin/polish-prompts/mirror-receive
//
// Dev-side receiver for the prod → dev polish-prompt mirror. Bearer-
// authed against an `ssat_…` service token holding `prompts:write`,
// minted on this environment's /admin/tokens page. The sender (on
// prod) posts here with the active prompt's body + metadata; we
// create a new version locally with source='mirror' and notes
// prefixed `"Mirrored from prod v{N}"` so the timeline is
// self-describing.
//
// Why a separate endpoint rather than re-using `propose_polish_prompt`
// (the MCP tool with the same scope): the mirror's notes prefix and
// source value are different, and the Slack notification this
// triggers (via insertActiveVersion) reads the source field to pick
// its header emoji. Keeping a dedicated route lets us label the
// provenance correctly without overloading propose with cross-env
// semantics.
//
// One-time setup, plus the failure modes you'll hit if you skip
// any step, lives in docs/polish-prompt-mirror.md.

import { z } from "zod";
import { extractBearer } from "@/lib/bearer";
import {
  TOKEN_PREFIX,
  verifyServiceToken,
} from "@/lib/service-tokens";
import {
  ALL_MODES,
  createVersion,
  type PolishPromptMode,
} from "@/lib/polish-prompts";

const bodySchema = z.object({
  mode: z.enum(ALL_MODES as readonly [PolishPromptMode, ...PolishPromptMode[]]),
  /** Same soft minimum the propose tool enforces — anything shorter
   *  cannot plausibly carry the required <dictation>-tag + never-
   *  respond contract. */
  body: z.string().min(50).max(20_000),
  notes: z.string().max(2000).optional(),
  /** The version number this row had in the source environment.
   *  Surfaced in the notes prefix so the dev row is self-describing. */
  source_version: z.number().int().min(1),
  /** Carries the source's bench score forward verbatim so the
   *  receiving env's admin UI shows the same number. NULL preserves
   *  "no bench was run" semantics. */
  source_bench_score: z.number().min(0).max(1).optional(),
});

export async function POST(req: Request): Promise<Response> {
  // ---- auth -----------------------------------------------------------------
  // Service-token bearer with prompts:write. Mirrors the MCP route's
  // auth flow rather than going through requireSuperAdminFromRequest
  // (which only handles user sessions + Mac-app refresh tokens).
  const bearer = extractBearer(req);
  if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) {
    return Response.json(
      { error: "missing or wrong-type bearer (expected ssat_…)" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }
  const verified = await verifyServiceToken(bearer);
  if (!verified) {
    return Response.json(
      { error: "invalid or revoked service token" },
      { status: 401 }
    );
  }
  if (!verified.scopes.includes("prompts:write")) {
    return Response.json(
      { error: "service token missing required scope: prompts:write" },
      { status: 403 }
    );
  }

  // ---- body validation ------------------------------------------------------
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { mode, body, notes, source_version, source_bench_score } =
    parsed.data;

  // ---- write ----------------------------------------------------------------
  // Note prefix is unconditional — the timeline must always show this
  // row came from a mirror, even if the source had no notes of its
  // own. Caller's notes are appended below the prefix.
  const noteParts = [`Mirrored from prod v${source_version}`];
  if (notes && notes.trim().length > 0) {
    noteParts.push("---", notes.trim());
  }
  const mergedNotes = noteParts.join("\n");

  const v = await createVersion({
    mode,
    body,
    notes: mergedNotes,
    source: "mirror",
    createdByTokenId: verified.id,
    benchScore: source_bench_score,
  });

  return Response.json({
    id: v.id,
    mode: v.mode,
    version: v.version,
    is_active: v.isActive,
  });
}
