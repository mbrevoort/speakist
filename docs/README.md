# Speakist — operations docs

How Speakist is built, deployed, and operated. Start with
[architecture.md](architecture.md) if you don't know where to look;
otherwise jump straight to the right page below.

## Where to read what

| I want to… | Read |
|---|---|
| Understand how the pieces fit together | [architecture.md](architecture.md) |
| **Run the backend locally** (`pnpm dev`, local D1, magic-link via console) | [../web/SETUP.md](../web/SETUP.md) |
| **Deploy the backend** to a fresh Cloudflare environment | [../web/DEPLOYING.md](../web/DEPLOYING.md) |
| **Trigger a release** (or understand what CI ships automatically) | [cicd.md](cicd.md) |
| Understand the **four-tier config model** | [cicd.md § Config management](cicd.md#config-management) |
| **Manually ship a Mac DMG** (emergency / no-CI fallback) | [releasing.md](releasing.md) |
| Build + run the Mac or iOS app from Xcode during development | [../README.md#build-the-mac-app](../README.md#build-the-mac-app) |
| Wire an agent against the polish-prompt active-learning loop | [feedback-agent.md](feedback-agent.md) |
| Mirror prompt iterations from prod to dev | [polish-prompt-mirror.md](polish-prompt-mirror.md) |

## Environments at a glance

| Concern | local | dev / staging | production |
|---|---|---|---|
| Web Worker | `pnpm dev` | `speakist-web-dev` on Cloudflare | `speakist-web-prod` on Cloudflare |
| D1 database | local mirror (`.wrangler/state`) | `speakist-dev` (remote) | `speakist-prod` (remote) |
| Web URL | `http://localhost:3000` | `speakist-dev.brevoortstudio.com` | `speakist.ai` |
| Mac DMG hosting | n/a | R2 → `downloads-dev.brevoortstudio.com` | R2 → `downloads.speakist.ai` |
| iOS app | n/a | TestFlight Internal Testing (`…ios.dev`) | TestFlight on the stable record (`…ios`) |
| Stripe | test mode + `stripe listen` | test mode | **live mode** |
| Auth email | logged to console | Resend | Resend |
| Mac build | Xcode Debug / Local channel | auto via [deploy-dev.yml](../.github/workflows/deploy-dev.yml) on push to `main` | auto via [deploy-prod.yml](../.github/workflows/deploy-prod.yml) on GitHub Release publish |
| Mac `apiBaseURL` default | `http://localhost:3000` | baked to dev URL | baked to `speakist.ai` |
| Sparkle update channel | n/a | `appcast-dev.xml` on dev Worker | `appcast.xml` (stable) / `appcast-beta.xml` (prerelease) on prod Worker |

The hostnames above are the canonical deployment's. Forks substitute
their own per [`../README.md#forking-this-repo`](../README.md#forking-this-repo).

## CI/CD vs manual

Both environments ship via GitHub Actions:

* **Dev** auto-deploys on every push to `main` — web Worker, Mac DMG
  (dev channel), and iOS TestFlight (Internal) all triggered by
  [deploy-dev.yml](../.github/workflows/deploy-dev.yml), with a path
  filter so unrelated commits skip the Apple jobs.
* **Production** auto-deploys on **GitHub Release publish**:
  [deploy-prod.yml](../.github/workflows/deploy-prod.yml) reads the
  release tag → `MARKETING_VERSION`, the release body markdown →
  Sparkle release notes (rendered via `gh api /markdown`), and the
  prerelease checkbox → channel (`stable` vs `beta`).

See [cicd.md](cicd.md) for the secrets checklist + failure modes, and
[releasing.md](releasing.md) for the manual `scripts/release.sh` path —
kept as a fallback for emergencies.

## First-time setup (new machine / new contributor)

Pick the path that matches what you need:

### "I just need the web backend running locally"
→ [web/SETUP.md](../web/SETUP.md). One hour. No Cloudflare deploy, no
Mac/iOS signing. Magic-link auth works offline (links print to console).

### "I'm setting up a new deployed environment (dev or prod)"
→ [web/DEPLOYING.md](../web/DEPLOYING.md). Step-by-step: D1 migration,
Worker secrets, custom domain, Stripe webhook, super admin keys.

### "I want to ship a manual Mac release"
→ [releasing.md](releasing.md). Both CI flows call the same
`scripts/release.sh` entry point, so this doc covers what every
release does end-to-end. Manual `make release` is the emergency
fallback when CI's down.

### "I want to wire up CI for a new environment"
→ [cicd.md](cicd.md). All 11 GitHub secrets, Apple Developer portal
one-time setup, Apple Distribution P12 export.

The four tracks are independent — you can run the backend without
ever building a DMG, ship a Mac DMG without deploying the backend to
prod, or wire up CI without ever running a manual release.

## Release channels

Three independent update channels for Mac, isolated by separate
appcast URLs:

| Channel | Purpose | Users | Cadence |
|---|---|---|---|
| `stable` | Public-facing | Everyone on the production hostname | Monthly-ish, manual |
| `beta` | Pre-release to catch regressions | Volunteer testers | Manual when you want a soak |
| `dev` | CI auto-builds on push to `main` | Internal | Every commit that touches Mac |

A Mac build belongs to exactly one channel — it's baked into the
Info.plist at release time. Users "switch channels" by installing a
different DMG. Full write-up: [releasing.md §0](releasing.md#0-release-channels).

iOS has two TestFlight records — one per environment. Promoting to
External Beta or App Store Review is a manual step in App Store
Connect.

## Configuration & secrets — where each value lives

Speakist uses a **four-tier config model** — every env-specific value
is in exactly one of these. Full write-up + recipes for adding new
values: [cicd.md § Config management](cicd.md#config-management).

| Tier | What | Source of truth | Examples |
|---|---|---|---|
| 1 | Build-time client bundle (`NEXT_PUBLIC_*`) | `web/package.json`'s `deploy:dev` / `deploy:prod` scripts | `NEXT_PUBLIC_SITE_URL` |
| 2 | Worker runtime vars (non-secret, per env) | `web/wrangler.toml` `[env.X.vars]` | `RELEASE_DOWNLOAD_BASE_URL`, `IOS_TESTFLIGHT_URL`, `RESEND_FROM_EMAIL`, `SUPER_ADMIN_EMAIL` |
| 3 | Worker secrets (encrypted, per env) | `wrangler secret put X --env <dev\|production>` | `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GROQ_API_KEY`, `RELEASE_PUBLISH_TOKEN` |
| 4 | Native app channel config (Mac/iOS) | `project.yml` build settings + `scripts/release.sh` channel matrix | bundle ID, `SPEAKIST_API_BASE_URL`, `SPEAKIST_FEED_URL` |

Provider keys (Groq, DeepGram), polish prompts, and Slack webhook URLs
live in D1 and are managed through the `/admin/system` and
`/admin/polish-prompts` admin UIs — see those pages for the live
configuration; the keys themselves are AES-GCM-encrypted at rest with
`APP_ENCRYPTION_KEY`.

## Emergency runbooks

- **Bad Mac release ships** → [releasing.md §3](releasing.md#3-emergency-rollback)
  (yank via SQL update; DMG stays on R2 for audit)
- **Stripe webhook broken** →
  `wrangler tail speakist-web-prod --env production --format pretty`
  in one terminal, `stripe trigger checkout.session.completed` in
  another
- **Transcription failing globally** → check system Groq + DeepGram
  keys at `/admin/system`; check `wrangler tail` for `no_key_configured`
- **D1 schema drift / migration needed** → `web/drizzle/migrations/` +
  `pnpm db:migrate:{dev,prod}` (CI runs the dev one automatically)
- **iOS cert cap hit** ("Choose a certificate to revoke") →
  [cicd.md failure modes](cicd.md#failure-modes) — revoke + re-export
  the Apple Distribution P12.

---

*If you edited this file: please also update the cross-links in
whatever detail doc you added. This index is load-bearing for
navigation.*
