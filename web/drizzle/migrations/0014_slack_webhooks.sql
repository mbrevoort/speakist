-- Optional Slack webhook notifications. Configured by super admin at
-- /admin/system. Each destination has an encrypted URL + an enable flag,
-- so an admin can pre-stage the URL and flip it on later, or disable
-- temporarily without losing the URL.
--
-- The URLs are encrypted with APP_ENCRYPTION_KEY because anyone holding
-- a Slack incoming-webhook URL can post into the channel — same threat
-- model as our other secrets.
--
-- All four columns default NULL/false so existing deployments behave
-- exactly as before until an admin opts in.

ALTER TABLE app_settings ADD COLUMN slack_new_user_webhook_url_encrypted TEXT;
ALTER TABLE app_settings ADD COLUMN slack_new_user_webhook_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN slack_topup_webhook_url_encrypted TEXT;
ALTER TABLE app_settings ADD COLUMN slack_topup_webhook_enabled INTEGER NOT NULL DEFAULT 0;
