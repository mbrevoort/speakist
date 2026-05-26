// GET /api/admin/polish-prompts
//
// Returns the currently active prompt for each mode (intuitive +
// prescriptive). Used by:
//
//   * /admin/polish-prompts dashboard for the at-a-glance summary.
//   * PR 4's mirror sender (prod side) to fetch what to push to dev.
//   * Any future monitoring / alerting that wants to ask "what's
//     prod serving right now?" from outside the Worker.
//
// Super-admin USER auth only. Service tokens go through the MCP
// surface in PR 3, not this REST route — that keeps the boundary
// clean (admin UI = cookies, agents = bearer + MCP).

import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import { getActivePrompt } from "@/lib/polish-prompts";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const [intuitive, prescriptive] = await Promise.all([
    getActivePrompt("intuitive"),
    getActivePrompt("prescriptive"),
  ]);

  return Response.json({
    intuitive: serializeActive(intuitive),
    prescriptive: serializeActive(prescriptive),
  });
}

function serializeActive(
  v: Awaited<ReturnType<typeof getActivePrompt>>
): unknown {
  if (!v) return null;
  return {
    id: v.id,
    mode: v.mode,
    version: v.version,
    body: v.body,
    notes: v.notes,
    source: v.source,
    bench_score: v.benchScore,
    created_at: v.createdAt.toISOString(),
  };
}
