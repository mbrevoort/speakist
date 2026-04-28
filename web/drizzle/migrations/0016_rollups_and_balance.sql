-- Pre-rollout scalability foundations. Two changes, both designed to
-- replace SUM-on-read scans with O(1) lookups so request paths and
-- admin queries stay flat as `usage_events` and `credit_ledger` grow:
--
--   1. Materialize `organizations.balance_millicents`. Today every
--      `getOrgCreditBalance` and the auto-topup gate run a full
--      `SUM(delta_millicents)` scan over an org's lifetime ledger.
--      With the column in place we read one row; ledger writes go
--      through a helper that updates the column in lockstep.
--
--   2. Add a `usage_daily(org_id, user_id, day_ts, …)` rollup table.
--      Admin platform charts and the per-org dashboard's
--      "by-day" series scan all `usage_events` in a 30/14-day window
--      and bucket in JS. The rollup compresses each (org, user, UTC
--      day) into one row, so a 30-day platform-wide query reads
--      roughly N_active_orgs × N_active_users_per_org × 30 rows
--      instead of every event. Every transcription does an UPSERT on
--      this table at debit time (see `recordDailyUsage` in
--      lib/credits.ts) so the rollup stays current within a single
--      request.
--
-- Both changes are backfilled here from the existing raw tables, so
-- the rollup is correct from the moment the migration finishes. If
-- the rollup or balance ever drifts, the same backfill SQL run by
-- hand recomputes them — they're pure projections of the underlying
-- raw tables.

-- 1. Materialized org balance.

ALTER TABLE organizations ADD COLUMN balance_millicents INTEGER NOT NULL DEFAULT 0;

UPDATE organizations
SET balance_millicents = COALESCE(
  (SELECT SUM(delta_millicents) FROM credit_ledger WHERE credit_ledger.org_id = organizations.id),
  0
);

-- 2. Daily-rollup table for usage_events.
--
-- (org_id, user_id, day_ts) is the natural unique key — one row per
-- (org, user, UTC-day). day_ts is the day's UTC midnight in ms,
-- computed as (created_at / 86400000) * 86400000. SQLite does
-- integer division when both operands are integers, so this is the
-- canonical "truncate ms timestamp to day" expression.
--
-- Indexes:
--   * PK (org_id, user_id, day_ts) covers org-scoped + per-user lookups.
--   * (org_id, day_ts) covers org-wide "by-day" queries
--     (getUsageByDay) and listAllOrgs' last30dEvents subquery.
--   * (day_ts) covers platform-wide queries (getPlatformDailyUsage,
--     getPlatformTotals 30d clause).
--   * (user_id, day_ts) covers listAllUsers' per-user 30d subqueries
--     and getUserDetail's daily series.

CREATE TABLE usage_daily (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_ts INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  audio_ms INTEGER NOT NULL DEFAULT 0,
  cost_millicents INTEGER NOT NULL DEFAULT 0,
  upstream_cost_millicents INTEGER NOT NULL DEFAULT 0,
  polish_events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, day_ts)
);

CREATE INDEX usage_daily_org_day_idx ON usage_daily (org_id, day_ts);
CREATE INDEX usage_daily_day_idx ON usage_daily (day_ts);
CREATE INDEX usage_daily_user_day_idx ON usage_daily (user_id, day_ts);

INSERT INTO usage_daily (
  org_id, user_id, day_ts, events, word_count, audio_ms,
  cost_millicents, upstream_cost_millicents, polish_events
)
SELECT
  org_id,
  user_id,
  (created_at / 86400000) * 86400000 AS day_ts,
  COUNT(*),
  COALESCE(SUM(word_count), 0),
  COALESCE(SUM(audio_ms), 0),
  COALESCE(SUM(cost_millicents), 0),
  COALESCE(SUM(upstream_cost_millicents), 0),
  COALESCE(SUM(CASE WHEN polish_applied = 1 THEN 1 ELSE 0 END), 0)
FROM usage_events
GROUP BY org_id, user_id, day_ts;
