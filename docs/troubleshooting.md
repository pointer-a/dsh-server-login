# 常见问题排查 — DSH 服务端登录插件

> 🧭 [← 返回 README](../README.md) · 部署教程：[deployment](deployment.md) · 硬隔离：[hard-isolation](hard-isolation.md)

按「现象 → 根因 → 修法」组织，都是实际部署中踩过的坑。

## 502：启动 DSH 后打开是 Bad Gateway

- **现象**：桌面显示「运行中」，但打开 DSH（子域名）返回 502（nginx）。
- **根因**：子 DSH 没在编排服务分配的回环端口上监听——要么还在冷启动，要么 spawn 即崩。
- **排查**：
  ```sh
  ps aux | grep dsh            # 有没有子进程
  ss -tulpn | grep <端口>      # 有没有监听
  ```
- **冷启动**：真实 DSH 冷启动 ~4s（源码启动）。编排服务在 `spawn` 事件就标「running」，但端口要等插件树 boot 完才绑。等 10 秒再开 / 再查 `ss`。
- **spawn 即崩**：看编排服务终端的子进程 stderr（stderr 会被 pipe 过去）。常见：`--port` 改动没部署（→ EADDRINUSE）、缺 `DEEPSEEK_API_KEY` 等。

## 启动 DSH 报 `spawn dsh ENOENT`

- **现象**：`/api/dsh/status` 显示 `status: "crashed"`、`lastError: "spawn dsh ENOENT"`；`ps` 里没有任何 dsh 子进程；再点启动报「已有运行中的 DSH」（崩溃循环留下的残留）。
- **根因**：systemd 的 PATH 精简，`dsh`（只装在 nvm 下）解析不到。`dsh` 脚本内部也是 `#!/usr/bin/env node`，同样需要 nvm 在 PATH。
- **修法**：
  1. env 里 `DSH_SERVER_LOGIN_DSH_BIN=/root/.nvm/versions/node/v22.23.2/bin/dsh`（绝对路径，版本按 `ls ~/.nvm/versions/node/` 改）。
  2. systemd 单元加 `Environment=PATH=/root/.nvm/versions/node/v22.23.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。
  3. `systemctl daemon-reload && systemctl restart dsh-server-login`，再先 stop 再 launch。

## 编排服务起不来：better-sqlite3 报 ERR_DLOPEN_FAILED / ABI 版本不匹配

- **现象**：`journalctl -u dsh-server-login` 里 `ERR_DLOPEN_FAILED`、`was compiled against ... NODE_MODULE_VERSION ... This version requires ...`；systemd 反复重启失败。
- **根因**：`npm install` 用 nvm Node 编译了 `better-sqlite3` 原生模块，但 systemd 的 `ExecStart=/usr/bin/env node` 解析到**另一个 Node 版本**，ABI 对不上。
- **修法**：`ExecStart` 用 nvm node 绝对路径（如 `/root/.nvm/versions/node/v22.23.2/bin/node lib/cli.js`），并 `npm rebuild better-sqlite3` 用同一个 node。

## 端口冲突：子 DSH 和编排服务抢 3080

- **现象**：手动跑 `dsh web` 报 `EADDRINUSE 0.0.0.0:3080`。
- **根因**：编排服务默认绑 3080，子 DSH（harness）默认也绑 3080。
- **关键机制**（读 harness 源码确认）：harness 的 web 服务端口读 **`--port` 这个 CLI flag**（`web-startup` 插件解析 → `webStartup` 服务 → webserver），**不是** env、**不是** patch。`--cwd` 也不是合法 flag。
- **修法**：spawn 子 DSH 用 `dsh --profile web --host 127.0.0.1 --port <随机端口>`（已内置）。

## 404：打开 DSH 后静态资源全 404

- **现象**：HTML 能加载，但 `/assets/*`、`/favicon.svg`、`/manifest.webmanifest` 全 404；`manifest` 从域名根去取。
- **根因**：DSH 的 SPA（Vite）资源用**绝对路径**（`/assets/*`、`/api/*`），假设自己挂在域名根 `/`。子路径 `/u/<id>/dsh/*` 下，这些绝对路径会打到域名根 → 404；连 `/api` 也会打到编排服务自己的 API。**子路径方案与这个 SPA 从根上不兼容**。
- **修法**：改**每用户子域名** `<用户名>.<baseDomain>`，SPA 挂在自己域名根，绝对路径天然成立（含 HTTP 与 WebSocket 均已由编排服务转发）。

## 403：DSH 功能请求报 transport failure / HTTP 403（如 /api/settings.describe）

- **现象**：DSH 页面能加载，但功能 API（`/api/settings.describe`、`/api/host.describe` 等）返回 403，前端报 "transport failure for /api/xxx: HTTP 403"。
- **根因**：harness 的 `/api` 浏览器信任栅栏（`api-request-trust.ts`）检查 Origin——`origin.host` 必须等于 `host.host`。代理把 `host` 改成 loopback（`127.0.0.1:port`）却原样转发了浏览器的 `origin`（子域名）→ 不匹配 → 403。
- **修法**：代理到 DSH 时剥掉 `origin` / `referer` / `sec-fetch-*` / `x-forwarded-*`，只保留 loopback `host`（已内置在 [proxy.ts](../src/supervisor/proxy.ts) 的 `buildUpstreamHeaders`）。

## ERR_SSL_VERSION_OR_CIPHER_MISMATCH

- **根因**：子域名没有覆盖它的证书（只有主域单域证书）。
- **修法**：DNS 通配 + 通配证书（DNS challenge）：
  ```sh
  certbot certonly --dns-cloudflare -d '*.dsh.example.com' -d 'dsh.example.com'
  ```

## 401：子域名/接口返回 {"error":"unauthorized"}

- **根因**：session cookie 是 host-only（没带 `Domain`），到不了子域名；或浏览器里还是**改配置之前登录**的旧 cookie。
- **修法**：
  1. 设 `DSH_SERVER_LOGIN_COOKIE_DOMAIN=.dsh.example.com`（注意前导点），重启。
  2. **重新登录**拿带 `Domain` 的新 cookie。

## 登录后跳管理员界面、无法保持登录

- **现象**：登录后按 admin 角色跳到 `admin.html`，但 admin.html 又弹登录框、再登不上。
- **根因**：浏览器里存的是旧 cookie（改 `Domain`/`Secure` 之前登录的），不再匹配当前配置。
- **修法**：删掉浏览器里的 `sid` cookie（DevTools → Application → Cookies → 删除 `dsh.example.com` 域下的 `sid`）重新登录。或本地测试时 `unset DSH_SERVER_LOGIN_COOKIE_DOMAIN DSH_SERVER_LOGIN_SECURE_COOKIES` 让 cookie 回到 host-only + 非 Secure。

## nginx 把 Host 头改成了 upstream 名

- **现象**：编排服务日志里 `host: dsh_orchestrator`。
- **根因**：nginx 默认 `proxy_set_header Host $proxy_host`（upstream 名）。
- **修法**：在 location 里加 `proxy_set_header Host $host`（子域名路由依赖真实 Host 头）。

## 编排服务日志在哪

- 有 systemd 单元：`journalctl -u dsh-server-login -f`。
- 手动跑（`node lib/cli.js`）：日志（含子 DSH 的 stdout/stderr，已被 pipe）在那个终端里。

## SEO 警告：`<html lang>` / `<title>` / `viewport` 缺失

- **现象**：Lighthouse 报这三条。
- **根因**：来自 **DSH 自己的聊天界面 SPA**（harness 前端），不是本插件页面（本插件的 login/desktop/admin 都写了这些）。
- **处理**：无害、不影响功能。要修需改 harness 前端或由 runtime 插件 `tapIndex` 注入，暂缓。
