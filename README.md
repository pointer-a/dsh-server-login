# dsh-server-login

[![build](https://github.com/pointer-a/dsh-server-login/actions/workflows/build.yml/badge.svg)](https://github.com/pointer-a/dsh-server-login/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**面向公网的多租户 DSH 托管平台** —— 部署到一台公网服务器后，多个用户注册并经管理员审核，各自获得一套**相互隔离**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）环境，随时通过域名安全访问（已适配手机端）。

> 以 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的 cordis-plugin 形态分发，遵守 [STANDARD.md](STANDARD.md)。

## 它解决什么

DSH 本身是单用户本地工具：没有认证、没有多租户隔离、Web 远程访问缺认证层。`dsh-server-login` 在其之上补一层**服务端登录 + 多租户编排**：

```
用户浏览器
   │ HTTPS
   ▼
nginx（TLS 终结，主域 + *.子域 通配）
   ▼
编排服务 dsh-server-login（Fastify，单进程）
   ├─ 认证 / 审核 / 管理台 / 网页桌面 / 域名 API
   └─ 按 Host 或 /u/<userId>/dsh/* 路由
        └─ 反向代理 → 各用户的 DSH 子进程（只绑 127.0.0.1 动态端口，不出公网）
```

流程：管理员审核注册用户 → 每个用户落到自己的文件桌面 → 按文件夹启动 DSH → 通过域名访问，彼此文件隔离。

## 核心能力

| 能力 | 说明 |
|---|---|
| **登录与审核** | `bootstrap-admin` 创建首个管理员；注册后需审核通过才能登录；禁用用户会同时删除其会话并停止运行中的 DSH |
| **每用户隔离 DSH** | 主 DSH 常驻对外服务；崩溃时**按需拉起一次守护 DSH** 修复并自动重启主实例 |
| **网页桌面** | 文件浏览 / 新建 / 上传；按文件夹启动 DSH；所有路径经「词法包含 + 符号链接分量」双重围栏校验 |
| **每文件夹插件** | 自动检测该用户 profile 已安装的插件，按文件夹勾选启用，持久化并注入 cordis patch |
| **多形态访问** | 默认子路径 `/u/<userId>/dsh/`；每用户子域名 `<用户名>.<baseDomain>`（HTTP + WebSocket）；自定义域名 + nginx `server {}` 生成接口 |
| **凭据隔离** | 每用户命名 API 密钥库，AES-256-GCM 加密落库（references-not-secrets）；换 key 自动重建实例；spawn 只注入当前启用的 key |

## 部署形态（二选一）

同一套代码，靠 `DSH_SERVER_LOGIN_DEPLOY_MODE` 切换：

| | 模式 A：直接部署（单服务器） | 模式 B：K8s + 容器化 |
|---|---|---|
| 形态 | 单机裸机，`child_process` + setuid/iptables | 多机 ACK，每用户独立 Pod |
| 数据 | SQLite（本机文件） | PostgreSQL（CloudNativePG） |
| 隔离 | 软隔离 / OS 账号硬隔离 | Pod 网络 + SecurityContext + NetworkPolicy |
| 弹性/HA | 无（单点） | 控制面 3 副本 + leader election，DSH Pod 自动重建 |
| 交付 | `git clone` + 脚本 | `kubectl apply -f deploy/` |

模式 B 已完整落地（Phase 0–4）：每用户 DSH Pod（dsh + tcp-bridge sidecar）+ file sidecar（8082）+ Headless Service + NetworkPolicy；控制面 3 副本 + Lease 选主 + reconcile + 崩溃接管；NAS(CNFS) 共享卷 + PSA restricted + ResourceQuota。见 [K8s 部署教程](docs/k8s-deployment.md) 与 [踩坑记录](docs/k8s-deploy.md)。

## 快速开始（模式 A）

前置：Linux 服务器、Node **^22.19 或 ≥24**、已安装 DSH CLI（`npm i -g @deepseek-ai/dsh`）。完整的生产流程（systemd / DNS / 通配证书 / nginx）见[部署教程](docs/deployment.md)。

```sh
git clone https://github.com/pointer-a/dsh-server-login.git
cd dsh-server-login
npm install && npm run build            # tsc → lib/

# 1) 创建首个管理员（用它登录管理台）
node lib/cli.js bootstrap-admin --username admin --password '<强密码>' --db ./dev.local.db

# 2) 启动编排服务
node lib/cli.js --port 3080 --db ./dev.local.db
```

打开 `http://127.0.0.1:3080/`：

1. 用 admin 登录进入管理台；
2. 另开浏览器注册一个普通用户 → 回管理台点「通过」；
3. 该用户重新登录进入桌面 → 上传文件 / 建文件夹 → 点「在此文件夹启动 DSH」；
4. 首次使用在桌面的「管理密钥」里填入自己的 DeepSeek API Key（加密存储；未设置时 DSH 能启动但无法调用模型）。

> ⚠️ 本地试跑可以验证登录 / 审核 / 桌面 / 启动全链路；但要**打开 DSH 聊天界面**，需要配置域名与每用户子域名（`BASE_DOMAIN` + `COOKIE_DOMAIN` + nginx 通配，见[部署教程](docs/deployment.md)第 6–9 步）——DSH 的 SPA 使用绝对路径，纯子路径方式加载不了静态资源。

## 配置

环境变量均可省略；同名 CLI flag（`--port` / `--db` / `--isolation-mode` 等）优先级更高，全部见 `src/config.ts` 与 `node lib/cli.js --help`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SERVER_LOGIN_PORT` | `3080` | 编排服务绑定端口（nginx 上游） |
| `DSH_SERVER_LOGIN_DATA_ROOT` | `~/.dsh-server-login` | 每用户 home/workspace 根（生产 `/var/lib/dsh-server-login`） |
| `DSH_SERVER_LOGIN_DSH_BIN` | `dsh` | 子 DSH 可执行文件（建议绝对路径，systemd 下 PATH 精简） |
| `DSH_SERVER_LOGIN_ISOLATION_MODE` | `soft` | `soft` 软隔离 / `account` 账号级硬隔离（Linux，需 root） |
| `DSH_SERVER_LOGIN_BASE_UID` | `100000` | 账号级隔离的 uid 基数 |
| `DSH_SERVER_LOGIN_PORT_GUARD` | `false` | iptables owner-match 端口守卫（Linux+root）：阻止同机其他账号直连各用户 DSH 的回环端口；不支持的环境下开启会拒绝启动（fail loud） |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | `false` | HTTPS 部署设为 `true`（cookie 加 `Secure`，SameSite=None 以跨子域共享） |
| `DSH_SERVER_LOGIN_BASE_DOMAIN` | 空 | 每用户子域名的基域（如 `dsh.example.com`）；空 = 仅子路径访问 |
| `DSH_SERVER_LOGIN_COOKIE_DOMAIN` | 空 | 会话 cookie 的 `Domain`（如 `.dsh.example.com`，注意前导点）；空 = host-only |
| `DSH_SERVER_LOGIN_SESSION_TTL` | `604800` | 会话有效期（秒，默认 7 天） |
| `DSH_SERVER_LOGIN_MAX_UPLOAD` | `25MB` | 上传请求体上限（base64 JSON） |
| `DSH_SERVER_LOGIN_RESTART_BACKOFF` | `1000` | 子 DSH 崩溃后的自动重启延迟（毫秒） |
| `DSH_SERVER_LOGIN_ENABLE_PATCH` | `false` | 是否向子 DSH 注入 `--patch`（运行时插件 + 每文件夹插件；旧版 dsh 不支持时可关） |
| `DSH_SERVER_LOGIN_SECRET` | 自动生成 | 每用户密钥库的加密主密钥；未设置时生成并持久化到 `<dataRoot>/secret.key`（0600） |
| `DSH_SERVER_LOGIN_DEPLOY_MODE` | `local` | `local` 单机 / `k8s` 每用户 Pod（模式 B） |
| `DSH_SERVER_LOGIN_DB_URL` | 空 | Postgres DSN；设置即启用 Postgres（k8s 必填） |
| `DSH_SERVER_LOGIN_NAMESPACE` | `dsh` | （k8s）每用户资源所在命名空间 |
| `DSH_SERVER_LOGIN_DSH_IMAGE` | 空 | （k8s 必填）每用户 DSH Pod 镜像 |
| `DSH_SERVER_LOGIN_CONTROL_PLANE_IMAGE` | 空 | （k8s 必填）file sidecar / tcp-bridge / init 容器镜像 |
| `DSH_SERVER_LOGIN_IMAGE_PULL_SECRET` | `dsh-acr-pull` | （k8s）生成 Pod 的拉镜像 secret |
| `DSH_SERVER_LOGIN_EGRESS_CIDRS` | 空 | （k8s）每用户 Pod 443 出站白名单 CIDR；空 = 全网（始终排除私网段与 169.254.169.254） |
| `DSH_SERVER_LOGIN_K8S_SERVICE_ACCOUNT` | `dsh-orchestrator` | （k8s）控制面 ServiceAccount |

## 文档

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [部署教程（模式 A）](docs/deployment.md) | 从零到公网可用：Node / DSH / systemd / DNS / HTTPS / nginx | 第一次部署单机版，照着做即可 |
| [硬隔离教程](docs/hard-isolation.md) | 每用户独立 OS 账号（`setpriv` 降权），生产环境建议开启 | 模式 A 跑通后的进阶加固 |
| [域名配置示例](docs/domain-config.md) | 主域 + 每用户子域 + 自定义域名的 nginx 配置 | 配置域名 / 排查路由问题 |
| [常见问题排查](docs/troubleshooting.md) | 502 / 404 / 401 / 403 / SSL / 端口冲突，按现象索引 | 出错了先来这里对现象 |
| [K8s 部署教程（模式 B）](docs/k8s-deployment.md) | ACK + CNFS + CNPG 分步部署（多机 HA） | 要部署容器化多机形态 |
| [K8s 踩坑记录](docs/k8s-deploy.md) | 模式 B 实机部署的坑与根因（镜像源 / 存储 / 网络 / 备案） | 模式 B 部署卡住时查 |
| [技术蓝图](docs/blueprint.md) | 权威技术设计：拓扑 / 双 DSH / 数据模型 / API / 安全模型 | 想了解原理或参与开发 |
| [PoC 实验记录](poc/README.md) | k8s 关键假设的四项实测（RWX / socat / NetworkPolicy / CNPG） | 评估模式 B 可行性时 |

> 学习路线：**模式 A** 先读「部署教程」跑通 → 再看「硬隔离」加固，出问题查「常见问题排查」；**模式 B** 直接从「K8s 部署教程」开始，卡住查「K8s 踩坑记录」。

## 开发

```sh
npm install          # pnpm/npm 均可；Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm test             # 构建 + node:test 单测（DB 双后端 / k8s spawner / leader / fs 围栏）
npm run smoke        # 及 smoke:* 系列：对运行中的服务做端到端冒烟（scripts/smoke*.mjs）
```

## 安全

- **会话**：不透明随机 token，仅 SHA-256 哈希落库；cookie `HttpOnly` + `SameSite`，HTTPS 下加 `Secure`。
- **密码**：scrypt 加盐哈希，常数时间比较。
- **密钥**：每用户 API key 以 AES-256-GCM 加密落库，主密钥来自 env 或 `<dataRoot>/secret.key`（0600）。
- **路径**：所有文件操作先做词法包含校验，再逐段拒绝符号链接分量，防止越出用户根目录。
- **隔离分层**：软隔离（默认）→ 账号级硬隔离（OS 账号 + `setpriv` 降权，`0700` 真正生效）→ 端口守卫（iptables owner-match）→ k8s Pod 边界（non-root / drop ALL / 只读 rootfs / NetworkPolicy）。
- **审计**：注册 / 登录 / 审核 / 改密钥等动作写入 `audit_log`。

细节与威胁模型见[技术蓝图 §7](docs/blueprint.md)、[硬隔离教程](docs/hard-isolation.md)。

## 问题反馈与支持

这是我开发的第一个正式项目，功能可能还不够完善，非常欢迎大家提出意见和反馈！
如果你在使用过程中遇到问题，或者有改进建议，欢迎提交 [Issue](../../issues)：

- 🐛 **遇到 Bug**：请描述你的复现步骤、报错信息、以及运行环境（系统/DSH 版本等）
- 💡 **功能建议**：请说明你的使用场景和你期望的效果
- 📖 **文档疑问**：指出 README 中看不懂或描述不清的地方

我会**尽量在 1~2 天内回复**，确认有效的问题会尽快修复并发布更新。
感谢你的支持！🌟

## 许可证

[MIT](LICENSE)
