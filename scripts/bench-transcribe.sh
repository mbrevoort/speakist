#!/usr/bin/env bash
# Bench /api/transcribe latency — runs N upload iterations against the
# Speakist Worker and prints the per-stage timing breakdown the Worker
# returns under `timings`. Use this to identify whether the
# release-to-paste budget is being spent in network overhead, the STT
# upstream call, polish, or debit — without round-tripping through the
# real Mac app each time.
#
# Usage:
#   scripts/bench-transcribe.sh <audio-file.wav> [iterations] [--lang LANG] [--prod]
#
# Examples:
#   scripts/bench-transcribe.sh ~/Library/Application\ Support/Speakist\ Local/Audio/SOME.wav 10
#   scripts/bench-transcribe.sh fixture.wav 5 --lang en
#   scripts/bench-transcribe.sh fixture.wav 1 --prod
#
# Note: polish is decided by the *signed-in user's* `polishEnabled` flag
# in the DB, not by a request header. Toggle it via /dashboard/account
# (or the Polish settings tab in the Mac app) before running, then the
# Worker will report `polishApplied=true` and `timings.polish` reflects
# the LLM call.
#
# Token resolution (in order):
#   1. SPEAKIST_TOKEN env var
#   2. macOS keychain (Speakist Local refreshToken)
#
# Defaults to the dev Worker (speakist-dev.brevoortstudio.com) since
# that's where iterative changes land first; pass --prod to hit
# production.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat <<USAGE >&2
Usage: $0 <audio-file.wav> [iterations] [--lang LANG] [--prod] [--fast]
USAGE
  exit 2
fi

AUDIO="$1"; shift
ITERATIONS=1
LANG_HEADER=""
ENV="dev"
SKIP_POLISH_HEADER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)
      LANG_HEADER="X-Language: $2"
      shift 2
      ;;
    --prod)
      ENV="prod"
      shift
      ;;
    --fast)
      # Send `X-Polish-Skip: true` so the Worker bypasses the polish
      # LLM round-trip entirely. Use this to A/B the polish cost
      # against the same audio file.
      SKIP_POLISH_HEADER="X-Polish-Skip: true"
      shift
      ;;
    [0-9]*)
      ITERATIONS="$1"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$AUDIO" ]]; then
  echo "Audio file not found: $AUDIO" >&2
  exit 1
fi

case "$ENV" in
  dev) BASE_URL="https://speakist-dev.brevoortstudio.com" ;;
  prod) BASE_URL="https://speakist.ai" ;;
esac

# --- Auth -------------------------------------------------------------------
if [[ -z "${SPEAKIST_TOKEN:-}" ]]; then
  # Default to the Local-build keychain entry. Swap the service name if
  # you're benching a different channel. SPEAKIST_KEYCHAIN_SERVICE lets
  # you override (e.g. "com.brevoort-studio.speakist.dev.apikeys").
  SERVICE="${SPEAKIST_KEYCHAIN_SERVICE:-com.brevoort-studio.speakist.local.apikeys}"
  if ! TOKEN=$(security find-generic-password -s "$SERVICE" -a "refreshToken" -w 2>/dev/null); then
    echo "Couldn't read bearer token from keychain ($SERVICE / refreshToken)." >&2
    echo "Either sign in via the Speakist Local app, or export SPEAKIST_TOKEN." >&2
    exit 1
  fi
  # The `security` CLI emits a trailing newline on the password value;
  # strip every kind of whitespace before using as a bearer header.
  TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
else
  TOKEN="$SPEAKIST_TOKEN"
fi

# Validate the token against the chosen environment before running the
# benchmark loop — saves N×audio-upload bandwidth if auth is wrong, and
# the user gets a single clear error instead of N copies.
ME_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/me")
if [[ "$ME_STATUS" != "200" ]]; then
  echo "Auth pre-check against $BASE_URL/api/me returned HTTP $ME_STATUS." >&2
  echo "Likely the keychain token is for a different environment than $ENV." >&2
  echo "If the Speakist Local app is signed in to prod, run with --prod." >&2
  echo "Or export SPEAKIST_TOKEN with a token valid for this environment." >&2
  exit 1
fi

# --- Bench loop -------------------------------------------------------------
audio_size=$(stat -f %z "$AUDIO")
audio_ms=$((audio_size / 32))   # 16 kHz mono Int16 = 32 bytes/ms; rough hint

echo "Benching $BASE_URL/api/transcribe — $ITERATIONS iteration(s)"
echo "  audio: $AUDIO ($((audio_size / 1024)) KB ≈ ${audio_ms}ms)"
[[ -n "$LANG_HEADER" ]]         && echo "  $LANG_HEADER"
[[ -n "$SKIP_POLISH_HEADER" ]]  && echo "  $SKIP_POLISH_HEADER"
echo

# Per-iteration arrays for aggregate stats. Initialized empty so
# `${#arr[@]}` is safe under `set -u` on macOS's bash 3.2 even when
# every iteration fails before populating.
declare -a NET_MS=()
declare -a WORKER_MS=()
declare -a UPSTREAM_MS=()
declare -a POLISH_MS=()
declare -a DEBIT_MS=()

printf "%3s  %6s  %6s  %6s  %6s  %6s  %6s  %s\n" \
  "#" "net" "wall" "auth" "body" "stt" "polish" "result"
printf "%3s  %6s  %6s  %6s  %6s  %6s  %6s  %s\n" \
  "---" "------" "------" "------" "------" "------" "------" "-----------------------------------"

for ((i=1; i<=ITERATIONS; i++)); do
  TX_ID="bench-$(date +%s)-$i-$RANDOM"

  # curl with --write-out gives us total time at the network layer; the
  # JSON body has the Worker's per-stage breakdown.
  T0=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')
  RESPONSE=$(curl -sS \
    -X POST "$BASE_URL/api/transcribe" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: audio/wav" \
    -H "X-Transcription-Id: $TX_ID" \
    -H "X-Audio-Ms: $audio_ms" \
    ${LANG_HEADER:+-H "$LANG_HEADER"} \
    ${SKIP_POLISH_HEADER:+-H "$SKIP_POLISH_HEADER"} \
    --data-binary "@$AUDIO" \
    -w "\nHTTP_STATUS:%{http_code}")
  T1=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')

  net_ms=$(echo "($T1 - $T0) * 1000" | bc -l | awk '{printf "%d", $1}')
  status=$(echo "$RESPONSE" | tail -n1 | sed 's/HTTP_STATUS://')
  body=$(echo "$RESPONSE" | sed '$d')

  if [[ "$status" != "200" ]]; then
    printf "%3d  %6d  %6s  %6s  %6s  %6s  %6s  %s\n" \
      "$i" "$net_ms" "-" "-" "-" "-" "-" "HTTP $status: $(echo "$body" | head -c 60)"
    continue
  fi

  # Pull out the timings + provider/model/text length + polish-reason
  # from the response. Reason is set when polish ran but applied=false
  # (e.g., `rejected: output_too_long`, `assistant_preamble: starts
  # with "here is"`, `empty_completion`) — surfaces *why* a polish
  # call was wasted so we can tighten prompts or skip cases where
  # polish reliably fails.
  read -r wall auth body_t upstream polish debit polish_applied polish_reason provider model textlen <<EOF
$(echo "$body" | jq -r '
    [
      (.timings.total // 0),
      (.timings.auth // 0),
      ((.timings.body // 0) - (.timings.auth // 0)),
      ((.timings.upstream // 0) - (.timings.body // 0)),
      ((.timings.polish // 0) - (.timings.upstream // 0)),
      ((.timings.debit // 0) - (.timings.polish // 0)),
      (if .polishApplied then "y" else "n" end),
      (.polishErrorReason // "-"),
      .provider,
      .model,
      (.text | length)
    ] | @tsv
  ')
EOF

  overhead=$((net_ms - wall))
  reason_field=""
  [[ "$polish_reason" != "-" ]] && reason_field=" polishReason=$polish_reason"
  printf "%3d  %6d  %6d  %6d  %6d  %6d  %6d  %s/%s polish=%s text=%dch overhead=%dms%s\n" \
    "$i" "$net_ms" "$wall" "$auth" "$body_t" "$upstream" "$polish" \
    "$provider" "$model" "$polish_applied" "$textlen" "$overhead" "$reason_field"

  NET_MS+=("$net_ms")
  WORKER_MS+=("$wall")
  UPSTREAM_MS+=("$upstream")
  POLISH_MS+=("$polish")
  DEBIT_MS+=("$debit")
done

# --- Aggregate stats --------------------------------------------------------
if [[ ${#NET_MS[@]} -lt 2 ]]; then
  exit 0
fi

# Print median + p95 for each stage. Sort numerically, pick at indexes.
summarize() {
  local label="$1"; shift
  local sorted; sorted=$(printf '%s\n' "$@" | sort -n)
  local n=$#
  local median_idx=$(( (n + 1) / 2 ))
  local p95_idx=$(( (n * 95 + 99) / 100 ))
  [[ $median_idx -lt 1 ]] && median_idx=1
  [[ $p95_idx -lt 1 ]] && p95_idx=1
  [[ $p95_idx -gt $n ]] && p95_idx=$n
  local median; median=$(echo "$sorted" | sed -n "${median_idx}p")
  local p95;    p95=$(echo "$sorted" | sed -n "${p95_idx}p")
  printf "  %-20s median=%5dms  p95=%5dms\n" "$label" "$median" "$p95"
}

echo
echo "Aggregate (${#NET_MS[@]} runs):"
summarize "net (mac ↔ paste)"   "${NET_MS[@]}"
summarize "worker total"        "${WORKER_MS[@]}"
summarize "upstream STT"        "${UPSTREAM_MS[@]}"
summarize "polish"              "${POLISH_MS[@]}"
summarize "debit"               "${DEBIT_MS[@]}"
