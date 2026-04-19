# Speakist web — setup checklist

One-page checklist for going from fresh clone to working dev environment.
Everything is env-var driven; no hard-coded secrets anywhere.

## Prerequisites
- **Node.js 20+** and **pnpm** (or npm — `package.json` is pnpm-flavored but compatible)
- **Docker Desktop** (Supabase local dev runs Postgres in a container)
- **Supabase CLI** — `brew install supabase/tap/supabase`
- **Stripe CLI** (only needed once you hit Phase 4) — `brew install stripe/stripe-cli/stripe`

## 1. Install dependencies

```bash
cd web
pnpm install
```

## 2. Accounts you need (free tiers fine for dev)

| Service | Used for | Phase | Link |
|---|---|---|---|
| **Supabase** | Postgres + Auth | 1+ | https://supabase.com/dashboard |
| **Vercel** | Hosting the web app | 1+ (for deploy) | https://vercel.com |
| **Resend** | Transactional email | 3 | https://resend.com |
| **Stripe** | Payments (test mode) | 4 | https://dashboard.stripe.com/test |
| **Deepgram** | STT (project-key for minting short-lived keys) | 6 | https://console.deepgram.com |

For local dev, you can skip Supabase Cloud and use the local stack — see step 4.

## 3. Copy env template

```bash
cp .env.example .env.local
# Generate the encryption key
openssl rand -base64 32 | pbcopy
# Paste it into APP_ENCRYPTION_KEY in .env.local
```

Fill in the NEXT_PUBLIC_SUPABASE_* + SUPABASE_SERVICE_ROLE_KEY values from
either step 4a (local) or 4b (cloud). Leave Stripe/Deepgram/Resend blank — the
build tolerates missing optional vars until you reach those phases.

## 4. Supabase — pick ONE

### 4a. Local (fastest for dev)

```bash
# From web/ — starts Postgres + Auth + Studio in Docker.
pnpm db:start

# Apply migrations. (Re-runs the files in supabase/migrations/.)
pnpm db:reset

# Seed: creates mike@brevoort.com as super admin, demo org, $5 bonus credit.
pnpm db:seed
```

`supabase start` prints the API URL, anon key, and service_role key — copy
them into `.env.local`. Supabase Studio is at http://localhost:54323.

Local auth emails land in **Inbucket** at http://localhost:54324 (no real
email account needed).

### 4b. Cloud (for deploys / shared dev)

1. Create a Supabase project at https://supabase.com/dashboard.
2. Copy Project URL + anon + service_role keys into `.env.local`.
3. Link and push migrations:
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push
   ```
4. Seed (same script, points at cloud via env vars):
   ```bash
   pnpm db:seed
   ```

## 5. Run the dev server

```bash
pnpm dev
```

Open http://localhost:3000 — you should see the Phase-1 placeholder.

Sanity-check the database by visiting Supabase Studio (local:
http://localhost:54323, cloud: dashboard) and confirming:
- `profiles` has one row with `is_super_admin = true`
- `organizations` has "Brevoort Studio"
- `credit_ledger` has one `signup_bonus` row for 500000 millicents ($5.00)

## 6. Deploy to Vercel (optional until Phase 2)

1. Push to GitHub.
2. `vercel link` from the `web/` directory.
3. In Vercel → Settings → Environment Variables, add every var from
   `.env.local`. **NEXT_PUBLIC_SITE_URL** should be the production URL
   (`https://speakist.brevoort.com` for now).
4. Add a custom domain in Vercel and point DNS at it.

## Troubleshooting

- **`pnpm db:seed` errors about missing service_role key** — you haven't
  loaded `.env.local`. Try: `set -a; source .env.local; set +a; pnpm db:seed`.
- **RLS denies every read** — you're probably querying as `anon`; use the
  signed-in client or the service-role admin client.
- **Migration fails on `CREATE EXTENSION`** — the Supabase local stack has
  `uuid-ossp` and `pgcrypto` pre-enabled; this is only an issue on a bare
  Postgres. Run `create extension if not exists "uuid-ossp";` manually.
- **`pnpm dev` complains about Inter font fetch** — first run pulls Google
  Fonts via `next/font`. Set `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=1` for airgap
  dev or commit `next` font cache.
