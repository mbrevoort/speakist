#!/usr/bin/env bash
#
# Speakist Mac release pipeline — multi-channel (dev / beta / stable).
#
# Usage:
#   scripts/release.sh 0.2.0                           # stable channel
#   scripts/release.sh 0.2.0 --channel dev             # dev channel
#   scripts/release.sh 0.2.0 --channel beta            # beta channel
#   scripts/release.sh 0.2.0 --channel dev --publish   # also upload to GitHub
#
# Channel matrix (URLs overrideable via env vars):
#
#   Channel  SUFeedURL                                                API default
#   -------  -------------------------------------------------------  ------------------------------------
#   stable   https://speakist.ai/appcast.xml                          https://speakist.ai
#   beta     https://speakist.ai/appcast-beta.xml                     https://speakist.ai
#   dev      https://speakist-dev.brevoortstudio.com/appcast-dev.xml  https://speakist-dev.brevoortstudio.com
#
# Prerequisites (one-time per machine):
#   * Xcode + Developer ID Application cert in Keychain for team Q5T8FJNX57
#   * brew install xcodegen create-dmg gh
#   * Sparkle tools: https://github.com/sparkle-project/Sparkle/releases
#     copy bin/ to ~/Library/Developer/Sparkle/bin or set SPARKLE_TOOLS
#   * EdDSA keypair: `$SPARKLE_TOOLS/generate_keys`, paste public key into
#     project.yml → SUPublicEDKey. BACK UP THE PRIVATE KEY FROM KEYCHAIN.
#   * notarytool profile: xcrun notarytool store-credentials SPEAKIST_NOTARY …
#   * gh auth login

set -euo pipefail

# ---- parse args ---------------------------------------------------------

VERSION=""
CHANNEL="stable"
PUBLISH="no"

show_usage() {
  cat <<USAGE
Usage: $0 <version> [--channel dev|beta|stable] [--publish]

  <version>         MARKETING_VERSION to ship (e.g. 0.2.0)
  --channel <name>  Update channel; defaults to 'stable'
  --publish         Also 'gh release create' the DMG to GITHUB_REPO
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    --publish) PUBLISH="yes"; shift ;;
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

# ---- channel → URLs -----------------------------------------------------

STABLE_FEED_URL="${STABLE_FEED_URL:-https://speakist.ai/appcast.xml}"
STABLE_API_URL="${STABLE_API_URL:-https://speakist.ai}"
BETA_FEED_URL="${BETA_FEED_URL:-https://speakist.ai/appcast-beta.xml}"
BETA_API_URL="${BETA_API_URL:-https://speakist.ai}"
DEV_FEED_URL="${DEV_FEED_URL:-https://speakist-dev.brevoortstudio.com/appcast-dev.xml}"
DEV_API_URL="${DEV_API_URL:-https://speakist-dev.brevoortstudio.com}"

case "$CHANNEL" in
  stable) FEED_URL="$STABLE_FEED_URL"; API_URL="$STABLE_API_URL"; APPCAST_FILE="web/public/appcast.xml";     DMG_SUFFIX="" ;;
  beta)   FEED_URL="$BETA_FEED_URL";   API_URL="$BETA_API_URL";   APPCAST_FILE="web/public/appcast-beta.xml"; DMG_SUFFIX="-beta" ;;
  dev)    FEED_URL="$DEV_FEED_URL";    API_URL="$DEV_API_URL";    APPCAST_FILE="web/public/appcast-dev.xml";  DMG_SUFFIX="-dev" ;;
esac

# ---- config -------------------------------------------------------------

APP_NAME="Speakist"
TEAM_ID="Q5T8FJNX57"
NOTARY_PROFILE="${NOTARY_PROFILE:-SPEAKIST_NOTARY}"
SPARKLE_TOOLS="${SPARKLE_TOOLS:-$HOME/Library/Developer/Sparkle/bin}"
GITHUB_REPO="${GITHUB_REPO:-brevoortstudio/speakist}"
BUILD_DIR="build"
EXPORT_DIR="${BUILD_DIR}/export"
ARCHIVE_PATH="${BUILD_DIR}/${APP_NAME}.xcarchive"
APP_PATH="${EXPORT_DIR}/${APP_NAME}.app"
DMG_PATH="${BUILD_DIR}/${APP_NAME}-${VERSION}${DMG_SUFFIX}.dmg"

# ---- preflight ----------------------------------------------------------

echo "==> Preflight (channel=$CHANNEL, version=$VERSION)"
command -v xcodebuild >/dev/null || { echo "xcodebuild not found"; exit 1; }
command -v xcodegen   >/dev/null || { echo "xcodegen not found. brew install xcodegen"; exit 1; }
command -v create-dmg >/dev/null || { echo "create-dmg not found. brew install create-dmg"; exit 1; }
[ -x "${SPARKLE_TOOLS}/sign_update" ] || {
  echo "Sparkle sign_update not found at ${SPARKLE_TOOLS}/sign_update"; exit 1
}
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
  echo "notarytool keychain profile '${NOTARY_PROFILE}' not configured."; exit 1
}

# ---- project.yml channel injection --------------------------------------
#
# Channel-specific SUFeedURL and SpeakistDefaultAPIBaseURL must be in
# project.yml BEFORE `xcodegen generate` so they're baked into Info.plist
# and survive into the codesigned bundle. Modifying Info.plist after
# codesign would invalidate the signature, so pre-generate is the only
# correct time.
#
# Workflow:
#   1. Back up project.yml to project.yml.release-bak (channel-free state)
#   2. sed the channel values in
#   3. xcodegen + xcodebuild run against the channel-specific project.yml
#   4. On exit (success or failure), restore the backup. Version bumps are
#      re-applied below so they do persist in the committed file.
#
# Trap guarantees restoration even if the build fails halfway.

cp project.yml project.yml.release-bak
trap 'mv project.yml.release-bak project.yml 2>/dev/null || true' EXIT

echo "==> Injecting channel '$CHANNEL' into project.yml"
sed -i '' -E "s|(SUFeedURL:)[[:space:]]*\"[^\"]*\"|\1 \"${FEED_URL}\"|" project.yml
sed -i '' -E "s|(SpeakistDefaultAPIBaseURL:)[[:space:]]*\"[^\"]*\"|\1 \"${API_URL}\"|" project.yml
sed -i '' -E "s|(SpeakistChannel:)[[:space:]]*\"[^\"]*\"|\1 \"${CHANNEL}\"|" project.yml

# ---- version bump -------------------------------------------------------
#
# Version bumps SHOULD persist after the release; they're committed.
# Channel injection should NOT (it'd poison subsequent non-release builds).
# We apply the bump to the backup too so it survives the EXIT trap.

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

# ---- export -------------------------------------------------------------

echo "==> xcodebuild -exportArchive"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist scripts/exportOptions.plist

[ -d "$APP_PATH" ] || { echo "Export didn't produce $APP_PATH"; exit 1; }

# Channel sanity check: the exported Info.plist must reflect what we asked
# for. If a build cache handed us a cross-channel plist, abort before
# shipping the wrong thing.
BUILT_FEED=$(/usr/libexec/PlistBuddy -c "Print :SUFeedURL" "$APP_PATH/Contents/Info.plist")
BUILT_CHANNEL=$(/usr/libexec/PlistBuddy -c "Print :SpeakistChannel" "$APP_PATH/Contents/Info.plist")
if [ "$BUILT_FEED" != "$FEED_URL" ] || [ "$BUILT_CHANNEL" != "$CHANNEL" ]; then
  echo "Channel mismatch in built Info.plist!"
  echo "  Expected: channel=$CHANNEL feed=$FEED_URL"
  echo "  Got:      channel=$BUILT_CHANNEL feed=$BUILT_FEED"
  echo "Run: rm -rf build/ Speakist.xcodeproj  and try again."
  exit 1
fi

# ---- notarize -----------------------------------------------------------

ZIP_PATH="${BUILD_DIR}/${APP_NAME}-notarize.zip"
echo "==> Zipping for notarization"
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "==> notarytool submit (this can take a few minutes)"
xcrun notarytool submit "$ZIP_PATH" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait

echo "==> stapling ticket to .app"
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
SPARKLE_SIG=$("${SPARKLE_TOOLS}/sign_update" "$DMG_PATH")

# ---- appcast <item> fragment --------------------------------------------

DMG_FILENAME=$(basename "$DMG_PATH")
DMG_SIZE=$(stat -f%z "$DMG_PATH")
PUB_DATE=$(date -Ru)
TAG="v${VERSION}${DMG_SUFFIX}"

APPCAST_ITEM="    <item>
      <title>Version ${VERSION}</title>
      <pubDate>${PUB_DATE}</pubDate>
      <sparkle:version>${NEW_BUILD}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure
        url=\"https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${DMG_FILENAME}\"
        length=\"${DMG_SIZE}\"
        type=\"application/octet-stream\"
        ${SPARKLE_SIG} />
    </item>"

cat <<BANNER

════════════════════════════════════════════════════════════════════════
Release ${VERSION} (${CHANNEL}) built successfully.
════════════════════════════════════════════════════════════════════════

DMG:         ${DMG_PATH}  ($(du -h "$DMG_PATH" | cut -f1))
Channel:     ${CHANNEL}
Build:       ${NEW_BUILD}
Feed URL:    ${FEED_URL}
API URL:     ${API_URL}
Notarized:   yes (stapled)
Sparkle sig: ${SPARKLE_SIG}

Add this to ${APPCAST_FILE} *inside* the <channel> tag, above any
existing <item> blocks (newest first):

${APPCAST_ITEM}

BANNER

# ---- optional: publish --------------------------------------------------

if [ "$PUBLISH" = "yes" ]; then
  command -v gh >/dev/null || { echo "gh not found. brew install gh"; exit 1; }

  echo "==> Publishing to GitHub: ${GITHUB_REPO}  ${TAG}"
  PRERELEASE_FLAG=""
  [ "$CHANNEL" != "stable" ] && PRERELEASE_FLAG="--prerelease"

  gh release create "${TAG}" \
    --repo "${GITHUB_REPO}" \
    --title "${APP_NAME} ${VERSION} (${CHANNEL})" \
    --notes "Speakist ${VERSION} — channel: ${CHANNEL}." \
    $PRERELEASE_FLAG \
    "$DMG_PATH"
  echo "==> Release URL:"
  gh release view "${TAG}" --repo "${GITHUB_REPO}" --json url -q .url
else
  echo "(skipped gh release create — pass --publish to upload)"
fi

# ---- finalize: keep version bump, drop channel injection ----------------

mv project.yml.release-bak project.yml
trap - EXIT

echo ""
echo "Next steps:"
echo "  1. Edit ${APPCAST_FILE}, paste the <item> block above at the top of <channel>"
echo "  2. git add project.yml ${APPCAST_FILE}"
if [ "$CHANNEL" = "dev" ]; then
  echo "  3. cd web && pnpm deploy:dev   # dev-channel appcast lives on the dev env"
else
  echo "  3. cd web && pnpm deploy:prod  # beta + stable appcasts live on prod"
fi
echo ""
echo "  Installs on the '${CHANNEL}' channel will auto-update on next poll"
echo "  (or via Settings → About → Check for updates…)."
