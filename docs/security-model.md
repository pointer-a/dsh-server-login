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

## 硬隔离升级路径（P7）

1. 每用户 OS 账号/容器（`systemd-nspawn`/`docker`/`runc`），`0700` 与挂载命名空间才真正生效。
2. 收窄 Landlock 读授权：把 `readOnly:['/']` 换成系统路径白名单 + 用户自己的 workspace，是单 OS 账号内闭合读缺口的最小改动，优先于全容器。
3. 凭据：`credential_vault` 密文引用 + 应用级加密，key 只在 spawn 时注入子进程 env。

> 是否在软隔离阶段就上线（P1–P6）由运营方决定；本文件把缺口与升级路径写死，避免误当"已隔离"。
