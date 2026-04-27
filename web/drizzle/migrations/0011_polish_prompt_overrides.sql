-- Super-admin overrides for the two polish-mode system prompts.
--
-- End users no longer customize their own prompt — that ability is
-- removed from the Mac, iOS, and web client UIs. The two prompts
-- (intuitive + prescriptive) are now configured globally by a super
-- admin at /admin/system. NULL in either column means "use the
-- baked-in default from lib/transcription/polish.ts" — so the
-- migration is a no-op behaviorally until an admin actually saves
-- an override.
--
-- The legacy `users.polish_system_prompt` column is left in place
-- (SQLite drop-column is awkward and the data is harmless) but is
-- no longer read or written by application code.

ALTER TABLE app_settings ADD COLUMN polish_intuitive_prompt TEXT;
ALTER TABLE app_settings ADD COLUMN polish_prescriptive_prompt TEXT;
