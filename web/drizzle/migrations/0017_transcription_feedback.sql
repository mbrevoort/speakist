-- "Report bad transcription" feedback corpus.
--
-- A row is created exactly when a user clicks "Report" on a History
-- entry in the Mac or iOS app. This is opt-in: nothing is ever sent
-- to the server unless the user explicitly reports. Audio + raw +
-- polished + expected text live indefinitely so we can build a
-- regression bench from real user-flagged failures.
--
-- The privacy boundary is critical: normal transcriptions discard
-- audio server-side and store transcripts only on the user's device.
-- A row in this table only exists because the user (or any user in
-- their org with an org-level opt-out NOT set) chose to share that
-- one transcription for quality-control purposes.
--
-- An org admin can disable feedback submission for everyone in the
-- org via `organizations.feedback_disabled` — set to 1 to make
-- /api/feedback return 403 for users in that org and hide the
-- "Report" button in the clients.

CREATE TABLE transcription_feedback (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id                   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at               INTEGER NOT NULL,        -- epoch ms

  -- Original transcription correlation. Matches the X-Transcription-Id
  -- the client sent on /api/transcribe so we can join against the
  -- usage_events row for context (provider, model, audio duration)
  -- without requiring the client to re-send any of it.
  transcription_client_id  TEXT NOT NULL,

  -- Texts. Length unbounded — TEXT in SQLite has no fixed cap.
  raw_text                 TEXT NOT NULL,           -- post-STT, pre-polish
  polished_text            TEXT NOT NULL,           -- final delivered text
  expected_text            TEXT NOT NULL,           -- what the user said it should be

  -- Snapshot of the system context at time of failure. Duplicated
  -- (vs joined from usage_events) so the feedback row is self-contained
  -- if usage_events ever gets archived or pruned.
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL,
  polish_applied           INTEGER NOT NULL,        -- 0/1
  polish_mode              TEXT,                    -- intuitive | prescriptive | NULL
  audio_seconds            REAL,
  language                 TEXT,

  -- User-provided categorization (optional, for triage convenience).
  -- Constrained values: wrong_word | punctuation | both | other.
  failure_kind             TEXT,
  user_note                TEXT,

  -- Audio object key in the speakist-feedback-audio R2 bucket.
  -- NULL when the user opted out of sharing audio (text-only report).
  audio_object_key         TEXT,

  -- Triage state. `new` until a super admin reviews; then one of
  -- reviewed | resolved | dismissed | proposed (the "agent has opened
  -- a PR for this" state, set by the future bench-and-PR agent).
  status                   TEXT NOT NULL DEFAULT 'new',
  resolution               TEXT,
  reviewed_at              INTEGER,
  reviewed_by              TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Triage queue lookup: super-admin's /admin/feedback view filters
-- by status and sorts newest-first.
CREATE INDEX transcription_feedback_status_idx
  ON transcription_feedback(status, created_at DESC);

-- Per-org cross-reference. Useful for a future per-org
-- "you've contributed N reports" summary, and for the agent that
-- batches reports by org for context-aware classification.
CREATE INDEX transcription_feedback_org_idx
  ON transcription_feedback(org_id, created_at DESC);

-- Org-level opt-out. NULL/0 = users in this org can submit feedback
-- (the default). 1 = /api/feedback returns 403 for any user in this
-- org and the clients hide the Report button. The opt-out is at the
-- org level (not per-user) because the data shared is a transcription
-- the org paid us to produce — the org owns the data, the org
-- decides whether it's eligible to be sent back to us.
ALTER TABLE organizations ADD COLUMN feedback_disabled INTEGER NOT NULL DEFAULT 0;
