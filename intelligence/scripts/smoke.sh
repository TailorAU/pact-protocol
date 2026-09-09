#!/usr/bin/env bash
# End-to-end smoke: replay fixtures → bronze/silver → state → graph → API → SSE.
# Style follows tools/matter-smoke.sh: bash + curl + python3, numbered assertions.
# Usage: bash scripts/smoke.sh [port]   (run from intelligence/, after npm run build)
set -u
PORT="${1:-4271}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAR="$(mktemp -d)"
API_LOG="$VAR/api.log"
PASS=0
FAIL=0
API_PID=""

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); say "  ok  $1"; }
bad()  { FAIL=$((FAIL + 1)); say " FAIL $1"; }
check() { # check <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  rm -rf "$VAR"
}
trap cleanup EXIT

say "== 1. replay ingestion (fixtures → bronze → silver)"
if node "$ROOT/packages/connectors/dist/cli.js" ingest --replay --var "$VAR" --data "$ROOT/data" >"$VAR/ingest.log" 2>&1; then
  ok "pt-ingest --replay exits 0"
else
  bad "pt-ingest --replay exits 0 (see $VAR/ingest.log)"
  cat "$VAR/ingest.log"
fi
check "bronze artifacts written" bash -c "ls \"$VAR\"/bronze/*/*/*/*/*.bin"
check "silver observations written" bash -c "ls \"$VAR\"/silver/*/*.jsonl"

say "== 2. API boot (replay mode)"
node "$ROOT/packages/api/dist/cli.js" --port "$PORT" --var "$VAR" --data "$ROOT/data" --replay >"$API_LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
check "healthz responds" curl -sf "http://127.0.0.1:$PORT/healthz"

api() { curl -sf "http://127.0.0.1:$PORT$1"; }

say "== 3. REST surface"
check "meta reports entities > 100" bash -c "api() { curl -sf http://127.0.0.1:$PORT\$1; }; api /api/intel/meta | python3 -c 'import sys,json; m=json.load(sys.stdin); assert m[\"counts\"][\"entities\"] > 100'"
check "NEM grid summary has live demand" bash -c "curl -sf http://127.0.0.1:$PORT/api/intel/grids/grid:au-nem/summary | python3 -c 'import sys,json; s=json.load(sys.stdin); assert s[\"live\"][\"demand_mw\"] is not None'"
check "Gladstone PS entity + telemetry state" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/entities/gen:au-nem:gladstone-ps' | python3 -c 'import sys,json; e=json.load(sys.stdin); assert e[\"entity\"][\"name\"].startswith(\"Gladstone\"); assert isinstance(e[\"state\"], list)'"
check "bbox query finds Gladstone cluster" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/entities?bbox=150.5,-24.5,151.8,-23.3' | python3 -c 'import sys,json; r=json.load(sys.stdin); ids=[e[\"entity_id\"] for e in r[\"entities\"]]; assert \"smelter:au-qld:boyne-island\" in ids'"
check "graph traversal: what feeds Boyne" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/entities/smelter:au-qld:boyne-island/graph?direction=upstream&depth=2' | python3 -c 'import sys,json; g=json.load(sys.stdin); names=[n[\"entity_id\"] for n in g[\"nodes\"]]; assert \"gen:au-nem:gladstone-ps\" in names'"
check "gap registry served" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/gaps?entity=smelter:au-qld:boyne-island' | python3 -c 'import sys,json; g=json.load(sys.stdin); assert len(g[\"gaps\"]) >= 1'"
check "SDUI composes for Boyne (schema-valid, endpoint-only panels)" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/sdui/smelter:au-qld:boyne-island' | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d[\"entity_id\"] == \"smelter:au-qld:boyne-island\"
assert len(d[\"layout\"]) >= 3
for p in d[\"layout\"]:
    data = p.get(\"data\")
    if data is not None:
        assert data[\"endpoint\"].startswith(\"/api/intel/\")
'"
check "inferences endpoint serves derived class only" bash -c "curl -sf 'http://127.0.0.1:$PORT/api/intel/inferences' | python3 -c 'import sys,json; r=json.load(sys.stdin); assert isinstance(r[\"inferences\"], list)'"
check "404 shape" bash -c "test \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/intel/entities/gen:au-nem:nope)\" = 404"

say "== 4. SSE stream delivers at least one event"
SSE_OUT="$VAR/sse.txt"
curl -sN --max-time 12 "http://127.0.0.1:$PORT/api/intel/stream" >"$SSE_OUT" 2>/dev/null
if grep -qE "^event: (hello|state\.updated|state\.corrected|inference)" "$SSE_OUT" && grep -qE "^event: (state\.updated|state\.corrected|inference)" "$SSE_OUT"; then
  ok "stream produced hello + at least one data event"
else
  bad "stream produced hello + at least one data event"
  head -20 "$SSE_OUT"
fi

say ""
say "smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
