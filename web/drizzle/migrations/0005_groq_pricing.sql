-- Phase B: add Groq Whisper-large-v3 pricing.
--
-- Groq is the first alternate transcription provider we're adding to the
-- /api/transcribe dispatch. Just pricing rows — the adapter + secrets +
-- env wiring all live in code (migration has no schema changes).
--
-- Rates from https://groq.com/pricing/ (April 2026). Conversion is
-- $1 = 100,000 millicents (schema.ts: "1/1000 of a cent, $5 = 500_000"):
--   * whisper-large-v3-turbo: $0.04/hour  = $0.000667/min = 66.7 mC/min
--   * whisper-large-v3:       $0.111/hour = $0.00185/min  = 185 mC/min
--
-- Retail markup: ~3× matching the Deepgram row markup. Super-admin can
-- edit these via the /admin/pricing UI later; this is just a sane seed.
--
-- Turbo retail ≈ 200 mC/min vs Deepgram nova-3 retail 1290 mC/min — ~6.5×
-- cheaper for the user who picks turbo. Big margin lever once we have
-- real-world accuracy data on which models users actually prefer.

INSERT INTO `provider_pricing`
  (`provider_id`, `model`, `cost_per_minute_millicents`, `retail_per_minute_millicents`, `active`, `updated_at`)
VALUES
  ('groq', 'whisper-large-v3-turbo',  66.7, 200, 1, (unixepoch('now') * 1000)),
  ('groq', 'whisper-large-v3',       185,   555, 1, (unixepoch('now') * 1000));
