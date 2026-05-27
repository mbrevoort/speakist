// Mint, verify, list, revoke service tokens.
//
// Tokens authenticate non-browser callers — primarily the scheduled
// polish-fixture proposer agent. See migration 0019 for the column
// model. A super-admin creates tokens at /admin/tokens, stamps them
// with a label + scope set, and configures the agent with the
// plaintext value (shown ONCE at creation time).
//
// Auth flow: the agent presents `Authorization: Bearer ssat_<value>`
// on requests to /api/admin/feedback* and /api/mcp. The verifier
// hashes the incoming value, looks up the row by `token_hash`, and
// checks (1) it exists, (2) it isn't revoked, (3) the requested
// scope is in the token's scopes array. On success it bumps
// `last_used_at` (fire-and-forget — we don't want auth latency
// gated on a write).

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { serviceTokens, users } from "@/lib/db/schema";
import { base64UrlEncode } from "@/lib/base64";
import { hashToken } from "@/lib/hash";

/** Scopes a service token can carry. Add a new value here AND on the
 *  admin form before requiring it on an endpoint. */
export const SERVICE_SCOPES = [
  "feedback:read",
  "feedback:triage",
  // Polish-prompt versioning. `prompts:read` covers the three
  // read-only MCP tools (get_active, list, get_version);
  // `prompts:write` is required for `propose_polish_prompt` which
  // creates a new active version with source='agent'. Rollback is
  // admin-UI-only and intentionally not exposed via MCP — the agent
  // shouldn't be able to undo a human decision.
  "prompts:read",
  "prompts:write",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

/** Plaintext token prefix. Lets the bearer dispatcher recognize a
 *  service token at a glance and route it through the right verifier
 *  (vs. the Mac/iOS refresh-token bearer or Auth.js session token). */
export const TOKEN_PREFIX = "ssat_";

/** 192 bits of entropy in the random part — far past the brute-force
 *  threshold a slow-hash like bcrypt would defend against, so the
 *  hash on the DB side can be a single SHA-256. */
const TOKEN_ENTROPY_BYTES = 24;
const LABEL_MAX_LENGTH = 80;

export function generatePlaintextToken(): string {
  const bytes = new Uint8Array(TOKEN_ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64UrlEncode(bytes);
}

export interface CreateTokenArgs {
  label: string;
  scopes: ServiceScope[];
  createdBy: string;
}

export interface CreatedToken {
  id: string;
  /** Plaintext shown to the operator exactly once. The DB only stores
   *  the hash; once the operator dismisses the page the value is
   *  unrecoverable by anyone. */
  plaintext: string;
}

export async function createServiceToken(args: CreateTokenArgs): Promise<CreatedToken> {
  if (!args.label.trim()) {
    throw new Error("label required");
  }
  for (const s of args.scopes) {
    if (!SERVICE_SCOPES.includes(s)) {
      throw new Error(`unknown scope: ${s}`);
    }
  }
  const plaintext = generatePlaintextToken();
  const tokenHash = await hashToken(plaintext);
  const db = getDb();
  const [row] = await db
    .insert(serviceTokens)
    .values({
      label: args.label.trim().slice(0, LABEL_MAX_LENGTH),
      tokenHash,
      scopesJson: JSON.stringify(args.scopes),
      createdBy: args.createdBy,
    })
    .returning({ id: serviceTokens.id });
  return { id: row.id, plaintext };
}

export interface VerifiedToken {
  id: string;
  scopes: ServiceScope[];
  createdBy: string;
}

/** Look up a plaintext bearer value, return the matching active token
 *  on success or null on any failure (no row, revoked, malformed
 *  scopes JSON). Always returns null rather than throwing so callers
 *  can distinguish "no auth" from "wrong auth" via the bearer prefix.
 *
 *  Side effect: bumps `last_used_at` on a successful match. The write
 *  is fire-and-forget via `.catch(() => {})` so verifier latency is
 *  bounded by a single SHA-256 + index lookup. */
export async function verifyServiceToken(plaintext: string): Promise<VerifiedToken | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = await hashToken(plaintext);
  const db = getDb();
  const [row] = await db
    .select({
      id: serviceTokens.id,
      scopesJson: serviceTokens.scopesJson,
      createdBy: serviceTokens.createdBy,
      revokedAt: serviceTokens.revokedAt,
    })
    .from(serviceTokens)
    .where(eq(serviceTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.revokedAt) return null;

  let scopes: ServiceScope[];
  try {
    const parsed = JSON.parse(row.scopesJson);
    if (!Array.isArray(parsed)) return null;
    scopes = parsed.filter((s): s is ServiceScope =>
      SERVICE_SCOPES.includes(s as ServiceScope)
    );
  } catch {
    return null;
  }

  // Fire-and-forget last_used_at bump. Same accept-loss pattern as
  // Mac sessions in lib/authz.ts:userFromBearer — if the write drops
  // (e.g., Worker terminates before D1 ack lands) the token still
  // authorized this request; the operator just won't see a fresh
  // timestamp in the listing.
  db.update(serviceTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(serviceTokens.id, row.id))
    .catch((err) => console.error("[service-tokens] last_used_at bump failed:", err));

  return { id: row.id, scopes, createdBy: row.createdBy };
}

export interface TokenListRow {
  id: string;
  label: string;
  scopes: ServiceScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdByEmail: string | null;
}

/** All tokens, active and revoked. UI sorts active first then archived. */
export async function listServiceTokens(): Promise<TokenListRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: serviceTokens.id,
      label: serviceTokens.label,
      scopesJson: serviceTokens.scopesJson,
      createdAt: serviceTokens.createdAt,
      lastUsedAt: serviceTokens.lastUsedAt,
      revokedAt: serviceTokens.revokedAt,
      createdByEmail: users.email,
    })
    .from(serviceTokens)
    .leftJoin(users, eq(users.id, serviceTokens.createdBy))
    // Active first (revoked_at IS NULL), then archived. Within each
    // group, newest-first.
    .orderBy(asc(serviceTokens.revokedAt), desc(serviceTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    scopes: parseScopes(r.scopesJson),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdByEmail: r.createdByEmail,
  }));
}

/** Mark a token revoked. Idempotent — re-revoking a revoked token
 *  is a no-op and still returns ok. */
export async function revokeServiceToken(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(serviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(serviceTokens.id, id), isNull(serviceTokens.revokedAt)))
    .returning({ id: serviceTokens.id });
  return result.length > 0;
}

// ---- helpers --------------------------------------------------------------

function parseScopes(s: string): ServiceScope[] {
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is ServiceScope =>
      SERVICE_SCOPES.includes(v as ServiceScope)
    );
  } catch {
    return [];
  }
}
