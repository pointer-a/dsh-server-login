# 域名配置示例 — DSH 服务端登录插件

> 🧭 [← 返回 README](../README.md) · 基础部署：[deployment](deployment.md) · 出问题：[排查手册](troubleshooting.md)

本文给出域名与 nginx 的配置示例。**注意**：默认访问方式已改为**每用户子域名**（`<用户名>.dsh.<域名>`，HTTP + WebSocket 均已支持）——因为 DSH 的 SPA 用绝对路径、子路径方案不兼容。通配 nginx 配置见 [deployment.md §6](deployment.md)，常见问题见 [troubleshooting.md](troubleshooting.md)。下面的「子路径」示例仅作遗留参考。

## 1. 访问拓扑

```
用户浏览器
   └─(HTTPS)─> nginx（边缘：TLS 终结 + host 路由）
                  └─(反向代理)─> 编排服务 Fastify  (127.0.0.1:3080)
                                   ├─ /api/* /login /register /admin /desktop   （编排服务自管）
                                   └─ /u/<userId>/dsh/* ──> 127.0.0.1:<动态端口>  （每用户 DSH）
```

- 每用户 DSH 只绑定**回环端口**（`127.0.0.1:<动态端口>`），不直接暴露公网；端口由编排服务在启动时分配。
- nginx 只做边缘 TLS 与转发，把 `/u/*` 原样透传给编排服务即可——**每用户 DSH 的端口映射由编排服务自己维护**，nginx 无需在每次 DSH 重启时 reload。

## 2. 默认域名（所有用户共享一个域名）

用子路径区分用户：`https://dsh.example.com/u/<userId>/dsh/`。

```nginx
# /etc/nginx/conf.d/dsh-server-login.conf

# WebSocket 升级头（DSH Web UI 依赖）
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream dsh_orchestrator {
    server 127.0.0.1:3080;   # 编排服务绑定端口（DSH_SERVER_LOGIN_PORT）
    keepalive 32;
}

server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;   # 强制 HTTPS
}

server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    # 编排服务 trustProxy=true，会读取以下头还原真实 IP / 协议
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location / {
        proxy_pass http://dsh_orchestrator;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;        # 长连接（DSH 对话 / WebSocket）
    }
}
```

**说明**：上面只配置了默认域名一条规则；`/u/<userId>/dsh/` 的转发到哪台每用户 DSH，由编排服务内部决定，nginx 不关心。

## 3. 自定义域名（每用户专属域名）

设计目标：每个用户可用自己的域名直达自己的 DSH，例如 `https://alice.example.com` → alice 的 DSH。

### 3.1 手动映射（当前可手写生效）

由于编排服务已经支持 `/u/<userId>/dsh/*`，可先在 nginx 手写一条把自定义域名根路径重写到子路径：

```nginx
server {
    listen 443 ssl;
    server_name alice.example.com;

    ssl_certificate     /etc/letsencrypt/live/alice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.example.com/privkey.pem;

    location / {
        # 把自定义域名根路径重写到 alice 的 DSH 子路径
        proxy_pass http://127.0.0.1:3080/u/<alice-user-id>/dsh/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

> `proxy_pass` 带 URI（以 `/` 结尾）时，nginx 会把匹配到的 `/` 替换为 `/u/<alice-user-id>/dsh/`，
> 于是 `https://alice.example.com/foo` → `http://127.0.0.1:3080/u/<alice-user-id>/dsh/foo`。
> 编排服务再剥掉 `/u/<userId>/dsh` 前缀转发给该用户的 DSH。

### 3.2 自动生成（已实现）

`POST /api/nginx/regen` 会根据 `domains` 表为每个已验证的自定义域名生成一个上面的 `server {}` 块，
由 [src/nginx/generate.ts](../src/nginx/generate.ts) 的 `renderServerBlock(domain, upstreamPort)` 渲染，运维写入
`/etc/nginx/conf.d/` 后 `nginx -s reload`。

## 4. HTTPS 证书（certbot / ACME）

```sh
# 默认域名
sudo certbot --nginx -d dsh.example.com

# 自定义域名（每个用户域各自签发）
sudo certbot --nginx -d alice.example.com
```

证书签发后 certbot 会自动改写对应 `server {}` 的 `ssl_certificate*`。证书的自动签发/续期（ACME）暂未接入：目前域名由管理员在管理台手动标记「已验证」，签发仍用 certbot 手动跑。后续计划把这一步与 `PUT /api/domain`（DNS/HTTP 挑战验证）串起来，实现「用户填域名 → 自动验证 → 自动签发 → 生成并热加载 nginx 配置」。

## 5. WebSocket 说明

DSH Web UI 使用 WebSocket。编排服务的反向代理已支持 WebSocket 隧道（[proxy.ts](../src/supervisor/proxy.ts) 的 `app.server` `upgrade` 处理器），按 Host 头路由到该用户 DSH，与 HTTP 一致。nginx 侧只需 `map $http_upgrade` + `Upgrade/Connection` 头透传。子域名下 WS 走 `wss://<用户名>.dsh.<域名>/api/...`。

## 6. 域名配置 API（已实现；ACME 自动验证待接入）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/domain` | 查询当前用户的域名 + nginx 配置 |
| `PUT` | `/api/domain` | 设置自定义域名，生成对应的 nginx `server {}` 块（`verified` 重置为 0） |
| `POST` | `/api/nginx/regen` | 重新生成并预览 nginx `server {}` 块 |
| `GET` | `/api/admin/domains` | 管理员：列出所有自定义域名 |
| `POST` | `/api/admin/domains/:id/verify` | 管理员：手动标记域名「已验证」（DNS 归属校验暂未自动化） |

实现见 [src/web/routes/domain.ts](../src/web/routes/domain.ts) 与 [src/nginx/generate.ts](../src/nginx/generate.ts)。

## 7. 生产环境变量

| 变量 | 说明 |
|---|---|
| `DSH_SERVER_LOGIN_PORT` | 编排服务绑定端口（nginx 上游需一致），默认 `3080` |
| `DSH_SERVER_LOGIN_DATA_ROOT` | 每用户 home / workspace 根，生产建议 `/var/lib/dsh-server-login` |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | **HTTPS 部署必须设为 `true`**（否则会话 cookie 不带 `Secure`） |
| `DSH_SERVER_LOGIN_DSH_BIN` | 子 DSH 可执行文件（默认 `dsh`） |

编排服务 `host` 默认 `127.0.0.1`（只监听回环，由 nginx 作为唯一公网入口），保持默认即可。

## 8. 安全注意

- 每用户 DSH 只绑回环端口；不要把它们改成 `0.0.0.0`，否则绕过认证直接暴露。
- 会话 cookie 在 HTTPS 下必须启用 `Secure`（见 §7）。
- 编排服务 `trustProxy=true`，仅在与 nginx 同机且信任其 `X-Forwarded-*` 头时使用；不要把它直接暴露公网。
- 自定义域名的归属校验（DNS/HTTP 挑战）在 P6 落地前，**不要**开放 `PUT /api/domain` 给普通用户随意映射他人路径。
