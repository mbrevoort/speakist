-- Service tokens for non-browser callers (cron-driven agents, scripts).
--
-- Auth.js handles browser sessions and the Mac/iOS app uses bearer
-- refresh tokens; both flow through `requireUserFromRequest` and end
-- up tied to a user id. A scheduled-agent caller doesn't sign in
-- interactively, so it needs its own auth surface — that's what this
-- table is for.
--
-- A super-admin mints a token at /admin/tokens, gets the plaintext
-- value exactly once, configures their agent with it, and the agent
-- presents it as `Authorization: Bearer ssat_<plaintext>` on calls
-- to /api/admin/feedback* and /api/mcp. The DB only ever stores a
-- SHA-256 hash of the plaintext, so leaking the table doesn't leak
-- working tokens. (SHA-256 of a 24-byte random value is fine without
-- bcrypt-style stretching — the input has 192 bits of entropy, far
-- past the brute-force threshold the slow hash would defend.)
--
-- Scope model: each token carries a JSON array of scope strings.
-- Endpoints declare what scope they require; the auth helper checks
-- the intersection. Initial scopes:
--
--   feedback:read    — list / get / audio
--   feedback:triage  — patch status/resolution + delete
--
-- Scopes are additive (you can mint a read-only token without triage).
-- The token row is never deleted — revoking sets `revoked_at` and the
-- verifier rejects revoked tokens. Keeps the audit trail intact.

CREATE TABLE service_tokens (
  id TEXT PRIMARY KEY,
  -- Operator-supplied label so multiple tokens can be told apart in
  -- the listing view. Free-text up to ~80 chars.
  label TEXT NOT NULL,
  -- SHA-256 hex of the plaintext token (lowercase, 64 hex chars). UNIQUE
  -- so verifyToken can index-lookup rather than scanning.
  token_hash TEXT NOT NULL UNIQUE,
  -- JSON array of scope strings: ["feedback:read","feedback:triage"].
  -- App-layer parses + validates; SQLite has no native JSON type but
  -- the glue is one JSON.parse call.
  scopes_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- Bumped on every successful verify so the listing shows fresh-vs-
  -- stale tokens. Eventual consistency is fine; we don't await this.
  last_used_at INTEGER,
  -- Soft-delete. NULL = active; set timestamp = revoked. Verifier
  -- treats non-NULL as a hard reject regardless of hash match.
  revoked_at INTEGER
);

-- Listing view sorts active tokens (revoked_at IS NULL) newest-first,
-- then archived ones at the bottom. Single index covers both with the
-- where clause filtering at scan time.
CREATE INDEX service_tokens_created_idx
  ON service_tokens(created_at DESC);
