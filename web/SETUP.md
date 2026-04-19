# Speakist web — setup checklist

One-page path from fresh clone to running dev environment on Cloudflare.
Every step is idempotent; re-running is safe.

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm install -g pnpm`)
- A **Cloudflare account** (free) → https://dash.cloudflare.com/sign-up
- **wrangler** CLI will be installed locally via pnpm — no global install needed.

## 1. Install dependencies

```bash
cd web
pnpm install
```

This also installs `wrangler` and `drizzle-kit` as local devDependencies,
so everything works via `pnpm <command>` or `pnpm exec <binary>`.

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
the remote DB. `next dev` + `wrangler pages dev` both read this.

Sanity check:

```bash
pnpm exec wrangler d1 execute speakist-dev --local --command="select name from sqlite_master where type='table'"
```

Should print ~13 tables.

## 6. Seed the local DB

```bash
pnpm db:seed:local
```

Creates the super-admin user (`mike@brevoort.com`), a demo "Brevoort Studio"
org, and a $5 signup-bonus ledger row.

## 7. Create `.env.local`

```bash
cp .env.example .env.local

# Generate AUTH_SECRET
openssl rand -base64 33 | pbcopy
# Paste into AUTH_SECRET in .env.local
```

Leave Resend/Stripe/Deepgram blank for now — magic-link emails will be
logged to the dev console instead of sent.

## 8. Run the dev server

```bash
pnpm dev
```

Open http://localhost:3000 — you should see the Phase-1 placeholder.

To test magic-link sign-in:
1. Visit http://localhost:3000/api/auth/signin
2. Enter `mike@brevoort.com`
3. Look at your `pnpm dev` console — the magic link is printed there
4. Click it; you're signed in with super-admin privileges

## 9. (When ready to deploy) Create the Pages project

```bash
pnpm pages:build                                # builds .vercel/output/static
pnpm exec wrangler pages project create speakist-dev --production-branch main
pnpm deploy:dev                                  # uploads the build
```

Then migrate + seed the **remote** dev database:

```bash
pnpm db:migrate:dev
pnpm db:seed:dev
```

And set production secrets (prompts for value, encrypted at rest in CF):

```bash
pnpm exec wrangler pages secret put AUTH_SECRET --project-name speakist-dev
pnpm exec wrangler pages secret put AUTH_URL --project-name speakist-dev
pnpm exec wrangler pages secret put RESEND_API_KEY --project-name speakist-dev
# ... etc for the secrets in .env.example
```

Production is the same flow with `speakist-prod` and `--remote --prod`.

## Services you'll need (free tiers fine)

| Service | Used for | When you need it |
|---|---|---|
| **Cloudflare** | Hosting + D1 + Workers | Phase 1 (now) |
| **Resend** | Magic-link + invitation emails | Phase 3, though dev-console works before |
| **Stripe** | Billing | Phase 4 |
| **Deepgram** | Short-lived STT keys | Phase 6 |

## Dev ↔ Prod workflow

- **Daily dev**: `pnpm dev` for tight iteration (uses local D1 mirror).
- **Integration check**: `pnpm deploy:dev` → test against real D1 on your
  dev Pages site.
- **Ship to prod**: `pnpm deploy:prod` (or wire into a GitHub Action on
  merge to main).

Different D1 dbs, different Cloudflare Pages projects, different env vars —
they never touch each other. No shared data, no "oops I ran the dev seed
against prod" risk.

## Troubleshooting

- **`getRequestContext is not available`** — you're calling `getDb()` from
  client code or during build. Move to a server component / route handler,
  or mark the page with `export const runtime = "edge"` if it's SSR.
- **`D1_ERROR: no such table: users`** — you haven't run `pnpm db:migrate:local`
  yet, or `wrangler.toml` points at a different database name.
- **Magic-link email never arrives in dev** — look at your `pnpm dev`
  console output; when `RESEND_API_KEY` is unset the link prints there.
- **"No Cloudflare env bindings found in next dev"** — make sure
  `next.config.ts` is calling `setupDevPlatform()` and your wrangler.toml
  is valid. `pnpm exec wrangler d1 list` should show your databases.
- **D1 `database_id` not set** — if you skipped step 3/4, `wrangler dev`
  will error. Paste the ids into `wrangler.toml`.

## Commands cheat-sheet

| Task | Command |
|---|---|
| Dev server | `pnpm dev` |
| Local D1 migrate | `pnpm db:migrate:local` |
| Dev D1 migrate | `pnpm db:migrate:dev` |
| Prod D1 migrate | `pnpm db:migrate:prod` |
| Generate next migration | `pnpm db:generate` |
| Drizzle studio (inspect DB) | `pnpm db:studio` |
| Local query | `pnpm exec wrangler d1 execute speakist-dev --local --command="..."` |
| Deploy dev | `pnpm deploy:dev` |
| Deploy prod | `pnpm deploy:prod` |
