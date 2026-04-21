-- Phase A of the Worker-proxied transcription rollout.
--
-- Introduces:
--   * `provider_pricing` table — per-(provider, model) upstream + retail
--     rates, keyed by (provider_id, model). Replaces the single
--     `pricing_config.price_per_word_millicents` column for transcription.
--     `price_per_word_millicents` stays around for any legacy /api/usage
--     call paths; it's dropped at Phase D cleanup.
--
--   * `usage_events.provider_id` — which provider produced this transcription.
--     Defaults to 'deepgram' for existing rows (everything pre-Phase-A was
--     Deepgram).
--
--   * `usage_events.upstream_cost_millicents` — renamed from
--     `deepgram_cost_millicents`. Same meaning (what we paid the upstream),
--     just not Deepgram-specific anymore. Old column data is preserved in
--     the new column.

-- ---- provider_pricing ------------------------------------------------------

CREATE TABLE `provider_pricing` (
  -- 'deepgram' | 'groq' | 'openai' | 'xai'. Loose TEXT so we can add
  -- providers without a schema change; the app-level union type enforces
  -- which slugs are meaningful.
  `provider_id`                     text NOT NULL,
  -- Provider-specific model slug, e.g. 'nova-3', 'whisper-large-v3-turbo',
  -- 'gpt-4o-mini-transcribe', 'grok-3-stt'. Matches whatever the provider's
  -- API expects in its model param.
  `model`                           text NOT NULL,
  -- What the upstream charges us per minute of audio, in millicents.
  -- REAL because providers price in fractions of a cent (Groq turbo is
  -- ~$0.000667/min = 0.667 millicents) and we don't want to round before
  -- computing the retail markup.
  `cost_per_minute_millicents`      real NOT NULL,
  -- What we charge the org, per minute, in millicents. Usually ~3x upstream
  -- (see docs) but editable per row. Super-admin UI in Phase D.
  `retail_per_minute_millicents`    real NOT NULL,
  -- Soft delete / gating. When false, the router coerces requests for this
  -- (provider, model) back to the org's default. Lets us retire a provider
  -- without deleting the row (we need it to price historical usage).
  `active`                          integer NOT NULL DEFAULT 1,
  `updated_at`                      integer NOT NULL,
  PRIMARY KEY (`provider_id`, `model`)
);

-- Seed Deepgram rates — matches the pre-Phase-A per-word rate of ~5.74 mC
-- with a typical dictation word density (~2.5 words/sec = 150 wpm = 860 mC/min
-- upstream roughly ~430 at Deepgram's $0.0043/min cost). Retail is 3x markup.
-- Super-admin can edit via /admin/system → provider_pricing UI (Phase D).
INSERT INTO `provider_pricing`
  (`provider_id`, `model`, `cost_per_minute_millicents`, `retail_per_minute_millicents`, `active`, `updated_at`)
VALUES
  ('deepgram', 'nova-3', 430, 1290, 1, (unixepoch('now') * 1000)),
  ('deepgram', 'nova-2', 430, 1290, 1, (unixepoch('now') * 1000));

-- ---- usage_events column changes ------------------------------------------

-- Add provider_id with a default so existing rows get 'deepgram' backfilled.
-- The default is a one-time DDL-level fill; future inserts from /api/transcribe
-- always specify provider_id explicitly.
ALTER TABLE `usage_events` ADD COLUMN `provider_id` text NOT NULL DEFAULT 'deepgram';

-- Add upstream_cost_millicents (the replacement for deepgram_cost_millicents).
-- Nullable because we may not always record upstream cost — e.g. if the
-- provider doesn't return duration in its response and we can't compute.
ALTER TABLE `usage_events` ADD COLUMN `upstream_cost_millicents` integer;

-- Backfill upstream cost from the old Deepgram-specific column, preserving
-- history for the super-admin margin dashboard.
UPDATE `usage_events`
  SET `upstream_cost_millicents` = `deepgram_cost_millicents`
  WHERE `deepgram_cost_millicents` IS NOT NULL;

-- D1 supports modern SQLite's DROP COLUMN. We're leaving the
-- `deepgram_cost_millicents` column in place for one release as an escape
-- hatch if we need to re-run the backfill; it's dropped in Phase D cleanup.
-- (No rows are written to it anymore starting in Phase A.)
