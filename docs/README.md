# Speakist — operations docs

Everything about how Speakist is built, deployed, and operated. If you know
what you're looking for, skip straight to the right page via the matrix
below. If you don't, start with [Architecture](architecture.md) for a
system overview.

## Where to read what

| I want to… | Read |
|---|---|
| Understand how the pieces fit together | [docs/architecture.md](architecture.md) |
| See the product spec | [docs/speakist-prd.md](speakist-prd.md) |
| **Run the web backend locally** (pnpm dev, local D1, magic-link via console) | [web/SETUP.md](../web/SETUP.md) |
| **Deploy the web backend** to a new Cloudflare environment (dev or prod) | [web/DEPLOYING.md](../web/DEPLOYING.md) |
| **Ship a Mac release** (build, sign, notarize, DMG, Sparkle update feed) | [docs/releasing.md](releasing.md) |
| Build + run the Mac app from Xcode during development | [../README.md#building](../README.md#building) |

## Environments at a glance

| Concern | local | dev / staging | production |
|---|---|---|---|
| Web Worker | `pnpm dev` | `speakist-web-dev` on Cloudflare | `speakist-web-prod` on Cloudflare |
| D1 database | local mirror (`.wrangler/state`) | `speakist-dev` (remote) | `speakist-prod` (remote) |
| Web URL | `http://localhost:3000` | `speakist-dev.brevoortstudio.com` | `speakist.ai` |
| DMG hosting | n/a (run from Xcode) | R2 → `downloads-dev.brevoortstudio.com` | R2 → `downloads.speakist.ai` |
| Stripe | test mode + `stripe listen` | test mode + dev-URL webhook | **live mode** + prod-URL webhook |
| Auth email | logged to console | Resend | Resend |
| Mac build | Xcode Debug builds | `make release CHANNEL=dev` | `make release` (stable default) |
| Mac `apiBaseURL` default | `http://localhost:3000` | baked to dev URL | baked to `speakist.ai` |
| Sparkle update channel | n/a — not installed | `appcast-dev.xml` on dev Worker | `appcast.xml` on prod Worker |

## First-time setup (new machine / new contributor)

Pick the path that matches what you need to do:

### "I just need the web backend running locally"
→ [web/SETUP.md](../web/SETUP.md). One hour. No Cloudflare deploy, no Mac
signing. Magic-link auth works offline (links print to console).

### "I'm setting up a new deployed environment (dev or prod)"
→ [web/DEPLOYING.md](../web/DEPLOYING.md). Step-by-step: D1 migration,
Worker secrets, workers.dev subdomain, custom domain, Stripe webhook.
Does NOT include R2 / Mac-release setup — that's a separate track.

### "I want to ship the Mac app"
→ [docs/releasing.md](releasing.md). Sparkle EdDSA keypair, notarytool
credentials, R2 buckets, publish-token secret, and the `make release
VERSION=x.y.z CHANNEL=…` command.

The three tracks are independent — you can run the web backend without
ever building a Mac DMG, or build a Mac DMG for the dev channel without
deploying the web backend to prod.

## Release channels

Three independent update channels, isolated by separate appcast URLs:

| Channel | Purpose | Users |
|---|---|---|
| `stable` | Public-facing, monthly-ish cadence | Everyone on speakist.ai |
| `beta` | Pre-release to catch regressions before stable | Volunteer beta testers |
| `dev` | Your own rapid-iteration builds | Internal + trusted testers |

A Mac build belongs to exactly one channel — the channel is baked into
its Info.plist at release time and can't be changed in-place. Users
"switch channels" by installing a different DMG. Full write-up:
[releasing.md §0](releasing.md#0-release-channels).

## Credentials & secrets — where each one lives

| Secret | Lives in | Used by | Set via |
|---|---|---|---|
| `AUTH_SECRET` | Worker secret | Auth.js signing | `wrangler secret put AUTH_SECRET --env X` |
| `APP_ENCRYPTION_KEY` | Worker secret | Encrypting Deepgram keys in D1 | `wrangler secret put …` |
| `RESEND_API_KEY` | Worker secret | Magic-link + invitation email | `wrangler secret put …` |
| `STRIPE_SECRET_KEY` | Worker secret | Billing | `wrangler secret put …` |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | Webhook HMAC verification | `wrangler secret put …` |
| `DEEPGRAM_PROJECT_ID` | Worker secret | Which DG project to mint ephemeral keys under | `wrangler secret put …` |
| Deepgram admin API key | D1 (encrypted) | Minting ephemeral per-transcription keys | `/admin/system` UI |
| `RELEASE_PUBLISH_TOKEN` | Worker secret | Auth for the release script's publish call | `wrangler secret put …` |
| `SPEAKIST_PUBLISH_TOKEN_{DEV,PROD}` | Release machine shell env | Matches RELEASE_PUBLISH_TOKEN for the script to send | `~/.zshrc` export |
| Apple Developer ID cert | Login Keychain | Codesigning release builds | Apple Developer download |
| notarytool password | Login Keychain (profile `SPEAKIST_NOTARY`) | Notarization submit | `xcrun notarytool store-credentials` |
| Sparkle EdDSA **private** key | Login Keychain + backed up to 1Password | Signing DMG for auto-update | `generate_keys` (Sparkle tool) |
| Sparkle EdDSA **public** key | `project.yml` → `SUPublicEDKey` | Verifying updates on-device | Committed to repo |
| `mike@brevoort.com` Apple ID | Apple's side | Signing, notarizing | N/A |

For the "how do I rotate secret X" flow, each doc above covers the
specifics of its secrets.

## Emergency runbooks

- **Bad Mac release ships** → [releasing.md §3](releasing.md#3-emergency-rollback)
  (yank via SQL update; DMG stays on R2 for audit)
- **Stripe webhook broken** → check `wrangler tail speakist-web-prod --env production --format pretty` in one terminal while triggering a test event with `stripe trigger checkout.session.completed` in another
- **Deepgram token mint failing** → `/admin/system` check; see the "No Deepgram key configured" case in [releasing.md troubleshooting](releasing.md#4-troubleshooting)
- **D1 schema drift / migration needed** → `web/drizzle/migrations/` + `pnpm db:migrate:{dev,prod}`

---

*If you edited this file: please also update the table-of-contents and cross-links in whatever you added to a detail doc. This index is load-bearing for navigation.*
