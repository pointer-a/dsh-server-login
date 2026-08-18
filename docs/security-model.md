# 安全模型 — DSH 服务端登录插件

## v1 软隔离（本阶段落实）

1. 每用户 `$DSH_HOME`（`<dataRoot>/users/<id>/home`）`0700`。
2. 每用户 session `cwd`（`<dataRoot>/users/<id>/ws/<folder>`）——FS 工具、`fs-sandbox`、bash workdir、沙箱策略都 key 在它上面。
3. 沙箱 `workspace-write`：写操作被 Landlock/bwrap/Seatbelt/Windows-ACL 限制在 workspace root 内。
4. SQLite 全参数化查询（better-sqlite3 prepared statements），零字符串拼接 SQL。
5. 路径穿越守卫：`path.resolve` + `startsWith(root + sep)` + 拒绝 `..`/NUL/绝对路径；P2 补 `realpath` 符号链接逃逸校验。
6. 口令哈希：`scrypt`（脚手架）→ 生产换 argon2id；常数时间比较；永不存明文。
7. Cookie：`HttpOnly; SameSite=Lax; Secure; Path=/`；token 为 256-bit 随机值，DB 只存 `sha256(token)`。
8. 登录限流 + 失败锁定（`@fastify/rate-limit` 基线，P1 细化 per-IP/per-user）。
9. CSRF：`SameSite=Lax` + 自定义头/double-submit token（P1）。
10. 反注入：插件 `plugin_id` 仅允许「已安装插件」allowlist；spawn argv 只用校验过的 UUID/白名单 profile 名，绝不拼接用户输入。
11. env 擦除：spawn 子进程 env 走白名单，只注入显式解析的 key。

## 已知缺口（如实记录）

**同 UID 越权读**：编排服务与所有每用户 DSH 跑在同一 OS 账号，`0700` 挡不住同 UID 进程读彼此文件；`fs-sandbox`/Landlock 默认 `readOnly:['/']` 也不限读。软隔离防「写越界」与「凭据泄漏」，但防不住「恶意 DSH 读邻居文件」。

## 硬隔离（P7，已实现账号级）

账号级隔离已落地（Linux-only）：每个用户一个独立 OS 账号，编排服务 spawn 子 DSH 时用 `setpriv --reuid <uid>` 降权，`0700` 目录才真正生效、闭合同 UID 越权读。

- 确定性 uid：`uidForUser(userId, baseUid)`（`src/isolation.ts`），`dsh-server-login uid-for-user` 供部署脚本取同一 uid。
- 配置：`isolationMode: 'account'` + `spawnAsUserCommand`（默认 `setpriv --reuid {UID} --regid {GID} --inh-caps=-all --clear-groups --`）。
- 运行时插件 `dsh-server-login/runtime`（本 bundle 内，不动 harness）读 env 契约（端口/角色/handoff）。
- 详细步骤见 [deployment.md](deployment.md)。

**更强选项（未默认，按需）**：每用户容器（runc/systemd-nspawn，私有挂载命名空间 + 只读 rootfs）；或收窄 Landlock 读授权（`readOnly:['/']` → 系统路径白名单 + 用户 workspace）作纵深防御。
