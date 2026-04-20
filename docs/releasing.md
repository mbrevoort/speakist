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
brew install xcodegen create-dmg gh
```

- `xcodegen` — regenerates `Speakist.xcodeproj` from `project.yml`
- `create-dmg` — builds the drag-to-Applications DMG
- `gh` — GitHub CLI, for `make release-publish`

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

### 1.5 GitHub repo for releases

The release script uploads DMGs as GitHub Release assets and generates
download URLs against that repo. Edit `scripts/release.sh`'s `GITHUB_REPO`
value (or set `GITHUB_REPO=owner/repo` in your shell) to point at your
repo. Then on the web side, set the matching Worker secret so the
`/api/download/mac` redirect knows where to look:

```bash
cd web
pnpm exec wrangler secret put GITHUB_REPO --env dev
# value: brevoortstudio/speakist (or whatever you pick)
# repeat for --env production when you ship
```

One-time setup: `gh auth login`.

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
12. Restores `project.yml` — **keeping the version bump, discarding the
    channel swap** — so you can commit the version change without polluting
    stable's defaults with dev values
13. Prints a ready-to-paste `<item>` XML block for the channel's appcast file

Expect 5–10 minutes. The notarization step is the slowest; you're waiting
on Apple's queue.

### 2.2 Upload to GitHub Releases

If you want the script to also upload:

```bash
make release-publish VERSION=0.2.0 CHANNEL=dev
```

This also passes `--prerelease` to `gh release create` for non-stable
channels so they don't show up as the "Latest" release on GitHub.

Otherwise, do it manually:

```bash
gh release create v0.2.0-dev build/Speakist-0.2.0-dev.dmg \
  --title "Speakist 0.2.0 (dev)" \
  --notes "..." \
  --prerelease
```

Release tags are channel-suffixed — stable is `v0.2.0`, beta is
`v0.2.0-beta`, dev is `v0.2.0-dev`. Keeping tags distinct avoids a
beta release overwriting a stable one of the same version.

### 2.3 Update appcast + deploy web

Paste the `<item>` block from the release script's output into the
channel-appropriate appcast file:

- stable → `web/public/appcast.xml`
- beta → `web/public/appcast-beta.xml`
- dev → `web/public/appcast-dev.xml`
`web/public/appcast.xml`, **above** any existing `<item>` blocks (Sparkle
reads newest-first).

```bash
git add project.yml web/public/appcast.xml
git commit -m "Release 0.2.0"
```

Deploy to the environment that serves this channel's appcast:

```bash
cd web

# Dev channel — appcast is hosted on the dev Worker:
pnpm deploy:dev

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

1. Visit `https://speakist.ai/dashboard` (must be signed in)
2. Click **Download for Mac**
3. Browser downloads the DMG
4. Mount, drag to Applications, launch → Gatekeeper accepts the notarized build

If either step fails, the most common culprits:
- Appcast XML malformed — validate with `xmllint web/public/appcast.xml`
- EdDSA signature mismatch — DMG was modified after `sign_update`; rebuild
- DMG URL 404 — the `enclosure url=` in the appcast doesn't match the
  actual GitHub Release asset URL; typo or tag mismatch

---

## 3. Emergency rollback

If a release is bad:

1. Delete or unpublish the GitHub Release:
   ```bash
   gh release delete v0.2.0 --yes
   ```
2. Remove the `<item>` block for 0.2.0 from `web/public/appcast.xml`
3. `pnpm deploy:prod`

Sparkle will stop seeing 0.2.0 as a valid update on its next poll (by default,
one hour after the app launches + every 24 hours while running). Users who
already installed 0.2.0 are stuck on it until you ship 0.2.1.

---

## 4. Future: automate via CI

What's here today is a Mac-only workflow — you run `make release` from your
own laptop. When you want to move it off your laptop:

- GitHub Actions runner with a `macos-14` image
- Store the notarytool app-specific password + the Sparkle private key as
  repo secrets (base64-encode the private key)
- On tag push (`v*`), the action runs `scripts/release.sh` and `gh release
  create`

This is a meaningful scope of work (credential handling, runner cost,
pipeline safety), so it's deliberately deferred until the manual flow
starts to bite.
