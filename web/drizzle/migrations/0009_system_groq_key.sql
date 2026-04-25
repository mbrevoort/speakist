-- System-wide Groq API key, encrypted at rest. Mirrors the existing
-- `system_deepgram_key_encrypted` column added in 0000_init.sql; the
-- default transcription routing is now Groq-first (English → Whisper
-- Turbo, other languages → Whisper Large) so this column is load-
-- bearing. Configured via super admin → System.
--
-- NULL = not configured. resolveProviderKey() falls back to the
-- GROQ_API_KEY env secret when this is NULL, then to a 500 if neither
-- is set.

ALTER TABLE app_settings ADD COLUMN system_groq_key_encrypted TEXT;
