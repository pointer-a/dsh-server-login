# 性能占用 — DSH 服务端登录插件

资源占用审视结论、冷启动实测、以及已做的优化。测量环境：Windows / Node 24，源码启动。

## 1. 冷启动实测

| 对象 | 实测 | 说明 |
|---|---|---|
| 编排服务（自建） | **~0.3s** | Fastify + SQLite + 路由注册 |
| DSH `web`（主 DSH） | **~4.3s** | 源码启动（`pnpm dsh`，走 tsx）；`--dump-config` 只 boot 不跑任务 |
| DSH `headless`（守护 DSH） | **~4.0s** | 比 web 略快（少 Web UI 层） |

- 编排服务自身可忽略；**冷启动大头是 DSH 的 Cordis 插件树 boot**（几十个插件的 import + Loader 挂载 + `apply()` 副作用 + 持久化/设置/凭据/沙箱探测），不是 Node 启动（后者仅 ~0.15s）。
- 构建产物版（直接跑 `lib/` 的 `dsh` 二进制，不经 pnpm+tsx）会明显更快，估算 1.5–3s；上面的 4s 是源码启动值。

测量命令（harness 目录）：

```sh
time pnpm dsh --profile web --dump-config      # 主 DSH
time pnpm dsh --profile headless --dump-config # 守护 DSH
```

## 2. 资源占用分解

| 维度 | 主体 | 量级 |
|---|---|---|
| 内存 | 每活跃用户 1 个常驻主 DSH 子进程（watchdog 已改为按需） | 主导。真实 DSH 估算 100–300MB+（需实测） |
| CPU | 每用户 LLM 推理/工具调用 | 随使用波动 |
| 磁盘 | SQLite（WAL）+ 每用户 workspace/home | 轻 |
| 网络 | 反向代理转发 + LLM 出站 | 代理无本地缓存 |

## 3. 已做的优化

1. **Prepared-statement 缓存**（[src/db/prepared.ts](../src/db/prepared.ts)）：better-sqlite3 不缓存 `db.prepare`，按连接 WeakMap 缓存，消除热路径（认证/代理）每次查询的重复 SQL 解析。
2. **`requireAuth` 合并为一次 JOIN**（[src/db/repo.ts](../src/db/repo.ts) `findSessionWithUser`）：`sessions JOIN users`，从「2 次查询」降到「1 次」，每个认证请求/每个代理子资源请求都走这条路径。
3. **反向代理 keep-alive**（[src/supervisor/proxy.ts](../src/supervisor/proxy.ts)）：`http.Agent({ keepAlive: true })`，DSH Web UI 子资源请求复用上游连接。
4. **fs 异步化**（[src/fs/workspace.ts](../src/fs/workspace.ts)、[src/web/routes/desktop.ts](../src/web/routes/desktop.ts)）：`listDir` 改 `fs/promises` 异步 `readdir`/`stat`，上传 `writeFile` 异步落盘，避免阻塞事件循环。

> 注：类型细节——`@types/better-sqlite3` 的 `prepare` 返回条件类型（`BindParameters extends unknown[] ? Statement<BindParameters> : Statement<[BindParameters]>`），用 `ReturnType<...>` 提取会带上假分支导致 `.run/.get/.all` 被当成单参数；故缓存类型用 `Database.Statement<unknown[], unknown>` 显式实例化。

## 4. 待办（低优先级）

- 子进程日志落盘：`child.stdout/stderr` 目前直连编排进程 stdout，多用户时量大且混；应落到每用户 `home/logs/*.log`（后续加轮转）。
- 生产日志级别：`DSH_SERVER_LOGIN_LOG_LEVEL=warn` 关闭逐请求日志。
- 上传由 base64 JSON 改为 multipart 流式，去掉 base64 内存膨胀（`maxUploadBytes` 当前是 JSON body 上限）。
