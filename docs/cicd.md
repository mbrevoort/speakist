# CI/CD

Two deploy pipelines + two pre-merge gates, all wired to GitHub Actions:

| Workflow | Trigger | Purpose | Runner |
|---|---|---|---|
| **Dev deploy** (`deploy-dev.yml`) | every push to `main` | Channel `dev` → Cloudflare `[env.dev]` Worker, Mac `…speakist.dev`, iOS `…speakist.ios.dev` | mixed |
| **Prod deploy** (`deploy-prod.yml`) | GitHub Release published | Channel `stable` (or `beta` if prerelease) → Cloudflare `[env.production]`, Mac `…speakist` (or `…speakist.beta`), iOS `…speakist.ios` | mixed |
| **PR checks** (`pr.yml`) | PR or push to `main` | Block merge on web typecheck/lint/vitest + Mac xcodebuild test | ubuntu, macOS |
| **Polish regression** (`polish-regression.yml`) | PR touching polish; weekly cron; manual dispatch | Block merge if [polish-fixtures](../web/src/lib/transcription/polish-fixtures.ts) regress; catch upstream Groq-side model drift over time | ubuntu |

The two pipelines share `scripts/release-ci.sh` and
`scripts/release-ios-ci.sh` — channel selection is driven entirely by
env vars set in the workflow (`RELEASE_CHANNEL`, `RELEASE_VERSION`,
`RELEASE_NOTES_FILE`, `RELEASE_IOS_SCHEME`, `RELEASE_IOS_CONFIG`),
so dev and prod runs go down the same code path with different
parameters. No duplicate scripts.

## Overview

`.github/workflows/deploy-dev.yml` defines four jobs:

| Job       | Runner          | What it does | Approximate time |
|-----------|-----------------|--------------|------------------|
| `changes` | `ubuntu-latest` | `dorny/paths-filter` against the push diff; emits `web` / `mac` / `ios` flags | <30 s |
| `web`     | `ubuntu-latest` | `pnpm install` → `pnpm db:migrate:dev` → `pnpm deploy:dev` | 3 min |
| `mac`     | `macos-26`      | xcodegen → archive → notarize → DMG → Sparkle-sign → R2 upload → publish API | 3-15 min (cache-warm vs cold) |
| `ios`     | `macos-26`      | xcodegen → archive → export → upload to TestFlight (Internal Testing) | 1-8 min |

`web` / `mac` / `ios` each `needs: changes` and gate via `if:` on the
matching output, so a docs-only push runs `changes` (~10 s) and skips
the three build jobs entirely — no Mac runner minutes, no iOS, no
Cloudflare deploy. `workflow_dispatch` runs everything regardless, so
the **Run workflow** button is still a "kick all pipelines" override.

Beyond `changes`, the build jobs run independently (no `needs:`
between web/mac/ios) so one job's failure doesn't block the others.
Concurrency `cancel-in-progress: false` queues runs serially so a
back-to-back push doesn't kill an in-flight notarization.

### Path-to-target mapping

The `changes` job's filter rules in the workflow file are the
canonical source — edit there, not here. Quick summary:

* **`web`** → `web/**`, the workflow itself.
* **`mac`** → all of `Speakist/**`, `Shared/**`, `project.yml`,
  `scripts/release.sh`, `scripts/release-ci.sh`,
  `scripts/exportOptions.plist`, the Apple-signing composite action.
* **`ios`** → `SpeakistiOS/**`, `SpeakistKeyboard/**`, `Shared/**`,
  the 8 specific Speakist/* files cross-compiled into the iOS target
  via project.yml (regenerate the list with
  `awk '/SpeakistiOS:/,/info:/' project.yml | grep 'path: Speakist/'`),
  `scripts/release-ios-ci.sh`, `scripts/exportOptions-ios.plist`,
  the Apple-signing composite action.

A change in `Shared/` triggers both Apple jobs. A change in any of
the 8 cross-compiled `Speakist/<file>.swift` paths triggers both
Apple jobs. Edit `project.yml` and the workflow file and you trigger
all three.

The Mac job reuses `scripts/release.sh` (the same script used for
local-laptop releases) via a thin `scripts/release-ci.sh` wrapper that
bridges CI env vars to the script's existing channel-injection +
notarization + Sparkle-signing pipeline. The iOS job uses a separate
`scripts/release-ios-ci.sh` since iOS distribution flow (TestFlight
via App Store Connect) doesn't share much with the Mac side
(Sparkle + R2).

## Polish regression suite

The `polish-regression.yml` workflow runs the bench in
[`web/scripts/bench-polish.ts`](../web/scripts/bench-polish.ts)
against the fixtures in
[`web/src/lib/transcription/polish-fixtures.ts`](../web/src/lib/transcription/polish-fixtures.ts).
It exercises the real Groq API end-to-end (no mocks) and asserts
behavior on each fixture: no assistant preamble, must-contain
substrings, length bounds, must-be-applied, etc.

### When it runs

| Trigger | When it fires | Why |
|---|---|---|
| `pull_request` | PR diff touches `polish.ts`, `polish-fixtures.ts`, `bench-polish.ts`, or the workflow file itself | Catch prompt or fixture regressions before merge. Anything else (UI changes, unrelated routes) skips the workflow entirely so we don't burn API budget on PRs that can't affect polish behavior. |
| `schedule` (Mon 09:00 UTC) | Once a week on `main` | Catch upstream model drift — Groq could re-tune `llama-3.1-8b-instant` between releases, or our prompt could degrade against newer Llama checkpoints, without anyone touching our code. |
| `workflow_dispatch` | Manual UI trigger | Ad-hoc validation. Inputs let you override iteration count or swap the model (e.g., compare against `openai/gpt-oss-20b` or `llama-3.3-70b-versatile`) without editing code. |

### What's measured

Per fixture, the bench reports `PASS` / `REJECT` / `FAIL`:

* **PASS** — the model returned an output, the rejection guard
  accepted it, every assertion held.
* **REJECT** — the rejection guard fell back to raw text (output
  too long, assistant preamble, fetch failure, etc.). The
  `errorReason` is logged.
* **FAIL** — output was accepted but failed at least one fixture
  expectation (missing required substring, exceeded length ratio,
  etc.).

Aggregate metrics: pass rate, rejection rate, latency p50/p95,
per-mode breakdown (intuitive vs prescriptive), failure-mode
histogram. Any non-PASS exits the workflow with code 1 — branch
protection should require this check on PRs that touch polish.

### Adding a fixture

When you discover a new failure mode in production (a real-world
dictation that polish handled badly), capture it as a fixture so
prompt changes can't silently re-introduce the same bug:

1. Add a case to `POLISH_FIXTURES` in `polish-fixtures.ts`.
2. Run the bench locally to confirm the case passes (or add the
   case as a known-failure with a TODO until the prompt is fixed).
3. Push the PR — the workflow will exercise the new fixture
   alongside everything else.

Don't write fixtures whose pass condition depends on a model's
arbitrary stylistic choices ("should it use an em-dash or a
comma?"). Those produce noisy regressions that don't reflect a
real quality change. Only assert what's structurally correct or
structurally wrong.

### Local usage

```bash
# Single iteration, default model — fast smoke test
GROQ_API_KEY=... pnpm --dir web bench:polish

# Multi-iteration to surface flakes
GROQ_API_KEY=... pnpm --dir web bench:polish -n 3

# A/B against another Groq model
GROQ_API_KEY=... pnpm --dir web exec tsx scripts/bench-polish.ts \
  --model openai/gpt-oss-20b

# Run only one case
GROQ_API_KEY=... pnpm --dir web exec tsx scripts/bench-polish.ts \
  --only weather-question

# A/B a prompt variant without editing polish.ts
GROQ_API_KEY=... pnpm --dir web exec tsx scripts/bench-polish.ts \
  --system-prompt-file-prescriptive ./tmp/alt-prompt.txt
```

### Required secret

| Secret | Purpose | How to obtain |
|---|---|---|
| `GROQ_API_KEY` | Direct Groq API access for the bench's `polishWithApiKey` call. Same key the prod Worker uses. | `console.groq.com/keys`. The CI key can be the same one the Worker uses (it's just for chat-completions calls — no infra access). |

The workflow does **not** need any Cloudflare or Apple secrets —
it talks directly to Groq, bypassing the Worker entirely. That's
deliberate: if the Worker's polish path is broken in a way the
bench's pure path catches, the failure mode is something we
introduced in our request shape (prompt, prefill, sentinel) rather
than infrastructure. Conversely, an outage in Cloudflare won't
fail this workflow.

## One-time setup

### 1. Apple Developer portal (iOS dev channel)

These manual steps register the iOS dev-channel bundle IDs + App Group
+ App Store Connect record. Without them, the iOS job fails at
`xcodebuild archive` with a provisioning error. Mac side needs nothing
on the portal — Developer ID distribution doesn't require an explicit
App ID registration.

1. **Identifiers → App IDs → "+"**:
   - Register `com.brevoort-studio.speakist.ios.dev` with App Groups
     capability enabled.
   - Register `com.brevoort-studio.speakist.ios.dev.Keyboard` with
     App Groups capability enabled.
2. **Identifiers → App Groups → "+"**:
   - Register `group.com.brevoort-studio.speakist.dev`.
3. **Edit each App ID → App Groups → Configure → check the new
   group** so both bundle IDs are linked to it.
4. **App Store Connect → My Apps → "+" → New App**:
   - Platform: iOS
   - Name: "Speakist Dev"
   - Bundle ID: `com.brevoort-studio.speakist.ios.dev` (dropdown
     populated from step 1)
   - SKU: `speakist-ios-dev`
5. **TestFlight → Internal Testing → "+"** — create an Internal
   Testing group, add yourself + initial testers. Internal builds
   skip Apple Beta App Review and become available within minutes
   of upload.

`xcodebuild -allowProvisioningUpdates` (run by CI against the App
Store Connect API key) auto-creates the iOS Distribution cert + the
two provisioning profiles on first run, so no profile installation
is needed beyond the steps above.

### 2. GitHub repository secrets

Set via repo Settings → Secrets and variables → Actions → New
repository secret. Names must match exactly.

| Secret | Purpose | How to obtain |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler auth (Workers + D1 + R2 edit) | `dash.cloudflare.com` → My Profile → API Tokens → Create. Use the "Edit Cloudflare Workers" template, then add **D1 Edit** and **Workers R2 Storage Edit** scopes, restrict to your account. |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler account selector | `dash.cloudflare.com` → right sidebar → Account ID |
| `RELEASE_PUBLISH_TOKEN_DEV` | bearer token for `/api/admin/releases/publish` | Same value as the `RELEASE_PUBLISH_TOKEN` secret already on the `speakist-web-dev` Worker. If unsure: `openssl rand -base64 32`, then `wrangler secret put RELEASE_PUBLISH_TOKEN --env dev` and paste the same value here. |
| `APPLE_DEVELOPER_ID_P12_BASE64` | Developer ID Application cert + private key for Mac codesign | Keychain Access → My Certificates → "Developer ID Application: …(YOUR-TEAM-ID)" → right-click → Export → save as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Password for the P12 above | The export password you just chose |
| `APPLE_IOS_DISTRIBUTION_P12_BASE64` | Apple Distribution cert + private key for iOS App Store / TestFlight | Xcode → Settings → Accounts → select Apple ID → Manage Certificates → "+" → **Apple Distribution** (creates a fresh cert with the private key in your local keychain). Then Keychain Access → My Certificates → "Apple Distribution: …(YOUR-TEAM-ID)" → right-click → Export → save as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_IOS_DISTRIBUTION_P12_PASSWORD` | Password for the iOS Distribution P12 | The export password you just chose |
| `APP_STORE_CONNECT_API_KEY_BASE64` | `.p8` private key for App Store Connect API (notarization + TestFlight upload) | `appstoreconnect.apple.com` → Users and Access → Integrations → App Store Connect API → "+" → name "Speakist CI", role **Admin** (Developer is insufficient for TestFlight upload). Download the `.p8` (one-time only). `base64 -i AuthKey_*.p8 \| pbcopy` |
| `APP_STORE_CONNECT_KEY_ID` | 10-char alphanumeric Key ID | Visible in the Keys table after creation |
| `APP_STORE_CONNECT_ISSUER_ID` | Team's Issuer UUID | Top of the Integrations → App Store Connect API page |
| `SPARKLE_PRIVATE_KEY` | EdDSA private key for signing DMG updates | On the machine that has it: `security find-generic-password -s 'https://sparkle-project.org' -a 'ed25519' -w` (prints the raw 44-char base64 directly — paste as-is, do **not** wrap in another base64 layer) |
| `GROQ_API_KEY` | Direct Groq API access for the polish-regression bench (`polish-regression.yml`). Not used by the deploy workflows. | `console.groq.com/keys` → "Create API Key". Can be the same key the Worker uses; the bench only calls `chat/completions`, no infra access. |

The same App Store Connect API key is used by both the Mac job (for
notarization via `notarytool`) and the iOS job (for cert + profile
auto-management via `xcodebuild -allowProvisioningUpdates` + upload
via `altool`). The Admin role is needed because the first iOS upload
for a new app sometimes triggers app-record metadata writes that
fail under Developer-role keys.

**Why the iOS Distribution P12 matters**: without it, every CI run had
`xcodebuild -allowProvisioningUpdates` mint a fresh Apple Distribution
cert via the App Store Connect API. After ~3 runs (Apple's per-team
cap on active distribution certs), CI failed at archive time with
"Choose a certificate to revoke." Importing the P12 puts a single
cert + private key into the runner's keychain, which
`-allowProvisioningUpdates` happily reuses — so the cap stops mattering.

## First-run checklist

After completing the one-time setup above:

1. Verify all 11 secrets are set in repo Settings → Secrets and
   variables → Actions.
2. Verify portal items 1-5 are complete — search Identifiers for
   `com.brevoort-studio.speakist.ios.dev`, App Groups for
   `group.com.brevoort-studio.speakist.dev`, App Store Connect for
   the "Speakist Dev" record.
3. Push a small commit (or trigger Actions → "Deploy Dev" → "Run
   workflow") and watch the Actions tab.
4. Expected timing: web ~3 min ✅, mac ~12 min ✅, ios ~8 min ✅.

End-to-end verification:

- **Web**: visit `https://speakist-dev.brevoortstudio.com/dashboard/usage`
  (dev) or `https://speakist.ai/dashboard/usage` (prod, after a
  GitHub Release publish) — page should reflect any UI changes
  from the deploy.
- **Mac**: open Speakist Dev (already-installed) → Speakist menu →
  Check for Updates… → should offer the new build.
- **iOS**: open TestFlight on iPhone → "Speakist Dev" should show a
  new build available a few minutes after upload completes.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Web job fails at `pnpm db:migrate:dev` | Pending migration has a syntax error | Fix migration in a follow-up PR; deploy is gated behind migrate by step ordering, so a broken migration won't push bad code |
| Mac notarization rejected | Hardened-runtime entitlement missing or signed bundle has unsigned helper | Pull the `notarytool log <uuid>` output (CI surfaces the UUID); fix in `Speakist/Speakist.entitlements` |
| iOS upload "Invalid bundle version" | CFBundleVersion collision with a previous build | Bump the `100000 + GITHUB_RUN_NUMBER` offset in `scripts/release-ios-ci.sh` higher (e.g., `1000000`); rare in practice |
| iOS upload "No matching provisioning profile" | Apple Developer portal step 1 or 3 wasn't done | Run the manual setup checklist above; `xcodebuild -allowProvisioningUpdates` will auto-fetch on next run |
| iOS archive "Choose a certificate to revoke. Your account has reached the maximum number of certificates." | `APPLE_IOS_DISTRIBUTION_P12_BASE64` secret is unset, so `-allowProvisioningUpdates` keeps minting fresh certs each run and hits Apple's per-team 3-cert cap | Revoke 1–2 old iOS Distribution certs at <https://developer.apple.com/account/resources/certificates/list> to free a slot. Then create a fresh **Apple Distribution** cert via Xcode → Settings → Accounts → Manage Certificates → "+" so the private key lives in your local keychain. Export as P12 and set the two `APPLE_IOS_DISTRIBUTION_P12_*` secrets per the table above. Future runs reuse the imported cert and never mint new ones |
| Mac DMG upload "401 Unauthorized" from publish API | `RELEASE_PUBLISH_TOKEN_DEV` doesn't match the Worker's `RELEASE_PUBLISH_TOKEN` secret | Either re-set both with the same value, or rotate via `wrangler secret put RELEASE_PUBLISH_TOKEN --env dev` and update the GitHub secret |

## Local debug recipes

To reproduce a CI failure on your laptop, you can run the same scripts
with the same env vars:

```bash
# Mac CI replay (requires the same secrets in your shell):
export NOTARY_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_X9Y8Z7W6V5.p8"
export NOTARY_API_KEY_ID="X9Y8Z7W6V5"
export NOTARY_API_ISSUER="<issuer-uuid>"
export SPARKLE_PRIVATE_KEY="<raw-base64>"
export RELEASE_PUBLISH_TOKEN="<bearer>"
export GITHUB_RUN_NUMBER=12345
export GITHUB_SHA="$(git rev-parse HEAD)"
scripts/release-ci.sh
```

```bash
# iOS CI replay:
export APP_STORE_CONNECT_KEY_ID="X9Y8Z7W6V5"
export APP_STORE_CONNECT_ISSUER_ID="<issuer-uuid>"
export GITHUB_RUN_NUMBER=12345
scripts/release-ios-ci.sh
```

Both scripts are designed to be runnable on a developer's machine
with the right env vars set — no GitHub Actions-specific behavior is
embedded in them.

## Production pipeline (`deploy-prod.yml`)

Fires on `release: published` (also re-triggerable manually via
`workflow_dispatch` with a tag input). Three jobs, parallel:

| Job | Runner | What it does | Approximate time |
|---|---|---|---|
| `context` | `ubuntu-latest` | Parse tag → version + channel; render release body markdown → HTML | <30 s |
| `web` | `ubuntu-latest` | `pnpm db:migrate:prod` → `pnpm deploy:prod` (against `[env.production]`) | 3 min |
| `mac` | `macos-26` | xcodegen → archive → notarize → DMG → Sparkle-sign → R2 prod upload → publish API on `speakist-web-prod` | 3-15 min |
| `ios` | `macos-26` | xcodegen → archive (`SpeakistiOS` scheme, Release config, MARKETING_VERSION from tag) → export → upload to TestFlight on the **Speakist** app record | 1-8 min |

### Release semantics

* **Tag** `v0.2.0` → `MARKETING_VERSION=0.2.0`. Tags are
  regex-validated as semver before any downstream job consumes them
  as a checkout ref or env var.
* **Body** (markdown) → rendered to HTML via `gh api /markdown` and
  stored in D1's `releases.releaseNotes` column. Sparkle's update
  window renders this HTML as the user-facing changelog. TestFlight's
  "What to Test" field can't be set via `altool` — paste the same
  release body into App Store Connect manually if you want it there.
* **Prerelease checkbox** routes to the `beta` channel. `stable` is
  the default. The iOS job is skipped on `beta` releases (no
  `…speakist.ios.beta` bundle ID is provisioned — use TestFlight
  External Beta on the stable iOS app for that role).
* **Cloudflare**: prod uses `[env.production]` in `web/wrangler.toml`
  → Worker `speakist-web-prod`, D1 `speakist-prod`, R2 bucket
  `speakist-releases-prod`, served at `speakist.ai` /
  `downloads.speakist.ai`. Zero overlap with dev's
  `speakist-web-dev` / `speakist-dev` / `speakist-releases-dev`.

### One-time prod setup

Four classes of work; do them in order so each later step has its
prerequisites ready.

#### 1. Cloudflare (prod environment)

```bash
# Create the prod D1, copy the returned database_id into
# web/wrangler.toml's [[env.production.d1_databases]] block
# (replacing __FILL_ME_IN__).
cd web
pnpm exec wrangler d1 create speakist-prod

# Create the prod R2 bucket.
pnpm exec wrangler r2 bucket create speakist-releases-prod

# Set the publish-API bearer secret on the prod Worker. Generate a
# fresh token; the same value goes into the GitHub secret
# RELEASE_PUBLISH_TOKEN_PROD below so CI can authenticate.
openssl rand -base64 32  # copy this
pnpm exec wrangler secret put RELEASE_PUBLISH_TOKEN --env production
# Mirror the other dev-side Worker secrets onto prod as needed
# (whatever's set on speakist-web-dev — Stripe keys, OpenRouter,
# Deepgram, etc.). Inspect with:
pnpm exec wrangler secret list --env dev
```

In the Cloudflare dashboard:

* **Workers & Pages → speakist-web-prod → Settings → Domains & Routes**:
  add `speakist.ai` (and `www.speakist.ai` if desired) as a custom
  domain. DNS for `speakist.ai` must be on Cloudflare for this to
  proxy correctly.
* **R2 → speakist-releases-prod → Settings → Custom Domains**: attach
  `downloads.speakist.ai`. This is the public origin Sparkle clients
  hit for DMG downloads — `release.sh` hard-codes this hostname.
* **Workers Plans**: confirm the prod Worker is on the same plan as
  dev (Paid if you want Analytics Engine — see commented-out blocks
  in `wrangler.toml`).

#### 2. Apple Developer portal (iOS stable channel)

Mirror of the dev-channel setup, but for the stable bundle IDs:

1. **Identifiers → App IDs → "+"**:
   * `com.brevoort-studio.speakist.ios` with App Groups capability.
   * `com.brevoort-studio.speakist.ios.Keyboard` with App Groups capability.
2. **Identifiers → App Groups → "+"**:
   * `group.com.brevoort-studio.speakist`.
3. **Edit each App ID → App Groups → Configure** → check the new
   group on both bundle IDs.
4. **App Store Connect → My Apps → "+" → New App**:
   * Platform: iOS
   * Name: **Speakist** (no suffix — distinct from "Speakist Dev")
   * Bundle ID: `com.brevoort-studio.speakist.ios` (dropdown)
   * SKU: `speakist-ios`
5. **TestFlight → Internal Testing → "+"** — create an Internal group
   on the new "Speakist" record. (External Beta is optional — set up
   when ready for wider testers.)

`xcodebuild -allowProvisioningUpdates` (run by CI against the App
Store Connect API key) auto-creates `Speakist iOS` and
`Speakist iOS Keyboard` Distribution profiles on first archive,
exactly as the dev flow does for the `…dev` profiles.

#### 3. GitHub repository secret

Only one new secret on top of the dev set:

| Secret | Purpose | How to obtain |
|---|---|---|
| `RELEASE_PUBLISH_TOKEN_PROD` | bearer for `speakist-web-prod`'s `/api/admin/releases/publish` | Same value as the `RELEASE_PUBLISH_TOKEN` Worker secret you set in step 1 above |

All other secrets (Cloudflare, Apple, Sparkle) are reused from the
dev pipeline — same Apple Developer team, same EdDSA Sparkle keypair,
same Cloudflare account.

#### 4. First release dry-run

Before tagging an actual release, validate the prod path with a
beta-prerelease tag:

```bash
git tag v0.0.0-prod-smoke
git push origin v0.0.0-prod-smoke
# In GitHub UI: Releases → Draft a new release → choose tag
#   v0.0.0-prod-smoke → check "Set as a pre-release" → Publish.
```

This routes through `channel=beta`:

* Web prod deploy runs (deploys to `speakist.ai`).
* Mac job ships a `Speakist Beta` DMG to `downloads.speakist.ai`,
  registered against `speakist.ai/appcast-beta.xml`.
* iOS job is skipped (channel != stable).

If everything's green, delete the smoke release in GitHub UI and the
DMG from R2 (`pnpm exec wrangler r2 object delete`), then tag
`v0.2.0` (or whatever your real version is) for a stable release.

### Cutting a real release

```bash
# After whatever feature work is merged to main:
git tag v0.2.0
git push origin v0.2.0
# In GitHub UI: Releases → Draft a new release → choose tag v0.2.0.
#   Title: "v0.2.0 — <short summary>"
#   Body: markdown changelog. This is what users see in Sparkle's
#         "What's new" panel and what you'll paste into TestFlight's
#         "What to Test" field manually.
#   Set as latest release: ✓
#   (leave prerelease unchecked for stable)
#   Publish.
```

The workflow fires within a few seconds. End-to-end timing: web ~3
min, mac ~12 min cold (~5 min cache-warm), ios ~8 min.

### Rolling back a bad release

The release.sh script is idempotent (re-running on the same tag
overwrites the R2 object and dedupes the D1 row), so a hotfix
re-release with a bumped patch version is the usual recovery. For
emergency removals from the appcast without re-shipping, yank via
the admin UI / DB:

```sql
UPDATE releases SET yanked_at = unixepoch(), yanked_reason = '…'
  WHERE channel = 'stable' AND version = '0.2.0';
```

The dynamic appcast filters out yanked rows on the next request, so
Sparkle clients stop seeing the bad version immediately. Already-
upgraded clients are not affected (Sparkle doesn't downgrade).

## Config management

Four tiers, each with a single source-of-truth so dev-vs-prod (and
local/dev/beta/stable on the apps) stay in lockstep without manual
syncing:

### Tier 1 — build-time client bundle (`NEXT_PUBLIC_*`)

Next.js inlines `NEXT_PUBLIC_*` into the JavaScript bundle at
`opennextjs-cloudflare build` time. A Worker secret can't reach
these values — by the time the Worker runs, the bundle is frozen.

* **Source of truth**: `web/package.json`'s `deploy:dev` and
  `deploy:prod` scripts, as inline shell exports.
* **Examples**: any `NEXT_PUBLIC_*` value read **only** in client
  components.
* **Local dev**: `web/.env.local` (gitignored) — same names.

To add a new build-time public value:

1. Add `NEXT_PUBLIC_FOO=...` to **both** the `deploy:dev` and
   `deploy:prod` scripts in `web/package.json`.
2. Add to `web/.env` template + your local `.env.local` for `pnpm dev`.
3. Read in code via `process.env.NEXT_PUBLIC_FOO`.

### Tier 1+2 — values read at both build and runtime

Some `NEXT_PUBLIC_*` values are *also* read server-side by Server
Components or `env.server` validation, not just inlined into the
client bundle. Webpack only inlines literal `process.env.X`
references at build time; runtime code that does
`safeParse(process.env)` (e.g. `web/src/lib/env.ts`'s server schema)
reads `process.env` as a live object on the Worker. If the value
isn't present in **both** places, one side breaks.

`NEXT_PUBLIC_SITE_URL` is the canonical example today — it's used
by `metadataBase`, by invitation-email URL builders, and by the
strict `z.string().url()` server-schema validation. Missing at
runtime → schema parse throws → every page that imports
`env.server` 500s.

* **Source of truth**: declared **twice**, deliberately:
  * Build-time: `NEXT_PUBLIC_SITE_URL=...` in
    `web/package.json`'s `deploy:dev` / `deploy:prod` scripts.
  * Runtime: `[env.dev.vars]` / `[env.production.vars]` in
    `web/wrangler.toml`.
* The two declarations should hold the same value per environment.

To add a new dual-tier value: do both Tier 1 and Tier 2 steps.

### Tier 2 — Worker runtime vars (non-secret, per env)

Read by Worker code at request time via `process.env.X`. Public —
safe to commit. Server Components and API routes see them at SSR
time, so values can flow into HTML the client receives.

* **Source of truth**: `[env.dev.vars]` and `[env.production.vars]`
  in `web/wrangler.toml`.
* **Examples**: `RELEASE_DOWNLOAD_BASE_URL`, `RELEASE_R2_BUCKET`,
  `IOS_TESTFLIGHT_URL`, `RESEND_FROM_EMAIL`, `SUPER_ADMIN_EMAIL`.

To add a new runtime var:

1. Add to **both** `[env.dev.vars]` and `[env.production.vars]` in
   `web/wrangler.toml` (even if the value's the same on both today,
   keeping both blocks symmetric makes future divergence one edit).
2. Add to `web/src/lib/env.ts`'s `serverSchema` with a `next dev`
   fallback default.
3. Read via `env.server.FOO` (preferred) or `process.env.FOO`.

### Tier 3 — Worker secrets (encrypted, per env)

Sensitive values that should never sit in the repo. Encrypted at
rest in Cloudflare; visible only to the Worker at request time.

* **Source of truth**: `wrangler secret put X --env <dev|production>`.
* **Examples**: `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `RESEND_API_KEY`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DEEPGRAM_API_KEY`,
  `DEEPGRAM_PROJECT_KEY`, `GROQ_API_KEY`, `RELEASE_PUBLISH_TOKEN`.

To rotate or set a secret:

```bash
cd web
pnpm exec wrangler secret put STRIPE_SECRET_KEY --env production
# Paste the new value when prompted.
```

To list what's currently set on a Worker:

```bash
pnpm exec wrangler secret list --env production
```

### Tier 4 — native app channel config (Mac + iOS, baked at build)

The Mac and iOS apps read their channel-specific values out of
Info.plist at runtime, but the Info.plist is generated at build time
from `project.yml` build settings.

* **Source of truth**: `project.yml`'s per-config blocks (`Debug` →
  `local`, `Release` → `stable`, iOS-only `Dev` → `dev`) plus
  `scripts/release.sh`'s channel matrix (it rewrites `project.yml`'s
  `Release` block in-place before `xcodegen generate` when shipping
  `beta` or `dev`).
* **Surfaced via**: Info.plist build-setting substitution
  (`$(SPEAKIST_API_BASE_URL)`, `$(SPEAKIST_FEED_URL)`, etc.) →
  `Bundle.main` → `SpeakistChannel.current` accessors in
  `Shared/SpeakistChannel.swift`.
* **Examples**: bundle ID, App Group, display name, channel tag,
  API base URL, Sparkle feed URL.

To add a new channel-specific value:

1. Add a `SPEAKIST_FOO` build setting to each `configs:` block in
   `project.yml` (Debug / Dev / Release).
2. Add a `SpeakistFoo` key to the relevant `info: properties:` block
   referencing `$(SPEAKIST_FOO)`.
3. Update `scripts/release.sh`'s channel matrix + `sed` rewrite
   patterns so beta/dev injection covers the new key.
4. Read at runtime via a `SpeakistChannel` accessor backed by
   `Bundle.main.object(forInfoDictionaryKey: "SpeakistFoo")`.

### Anti-patterns to avoid

* **Don't put env-specific URLs in code as `const`s** — they drift.
  If a value can differ between dev and prod, it belongs in Tier 1
  or Tier 2.
* **Don't put secrets in Tier 1** — `NEXT_PUBLIC_*` reaches the
  client bundle, where any user can read it. Anything sensitive
  goes through Tier 3.
* **Don't leave dev-flavored fallbacks in code defaults** — a
  fallback firing in production means a config drift, not a
  feature. Defaults in `env.ts`/code should be either prod-safe
  (e.g., `noreply@speakist.ai`) or local-dev-only (`localhost:3000`).
* **Don't touch the App Group ID, bundle ID prefix, or URL scheme
  prefix per channel without auditing both Apple Developer portal
  and `release.sh`** — they're paired registrations and a one-sided
  change produces mysterious provisioning failures at archive time.
