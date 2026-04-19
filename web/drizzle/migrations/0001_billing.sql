-- Phase 4: add billing columns to organizations.
--
-- Auto-top-up: when an org's balance drops below `auto_topup_threshold_millicents`
-- during a debit, we charge `auto_topup_amount_millicents` off-session using
-- the saved `stripe_default_payment_method_id`. If either threshold or amount
-- is NULL the org inherits the defaults from pricing_config.
--
-- `stripe_default_payment_method_id` is set the first time a top-up Checkout
-- completes with setup_future_usage=off_session (Stripe attaches the PM to
-- the Customer, we record its id here so off-session charges know which PM
-- to use). Nullable → auto-top-up is effectively disabled until the first
-- manual top-up succeeds.

ALTER TABLE `organizations` ADD COLUMN `auto_topup_enabled` integer NOT NULL DEFAULT 0;
ALTER TABLE `organizations` ADD COLUMN `auto_topup_threshold_millicents` integer;
ALTER TABLE `organizations` ADD COLUMN `auto_topup_amount_millicents` integer;
ALTER TABLE `organizations` ADD COLUMN `stripe_default_payment_method_id` text;
