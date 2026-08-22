# K8s 部署（模式 B）—— 踩坑记录 + 部署流程

> 记录在**阿里云 2C2G 实机**上跑通 k8s 模式 B 时踩到的坑（PoC 实测验证）。
> 本文当前**只记录踩坑**；完整部署流程（helm install 一条龙）待补，见文末 §5。

---

## 1. 环境 / k3s 安装

### 1.1 cgroup v1 导致 k3s v1.36+ kubelet 拒启

- **症状**：k3s v1.36 启动几秒后退出，`systemctl` 反复 auto-restart。日志：
  ```
  Shutdown request received: "kubelet exited: ... kubelet is configured to not run on a host using cgroup v1 ..."
  ```
- **根因**：K8s 1.36 移除了 cgroup v1 支持；阿里云 Linux 3（RHEL8 系）默认跑 cgroup v1。
- **修复（二选一）**：
  - 启用 cgroup v2（改内核参数 + **重启**）：
    ```bash
    grubby --update-kernel=ALL --args="systemd.unified_cgroup_hierarchy=1"
    grubby --info=ALL | grep args      # 确认参数已写入
    reboot
    # 重启后验证
    stat -fc %T /sys/fs/cgroup/        # 输出 cgroup2fs 才对
    ```
  - 或降级 k3s v1.31（还支持 cgroup v1）。

### 1.2 swap 未关

- **症状**：kubelet 起不来（`fail-swap-on` 默认 true）。
- **修复**：
  ```bash
  swapoff -a
  # 持久化（可选）：注释 /etc/fstab 里的 swap 行
  sed -i '/[[:space:]]swap[[:space:]]/s/^/#/' /etc/fstab
  ```

### 1.3 SELinux 依赖缺失（RHEL8 系）

- **症状**：k3s 安装脚本报：
  ```
  nothing provides container-selinux >= 3:2.191.0-1 needed by k3s-selinux-...
  ```
- **修复**：跳过 SELinux RPM（PoC 不需要）：
  ```bash
  curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh | \
    INSTALL_K3S_MIRROR=cn INSTALL_K3S_SKIP_SELINUX_RPM=true sh -s - --disable traefik --disable metrics-server --disable servicelb --disable local-storage
  ```

---

## 2. 镜像源（中国区）

### 2.1 docker hub 被墙

- **症状**：`registry-1.docker.io` 403 / 超时，busybox/node/socat 镜像拉不动。
- **修复**：给 k3s 的 containerd 配国内镜像 `/etc/rancher/k3s/registries.yaml`：
  ```yaml
  mirrors:
    docker.io:
      endpoint:
        - "https://docker.m.daocloud.io"
        - "https://docker.1ms.run"
  ```
  然后 `systemctl restart k3s`。
- **注意**：镜像拉取**极慢**（一个 29MB 镜像拉了 13 分钟），批量拉取要有耐心或换更快的镜像源。

### 2.2 raw.githubusercontent 被墙

- **症状**：`kubectl apply -f https://raw.githubusercontent.com/longhorn/...` 拉不到 manifest。
- **修复**：加 ghproxy 前缀：
  ```bash
  curl -sL "https://ghfast.top/https://raw.githubusercontent.com/longhorn/longhorn/v1.7.2/deploy/longhorn.yaml" -o /tmp/longhorn.yaml
  ```

### 2.3 alpine/socat tag 写错

- **症状**：`alpine/socat:1.8.0.0-r0` 拉取 403。
- **根因**：该 tag 不存在。
- **修复**：用 `alpine/socat:1.8.0.0`（或 `latest`）。
  ⚠️ **方案 docs/k8s.md §4.3 里的 `1.8.0.0-r0` 需改正。**

### 2.4 ghcr.io 直连被墙（CNPG/Longhorn 镜像）

- **症状**：CloudNativePG operator 镜像 `ghcr.io/cloudnative-pg/cloudnative-pg` 卡 "Pulling" 十几分钟不动。
- **修复**：`registries.yaml` 里给 `ghcr.io` 也配镜像：
  ```yaml
  ghcr.io:
    endpoint:
      - "https://ghcr.m.daocloud.io"
  ```

### 2.5 CloudNativePG `poolers` CRD apply 报 annotation 超长

- **症状**：`kubectl apply -f cnpg.yaml` 报 `CRD poolers.postgresql.cnpg.io is invalid: metadata.annotations: Too long`，operator 崩溃 `no matches for kind "Pooler"`。
- **根因**：client-side apply 写的 `last-applied-configuration` annotation 超过 256KB。
- **修复**：`kubectl apply --server-side --force-conflicts -f cnpg.yaml`（server-side 不写那个超长 annotation）。

---

## 3. Longhorn

### 3.1 磁盘保留比例过高

- **症状**：卷副本创建失败 `No available disk candidates`，卷状态 `faulted`。
- **根因**：Longhorn 默认**保留 30% 磁盘**；磁盘 88% 满时「可用 < 保留量」，拒绝调度副本。
- **修复**：把保留/最小可用降到 5%：
  ```bash
  kubectl -n longhorn-system patch settings.longhorn.io storage-reserved-percentage-for-default-disk --type=merge -p '{"value":"5"}'
  kubectl -n longhorn-system patch settings.longhorn.io storage-minimal-available-percentage --type=merge -p '{"value":"5"}'
  ```

### 3.2 iscsid 未启动

- **症状**：卷卡在 `attaching`，消费 Pod 一直 `ContainerCreating`。
- **修复**（装完 `iscsi-initiator-utils` 后记得启动）：
  ```bash
  dnf install -y iscsi-initiator-utils
  systemctl enable --now iscsid
  ```

### 3.3 单节点 3 副本调度不了

- **症状**：2 个副本 `Failed to schedule replica`，卷卡 `attaching`。
- **根因**：Longhorn 默认 **hard anti-affinity**，同一卷的副本必须在不同节点；单节点只能调度 1 个。
- **修复**：副本降到 1：
  ```bash
  kubectl -n longhorn-system patch volumes.longhorn.io <volume-name> --type=merge -p '{"spec":{"numberOfReplicas":1}}'
  kubectl -n longhorn-system patch settings.longhorn.io default-replica-count --type=merge -p '{"value":"1"}'
  ```

### 3.4 RWX 卷需 nfs-utils

- **症状**：RWX 卷挂载失败（RWX 走 share-manager / NFS ganesha）。
- **修复**：装 `nfs-utils`（提供 `mount.nfs`）：
  ```bash
  dnf install -y nfs-utils
  ```

### 3.5 内存预算（重要）

- Longhorn 自身 ~600M。**2C2G 上 k3s + Longhorn 已占 ~1.4G**，无法再跑 CloudNativePG 3 实例（需 ~1.5G）。
- **PoC item 4（CNPG + pgbench）需 ≥4G 机器**，2G 必 OOM。

---

## 4. 方案修正（PoC 实测推翻/修正的结论）

### 4.1 flannel 实际强制 NetworkPolicy（§3.5 修正）

- 实测 k3s v1.31 flannel 下 NetworkPolicy **开箱即用**（k3s 内嵌 kube-router netpol 控制器，不再以 DaemonSet 形式；attacker 被拒，删策略后立刻恢复连通）。
- **§3.5「k3s 默认 flannel 不强制」不成立**。
- Cilium 的选型理由应改为：**L7 策略 / eBPF 性能 / Hubble 可观测**（这些 kube-router 没有），而不是「基础强制」。

### 4.2 gid ≠ fsGroup（§6.0 措辞）

- 实测 init Job 建目录 `0700` 属主 uid 正确，但 **gid=0**（不是 fsGroup=100001）——因 §4.3 的 Pod 只设 `runAsUser`+`fsGroup`、没设 `runAsGroup`，进程默认 gid=0。
- **不影响 0700 安全边界**（0700 已把 group 权限关成 `---`）。若要对齐 gid，需加 `runAsGroup:<uid>`。

### 4.3 socat tag（§4.3 修正）

- `alpine/socat:1.8.0.0-r0` → `alpine/socat:1.8.0.0`。见 §2.3。

---

## 5. 完整部署流程（待补）

> 晚上补全：k3s HA 搭建 → Longhorn → Cilium → CloudNativePG → cert-manager → Helm chart `helm install dsh ./charts/dsh-server-login`。

---

## 6. PoC 实测基线（item 4：CNPG on Longhorn）

**机器**：阿里云 4C16G，Ubuntu 24.04，SSD 40G。k3s v1.31 + Longhorn v1.7.2（副本 1）+ CNPG v1.24.1，3 实例 healthy。

**pgbench（scale 5，30s，4 clients / 2 threads）**：

| 负载 | tps | latency average | 说明 |
|---|---|---|---|
| select-only（`-S`） | 19164.7 | 0.209 ms | 纯读，数据 ~70MB 全进内存缓冲，未打到磁盘 |
| TPC-B 混合（含写） | 705.3 | 5.671 ms | 写落到 Longhorn 磁盘，**这才是 I/O 基线** |

**结论**：CNPG on Longhorn 跑通（3 实例、pgbench 正常）。写路径 latency ~5.6ms / tps ~705，是 Longhorn 单副本的 I/O 成本。要对照「节点本地 NVMe + PG 主备」判断是否可接受，需换 NVMe 盘 + 更大 scale（让数据集超过内存）再压一次。

**另：pgbench 手动跑法**（`kubectl run --rm -i` 在后台/非 tty 会话会卡 stdin，别用）：
```bash
kubectl run pgbench-init --restart=Never --image=postgres:16 -n <ns> \
  --env PGHOST=<cluster>-rw --env PGUSER=dsh --env PGPASSWORD=<pw> --env PGDATABASE=dsh \
  -- pgbench -i -s 5
# 等 pod phase=Succeeded 后 kubectl logs；跑完 kubectl delete pod
```
