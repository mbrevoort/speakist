# Speakist — operations docs

Everything about how Speakist is built, deployed, and operated. Skip
straight to the right page via the matrix below; if you don't know
where to start, [architecture.md](architecture.md) gives the system
overview.

## Where to read what

| I want to… | Read |
|---|---|
| Understand how the pieces fit together | [architecture.md](architecture.md) |
| See the product spec | [speakist-prd.md](speakist-prd.md) |
| **Run the backend locally** (`pnpm dev`, local D1, magic-link via console) | [../web/SETUP.md](../web/SETUP.md) |
| **Deploy the backend** to a fresh Cloudflare environment | [../web/DEPLOYING.md](../web/DEPLOYING.md) |
| **Trigger a release** (or understand what CI ships automatically) | [cicd.md](cicd.md) |
| Understand the **four-tier config model** (build-time vars, Worker vars, secrets, native channel) | [cicd.md § Config management](cicd.md#config-management) |
| **Manually ship a Mac DMG** (emergency / no-CI fallback) | [releasing.md](releasing.md) |
| Build + run the Mac or iOS app from Xcode during development | [../README.md#build-the-mac-app](../README.md#build-the-mac-app) |
| Track iOS App Store submission readiness (audit findings, what's done, what's left) | [ios-app-store-submission.md](ios-app-store-submission.md) |

## Environments at a glance

| Concern | local | dev / staging | production |
|---|---|---|---|
| Web Worker | `pnpm dev` | `speakist-web-dev` on Cloudflare | `speakist-web-prod` on Cloudflare |
| D1 database | local mirror (`.wrangler/state`) | `speakist-dev` (remote) | `speakist-prod` (remote) |
| Web URL | `http://localhost:3000` | `speakist-dev.brevoortstudio.com` | `speakist.ai` |
| Mac DMG hosting | n/a | R2 → `downloads-dev.brevoortstudio.com` | R2 → `downloads.speakist.ai` |
| iOS app | n/a | TestFlight Internal Testing (`com.brevoort-studio.speakist.ios.dev`) | TestFlight on the stable record (`com.brevoort-studio.speakist.ios`) |
| Stripe | test mode + `stripe listen` | test mode | **live mode** |
| Auth email | logged to console | Resend (`noreply@speakist.ai`) | Resend (`noreply@speakist.ai`) |
| Mac build | Xcode Debug / Local channel | auto via [deploy-dev.yml](../.github/workflows/deploy-dev.yml) on push to `main` | auto via [deploy-prod.yml](../.github/workflows/deploy-prod.yml) on GitHub Release publish |
| Mac `apiBaseURL` default | `http://localhost:3000` | baked to dev URL | baked to `speakist.ai` |
| Sparkle update channel | n/a | `appcast-dev.xml` on dev Worker | `appcast.xml` (stable) / `appcast-beta.xml` (prerelease) on prod Worker |

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
  prerelease checkbox → channel (`stable` vs `beta`). Drives the
  prod Worker, Mac DMG (stable/beta), and iOS TestFlight on the
  stable app record. iOS is skipped on prereleases (no
  `…ios.beta` bundle is provisioned by design).

See [cicd.md](cicd.md) for the secrets checklist + failure modes for
both pipelines, and [releasing.md](releasing.md) for the manual
`scripts/release.sh` path — kept as a fallback for emergencies (CI
down, hotfix needs to ship before the next merge to `main`, etc.).

## First-time setup (new machine / new contributor)

Pick the path that matches what you need:

### "I just need the web backend running locally"
→ [web/SETUP.md](../web/SETUP.md). One hour. No Cloudflare deploy, no
Mac/iOS signing. Magic-link auth works offline (links print to console).

### "I'm setting up a new deployed environment (dev or prod)"
→ [web/DEPLOYING.md](../web/DEPLOYING.md). Step-by-step: D1 migration,
Worker secrets, custom domain, Stripe webhook, super admin keys for
Groq + DeepGram.

### "I want to ship a manual Mac release"
→ [docs/releasing.md](releasing.md). Both CI flows (dev: push-to-main;
prod: GitHub Release) call the same `scripts/release.sh` entry point,
so this doc covers what every release does end-to-end. Manual
`make release` is the emergency fallback when CI's down.

### "I want to wire up CI for a new environment"
→ [docs/cicd.md](cicd.md). All 11 GitHub secrets, Apple Developer
portal one-time setup, Apple Distribution P12 export.

The four tracks are independent — you can run the backend without
ever building a DMG, ship a Mac DMG without deploying the backend to
prod, or wire up CI without ever running a manual release.

## Release channels

Three independent update channels for Mac, isolated by separate appcast
URLs:

| Channel | Purpose | Users | Cadence |
|---|---|---|---|
| `stable` | Public-facing | Everyone on speakist.ai | Monthly-ish, manual |
| `beta` | Pre-release to catch regressions | Volunteer testers | Manual when you want a soak |
| `dev` | CI auto-builds on push to `main` | Internal | Every commit that touches Mac |

A Mac build belongs to exactly one channel — it's baked into the
Info.plist at release time and can't be changed in-place. Users
"switch channels" by installing a different DMG. Full write-up:
[releasing.md §0](releasing.md#0-release-channels).

iOS has two TestFlight records — one per environment:

| Channel | App Store Connect record | Bundle ID | TestFlight track |
|---|---|---|---|
| dev | "Speakist Dev" | `com.brevoort-studio.speakist.ios.dev` | Internal Testing — auto-uploads on push to `main` |
| stable | "Speakist" | `com.brevoort-studio.speakist.ios` | Internal Testing — auto-uploads on GitHub Release publish |

Promoting to External Beta or App Store Review is a manual step in
App Store Connect. There's no separate iOS beta bundle; users in
the External Beta group on the stable record substitute for that.

## Configuration & secrets — where each value lives

Speakist uses a **four-tier config model** — every env-specific
value is in exactly one of these. Full write-up + recipes for adding
new values: [cicd.md § Config management](cicd.md#config-management).

| Tier | What | Source of truth | Examples |
|---|---|---|---|
| 1 | Build-time client bundle (`NEXT_PUBLIC_*`) | `web/package.json`'s `deploy:dev` / `deploy:prod` scripts | `NEXT_PUBLIC_SITE_URL` |
| 2 | Worker runtime vars (non-secret, per env) | `web/wrangler.toml` `[env.X.vars]` | `RELEASE_DOWNLOAD_BASE_URL`, `IOS_TESTFLIGHT_URL`, `RESEND_FROM_EMAIL`, `SUPER_ADMIN_EMAIL` |
| 3 | Worker secrets (encrypted, per env) | `wrangler secret put X --env <dev\|production>` | The table below |
| 4 | Native app channel config (Mac/iOS) | `project.yml` build settings + `scripts/release.sh` channel matrix | bundle ID, `SPEAKIST_API_BASE_URL`, `SPEAKIST_FEED_URL` |

### Tier 3 secrets

| Secret | Lives in | Used by | How to set |
|---|---|---|---|
| `AUTH_SECRET` | Worker secret | Auth.js signing | `wrangler secret put AUTH_SECRET --env <dev\|production>` |
| `APP_ENCRYPTION_KEY` | Worker secret | Encrypting per-org provider key overrides + system keys | `wrangler secret put …` |
| `RESEND_API_KEY` | Worker secret | Magic-link + invitation email | `wrangler secret put …` |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Worker secrets | Billing | `wrangler secret put …` |
| `DEEPGRAM_PROJECT_ID` | Worker secret | Project ID for the legacy Mac-direct DeepGram path | `wrangler secret put …` |
| System Groq key | D1 (encrypted) | Default transcription provider | `/admin/system` UI |
| System DeepGram key | D1 (encrypted) | Optional fallback when an org is pinned to DeepGram | `/admin/system` UI |
| Polish prompts (intuitive + prescriptive) | D1 (plain) | Server-side prompt for the polish LLM | `/admin/system` UI |
| `RELEASE_PUBLISH_TOKEN` | Worker secret | Auth for `release.sh` to publish appcast rows | `wrangler secret put …` |
| `SPEAKIST_PUBLISH_TOKEN_{DEV,PROD}` | Local shell env (laptop releases) / GitHub secret (CI) | Matches `RELEASE_PUBLISH_TOKEN` for the script to send | `~/.zshrc` or repo Actions secrets |
| Apple Developer ID (Mac codesign) | Login Keychain on dev laptop + GitHub secret as P12 for CI | Signing release Mac DMGs | Apple Developer portal export |
| Apple Distribution (iOS codesign) | GitHub secret as P12 | Signing iOS archives | Xcode → Settings → Accounts → Manage Certificates |
| App Store Connect API key (`.p8`) | GitHub secret | notarytool + altool TestFlight upload | App Store Connect → Users and Access → Integrations |
| Sparkle EdDSA private key | Login Keychain (laptop) + 1Password backup + GitHub secret | Signing DMG for auto-update | One-time `generate_keys` |
| Sparkle EdDSA public key | `project.yml` → `SUPublicEDKey` | Verifying updates on-device | Committed to repo |

For "how do I rotate secret X" flows, each linked doc covers the
specifics for its own surface (CI, manual release, web admin).

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

*If you edited this file: please also update the table-of-contents and
cross-links in whatever detail doc you added. This index is load-
bearing for navigation.*
