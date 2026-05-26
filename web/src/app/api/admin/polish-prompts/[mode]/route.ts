// GET /api/admin/polish-prompts/[mode]
//
// List versions for one mode, newest first. Mirrors the MCP
// `list_polish_prompt_versions` tool's projection — body is omitted
// so the listing payload stays compact; callers hit the
// `[mode]/[version]` endpoint when they actually need a body.
//
// Super-admin USER auth only.

import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import {
  ALL_MODES,
  listVersions,
  type PolishPromptMode,
  type PromptVersion,
} from "@/lib/polish-prompts";
import { truncate } from "@/lib/utils";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ mode: string }> }
): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { mode: rawMode } = await params;
  if (!ALL_MODES.includes(rawMode as PolishPromptMode)) {
    return Response.json(
      { error: `unknown mode: ${rawMode}` },
      { status: 400 }
    );
  }
  const mode = rawMode as PolishPromptMode;

  // Optional `?limit=` (1..200, default 50). Mirrors the domain
  // helper's bounds; the helper clamps too, but parsing here gives
  // a clear 400 on garbage rather than silently snapping.
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      return Response.json(
        { error: "limit must be 1..200" },
        { status: 400 }
      );
    }
    limit = Math.floor(n);
  }

  const rows = await listVersions(mode, { limit });
  return Response.json({
    items: rows.map(projectForListing),
    count: rows.length,
  });
}

/** Compact projection for the listing surface. Body is intentionally
 *  omitted — clients call the `[version]` route for the full text. */
function projectForListing(v: PromptVersion) {
  return {
    id: v.id,
    version: v.version,
    source: v.source,
    is_active: v.isActive,
    bench_score: v.benchScore,
    rolled_back_from_version_id: v.rolledBackFromVersionId,
    notes_preview: v.notes ? truncate(v.notes, 160) : null,
    created_at: v.createdAt.toISOString(),
    created_by_user_id: v.createdByUserId,
    created_by_token_id: v.createdByTokenId,
  };
}

