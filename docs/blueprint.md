# 技术蓝图 — DSH 服务端登录插件

> 🧭 [← 返回 README](../README.md) · 部署（模式 A）：[deployment](deployment.md) · 部署（模式 B）：[k8s-deployment](k8s-deployment.md)

多租户托管平台，让用户通过域名安全访问自己的 DeepSeek Harness（DSH）实例。本文是权威技术设计；实现与本文冲突时以本文为准，并同步回改。

## 1. 运行拓扑

```
用户浏览器
   ├─(HTTPS)─> dsh.<域名>             → 编排服务 Fastify（认证/管理/桌面/域名，/api/*）
   └─(HTTPS)─> <用户名>.dsh.<域名>    → 编排服务按 Host 头路由到该用户 DSH（HTTP + WebSocket）
```

- **主域 `dsh.<域名>`**：编排服务自己的登录 / 管理台 / 桌面 / API。
- **每用户子域 `<用户名>.dsh.<域名>`**：编排服务按 Host 头解析用户名 → 校验会话 cookie → 反向代理到该用户 DSH 的 `127.0.0.1:<动态端口>`（HTTP + WebSocket 隧道）。
- 每用户 DSH 只绑回环端口、不直接暴露公网；端口表随 spawn/respawn 即时更新，nginx 用通配 `*.dsh.<域名>` 透传即可，无需每次 reload。
- 编排服务是独立 Node 进程，`child_process.spawn('dsh --profile web --host 127.0.0.1 --port <随机>', ...)` 拉起每用户 DSH（主 + 按需守护）。

## 2. 打包与启动

- **主入口**：独立 `dsh-server-login` bin（`node lib/cli.js`）直接跑 Fastify + SQLite + 进程编排。
- **市场识别**：根 `package.json` 的 `dsh` 字段（`plugin`/`kind`/`bundle.patch`）+ `cordis.patch.yml`；不 import 任何 `@deepseek-ai/*` 宿主包，peerDependencies 为空，规避宿主包遮蔽。
- **cordis 入口 `apply()` 是带守卫空操作**：默认无副作用，装进任意 profile 都不起服务器。
- **产物型分发**：提交 `lib/`（构建产物），`prepare` = `npm run build` 供 git 安装自构建。

## 3. spawn 每用户 DSH

```ts
spawn(dshBinPath, ['--profile', 'web', '--patch', mainPatchPath, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: workspacePath, // 用户在桌面选的文件夹
  env: { ...scrubEnv(process.env), HOME: workspacePath, DSH_HOME: homeDir, DEEPSEEK_API_KEY: userApiKey },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
})
```

- env 擦除镜像 harness 的 `scrubbedParentEnv`/`SENSITIVE_ENV_PATTERN` 思路：只向子进程显式注入已解析 key。
- 端口是 CLI flag（`--port`），**不是** env、**不是** patch（踩坑记录见 [troubleshooting.md](troubleshooting.md)「端口冲突」）。
- 进程树 teardown 自行实现：SIGTERM → grace → SIGKILL。

## 4. 双 DSH「共享对话 + 崩溃接管」

**共享状态 = 每用户 `$DSH_HOME` 里的持久会话日志**（append-only；`session-persistence` 落盘）。

- **主 DSH** 独占实时会话并持续 append；绑定回环端口对外服务。
- **守护 DSH** 是**按需拉起的一次性 headless DSH**（不常驻）：主 DSH 崩溃时、或需执行 post-restart 命令时，编排服务才 spawn 一次；它与主 DSH 同 home/同 workspace，通过 `loadStoredFrom(id, fromSeq)` 读同一日志，修复/resume 后退出。

**崩溃接管闭环**（主 DSH 崩溃时，编排服务拉起一次守护 DSH 并自动重启主 DSH）：

1. **诊断**：读退出码 + stderr 尾部 + 会话日志尾部，判定崩溃点。
2. **修复会话日志**：`interruptedTurnClosers`（`packages/core/session/src/repair.ts`）+ `session-persistence.load`/`commitRepair` 把中断 turn 合成 `tool/result`/`step/end`/`turn/end{interrupted}`，产出可恢复的合法转录。
3. **修复根因**：守护 DSH 以 agent 身份（对共享 workspace 有工具权限）修文件/配置、摘坏插件、杀卡死子进程。
4. **接手会话**：`ctx.sessionPersistence.prepare`/`load`（或 `ctx.sessions.create({seed})`）恢复修复后的日志，接续对话成为新主 DSH；随后可选重拉 fresh 主 DSH 并退回守护位。

**计划内重启（装插件）**：主 DSH 退出前把「post-restart 自动命令」写成 JSON 落到 `$DSH_HOME`，守护 DSH 执行重启后命令。

**关键澄清**：「接手」= 顺序 failover（恢复同一持久日志续接对话），非两个活体同时驱动同一 turn——这是 harness 的 resume 语义，无需自建双向活体通道。

## 5. 数据模型（SQLite，migration v1）

- v1 使用：`users`、`sessions`、`workspaces`、`folder_plugins`、`dsh_instances`、`audit_log`。
- 预留：`domains`、`credential_vault`（references-not-secrets，密文引用不落明文）。

字段与约束见 `src/db/schema.ts`。

## 6. API 面

| 组 | 路由 | 脚手架状态 |
|---|---|---|
| Auth | `POST /api/auth/register\|login\|logout`、`GET /api/auth/me` | 已实现（P1） |
| Admin | `GET /api/admin/users`、`POST /api/admin/users/:id/approve\|disable\|enable` | 已实现（P1；disable 会同时删会话 + 停 DSH） |
| Desktop/FS | `GET /api/desktop/tree`、`POST /api/fs/mkdir\|upload\|create` | 已实现（P2；路径经词法 + 符号链接双重围栏） |
| 凭据库 | `GET/POST /api/me/keys`、`POST /api/me/keys/:id/select`、`DELETE /api/me/keys/:id` | 已实现（每用户命名密钥，AES-256-GCM 加密落库） |
| DSH | `POST /api/dsh/launch\|stop\|restart`、`GET /api/dsh/status`、`GET /u/:slug/dsh/*` | 已实现（P3/P5，HTTP 代理；main+watchdog 编排层） |
| Plugin | `GET /api/plugins`、`POST /api/plugins/select` | 已实现（P4） |
| Domain/nginx | `GET/PUT /api/domain`、`POST /api/nginx/regen`、`GET /api/admin/domains`、`POST /api/admin/domains/:id/verify` | 已实现（P6，管理员手动验证；ACME 待接入） |
| 静态 | `GET /*`（占位 SPA） | 已接 |

## 7. 安全模型

默认软隔离（每用户 `$DSH_HOME` + session `cwd` + 沙箱写隔离）；Linux 生产建议开启账号级硬隔离（每用户 OS 账号），见 [hard-isolation.md](hard-isolation.md)。两个兜底：

- **端口守卫（portGuard）**：iptables OUTPUT owner-match 规则，阻止同机其他账号直连各用户 DSH 的回环端口、绕过编排服务认证；不支持的环境下开启即拒绝启动。
- **路径围栏**：所有文件面先做词法包含校验（`resolveWithinRoot`），再逐段 `lstat` 拒绝符号链接分量，防止经工作区内的链接越出用户根。

## 8. 分阶段路线

P1–P7 已完成：登录审核、桌面/FS、单 DSH 启动、每文件夹插件、守护/双 DSH、域名/nginx、硬隔离。模式 B（K8s + Postgres + leader election + reconcile，每用户 Pod）已落地：清单见 `deploy/`，部署教程见 [k8s-deployment.md](k8s-deployment.md)。
