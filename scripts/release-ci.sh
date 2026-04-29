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
# computes a version string, then exec's release.sh with the
# appropriate channel.
#
# Drives both the dev pipeline (deploy-dev.yml, every push to main)
# and the prod pipeline (deploy-prod.yml, every GitHub Release). The
# default behavior — no overrides set — reproduces the dev flow
# exactly: channel=dev, version=<project.yml>+dev.<run>, notes="CI
# build from <sha>", token from SPEAKIST_PUBLISH_TOKEN_DEV.
#
# Required env (failure mode is loud — missing var → exit 1):
#   APP_STORE_CONNECT_KEY_ID    10-char alphanumeric
#   APP_STORE_CONNECT_ISSUER_ID Issuer UUID
#   SPARKLE_PRIVATE_KEY         Raw base64 EdDSA private key
#   RELEASE_PUBLISH_TOKEN       Bearer for /api/admin/releases/publish
#   GITHUB_RUN_NUMBER           Provided automatically by GitHub Actions
#   GITHUB_SHA                  Provided automatically (used in release notes)
#
# Optional env (set by deploy-prod.yml to override defaults):
#   RELEASE_CHANNEL             dev|beta|stable (default: dev)
#   RELEASE_VERSION             Marketing version (default: derived
#                               from project.yml + run number)
#   RELEASE_NOTES_FILE          Path to release-notes file (HTML or
#                               plain text). Contents go into the
#                               appcast <description>. Falls back to
#                               "CI build from <short-sha>" when unset.

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

# Channel selection (default: dev for the deploy-dev pipeline).
CHANNEL="${RELEASE_CHANNEL:-dev}"
case "$CHANNEL" in
  dev|beta|stable) ;;
  *) echo "FATAL: invalid RELEASE_CHANNEL='$CHANNEL' (must be dev, beta, or stable)" >&2; exit 1 ;;
esac

# Hand the env-var hooks to release.sh.
export NOTARY_API_KEY_PATH="$API_KEY_PATH"
export NOTARY_API_KEY_ID="$APP_STORE_CONNECT_KEY_ID"
export NOTARY_API_ISSUER="$APP_STORE_CONNECT_ISSUER_ID"
# SPARKLE_PRIVATE_KEY already in env from the workflow; release.sh
# checks `${SPARKLE_PRIVATE_KEY:-}` so passing through is enough.
# Map the workflow's RELEASE_PUBLISH_TOKEN onto the channel-specific
# slot release.sh reads from. dev → SPEAKIST_PUBLISH_TOKEN_DEV;
# beta and stable both → SPEAKIST_PUBLISH_TOKEN_PROD (they share
# the prod Worker + D1 — only the channel column on the row differs).
case "$CHANNEL" in
  dev)          export SPEAKIST_PUBLISH_TOKEN_DEV="$RELEASE_PUBLISH_TOKEN" ;;
  beta|stable)  export SPEAKIST_PUBLISH_TOKEN_PROD="$RELEASE_PUBLISH_TOKEN" ;;
esac

# Marketing version: prod pipeline passes RELEASE_VERSION (e.g. "0.2.0"
# from the GitHub Release tag), so use it verbatim. Dev pipeline leaves
# it unset and gets the "<project.yml>+dev.<run>" cosmetic suffix —
# Sparkle ignores marketing version for ordering (CFBundleVersion is
# what matters), so the "+dev.N" is purely a "which CI build is this"
# breadcrumb in About windows.
if [ -n "${RELEASE_VERSION:-}" ]; then
  VERSION="$RELEASE_VERSION"
else
  PROJECT_VERSION=$(awk '/^[[:space:]]*MARKETING_VERSION:/ {gsub(/"/, "", $2); print $2; exit}' project.yml)
  [ -n "$PROJECT_VERSION" ] || { echo "FATAL: couldn't read MARKETING_VERSION from project.yml" >&2; exit 1; }
  VERSION="${PROJECT_VERSION}+dev.${GITHUB_RUN_NUMBER}"
fi

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

# Release notes: prod pipeline writes the GitHub Release body (rendered
# from markdown to HTML) to a file and points us at it via
# RELEASE_NOTES_FILE — the contents land in the Sparkle appcast
# <description><![CDATA[...]]> for users to see. Dev pipeline leaves
# it unset and gets a short "CI build from <sha>" breadcrumb instead.
SHORT_SHA=${GITHUB_SHA:0:7}
if [ -n "${RELEASE_NOTES_FILE:-}" ]; then
  [ -f "$RELEASE_NOTES_FILE" ] || { echo "FATAL: RELEASE_NOTES_FILE not found: $RELEASE_NOTES_FILE" >&2; exit 1; }
  NOTES=$(cat "$RELEASE_NOTES_FILE")
else
  NOTES="CI build from ${SHORT_SHA}"
fi

echo "==> CI release wrapper: VERSION=$VERSION CHANNEL=$CHANNEL SHA=$SHORT_SHA"
exec scripts/release.sh "$VERSION" --channel "$CHANNEL" --notes "$NOTES"
