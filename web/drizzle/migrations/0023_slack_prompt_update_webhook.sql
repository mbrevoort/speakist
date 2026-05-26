-- Slack webhook for polish-prompt version updates.
--
-- Fires once per write through lib/polish-prompts.ts:insertActiveVersion
-- — covers admin edits, agent proposals via MCP, rollbacks, and prod→dev
-- mirror (PR 4). Mirrors the existing slack_new_user_* / slack_topup_* /
-- slack_feedback_* triplets (migrations 0014, 0018): an AES-GCM-encrypted
-- URL via APP_ENCRYPTION_KEY plus an independent enable flag, both
-- managed at /admin/system. See lib/slack.ts.
--
-- Why a separate destination from `slack_feedback_*`: prompt updates
-- are low-volume signal, feedback reports are high-volume noise — they
-- belong in different channels.
--
-- Default enable flag is 0 so this is a no-op on existing databases
-- until an admin opts in.

ALTER TABLE app_settings ADD COLUMN slack_prompt_update_webhook_url_encrypted TEXT;
ALTER TABLE app_settings ADD COLUMN slack_prompt_update_webhook_enabled INTEGER NOT NULL DEFAULT 0;
