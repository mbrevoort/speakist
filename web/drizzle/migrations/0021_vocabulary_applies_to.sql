-- Split vocabulary entries between "local" (client-side only, doesn't
-- reach STT) and "stt" (sent to Deepgram as keyterm bias + X-Replace
-- rule). The old behavior — every entry reaches STT — turned out to be
-- dangerous: auto-ingestion from inline transcript edits learned global
-- word swaps like {find: "as", replacement: "given"} that clobbered
-- every "as" in every future dictation.
--
-- The new model:
--   * `local` — stored, visible in the Vocabulary UI, never sent to STT.
--     This is the new default for auto-ingestion (DiffEngine output).
--   * `stt`   — sent to STT (both keyterm and X-Replace). Promoted to
--     here either by explicit user action in the Settings UI or by the
--     reactive LLM classifier (added in a follow-up migration) once a
--     local entry has been corrected ≥ 2× and the classifier says it
--     looks like a proper noun / technical term / slang phrase / etc.
--
-- Backfill rationale: every existing entry today is implicitly "stt".
-- We can't keep that as-is — the dangerous globals the user already has
-- (as → given, a → an, this → is a, etc.) need to stop affecting STT.
-- The heuristic below promotes only the entries that pass a tight
-- safety screen; everything else falls back to local. Users can review
-- and re-promote any false-negatives via the Settings UI cleanup banner.
--
-- Backfill heuristic — promote to 'stt' iff ALL of:
--   1. is_proper_noun = 1  (find or replacement has a capital letter or
--                           digit — the existing weak heuristic, but it
--                           catches the brand-name / Camel-Case / vX
--                           cases that motivate vocab in the first place)
--   2. LENGTH(from_text) >= 3
--   3. LOWER(from_text) not in a tight blocklist of common English
--      function words that should never be globally rewritten
--
-- The blocklist mirrors the Mac heuristic in CorrectionStore.swift to
-- keep client / server reasoning aligned. Kept short on purpose — too
-- broad a list rejects legitimate technical jargon. The classifier (a
-- follow-up migration) does the nuanced judgment; this SQL screen just
-- catches the obvious "no, never" cases.

ALTER TABLE vocabulary_entries
  ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'local';

UPDATE vocabulary_entries
SET applies_to = 'stt'
WHERE is_proper_noun = 1
  AND LENGTH(from_text) >= 3
  AND LOWER(from_text) NOT IN (
    'the', 'and', 'but', 'for', 'with', 'that', 'this', 'these', 'those',
    'they', 'them', 'their', 'there', 'then', 'than',
    'have', 'has', 'had', 'was', 'were', 'are', 'been', 'being',
    'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
    'into', 'onto', 'upon', 'from', 'about', 'over', 'under', 'between',
    'when', 'where', 'while', 'because', 'although', 'though',
    'not', 'yes', 'okay', 'such', 'some', 'any', 'all', 'both', 'each',
    'how', 'why', 'who', 'what', 'which', 'whose', 'whom',
    'you', 'your', 'yours', 'our', 'ours', 'mine', 'her', 'his', 'hers',
    'one', 'two', 'three', 'four', 'five'
  );

-- Index supports "list my stt-bound entries" queries (the keyterm and
-- X-Replace builders both run that filter on every transcribe call).
CREATE INDEX vocab_applies_to_idx
  ON vocabulary_entries(user_id, applies_to, updated_at);
