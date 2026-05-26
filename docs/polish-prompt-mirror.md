# Polish-prompt mirror — prod → dev

Prod's `/admin/polish-prompts` has a **Mirror → dev** button per mode.
Clicking it copies prod's currently active prompt into dev's
`polish_prompt_versions` table as a new row with `source='mirror'`,
fires the dev Slack `prompt_update` channel, and surfaces the new dev
version number back to the prod operator.

The button is **disabled by default**. It enables once both of the
following are set on the prod Worker.

## One-time setup

### 1. Mint a `prompts:write` service token on **dev**

Sign in to the dev environment as a super admin, go to
`/admin/tokens`, click **Create token**, label it `prod-mirror`, and
check **`prompts:write`** (and only that scope — read isn't needed for
mirroring).

Submit. Copy the plaintext token that appears once (`ssat_…`); the DB
only stores its hash from this point forward.

### 2. Set the secret on **prod**

From the repo root:

```sh
cd web
pnpm exec wrangler secret put DEV_MIRROR_TOKEN --env production
# paste the ssat_… plaintext when prompted
```

Wrangler confirms with `✨ Success! Uploaded secret …`. The value
lives encrypted in Cloudflare's secret store from here on.

### 3. (Already done in the repo, but verify) prod knows dev's URL

`web/wrangler.toml` under `[env.production.vars]`:

```toml
DEV_MIRROR_BACKEND_URL = "https://speakist-dev.brevoortstudio.com"
```

That's the dev Worker's public origin — the sender POSTs to
`${DEV_MIRROR_BACKEND_URL}/api/admin/polish-prompts/mirror-receive`.
Change it only if dev moves to a different domain.

### 4. Redeploy prod

```sh
pnpm deploy:prod
```

Worker secrets refresh on cold start; the next admin who loads
`/admin/polish-prompts` on prod sees the **Mirror → dev** button
enabled.

## What happens when you click Mirror → dev

1. Prod reads its own active prompt for the chosen mode.
2. Prod POSTs `{ mode, body, notes, source_version, source_bench_score }`
   to dev's `/api/admin/polish-prompts/mirror-receive` with
   `Authorization: Bearer ${DEV_MIRROR_TOKEN}`.
3. Dev verifies the token, checks the `prompts:write` scope, and
   calls `createVersion` with `source='mirror'`. The notes field is
   auto-prefixed with `"Mirrored from prod v{N}"`.
4. Dev's `insertActiveVersion` fires the dev Slack `prompt_update`
   channel — the receiving env's operators see the change in their
   own timeline.
5. Dev returns `{ id, mode, version, is_active }`; prod's admin UI
   shows a toast: "Mirrored intuitive v12 → dev v7."

## Failure modes

The button surfaces a clear error in the admin UI for each.

| Symptom | Likely cause | Fix |
|---|---|---|
| `mirror_not_configured` | `DEV_MIRROR_BACKEND_URL` or `DEV_MIRROR_TOKEN` missing on prod | Re-run step 2 + step 4 above |
| `no_active_version` | No `polish_prompt_versions` row with `is_active = 1` for this mode | Create or roll back to a version on prod first |
| `dev_rejected` 401/403 | Dev says the token is invalid, revoked, or missing the scope | Mint a fresh token on dev (step 1); re-set the secret on prod (step 2); redeploy |
| `dev_rejected` 400 | Bad body — likely a code-level bug. The detail field carries dev's response | File an issue with both bodies |
| `dev_unreachable` | Network / DNS / dev Worker down | Check `https://speakist-dev.brevoortstudio.com/` health |

## Reverse direction (dev → prod)

Intentionally not supported. The active learning loop runs against the
dev corpus first; mirroring prod's active back to dev clean-slate is
the safe direction. If you want to move a dev-iterated prompt to prod,
do it explicitly: copy the body into prod's admin UI as a new version,
or run the agent against the prod backend with its own service token.
