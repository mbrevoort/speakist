-- Slack webhook for "Report bad transcription" submissions.
--
-- Mirrors the existing slack_new_user_* and slack_topup_* columns
-- (added in 0014_slack_webhooks.sql): an AES-GCM encrypted URL plus
-- an independent enable flag, both managed at /admin/system. URL
-- decryption envelope is `APP_ENCRYPTION_KEY` — same as the other
-- two destinations. See lib/slack.ts.
--
-- Default enable flag is 0 (disabled) so the column is a no-op on
-- existing databases until an admin opts in.

ALTER TABLE app_settings ADD COLUMN slack_feedback_webhook_url_encrypted TEXT;
ALTER TABLE app_settings ADD COLUMN slack_feedback_webhook_enabled INTEGER NOT NULL DEFAULT 0;
