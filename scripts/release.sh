#!/usr/bin/env bash
#
# Speakist Mac release pipeline — multi-channel, distributed from Cloudflare R2.
#
# Usage:
#   scripts/release.sh 0.2.0                           # stable channel
#   scripts/release.sh 0.2.0 --channel dev             # dev channel
#   scripts/release.sh 0.2.0 --channel beta            # beta channel
#   scripts/release.sh 0.2.0 --notes "..."             # release notes
#
# What this does, end to end:
#   1. Rewrite project.yml with channel-specific SUFeedURL + API URL
#   2. Bump version in project.yml
#   3. xcodegen + xcodebuild archive → export → notarize → staple
#   4. hdiutil + AppleScript package the app into a DMG with a Finder
#      alias for the Applications drop target (not a symlink, which
#      doesn't render with the correct icon in modern macOS)
#   5. Sparkle sign_update computes the EdDSA signature
#   6. Upload DMG to the channel's R2 bucket via `wrangler r2 object put`
#   7. POST to the Worker's /api/admin/releases/publish endpoint so the D1
#      `releases` table records the new version — dynamic appcast + download
#      endpoints pick it up immediately
#   8. Restore project.yml (keep version bump, drop channel injection)
#
# No git push, no manual appcast edits, no `gh release create` — the single
# source of truth is D1, populated via the publish API.
#
# Channel matrix (URLs are overrideable via env vars):
#
#   Channel  SUFeedURL                                                API default                               R2 bucket                Download base
#   -------  -------------------------------------------------------  ---------------------------------------  -----------------------  ----------------------------------------
#   stable   https://speakist.ai/appcast.xml                          https://speakist.ai                      speakist-releases-prod   https://downloads.speakist.ai
#   beta     https://speakist.ai/appcast-beta.xml                     https://speakist.ai                      speakist-releases-prod   https://downloads.speakist.ai
#   dev      https://speakist-dev.brevoortstudio.com/appcast-dev.xml  https://speakist-dev.brevoortstudio.com  speakist-releases-dev    https://downloads-dev.brevoortstudio.com
#
# Prerequisites (one-time per machine):
#   * Xcode + Developer ID Application cert in Keychain for team Q5T8FJNX57
#   * brew install xcodegen jq  (hdiutil ships with macOS)
#   * Sparkle tools: https://github.com/sparkle-project/Sparkle/releases
#     copy bin/ to ~/Library/Developer/Sparkle/bin (or set SPARKLE_TOOLS)
#   * EdDSA keypair: $SPARKLE_TOOLS/generate_keys → paste the public key
#     into project.yml → SUPublicEDKey. BACK UP THE PRIVATE KEY FROM KEYCHAIN.
#   * notarytool profile: xcrun notarytool store-credentials SPEAKIST_NOTARY …
#   * wrangler: (cd web && pnpm exec wrangler login) one-time
#   * R2 buckets created + custom domains attached (see docs/releasing.md)
#
# Per-channel env vars you must export in your shell:
#   SPEAKIST_PUBLISH_TOKEN_DEV   — matches RELEASE_PUBLISH_TOKEN on dev Worker
#   SPEAKIST_PUBLISH_TOKEN_PROD  — matches it on prod Worker

set -euo pipefail

# ---- parse args ---------------------------------------------------------

VERSION=""
CHANNEL="stable"
RELEASE_NOTES=""

show_usage() {
  cat <<USAGE
Usage: $0 <version> [--channel dev|beta|stable] [--notes "..."]

  <version>         MARKETING_VERSION to ship (e.g. 0.2.0)
  --channel <name>  Update channel; defaults to 'stable'
  --notes <text>    Release notes (plain text or HTML). Optional.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --notes=*) RELEASE_NOTES="${1#*=}"; shift ;;
    -h|--help) show_usage; exit 0 ;;
    -*) echo "Unknown flag: $1"; show_usage; exit 1 ;;
    *)
      if [ -z "$VERSION" ]; then VERSION="$1"
      else echo "Too many positional args"; show_usage; exit 1
      fi
      shift ;;
  esac
done

if [ -z "$VERSION" ]; then show_usage; exit 1; fi

case "$CHANNEL" in
  stable|beta|dev) ;;
  *) echo "Unknown channel: $CHANNEL (must be dev, beta, or stable)"; exit 1 ;;
esac

# ---- channel → URLs + R2 + publish endpoint -----------------------------

STABLE_FEED_URL="${STABLE_FEED_URL:-https://speakist.ai/appcast.xml}"
STABLE_API_URL="${STABLE_API_URL:-https://speakist.ai}"
STABLE_R2_BUCKET="${STABLE_R2_BUCKET:-speakist-releases-prod}"
STABLE_DOWNLOAD_BASE="${STABLE_DOWNLOAD_BASE:-https://downloads.speakist.ai}"

BETA_FEED_URL="${BETA_FEED_URL:-https://speakist.ai/appcast-beta.xml}"
BETA_API_URL="${BETA_API_URL:-https://speakist.ai}"
BETA_R2_BUCKET="${BETA_R2_BUCKET:-speakist-releases-prod}"
BETA_DOWNLOAD_BASE="${BETA_DOWNLOAD_BASE:-https://downloads.speakist.ai}"

DEV_FEED_URL="${DEV_FEED_URL:-https://speakist-dev.brevoortstudio.com/appcast-dev.xml}"
DEV_API_URL="${DEV_API_URL:-https://speakist-dev.brevoortstudio.com}"
DEV_R2_BUCKET="${DEV_R2_BUCKET:-speakist-releases-dev}"
DEV_DOWNLOAD_BASE="${DEV_DOWNLOAD_BASE:-https://downloads-dev.brevoortstudio.com}"

PROD_PUBLISH_URL="${PROD_PUBLISH_URL:-https://speakist.ai/api/admin/releases/publish}"
DEV_PUBLISH_URL="${DEV_PUBLISH_URL:-https://speakist-dev.brevoortstudio.com/api/admin/releases/publish}"

case "$CHANNEL" in
  stable)
    FEED_URL="$STABLE_FEED_URL"; API_URL="$STABLE_API_URL"
    R2_BUCKET="$STABLE_R2_BUCKET"; DOWNLOAD_BASE="$STABLE_DOWNLOAD_BASE"
    PUBLISH_URL="$PROD_PUBLISH_URL"; PUBLISH_TOKEN="${SPEAKIST_PUBLISH_TOKEN_PROD:-}"
    WRANGLER_ENV="production"; DMG_SUFFIX=""
    BUNDLE_ID="com.brevoort-studio.speakist"
    DISPLAY_NAME="Speakist"
    ;;
  beta)
    FEED_URL="$BETA_FEED_URL"; API_URL="$BETA_API_URL"
    R2_BUCKET="$BETA_R2_BUCKET"; DOWNLOAD_BASE="$BETA_DOWNLOAD_BASE"
    PUBLISH_URL="$PROD_PUBLISH_URL"; PUBLISH_TOKEN="${SPEAKIST_PUBLISH_TOKEN_PROD:-}"
    WRANGLER_ENV="production"; DMG_SUFFIX="-beta"
    BUNDLE_ID="com.brevoort-studio.speakist.beta"
    DISPLAY_NAME="Speakist Beta"
    ;;
  dev)
    FEED_URL="$DEV_FEED_URL"; API_URL="$DEV_API_URL"
    R2_BUCKET="$DEV_R2_BUCKET"; DOWNLOAD_BASE="$DEV_DOWNLOAD_BASE"
    PUBLISH_URL="$DEV_PUBLISH_URL"; PUBLISH_TOKEN="${SPEAKIST_PUBLISH_TOKEN_DEV:-}"
    WRANGLER_ENV="dev"; DMG_SUFFIX="-dev"
    BUNDLE_ID="com.brevoort-studio.speakist.dev"
    DISPLAY_NAME="Speakist Dev"
    ;;
esac

# ---- config -------------------------------------------------------------

# Xcode project + scheme filenames never change per channel — xcodegen
# reads `name: Speakist` at the top of project.yml, producing
# Speakist.xcodeproj with a single "Speakist" scheme regardless of
# which configuration (Debug/Release) or channel ends up selected.
PROJECT_NAME="Speakist"
# The built .app bundle filename follows PRODUCT_NAME, which tracks
# SPEAKIST_DISPLAY_NAME per-config — so Release builds for this channel
# produce e.g. "Speakist Dev.app" / "Speakist.app" / "Speakist Beta.app".
APP_BUNDLE_NAME="$DISPLAY_NAME"

TEAM_ID="Q5T8FJNX57"
NOTARY_PROFILE="${NOTARY_PROFILE:-SPEAKIST_NOTARY}"
SPARKLE_TOOLS="${SPARKLE_TOOLS:-$HOME/Library/Developer/Sparkle/bin}"
BUILD_DIR="build"
EXPORT_DIR="${BUILD_DIR}/export"
ARCHIVE_PATH="${BUILD_DIR}/${PROJECT_NAME}.xcarchive"
APP_PATH="${EXPORT_DIR}/${APP_BUNDLE_NAME}.app"
# DMG filename stays URL-safe (no spaces) so download URLs don't require
# percent-encoding. Channel differentiation comes from DMG_SUFFIX.
DMG_FILENAME="${PROJECT_NAME}-${VERSION}${DMG_SUFFIX}.dmg"
DMG_PATH="${BUILD_DIR}/${DMG_FILENAME}"

# ---- preflight ----------------------------------------------------------

echo "==> Preflight (channel=$CHANNEL, version=$VERSION)"
command -v xcodebuild >/dev/null || { echo "xcodebuild not found"; exit 1; }
command -v xcodegen   >/dev/null || { echo "brew install xcodegen"; exit 1; }
command -v hdiutil    >/dev/null || { echo "hdiutil not found (comes with macOS)"; exit 1; }
command -v jq         >/dev/null || { echo "brew install jq"; exit 1; }
command -v curl       >/dev/null || { echo "curl not found"; exit 1; }
[ -x "${SPARKLE_TOOLS}/sign_update" ] || { echo "Sparkle sign_update missing at ${SPARKLE_TOOLS}/sign_update"; exit 1; }
# CI uses an App Store Connect API key (.p8) for notarization instead
# of a keychain credential profile. When NOTARY_API_KEY_PATH is set,
# the corresponding KEY_ID + ISSUER must be too — failure is loud.
# Otherwise fall through to the keychain-profile path used on the
# developer's laptop.
if [ -n "${NOTARY_API_KEY_PATH:-}" ]; then
  [ -f "$NOTARY_API_KEY_PATH" ] || { echo "NOTARY_API_KEY_PATH is set but file not found: $NOTARY_API_KEY_PATH"; exit 1; }
  [ -n "${NOTARY_API_KEY_ID:-}" ] || { echo "NOTARY_API_KEY_PATH set without NOTARY_API_KEY_ID"; exit 1; }
  [ -n "${NOTARY_API_ISSUER:-}" ] || { echo "NOTARY_API_KEY_PATH set without NOTARY_API_ISSUER"; exit 1; }
  xcrun notarytool history --key "$NOTARY_API_KEY_PATH" --key-id "$NOTARY_API_KEY_ID" --issuer "$NOTARY_API_ISSUER" >/dev/null 2>&1 || {
    echo "notarytool API key auth failed. Verify key, key-id, issuer."; exit 1
  }
else
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
    echo "notarytool keychain profile '${NOTARY_PROFILE}' not configured."; exit 1
  }
fi
(cd web && pnpm exec wrangler whoami >/dev/null 2>&1) || {
  echo "wrangler not logged in. cd web && pnpm exec wrangler login"; exit 1
}
if [ -z "$PUBLISH_TOKEN" ]; then
  VAR_NAME=$([ "$CHANNEL" = "dev" ] && echo "SPEAKIST_PUBLISH_TOKEN_DEV" || echo "SPEAKIST_PUBLISH_TOKEN_PROD")
  echo "$VAR_NAME env var is not set (must match the Worker's RELEASE_PUBLISH_TOKEN secret)"
  exit 1
fi

# Guard against shipping an iconless build. The AppIcon asset catalog
# declares 10 required slots; if any are missing, Xcode silently builds
# without an icon and Finder shows the generic placeholder (which also
# makes the DMG's drag window look broken). Regenerate with `make icons`.
APPICON_DIR="Speakist/Resources/Assets.xcassets/AppIcon.appiconset"
ICON_PNG_COUNT=$(find "$APPICON_DIR" -maxdepth 1 -name "*.png" 2>/dev/null | wc -l | tr -d ' ')
if [ "$ICON_PNG_COUNT" -lt 10 ]; then
  echo "AppIcon.appiconset has only ${ICON_PNG_COUNT}/10 PNGs — app will ship without an icon."
  echo "Run 'make icons' to regenerate from design/Speakist.svg, then commit."
  exit 1
fi

# ---- project.yml channel injection --------------------------------------

cp project.yml project.yml.release-bak
trap 'mv project.yml.release-bak project.yml 2>/dev/null || true' EXIT

echo "==> Injecting channel '$CHANNEL' into project.yml"
# All channel-specific values live under settings.configs.Release. We scope
# each rewrite with a sed address range from the `        Release:` line
# down to the next top-level section (`    dependencies:` at 4 spaces) so
# we don't stomp on the Debug config's Local-channel values or the
# SpeakistTests target's `.tests` bundle ID.
RELEASE_RANGE='/^        Release:$/,/^    [a-z]/'
sed -i '' -E "${RELEASE_RANGE} s|(PRODUCT_BUNDLE_IDENTIFIER: )com\\.brevoort-studio\\.speakist\$|\\1${BUNDLE_ID}|" project.yml
sed -i '' -E "${RELEASE_RANGE} s|(SPEAKIST_DISPLAY_NAME: )\"Speakist\"|\\1\"${DISPLAY_NAME}\"|" project.yml
sed -i '' -E "${RELEASE_RANGE} s|(SPEAKIST_CHANNEL: )stable\$|\\1${CHANNEL}|" project.yml
sed -i '' -E "${RELEASE_RANGE} s|(SPEAKIST_API_BASE_URL: )\"https://speakist.ai\"|\\1\"${API_URL}\"|" project.yml
sed -i '' -E "${RELEASE_RANGE} s|(SPEAKIST_FEED_URL: )\"https://speakist.ai/appcast.xml\"|\\1\"${FEED_URL}\"|" project.yml

# ---- version bump -------------------------------------------------------

echo "==> Bumping MARKETING_VERSION → $VERSION"
sed -i '' -E "s/(MARKETING_VERSION: +\")[^\"]+(\")/\1${VERSION}\2/" project.yml
sed -i '' -E "s/(MARKETING_VERSION: +\")[^\"]+(\")/\1${VERSION}\2/" project.yml.release-bak

CURRENT_BUILD=$(grep -E 'CURRENT_PROJECT_VERSION:' project.yml | head -n1 | sed -E 's/.*"([0-9]+)".*/\1/')
# Two modes:
#   * Default: bump the file's value by 1 (local-laptop flow where the
#     bumped value gets committed back to git).
#   * RELEASE_BUILD_NUMBER set: use it verbatim. CI sets this to
#     `100000 + GITHUB_RUN_NUMBER` so every run produces a monotonic,
#     never-colliding CFBundleVersion regardless of project.yml's
#     persisted value (CI never commits the bump back).
if [ -n "${RELEASE_BUILD_NUMBER:-}" ]; then
  NEW_BUILD="$RELEASE_BUILD_NUMBER"
  echo "==> Setting CURRENT_PROJECT_VERSION ← $NEW_BUILD (from RELEASE_BUILD_NUMBER env)"
else
  NEW_BUILD=$((CURRENT_BUILD + 1))
  echo "==> Bumping CURRENT_PROJECT_VERSION $CURRENT_BUILD → $NEW_BUILD"
fi
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: +\")[0-9]+(\")/\1${NEW_BUILD}\2/" project.yml
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: +\")[0-9]+(\")/\1${NEW_BUILD}\2/" project.yml.release-bak

# ---- archive ------------------------------------------------------------

echo "==> xcodegen generate"
xcodegen generate

# PostHog override — only meaningful for the stable channel. The Mac
# Release config in project.yml ships `SPEAKIST_POSTHOG_KEY: ""`, so
# uncoordinated dev/local builds never accidentally hit production
# PostHog. CI exports SPEAKIST_POSTHOG_KEY_STABLE for stable runs and
# we forward it here as a build-setting override; xcodebuild applies
# command-line build settings with highest precedence, which then feeds
# the `SpeakistPostHogKey` Info.plist substitution. Empty for dev/beta
# CI runs and laptop builds → Analytics.swift refuses to init.
POSTHOG_FLAG=""
if [ "$CHANNEL" = "stable" ] && [ -n "${SPEAKIST_POSTHOG_KEY_STABLE:-}" ]; then
  POSTHOG_FLAG="SPEAKIST_POSTHOG_KEY=$SPEAKIST_POSTHOG_KEY_STABLE"
fi

echo "==> xcodebuild archive (Release)"
rm -rf "$ARCHIVE_PATH"
xcodebuild -project "${PROJECT_NAME}.xcodeproj" \
    -scheme "${PROJECT_NAME}" \
    -configuration Release \
    -archivePath "${ARCHIVE_PATH}" \
    -destination 'generic/platform=macOS' \
    ${POSTHOG_FLAG} \
    archive

echo "==> xcodebuild -exportArchive"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist scripts/exportOptions.plist

[ -d "$APP_PATH" ] || {
  echo "Export didn't produce $APP_PATH"
  echo "Contents of $EXPORT_DIR:"; ls -la "$EXPORT_DIR" 2>&1
  exit 1
}

# Channel sanity check — abort if build cache served a wrong-channel plist.
# This catches sed-range regressions (e.g., if someone reorders the Release
# config in project.yml and our pattern stops matching) so we never ship a
# build whose bundle ID / channel URL / display name has drifted.
BUILT_FEED=$(/usr/libexec/PlistBuddy -c "Print :SUFeedURL" "$APP_PATH/Contents/Info.plist")
BUILT_CHANNEL=$(/usr/libexec/PlistBuddy -c "Print :SpeakistChannel" "$APP_PATH/Contents/Info.plist")
BUILT_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Contents/Info.plist")
BUILT_DISPLAY=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$APP_PATH/Contents/Info.plist")
if [ "$BUILT_FEED" != "$FEED_URL" ] || [ "$BUILT_CHANNEL" != "$CHANNEL" ] \
   || [ "$BUILT_BUNDLE_ID" != "$BUNDLE_ID" ] || [ "$BUILT_DISPLAY" != "$DISPLAY_NAME" ]; then
  echo "Channel mismatch in built Info.plist!"
  echo "  Expected: channel=$CHANNEL bundleID=$BUNDLE_ID display=$DISPLAY_NAME feed=$FEED_URL"
  echo "  Got:      channel=$BUILT_CHANNEL bundleID=$BUILT_BUNDLE_ID display=$BUILT_DISPLAY feed=$BUILT_FEED"
  echo "Try: rm -rf build/ Speakist.xcodeproj && re-run"
  exit 1
fi

# ---- notarize -----------------------------------------------------------

ZIP_PATH="${BUILD_DIR}/${PROJECT_NAME}-notarize.zip"
echo "==> Zipping for notarization"
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "==> notarytool submit (this can take a few minutes)"
# Mirror the preflight branch: API key in CI, keychain profile locally.
if [ -n "${NOTARY_API_KEY_PATH:-}" ]; then
  xcrun notarytool submit "$ZIP_PATH" \
    --key "$NOTARY_API_KEY_PATH" \
    --key-id "$NOTARY_API_KEY_ID" \
    --issuer "$NOTARY_API_ISSUER" \
    --wait
else
  xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
fi

echo "==> stapling ticket"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

# ---- DMG ----------------------------------------------------------------

# Why we're not using `create-dmg` here: it implements the Applications
# drop target as a raw symlink (`ln -s /Applications ./Applications`),
# which modern macOS versions (Sonoma / Sequoia / Tahoe) stop
# auto-resolving to the system Applications-folder icon inside read-only
# DMGs. Users see an empty dashed placeholder next to the app instead of
# the familiar "drag here" Applications folder. We fix that by creating a
# proper Finder alias file via AppleScript — Finder always renders
# aliases with the correct target-folder icon.
#
# The pipeline: staging dir → writable UDRW DMG → mount → AppleScript
# sets window bounds + icon positions → unmount → convert to compressed
# UDZO. ~30 lines, no brew dependencies, reliably good-looking result.

echo "==> Building DMG at $DMG_PATH"
rm -f "$DMG_PATH"

VOL_NAME="${DISPLAY_NAME} ${VERSION}"
STAGING_DIR=$(mktemp -d)
TEMP_DMG_DIR=$(mktemp -d)
TEMP_DMG="$TEMP_DMG_DIR/temp.dmg"
# Cleanup even on failure so we don't leak mounts/temp dirs. The unmount
# is best-effort — if AppleScript already succeeded the volume may be
# gone; if we bailed early it may never have mounted.
cleanup_dmg() {
  hdiutil detach "/Volumes/$VOL_NAME" -quiet 2>/dev/null || true
  rm -rf "$STAGING_DIR" "$TEMP_DMG_DIR"
}
trap 'cleanup_dmg; mv project.yml.release-bak project.yml 2>/dev/null || true' EXIT

# 1. Stage the app bundle.
cp -R "$APP_PATH" "$STAGING_DIR/"

# 1b. Stage the DMG background image into a hidden .background folder.
#     Finder reads the picture from inside the volume itself (referenced
#     via HFS path in the AppleScript below), so the file has to live
#     inside the DMG, not on the host. The .background folder name is
#     conventional + hidden by default in Finder.
#
#     The PNG is generated by scripts/generate-dmg-background.swift —
#     regenerate after any layout / palette change. Provides title,
#     subtitle, drag arrow, and ghost outlines under each icon slot
#     so the install action is unmistakable even when modern macOS
#     fails to resolve the Applications-alias icon (a known bug that
#     shows the alias as a near-invisible dark square on a dark bg).
mkdir -p "$STAGING_DIR/.background"
cp "design/dmg-background.png" "$STAGING_DIR/.background/background.png"

# 2. Create a proper Finder alias to /Applications (NOT a symlink).
#    AppleScript's `make new alias file` produces an alias file that
#    Finder renders with the real Applications-folder icon. A bare
#    symlink (what `create-dmg --app-drop-link` produces) no longer
#    auto-resolves to that icon in modern macOS read-only DMGs. Even
#    with the alias, modern macOS sometimes renders it as a black
#    blob on a dark background — hence the ghost outlines + arrow
#    baked into the .background image (step 1b) as a fallback hint.
osascript <<APPLE_SCRIPT
tell application "Finder"
    set appsAlias to make new alias file at POSIX file "$STAGING_DIR" to POSIX file "/Applications"
    set name of appsAlias to "Applications"
end tell
APPLE_SCRIPT

# 3. Build a writable DMG from the staging folder.
hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING_DIR" \
    -ov -format UDRW -fs HFS+ "$TEMP_DMG" >/dev/null

# 4. Mount the writable DMG at its default location (/Volumes/\$VOL_NAME)
#    so Finder registers it by volume name and our AppleScript's
#    \`tell disk "$VOL_NAME"\` can find it. `-noautoopen` keeps Finder
#    from popping a window at the user; we still script the window
#    customization below.
hdiutil attach "$TEMP_DMG" -noautoopen -quiet
# Give Finder time to register the mount. 1s was enough on
# GitHub-hosted runners with idle Finder; on a self-hosted Mac that's
# also handling a logged-in user's Finder it can take noticeably
# longer for the volume to surface.
sleep 5

# 5. Finder window layout. Cosmetic only — the DMG is fully valid
#    without it; users who download it just see Finder's default
#    Untitled window layout instead of the branded one with the drag
#    arrow. We treat this step as **best-effort** because driving
#    Finder via AppleScript from a launchd-spawned process (the
#    self-hosted runner case) is fragile: even with the runner in
#    `gui/<uid>` with SessionCreate=true, `tell disk` can hit the
#    2-minute AppleEvent timeout if Finder is busy or the audit
#    session boundary isn't fully bridged. `with timeout of 60 seconds`
#    fails fast instead of burning 2 minutes on a hang. `activate`
#    pulls Finder forward so its window-level operations dispatch.
#
# `update without registering applications` flushes the .DS_Store to
# disk so the layout persists into the final compressed DMG.
# Coordinates MUST match scripts/generate-dmg-background.swift so the
# icons land on top of their ghost outlines in the bg art.
DMG_LAYOUT_RC=0
osascript <<APPLE_SCRIPT || DMG_LAYOUT_RC=$?
with timeout of 60 seconds
    tell application "Finder"
        activate
        tell disk "$VOL_NAME"
            open
            set current view of container window to icon view
            set toolbar visible of container window to false
            set statusbar visible of container window to false
            set the bounds of container window to {200, 120, 800, 520}
            set viewOptions to the icon view options of container window
            set arrangement of viewOptions to not arranged
            set icon size of viewOptions to 100
            -- Background picture path is HFS-style (colon separators) and
            -- relative to the volume root. The PNG was staged at
            -- /.background/background.png in step 1b above.
            set background picture of viewOptions to file ".background:background.png"
            set position of item "${APP_BUNDLE_NAME}.app" of container window to {150, 180}
            set position of item "Applications" of container window to {450, 180}
            close
            open
            update without registering applications
            delay 1
        end tell
    end tell
end timeout
APPLE_SCRIPT
if [ "$DMG_LAYOUT_RC" -ne 0 ]; then
  echo "==> WARNING: DMG window layout step failed (rc=$DMG_LAYOUT_RC). Shipping a valid but unstyled DMG."
fi

# 6. Unmount, then convert to compressed read-only UDZO.
hdiutil detach "/Volumes/$VOL_NAME" -quiet
hdiutil convert "$TEMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" -ov -quiet

# Clean up staging/temp immediately (trap will no-op on already-gone files).
cleanup_dmg
trap 'mv project.yml.release-bak project.yml 2>/dev/null || true' EXIT

# ---- Sparkle sign -------------------------------------------------------

echo "==> Sparkle sign_update"
# CI passes the EdDSA private key directly via SPARKLE_PRIVATE_KEY
# (env var) so the runner doesn't need a populated Keychain. Locally,
# `sign_update` reads from the user's Keychain transparently.
# sign_update emits `sparkle:edSignature="abc==" length="123"`. We store only
# the bare base64 signature in D1 — `dmgSizeBytes` is the sole source of
# `length=` in the appcast enclosure, which keeps the XML valid (duplicate
# attributes cause Sparkle to fail feed parsing).
#
# Sparkle 2.6+ deprecated the `-s <key>` flag (warns + exits non-zero) so
# write the key to a temp file and pass `--ed-key-file <path>` instead.
# Trapping cleanup of the temp file on script exit avoids leaving the
# private key on disk in the runner workspace.
if [ -n "${SPARKLE_PRIVATE_KEY:-}" ]; then
  SPARKLE_KEY_FILE=$(mktemp -t sparkle-ed)
  trap 'rm -f "$SPARKLE_KEY_FILE"; mv project.yml.release-bak project.yml 2>/dev/null || true' EXIT
  printf '%s' "$SPARKLE_PRIVATE_KEY" > "$SPARKLE_KEY_FILE"
  chmod 600 "$SPARKLE_KEY_FILE"
  SPARKLE_RAW=$("${SPARKLE_TOOLS}/sign_update" --ed-key-file "$SPARKLE_KEY_FILE" "$DMG_PATH")
else
  SPARKLE_RAW=$("${SPARKLE_TOOLS}/sign_update" "$DMG_PATH")
fi
SPARKLE_SIG=$(echo "$SPARKLE_RAW" | sed -E 's/.*sparkle:edSignature="([^"]+)".*/\1/')
if [ -z "$SPARKLE_SIG" ] || [ "$SPARKLE_SIG" = "$SPARKLE_RAW" ]; then
  echo "Could not parse sparkle:edSignature from sign_update output:"
  echo "  $SPARKLE_RAW"
  exit 1
fi
DMG_SIZE=$(stat -f%z "$DMG_PATH")

# ---- R2 upload ----------------------------------------------------------

echo "==> Uploading DMG to R2 bucket '${R2_BUCKET}' (env ${WRANGLER_ENV})"
# `--remote` uploads to the real R2 bucket (not the local .wrangler cache).
# `--content-type` is set so the browser + Sparkle treat it as a binary
# download instead of trying to interpret it.
(cd web && pnpm exec wrangler r2 object put \
    "${R2_BUCKET}/${DMG_FILENAME}" \
    --file "../${DMG_PATH}" \
    --remote \
    --content-type "application/octet-stream" \
    --env "$WRANGLER_ENV")

DMG_PUBLIC_URL="${DOWNLOAD_BASE}/${DMG_FILENAME}"

# ---- publish to D1 via API ----------------------------------------------

echo "==> Registering release via ${PUBLISH_URL}"
# jq -n --arg / --argjson handle string escaping cleanly (release notes can
# contain quotes, backticks, newlines). This avoids hand-rolling JSON escaping.
PAYLOAD=$(jq -n \
  --arg channel "$CHANNEL" \
  --arg version "$VERSION" \
  --argjson buildNumber "$NEW_BUILD" \
  --arg dmgUrl "$DMG_PUBLIC_URL" \
  --argjson dmgSizeBytes "$DMG_SIZE" \
  --arg sparkleSignature "$SPARKLE_SIG" \
  --arg releaseNotes "$RELEASE_NOTES" \
  '{channel: $channel, version: $version, buildNumber: $buildNumber,
    dmgUrl: $dmgUrl, dmgSizeBytes: $dmgSizeBytes,
    sparkleSignature: $sparkleSignature}
   + (if $releaseNotes == "" then {} else {releaseNotes: $releaseNotes} end)')

HTTP_STATUS=$(curl -sS -o /tmp/release-publish-resp.json -w "%{http_code}" \
  -X POST "$PUBLISH_URL" \
  -H "Authorization: Bearer ${PUBLISH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD") || { echo "curl failed"; exit 1; }

if [ "$HTTP_STATUS" != "200" ]; then
  echo "Publish API returned HTTP $HTTP_STATUS:"
  cat /tmp/release-publish-resp.json
  echo
  echo "DMG was uploaded to R2 but D1 was NOT updated. Fix + re-run."
  echo "Upload is idempotent; next run overwrites the same R2 object."
  exit 1
fi

# ---- finalize -----------------------------------------------------------

mv project.yml.release-bak project.yml
trap - EXIT

cat <<BANNER

════════════════════════════════════════════════════════════════════════
Release ${VERSION} (${CHANNEL}) shipped.
════════════════════════════════════════════════════════════════════════

DMG:         ${DMG_PATH}  ($(du -h "$DMG_PATH" | cut -f1))
Public URL:  ${DMG_PUBLIC_URL}
Channel:     ${CHANNEL}
Build:       ${NEW_BUILD}
Feed URL:    ${FEED_URL}
Sparkle sig: ${SPARKLE_SIG}

The Worker's D1 releases table has been updated. The dynamic appcast at
${FEED_URL} already reflects this release — Sparkle clients on the
'${CHANNEL}' channel will pick it up on their next poll (hourly by default,
or immediately via Settings → About → Check for updates…).

Only git housekeeping left:

  git add project.yml
  git commit -m "Release ${VERSION} (${CHANNEL})"
  git push

BANNER
