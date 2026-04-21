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
#   4. create-dmg produces the DMG
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
#   * brew install xcodegen create-dmg jq
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

APP_NAME="Speakist"
TEAM_ID="Q5T8FJNX57"
NOTARY_PROFILE="${NOTARY_PROFILE:-SPEAKIST_NOTARY}"
SPARKLE_TOOLS="${SPARKLE_TOOLS:-$HOME/Library/Developer/Sparkle/bin}"
BUILD_DIR="build"
EXPORT_DIR="${BUILD_DIR}/export"
ARCHIVE_PATH="${BUILD_DIR}/${APP_NAME}.xcarchive"
APP_PATH="${EXPORT_DIR}/${APP_NAME}.app"
DMG_FILENAME="${APP_NAME}-${VERSION}${DMG_SUFFIX}.dmg"
DMG_PATH="${BUILD_DIR}/${DMG_FILENAME}"

# ---- preflight ----------------------------------------------------------

echo "==> Preflight (channel=$CHANNEL, version=$VERSION)"
command -v xcodebuild >/dev/null || { echo "xcodebuild not found"; exit 1; }
command -v xcodegen   >/dev/null || { echo "brew install xcodegen"; exit 1; }
command -v create-dmg >/dev/null || { echo "brew install create-dmg"; exit 1; }
command -v jq         >/dev/null || { echo "brew install jq"; exit 1; }
command -v curl       >/dev/null || { echo "curl not found"; exit 1; }
[ -x "${SPARKLE_TOOLS}/sign_update" ] || { echo "Sparkle sign_update missing at ${SPARKLE_TOOLS}/sign_update"; exit 1; }
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
  echo "notarytool keychain profile '${NOTARY_PROFILE}' not configured."; exit 1
}
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
NEW_BUILD=$((CURRENT_BUILD + 1))
echo "==> Bumping CURRENT_PROJECT_VERSION $CURRENT_BUILD → $NEW_BUILD"
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: +\")[0-9]+(\")/\1${NEW_BUILD}\2/" project.yml
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: +\")[0-9]+(\")/\1${NEW_BUILD}\2/" project.yml.release-bak

# ---- archive ------------------------------------------------------------

echo "==> xcodegen generate"
xcodegen generate

echo "==> xcodebuild archive (Release)"
rm -rf "$ARCHIVE_PATH"
xcodebuild -project "${APP_NAME}.xcodeproj" \
    -scheme "${APP_NAME}" \
    -configuration Release \
    -archivePath "${ARCHIVE_PATH}" \
    -destination 'generic/platform=macOS' \
    archive

echo "==> xcodebuild -exportArchive"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist scripts/exportOptions.plist

[ -d "$APP_PATH" ] || { echo "Export didn't produce $APP_PATH"; exit 1; }

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

ZIP_PATH="${BUILD_DIR}/${APP_NAME}-notarize.zip"
echo "==> Zipping for notarization"
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "==> notarytool submit (this can take a few minutes)"
xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> stapling ticket"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

# ---- DMG ----------------------------------------------------------------

echo "==> Building DMG at $DMG_PATH"
rm -f "$DMG_PATH"
create-dmg \
    --volname "${APP_NAME} ${VERSION}" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "${APP_NAME}.app" 175 200 \
    --app-drop-link 425 200 \
    --no-internet-enable \
    "$DMG_PATH" \
    "$APP_PATH"

# ---- Sparkle sign -------------------------------------------------------

echo "==> Sparkle sign_update"
# sign_update emits `sparkle:edSignature="abc==" length="123"`. We store only
# the bare base64 signature in D1 — `dmgSizeBytes` is the sole source of
# `length=` in the appcast enclosure, which keeps the XML valid (duplicate
# attributes cause Sparkle to fail feed parsing).
SPARKLE_RAW=$("${SPARKLE_TOOLS}/sign_update" "$DMG_PATH")
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
