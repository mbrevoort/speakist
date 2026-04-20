# Speakist web — deployment runbook

Three environments by design:

| Environment | Worker | D1 DB | Domain | Stripe | Mac points at |
|---|---|---|---|---|---|
| **local** | `wrangler dev` / `next dev` | `speakist-dev` (local mirror under `.wrangler/`) | `http://localhost:3000` | test mode + `stripe listen` | `http://localhost:3000` (default) |
| **dev/staging** | `speakist-web-dev` | `speakist-dev` (remote) | `speakist-dev.brevoortstudio.com` | test mode | `https://speakist-dev.brevoortstudio.com` |
| **production** | `speakist-web-prod` | `speakist-prod` (remote) | `speakist.ai` | **live mode** | `https://speakist.ai` |

This doc covers the **dev/staging** deploy end-to-end. Production follows the same pattern with `--env production` on every wrangler invocation and live-mode Stripe keys.

---

## Before you start

You need:
- The repo checked out locally, `pnpm install` already done in `web/`
- `wrangler login` completed once (OAuths your Cloudflare account)
- Access to the Cloudflare dashboard for attaching the custom domain
- A Deepgram admin API key (same one you use locally)
- A Stripe account with test mode available

**Check your current state:**
```bash
cd web
pnpm exec wrangler whoami    # confirms your Cloudflare account
pnpm exec wrangler d1 list   # should show `speakist-dev`
```

If `speakist-dev` doesn't show up, you never created the remote D1. Run:
```bash
pnpm exec wrangler d1 create speakist-dev
# paste the returned database_id into wrangler.toml if it's still set to __FILL_ME_IN__
```

---

## 1. Apply migrations to the remote dev D1

Local migrations only affect the `.wrangler/state/` file. To migrate the
actual Cloudflare-hosted D1, use `--remote`:

```bash
pnpm db:migrate:dev
```

This is `wrangler d1 migrations apply speakist-dev --remote --env dev`.
You'll see it apply everything from `drizzle/migrations/*.sql` in order.

Sanity check:
```bash
pnpm exec wrangler d1 execute speakist-dev --remote --env dev \
  --command="SELECT name FROM sqlite_master WHERE type='table'"
```
Should print ~13 tables.

---

## 2. Seed the super admin into the remote DB

Same seed we used locally, pointed at remote:

```bash
pnpm db:seed:dev
```

This creates `mike@brevoort.com` as super admin, `Brevoort Studio` as the
seed org, and grants the $5 signup bonus.

(If you want a different super-admin email, edit `scripts/seed.sql`
before running — the email is hard-coded there so it's idempotent.)

---

## 3. Set all the Worker secrets

These are the production-style secrets for the **dev** Worker. They're
encrypted at rest on Cloudflare and only visible to the Worker at runtime.
Every `wrangler secret put X` prompts for the value — paste, hit enter.

```bash
# Auth.js secret — generate once per environment
pnpm exec wrangler secret put AUTH_SECRET --env dev
# value: openssl rand -base64 33

# Auth.js needs the public URL to generate correct callback links
pnpm exec wrangler secret put AUTH_URL --env dev
# value: https://speakist-dev.brevoortstudio.com

# AES-256 key for encrypting Deepgram keys at rest
pnpm exec wrangler secret put APP_ENCRYPTION_KEY --env dev
# value: openssl rand -base64 32

# Public site URL (read by metadataBase, used in emails, OG tags)
pnpm exec wrangler secret put NEXT_PUBLIC_SITE_URL --env dev
# value: https://speakist-dev.brevoortstudio.com

# Resend email
pnpm exec wrangler secret put RESEND_API_KEY --env dev
# value: re_... from https://resend.com/api-keys
pnpm exec wrangler secret put RESEND_FROM_EMAIL --env dev
# value: noreply@speakist-dev.brevoortstudio.com  (domain must be verified in Resend)

# Stripe (test mode — safe to share with dev env)
pnpm exec wrangler secret put STRIPE_SECRET_KEY --env dev
# value: sk_test_... from https://dashboard.stripe.com/test/apikeys
# STRIPE_PUBLISHABLE_KEY is optional for our current code (no Stripe.js on client)
# STRIPE_WEBHOOK_SECRET — set AFTER step 6 when you create the dev webhook endpoint

# Deepgram (the *project ID* only — the master key goes into /admin/system)
pnpm exec wrangler secret put DEEPGRAM_PROJECT_ID --env dev
# value: the UUID from Deepgram → Project Settings

# Super admin email (defaults to mike@brevoort.com if unset)
pnpm exec wrangler secret put SUPER_ADMIN_EMAIL --env dev
# value: mike@brevoort.com
```

List what's set (without values) to sanity check:
```bash
pnpm exec wrangler secret list --env dev
```

---

## 4. First deploy

```bash
pnpm deploy:dev
```

This runs `opennextjs-cloudflare deploy`, which:
1. Builds the Next.js app via OpenNext (emits `.open-next/worker.js` + `.open-next/assets/`)
2. Uploads to Cloudflare as the `speakist-web-dev` Worker
3. Prints the default `speakist-web-dev.<your-subdomain>.workers.dev` URL

At this point the site is live but on Cloudflare's default hostname.
Open that URL — the landing page should render.

Sign-in won't work yet because `AUTH_URL` is pointing at the custom
domain we haven't attached. Fix that in the next step.

---

## 5. Attach the custom domain

Two paths, depending on where `brevoortstudio.com` lives:

### 5a. If brevoortstudio.com is already on Cloudflare (using their nameservers)

1. Cloudflare dashboard → Workers & Pages → **speakist-web-dev**
2. Settings → Triggers → **Custom Domains** → **Add Custom Domain**
3. Enter `speakist-dev.brevoortstudio.com`
4. Cloudflare provisions the cert and sets up routing automatically.
   Ready in under a minute.

### 5b. If brevoortstudio.com uses different nameservers (Route53, etc.)

You have two options:

- **Easiest**: Add `brevoortstudio.com` to Cloudflare as a new zone (free
  plan works). Follow Cloudflare's DNS-migration wizard, update your
  registrar's nameservers. Then follow 5a.

- **Alternative**: Set up a Worker **Route** instead of a Custom Domain,
  and manually CNAME from your existing DNS:
  ```
  speakist-dev  CNAME  speakist-web-dev.<your-cf-subdomain>.workers.dev
  ```
  Then in wrangler.toml:
  ```toml
  [[routes]]
  pattern = "speakist-dev.brevoortstudio.com/*"
  custom_domain = true
  ```
  Redeploy. Requires the domain to be on Cloudflare as a zone either
  way, so 5a is usually easier.

---

## 6. Stripe webhook for the dev URL

In Stripe dashboard → make sure "Viewing test data" is ON (top-right toggle)
→ Developers → **Webhooks** → **Add endpoint**:

- **Endpoint URL**: `https://speakist-dev.brevoortstudio.com/api/stripe/webhook`
- **Events to send**: at minimum these three —
  - `checkout.session.completed`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
- Create endpoint

Click the endpoint → **Signing secret** → Reveal → copy the `whsec_...` value.
Then back in terminal:

```bash
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
# paste the whsec_...
```

Redeploy so the Worker picks up the new secret:
```bash
pnpm deploy:dev
```

**Live mode vs test mode note**: Stripe separates webhooks by mode. Your dev
webhook lives in test mode. When you deploy prod later, you'll create a
**separate** webhook endpoint in Stripe live mode pointing at
`https://speakist.ai/api/stripe/webhook`, and set
`STRIPE_WEBHOOK_SECRET --env production` with that endpoint's secret.
The two never share state.

---

## 7. Activate the Customer Portal (test mode)

Stripe's Customer Portal lets users update their saved payment method +
see invoices. It's separate from Checkout and needs a one-time activation
per mode.

https://dashboard.stripe.com/test/settings/billing/portal → click **Save**
near the top (defaults are fine for now).

This only needs to happen once per Stripe mode (test now, live later when
going to prod).

---

## 8. Set the system Deepgram key via /admin/system

The Deepgram admin API key (the one with `keys:write`) is stored in the
database encrypted by `APP_ENCRYPTION_KEY`, not in env vars. Configure
through the UI:

1. Visit `https://speakist-dev.brevoortstudio.com/auth/signin`
2. Sign in as `mike@brevoort.com` — the magic link will land in your
   Resend inbox (or your email, if you've verified the domain)
3. After signin, go to `/admin/system`
4. System Deepgram key → **Set key** → paste your Deepgram admin API key → Save

If it complains about `APP_ENCRYPTION_KEY`, double-check step 3 actually
set that secret.

---

## 9. Flip the "allow public signup" toggle OFF

This is the new knob you asked for:

Same page, `/admin/system` → **Public signup** card → **Turn OFF**.

From this point forward, new email signups on the dev environment who
**don't** match an invitation or an existing org's auto-join domain
will land on an "Awaiting invitation" screen instead of getting a
workspace. Your super-admin org keeps working; invitations you send
from `/dashboard/members` still work; auto-join-domain (set in
`/dashboard/settings`) still works.

---

## 10. Smoke test end-to-end

On the dev URL (`https://speakist-dev.brevoortstudio.com`):

- [ ] Landing page renders; pricing block shows the correct per-1000-word rate
- [ ] Sign out. Try signing up with a fresh email (not mike@brevoort.com).
      Should land on "Awaiting invitation" — proving the toggle works.
- [ ] Sign back in as mike@brevoort.com. Go to `/dashboard/members`, invite
      that fresh email. Accept the invitation in another browser. New user
      lands in your org as a member.
- [ ] Go to `/dashboard/billing`. Click the $10 top-up tile. Use Stripe's
      test card `4242 4242 4242 4242` / any future expiry / any CVC. Stripe
      Checkout completes → you return to the dashboard → the ledger shows
      a `+$10.00` Stripe top-up row within ~10 seconds.
- [ ] Point your Mac app at the dev URL:
      ```bash
      defaults write com.brevoort-studio.speakist apiBaseURL "https://speakist-dev.brevoortstudio.com"
      ```
      Restart Speakist. Sign in (device code flow works over HTTPS the same
      as local). Hold ⌃⌘X, dictate. Confirm `/dashboard/usage` shows the
      event and `/dashboard/billing` shows a per-word debit.

Everything green? Dev is ready. Share the URL with teammates; invite them
from `/dashboard/members`.

---

## Switching your Mac between environments

The Mac only talks to one backend at a time. To switch:

```bash
# Point at local dev server
defaults write com.brevoort-studio.speakist apiBaseURL "http://localhost:3000"

# Point at deployed dev
defaults write com.brevoort-studio.speakist apiBaseURL "https://speakist-dev.brevoortstudio.com"

# Point at production (when it exists)
defaults write com.brevoort-studio.speakist apiBaseURL "https://speakist.ai"
```

After each change, restart Speakist.

**Note**: each environment has its own `mac_sessions` table. Switching URLs
invalidates your previous session — you'll need to sign in again via the
Account tab. That's intentional; a token issued by one environment should
never work against another.

---

## Rolling back / redeploying

Code change → redeploy:
```bash
pnpm deploy:dev
```

Schema change → always apply migrations BEFORE deploying:
```bash
pnpm db:migrate:dev
pnpm deploy:dev
```

Rollback: Cloudflare's Workers UI → Deployments tab → pick a prior version
→ Rollback. Instant. Migration rollbacks are manual — Drizzle doesn't
auto-generate down-migrations, so undoing schema changes is a "write a
new forward migration" affair.

---

## When you're ready for production

Everything in this doc with `--env production` and `https://speakist.ai`
instead of the dev URL. Two important swaps:

1. Create `speakist-prod` D1 (`wrangler d1 create speakist-prod --env production`), paste ID into `wrangler.toml` `[env.production]`
2. All `wrangler secret put` commands take `--env production` and use the LIVE Stripe keys (`sk_live_...`, `whsec_` from a live webhook endpoint)
3. Leave `allow_public_org_creation` = ON in prod (the business model is random signups)
