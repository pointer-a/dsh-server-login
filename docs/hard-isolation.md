# 硬隔离教程（新手版）— 每用户独立 OS 账号

> 本教程是 [deployment.md](deployment.md) 的进阶篇。先按那篇把整套跑通、能正常登录和打开 DSH，再回来做这个。
> 全文用 `example.com` 举例，请替换成你自己的域名；`/root/dsh-server-login` 换成你实际 `git clone` 的目录。

## 0. 为什么需要硬隔离（先看懂再动手）

默认部署是**软隔离**：所有用户的 DSH 进程跑在**同一个系统账号（root）**下，每个用户自己的目录设了 `0700`（只有本人能进）。

问题是：`0700` 只对**别的系统账号**有效。同一个 root 账号下的进程之间，**权限检查形同虚设**——一个用户（的 DSH 进程）可以用 root 直接读另一个用户的文件。

**硬隔离**就是：给每个用户建一个**独立的 Linux 系统账号**，让它的 DSH 进程以这个账号运行。这样：

- `0700` 才真正生效（别的账号进不来）。
- 用户 A 的 DSH 进程，即使用户 B 的目录是 `0700`，也会被系统直接拒绝。

**代价**：需要 root 权限 + 每个用户创建时要做一次「建账号 + 改属主」。好在可以自动化（见 §3.1），一次配好就不用管。

---

## 1. 确认编排服务已用 root 运行

硬隔离要靠 `setpriv` 把进程降权到目标账号，这**只有 root 能调用**。所以编排服务必须以 root 跑。

如果你用了 [deployment.md](deployment.md) 的 systemd 配置（`/etc/systemd/system/dsh-server-login.service`），默认就是 root，跳过这步。

---

## 2. 打开账号级隔离的开关

在环境变量文件里加两个配置（`/etc/dsh-server-login.env`）：

```sh
# 追加这两行
DSH_SERVER_LOGIN_ISOLATION_MODE=account
DSH_SERVER_LOGIN_BASE_UID=100000
```

| 变量 | 值 | 解释 |
|---|---|---|
| `DSH_SERVER_LOGIN_ISOLATION_MODE` | `account` | 开启账号级隔离（默认 `soft`）。 |
| `DSH_SERVER_LOGIN_BASE_UID` | `100000` | 每个用户 uid 的「起始数字」。系统 uid 一般 < 1000，这里从 10 万开始，避免撞系统账号。 |

改完**重启编排服务**让配置生效：

```sh
systemctl restart dsh-server-login
```

> 从这一刻起，编排服务 spawn 每个用户的 DSH 时，会用它内置的 `setpriv` 命令（`setpriv --reuid <uid> --regid <uid> --inh-caps=-all --clear-groups --`）把进程降权到该用户账号。

---

## 2.1 ⚠️ 前置：`dsh` 必须装在降权账号能读到的位置（不能装在 `/root` 下）

硬隔离降权后，子 DSH 以每用户账号（uid > 100000）运行，这些账号**读不到 root 的 home 目录 `/root`**。

如果 `dsh`（以及它依赖的 node）是用 nvm 装在 `/root/.nvm/...` 下的（默认就是），开了 `account` 之后，子 DSH 一启动就会报 `Cannot find module '/root/.nvm/.../bin/dsh'`，然后**每秒崩溃循环**。日志长这样：

```
[dsh-child main] node:internal/modules/cjs/loader:1210
Error: Cannot find module '/root/.nvm/versions/node/.../bin/dsh'
```

**所以开 §2 的开关之前，先把 node + dsh 装到系统级位置**（所有账号都能读）：

```sh
# 1) 系统级安装 node 22（装到 /usr/bin）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 2) 系统级安装 dsh（注意：必须强制 prefix，否则会被 nvm 劫持装回 /root）
NPM_CONFIG_PREFIX=/usr/local /usr/bin/npm install -g @deepseek-ai/dsh
ls -l /usr/local/bin/dsh      # 必须是 /usr/local/bin/dsh，不能在 /root 下

# 3) 环境变量指向系统 dsh
#    /etc/dsh-server-login.env → DSH_SERVER_LOGIN_DSH_BIN=/usr/local/bin/dsh

# 4) systemd 的 PATH 去掉 /root/.nvm/...，改成系统路径
#    （子 DSH 的 #!/usr/bin/env node 才找得到系统 node）
#    /etc/systemd/system/dsh-server-login.service：
#    Environment=PATH=/usr/bin:/usr/local/bin:/usr/sbin:/usr/local/sbin:/sbin:/bin
```

> **nvm 劫持 npm 的坑**：即使你用 `/usr/bin/npm`，它仍可能装到 `/root/.nvm/...`——因为 `/root/.npmrc` 里被 nvm 写了 `prefix=/root/.nvm/versions/node/...`。检查：`/usr/bin/npm prefix -g`（返回 nvm 路径就是被劫持了）。解决：命令前加 `NPM_CONFIG_PREFIX=/usr/local` 强制覆盖。

> **另一个降权后读不到的东西**：运行时插件 `dsh-server-login/runtime` 在 `git clone` 的目录（如 `/dsh_login/dsh-server-login/lib/`）里，降权账号也要能读到。检查 `ls -ld /dsh_login`，如果是 `drwx------`（只有 root），执行 `chmod 755 /dsh_login`。

---

## 3. 为每个用户创建系统账号（核心一步）

这是**唯一需要手动做的事**：用户注册后，要先给他建系统账号 + 把他目录改成这个账号所有，硬隔离才完整。**没做这一步，DSH 会以 root 运行（跟没开硬隔离一样）。**

创建脚本（`provision-user.sh`，root 运行）：

```bash
#!/usr/bin/env bash
# 用法：provision-user.sh <userId>     （userId 就是数据库里 users 表的 id，管理员界面能看到）
set -euo pipefail

uid="$(dsh-server-login uid-for-user "$1")"
user="dsh-$1"

# 1) 创建系统账号（uid 用插件算出来的同一个值，保证两边一致；不建 home、不能登录）
useradd -u "$uid" -M -s /usr/sbin/nologin "$user"

# 2) 把该用户的目录改成这个账号所有（关键！）
chown -R "$uid:$uid" "/var/lib/dsh-server-login/users/$1"

echo "provisioned $1 -> uid $uid"
```

怎么执行：

```sh
chmod +x provision-user.sh
./provision-user.sh <userId>
```

**userId 从哪拿**：用管理员登录 → 管理台 → 用户列表里那个 id（或直接查库，见 [troubleshooting.md](troubleshooting.md) 的「查看管理员账号」一节）。

### 3.1 让它自动跑（不用每次手动）

每个用户注册后都手动跑一次太麻烦，这里给几个**自动触发**方案，按你服务器的环境挑一个：

**方案 A：systemd 监控目录（最简单，无需额外软件）**

把上面那个脚本存成 `/usr/local/bin/provision-user.sh`，然后用 systemd 的路径监控：**每当某个用户的目录被创建（即注册成功），就自动跑一次脚本**。

`/etc/systemd/system/dsh-provision.path`：

```ini
[Unit]
Description=Watch new user dirs and provision OS accounts

[Path]
PathExistsGlob=/var/lib/dsh-server-login/users/*/home
Unit=dsh-provision.service

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/dsh-provision.service`：

```ini
[Unit]
Description=Provision a newly registered user
After=dsh-server-login.service

[Service]
Type=oneshot
# 找出刚注册、还没建账号的用户，挨个建
ExecStart=/usr/local/bin/provision-new-users.sh
```

`/usr/local/bin/provision-new-users.sh`（核心：遍历所有用户目录，没建账号的先建，然后**每次都 chown**）：

```bash
#!/usr/bin/env bash
set -euo pipefail
for dir in /var/lib/dsh-server-login/users/*/; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  user="dsh-$id"
  if ! id "$user" &>/dev/null; then
    # 账号不存在才建（uid 用插件算出来的同一个值，保证两边一致）
    uid="$(dsh-server-login uid-for-user "$id")"
    useradd -u "$uid" -M -s /usr/sbin/nologin "$user"
  fi
  uid="$(id -u "$user")"          # 账号已存在就复用它的 uid
  chown -R "$uid:$uid" "$dir"     # 每次都 chown（幂等，把漏掉的属主补上）
  echo "provisioned $id -> uid $uid"
done
```

> ⚠️ **别写「账号已存在就跳过」**：那样会连 chown 一起跳过——如果某用户的目录后来变成 root 所有，重跑也不会修，他的 DSH 还是会因为读不了自己 home 而崩（外网 502）。所以 chown 要放在判断**外面**、每次都执行。

启用：

```sh
systemctl daemon-reload
systemctl enable --now dsh-provision.path
```

这样以后**用户一注册，目录一出现，systemd 就自动建账号 + 改属主**，管理员不用再管。

**方案 B：定时任务（简单粗暴，隔几分钟扫一次）**

如果不想用 systemd 的 path 监控，就用 cron 每 5 分钟跑一遍同一个 `provision-new-users.sh`（幂等，跑多少次都安全）：

```sh
crontab -e
# 加一行：
*/5 * * * * /usr/local/bin/provision-new-users.sh
```

**方案 C：手动（用户少时够用）**

用户少、注册不频繁，管理员有空就手动跑 `./provision-user.sh <userId>` 也行。**但别忘了**——漏一个 = 那个用户还在 root 下跑，等于没隔离。

> **推荐**：方案 A 最省心、自动、幂等，一次配好就不用管。

---

## 4. 验证硬隔离真的生效

**第 1 步：看 DSH 进程的 uid。**

先在桌面启动一个用户的 DSH，然后：

```sh
# 找到 DSH 进程
ps aux | grep dsh | grep -v grep

# 假设拿到了 pid，看它的真实 uid
ps -o uid,user,cmd -p <pid>
```

**应该看到**：`uid` 等于 `dsh-server-login uid-for-user <那个userId>`（是一个 >100000 的账号），**不是** 0（root）。如果显示 0，说明没降权，回头检查第 2、3 步。

**第 2 步：越权读测试（最关键）。**

```sh
# 1) 在用户 A 的 home 里放个文件
echo "secret" > /var/lib/dsh-server-login/users/<A的id>/home/s.txt
chmod 600 /var/lib/dsh-server-login/users/<A的id>/home/s.txt

# 2) 用用户 B 的 DSH 去读它（在 B 的 DSH 里执行 cat）
# 正确结果：Permission denied（读不到）
```

看到 `Permission denied` = 硬隔离生效。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| DSH 还是以 root 跑 | `ISOLATION_MODE=account` 没生效（重启了吗？）、或该用户没跑 provision-user.sh。 |
| `setpriv: no permission` 报错 | 编排服务没以 root 运行。 |
| 新用户启动 DSH 报权限错误 | 该用户目录 chown 了吗？重新跑 provision-user.sh。 |
| 忘了给某个用户做第 3 步 | 补跑，然后重启该用户的 DSH。 |
| DSH 每秒崩溃，日志 `Cannot find module '/root/.nvm/.../bin/dsh'` | `dsh` 装在 `/root` 下，降权账号读不到。按 §2.1 把 dsh 装到系统级位置。 |
| `/usr/bin/npm install -g` 还是装到 `/root/.nvm` | npm 全局前缀被 nvm 劫持（`/root/.npmrc` 里的 `prefix`）。用 `NPM_CONFIG_PREFIX=/usr/local` 强制覆盖。 |

---
