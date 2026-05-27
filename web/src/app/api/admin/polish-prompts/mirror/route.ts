// POST /api/admin/polish-prompts/mirror
//
// Prod-side sender for the prod → dev polish-prompt mirror. Auth-gates
// the caller (super admin, cookie or Mac-app bearer) and hands off to
// lib/polish-prompts-mirror.ts:mirrorActivePromptToDev — the same
// helper the /admin/polish-prompts "Mirror → dev" server action calls.
//
// Service tokens are deliberately NOT accepted here: mirroring is a
// human-driven decision; an agent can't decide what crosses
// environments.
//
// One-time setup is documented in docs/polish-prompt-mirror.md.

import { z } from "zod";
import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import {
  ALL_MODES,
  type PolishPromptMode,
} from "@/lib/polish-prompts";
import { mirrorActivePromptToDev } from "@/lib/polish-prompts-mirror";

const bodySchema = z.object({
  mode: z.enum(ALL_MODES as readonly [PolishPromptMode, ...PolishPromptMode[]]),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const result = await mirrorActivePromptToDev(parsed.data.mode);
  if (!result.ok) {
    return Response.json(
      {
        error: result.error,
        detail: result.detail,
        ...(result.error === "dev_rejected" && result.devStatus != null
          ? { dev_status: result.devStatus }
          : {}),
      },
      { status: result.status }
    );
  }
  return Response.json({
    ok: true,
    source_version: result.sourceVersion,
    source_bench_score: result.sourceBenchScore,
    dev_id: result.devId,
    dev_version: result.devVersion,
  });
}
