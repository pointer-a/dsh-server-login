#!/usr/bin/env bash
set -euo pipefail

NS=dsh-poc
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f "$HERE/cluster.yaml" >/dev/null

echo "== wait for CloudNativePG cluster ready (3 instances) =="
READY=0
for _ in $(seq 1 72); do
  READY="$(kubectl get -n "$NS" cluster dsh-pg-poc -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo 0)"
  [ "$READY" = "3" ] && break
  sleep 5
done
if [ "$READY" != "3" ]; then
  echo "FAIL: cluster not ready in time (readyInstances=$READY)"
  kubectl get -n "$NS" cluster dsh-pg-poc -o yaml
  exit 1
fi
echo "PASS: cluster ready (3 instances)"

PGHOST=dsh-pg-poc-rw
PGUSER="$(kubectl get -n "$NS" secret dsh-pg-poc-app -o jsonpath='{.data.username}' | base64 -d)"
PGPASSWORD="$(kubectl get -n "$NS" secret dsh-pg-poc-app -o jsonpath='{.data.password}' | base64 -d)"
PGDATABASE="$(kubectl get -n "$NS" secret dsh-pg-poc-app -o jsonpath='{.data.dbname}' | base64 -d)"

echo "== pgbench init (scale 5) =="
kubectl run -n "$NS" pgbench-init --rm -i --restart=Never --image=postgres:16 \
  --env "PGHOST=$PGHOST" --env "PGUSER=$PGUSER" --env "PGPASSWORD=$PGPASSWORD" --env "PGDATABASE=$PGDATABASE" \
  -- pgbench -i -s 5 2>&1 | tail -3

echo
echo "== pgbench select-only (30s, c4/j2) =="
kubectl run -n "$NS" pgbench-run --rm -i --restart=Never --image=postgres:16 \
  --env "PGHOST=$PGHOST" --env "PGUSER=$PGUSER" --env "PGPASSWORD=$PGPASSWORD" --env "PGDATABASE=$PGDATABASE" \
  -- pgbench -S -T 30 -c 4 -j 2 2>&1 | grep -E 'latency average|including connections establishing' || true

echo
echo "记录上面的 tps / latency average 作为 Longhorn 上的基线（对照节点 NVMe 判断 §4.5 是否可接受）"
