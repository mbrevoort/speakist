-- Rename "cleanup" to "polish" throughout + record per-event polish status.
--
-- "Cleanup" had a sanitize-y connotation that didn't match what the
-- feature does (add punctuation, fix grammar, preserve everything). "Polish"
-- better captures the "leave it intact but make it shinier" semantics.
--
-- Also adds `usage_events.polish_applied` so the dashboard can show which
-- transcriptions went through the LLM polish pass. Billing is unchanged —
-- we charge per-minute × retail rate regardless of whether polish ran;
-- the cost of the polish LLM call is absorbed (see lib/transcription/polish.ts).
-- Word count stored on the row is the final (post-polish) count when polish
-- ran, which is what the user sees and what the dashboard shows.

-- ---- users: rename cleanup_* → polish_* ---------------------------------

ALTER TABLE `users` RENAME COLUMN `cleanup_enabled` TO `polish_enabled`;
ALTER TABLE `users` RENAME COLUMN `cleanup_system_prompt` TO `polish_system_prompt`;

-- ---- usage_events: track polish per event -------------------------------

-- Boolean (0/1). 1 when the /api/transcribe route ran the LLM polish pass
-- and used the polished output. 0 when polish was disabled or the pass
-- failed/was skipped (we still bill for the raw transcription in both cases).
ALTER TABLE `usage_events` ADD COLUMN `polish_applied` integer NOT NULL DEFAULT 0;
