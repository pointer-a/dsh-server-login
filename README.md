# dsh-server-login

DSH 服务端登录插件 —— 一个面向公网的多租户托管平台，让用户通过域名安全访问自己的 DeepSeek Harness（DSH）实例。

## 这是什么

把本插件部署到一台公网服务器后，多个用户可以注册并由管理员审核，各自获得一套**相互隔离**的 DSH 环境（主 DSH + 守护 DSH）。用户登录后进入一个简单桌面，浏览自己的文件、按文件夹启动 DSH、选择启用哪些插件。默认通过域名访问，并预留自定义域名 + nginx 配置接口。

## 运行形态

- **主入口**是独立命令行 `dsh-server-login`：它启动一个 Fastify 服务 + SQLite 数据库，并用 `child_process` 按用户拉起各自的 DSH 进程对。
- 根 `package.json` 的 `dsh` 字段 + `cordis.patch.yml` 只是让 DSH 插件市场把它识别/安装为 cordis 插件；其 `apply()` 是**带守卫的空操作**，不会在任意 profile 里起服务器。

## 快速开始（脚手架）

```sh
npm install
npm run build          # tsc → lib/
node lib/cli.js --port 0 --db ./dev.local.db
```

访问 `http://127.0.0.1:<port>/`（admin/desktop 为占位页）。`GET /api/auth/me` 当前返回 401（认证骨架）。

## 配置

| 参数 | 环境变量 | 默认 |
|---|---|---|
| `--port` | `DSH_SERVER_LOGIN_PORT` | `3080` |
| `--host` | — | `127.0.0.1` |
| `--db` | — | `<dataRoot>/server-login.db` |
| `--data-root` | `DSH_SERVER_LOGIN_DATA_ROOT` | `~/.dsh-server-login` |
| `--dsh-bin` | — | `dsh` |

生产部署建议 `DSH_SERVER_LOGIN_DATA_ROOT=/var/lib/dsh-server-login`（每用户 home 在此目录下，`0700`）。

## 安全声明（重要）

当前为**软隔离**：每用户独立 `$DSH_HOME` + session `cwd` + 沙箱写隔离，读靠目录 `0700` 权限。**已知缺口**：编排服务与所有每用户 DSH 跑在同一 OS 账号下，`0700` 挡不住同 UID 进程的越权读。硬隔离（每用户 OS 账号/容器、收窄 Landlock 读授权）是后续阶段 P7。详见 [docs/security-model.md](docs/security-model.md)。

## 分阶段路线

见 [docs/roadmap.md](docs/roadmap.md)。完整技术设计见 [docs/blueprint.md](docs/blueprint.md)。域名与 nginx 配置示例见 [docs/domain-config.md](docs/domain-config.md)。性能占用与冷启动实测见 [docs/performance.md](docs/performance.md)。

## 发布

本仓库按 DSH 插件市场的 [STANDARD.md](STANDARD.md) 以 **cordis-plugin（产物型）** 形态分发：提交 `lib/`（构建产物），`main` 指向 `lib/index.js`，`prepare` 脚本供 git 安装时自构建。发布前请替换 `package.json` 里的 `repository.url` 为真实仓库地址，并确认 `name` 在 npm 上唯一。
