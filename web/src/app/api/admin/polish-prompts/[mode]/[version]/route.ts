// GET /api/admin/polish-prompts/[mode]/[version]
//
// Fetch the full body for a specific (mode, version) pair. Used by
// the admin UI's "View body" / "Roll back to this" affordances and
// by anything else that needs to compare bodies between versions.
//
// Super-admin USER auth only.

import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import {
  getPromptByVersion,
  type PolishPromptMode,
} from "@/lib/polish-prompts";

const ALLOWED_MODES: readonly PolishPromptMode[] = [
  "intuitive",
  "prescriptive",
];

export async function GET(
  req: Request,
  {
    params,
  }: { params: Promise<{ mode: string; version: string }> }
): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { mode: rawMode, version: rawVersion } = await params;
  if (!ALLOWED_MODES.includes(rawMode as PolishPromptMode)) {
    return Response.json(
      { error: `unknown mode: ${rawMode}` },
      { status: 400 }
    );
  }
  const version = Number(rawVersion);
  if (!Number.isInteger(version) || version < 1) {
    return Response.json(
      { error: "version must be a positive integer" },
      { status: 400 }
    );
  }

  const row = await getPromptByVersion(
    rawMode as PolishPromptMode,
    version
  );
  if (!row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({
    id: row.id,
    mode: row.mode,
    version: row.version,
    body: row.body,
    notes: row.notes,
    source: row.source,
    is_active: row.isActive,
    bench_score: row.benchScore,
    bench_results: row.benchResults,
    rolled_back_from_version_id: row.rolledBackFromVersionId,
    created_at: row.createdAt.toISOString(),
    created_by_user_id: row.createdByUserId,
    created_by_token_id: row.createdByTokenId,
  });
}
