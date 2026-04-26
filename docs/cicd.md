# CI/CD

This doc covers the **dev environment** pipeline only — every push to
`main` automatically deploys the web Worker, ships a Mac DMG to the
dev Sparkle feed, and uploads an iOS build to TestFlight under the
`com.brevoort-studio.speakist.ios.dev` bundle ID. Production releases
remain manual for now (`make release VERSION=… CHANNEL=stable`); a
GitHub Releases-triggered prod workflow is a future addition.

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
| `APPLE_DEVELOPER_ID_P12_BASE64` | Developer ID Application cert + private key for Mac codesign | Keychain Access → My Certificates → "Developer ID Application: Mike Brevoort (Q5T8FJNX57)" → right-click → Export → save as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Password for the P12 above | The export password you just chose |
| `APPLE_IOS_DISTRIBUTION_P12_BASE64` | Apple Distribution cert + private key for iOS App Store / TestFlight | Xcode → Settings → Accounts → select Apple ID → Manage Certificates → "+" → **Apple Distribution** (creates a fresh cert with the private key in your local keychain). Then Keychain Access → My Certificates → "Apple Distribution: Mike Brevoort (Q5T8FJNX57)" → right-click → Export → save as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_IOS_DISTRIBUTION_P12_PASSWORD` | Password for the iOS Distribution P12 | The export password you just chose |
| `APP_STORE_CONNECT_API_KEY_BASE64` | `.p8` private key for App Store Connect API (notarization + TestFlight upload) | `appstoreconnect.apple.com` → Users and Access → Integrations → App Store Connect API → "+" → name "Speakist CI", role **Admin** (Developer is insufficient for TestFlight upload). Download the `.p8` (one-time only). `base64 -i AuthKey_*.p8 \| pbcopy` |
| `APP_STORE_CONNECT_KEY_ID` | 10-char alphanumeric Key ID | Visible in the Keys table after creation |
| `APP_STORE_CONNECT_ISSUER_ID` | Team's Issuer UUID | Top of the Integrations → App Store Connect API page |
| `SPARKLE_PRIVATE_KEY` | EdDSA private key for signing DMG updates | On the machine that has it: `security find-generic-password -s 'https://sparkle-project.org' -a 'ed25519' -w` (prints the raw 44-char base64 directly — paste as-is, do **not** wrap in another base64 layer) |

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
  — page should reflect any UI changes from the commit.
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

## Production releases (later)

Out of scope for this dev pipeline. The plan: a sibling
`deploy-prod.yml` workflow triggered by GitHub Releases (`on:
release: types: [published]`). The release tag determines the
version (`v0.2.0` → `MARKETING_VERSION=0.2.0`). Channel selection
between `beta` and `stable` happens via the release's prerelease
flag (or a label like `channel:beta`). The Mac side reuses
`release-ci.sh` with `--channel beta` or `--channel stable`; the
iOS side promotes the same TestFlight build from Internal to
External Testing or to App Store Review.

The composite action `setup-apple-signing` and the env-var hooks in
`release.sh` were designed to support both flows without further
changes — the only new piece is the prod-flavored workflow file.
