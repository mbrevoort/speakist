#!/usr/bin/env bash
#
# CI wrapper around scripts/release.sh.
#
# Bridges the keychain-credentials world that release.sh expects on a
# developer's laptop to the env-var world a GitHub Actions runner
# operates in. The composite action `setup-apple-signing` already
# imported the Developer ID cert into a temp keychain and dropped the
# App Store Connect .p8 into the conventional path; this script
# exports the env-var hooks release.sh reads (NOTARY_API_KEY_PATH /
# NOTARY_API_KEY_ID / NOTARY_API_ISSUER / SPARKLE_PRIVATE_KEY) and
# computes a CI-flavored version string, then exec's release.sh with
# the dev-channel flag.
#
# Required env (failure mode is loud — missing var → exit 1):
#   APP_STORE_CONNECT_KEY_ID    10-char alphanumeric
#   APP_STORE_CONNECT_ISSUER_ID Issuer UUID
#   SPARKLE_PRIVATE_KEY         Raw base64 EdDSA private key
#   RELEASE_PUBLISH_TOKEN       Bearer for /api/admin/releases/publish
#   GITHUB_RUN_NUMBER           Provided automatically by GitHub Actions
#   GITHUB_SHA                  Provided automatically (used in release notes)

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
require SPARKLE_PRIVATE_KEY
require RELEASE_PUBLISH_TOKEN
require GITHUB_RUN_NUMBER
require GITHUB_SHA

# Path the composite action wrote the .p8 to. Verify it exists rather
# than re-deriving the location, so a future composite-action change
# doesn't silently break this script.
API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
[ -f "$API_KEY_PATH" ] || {
  echo "FATAL: API key not found at $API_KEY_PATH — did setup-apple-signing run?" >&2
  exit 1
}

# Hand the env-var hooks to release.sh.
export NOTARY_API_KEY_PATH="$API_KEY_PATH"
export NOTARY_API_KEY_ID="$APP_STORE_CONNECT_KEY_ID"
export NOTARY_API_ISSUER="$APP_STORE_CONNECT_ISSUER_ID"
# SPARKLE_PRIVATE_KEY already in env from the workflow; release.sh
# checks `${SPARKLE_PRIVATE_KEY:-}` so passing through is enough.
# The publish-token env var has channel-specific names per the script;
# we map the workflow's RELEASE_PUBLISH_TOKEN onto the dev-channel slot.
export SPEAKIST_PUBLISH_TOKEN_DEV="$RELEASE_PUBLISH_TOKEN"

# Compute a marketing version with a CI build-meta suffix. The suffix
# is purely cosmetic — Sparkle compares CFBundleVersion (the integer
# build number) for ordering, not the marketing version. The "+dev.N"
# is here so a user reading the About panel can eyeball which CI build
# they're on.
PROJECT_VERSION=$(awk '/^[[:space:]]*MARKETING_VERSION:/ {gsub(/"/, "", $2); print $2; exit}' project.yml)
[ -n "$PROJECT_VERSION" ] || { echo "FATAL: couldn't read MARKETING_VERSION from project.yml" >&2; exit 1; }
VERSION="${PROJECT_VERSION}+dev.${GITHUB_RUN_NUMBER}"

# Override CFBundleVersion to a monotonically-increasing per-CI-run
# number. release.sh's default behavior is "+1 on the file's persisted
# value", which means every CI run produces the same number (since CI
# never commits the bump back) — every Sparkle item ended up with the
# same `<sparkle:version>`, so the appcast looked identical to clients
# and Check-for-Updates always reported "you're up to date" regardless
# of how many builds had shipped.
#
# `100000 + GITHUB_RUN_NUMBER` mirrors the iOS CFBundleVersion strategy
# in scripts/release-ios-ci.sh — large headroom (you'd need 100k runs to
# collide with anything plausible) and monotonic by GitHub's contract
# on run numbers (only ever increment, even on force-pushes).
export RELEASE_BUILD_NUMBER=$((100000 + GITHUB_RUN_NUMBER))

# Short notes for the publish-API row.
SHORT_SHA=${GITHUB_SHA:0:7}
NOTES="CI build from ${SHORT_SHA}"

echo "==> CI release wrapper: VERSION=$VERSION CHANNEL=dev SHA=$SHORT_SHA"
exec scripts/release.sh "$VERSION" --channel dev --notes "$NOTES"
