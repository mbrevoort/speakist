// DELETE /api/admin/tokens/[id]
//
// Soft-delete (revoke) a service token. The row stays for audit; the
// `revoked_at` stamp is what matters at verify time. Idempotent —
// revoking an already-revoked token returns 200.

import { AuthzError, requireSuperAdminFromRequest } from "@/lib/authz";
import { revokeServiceToken } from "@/lib/service-tokens";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireSuperAdminFromRequest(req);
  } catch (err) {
    if (err instanceof AuthzError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "missing_id" }, { status: 400 });
  }
  await revokeServiceToken(id);
  return Response.json({ ok: true });
}
