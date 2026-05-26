// Super-admin service-token management.
//
// GET   /api/admin/tokens          → list all tokens (active + revoked)
// POST  /api/admin/tokens          → mint a new token; plaintext returned
//                                     in the response (shown once in UI)
//
// Both endpoints require an authenticated super-admin USER session.
// We deliberately don't accept service tokens for self-management —
// that would let a single leaked token mint replacements indefinitely.

import { z } from "zod";
import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import {
  createServiceToken,
  listServiceTokens,
  SERVICE_SCOPES,
} from "@/lib/service-tokens";

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(SERVICE_SCOPES))
    .min(1)
    .max(SERVICE_SCOPES.length),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const tokens = await listServiceTokens();
  return Response.json({ tokens });
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "bad_body", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const created = await createServiceToken({
    label: parsed.data.label,
    scopes: parsed.data.scopes,
    createdBy: user.id,
  });
  return Response.json(created);
}
