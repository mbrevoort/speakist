-- Org model-access controls + Groq key override + per-user cleanup prefs.
--
-- Two features land in the same migration because both feed the /api/transcribe
-- hot path: the org controls gate which (provider, model) pairs a user can
-- dispatch to, and the cleanup prefs control whether we run a post-transcription
-- LLM pass on the result.
--
-- Nothing here is backfilled with non-default values — existing orgs keep
-- access to every active provider_pricing row (NULL allowed_models_json),
-- and existing users start with cleanup OFF.

-- ---- organizations: Groq key override + allowed-models whitelist ---------

-- Parallel to `deepgram_key_override_encrypted`. When set, the Worker uses
-- this org's Groq project for Groq transcriptions; billing still flows
-- through our ledger but provider cost is paid by them.
ALTER TABLE `organizations` ADD COLUMN `groq_key_override_encrypted` text;

-- JSON array of "provider/model" slugs this org's users are allowed to
-- dispatch. NULL = no restriction (every active `provider_pricing` row is
-- usable). Enforced by /api/transcribe: requests for a model not in the
-- list return 403 so the Mac surfaces the restriction to the user rather
-- than silently swapping to a default.
--
-- Example: `["deepgram/nova-3","groq/whisper-large-v3-turbo"]`
ALTER TABLE `organizations` ADD COLUMN `allowed_models_json` text;

-- ---- users: post-transcription cleanup prefs -----------------------------

-- When true, /api/transcribe passes the raw transcript through an LLM
-- cleanup step (Groq llama-3.1-8b-instant) before returning. Defaults OFF —
-- users opt in from Mac Settings, which also PUTs this back here so every
-- signed-in device sees consistent state.
ALTER TABLE `users` ADD COLUMN `cleanup_enabled` integer NOT NULL DEFAULT 0;

-- NULL = server uses the baked-in default prompt; any non-null value is
-- the user's custom system prompt. Stored unencrypted because it's user
-- preference text, not a secret. Capped at 4 KB in the server-action zod
-- schema — enough for elaborate style guides, short enough to keep chat-
-- completion tokens predictable.
ALTER TABLE `users` ADD COLUMN `cleanup_system_prompt` text;
