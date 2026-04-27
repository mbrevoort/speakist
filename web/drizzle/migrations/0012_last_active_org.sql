-- Active workspace tracking for multi-org users.
--
-- A user can belong to N organizations (via org_members rows); today
-- `getCurrentOrgForUser` silently picks the earliest-joined which makes
-- additional memberships invisible. This column lets us persist an
-- explicit choice — set at sign-in (the /link device-code page now
-- shows a workspace picker if the user has 2+ memberships), at
-- invitation acceptance (auto-set to the freshly-joined org), or via
-- the dashboard topbar switcher.
--
-- NULL means "no explicit choice yet" → resolver falls back to
-- earliest-joined and self-heals if the persisted org is gone.
--
-- Not declared as a FK with ON DELETE CASCADE because the resolver
-- already handles the "stale id" case gracefully; falling back to the
-- earliest-joined existing org is a friendlier outcome than wiping
-- the user's preference whenever an org gets deleted.

ALTER TABLE users ADD COLUMN last_active_org_id TEXT;
