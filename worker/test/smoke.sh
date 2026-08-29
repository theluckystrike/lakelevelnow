#!/usr/bin/env bash
# Smoke test for the lake-level-almanac worker. Usage: bash test/smoke.sh [base-url]
# Exits non-zero when any check fails. Needs curl + jq.
set -u
BASE="${1:-https://lake-level-almanac.lipmichal.workers.dev}"
# Real, unpaid live session on the single-lake payment link: proves the Stripe key works.
SID="cs_live_b1kX4OjasrwnsFcXS6nkR9bhNaptiiD6fuJDOK4xVdAwGA4uf0PQl01z7N"
PASS=0
FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "ok    $1 = $3"
  else FAIL=$((FAIL + 1)); echo "FAIL  $1 expected=$2 got=$3"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

command -v jq >/dev/null || { echo "jq is required"; exit 2; }

H=$(curl -s "$BASE/health")
check "health.ok" "true" "$(echo "$H" | jq -r '.ok')"
check "health.version" "1.1.0" "$(echo "$H" | jq -r '.version')"
check "health.mode" "live" "$(echo "$H" | jq -r '.mode')"
check "health.configured" "true" "$(echo "$H" | jq -r '[.configured[]] | all')"

check "catalog.lakes" "19" "$(curl -s "$BASE/catalog" | jq -r '.lakes | length')"

check "verify.bad_id" "400" "$(code "$BASE/verify?session_id=bad")"
V=$(curl -s -w '\n%{http_code}' "$BASE/verify?session_id=$SID")
check "verify.unpaid.code" "402" "$(echo "$V" | tail -1)"
check "verify.unpaid.error" "not_paid" "$(echo "$V" | sed '$d' | jq -r '.error')"

check "hit.with_origin" "204" "$(code -H 'Origin: https://lakelevelnow.com' "$BASE/hit?e=alm_view&l=test")"
check "hit.no_origin" "204" "$(code "$BASE/hit?e=alm_view&l=test")"
check "hit.bad_event" "204" "$(code -H 'Origin: https://lakelevelnow.com' "$BASE/hit?e=nope")"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
