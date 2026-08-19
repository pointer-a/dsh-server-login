# 部署教程（新手版）— DSH 服务端登录插件

这份教程假设你**第一次**部署这类服务。每一步都写清楚「做什么、为什么、怎么做、应该看到什么」。照着顺序做，大约 15–30 分钟能把整套跑通。

> 全文用 `example.com` 当例子，**请把所有 `example.com` 换成你自己的域名**。比如你的域名是 `dsh.baidu.com`，那么 `dsh.example.com` 就是 `dsh.baidu.com`，`*.dsh.example.com` 就是 `*.dsh.baidu.com`。

---

## 0. 先搞懂几个词（看不懂也没关系，后面会一直用到）

| 词 | 大白话解释 |
|---|---|
| **服务器** | 一台一直开机的电脑（这里指 Linux 云服务器），你的服务跑在上面。 |
| **域名** | 人类好记的名字，比如 `example.com`。它最终会被翻译成服务器的 IP。 |
| **DNS** | 负责「域名 → IP」翻译的系统。你在域名商那里改 DNS 记录，就是告诉全世界「这个名字指向那台服务器」。 |
| **子域名** | 在域名前面再加一段。比如 `dsh.example.com`、`carol.dsh.example.com` 都是 `example.com` 的子域名。 |
| **端口** | 一台服务器上的不同「门牌号」。一个服务占一个端口。 |
| **nginx** | 一个「反向代理」软件：站在门口，把外面来的请求按域名转发给里面跑的服务。 |
| **HTTPS / 证书** | 让浏览器显示「🔒 安全」的加密层。证书要针对具体域名签发。 |
| **环境变量** | 给程序传配置的方式，形如 `名字=值`。 |
| **进程** | 正在运行的一个程序。 |

## 0.1 整体长什么样（先有个全局印象）

```
你的用户（浏览器）
   │
   │ 访问 dsh.example.com（登录、管理、桌面）
   │ 访问 carol.dsh.example.com（carol 这个用户的 DSH 聊天界面）
   ▼
nginx（门口，按域名分发 + 加 HTTPS 锁）
   ▼
编排服务 dsh-server-login（本插件，跑在 127.0.0.1:3080）
   ├─ 管登录、审核、桌面
   └─ 按域名把 carol 的请求转发给「carol 的 DSH 进程」
            └─ DSH 进程（DeepSeek Harness，跑在随机的本机端口上）
```

**两个东西别搞混**：

- **`dsh-server-login`（编排服务）**：我们这个插件，管「登录、审核、桌面、按域名转发」。
- **`dsh`（DSH）**：DeepSeek Harness，真正的 AI 聊天界面。它由编排服务**自动**为每个用户启动，你不需要手动跑它。

---

## 1. 部署前准备（清单）

1. 一台 Linux 服务器，能 `root` 登录（推荐 Ubuntu 22.04+）。
2. 一个自己的域名，能登录域名商后台改 DNS 记录。
3. 大概半小时。

---

## 2. 第 1 步：安装 Node.js

本插件需要 Node 22 以上。用 nvm 装最省心：

```sh
# 1) 安装 nvm（Node 版本管理器）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# 2) 让当前终端生效（或关掉重开一个终端）
source ~/.bashrc
# 3) 安装 Node 22
nvm install 22
# 4) 验证
node -v    # 应该显示 v22.x.x
```

---

## 3. 第 2 步：安装 DSH（DeepSeek Harness）

这是聊天界面的本体。用 npm 装它的 CLI：

```sh
npm install -g @deepseek-ai/dsh
```

> 如果这个包名不对（DSH 还在预发布阶段，安装方式可能变），以 DeepSeek Harness 官方文档为准。**装完验证一句话**：

```sh
dsh --version    # 能打印版本号就是装好了
```

---

## 4. 第 3 步：安装本插件（dsh-server-login）

```sh
# 1) 下载源码
git clone https://github.com/pointer-a/dsh-server-login.git
cd dsh-server-login

# 2) 装依赖 + 编译
npm install
npm run build
```

装完这个目录里会有个 `lib/`（编译产物）和 `node_modules/`（依赖）。

> **让子 DSH 能加载本插件的运行时插件**：本插件会通过 `--patch` 给每个用户的 DSH 挂一个运行时插件（负责注入「守护 DSH」上下文、绑定端口等）。前提是 `dsh-server-login` 要装进 DSH 的 profile：
>
> ```sh
> dsh plugin --profile web add /dsh_login/dsh-server-login
> ```
>
> 不做这步，运行时插件加载不了，守护 DSH 的上下文注入就不会生效。

---

## 5. 第 4 步：创建管理员账号

管理员是第一个账号，由他审核其他注册用户。

```sh
# 先加载环境变量（让数据库路径一致，见下面警告）
source /etc/dsh-server-login.env
node lib/cli.js bootstrap-admin --username admin --password '你的强密码'
```

- `--username admin`：管理员用户名（可换）。
- `--password '你的强密码'`：管理员密码（换成你自己的，别用弱密码）。

看到 `admin "admin" created (...)` 就成功了。

> ⚠️ **数据库路径必须全程一致**：管理员、编排服务、systemd 用的必须是**同一个数据库**。
> 本教程统一用 `<DATA_ROOT>/server-login.db`（= `/var/lib/dsh-server-login/server-login.db`），所以**建管理员和启动服务都不加 `--db`、都先 `source /etc/dsh-server-login.env`**。
> 如果你在某处加了 `--db 别的路径`，那建管理员和 systemd **必须加同一个路径**，否则登录不进。

---

## 6. 第 5 步：配置环境变量 + 启动编排服务

先写一个环境变量文件，把配置集中放一起，方便以后改：

```sh
cat > /etc/dsh-server-login.env <<'EOF'
DSH_SERVER_LOGIN_PORT=3080
DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login
DSH_SERVER_LOGIN_BASE_DOMAIN=dsh.example.com
DSH_SERVER_LOGIN_COOKIE_DOMAIN=.dsh.example.com
DSH_SERVER_LOGIN_SECURE_COOKIES=true
DSH_SERVER_LOGIN_DSH_BIN=/root/.nvm/versions/node/v22.23.2/bin/dsh
DEEPSEEK_API_KEY=sk-你的deepseek密钥
EOF
```

逐个解释：

| 变量 | 值 | 为什么 |
|---|---|---|
| `DSH_SERVER_LOGIN_PORT` | `3080` | 编排服务自己监听的端口（nginx 会转发到这个端口）。 |
| `DSH_SERVER_LOGIN_DATA_ROOT` | `/var/lib/dsh-server-login` | 每个用户的文件/配置存哪里。 |
| `DSH_SERVER_LOGIN_BASE_DOMAIN` | `dsh.example.com` | **关键**：告诉编排服务「子域名长什么样」——`<用户名>.dsh.example.com`。 |
| `DSH_SERVER_LOGIN_COOKIE_DOMAIN` | `.dsh.example.com` | **关键**：登录 cookie 加这个 `Domain`，才能被子域名共享。注意前面的**点**。 |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | `true` | 走 HTTPS，cookie 必须标 `Secure`。 |
| `DSH_SERVER_LOGIN_DSH_BIN` | `/root/.nvm/versions/node/v22.23.2/bin/dsh` | 编排服务用它启动每个用户的 DSH。**用绝对路径**，别写 `dsh`——systemd 的 PATH 找不到（否则报 `spawn dsh ENOENT`）。版本号按你实际 nvm 版本改：`ls ~/.nvm/versions/node/`。 |
| `DEEPSEEK_API_KEY` | 你的 key | 每个 DSH 进程会继承它，用于调 DeepSeek 模型。 |

### 6.1 先手动跑一次（验证能起来）

```sh
source /etc/dsh-server-login.env
node lib/cli.js
```

看到 `dsh-server-login listening on http://127.0.0.1:3080` 就是起来了。`Ctrl+C` 停掉，下面配成开机自启。

### 6.2 配成开机自启（systemd）

```sh
cat > /etc/systemd/system/dsh-server-login.service <<'EOF'
[Unit]
Description=DSH server login orchestrator
After=network.target

[Service]
WorkingDirectory=/root/dsh-server-login
EnvironmentFile=/etc/dsh-server-login.env
Environment=PATH=/root/.nvm/versions/node/v22.23.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/root/.nvm/versions/node/v22.23.2/bin/node lib/cli.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now dsh-server-login
systemctl status dsh-server-login   # 看到 active (running) 就对了
```

> 把 `WorkingDirectory` 换成你实际 `git clone` 的目录（上面假设是 `/root/dsh-server-login`）。

> ⚠️ **两个 nvm + systemd 必踩的坑**（不这样写就会起不来）：
> 1. **`ExecStart` 必须用 nvm node 的绝对路径**，不能写 `/usr/bin/env node`——systemd 的 PATH 没有 nvm，`node` 会解析到别的版本，导致 `better-sqlite3` 原生模块报 `ERR_DLOPEN_FAILED`（ABI 版本不匹配，编排服务起不来）。
> 2. **必须把 nvm 的 bin 加进 PATH**（上面那行 `Environment=PATH=...`）——否则编排服务 spawn 子 DSH 时 `dsh` 找不到（`spawn dsh ENOENT`），而且 `dsh` 脚本内部也是 `#!/usr/bin/env node`，同样需要 `node` 在 PATH。
> 上面所有 nvm 路径按你实际版本改：`ls ~/.nvm/versions/node/`。

---

## 7. 第 6 步：配置 DNS

登录你的域名商后台，加两条 **A 记录**，都指向服务器的 IP：

| 类型 | 主机记录 | 值 |
|---|---|---|
| A | `dsh` | 你的服务器 IP |
| A | `*.dsh` | 你的服务器 IP |

- `dsh` → 让 `dsh.example.com` 指向服务器。
- `*.dsh`（通配）→ 让 `carol.dsh.example.com`、`bob.dsh.example.com` 等任意子域名都指向服务器。

改完等几分钟 DNS 生效。验证（在本机跑，把 IP 换成你的服务器 IP）：

```sh
ping dsh.example.com      # 应该解析到你的服务器 IP
```

---

## 8. 第 7 步：签发 HTTPS 证书（通配证书）

子域名多、又不能挨个签，所以签一张**通配证书**（`*.dsh.example.com`）。通配证书必须用 **DNS 验证**（证明你真的拥有这个域名）。

以 Cloudflare 为例：

```sh
# 1) 装 Cloudflare 的 certbot 插件
apt install -y certbot python3-certbot-dns-cloudflare

# 2) 准备一个存 API 令牌的文件（去 Cloudflare 后台建一个 DNS 编辑权限的 token）
cat > /etc/cloudflare.ini <<'EOF'
dns_cloudflare_api_token = 你的token
EOF
chmod 600 /etc/cloudflare.ini

# 3) 签发（注意两条 -d：通配 + 主域）
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/cloudflare.ini \
  -d '*.dsh.example.com' -d 'dsh.example.com'
```

> 如果你不用 Cloudflare，改用对应插件（阿里云 `--dns-aliyun`、腾讯云 `--dns-tencentcloud`、DNSPod `--dns-dnspod` 等），原理一样。
*要注意cloudflare的免费套餐只提供托管二级及以下域名，若你的通配域名到了第三级，可以选择关闭cloudflare的代理，当然这会带来较大风险*
签好后证书在这里：

```sh
ls /etc/letsencrypt/live/dsh.example.com/
# 应看到 fullchain.pem 和 privkey.pem
```

---

## 9. 第 8 步：配置 nginx

先装 nginx：

```sh
apt install -y nginx
```

新建配置文件：

```sh
cat > /etc/nginx/conf.d/dsh-server-login.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# 主域：登录 / 管理台 / 桌面
server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host              $host;   # 关键：保留真实域名
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}

# 通配子域：每个用户的 DSH
server {
    listen 443 ssl http2;
    server_name *.dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host              $host;   # 关键：保留原始子域名
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
EOF
```

**最重要的两行**（做错就会各种 404/401）：

- `server_name dsh.example.com` 和 `server_name *.dsh.example.com`：区分主域和子域。
- `proxy_set_header Host $host`：**别删**，它把原始域名透传给编排服务，子域路由靠它。如果你写成 `Host dsh.example.com`（固定值）或干脆不写，所有子域都会被当成主域，路由就乱了。

改完重载：

```sh
nginx -t && systemctl reload nginx
```

---

## 10. 第 9 步：（可选）账号级硬隔离

> **新手可跳过这一步**，默认的「软隔离」已经能跑、能用。硬隔离是给生产环境防「一个用户偷看另一个用户文件」用的进阶项，需要 root 权限。想上再看 [security-model.md](security-model.md)。

---

## 11. 第 10 步：从头验证一遍

按这个顺序走一遍，每步看到对应结果就说明那一步对了：

1. **打开主域**：浏览器访问 `https://dsh.example.com` → 看到登录页（不是 502/404）。
2. **注册一个用户**：点「注册」，填用户名（比如 `carol`）+ 密码 → 提示「等待审核」。
3. **审核**：用管理员账号登录 → 管理台 → 点「通过」carol。
4. **用户登录**：carol 登录 → 进入桌面（文件浏览器）。
5. **启动 DSH**：桌面点「在此文件夹启动 DSH」→ 显示「运行中」。
6. **打开 DSH**：点「打开 DSH」→ 跳到 `https://carol.dsh.example.com/` → 看到 DSH 聊天界面（不是 502/404/401）。

> ⏳ **冷启动**：真实 DSH 启动要 **几秒到十几秒**（源码启动约 4s）。点「启动」后 `status` 会先显示 `running`，但端口要等插件树 boot 完才绑上——**别立刻点「打开 DSH」，等 10 秒再开**，否则会 502。

### 如果某一步卡住了

对照 [troubleshooting.md](troubleshooting.md) 找现象 → 根因 → 修法。最常见的几个：

- 502：DSH 刚启动还在「冷启动」（等 10 秒），或 DSH 没起来。
- 404：`BASE_DOMAIN` 没设、或 nginx 的 `Host` 头被改掉了。
- 401：cookie 没到子域（`COOKIE_DOMAIN` 没设或没带前导点），或浏览器里是旧 cookie（删掉重新登录）。
- 403：DSH 的信任栅栏不认请求（`Origin` 头问题，已在内置代理里处理）。

---

## 12. 以后怎么更新插件

```sh
cd /root/dsh-server-login
git pull
npm run build            # 重新编译（改过代码就必须跑）
systemctl restart dsh-server-login
```

> 重要：**光 `git pull` 不够**，一定记得 `npm run build`——因为跑的是编译产物 `lib/`，不编译的话改动不会生效。
