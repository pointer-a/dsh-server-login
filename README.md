# dsh-server-login

面向公网的多租户 DSH 托管平台 —— 部署到一台公网服务器后，多个用户注册并经管理员审核，各自获得一套**相互隔离**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）环境，随时通过域名安全访问。

> 以 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的 cordis-plugin 形态分发，遵守 [STANDARD.md](STANDARD.md)。

## 它解决什么

DSH 本身是单用户本地工具，没有认证、没有多租户隔离、Web 远程访问缺认证层。`dsh-server-login` 在其之上补一层**服务端登录 + 多租户编排**：管理员审核注册用户，每个用户落到自己的文件桌面，按文件夹启动 DSH、选择启用哪些插件，通过域名访问，且彼此文件隔离（目前暂未适配手机）。

## 核心能力

- **登录与审核**：管理员先行（`bootstrap-admin`），用户注册后需管理员审核通过；独立管理台 UI。
- **每用户隔离的 DSH 环境**：主 DSH 负责正常工作；崩溃时**按需拉起一次守护 DSH** 修复并自动重启；装插件重启时守护执行主 DSH 给出的 post-restart 命令。
- **登录桌面**：文件浏览 / 建文件夹 / 上传；按文件夹启动 DSH；每文件夹独立勾选启用的插件（持久化并注入 cordis patch）。
- **域名访问**：默认域名 + 每用户子路径 `/u/<userId>/dsh/`；自定义域名 + nginx 配置生成接口。
- **硬隔离**（Linux）：每用户独立 OS 账号（`setuid` 降权），`0700` 目录真正隔离跨用户读。

## 架构总览

```
用户浏览器 → nginx(TLS) → 编排服务(Fastify + SQLite，单进程)
                              ├─ 认证 / 审核 / 桌面 / 域名 API
                              └─ /u/<userId>/dsh/* → 子 DSH(127.0.0.1:动态端口)
每用户子 DSH（主 + 按需守护）只绑回环端口，由编排服务反向代理对外。
```

编排服务以 `child_process` 按用户 spawn DSH 子进程，端口随机分配、崩溃自动重启。完整设计见 [docs/blueprint.md](docs/blueprint.md)。

## 快速开始

```sh
npm install
npm run build                                        # tsc → lib/
node lib/cli.js bootstrap-admin --username admin --password '<强密码>' --db ./dev.local.db
node lib/cli.js --port 3080 --db ./dev.local.db
```

访问 `http://127.0.0.1:3080/`：登录 / 注册 / 管理台 / 桌面（详细部署流程见 [docs/deployment.md](docs/deployment.md)）。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SERVER_LOGIN_PORT` | `3080` | 编排服务绑定端口 |
| `DSH_SERVER_LOGIN_DATA_ROOT` | `~/.dsh-server-login` | 每用户 home/workspace 根（生产 `/var/lib/dsh-server-login`） |
| `DSH_SERVER_LOGIN_DSH_BIN` | `dsh` | 子 DSH 可执行 |
| `DSH_SERVER_LOGIN_ISOLATION_MODE` | `soft` | `soft` 软隔离 / `account` 账号级硬隔离（Linux，需 root） |
| `DSH_SERVER_LOGIN_BASE_UID` | `100000` | 账号级隔离的 uid 基数 |
| `DSH_SERVER_LOGIN_SECURE_COOKIES` | `false` | HTTPS 部署设为 `true` |
| `DSH_SERVER_LOGIN_PLUGINS` | — | 可用插件目录（JSON 数组） |

其余可调项（`dshCommand`、`spawnAsUserCommand`、`restartBackoffMs`、`sessionTtlSeconds`、`maxUploadBytes` 等）见 `src/config.ts` 与各文档。

## 文档

- [docs/blueprint.md](docs/blueprint.md) — 技术设计（拓扑 / 数据模型 / API / 双 DSH）
- [docs/deployment.md](docs/deployment.md) — Linux 生产部署（账号级隔离 / nginx / systemd）
- [docs/domain-config.md](docs/domain-config.md) — 域名与 nginx 配置示例
- [docs/troubleshooting.md](docs/troubleshooting.md) — 常见问题排查（502 / 404 / SSL / 401 / 端口冲突）

## 安全

默认**软隔离**（每用户 `$DSH_HOME` + session `cwd` + 沙箱写隔离）。Linux 生产部署建议开启**账号级硬隔离**（每用户 OS 账号，闭合同 UID 越权读）。详见 [docs/deployment.md](docs/deployment.md)。

## 发布与市场收录

以 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的 **cordis-plugin（产物型）** 形态分发（[STANDARD.md](STANDARD.md)）。当前状态：

- 仓库：`github.com/pointer-a/dsh-server-login`（**public**，已加 topic `dsh-plugin`）
- npm 包名 `dsh-server-login`（未被占用）
- **STANDARD §7 自测 14 项全部通过**：cordis 插件判定（`dsh` 字段 + `dsh.bundle.patch`）、产物型 `main` 存在、无根 install 脚本、`dependencies` 无宿主包、描述无分类敏感词、版本 semver、披露 D1/D3/D4 齐全、MIT 许可
- 市场 CI 每 2 小时扫描一次 `dsh-plugin` topic 自动收录（最近一次推送后等待扫描周期）

> 每次发版请 **bump `version`**（市场用它对「更新」检测），并重新确认披露字段与实际行为一致。

## 许可证

[MIT](LICENSE)
