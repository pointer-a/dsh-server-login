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

## 5. 完整部署流程（ACK 实跑记录，2026-08-23）

> 在阿里云 **ACK 智能托管模式** 上跑通控制面 Phase 2 的完整步骤。k8s 方案里的
> 「3 server HA / kube-vip / MetalLB / Cilium」在 ACK 上由托管能力替代（§5.5 映射）。
> 每用户 DSH Pod（Phase 3）、cert-manager、Helm chart 尚未落地，仍待补。

### 5.1 集群与基础组件

1. 建 ACK 集群（智能托管模式）：**网络插件 DataPath V2（eBPF）+ 勾选 NetworkPolicy**；服务转发模式 IPVS。
2. 装 CNPG operator：manifest 用 ghproxy 下载（§2.2），`kubectl apply --server-side --force-conflicts`（§2.5 annotation 超长坑）。
3. **ghcr.io 换源**：CNPG operator 与 Postgres 镜像在阿里云拉不动（§2.4），换 `ghcr.m.daocloud.io`。

### 5.2 部署步骤

1. `kubectl apply -f deploy/00-namespace.yaml`
2. `kubectl apply -f deploy/01-dsh-pg.yaml`（Postgres 集群；storageClass 用拓扑感知 `alicloud-disk-topology-alltype`，size ≥20GiB）
3. 等 `dsh-pg` 进入 `Cluster in healthy state`；读连接串：
   `kubectl -n dsh get secret dsh-pg-app -o jsonpath='{.data.uri}' | base64 -d`
4. 推镜像到 ACR：CI master push 自动推（需 `ACR_USERNAME`/`ACR_PASSWORD` secret），或 workflow_dispatch。
5. 建三个 secret（不在 deploy/ YAML 里，因含动态值）：
   - `dsh-acr-pull`（`docker-registry` 类型，ACR 凭证）
   - `dsh-secret`（共享加密密钥，`key`）
   - `dsh-pg`（`url` = 上面读到的 URI）
6. `kubectl apply -f deploy/02-control-plane.yaml`
7. bootstrap admin：`kubectl -n dsh exec deploy/dsh-orchestrator -- node lib/cli.js bootstrap-admin --username admin --password '<p>'`
8. 按 §5.3 验收。

### 5.3 验收清单（Phase 2）

- 注册 → 审核 → 登录 → 管理台/域名 API 全通。
- 访问控制：普通用户访问管理台 403、域名 API 200。
- kill 一个控制面副本 → Deployment 自动重建（3/3）、Service 不中断。
- 数据在 Postgres，删副本/重启不丢。

### 5.4 踩坑记录（ACK 实测新增）

| 坑 | 修复 |
|---|---|
| ghcr.io 被墙：CNPG operator / Postgres 镜像拉不动 | 换 `ghcr.m.daocloud.io`（§2.4） |
| ESSD 最小 20GiB：`size: 10Gi` 报 `less than minimum 20GiB` | storage `size: 20Gi` |
| CNPG 重建集群密码漂移：`dsh-pg-app` 重新生成密码 | 读最新 URI 重建 `dsh-pg` secret；生产用固定密码 |
| 控制面启动依赖 Postgres 就绪：ECONNREFUSED 崩 | 等 Postgres healthy 再部署，或接受 CrashLoopBackOff 重试 |
| Auto Mode 节点有 taint，CNPG pod 调度失败 | GOATScaler 自动扩出无 taint 节点 |

### 5.5 ACK 与 k8s 方案的映射

| k8s.md 定案 | ACK 等价 |
|---|---|
| 3 server HA + kube-vip | 托管控制面（免费） |
| MetalLB（L2 ARP 云上不生效） | SLB / ALB |
| Cilium | Terway DataPath V2（eBPF + NetworkPolicy） |
| Longhorn RWX / RWO | NAS / ESSD 云盘 |
| CloudNativePG | CloudNativePG（自建）或 RDS PG 高可用版 |

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

---

## 7. Phase 3 集群联调踩坑（2026-08-23，第二阶段）

> 控制面 `deployMode=k8s` + leader election + file sidecar + 每用户 Pod 在 ACK
> 上联调的实跑记录。前一个阶段（§5）只把控制面 3 副本 + CNPG 跑通了。

### 7.1 部署顺序（缺一步就挂，按序执行）

1. `deploy/00-namespace.yaml` → `01-dsh-pg.yaml`（Postgres healthy）→ 读 `dsh-pg-app` URI 建 `dsh-pg`/`dsh-secret`/`dsh-acr-pull` secret。
2. **`deploy/03-rbac.yaml`**（SA + Role + lease 权限）。漏了它，控制面 Deployment 报
   `FailedCreate: serviceaccount "dsh-orchestrator" not found`，滚动更新卡死。
3. `deploy/02-control-plane.yaml`（含 `imagePullPolicy: Always`，同名 tag 否则节点
   缓存旧镜像）。
4. NAS：控制台建 **CNFS**（容器网络文件系统）→ 应用 `deploy/05-storage.yaml` 引 CNFS
   → `04-pvc.yaml` → `08-bootstrap.yaml`（chmod 1777 PVC 根）→ **最后** `07-psa.yaml`。
5. 每用户 Pod 依赖 `dsh-acr-pull`（§7.3）。

### 7.2 NAS：用 CNFS，别手写 `server` 参数

- 手写 `alicloud-nas` StorageClass 的 `server` 必须是**挂载目标域 + `:/`**，且
  **不含 FileSystemId 前缀**。我给错成 `ap-24w40hkvbc.030l...cn-shanghai.nas.aliyuncs.com`
  （带 FSID 前缀）→ provisioner 报 `CreateDir: IllegalCharacters`；去掉 `ap-24w40hkvbc.`
  后 PVC 才 Bound。
- 但挂载目标还会变（`-wkc31` → `-tjn95`），正确姿势是控制台建 **CNFS**
  （`storage.alibabacloud.com/v1beta1 ContainerNetworkFileSystem`），StorageClass 用
  `containerNetworkFileSystem: nas` 参数引用，provisioner 自动拿到当前挂载目标。
- bootstrap Job 第一次卡 `ContainerCreating` 无事件 = NFS 挂载挂起（挂载目标错/VPC 不通）；
  目标对了会报 `mount.nfs: Connection reset by peer`（通常是安全组/访问组或目标刚就绪）。

### 7.3 每用户 Pod 镜像拉取

- 控制面镜像在**私有 ACR**，生成的 files Pod / DSH Pod / watchdog Job **必须带
  `imagePullSecrets: [dsh-acr-pull]`**——控制面 Deployment 有，但生成的 Pod 不继承。
  漏了就是 `Init:ImagePullBackOff insufficient_scope`。代码里 config `imagePullSecret`
  默认 `dsh-acr-pull`，已在 K8sSpawner 生成的三类 Pod/Job 全部带上。
- bootstrap Job 也需 `imagePullSecrets` + 用控制面镜像（busybox 从 docker.io 拉不动）。

### 7.4 域名入口被阿里云备案拦截

- 腾讯云入口机 nginx 反代到 ACK 公网 SLB（`8.153.12.52`）时，`Host: dsh.xulei1112.cloud`
  被阿里云返回 `403 Non-compliance ICP Filing`（`Server: Beaver`）——域名在腾讯云备案、
  未在阿里云备案，走阿里云公网 SLB 的 80/443 被备案校验拦。直连 SLB IP（不带域名 Host）
  则 200 正常。
- 解法：给域名在阿里云做 ICP 备案，或入口走 NodePort/专线绕开公网 SLB 备案层，或
  控制面域名解析子域改用「SLB 直连 + 腾讯云 nginx 透传 Host」之外的方案（待定）。
