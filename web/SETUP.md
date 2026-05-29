# Speakist web — local setup checklist

One-page path from fresh clone to running web backend **locally**. Every
step is idempotent; re-running is safe.

We deploy via the **OpenNext Cloudflare adapter** (`@opennextjs/cloudflare`),
which emits a single Worker that serves the entire Next.js app (SSR + API
routes) with static assets via Cloudflare's `ASSETS` binding. The older
`@cloudflare/next-on-pages` approach is deprecated — don't use it.

### Related docs

- **Deploying to a real Cloudflare environment** (dev or prod) →
  [DEPLOYING.md](./DEPLOYING.md). Covers custom domains, Stripe webhooks,
  `/admin/system` configuration.
- **Shipping a Mac DMG** (signing, notarization, Sparkle updates) →
  [../docs/releasing.md](../docs/releasing.md). Independent of web
  deployment.
- **Everything else** (architecture, env matrix, secret locations) →
  [../docs/README.md](../docs/README.md).

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm install -g pnpm`)
- A **Cloudflare account** (free) → https://dash.cloudflare.com/sign-up
- `wrangler` and OpenNext adapter are installed locally via pnpm — no global
  installs needed.

## 1. Install dependencies

```bash
cd web
pnpm install
```

## 2. Sign in to Cloudflare

```bash
pnpm exec wrangler login
```

Opens a browser, OAuths your Cloudflare account into wrangler. One-time per
machine.

## 3. Create the D1 database (dev)

```bash
pnpm exec wrangler d1 create speakist-dev
```

wrangler prints something like:

```
✅ Successfully created DB 'speakist-dev'
[[d1_databases]]
binding = "DB"
database_name = "speakist-dev"
database_id = "7c9a..."
```

Copy the `database_id` and paste it into `wrangler.toml` under the **default**
`[[d1_databases]]` block, replacing `__FILL_ME_IN__`.

## 4. (Optional, for prod deploy) Create the prod D1

```bash
pnpm exec wrangler d1 create speakist-prod
```

Paste the id into the `[env.production]` block of `wrangler.toml`.

## 5. Apply migrations to the local D1 mirror

```bash
pnpm db:migrate:local
```

`wrangler` keeps a local SQLite file under `.wrangler/state/` that mirrors
the remote DB. `next dev` reads this.

Sanity check:

```bash
pnpm exec wrangler d1 execute speakist-dev --local --env dev --command="select name from sqlite_master where type='table'"
```

Should print ~13 tables.

## 6. Seed the local DB

```bash
pnpm db:seed:local
```

Creates the super-admin user (`admin@example.com` — edit
`scripts/seed.sql` first if you want a different one, or just sign
in below and UPDATE the email afterwards), a demo "Acme" org, and a
$5 signup-bonus ledger row.

## 7. Create `.env.local`

```bash
cp .env.example .env.local

# Generate AUTH_SECRET
openssl rand -base64 33 | pbcopy
# Paste into AUTH_SECRET in .env.local
```

Leave Resend/Stripe/Groq/Deepgram blank for now — magic-link emails
will be logged to the dev console instead of sent. Transcription
won't work locally until you set a `GROQ_API_KEY` in `.env.local` (or
configure a system Groq key at `/admin/system` after step 9 below).

## 8. Run the dev server

```bash
pnpm dev
```

Open http://localhost:3000 — you should see the Phase-1 placeholder.

To test magic-link sign-in:
1. Visit http://localhost:3000/api/auth/signin
2. Enter `admin@example.com` (or whichever email you put in
   `seed.sql`)
3. Look at your `pnpm dev` console — the magic link is printed there
4. Click it; you're signed in with super-admin privileges

To preview the **built Worker** locally (closer to what ships to prod):

```bash
pnpm cf:preview
```

This runs `opennextjs-cloudflare build` then serves the Worker via
`wrangler dev`.

## 9. Deploy to Cloudflare

```bash
# Dev Worker — deploys as `speakist-web-dev`
pnpm deploy:dev

# Prod Worker — deploys as `speakist-web-prod`
pnpm deploy:prod
```

First deploy creates the Worker; subsequent deploys update it. No separate
"create project" step needed (unlike Pages).

Then migrate + seed the **remote** databases:

```bash
pnpm db:migrate:dev
pnpm db:seed:dev
# later, for prod:
pnpm db:migrate:prod
```

Set Worker secrets (prompts for value, encrypted at rest). Every command
needs `--env dev` or `--env production` since our `wrangler.toml` declares
both environments explicitly — wrangler won't guess.

```bash
# For the dev Worker:
pnpm exec wrangler secret put AUTH_SECRET --env dev
pnpm exec wrangler secret put AUTH_URL --env dev
pnpm exec wrangler secret put RESEND_API_KEY --env dev
# ... etc for every secret in .env.example

# For prod:
pnpm exec wrangler secret put AUTH_SECRET --env production
# ... etc
```

For the full dev deploy walkthrough (custom domain, Stripe webhook, invite-
only toggle, etc.), see [DEPLOYING.md](./DEPLOYING.md).

## Services you'll need (free tiers fine)

| Service | Used for | When you need it |
|---|---|---|
| **Cloudflare** | Hosting + D1 + Workers | Step 1 of any deploy |
| **Resend** | Magic-link + invitation emails | First user signup (dev console works as a fallback) |
| **Stripe** | Billing | First top-up |
| **Groq** | Default upstream STT (Whisper Turbo / Whisper Large) + polish LLM | First transcription |
| **Deepgram** | Optional alternate STT for orgs the super admin pins to it | Only when an org's `allowed_models_json` references a `deepgram/*` model |

## Dev ↔ Prod workflow

- **Daily dev**: `pnpm dev` for tight iteration (uses local D1 mirror).
- **Integration check**: `pnpm deploy:dev` → test against the real
  `speakist-web-dev` Worker + remote D1.
- **Ship to prod**: `pnpm deploy:prod` (or wire into a GitHub Action on
  merge to main).

Different D1 dbs, different Workers, different secrets — they never touch
each other. No shared data, no "oops I ran the dev seed against prod" risk.

## Troubleshooting

- **`getCloudflareContext is not available`** — you're calling `getDb()`
  from client code or during build. Move to a server component / route
  handler / server action.
- **`D1_ERROR: no such table: users`** — you haven't run `pnpm db:migrate:local`
  yet, or `wrangler.toml` points at a different database name.
- **Magic-link email never arrives in dev** — look at your `pnpm dev`
  console output; when `RESEND_API_KEY` is unset the link prints there.
- **"No Cloudflare env bindings found in next dev"** — confirm
  `next.config.ts` calls `initOpenNextCloudflareForDev()` and your
  wrangler.toml is valid. `pnpm exec wrangler d1 list` should show your dbs.
- **D1 `database_id` not set** — if you skipped step 3/4, `wrangler dev`
  will error. Paste the ids into `wrangler.toml`.
- **Build fails with "Cannot find module '@cloudflare/next-on-pages'"** —
  that package is deprecated. If you see references to it, you're on an
  older branch; pull latest.

## Commands cheat-sheet

| Task | Command |
|---|---|
| Dev server | `pnpm dev` |
| Preview built Worker locally | `pnpm cf:preview` |
| Build Worker only | `pnpm cf:build` |
| Deploy dev Worker | `pnpm deploy:dev` |
| Deploy prod Worker | `pnpm deploy:prod` |
| Local D1 migrate | `pnpm db:migrate:local` |
| Dev D1 migrate (remote) | `pnpm db:migrate:dev` |
| Prod D1 migrate (remote) | `pnpm db:migrate:prod` |
| Generate next migration | `pnpm db:generate` |
| Drizzle studio (inspect schema) | `pnpm db:studio` |
| Local query | `pnpm exec wrangler d1 execute speakist-dev --local --command="..."` |
