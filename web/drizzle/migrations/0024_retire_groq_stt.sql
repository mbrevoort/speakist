-- Retire Groq as an STT provider. Deepgram nova-3 outperformed Groq Whisper
-- on latency + accuracy and has been the default for every language since
-- the routing change; the Groq adapter is removed in the same release.
--
-- Two data concerns:
--
--   1. `provider_pricing` — deactivate (NOT delete) the groq rows. Historical
--      usage_events with provider_id='groq' keep their recorded costs, and
--      keeping the rows preserves any future need to recompute margins.
--
--   2. `organizations.allowed_models_json` — orgs pinned to a groq model via
--      the super-admin allow-list would otherwise fall through the (now
--      adapter-validated) slug parser on every request. Strip `groq/*`
--      entries; NULL-out lists that become empty (NULL = "no restriction",
--      which routes to the deepgram default — the correct successor).
--
-- Note: the Groq KEY infrastructure (organizations.groq_key_override_encrypted,
-- app_settings.system_groq_key_encrypted) is intentionally untouched — the
-- polish LLM runs on Groq and resolves its key through those columns.

UPDATE provider_pricing SET active = 0 WHERE provider_id = 'groq';

-- Remove groq/* entries from any non-NULL allow-list.
UPDATE organizations
SET allowed_models_json = (
  SELECT json_group_array(je.value)
  FROM json_each(organizations.allowed_models_json) AS je
  WHERE je.value NOT LIKE 'groq/%'
)
WHERE allowed_models_json IS NOT NULL
  AND allowed_models_json LIKE '%groq/%';

-- Lists that only contained groq entries are now '[]' — normalize to NULL
-- ("no restriction") so those orgs use the global deepgram default.
UPDATE organizations
SET allowed_models_json = NULL
WHERE allowed_models_json = '[]';
