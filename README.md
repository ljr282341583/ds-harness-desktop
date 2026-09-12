# DS Harness Desktop

> DeepSeek Harness（DSH）的桌面版 —— 把 `dsh` 这个 Agent Harness 从「浏览器 Web GUI」形态封装为 Windows 桌面应用：原生窗口 + 系统托盘，后端仍是官方 `dsh`，工具链与 web 版完全一致。

## 主要功能

| 能力 | 说明 |
|---|---|
| 原生桌面窗口 | 把 `dsh web` 的界面装进独立窗口，不再占用浏览器标签页；关窗口 = 最小化到托盘 |
| 系统托盘常驻 | 托盘菜单提供 显示窗口 / 重启服务 / 检查 dsh 更新 / 更新通道 / 检查桌面端更新 / 回到内置版本 / 打开数据目录 / 退出 |
| 完整工具链 | 与 web 版一致：bash/pwsh 终端、文件系统、subagent、workflow、goal、skills 等 |
| 复用现有数据 | 直接复用本机 `~/.dsh`，API Key、会话、skills、profiles 无需重新配置，与 CLI / web 版共享 |
| 单实例与端口自适应 | 二次启动只聚焦已有窗口；默认 3080，被占用时自动改用 3081+；检测到已有 DSH 实例则直接复用，避免双实例并发写坏数据 |
| 一键更新 dsh 本体 | 托盘「检查 dsh 更新」：检测官方 `@deepseek-ai/dsh` 新版本并即时安装，**不需要重新安装桌面端** |
| 桌面端自更新 | 托盘「检查桌面端更新」：从 GitHub Releases 检查并安装本程序的新版本 |
| 开箱即用 | 单文件内置 Electron、Node 24 侧车与 dsh 全部依赖，**无需安装任何运行时** |

## 下载

成品发布在 [GitHub Releases](https://github.com/ljr282341583/ds-harness-desktop/releases)，二选一即可（内容相同，仅打包形态不同）：

| 版本 | 下载 | 说明 |
|---|---|---|
| 安装版（推荐） | [DS-Harness-Desktop-Setup-0.3.3.exe](https://github.com/ljr282341583/ds-harness-desktop/releases/download/v0.3.3/DS-Harness-Desktop-Setup-0.3.3.exe) | 向导安装（**可自选安装目录**），带开始菜单 / 桌面快捷方式 / 卸载入口；**支持托盘一键自更新** |
| 便携版 | [DS-Harness-Desktop-0.3.3-portable.exe](https://github.com/ljr282341583/ds-harness-desktop/releases/download/v0.3.3/DS-Harness-Desktop-0.3.3-portable.exe) | 免安装单文件，双击即用，适合拷贝分发；每次启动需自解压，且**无法原地自更新**（会引导手动下载新文件） |

> 想找历史版本或全部资产（含 `latest.yml`），见 [Releases 列表](https://github.com/ljr282341583/ds-harness-desktop/releases)。

> 安装包未做代码签名，被 SmartScreen 拦截时点「更多信息 → 仍要运行」。

## 使用说明

### 首次使用

1. 双击下载的安装版（或便携版）启动。
2. 先出现「正在启动 DeepSeek Harness…」加载页，随后自动加载 DSH 的界面。
   冷启动需要初始化 profile，可能十几秒到一分钟不等，属正常现象。
3. 在界面 **Settings → Models** 填入自己的 DeepSeek API Key（复用本机 `~/.dsh`，与 web 版一致）。
4. 若被 SmartScreen 拦截：点「更多信息 → 仍要运行」。

### 日常操作

| 操作 | 怎么做 |
|---|---|
| 关窗口但不退出 | 点窗口右上角 ✕ → 最小化到托盘，后台常驻 |
| 从托盘唤回窗口 | 单击托盘图标，或右键 → 显示窗口 |
| 真正退出 | 托盘右键 → 退出（会一并干净结束 dsh 子进程） |
| 服务卡死 / 异常 | 错误页点「重启服务」，或托盘右键 → 重启服务 |
| 端口占用 | 默认用 3080；若已被别的程序占用则自动用 3081+ |
| 与浏览器版同开 | 若 3080 已有 DSH 在跑，桌面版直接复用该实例，不再新开 |
| 重复启动 | 只聚焦已有窗口（单实例锁），不会开两个 |

### 更新

托盘里有两个不同的更新入口，分别管两层：

| 菜单项 | 更新对象 | 是否需要联网到 GitHub |
|---|---|---|
| 检查 dsh 更新 | 官方 DeepSeek Harness 本体 | 否（走 npm 镜像） |
| 检查桌面端更新 | 桌面端程序自身（外壳） | 是 |

配套菜单项：

| 菜单项 | 作用 |
|---|---|
| 更新通道 | `官方推荐（stable）` 跟官方 `latest` 标签；`尝鲜（preview）` 跟 `next` 标签 |
| 回到内置版本 | 把 dsh 切回随安装包捆绑的版本，不想用新版本时用它 |
| 打开数据目录 | 打开应用数据目录（含已下载的 dsh 版本与运行日志） |

行为说明：

- **dsh 更新是安全的**：新版本会先通过启动冒烟验证才启用；任一步失败都会丢弃新版本、保留原版本。
  若新版本装了却启动不起来，程序会自动回退到内置版本并重启一次。
- **不影响你的数据**：更新只写入应用自己的数据目录，不触碰 `~/.dsh` 里的密钥、会话、skills 与 profiles。
- **磁盘占用**：只保留当前版本与上一个可用版本，其余自动清理。
- **「稍后」的含义**：桌面端更新下载完后如果选「稍后」，会暂不安装；托盘里会出现
  「重启并安装 vX」，想装的时候点它（安装前会先干净停掉 dsh 服务）。
- **便携版差异**：便携版每次启动都会自解压到临时目录，无法在原地替换自己，因此「检查桌面端更新」会引导你从发布页下载新的便携版文件；dsh 本体更新在两种形态上都能用。

### 常见问题

| 现象 | 处理 |
|---|---|
| 一直停在「正在启动…」 | dsh 首次初始化可能较慢，等 10~60 秒；仍不行则托盘「重启服务」 |
| 显示「服务不可用」 | 先点错误页的「重启服务」；若反复出现，多半是 `~/.dsh/profiles` 里的第三方插件与当前 dsh 版本不兼容（dsh 启动会直接退出）。可查看 `%APPDATA%\ds-harness-desktop\dsh-child.log`，日志里会指明是哪个插件；临时办法是先在 profile 里移除该插件 |
| 检查更新提示已是最新 | `stable` 通道跟官方 `latest` 标签，官方未提升该标签时就显示已是最新；想尝鲜可切到 `preview` |
| 更新下载很慢 | 安装包约 213 MB，且需访问 GitHub；网络受限时可能超时 |
| **更新后应用打不开** | 从 [Releases](https://github.com/ljr282341583/ds-harness-desktop/releases/latest) 重新下载最新安装包再装一次即可修复（只覆盖程序文件，不会动 `~/.dsh` 里的会话与密钥）。v0.3.1 的自动更新曾出现装坏的情况，v0.3.2 已修 |
| 窗口关了找不到 | 它在托盘里，单击托盘图标唤回 |

## 从源码构建

本仓库只含**源码**，不含编译好的安装包（`产出\`、`node_modules\`、`runtime\` 均不入库）。

1. 安装依赖：`cd app && npm ci`（按 lockfile 精确安装，勿用 `npm install`）
2. 准备侧车运行时（`app\runtime\`，须含 npm）：`powershell -ExecutionPolicy Bypass -File app\scripts\prepare-runtime.ps1`
3. 开发运行：`cd app && npm start`
4. 打包：`cd app && npm run build`（产物输出到 `产出\`）
5. 更新器测试：`cd app && npm test`（离线单测）；`npm run test:e2e` 追加真实下载安装 + 冒烟验证

> 拿到成品后如何使用见 `docs\使用方法.md`；如何把成品分发给别人见 `docs\分发说明.md`；设计与决策见 `docs\设计方案.md`。

## 更新与发布

| 层 | 入口 | 更新对象 | 是否需要发新版本 |
|---|---|---|---|
| dsh 本体（A 层） | 托盘「检查 dsh 更新」 | 官方 `@deepseek-ai/dsh` | 不需要，运行时直接更新 |
| 桌面端外壳（B 层） | 托盘「检查桌面端更新」 | 本程序自身 | 需要，但打 tag 即自动发布 |

**发布新版本**：

```sh
git tag v0.3.1
git push origin v0.3.1
```

GitHub Actions（`.github/workflows/release.yml`）会同步版本号、安装依赖、准备 Node 24 侧车（含 npm）、跑更新器单测，然后打包并把 NSIS 安装器、便携版与 `latest.yml` 发布到 Releases。

> 客户端要求仓库公开，且 Release 必须包含 `latest.yml`（由 CI 自动上传，手动上传 exe 是不够的）。
> 日常的 dsh 版本升级**不需要**发新外壳。

## 目录说明

| 目录/文件 | 用途 | 是否入库 |
|---|---|---|
| `README.md` | 项目说明与构建指引 | ✅ |
| `docs\设计方案.md` | 需求、决策树、架构与实现要点 | ✅ |
| `docs\使用方法.md` | 成品使用说明 | ✅ |
| `docs\分发说明.md` | 成品分发说明 | ✅ |
| `过程记录\` | 进度日志，每次会话追加 `YYYY-MM-DD-主题.md` | ✅ |
| `app\` | Electron 壳源码 + 打包配置 + 更新器 + 测试 | ✅ |
| `app\scripts\prepare-runtime.ps1` | 准备侧车运行时（Node 24 + npm） | ✅ |
| `.github\workflows\release.yml` | 打 tag 自动打包并发布 | ✅ |
| `产出\` | 构建产物（安装包/便携版），发布走 GitHub Releases | ❌ 不入库 |
| `app\node_modules\`、`app\runtime\` | 依赖与侧车运行时 | ❌ 不入库 |

## 项目信息

- 项目名称：DS Harness Desktop（ds-harness-desktop）
- 创建日期：2026-08-14
- 项目目标：为 DeepSeek Harness（`@deepseek-ai/dsh`，Node.js + Cordis 插件化 Agent Harness）提供一个桌面端形态。DSH 以 `dsh web` 启动本地 Web 服务器（webserver + 前端静态资源 + apiproxy），桌面版把这套能力装进原生窗口，并保留完整工具链。
- 当前状态：v0.3.0 已发布（NSIS 安装器 + portable 便携版；含托盘/生命周期/Node 24 侧车、应用内 dsh 一键更新、桌面端自更新）
- 验收标准：见 `docs\设计方案.md` 第 6 节

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-14 | 项目立项；完成需求访谈、搭壳、冒烟测试、打包（NSIS + portable）、补图标、写使用方法文档 |
| 2026-08-15 | 修复数据污染：spawn dsh 显式指定 cwd；启动前探测 3080 已有实例则直接复用，杜绝双实例并发写 `~/.dsh` |
| 2026-08-17 | 源码验证运行通过；补齐 Node 24 侧车并重新打包；发布 v0.1.0 |
| 2026-08-22 | P0 修复：`@deepseek-ai/dsh` 改为精确版本并重新生成 lockfile；`afterPack` 增加依赖守卫（拒绝含 `compression: none` 的 dsh-base 构建，防止读不了 zstd 历史会话闪退）；安装依赖改用 `npm ci` |
| 2026-08-23 | 发布 v0.1.1：P0 依赖修复（闪退）+ 不再自动打开系统浏览器（`--no-open`） |
| 2026-09-10 | 发布 v0.2.0：内置 dsh 升到 `0.1.5-rc.1`；主进程解析子进程输出的带 token 启动地址并据此加载（新版 Web UI 强制 token 鉴权）；复用已有实例时识别 401 并给出提示 |
| 2026-09-12 | 发布 v0.3.0：新增两层更新能力。① dsh 本体：托盘「检查 dsh 更新」检测官方新版本并即时安装，含版本通道（stable/preview）、兼容守卫、启动冒烟验证、失败回滚与自动回退内置版本；② 桌面端自身：`electron-updater` + GitHub Releases 自更新；新增 `.github/workflows/release.yml`，打 tag 自动打包发布（含 `latest.yml`）。修复冷启动鉴权失败（等待 token 地址上限 30s → 120s，迟到 token 自动重载）。侧车运行时改为须含 npm |
| 2026-09-12 | 仓库转为公开：客户端可匿名拉取 Release 与更新清单（公开前已扫描提交历史与工作区，未发现密钥/令牌） |
| 2026-09-12 | 修复发布形态：`publish` 段显式指定 `releaseType: release`，避免 electron-builder 默认把 Release 建成草稿（草稿对客户端不可见，会导致「检查桌面端更新」永远拉不到新版本） |
| 2026-09-13 | 发布 v0.3.1：日志按大小轮转（上限 5 MB，保留 `.1` 备份），避免长期运行把日志撑满磁盘；冒烟验证不再把调用方的完整环境变量交给新下载的包，改为最小环境白名单；明确「稍后」= 退出应用时自动安装；CI 增加「写入 Release 说明」（取 tag 注释），修掉此前 Release 正文为空的退化 |
| 2026-09-13 | 发布 v0.3.2：**修复自动更新会把应用装坏**的问题 —— 安装器启动前先等 dsh 子进程真正退出（此前安装器与正在退出的进程抢安装目录里的文件，导致「删了旧文件没装回新文件」）；改用 oneClick 静默安装（向导式 + 自选安装目录在 electron-updater 的 `--updated` 流程下不可靠）；不再在退出应用时静默安装，安装只在用户确认时进行；补「更新后打不开」的恢复说明 |
| 2026-09-13 | 发布 v0.3.3：撤销 v0.3.2 的 oneClick 改动，恢复**向导式安装 + 可自选安装目录**（根因是停机竞态，已由 stopHarnessAndWait 修复，不必牺牲这个能力） |
