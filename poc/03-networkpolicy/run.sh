#!/usr/bin/env bash
set -euo pipefail

NS=dsh-poc
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create configmap dsh-target-script --from-file="$HERE/target.mjs" -n "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "== apply pods =="
kubectl apply -f "$HERE/pods.yaml" >/dev/null
kubectl wait -n "$NS" --for=condition=Ready pod/dsh-target --timeout=120s
kubectl wait -n "$NS" --for=condition=Ready pod/controlplane --timeout=120s
kubectl wait -n "$NS" --for=condition=Ready pod/attacker --timeout=120s

echo "== apply NetworkPolicy (default-deny + allow control-plane) =="
kubectl apply -f "$HERE/default-deny.yaml" >/dev/null
kubectl apply -f "$HERE/allow-controlplane.yaml" >/dev/null
sleep 2

IP="$(kubectl get -n "$NS" pod dsh-target -o jsonpath='{.status.podIP}')"
URL="http://$IP:8081/"
echo "target pod IP: $IP"

echo "== control-plane -> dsh (must succeed) =="
if kubectl exec -n "$NS" controlplane -- wget -q -T 5 -O- "$URL" 2>/dev/null | grep -q 'dsh-ok'; then
  pass "control-plane reaches dsh:8081"
else
  fail "control-plane could NOT reach dsh:8081 (policy or CNI not enforced as expected)"
fi

echo "== attacker -> dsh (must be blocked) =="
if kubectl exec -n "$NS" attacker -- wget -q -T 5 -O- "$URL" >/dev/null 2>&1; then
  fail "attacker reached dsh:8081 — NetworkPolicy NOT enforced (flannel? check CNI)"
else
  pass "attacker is blocked from dsh:8081 (default-deny enforced)"
fi

echo
echo "ALL ITEM-3 CHECKS PASSED"
