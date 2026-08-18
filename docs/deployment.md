# 部署说明 — DSH 服务端登录插件（Linux）

公网 Linux 服务器的完整部署步骤。目标形态：**每用户一个独立 OS 账号**（硬隔离），nginx 边缘 TLS，用户经域名访问自己的 DSH。

## 0. 前置条件

- Linux 服务器，root 权限（账号创建 + setuid 降权需要）。
- Node.js `^22.19 || >=24`，pnpm 或 npm。
- 已安装 DeepSeek Harness 的 `dsh` CLI（子 DSH 的可执行文件）。
- nginx + certbot（TLS 签发）。
- 一个指向服务器的默认域名。

## 1. 架构总览

```
用户浏览器 → nginx(443, TLS) → 编排服务(127.0.0.1:3080, root 运行)
                                   ├─ 认证/管理/桌面/域名 API
                                   └─ /u/<userId>/dsh/* → 子 DSH(127.0.0.1:动态端口)
每用户子 DSH 以「该用户的 OS 账号」运行（setpriv 降权），只能读自己的 home/workspace。
```

- 编排服务以 **root** 运行（为了 spawn 子 DSH 时 `setpriv` 降权）。
- 每个子 DSH（主 + 按需守护）在 spawn 前由编排服务用 `setpriv --reuid <uid>` 切到对应用户账号。
- 每用户目录 `$DATA_ROOT/users/<id>/{home,ws}` 归该 uid 所有、`0700`——此时 `0700` 才真正挡住跨用户读。

## 2. 安装

```sh
# 1) 安装本插件（含运行时插件 dsh-server-login/runtime）
npm install -g dsh-server-login        # 或 pnpm add -g

# 2) 确认子 DSH 可执行（dsh 在 PATH）
dsh --version

# 3) 数据根目录
mkdir -p /var/lib/dsh-server-login
```

## 3. 创建首个管理员

```sh
dsh-server-login bootstrap-admin --username admin --password '<强密码>' --data-root /var/lib/dsh-server-login
```

## 4. 账号级隔离配置（P7）

编排服务启动参数（或环境变量）：

| 变量 | 值 | 说明 |
|---|---|---|
| `DSH_SERVER_LOGIN_ISOLATION_MODE` | `account` | 账号级隔离 |
| `DSH_SERVER_LOGIN_BASE_UID` | `100000` | 每用户 uid 的基数（须 > 系统 uid 范围） |
| `DSH_SERVER_LOGIN_DATA_ROOT` | `/var/lib/dsh-server-login` | 每用户目录根 |
| `DSH_SERVER_LOGIN_DSH_BIN` | `dsh` | 子 DSH 可执行 |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | `true` | HTTPS 下必须 |
| `DSH_SERVER_LOGIN_PORT` | `3080` | 编排服务绑定（与 nginx 上游一致） |

降权命令默认是 `setpriv --reuid {UID} --regid {GID} --inh-caps=-all --clear-groups --`；可用 `spawnAsUserCommand`（配置/环境变量 `DSH_SERVER_LOGIN_SPAWN_AS_USER`）覆盖。

### 4.1 每用户 OS 账号的创建与 chown

用户注册后，编排服务会在 `$DATA_ROOT/users/<id>/` 建 home/ws 目录（此时归 root）。要启用账号级隔离，**每个用户需要一次性创建 OS 账号并 chown**：

```bash
#!/usr/bin/env bash
# provision-user.sh <userId>   —— 以 root 运行
set -euo pipefail
uid="$(dsh-server-login uid-for-user "$1")"
user="dsh-$1"
useradd -u "$uid" -M -s /usr/sbin/nologin "$user"
chown -R "$uid:$uid" "/var/lib/dsh-server-login/users/$1"
echo "provisioned $1 -> uid $uid"
```

- `uid-for-user <userId>` 打印与编排服务**完全一致**的确定性 uid（同一份 `uidForUser` 实现），避免 JS 与 shell 各算一份导致不一致。
- 建议把这一步接到注册流程（webhook / 队列 / systemd path 监听），或管理员手动跑一次。

## 5. 运行时插件 + 端口绑定

子 DSH 由编排服务 `--patch <file>` 加载本 bundle 的运行时插件 `dsh-server-login/runtime`（读 `DSH_SERVER_LOGIN_PORT`/`DSH_SERVER_LOGIN_ROLE`/`DSH_SERVER_LOGIN_HANDOFF_PATH`）。**前提**：`dsh-server-login` 需安装在子 DSH 的 profile 里：

```sh
# 在子 DSH 使用的 profile 中安装本包，使 dsh-server-login/runtime 可解析
dsh plugin --profile web add dsh-server-login
```

端口绑定：harness 的 web 服务读 **`--port` 这个 CLI flag**（`web-startup` 插件解析后经 `webStartup` 服务喂给 webserver）。编排服务 spawn 子 DSH 时已传 `--host 127.0.0.1 --port <随机端口>`，子 DSH 便绑到分配的随机端口、只监听回环，与编排服务自身（3080）不再冲突，无需 patch 覆盖。

## 6. nginx + 域名 + TLS

默认域名 + 每用户子路径，以及自定义域名，见 [docs/domain-config.md](domain-config.md)。核心是把一切透传给 `127.0.0.1:3080`，并开启 WebSocket 升级头。

```sh
certbot --nginx -d dsh.example.com
```

## 7. systemd 托管编排服务

```ini
# /etc/systemd/system/dsh-server-login.service
[Unit]
Description=DSH server login orchestrator
After=network.target

[Service]
User=root
Environment=DSH_SERVER_LOGIN_ISOLATION_MODE=account
Environment=DSH_SERVER_LOGIN_BASE_UID=100000
Environment=DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login
Environment=DSH_SERVER_LOGIN_SECURE_COOKIES=true
Environment=DSH_SERVER_LOGIN_PORT=3080
Environment=DSH_SERVER_LOGIN_DSH_BIN=dsh
ExecStart=/usr/local/bin/dsh-server-login
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now dsh-server-login
```

## 8. 验证清单

1. 注册一个用户 → `provision-user.sh <userId>` → 管理员审核。
2. 用户登录桌面 → 启动 DSH。
3. `ps -o uid,user,cmd -p <子DSH pid>`：子 DSH 的 uid 应等于 `dsh-server-login uid-for-user <userId>`（不是 root）。
4. **越权读验证**：在用户 A 的 `home` 放一个文件，用户 B 的 DSH 里 `cat` 它 → 应 `Permission denied`。
5. `systemctl status dsh-server-login` 正常；`/api/auth/me` 未登录返回 401。

## 9. 安全注意

- 编排服务必须以 root 运行（`setpriv` 需要）；它自身**只监听 127.0.0.1**，公网入口只有 nginx。
- 不要给子 DSH 开放 `0.0.0.0` 或公网端口。
- 会话 cookie 在 HTTPS 下必须 `Secure`（第 4 节已设）。
- 自定义域名归属校验（ACME/DNS）落地前，不要开放 `PUT /api/domain` 给普通用户随意映射。
- 账号级隔离闭合了同 UID 越权读，但容器级（私有挂载命名空间、只读 rootfs）是更强的后续选项。

## 10. 已知待办（真实 harness 集成时）

- 守护 DSH 的「修复会话日志 + resume 接手」是 harness 内部行为（`interruptedTurnClosers` + `session-persistence`），接入时由 `dsh-server-login/runtime` 的 watchdog 分支承担。
- 子进程日志当前直连编排进程 stdout，生产建议落到每用户 `home/logs/`。
