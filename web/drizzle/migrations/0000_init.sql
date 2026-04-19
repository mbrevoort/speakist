-- Speakist initial schema. Handwritten to match src/lib/db/schema.ts exactly
-- so `wrangler d1 migrations apply` works out of the box after clone. Future
-- migrations are generated with `pnpm db:generate` from the schema.
--
-- Notes:
--  * All timestamps are INTEGER Unix milliseconds.
--  * All money fields are INTEGER millicents (1/1000 cent).
--  * All booleans are INTEGER 0/1.
--  * All IDs are TEXT UUIDs (set client-side via crypto.randomUUID()).

-- ===========================================================================
-- Auth.js tables (required by @auth/drizzle-adapter)
-- ===========================================================================

CREATE TABLE `users` (
  `id`              text PRIMARY KEY NOT NULL,
  `name`            text,
  `email`           text NOT NULL,
  `email_verified`  integer,
  `image`           text,
  `display_name`    text,
  `is_super_admin`  integer NOT NULL DEFAULT 0,
  `created_at`      integer NOT NULL,
  `updated_at`      integer NOT NULL
);
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);

CREATE TABLE `accounts` (
  `user_id`              text NOT NULL,
  `type`                 text NOT NULL,
  `provider`             text NOT NULL,
  `provider_account_id`  text NOT NULL,
  `refresh_token`        text,
  `access_token`         text,
  `expires_at`           integer,
  `token_type`           text,
  `scope`                text,
  `id_token`             text,
  `session_state`        text,
  PRIMARY KEY (`provider`, `provider_account_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE TABLE `sessions` (
  `session_token` text PRIMARY KEY NOT NULL,
  `user_id`       text NOT NULL,
  `expires`       integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE TABLE `verification_tokens` (
  `identifier` text NOT NULL,
  `token`      text NOT NULL,
  `expires`    integer NOT NULL,
  PRIMARY KEY (`identifier`, `token`)
);

-- ===========================================================================
-- Organizations, members, invitations
-- ===========================================================================

CREATE TABLE `organizations` (
  `id`                               text PRIMARY KEY NOT NULL,
  `name`                             text NOT NULL,
  `slug`                             text NOT NULL,
  `is_comped`                        integer NOT NULL DEFAULT 0,
  `deepgram_key_override_encrypted`  text,
  `auto_join_domain`                 text,
  `stripe_customer_id`               text,
  `created_at`                       integer NOT NULL,
  `updated_at`                       integer NOT NULL
);
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
CREATE INDEX `organizations_auto_join_idx` ON `organizations` (`auto_join_domain`);

CREATE TABLE `org_members` (
  `org_id`     text NOT NULL,
  `user_id`    text NOT NULL,
  `role`       text NOT NULL DEFAULT 'member',
  `created_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `user_id`),
  FOREIGN KEY (`org_id`)  REFERENCES `organizations`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)         ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX `org_members_user_idx` ON `org_members` (`user_id`);

CREATE TABLE `invitations` (
  `id`          text PRIMARY KEY NOT NULL,
  `org_id`      text NOT NULL,
  `email`       text NOT NULL,
  `role`        text NOT NULL DEFAULT 'member',
  `token`       text NOT NULL,
  `invited_by`  text NOT NULL,
  `expires_at`  integer NOT NULL,
  `accepted_at` integer,
  `created_at`  integer NOT NULL,
  FOREIGN KEY (`org_id`)     REFERENCES `organizations`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`)         ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE UNIQUE INDEX `invitations_token_unique` ON `invitations` (`token`);
CREATE INDEX `invitations_org_idx`   ON `invitations` (`org_id`);
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);

-- ===========================================================================
-- Vocabulary (per-user, synced from Mac app)
-- ===========================================================================

CREATE TABLE `vocabulary_entries` (
  `id`              text PRIMARY KEY NOT NULL,
  `user_id`         text NOT NULL,
  `from_text`       text NOT NULL,
  `to_text`         text NOT NULL,
  `count`           integer NOT NULL DEFAULT 1,
  `is_proper_noun`  integer NOT NULL DEFAULT 0,
  `last_seen`       integer NOT NULL,
  `created_at`      integer NOT NULL,
  `updated_at`      integer NOT NULL,
  `deleted_at`      integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX `vocab_user_updated_idx` ON `vocabulary_entries` (`user_id`, `updated_at`);
CREATE UNIQUE INDEX `vocab_unique` ON `vocabulary_entries` (`user_id`, `from_text`, `to_text`);

-- ===========================================================================
-- Credit ledger (append-only) + usage events
-- ===========================================================================

CREATE TABLE `credit_ledger` (
  `id`                 text PRIMARY KEY NOT NULL,
  `org_id`             text NOT NULL,
  `delta_millicents`   integer NOT NULL,
  `reason`             text NOT NULL,
  `stripe_event_id`    text,
  `usage_event_id`     text,
  `created_by`         text,
  `note`               text,
  `created_at`         integer NOT NULL,
  FOREIGN KEY (`org_id`)     REFERENCES `organizations`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)         ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE UNIQUE INDEX `credit_ledger_stripe_event_unique` ON `credit_ledger` (`stripe_event_id`);
CREATE INDEX `credit_ledger_org_idx` ON `credit_ledger` (`org_id`, `created_at`);

CREATE TABLE `usage_events` (
  `id`                         text PRIMARY KEY NOT NULL,
  `org_id`                     text NOT NULL,
  `user_id`                    text NOT NULL,
  `transcription_client_id`    text NOT NULL,
  `word_count`                 integer NOT NULL,
  `audio_ms`                   integer,
  `model`                      text NOT NULL,
  `cost_millicents`            integer NOT NULL DEFAULT 0,
  `deepgram_cost_millicents`   integer,
  `created_at`                 integer NOT NULL,
  FOREIGN KEY (`org_id`)  REFERENCES `organizations`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)         ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX `usage_events_org_idx`  ON `usage_events` (`org_id`, `created_at`);
CREATE INDEX `usage_events_user_idx` ON `usage_events` (`user_id`, `created_at`);
CREATE UNIQUE INDEX `usage_events_unique` ON `usage_events` (`org_id`, `transcription_client_id`);

-- ===========================================================================
-- Singletons: pricing_config, app_settings
-- ===========================================================================

CREATE TABLE `pricing_config` (
  `id`                                             integer PRIMARY KEY DEFAULT 1,
  `price_per_word_millicents`                      real    NOT NULL DEFAULT 5.74,
  `deepgram_per_minute_millicents`                 real    NOT NULL DEFAULT 430.0,
  `signup_bonus_millicents`                        integer NOT NULL DEFAULT 500000,
  `default_auto_topup_amount_millicents`           integer NOT NULL DEFAULT 2000000,
  `default_auto_topup_threshold_millicents`        integer NOT NULL DEFAULT 500000,
  `updated_at`                                     integer NOT NULL
);
-- Seed the singleton row. Using unixepoch() * 1000 for ms.
INSERT INTO `pricing_config` (`id`, `updated_at`) VALUES (1, unixepoch() * 1000);

CREATE TABLE `app_settings` (
  `id`                              integer PRIMARY KEY DEFAULT 1,
  `system_deepgram_key_encrypted`   text,
  `updated_at`                      integer NOT NULL
);
INSERT INTO `app_settings` (`id`, `updated_at`) VALUES (1, unixepoch() * 1000);

-- ===========================================================================
-- Mac sign-in (device code + sessions)
-- ===========================================================================

CREATE TABLE `device_auth_codes` (
  `id`            text PRIMARY KEY NOT NULL,
  `user_code`     text NOT NULL,
  `device_code`   text NOT NULL,
  `user_id`       text,
  `approved_at`   integer,
  `consumed_at`   integer,
  `expires_at`    integer NOT NULL,
  `device_name`   text,
  `created_at`    integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE UNIQUE INDEX `device_auth_codes_user_code_unique`   ON `device_auth_codes` (`user_code`);
CREATE UNIQUE INDEX `device_auth_codes_device_code_unique` ON `device_auth_codes` (`device_code`);

CREATE TABLE `mac_sessions` (
  `id`                   text PRIMARY KEY NOT NULL,
  `user_id`              text NOT NULL,
  `refresh_token_hash`   text NOT NULL,
  `device_name`          text,
  `last_used_at`         integer,
  `revoked_at`           integer,
  `created_at`           integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE UNIQUE INDEX `mac_sessions_refresh_token_hash_unique` ON `mac_sessions` (`refresh_token_hash`);
CREATE INDEX `mac_sessions_user_idx` ON `mac_sessions` (`user_id`);
