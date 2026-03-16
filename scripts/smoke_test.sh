#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ENTRY="$ROOT_DIR/server/index.js"
BASE_URL="${BASE_URL:-http://localhost:4000}"
TMP_DIR="$(mktemp -d /tmp/war-room-smoke-XXXXXX)"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke][FAIL] %s\n' "$*" >&2; exit 1; }

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    fail "${label} (missing '${needle}')"
  fi
  log "PASS ${label}"
}

wait_for_server() {
  local attempts=30
  while (( attempts > 0 )); do
    if curl -s "${BASE_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.25
  done
  return 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "Required file not found: $path"
}

require_file "$ROOT_DIR/pistol.mp3"
require_file "$ROOT_DIR/gun.mp3"

log "Converting sample audio to wav"
ffmpeg -y -i "$ROOT_DIR/pistol.mp3" -ac 1 -ar 16000 "$TMP_DIR/pistol.wav" >/dev/null 2>&1
ffmpeg -y -i "$ROOT_DIR/gun.mp3" -ac 1 -ar 16000 "$TMP_DIR/gun.wav" >/dev/null 2>&1

log "Starting server"
node "$SERVER_ENTRY" >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID="$!"

wait_for_server || fail "Server did not become healthy. Log: $TMP_DIR/server.log"
log "Server healthy"

health="$(curl -s "${BASE_URL}/health")"
assert_contains "$health" "\"ok\":true" "health endpoint"

routes="$(curl -s "${BASE_URL}/routes")"
assert_contains "$routes" "/bluetooth/audio-event" "routes include bluetooth/audio-event"
assert_contains "$routes" "/bluetooth/threat-assessment" "routes include bluetooth/threat-assessment"

log "Testing watch threat assessment with pistol"
pistol_json="$(AUDIO_B64=$(base64 -w 0 "$TMP_DIR/pistol.wav"); curl -s -X POST "${BASE_URL}/watch/threat-assessment" -H 'Content-Type: application/json' -d "{\"watchId\":\"SMOKE-WATCH-1\",\"soldierGunName\":\"sniper\",\"audioBase64\":\"$AUDIO_B64\"}")"
assert_contains "$pistol_json" "\"result\":\"yes(pistol)\"" "watch threat pistol classification"
assert_contains "$pistol_json" "\"source\":\"enemy\"" "watch threat source enemy"

log "Testing bluetooth threat assessment with binary wav"
bt_json="$(curl -s -X POST "${BASE_URL}/bluetooth/threat-assessment" -H 'Content-Type: audio/wav' -H 'X-Watch-Id: SMOKE-BT-1' -H 'X-Session-Id: SMOKE-SESSION-1' -H 'X-Soldier-Gun-Name: sniper' --data-binary "@$TMP_DIR/pistol.wav")"
assert_contains "$bt_json" "\"source\":\"bluetooth\"" "bluetooth source flag"
assert_contains "$bt_json" "\"chunk\"" "bluetooth chunk payload"
assert_contains "$bt_json" "\"aggregated\"" "bluetooth aggregated payload"

log "Testing bluetooth smoothing second chunk"
bt_json_second="$(curl -s -X POST "${BASE_URL}/bluetooth/threat-assessment" -H 'Content-Type: audio/wav' -H 'X-Watch-Id: SMOKE-BT-1' -H 'X-Session-Id: SMOKE-SESSION-1' -H 'X-Soldier-Gun-Name: sniper' --data-binary "@$TMP_DIR/pistol.wav")"
assert_contains "$bt_json_second" "\"result\":\"yes(pistol)\"" "bluetooth stabilized result"

log "Testing watch audio event for gun clip"
gun_json="$(AUDIO_B64=$(base64 -w 0 "$TMP_DIR/gun.wav"); curl -s -X POST "${BASE_URL}/watch/audio-event" -H 'Content-Type: application/json' -d "{\"watchId\":\"SMOKE-WATCH-2\",\"audioBase64\":\"$AUDIO_B64\"}")"
assert_contains "$gun_json" "\"result\":\"yes(shotgun)\"" "watch audio event gun classification"

log "All smoke checks passed"

