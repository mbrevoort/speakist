// Admin → Service tokens.
//
// Super-admin mints/lists/revokes the bearer tokens that scheduled
// agents use to call /api/admin/feedback* and /api/mcp. See
// lib/service-tokens.ts for the model + auth rules.
//
// UI surface:
//
//   * One "Create token" form at the top with a label + scope
//     checklist. After submit, the plaintext is shown ONCE in a
//     persistent reveal panel until the operator dismisses it.
//   * Below: a table of every token (active + revoked). Active rows
//     have a Revoke button; revoked rows show their revoke time.
//
// The plaintext reveal is intentionally noisy. We never show the
// plaintext again — the DB only has SHA-256 — so the operator has
// exactly one chance to copy it.

import { PageHeader } from "@/components/dashboard/page-header";
import { requireSuperAdmin } from "@/lib/authz";
import {
  listServiceTokens,
  SERVICE_SCOPES,
  type TokenListRow,
} from "@/lib/service-tokens";
import { TokenManager } from "./token-manager";

export const metadata = { title: "Service tokens — Admin" };

export default async function AdminTokensPage() {
  await requireSuperAdmin();
  const tokens = await listServiceTokens();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Service tokens"
        description="Bearer tokens for non-browser callers (scheduled agents, scripts). One token per consumer; scope each one tightly. The plaintext is shown exactly once at creation — copy it then or mint a replacement."
      />
      <TokenManager
        initialTokens={serializeForClient(tokens)}
        availableScopes={[...SERVICE_SCOPES]}
      />
    </div>
  );
}

/** Server → client boundary: Date instances need to cross as ISO
 *  strings since the client component can't accept non-serializable
 *  values directly. */
function serializeForClient(rows: TokenListRow[]): SerializedToken[] {
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    scopes: r.scopes,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdByEmail: r.createdByEmail,
  }));
}

export interface SerializedToken {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdByEmail: string | null;
}
