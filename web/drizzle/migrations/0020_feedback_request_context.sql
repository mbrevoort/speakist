-- Capture the per-request transcription context on each feedback row.
--
-- Motivation: the bad-transcription corpus drives the STT + polish
-- regression benches (see web/scripts/bench-stt-sync.ts). Without the
-- vocab/keyterm list and option toggles that were active at the
-- original /api/transcribe call, the bench replays the audio in a
-- subtly different config than what the user experienced — which
-- blocks vocab-bleed reproduction in particular, since that failure
-- mode is driven by upstream STT keyterm biasing.
--
-- `keyterms_json` is its own column because it's the actively-
-- investigated field; future admin UIs may want to filter feedback
-- rows by keyterm presence ("show me everything where 'Stripe' was
-- in scope"). Value: JSON-encoded array of strings, or NULL when
-- the client didn't report a list.
--
-- `transcription_options_json` is a single JSON blob for the rest
-- of the request snapshot: replaceRules, dictation, fillerWords,
-- measurements, profanityFilter, detectLanguage. Rarely queried, so
-- the column-per-flag cost wasn't worth it — and a blob keeps us
-- migration-free when /api/transcribe grows a new option.
--
-- Both columns nullable so the migration is non-destructive against
-- existing rows. Clients started backfilled with NULL.

ALTER TABLE transcription_feedback
  ADD COLUMN keyterms_json TEXT;

ALTER TABLE transcription_feedback
  ADD COLUMN transcription_options_json TEXT;
