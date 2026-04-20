#!/usr/bin/env bash
#
# Speakist Mac release pipeline.
#
# Runs the full archive → export → notarize → DMG → sparkle-sign sequence
# and emits the <item> XML block to paste into web/public/appcast.xml.
# Optionally uploads to a GitHub Release with `--publish`.
#
# Usage:
#   scripts/release.sh 0.2.0                  # build + sign + notarize + DMG
#   scripts/release.sh 0.2.0 --publish        # also `gh release create`
#
# Prerequisites (one-time per machine):
#   * Xcode + Developer ID Application cert in Keychain for team Q5T8FJNX57
#   * brew install xcodegen create-dmg
#   * Sparkle tools: download the Sparkle release archive, copy the bin/
#     folder somewhere on disk, set SPARKLE_TOOLS env var to that path.
#       https://github.com/sparkle-project/Sparkle/releases
#   * Sparkle EdDSA keypair: `$SPARKLE_TOOLS/generate_keys`
#       - public key: paste into project.yml → info.properties.SUPublicEDKey
#       - private key: stored in your login Keychain by generate_keys;
#         back it up (1Password, YubiKey). LOSING IT MEANS YOU CANNOT
#         PUSH UPDATES TO EXISTING INSTALLS, EVER.
#   * notarytool credentials: one-time
#       xcrun notarytool store-credentials SPEAKIST_NOTARY \
#         --apple-id mike@brevoort.com --team-id Q5T8FJNX57 \
#         --password <app-specific-password>
#   * (for --publish) `gh auth login` completed; GITHUB_REPO env var set
#     or hardcoded below.

set -euo pipefail

# -------- config ----------------------------------------------------------

VERSION="${1:-}"
PUBLISH="${2:-}"

if [ -z "$VERSION" ]; then
  cat <<USAGE
Usage: $0 <version> [--publish]
       $0 0.2.0
       $0 0.2.0 --publish
USAGE
  exit 1
fi

APP_NAME="Speakist"
TEAM_ID="Q5T8FJNX57"
NOTARY_PROFILE="${NOTARY_PROFILE:-SPEAKIST_NOTARY}"
SPARKLE_TOOLS="${SPARKLE_TOOLS:-$HOME/Library/Developer/Sparkle/bin}"
GITHUB_REPO="${GITHUB_REPO:-brevoortstudio/speakist}"   # owner/repo; change to yours
BUILD_DIR="build"
EXPORT_DIR="${BUILD_DIR}/export"
ARCHIVE_PATH="${BUILD_DIR}/${APP_NAME}.xcarchive"
APP_PATH="${EXPORT_DIR}/${APP_NAME}.app"
DMG_PATH="${BUILD_DIR}/${APP_NAME}-${VERSION}.dmg"

# -------- preflight -------------------------------------------------------

echo "==> Preflight"
command -v xcodebuild >/dev/null || { echo "xcodebuild not found"; exit 1; }
command -v xcodegen   >/dev/null || { echo "xcodegen not found. brew install xcodegen"; exit 1; }
command -v create-dmg >/dev/null || { echo "create-dmg not found. brew install create-dmg"; exit 1; }
[ -x "${SPARKLE_TOOLS}/sign_update" ] || {
  echo "Sparkle sign_update not found at ${SPARKLE_TOOLS}/sign_update"
  echo "Download Sparkle, copy bin/ somewhere, set SPARKLE_TOOLS env var"
  exit 1
}
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
  echo "notarytool keychain profile '${NOTARY_PROFILE}' not configured."
  echo "Run: xcrun notarytool store-credentials ${NOTARY_PROFILE} \\"
  echo "       --apple-id <your@apple.id> --team-id ${TEAM_ID} \\"
  echo "       --password <app-specific-password-from-appleid.apple.com>"
  exit 1
}

# -------- bump version in project.yml ------------------------------------

echo "==> Bumping MARKETING_VERSION → $VERSION"
# sed in-place (BSD variant on macOS). CURRENT_PROJECT_VERSION is the build
# number; bumping by 1 each release is reasonable. This is naïve (first match
# wins) but the file only has one MARKETING_VERSION line so it's fine.
sed -i '' -E "s/(MARKETING_VERSION: +\")[^\"]+(\")/\1${VERSION}\2/" project.yml

CURRENT_BUILD=$(grep -E 'CURRENT_PROJECT_VERSION:' project.yml | head -n1 | sed -E 's/.*"([0-9]+)".*/\1/')
NEW_BUILD=$((CURRENT_BUILD + 1))
echo "==> Bumping CURRENT_PROJECT_VERSION $CURRENT_BUILD → $NEW_BUILD"
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: +\")[0-9]+(\")/\1${NEW_BUILD}\2/" project.yml

# -------- archive ---------------------------------------------------------

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

# -------- export ---------------------------------------------------------

echo "==> xcodebuild -exportArchive"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist scripts/exportOptions.plist

[ -d "$APP_PATH" ] || { echo "Export didn't produce $APP_PATH"; exit 1; }

# -------- notarize -------------------------------------------------------

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

# -------- DMG ------------------------------------------------------------

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

# -------- Sparkle sign ---------------------------------------------------

echo "==> Sparkle sign_update"
# sign_update reads the private key from the login Keychain (where
# generate_keys stored it). Output looks like:
#   sparkle:edSignature="..." length="..."
SPARKLE_SIG=$("${SPARKLE_TOOLS}/sign_update" "$DMG_PATH")

# -------- appcast <item> fragment ----------------------------------------

DMG_FILENAME=$(basename "$DMG_PATH")
DMG_SIZE=$(stat -f%z "$DMG_PATH")
PUB_DATE=$(date -Ru)

APPCAST_ITEM="    <item>
      <title>Version ${VERSION}</title>
      <pubDate>${PUB_DATE}</pubDate>
      <sparkle:version>${NEW_BUILD}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure
        url=\"https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${DMG_FILENAME}\"
        length=\"${DMG_SIZE}\"
        type=\"application/octet-stream\"
        ${SPARKLE_SIG} />
    </item>"

cat <<BANNER

════════════════════════════════════════════════════════════════════════
Release ${VERSION} built successfully.
════════════════════════════════════════════════════════════════════════

DMG:         ${DMG_PATH}  ($(du -h "$DMG_PATH" | cut -f1))
Build:       ${NEW_BUILD}
Notarized:   yes (stapled)
Sparkle sig: ${SPARKLE_SIG}

Add this to web/public/appcast.xml *inside* the <channel> tag, above any
existing <item> blocks (newest first):

${APPCAST_ITEM}

BANNER

# -------- optional: publish ----------------------------------------------

if [ "$PUBLISH" = "--publish" ]; then
  command -v gh >/dev/null || { echo "gh not found. brew install gh"; exit 1; }

  echo "==> Publishing to GitHub: ${GITHUB_REPO}  v${VERSION}"
  gh release create "v${VERSION}" \
    --repo "${GITHUB_REPO}" \
    --title "${APP_NAME} ${VERSION}" \
    --notes "Speakist ${VERSION} — see appcast.xml for release notes." \
    "$DMG_PATH"
  echo "==> Release URL:"
  gh release view "v${VERSION}" --repo "${GITHUB_REPO}" --json url -q .url
else
  echo "(skipped gh release create — pass --publish to upload)"
fi

echo ""
echo "Next steps:"
echo "  1. Edit web/public/appcast.xml, paste the <item> block above at the top"
echo "     of the <channel>, and commit"
echo "  2. pnpm deploy:prod   # so speakist.ai/appcast.xml serves the new entry"
echo "  3. Running Speakist installs will auto-update on next poll (or via"
echo "     Settings → About → Check for updates…)"
