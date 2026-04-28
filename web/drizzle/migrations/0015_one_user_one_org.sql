-- One user, one org. Three changes:
--
-- 1. Add `users.signup_bonus_granted_at` (timestamp_ms, nullable). Gates the
--    signup bonus per user lifetime so that a user who leaves and recreates
--    their org doesn't re-mint $5 of credit each cycle.
--
-- 2. Add a UNIQUE INDEX on `org_members(user_id)` — the new schema-level
--    invariant that a user belongs to at most one org. Any future bug that
--    tries to insert a second membership row will SQLITE_CONSTRAINT instead
--    of silently re-creating the multi-org problem.
--
-- 3. Drop `users.last_active_org_id`. With one membership per user, the
--    "which workspace am I currently in" preference no longer exists.
--
-- This migration is destructive for any user that already has 2+
-- memberships — but Speakist isn't deployed to production yet, so we make
-- a clean cut rather than carrying a dedupe pass forward as cruft.

ALTER TABLE users ADD COLUMN signup_bonus_granted_at INTEGER;

CREATE UNIQUE INDEX org_members_user_unique ON org_members (user_id);

ALTER TABLE users DROP COLUMN last_active_org_id;
