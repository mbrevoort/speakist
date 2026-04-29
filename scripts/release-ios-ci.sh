#!/usr/bin/env bash
#
# CI: build an iOS archive, export an .ipa, upload to TestFlight.
#
# Drives both the dev pipeline (deploy-dev.yml — scheme "SpeakistiOS
# Dev", config Dev → bundle ID …ios.dev → "Speakist Dev" app record)
# and the prod pipeline (deploy-prod.yml — scheme "SpeakistiOS",
# config Release → bundle ID …ios → "Speakist" app record). Default
# behavior (no overrides set) reproduces the dev flow exactly.
#
# Prerequisites (set up by the composite action `setup-apple-signing`
# in the calling workflow):
#   * App Store Connect API key (.p8) at
#     ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   * Apple Distribution P12 imported into the runner keychain so
#     `xcodebuild -allowProvisioningUpdates` reuses it instead of
#     minting fresh certs (3-cert/team cap). See deploy-dev.yml +
#     docs/cicd.md for the secret wiring.
#
# Required env:
#   APP_STORE_CONNECT_KEY_ID     10-char alphanumeric
#   APP_STORE_CONNECT_ISSUER_ID  Team's issuer UUID
#   GITHUB_RUN_NUMBER            Provided by GitHub Actions
#
# Optional env (set by deploy-prod.yml to switch from dev to stable):
#   RELEASE_IOS_SCHEME           Xcode scheme (default: "SpeakistiOS Dev")
#   RELEASE_IOS_CONFIG           Build config (default: Dev)
#   RELEASE_VERSION              MARKETING_VERSION override (e.g. "0.2.0").
#                                Unset on dev — project.yml's value is used.
#
# CFBundleVersion strategy: TestFlight requires every uploaded build
# for a given (bundle ID, marketing version) pair to have a strictly
# greater CFBundleVersion than every previous upload, forever (until
# marketing version increases). Picking `100000 + GITHUB_RUN_NUMBER`
# gives plenty of headroom — you'd need 100k CI runs to collide with
# anything plausible — and is monotonic by GitHub's contract on
# run numbers (which only ever increment, even on force-pushes).
# The dev-channel and stable-channel records have separate bundle IDs,
# so their CFBundleVersion sequences are independent and never collide.

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
SCHEME="${RELEASE_IOS_SCHEME:-SpeakistiOS Dev}"
CONFIG="${RELEASE_IOS_CONFIG:-Dev}"
# Per-config archive path so a single workspace can host both
# dev-channel and stable-channel archives without one stomping the other.
ARCHIVE_PATH="build/SpeakistiOS-${CONFIG}.xcarchive"
EXPORT_DIR="build/ios-export-${CONFIG}"

# MARKETING_VERSION override only when RELEASE_VERSION is set (prod
# pipeline). Dev builds keep whatever's in project.yml — bumping the
# marketing version on every dev push would force a fresh CFBundleVersion
# baseline for TestFlight, which doesn't help anyone testing internally.
#
# Plain string (unquoted on expansion) rather than a bash array. The
# array form `"${arr[@]}"` errors under `set -u` when the array is
# empty on bash versions older than 4.4 — which is what `env bash`
# resolves to on the GitHub macos-26 runner. Unquoted scalar
# expansion of an empty (but defined) string is safe under `set -u`
# because the variable IS set; it just yields zero tokens.
# `MARKETING_VERSION=...` has no whitespace, so unquoted expansion
# produces exactly one xcodebuild build-setting argument.
MARKETING_FLAG=""
if [ -n "${RELEASE_VERSION:-}" ]; then
  MARKETING_FLAG="MARKETING_VERSION=$RELEASE_VERSION"
fi

echo "==> Generating Xcode project (xcodegen)"
xcodegen generate

echo "==> xcodebuild archive (scheme='$SCHEME' config=$CONFIG CFBundleVersion=$CFBUNDLE_VERSION${RELEASE_VERSION:+ MARKETING_VERSION=$RELEASE_VERSION})"
xcodebuild \
  -project Speakist.xcodeproj \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID" \
  CURRENT_PROJECT_VERSION=$CFBUNDLE_VERSION \
  ${MARKETING_FLAG} \
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
