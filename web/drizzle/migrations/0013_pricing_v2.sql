-- Pricing v2 (consumption-only launch, see docs/pricing-strategy.md).
--
-- Changes:
--   1. Add `auto_topup_max_monthly_millicents` column to organizations —
--      hard cap on auto-top-up spend per calendar month. NULL = no cap.
--   2. Add `default_auto_topup_max_monthly_millicents` column to
--      pricing_config — default cap inherited when an org enables
--      auto-topup without setting their own.
--   3. Update pricing_config singleton row to the v2 headline values:
--        * price_per_word_millicents 5.74 → 20.0  ($0.20 / 1K words)
--        * signup_bonus_millicents 500,000 → 60,000  ($5 → ~3K words)
--        * default_auto_topup_amount_millicents 2,000,000 → 500,000  ($20 → $5)
--        * default_auto_topup_threshold_millicents 500,000 → 100,000  ($5 → $1.00)
--
-- Rationale: see docs/pricing-strategy.md. The $0.20/1K rate positions
-- Speakist at ~50% of Wispr Flow's effective rate at typical use, while
-- staying clearly above raw COGS (~$0.0046/1K) so margins remain >90% net
-- on every SKU after Stripe + Groq.
--
-- Note: this migration ONLY updates the singleton's pricing-related defaults
-- if the row still holds the v1 defaults — orgs that have already
-- customized values in production stay untouched.

-- 1. Schema additions

ALTER TABLE `organizations` ADD COLUMN `auto_topup_max_monthly_millicents` integer;

ALTER TABLE `pricing_config` ADD COLUMN `default_auto_topup_max_monthly_millicents` integer NOT NULL DEFAULT 2000000;

-- 2. Re-anchor the singleton row to v2 defaults if (and only if) it still
-- holds the v1 defaults. A super-admin who hand-edited the row keeps their
-- values.

UPDATE `pricing_config`
SET
  `price_per_word_millicents` = 20.0,
  `signup_bonus_millicents` = 60000,
  `default_auto_topup_amount_millicents` = 500000,
  `default_auto_topup_threshold_millicents` = 100000
WHERE
  `id` = 1
  AND `price_per_word_millicents` = 5.74
  AND `signup_bonus_millicents` = 500000
  AND `default_auto_topup_amount_millicents` = 2000000
  AND `default_auto_topup_threshold_millicents` = 500000;
