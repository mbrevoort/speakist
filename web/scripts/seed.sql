-- Seed data applied via `wrangler d1 execute ... --file=scripts/seed.sql`.
-- Pure SQL so it works on any D1 database (local or remote) without needing
-- the Node runtime or env vars. Idempotent — safe to run repeatedly.
--
-- Creates:
--   * Super-admin user (admin@example.com) marked email-verified
--   * Demo "Acme" organization
--   * Membership row tying the two
--   * $5 signup-bonus ledger row
--
-- Forking this repo: edit the email + display name + org name below to
-- match your deployment. Or, after running the seed once, sign in via
-- magic link with your real email and run an UPDATE to swap the seed
-- user's email + display_name to your own — same effect, no SQL edit.
--
-- Auth.js will NOT create an accounts row for this user until they sign in
-- at least once via magic link. That's fine — sign-in with an existing email
-- just attaches the account row via the adapter's linkAccount() call.

-- Super admin user
INSERT OR IGNORE INTO users (id, email, display_name, email_verified, is_super_admin, created_at, updated_at)
VALUES (
  'seed-user-admin',
  'admin@example.com',
  'Admin',
  unixepoch() * 1000,
  1,
  unixepoch() * 1000,
  unixepoch() * 1000
);

-- If the row already existed (from a prior sign-in), make sure is_super_admin is on.
UPDATE users SET is_super_admin = 1 WHERE email = 'admin@example.com';

-- Demo org
INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at)
VALUES (
  'seed-org-demo',
  'Acme',
  'acme',
  unixepoch() * 1000,
  unixepoch() * 1000
);

-- Membership
INSERT OR IGNORE INTO org_members (org_id, user_id, role, created_at)
SELECT 'seed-org-demo', u.id, 'owner', unixepoch() * 1000
FROM users u WHERE u.email = 'admin@example.com';

-- Signup bonus — only if we haven't granted one yet.
INSERT INTO credit_ledger (id, org_id, delta_millicents, reason, note, created_at)
SELECT
  'seed-ledger-signup-bonus',
  'seed-org-demo',
  (SELECT signup_bonus_millicents FROM pricing_config WHERE id = 1),
  'signup_bonus',
  'Automatic signup bonus (seed script)',
  unixepoch() * 1000
WHERE NOT EXISTS (
  SELECT 1 FROM credit_ledger
  WHERE org_id = 'seed-org-demo' AND reason = 'signup_bonus'
);
