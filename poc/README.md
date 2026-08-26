# Phase 3 核心路径 PoC（不写业务代码）

> 🧭 [← 返回 README](../README.md) · 结论落地为：[K8s 部署教程](../docs/k8s-deployment.md)

> 对应内部设计稿 §7 的四项风险验证。**不引入任何业务代码**——全部用一次性
> 镜像（busybox / node / socat / CloudNativePG）验证基础设施假设。四项全部通过，
> 才允许进入 Phase 0 镜像化 / Phase 2/3 落地，避免 Phase 3 返工。

## 前置条件

- 一个 k3s 集群（`k3s --cluster-init` 3 server + N worker 皆可，单机 k3s 也能跑 PoC）。
- 已装且健康：
  - **Longhorn**（item 1、4 依赖；item 1 是硬前提，必须 `longhorn.io` StorageClass 可用）
  - **Cilium**（item 3 依赖；NetworkPolicy 必须被强制）
  - **CloudNativePG** operator（item 4 依赖）
  - **cert-manager / MetalLB / kube-vip** 与本 PoC 无关，暂不需要
- `kubectl` 指向该集群（`kubectl get nodes` 有输出）。
- 本地有 `bash` + `curl`（item 2/3 用）；item 2 的 WS 客户端用 `node`（本机或容器内均可）。

```sh
kubectl get nodes
kubectl get storageclass longhorn        # item 1/4 前提
kubectl get pods -n kube-system -o wide | grep -E 'cilium|longhorn|csi'
kubectl get crd clusters.postgresql.cnpg.io  # item 4 前提
```

---

## Item 1 — Longhorn RWX + subPath + runAsUser/fsGroup（§4.9 / §6.0 的 PoC）

**验证的未知点**：`fsGroup` 是否会 chown subPath 叶子？非 root 目标 uid 能否在 PVC
根建目录、`0700` 属主是否正确、子目录挂载后能否读写。

> ⚠️ 这是 `docs/k8s.md` §4.9 标明的「PoC 第一项必须验证」。若失败，按 §4.9 的
> 回退：bootstrap 阶段用特权 Job 完成 `chmod 1777`（在启 PSA restricted **之前**），
> 时序固定为「初始化 PVC → 启 PSA → 允许用户 Pod」。

```sh
cd 01-longhorn-subpath
./run.sh
```

**通过标准**（脚本自动断言）：

1. bootstrap Job（特权）`chmod 1777 /mnt` 成功。
2. init Job（非 root，`runAsUser/fsGroup = 100001`）能 `mkdir -p /mnt/u1/{ws,home}` 且
   `chmod 0700 /mnt/u1` 成功——即**非 root uid 能写 PVC 根**（`chmod 1777` 生效）。
3. 测试 Pod（`runAsUser=100001`，`subPath: u1`）能写/读文件，且 `stat` 显示目录属主
   uid=100001、权限 0700。
4. （可选）另一个 uid（100002）无法读该目录——`subPath` 叶子 + DAC 的越权边界。

---

## Item 2 — socat 桥 WebSocket 透明转发（§3.2 / §4.3）

**验证的未知点**：DSH 只监听 loopback，`socat TCP-LISTEN:8081 → 127.0.0.1:8080` 的纯
TCP 转发对 WebSocket Upgrade 是否透明。

```sh
cd 02-socat-ws
./run.sh
```

**通过标准**：

1. 通过 sidecar 的 8081 能拿到 fake-dsh 的 HTTP 200（TCP 基础通）。
2. WebSocket Upgrade 握手经 8081 返回 `101 Switching Protocols`，且
   `Sec-WebSocket-Accept` 校验正确（证明 Upgrade 请求与响应都原样穿透 socat）。
3. 一条文本帧 echo 往返成功（双向透明）。

> 若 2/3 不透明，回退：换 `nginx`/`netcat` sidecar（同端口转发），见 §9。

---

## Item 3 — NetworkPolicy 默认拒绝 + 控制面→DSH 单向（§3.5 / §4.4）

**验证的未知点**：Cilium 是否强制 NetworkPolicy；default-deny 下「仅控制面可达 DSH
8081」的单向放行是否正确，跨来源访问被拒。

```sh
cd 03-networkpolicy
./run.sh
```

**通过标准**：

1. 同 namespace 内打了 `app=dsh-orchestrator` 的「控制面」Pod 能连通 DSH 8081。
2. 同 namespace 内**其它** Pod（`app=attacker`）访问 DSH 8081 **被拒**（超时/拒绝）。
3. 这也覆盖 §3.5 的「每次 NetworkPolicy 变更后跑自动化验证」——本脚本即该验证的雏形。

> 若 flannel（k3s 默认）下 2 仍通，说明 CNI 未强制策略，必须切 Cilium（§11.2）。

---

## Item 4 — CloudNativePG on Longhorn 的 pgbench 基线（§4.5）

**验证的未知点**：Postgres 对延迟/IOPS 敏感，Longhorn RWO 复制是否拖慢同步复制，
延迟是否可接受。

```sh
cd 04-cnpg-pgbench
./run.sh
```

**通过标准**（人工判读，无固定阈值，取决于硬件）：

1. CloudNativePG 3 实例主备建立、`Ready`。
2. `pgbench -S`（select-only）tps 与延迟与本机 NVMe 基线对比，落在可接受区间。
   §4.5 结论：不够则回退「节点本地 NVMe + PG 主备」。

---

## 通过后

四项全过 → 记录结果（tps/latency 数字、Longhorn 权限行为结论）到本 README 尾部，
再进入 Phase 0（镜像化）。任一项失败 → 按对应 §9 回退方案调整后重跑。
