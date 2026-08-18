# 技术蓝图 — DSH 服务端登录插件

多租户托管平台，让用户通过域名安全访问自己的 DeepSeek Harness（DSH）实例。本文是权威技术设计；实现与本文冲突时以本文为准，并同步回改。

## 1. 运行拓扑

```
用户浏览器
   └─(HTTPS)─> nginx（TLS 终结 / vhost 映射）
                  └─(反向代理)─> 编排服务 Fastify
                                    ├─ /api/*（认证/管理/桌面/插件/域名）
                                    ├─ /u/:slug/dsh/* → 每用户 DSH 的 127.0.0.1 动态端口
                                    ├─ SQLite（better-sqlite3）
                                    └─ 进程编排（child_process spawn/kill/watch）
                                          ├─ 主 DSH（dsh --profile web）
                                          └─ 守护 DSH（dsh --profile headless）
```

- 每用户 DSH 只绑定回环端口，不直接暴露公网；反向代理是编排服务自己的职责（端口表随 spawn/respawn 即时更新，nginx 无需每次 reload）。
- 编排服务是独立 Node 进程，`child_process.spawn('dsh', ...)` 拉起每用户的 DSH 进程对。

## 2. 打包与启动

- **主入口**：独立 `dsh-server-login` bin（`node lib/cli.js`）直接跑 Fastify + SQLite + 进程编排。
- **市场识别**：根 `package.json` 的 `dsh` 字段（`plugin`/`kind`/`bundle.patch`）+ `cordis.patch.yml`；不 import 任何 `@deepseek-ai/*` 宿主包，peerDependencies 为空，规避宿主包遮蔽。
- **cordis 入口 `apply()` 是带守卫空操作**：默认无副作用，装进任意 profile 都不起服务器。
- **产物型分发**：提交 `lib/`（构建产物），`prepare` = `npm run build` 供 git 安装自构建。

## 3. spawn 每用户 DSH

```ts
spawn(dshBinPath, ['--profile', 'web', '--patch', mainPatchPath, '--cwd', workspacePath], {
  cwd: workspacePath,
  env: { ...scrubEnv(process.env), DSH_HOME: homeDir, DEEPSEEK_API_KEY: userApiKey },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
})
```

- env 擦除镜像 harness 的 `scrubbedParentEnv`/`SENSITIVE_ENV_PATTERN` 思路：只向子进程显式注入已解析 key。
- 进程树 teardown 自行实现：SIGTERM → grace → SIGKILL（Windows `taskkill /T /F`）。

## 4. 双 DSH「共享对话 + 崩溃接管」

**共享状态 = 每用户 `$DSH_HOME` 里的持久会话日志**（append-only；`session-persistence` 落盘）。

- **主 DSH** 独占实时会话并持续 append；绑定回环端口对外服务。
- **守护 DSH** 是同 home/同 workspace 的并发 headless DSH，通过 `loadStoredFrom(id, fromSeq)` 尾随读同一日志。

**崩溃接管闭环**（守护 DSH 检测到主进程退出后）：

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
| Admin | `GET /api/admin/users`、`POST /api/admin/users/:id/approve\|disable` | 已实现（P1） |
| Desktop/FS | `GET /api/desktop/tree`、`POST /api/fs/mkdir\|upload` | 已实现（P2） |
| DSH | `POST /api/dsh/launch\|stop`、`GET /api/dsh/status`、`GET /u/:slug/dsh/*` | 已实现（P3，HTTP 代理） |
| Plugin | `GET /api/plugins`、`POST /api/plugins/select` | 已实现（P4） |
| Domain/nginx | `GET/PUT /api/domain`、`POST /api/nginx/regen` | stub |
| 静态 | `GET /*`（占位 SPA） | 已接 |

## 7. 安全模型

见 [security-model.md](security-model.md)。

## 8. 分阶段路线

见 [roadmap.md](roadmap.md)。
