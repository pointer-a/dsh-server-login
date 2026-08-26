# K8s 部署教程（模式 B）— DSH 服务端登录插件

> 🧭 [← 返回 README](../README.md) · 卡住了：[踩坑记录](k8s-deploy.md) · 模式 A 教程：[deployment](deployment.md)

> 把 `dsh-server-login` 部署成**多机 HA、每用户独立 Pod** 的形态。本文是**可复制的分步部署教程**；
> 实机逐条踩坑与根因排查见 [k8s-deploy.md](k8s-deploy.md)。
>
> 实测环境：阿里云 ACK 智能托管（华东2）+ CNFS(NAS) + CloudNativePG + 私有 ACR。

---

## 0. 前置条件

- 一个 **ACK 智能托管集群**（网络插件 DataPath V2 / 勾选 NetworkPolicy；节点 ≥ 3 或启用自动扩容）。
- 一个 **NAS 文件系统**，并在集群里建 **CNFS**（控制台「容器网络文件系统」，名字记为 `nas`）。
- 一个 **私有 ACR 仓库**（本文用 `registry.example.com/dsh` 作占位）。
- 一个域名（本文用 `dsh.example.com` 作占位）+ 通配 TLS 证书（cert-manager 或 LB 证书）。

已安装：`kubectl`、`cnpg` operator（`kubectl apply --server-side -f cnpg.yaml`）。

---

## 1. 镜像

两种方式二选一：

- **CI（推荐）**：推代码到 master，GitHub Actions 自动 build + Trivy + push 两个镜像到 ACR。
- **手动**：
  ```sh
  docker build -t <acr>/dsh-server-login:0.2.0 .
  docker build -t <acr>/dsh:0.1.1-rc.2 -f Dockerfile.dsh .
  docker push <acr>/dsh-server-login:0.2.0
  docker push <acr>/dsh:0.1.1-rc.2
  ```

---

## 2. Namespace + Postgres

```sh
kubectl apply -f deploy/00-namespace.yaml
kubectl apply -f deploy/01-dsh-pg.yaml
# 等 healthy：
kubectl -n dsh wait --for=condition=Ready cluster/dsh-pg --timeout=600s
```

读连接串（后面建 `dsh-pg` secret 用）：

```sh
kubectl -n dsh get secret dsh-pg-app -o jsonpath='{.data.uri}' | base64 -d
# postgresql://dsh:<password>@dsh-pg-rw.dsh:5432/dsh
```

---

## 3. Secrets（含动态值，不进 YAML）

```sh
# ① ACR 拉镜像凭证（生成 Pod 拉私有镜像用）
kubectl -n dsh create secret docker-registry dsh-acr-pull \
  --docker-server=registry.example.com \
  --docker-username='<ACR_USERNAME>' --docker-password='<ACR_PASSWORD>'

# ② 共享加密密钥（迁移时填旧 dataRoot/secret.key 内容，否则已加密的 API key 解不开）
kubectl -n dsh create secret generic dsh-secret --from-literal=key='<32字节hex>'

# ③ Postgres DSN（用 §2 读到的 uri）
kubectl -n dsh create secret generic dsh-pg --from-literal=url='postgresql://dsh:...@dsh-pg-rw.dsh:5432/dsh'
```

---

## 4. RBAC + 控制面

```sh
kubectl apply -f deploy/03-rbac.yaml      # SA + Role（含 leases + list/watch，leader election 需要）
kubectl apply -f deploy/02-control-plane.yaml
kubectl -n dsh rollout status deploy/dsh-orchestrator --timeout=300s
```

初始化管理员：

```sh
kubectl -n dsh exec deploy/dsh-orchestrator -- node lib/cli.js bootstrap-admin --username admin --password '<强密码>'
```

> 控制面 3 副本，只有 leader 跑 reconcile（Lease 选主）。`deploy/02-control-plane.yaml` 里把
> `DSH_SERVER_LOGIN_BASE_DOMAIN` / `DSH_SERVER_LOGIN_COOKIE_DOMAIN` / 镜像地址改成你自己的。

---

## 5. 存储：NAS(CNFS) + PVC + bootstrap + PSA（严格时序）

> ⚠️ **顺序不能乱**：先建 PVC → 特权 bootstrap `chmod 1777` → 最后打 PSA restricted。先打 PSA，
> 非 root 的 initContainer 就写不了 PVC 根，用户目录永远建不出来。

```sh
# ① StorageClass（引用控制台建好的 CNFS `nas`）
kubectl apply -f deploy/05-storage.yaml
# ② 每用户共享 RWX PVC
kubectl apply -f deploy/04-pvc.yaml
kubectl -n dsh wait --for=jsonpath='{.status.phase}=Bound' pvc/dsh-users --timeout=300s
# ③ 特权 bootstrap：PVC 根 chmod 1777（world-writable + sticky）
kubectl apply -f deploy/08-bootstrap.yaml
kubectl -n dsh wait --for=condition=complete job/dsh-users-bootstrap --timeout=180s
# ④ 打 PSA restricted（放在最后）
kubectl apply -f deploy/07-psa.yaml
# ⑤ 配额（防单用户耗尽集群）
kubectl apply -f deploy/06-quota.yaml
```

---

## 6. 入口（域名 + TLS）

- 暴露控制面：给 `dsh-orchestrator` 加一个 **LoadBalancer Service**（`port 80 → targetPort 3080`），
  或用 **Ingress**（Traefik / nginx-ingress）统一入口。
- DNS：把 `dsh.example.com` 与 `*.dsh.example.com` 解析到 LB 的 IP（或 Ingress 域名）。
- TLS：cert-manager 签通配证书（DNS-01），或直接用 LB/ALB 的证书。
- ⚠️ 域名经阿里云公网 SLB/ALB 暴露时需先做 **ICP 备案**，否则 80/443 会被备案校验拦（403）。

LoadBalancer Service 参考：

```yaml
apiVersion: v1
kind: Service
metadata: { name: dsh-orchestrator-lb, namespace: dsh }
spec:
  type: LoadBalancer
  selector: { app: dsh-orchestrator }
  ports: [{ port: 80, targetPort: 3080 }]
```

---

## 7. 验收清单

1. `kubectl -n dsh get pods`：`dsh-orchestrator` 3/3、`dsh-pg-1` 1/1、`dsh-files-*`/`dsh-*`（按需出现）。
2. leader 单活：`kubectl -n dsh get lease dsh-orchestrator` holder 非空、`leaseTransitions` 随接管递增。
3. 域名全链路：注册 → 管理员审核 → 登录 → 桌面 tree/建文件夹/上传 → 启动 DSH → `https://<user>.dsh.example.com/` 200。
4. 模型请求：DSH 里配 key 后能解析并访问 `api.deepseek.com`（DNS + 443 出站通）。
5. 隔离：任意非控制面 Pod 访问某用户 DSH 的 8081/8082 被 NetworkPolicy 拒。

---

## 8. 配置参考（控制面 env）

| env | 默认 | 说明 |
|---|---|---|
| `DSH_SERVER_LOGIN_DEPLOY_MODE` | `local` | `k8s` 启用每用户 Pod |
| `DSH_SERVER_LOGIN_DB_URL` | 空 | Postgres DSN（k8s 必填） |
| `DSH_SERVER_LOGIN_SECRET` | 空 | 共享加密密钥 |
| `DSH_SERVER_LOGIN_NAMESPACE` | `dsh` | 每用户资源命名空间 |
| `DSH_SERVER_LOGIN_DSH_IMAGE` | 空 | 每用户 DSH 镜像 |
| `DSH_SERVER_LOGIN_CONTROL_PLANE_IMAGE` | 空 | file sidecar / tcp-bridge 镜像 |
| `DSH_SERVER_LOGIN_IMAGE_PULL_SECRET` | `dsh-acr-pull` | 生成 Pod 的拉镜像 secret |
| `DSH_SERVER_LOGIN_BASE_DOMAIN` | 空 | 子域路由基域 |
| `DSH_SERVER_LOGIN_COOKIE_DOMAIN` | 空 | cookie `Domain` |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | `false` | HTTPS 设 `true` |
| `DSH_SERVER_LOGIN_EGRESS_CIDRS` | 空 | 443 出站白名单（空=0.0.0.0/0） |

---

## 9. 常见问题 → [k8s-deploy.md](k8s-deploy.md)

- 部署顺序、NAS/CNFS、uid 错位、就绪探针、代理端口、leader 接管、DNS、备案、keepAlive 502 等全部踩坑与根因已记录在 `k8s-deploy.md` §5–§8。
