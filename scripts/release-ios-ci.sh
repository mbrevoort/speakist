#!/usr/bin/env bash
#
# CI: build the iOS Dev archive, export an .ipa, upload to TestFlight.
#
# Prerequisites (set up by the composite action `setup-apple-signing`
# in the calling workflow):
#   * App Store Connect API key (.p8) at
#     ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   * No Developer ID cert needed — `xcodebuild -allowProvisioningUpdates`
#     against the API key auto-fetches an iOS Distribution cert + the
#     two provisioning profiles for the Dev bundle IDs (main app +
#     keyboard extension).
#
# Required env:
#   APP_STORE_CONNECT_KEY_ID     10-char alphanumeric
#   APP_STORE_CONNECT_ISSUER_ID  Team's issuer UUID
#   GITHUB_RUN_NUMBER            Provided by GitHub Actions
#
# CFBundleVersion strategy: TestFlight requires every uploaded build
# for a given (bundle ID, marketing version) pair to have a strictly
# greater CFBundleVersion than every previous upload, forever (until
# marketing version increases). Picking `100000 + GITHUB_RUN_NUMBER`
# gives plenty of headroom — you'd need 100k CI runs to collide with
# anything plausible — and is monotonic by GitHub's contract on
# run numbers (which only ever increment, even on force-pushes).

set -euo pipefail

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "FATAL: required env var $name is unset" >&2
    exit 1
  fi
}

require APP_STORE_CONNECT_KEY_ID
require APP_STORE_CONNECT_ISSUER_ID
require GITHUB_RUN_NUMBER

API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
[ -f "$API_KEY_PATH" ] || {
  echo "FATAL: API key not found at $API_KEY_PATH — did setup-apple-signing run?" >&2
  exit 1
}

CFBUNDLE_VERSION=$((100000 + GITHUB_RUN_NUMBER))
ARCHIVE_PATH="build/SpeakistiOS-Dev.xcarchive"
EXPORT_DIR="build/ios-export"

echo "==> Generating Xcode project (xcodegen)"
xcodegen generate

echo "==> xcodebuild archive (Dev config, CFBundleVersion=${CFBUNDLE_VERSION})"
xcodebuild \
  -project Speakist.xcodeproj \
  -scheme "SpeakistiOS Dev" \
  -configuration Dev \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID" \
  CURRENT_PROJECT_VERSION=$CFBUNDLE_VERSION \
  archive

echo "==> xcodebuild -exportArchive"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist scripts/exportOptions-ios.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"

IPA=$(find "$EXPORT_DIR" -maxdepth 2 -name "*.ipa" -print -quit)
[ -n "$IPA" ] || { echo "FATAL: no IPA produced under $EXPORT_DIR" >&2; ls -lR "$EXPORT_DIR" >&2; exit 1; }
echo "==> Built IPA: $IPA"

echo "==> Uploading to TestFlight (xcrun altool)"
# `altool --upload-app` handles the App Store Connect API auth and the
# multi-stage upload protocol. Builds land in the Internal Testing
# group automatically once Apple's CDN finishes processing the binary
# (typically 5-15 min after upload completes — no human review for
# Internal testers).
xcrun altool --upload-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$APP_STORE_CONNECT_KEY_ID" \
  --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"

echo "==> TestFlight upload complete (build $CFBUNDLE_VERSION)"
