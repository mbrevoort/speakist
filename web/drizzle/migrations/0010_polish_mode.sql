-- Two-mode polish: intuitive vs prescriptive.
--
-- `prescriptive` is the safer default — it only fixes punctuation,
-- capitalization, and clear grammar issues; it never applies self-
-- corrections or touches meaning. `intuitive` is the prior behavior
-- (intent-aware, applies explicit self-corrections, fixes obvious
-- slips).
--
-- Existing users who already had polish_enabled=true picked up the
-- intuitive prompt today, so we promote them to `intuitive` to
-- preserve their current experience. New users (and existing users
-- with polish disabled) default to the conservative mode.

ALTER TABLE users ADD COLUMN polish_mode TEXT NOT NULL DEFAULT 'prescriptive';

UPDATE users SET polish_mode = 'intuitive' WHERE polish_enabled = 1;
