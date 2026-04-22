-- Track per-request processing time on usage_events.
--
-- `processing_ms` is the total wall-clock the Worker spent handling a single
-- /api/transcribe call: upstream STT fetch + optional polish pass + DB
-- writes. NULL for events inserted before this column existed.
--
-- Surfaced in the /dashboard/usage "Recent transcriptions" table so the
-- user can see how long each request actually took, independently of
-- audio duration. Not used for billing.

ALTER TABLE `usage_events` ADD COLUMN `processing_ms` integer;
