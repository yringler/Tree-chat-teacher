#!/usr/bin/env bash
# Smoke test against a running `wrangler dev` (DEV_ALLOW_NO_AUTH=true, fake provider).
# Usage: scripts/smoke.sh [base-url]
set -euo pipefail
BASE="${1:-http://localhost:8787}"
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "→ create tree"
TREE=$(curl -fsS -X POST "$BASE/api/trees" -H 'Content-Type: application/json' \
  -d '{"title":"Smoke test","providerId":"fake"}')
TREE_ID=$(echo "$TREE" | json "d['tree']['id']")
TRUNK=$(echo "$TREE" | json "d['tree']['trunkBranchId']")

echo "→ send (SSE)"
STREAM=$(curl -fsS -N -X POST "$BASE/api/branches/$TRUNK/messages" -H 'Content-Type: application/json' \
  -d '{"content":"Hello from smoke.sh"}')
echo "$STREAM" | grep -q '^event: done' || { echo "no done event"; echo "$STREAM"; exit 1; }
ASSISTANT=$(echo "$STREAM" | grep '^data:' | head -1 | sed 's/^data: //' | json "d['assistantNode']['id']")

echo "→ branch (summary) + send"
BRANCH=$(curl -fsS -X POST "$BASE/api/branches" -H 'Content-Type: application/json' \
  -d "{\"fromNodeId\":\"$ASSISTANT\",\"contextMode\":\"summary\",\"anchorQuote\":\"smoke\"}" | json "d['id']")
curl -fsS -N -X POST "$BASE/api/branches/$BRANCH/messages" -H 'Content-Type: application/json' \
  -d '{"content":"side question"}' | grep -q '^event: done'

echo "→ context plan"
curl -fsS "$BASE/api/branches/$BRANCH/context" | json "[s['kind'] for s in d['plan']['segments']]"

echo "→ share + public view"
SHARE=$(curl -fsS -X POST "$BASE/api/shares" -H 'Content-Type: application/json' -d "{\"treeId\":\"$TREE_ID\",\"scope\":\"tree\"}")
TOKEN=$(echo "$SHARE" | json "d['token']")
SHARE_ID=$(echo "$SHARE" | json "d['id']")
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/$TOKEN")" = 200
curl -fsS "$BASE/s/$TOKEN/data.json" | grep -q 'Hello from smoke.sh'

echo "→ revoke"
curl -fsS -X POST "$BASE/api/shares/$SHARE_ID/revoke" >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/$TOKEN")" = 410

echo "→ export"
curl -fsS "$BASE/api/export?treeId=$TREE_ID&format=md" | grep -q '# Smoke test'

echo "✓ smoke test passed"
