-- Versioned polish prompts — the storage half of the active learning loop.
--
-- Before this migration, the two polish-mode prompts (intuitive +
-- prescriptive) were either baked into lib/transcription/polish.ts or
-- saved as a single string per mode on app_settings.polish_*_prompt.
-- That gave us "current value" but no history, no audit, no rollback,
-- and no way for an agent to safely propose updates.
--
-- New shape: one row per (mode, version). Exactly one row per mode is
-- active at any time, enforced by the partial unique index on
-- (mode) WHERE is_active = 1. Every prompt change — admin edit, agent
-- proposal, rollback, or cross-env mirror — creates a new row,
-- deactivates the prior active row, and bumps the version counter.
--
-- Rollback is forward-only: clicking "roll back to v7" creates a new
-- v8 with v7's body copied in, source = 'rollback', and
-- rolled_back_from_version_id pointing at v7. The active pointer
-- advances; history is never rewritten.
--
-- Bench score travels with the version so we can show regressions
-- (or improvements) in the admin UI without re-running the harness on
-- every page load. bench_results_json is the per-fixture breakdown,
-- exposed via MCP so the agent can reason about which fixtures
-- moved between iterations.
--
-- Source values:
--   seed     — bootstrapped from app_settings.polish_*_prompt at this migration
--   admin    — super admin edited via /admin/polish-prompts
--   agent    — service-token caller via the MCP `propose_polish_prompt` tool
--   rollback — admin clicked "roll back to vN"; body copied from vN
--   mirror   — prod→dev (or future env→env) sync; body copied from another env
--
-- See web/src/lib/polish-prompts.ts for the domain-layer invariants and
-- the read/write helpers every caller must go through. app_settings
-- columns polish_intuitive_prompt / polish_prescriptive_prompt are
-- left in place for one release as a fallback in lib/transcription/polish.ts
-- and will be dropped in a follow-up migration.

CREATE TABLE polish_prompt_versions (
  id TEXT PRIMARY KEY,
  -- Which polish prompt this version is for. Matches users.polish_mode.
  mode TEXT NOT NULL CHECK (mode IN ('intuitive', 'prescriptive')),
  -- Monotonic per-mode counter, starting at 1. Enforced unique via the
  -- (mode, version) composite index below; the application reads
  -- MAX(version) + 1 inside the create path and the unique index
  -- catches the race.
  version INTEGER NOT NULL,
  -- The actual prompt body. Always populated; an empty/whitespace-only
  -- body is rejected at the domain layer.
  body TEXT NOT NULL,
  -- Free-form notes: why this version exists, what the agent observed,
  -- which feedback IDs prompted it. Up to ~2000 chars at the API layer.
  notes TEXT,
  -- See migration header for the enum values. Single column rather
  -- than a separate provenance table because every fact we'd want to
  -- record about a version is uniformly applicable.
  source TEXT NOT NULL CHECK (source IN ('seed', 'admin', 'agent', 'rollback', 'mirror')),
  -- 0/1 with a partial unique index (below) enforcing at most one
  -- active row per mode. The resolver in lib/transcription/polish.ts
  -- reads WHERE is_active = 1.
  is_active INTEGER NOT NULL DEFAULT 0,
  -- Set when source = 'rollback'; points at the version whose body
  -- this row is a copy of. NULL for all other sources.
  rolled_back_from_version_id TEXT REFERENCES polish_prompt_versions(id),
  -- Pass-rate against the polish-fixtures.ts regression corpus, 0..1.
  -- NULL when the version was created without running the bench
  -- (manual admin edit without explicit benching, or seed migration).
  bench_score REAL,
  -- JSON-encoded per-fixture breakdown. Schema is owned by the bench
  -- harness; the DB just stores the blob. Exposed via MCP so the
  -- agent can diff fixture pass/fail between iterations.
  bench_results_json TEXT,
  created_at INTEGER NOT NULL,
  -- Created by whom: a logged-in super admin OR a service token holder.
  -- Exactly one is non-null (enforced at the domain layer). Both NULL
  -- only for the seed migration below.
  created_by_user_id TEXT REFERENCES users(id),
  created_by_token_id TEXT REFERENCES service_tokens(id)
);

-- Per-mode monotonic version. UNIQUE so a race on MAX(version) + 1
-- between two concurrent inserts loses the second one with a clean
-- constraint error instead of silently producing two rows at the same
-- version number.
CREATE UNIQUE INDEX idx_ppv_mode_version
  ON polish_prompt_versions(mode, version);

-- Partial unique index — at most one active row per mode. This is the
-- load-bearing invariant: the resolver reads WHERE is_active = 1 and
-- expects exactly zero or one row. SQLite supports partial indexes;
-- the WHERE clause is evaluated at index-write time.
CREATE UNIQUE INDEX idx_ppv_active
  ON polish_prompt_versions(mode)
  WHERE is_active = 1;

-- Listing-newest-first path used by /admin/polish-prompts and the MCP
-- list_polish_prompt_versions tool.
CREATE INDEX idx_ppv_mode_created
  ON polish_prompt_versions(mode, created_at DESC);

-- ---------------------------------------------------------------------------
-- One-time data migration from the old single-column overrides.
--
-- If app_settings has a non-NULL polish_*_prompt set, copy it in as
-- v1 of that mode with source = 'seed' and is_active = 1. If both
-- columns are NULL on a fresh install, this inserts nothing — the
-- resolver falls back through to the baked-in default. The two
-- INSERT...SELECT blocks are independent so half-populated state
-- (only intuitive set, say) lands cleanly.
--
-- IDs are 32-char lowercase hex via randomblob — not the same shape
-- as the app's crypto.randomUUID() output but unique TEXT, which is
-- all the schema requires. created_at is unix seconds × 1000 to
-- match the app's millisecond convention.
-- ---------------------------------------------------------------------------

INSERT INTO polish_prompt_versions
  (id, mode, version, body, notes, source, is_active, created_at)
SELECT
  lower(hex(randomblob(16))),
  'intuitive',
  1,
  polish_intuitive_prompt,
  'Seed from app_settings.polish_intuitive_prompt at versioning rollout',
  'seed',
  1,
  unixepoch() * 1000
FROM app_settings
WHERE id = 1
  AND polish_intuitive_prompt IS NOT NULL
  AND length(polish_intuitive_prompt) > 0;

INSERT INTO polish_prompt_versions
  (id, mode, version, body, notes, source, is_active, created_at)
SELECT
  lower(hex(randomblob(16))),
  'prescriptive',
  1,
  polish_prescriptive_prompt,
  'Seed from app_settings.polish_prescriptive_prompt at versioning rollout',
  'seed',
  1,
  unixepoch() * 1000
FROM app_settings
WHERE id = 1
  AND polish_prescriptive_prompt IS NOT NULL
  AND length(polish_prescriptive_prompt) > 0;
