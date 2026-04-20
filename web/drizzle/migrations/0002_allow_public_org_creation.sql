-- Add a super-admin-controlled toggle that decides whether brand-new
-- signups get a workspace auto-created for them.
--
-- When `allow_public_org_creation = 1` (default, matches prior behavior):
--   * First-time signup → create "{name}'s Workspace" + $5 bonus
--   * Invitation accept → join the invited org (unchanged)
--   * Auto-join domain match → join that org (unchanged)
--
-- When `allow_public_org_creation = 0`:
--   * First-time signup → user row created, NO org, NO bonus. They land on
--     /dashboard with a friendly "awaiting invitation" screen.
--   * Invitation accept → still works (unchanged)
--   * Auto-join domain match → still works (unchanged)
--
-- Intended use: dev/staging environments set this to 0 so only people
-- we've invited can actually use the app. Production leaves it at 1.

ALTER TABLE `app_settings` ADD COLUMN `allow_public_org_creation` integer NOT NULL DEFAULT 1;
