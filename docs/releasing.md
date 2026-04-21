# Releasing Speakist for Mac

End-to-end: build → sign → notarize → DMG → Sparkle-sign → host → users
auto-update.

This doc has five parts:

0. **Release channels** — dev / beta / stable (the model)
1. **One-time setup** — once per machine that will ever produce a release
2. **Per-release runbook** — every time you ship a new version
3. **Emergency rollback** — yanking a bad release
4. **Troubleshooting** — the errors you'll actually hit
5. **Future: CI automation** — not wired yet

---

## 0. Release channels

Four channels, fully isolated. Each has a **distinct bundle ID and
display name**, which makes macOS treat them as different apps — you can
install all four side-by-side without TCC grants, Keychain items,
UserDefaults, history DBs, or log files cross-contaminating:

| Channel | Bundle ID | Display name | `SUFeedURL` | `apiBaseURL` default | DMG filename |
|---|---|---|---|---|---|
| `stable` | `com.brevoort-studio.speakist` | Speakist | `speakist.ai/appcast.xml` | `speakist.ai` | `Speakist-0.2.0.dmg` |
| `beta` | `com.brevoort-studio.speakist.beta` | Speakist Beta | `speakist.ai/appcast-beta.xml` | `speakist.ai` | `Speakist-0.2.0-beta.dmg` |
| `dev` | `com.brevoort-studio.speakist.dev` | Speakist Dev | `speakist-dev.brevoortstudio.com/appcast-dev.xml` | `speakist-dev.brevoortstudio.com` | `Speakist-0.2.0-dev.dmg` |
| `local` | `com.brevoort-studio.speakist.local` | Speakist Local | *(no auto-update)* | `http://localhost:3000` | *(Xcode local only)* |

`local` is what you get from `make build` / running straight from Xcode
(Xcode's Debug configuration produces the Local channel). It has its
own bundle ID on purpose so your local dev loop doesn't collide with
any signed channel you're also using day-to-day, and it points at
`localhost:3000` by default so `pnpm dev` in `web/` is the assumed
backend.

How it works:

- **Channel identity is baked in at build time.** `scripts/release.sh`
  rewrites the `Release:` block in `project.yml` before `xcodegen
  generate` so all five channel-specific build settings carry the right
  values: `PRODUCT_BUNDLE_IDENTIFIER`, `SPEAKIST_DISPLAY_NAME`,
  `SPEAKIST_CHANNEL`, `SPEAKIST_API_BASE_URL`, `SPEAKIST_FEED_URL`.
  Info.plist reads them via `$(...)` references and ships into the
  codesigned bundle. Modifying Info.plist after signing invalidates the
  signature, which is why the channel can't be chosen at runtime.
- The Local-channel values come from `project.yml`'s
  `settings.configs.Debug` block, which xcodegen reads for local Xcode
  builds. No release script involvement.
- **Users switch channels by installing a different DMG**, not by a
  toggle. Sparkle only ever polls the URL baked into its current .app.
- **The dev-channel appcast lives on the dev Worker** so you can ship
  dev-channel updates without touching prod. Beta + stable appcasts
  live on the prod Worker.
- **Everything keyed on identity derives from `Bundle.main` at runtime**
  via `Speakist/App/AppIdentity.swift` — Keychain service (`{bundleID}.apikeys`),
  logger subsystem, Application Support folder (`{displayName}/`), temp
  dir (`/tmp/{displayName}/`), log directory (`~/Library/Logs/{displayName}/`).
- **Preferences.swift reads `SpeakistDefaultAPIBaseURL` from Info.plist**
  as the default for the `apiBaseURL` UserDefaults key. Users can still
  override per-install with `defaults write {bundle-id} apiBaseURL "…"`
  (the correct bundle ID varies by channel — see the table above).

### Switching someone from an old single-bundle-ID install

If someone was running a pre-channel-split build of Speakist, their
existing data lives under `Application Support/Speakist/` and their
Keychain tokens sit under `com.brevoort-studio.speakist.apikeys`. Installing
a new dev DMG (`com.brevoort-studio.speakist.dev`) won't migrate that —
they'll see a fresh empty history, sign in again, and re-grant Microphone
and Accessibility (the new bundle ID is a new app to TCC). That's expected.
If they want to keep their old history, manually copy
`~/Library/Application Support/Speakist/*.sqlite` to
`~/Library/Application Support/Speakist Dev/` (or the matching display
name for whatever channel they're moving to).

### When to use each channel

- **dev** — your own daily testing + a small circle of trusted testers.
  Ships frequently (sometimes multiple times per day). Points at the dev
  backend. Breakage tolerated.
- **beta** — pre-release candidates with production backend. Ship a
  week or two before stable to catch regressions that only surface
  against real data. Small volunteer audience.
- **stable** — public-facing production. Ships weekly to monthly with
  changelogs.

### Why separate appcast URLs instead of one appcast + Sparkle's channel filter

Sparkle supports `<sparkle:channel>` elements inside `<item>` blocks
that would let a single appcast serve all three with Sparkle filtering
client-side. We use separate URLs because:

1. **Dev releases don't require a prod deploy.** With a single appcast
   on `speakist.ai`, every dev release would need a `pnpm deploy:prod`
   for stable users to pick up the new manifest. Bad ergonomics.
2. **Clearer blast radius.** A malformed entry in `appcast-dev.xml`
   can't break stable-channel auto-update.
3. **Debuggability.** `curl https://speakist.ai/appcast.xml` tells you
   exactly what stable users see, uncomplicated by filters.

---

## 1. One-time setup

### 1.1 Apple Developer ID certificate

You need a **Developer ID Application** cert installed in the login Keychain
for team `Q5T8FJNX57`. If you can already run `make archive` without
signing errors, you're set. If not: Apple Developer → Certificates → create
a new Developer ID Application cert, download the `.cer`, double-click to
install.

### 1.2 Command-line tools

```bash
brew install xcodegen create-dmg jq
```

- `xcodegen` — regenerates `Speakist.xcodeproj` from `project.yml`
- `create-dmg` — builds the drag-to-Applications DMG
- `jq` — used by the release script to build the publish-API JSON payload safely

### 1.3 Sparkle tools + keypair

Sparkle's binaries live alongside the framework download, not in Homebrew.

1. Download the latest Sparkle release:
   https://github.com/sparkle-project/Sparkle/releases
2. Unzip. Copy the `bin/` folder to a permanent home, e.g.:
   ```bash
   mkdir -p ~/Library/Developer/Sparkle
   cp -r ~/Downloads/Sparkle-2.x.x/bin ~/Library/Developer/Sparkle/
   ```
3. If you put it somewhere else, set `SPARKLE_TOOLS` in your shell:
   ```bash
   export SPARKLE_TOOLS=/your/path/to/bin   # add to ~/.zshrc
   ```

**Generate the EdDSA keypair that signs updates:**

```bash
~/Library/Developer/Sparkle/bin/generate_keys
```

This prints a **public key** and stores the **private key** in your login
Keychain. Take the public key and paste it into `project.yml`:

```yaml
targets:
  Speakist:
    info:
      properties:
        SUPublicEDKey: "PASTE-THE-PUBLIC-KEY-HERE"
```

Commit that change.

> ⚠️ **Back up the private key.** Export it from Keychain Access (the
> entry is "Private key for signing Sparkle updates") into 1Password or a
> YubiKey. Losing it means you can **never push updates to existing
> installs again** — every user would have to manually re-download the app.
> Treat this key like you'd treat a domain registrar login.

### 1.4 notarytool credentials

```bash
xcrun notarytool store-credentials SPEAKIST_NOTARY \
  --apple-id mike@brevoort.com \
  --team-id Q5T8FJNX57 \
  --password APP_SPECIFIC_PASSWORD
```

`APP_SPECIFIC_PASSWORD` is generated at https://appleid.apple.com → Sign-In
and Security → App-Specific Passwords. Label it "Speakist notarytool" or
similar.

`SPEAKIST_NOTARY` is the profile name the release script reads (via the
`NOTARY_PROFILE` env var — defaults to `SPEAKIST_NOTARY`).

### 1.5 R2 buckets for DMG hosting

DMGs live on Cloudflare R2 behind a custom domain per env:

| Env | Bucket | Custom domain |
|---|---|---|
| dev | `speakist-releases-dev` | `downloads-dev.brevoortstudio.com` |
| prod | `speakist-releases-prod` | `downloads.speakist.ai` |

One-time setup — do both envs:

```bash
cd web
pnpm exec wrangler r2 bucket create speakist-releases-dev
pnpm exec wrangler r2 bucket create speakist-releases-prod
```

Then attach the custom domains via the Cloudflare dashboard (can't be done
via wrangler CLI at the moment):

1. Dashboard → R2 → `speakist-releases-dev` → **Settings** → **Custom Domains** → **Connect Domain**
2. Enter `downloads-dev.brevoortstudio.com`
3. Cloudflare provisions TLS + inserts a CNAME; propagation is ~1 minute
4. Same for `speakist-releases-prod` → `downloads.speakist.ai` once that
   zone is on Cloudflare (prod domain can be attached later — dev is
   enough to start shipping)

### 1.6 Publish-token secret

The release script POSTs to `/api/admin/releases/publish` on the Worker
to register each new release in D1. Protected by a shared-secret token:

```bash
# Generate once
openssl rand -base64 32

# Set it on each env that accepts releases:
cd web
pnpm exec wrangler secret put RELEASE_PUBLISH_TOKEN --env dev
pnpm exec wrangler secret put RELEASE_PUBLISH_TOKEN --env production
# paste the same value for both, or different ones — they're independent
```

Then export the matching value in your shell so `scripts/release.sh`
can send it:

```bash
# ~/.zshrc (or similar)
export SPEAKIST_PUBLISH_TOKEN_DEV="..."
export SPEAKIST_PUBLISH_TOKEN_PROD="..."
```

Dev-channel releases use the DEV token against the dev Worker; beta +
stable releases use the PROD token against the prod Worker.

---

## 2. Per-release runbook

### 2.1 Build + sign + notarize + DMG

From the repo root:

```bash
make release VERSION=0.2.0                    # stable channel (default)
make release VERSION=0.2.0 CHANNEL=dev        # dev channel
make release VERSION=0.2.0 CHANNEL=beta       # beta channel
```

This runs `scripts/release.sh`, which:

1. Snapshots `project.yml` to `project.yml.release-bak`
2. Rewrites `SUFeedURL`, `SpeakistDefaultAPIBaseURL`, and `SpeakistChannel`
   in `project.yml` for the chosen channel
3. Bumps `MARKETING_VERSION` to `0.2.0`, increments `CURRENT_PROJECT_VERSION`
4. `xcodegen generate`
5. `xcodebuild archive` (Release config, Developer ID signing)
6. `xcodebuild -exportArchive` with `scripts/exportOptions.plist`
7. Sanity-checks the exported Info.plist matches the channel we asked for
   (guards against stale build-cache returning a wrong-channel plist)
8. Zips the `.app`, submits to Apple via `notarytool`, waits for "Accepted"
9. `stapler staple` the notary ticket onto the `.app`
10. `create-dmg` produces `build/Speakist-0.2.0{-dev|-beta}.dmg`
11. `sign_update` (from Sparkle) computes an EdDSA signature for the DMG
12. **Uploads the DMG to the channel's R2 bucket** via
    `wrangler r2 object put --remote`
13. **POSTs to `/api/admin/releases/publish`** with the signature + DMG URL;
    the Worker inserts a row into the `releases` D1 table
14. Restores `project.yml` — **keeping the version bump, discarding the
    channel swap**

Expect 5–10 minutes. The notarization step is the slowest; you're waiting
on Apple's queue.

**The release is live the moment the publish API call returns 200.** The
dynamic `/appcast*.xml` endpoints on the Worker immediately reflect the
new version — no `pnpm deploy:*` needed. No manual appcast edits, no
git-commit-to-ship.

### 2.2 Commit the version bump

The only thing left is persisting the version bump in git:

```bash
git add project.yml
git commit -m "Release 0.2.0 ($CHANNEL)"
git push
```

There's no appcast file to edit (dynamic now), no release artifacts in
the repo, no GitHub Release to create.

### 2.3 Verify the release end-to-end

**Sparkle path (existing installs):**

1. Open a Speakist install that's on the **previous** version
2. Settings → About → **Check for updates…**
3. Sparkle should fetch the appcast, find 0.2.0, show "Install Update"
4. Click install → downloads DMG → verifies EdDSA signature → quits + relaunches

**Download path (new users):**

1. Visit landing page → click **Download for Mac** (or go straight to
   `https://speakist.ai/api/download/mac`)
2. Browser 302s to `https://downloads.speakist.ai/Speakist-0.2.0.dmg`
3. DMG downloads from R2
4. Mount, drag to Applications, launch → Gatekeeper accepts the notarized build

`/api/download/mac` also supports `?channel=beta` and `?channel=dev` for
beta/dev testers — same 302 flow, different R2 object.

If any step fails:
- Appcast XML malformed or empty — hit the URL directly in a browser to
  inspect; if the feed is empty the publish API call didn't insert a row
- EdDSA signature mismatch — DMG was modified after `sign_update`; rebuild
- DMG 404 on R2 — the upload step silently failed; re-run `scripts/release.sh`
  (uploads are idempotent)
- Publish endpoint 401 — `RELEASE_PUBLISH_TOKEN` (Worker secret) doesn't
  match `SPEAKIST_PUBLISH_TOKEN_{DEV,PROD}` in your shell

---

## 3. Emergency rollback

Releases live in D1, not in static files. Two ways:

**A) Yank the release (recommended)** — keeps the row for audit, just
hides it from the appcast + download redirect. Run a SQL update via
wrangler (or build a super-admin UI later):

```bash
cd web
pnpm exec wrangler d1 execute speakist-prod --remote --env production \
  --command "UPDATE releases SET yanked_at = unixepoch() * 1000, yanked_reason = 'breaks on macOS 14.1' WHERE channel = 'stable' AND version = '0.2.0'"
```

Next Sparkle poll (hourly by default) will no longer see 0.2.0 as a
valid update. The DMG stays on R2 — you can delete it manually if you want:

```bash
pnpm exec wrangler r2 object delete speakist-releases-prod/Speakist-0.2.0.dmg --remote
```

**B) Hard delete** — remove the row entirely. Use A unless you specifically
don't want an audit trail.

Users who already installed 0.2.0 are stuck on it until you ship 0.2.1.

---

## 4. Troubleshooting

### "Speakist wants to access the keychain" prompt

With per-channel bundle IDs (`…speakist.local`, `…speakist.dev`,
`…speakist.beta`, `…speakist`), each channel writes to its own Keychain
service (`{bundleID}.apikeys`), so cross-channel prompts don't happen
anymore — each build asks about its own service only.

You may still see a prompt **once**, the first time a new signature runs
against an existing Keychain item within the same channel (e.g., if you
re-sign the Local build with a different Apple Development identity).
Keychain ACLs are tied to the specific code signature. Click **Always
Allow** — the new signature is added to the item's ACL and future
launches are silent.

Clean-slate recipe if you want to start fresh for a channel (replace
`.dev` with `.beta`, `.local`, or remove the suffix entirely for stable):

```bash
security delete-generic-password -s com.brevoort-studio.speakist.dev.apikeys -a refreshToken
```

Then relaunch → Settings → Account → **Sign in with Speakist**.

### App ships with a generic (iconless) Finder icon

The app's icon lives at `Speakist/Resources/Assets.xcassets/AppIcon.appiconset/`
as 10 PNG files (16pt–512pt, @1x and @2x) plus a `Contents.json` manifest.
If the PNGs are missing, Xcode compiles `Assets.car` without icon pixels,
omits `CFBundleIconName` from the Info.plist, and Finder falls back to the
grey-document placeholder. Inside a DMG, this also makes the drag window
look broken — the source `.app` shows as an empty square next to the
Applications alias.

Regenerate from `design/Speakist.svg`:

```bash
make icons
```

This runs `scripts/generate-app-icon.swift`, which uses NSImage's built-in
SVG renderer to produce all 10 sizes and rewrites `Contents.json`. Commit
the resulting PNGs — they're checked into the repo so fresh clones / CI
don't need to regenerate.

`release.sh` preflight aborts if fewer than 10 PNGs are present in the
appiconset, so you can't accidentally ship another iconless build.

Note: if you only replace the DMG bytes (same version, same filename) to
fix an icon regression, the Sparkle signature stored in D1 no longer
matches the new bytes and Sparkle installs will fail verification. Bump
to the next patch version (`make release VERSION=0.1.1 …`) instead — that
inserts a fresh D1 row with a matching signature.

### Making an already-installed build poll a different channel

Sparkle checks `NSUserDefaults` for `SUFeedURL` before falling back to
the Info.plist value. That means you can temporarily point a signed
install at a different channel's appcast without rebuilding. Because
each channel has its own bundle ID, use the right one for the install
you want to reconfigure:

```bash
# Point a Dev install at the beta channel (use Dev's bundle ID)
defaults write com.brevoort-studio.speakist.dev SUFeedURL \
  "https://speakist.ai/appcast-beta.xml"

# Undo (revert to the URL baked into Info.plist)
defaults delete com.brevoort-studio.speakist.dev SUFeedURL
```

Pair with `apiBaseURL` if you also want the app calling a different backend:

```bash
defaults write com.brevoort-studio.speakist.dev apiBaseURL \
  "https://speakist.ai"
```

Restart Speakist after either change. This is strictly a dev-convenience
knob — distributed builds should have the correct channel baked in at
release time via `scripts/release.sh`.

Note: the Local build (`com.brevoort-studio.speakist.local`) has an
empty `SUFeedURL` and no auto-update — overriding the default wouldn't
help because Local installs don't ship through the release pipeline that
would sign a compatible replacement. Just `make build` to rebuild.

### Sparkle tarball extracts into your current directory

`Sparkle-X.Y.Z.tar.xz` uses `./` as its tar root. Running `tar -xf` in
`~/Downloads` will scatter `bin/`, `Symbols/`, `Sparkle.framework`,
`Sparkle Test App.app`, etc. directly into your Downloads folder.
**Always extract into a temp directory:**

```bash
TMP=$(mktemp -d)
(cd "$TMP" && tar -xf ~/Downloads/Sparkle-*.tar.xz)
cp -R "$TMP/bin" ~/Library/Developer/Sparkle/
rm -rf "$TMP"
```

### Restoring the Sparkle private key on a new machine

Your private key backup (from 1Password) is a ~44-char base64 string,
not a `.p12` — Sparkle stores EdDSA keys as raw "password value" in the
login Keychain, not as a certificate.

To use the backed-up key directly when signing:

```bash
sign_update -s "<the-base64-private-key>" Speakist-0.2.0.dmg
```

To re-add it to a fresh machine's Keychain so it's picked up automatically,
the simplest path is to run `generate_keys --account-name …` with the
`--insert` flag — see `generate_keys -h`. Or manually re-create the
Keychain item with `security add-generic-password -s "https://sparkle-project.org"
-a "ed25519" -w "<private-key>"`.

### `make release` preflight errors

| Error | Fix |
|---|---|
| `brew install create-dmg` | `brew install create-dmg` |
| `brew install jq` | `brew install jq` |
| `Sparkle sign_update missing at …` | Install Sparkle tools (§1.3) |
| `notarytool keychain profile 'SPEAKIST_NOTARY' not configured` | `xcrun notarytool store-credentials …` (§1.4) |
| `wrangler not logged in` | `cd web && pnpm exec wrangler login` |
| `SPEAKIST_PUBLISH_TOKEN_{DEV,PROD} env var is not set` | Export matching `RELEASE_PUBLISH_TOKEN` value in shell (§1.6) |
| `Channel mismatch in built Info.plist!` | Stale build cache. Run `rm -rf build/ Speakist.xcodeproj` and retry |
| `Publish API returned HTTP 401` | `RELEASE_PUBLISH_TOKEN` Worker secret doesn't match your shell's `SPEAKIST_PUBLISH_TOKEN_*` value; re-sync |
| `Publish API returned HTTP 503` | `RELEASE_PUBLISH_TOKEN` not configured on the Worker. Run `wrangler secret put RELEASE_PUBLISH_TOKEN --env …` + redeploy |

### Post-release verification failures

**Sparkle says "You're up to date" but I just shipped:**
- The appcast is empty or stale. Hit the URL directly:
  `curl -s https://speakist-dev.brevoortstudio.com/appcast-dev.xml | head -30`
  If there are no `<item>` blocks, the publish API call didn't insert a row.
  Check `wrangler tail speakist-web-dev --env dev --format pretty` while
  re-running `make release` to see the `/api/admin/releases/publish` POST.
- Sparkle caches appcasts briefly — force-check via Settings → About →
  **Check for updates…** rather than waiting for the automatic poll.
- Running install's `sparkle:version` is ≥ the latest release's. Sparkle
  won't downgrade or re-install the same build number. Bump
  `CURRENT_PROJECT_VERSION` by running `make release` again (it
  auto-increments).

**"Update available" prompt but Install fails with a signature error:**
- EdDSA verification failing means the DMG was modified after `sign_update`
  produced its signature. If you re-uploaded or regenerated the DMG
  manually, the signature in D1 no longer matches. Re-run
  `scripts/release.sh` — it re-signs + re-uploads + updates D1.

**Download works but app fails Gatekeeper check on launch:**
- Stapler didn't attach the notary ticket. Verify:
  `xcrun stapler validate /Applications/Speakist.app`
- If invalid, re-run the release (notarization is the step that produces
  the ticket; stapling attaches it). Apple's notary queue can reject builds
  with hardened-runtime violations — read the `notarytool log` output
  carefully.

---

## 5. Future: automate via CI

What's here today is a Mac-only workflow — you run `make release` from your
own laptop. When you want to move it off your laptop:

- GitHub Actions runner with a `macos-14` image (even with a private source
  repo, Actions runners + secrets work normally)
- Store the notarytool app-specific password + the Sparkle private key as
  repo secrets (base64-encode the private key)
- On tag push (`v*`), the action runs `scripts/release.sh`
- Publish-token secrets stay the same — the workflow sets them as env vars
  before invoking `scripts/release.sh`

This is a meaningful scope of work (credential handling, runner cost,
pipeline safety), so it's deliberately deferred until the manual flow
starts to bite.
