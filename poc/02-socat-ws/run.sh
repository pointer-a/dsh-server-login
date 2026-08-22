#!/usr/bin/env bash
set -euo pipefail

NS=dsh-poc
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create configmap fake-dsh --from-file="$HERE/fake-dsh.mjs" -n "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f "$HERE/pod.yaml" >/dev/null
kubectl wait -n "$NS" --for=condition=Ready pod/dsh-ws-test --timeout=120s

kubectl port-forward -n "$NS" pod/dsh-ws-test 18081:8081 >/tmp/dsh-poc-pf.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
sleep 3

echo "== HTTP through socat (8081 -> 8080) =="
RESP="$(curl -s --max-time 5 http://127.0.0.1:18081/)"
echo "$RESP"
echo "$RESP" | grep -q 'fake-dsh' && pass "HTTP reaches fake-dsh through socat" || fail "HTTP did not reach fake-dsh"

echo "== WebSocket through socat =="
node "$HERE/ws-client.mjs" 127.0.0.1:18081

echo
echo "ALL ITEM-2 CHECKS PASSED"
