#!/usr/bin/env bash
set -euo pipefail

NS=dsh-poc
UID_=100001
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "== 1. PVC bound =="
kubectl apply -f "$HERE/pvc.yaml" >/dev/null
kubectl wait -n "$NS" --for=jsonpath='{.status.phase}'=Bound pvc/dsh-users --timeout=120s
pass "PVC dsh-users bound (Longhorn RWX)"

echo "== 2. bootstrap (privileged chmod 1777) =="
kubectl apply -f "$HERE/bootstrap-job.yaml" >/dev/null
kubectl wait -n "$NS" --for=condition=complete job/dsh-users-bootstrap --timeout=120s
BOOT_LOG="$(kubectl logs -n "$NS" job/dsh-users-bootstrap)"
echo "$BOOT_LOG"
echo "$BOOT_LOG" | grep -q 'drwxrwxrwt' && pass "PVC root is world-writable+sticky" || fail "bootstrap chmod 1777 did not stick"

echo "== 3. init Job (non-root uid builds 0700 dir) =="
kubectl apply -f "$HERE/init-job.yaml" >/dev/null
kubectl wait -n "$NS" --for=condition=complete job/dsh-u1-init --timeout=120s
INIT_LOG="$(kubectl logs -n "$NS" job/dsh-u1-init)"
echo "$INIT_LOG"
# ls -ldn output: drwx------ 2 100001 100001 ... /mnt/u1
echo "$INIT_LOG" | grep -qE 'drwx------.*100001' && pass "u1 dir is 0700 owned by uid $UID_" || fail "init Job could not create/chown u1 (non-root uid cannot write PVC root)"

echo "== 4. test Pod (subPath + runAsUser read/write) =="
kubectl apply -f "$HERE/test-pod.yaml" >/dev/null
kubectl wait -n "$NS" --for=jsonpath='{.status.phase}'=Succeeded pod/dsh-u1-test --timeout=120s
TEST_LOG="$(kubectl logs -n "$NS" pod/dsh-u1-test)"
echo "$TEST_LOG"
echo "$TEST_LOG" | grep -q '^hello$' && pass "subPath write/read works" || fail "subPath mount read/write failed"
echo "$TEST_LOG" | grep -qE 'drwx------.*100001' && pass "mounted dir is 0700 uid $UID_" || fail "mounted dir owner/perm wrong"

echo
echo "ALL ITEM-1 CHECKS PASSED"
