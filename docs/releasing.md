# Releasing Speakist for Mac

End-to-end: build → sign → notarize → DMG → Sparkle-sign → host → users
auto-update.

This doc has three parts:

0. **Release channels** — dev / beta / stable (the model)
1. **One-time setup** — once per machine that will ever produce a release
2. **Per-release runbook** — every time you ship a new version

---

## 0. Release channels

Three channels, each fully isolated:

| Channel | `SUFeedURL` baked into the build | `apiBaseURL` default | DMG filename | Appcast file |
|---|---|---|---|---|
| `stable` | `speakist.ai/appcast.xml` | `speakist.ai` | `Speakist-0.2.0.dmg` | `web/public/appcast.xml` |
| `beta` | `speakist.ai/appcast-beta.xml` | `speakist.ai` | `Speakist-0.2.0-beta.dmg` | `web/public/appcast-beta.xml` |
| `dev` | `speakist-dev.brevoortstudio.com/appcast-dev.xml` | `speakist-dev.brevoortstudio.com` | `Speakist-0.2.0-dev.dmg` | `web/public/appcast-dev.xml` |

How it works:

- **Channel is baked in at build time.** `scripts/release.sh` rewrites
  `project.yml` before `xcodegen generate`, so `SUFeedURL`,
  `SpeakistDefaultAPIBaseURL`, and `SpeakistChannel` land in the built
  Info.plist with the channel's values. That survives into the codesigned
  bundle — modifying Info.plist after signing invalidates the signature,
  which is why we can't pick the channel at runtime.
- **Users switch channels by installing a different DMG**, not by a
  toggle. Sparkle only ever polls the URL baked into its current .app.
- **The dev-channel appcast lives on the dev Worker** so you can ship
  dev-channel updates without touching prod. Beta + stable appcasts
  live on the prod Worker.
- **Preferences.swift reads `SpeakistDefaultAPIBaseURL` from Info.plist**
  as the default for the `apiBaseURL` UserDefaults key. Users can still
  override per-install with `defaults write
  com.brevoort-studio.speakist apiBaseURL "…"`.

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

### 2.3 (Legacy) Where stuff used to live

Previous versions of this pipeline used GitHub Releases + static
`web/public/appcast*.xml` files. That's gone — DMGs are on R2, appcasts
are dynamic. Nothing to deploy to the Worker per-release; only when
the Worker **code** changes do you `pnpm deploy:*`.

### Old "deploy web" step — no longer needed

```bash
# cd web
# pnpm deploy:dev / :prod   ← only when YOUR CODE changes, not per-release

# Beta or stable channel — appcast is hosted on the prod Worker:
pnpm deploy:prod
```

You can also deploy both if you want the appcast file present on both
envs; the released app only polls the URL baked into its Info.plist,
but having the file at both URLs is harmless.

Also push the git tag + commits:

```bash
git push
git push --tags   # if using release-publish, the tag is already there
```

### 2.4 Verify the release end-to-end

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

## 4. Future: automate via CI

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
