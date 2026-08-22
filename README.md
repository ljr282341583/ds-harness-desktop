# DS Harness Desktop

> DeepSeek Harness（DSH）的桌面版 —— 把 `dsh` 这个 Agent Harness 从「浏览器 Web GUI」形态封装为桌面应用。

## 项目信息

- 项目名称：DS Harness Desktop（ds-harness-desktop）
- 创建日期：2026-08-14
- 项目目标：为 DeepSeek Harness（`@deepseek-ai/dsh`，Node.js + Cordis 插件化 Agent Harness）提供一个桌面端形态。当前 DSH 以 `dsh web` 启动本地 Web 服务器（webserver + 前端静态资源 + apiproxy），在浏览器 `http://127.0.0.1:3080` 使用；桌面版目标是把这套能力装进原生窗口应用，保留完整工具链（bash/pwsh 终端、文件系统、subagent、workflow、goal 等）。
- 当前状态：已完成（v0.1.0 交付：NSIS 安装器 + portable 便携版，含托盘/生命周期/Node 24 侧车/图标）
- 验收标准：见 `docs\设计方案.md` 第 6 节（全部通过）

## 下载（v0.1.0）

编译好的成品发布在 [GitHub Releases](https://github.com/ljr282341583/ds-harness-desktop/releases/tag/v0.1.0)，二选一即可（内容相同，仅打包形态不同）：

| 版本 | 下载 | 说明 |
|---|---|---|
| 安装版 | [DS.Harness.Desktop.Setup.0.1.1.exe](https://github.com/ljr282341583/ds-harness-desktop/releases/download/v0.1.1/DS.Harness.Desktop.Setup.0.1.1.exe) | 向导安装，带开始菜单/桌面快捷方式/卸载入口 |
| 便携版 | [DS.Harness.Desktop-0.1.1-portable.exe](https://github.com/ljr282341583/ds-harness-desktop/releases/download/v0.1.1/DS.Harness.Desktop-0.1.1-portable.exe) | 免安装单文件，双击即用，适合拷贝分发（每次启动需自解压约 2 分钟） |

> 单文件已内置 Electron、Node 24 侧车、dsh 及全部依赖，**无需安装任何运行时**。首次使用在界面 Settings → Models 填自己的 DeepSeek API Key（复用本机 `~/.dsh`）；被 SmartScreen 拦截时点「更多信息 → 仍要运行」。

## 快速上手（从源码）

本仓库只含**源码**，不含编译好的安装包（`产出\`、`node_modules\`、`runtime\` 均不入库，需按下面步骤准备；也可直接从上方 Releases 下载成品）。

1. 安装依赖：`cd app && npm ci`（按 lockfile 精确安装，勿用 `npm install`）
2. 准备 Node 24 侧车（`app\runtime\`）：按 `app\README.md` 的「首次准备」下载
3. 开发运行：`cd app && npm start`
4. 打包安装包：`cd app && npm run build`（产物输出到 `产出\`）

> 拿到编译好的成品后如何使用，见 `docs\使用方法.md`；如何把成品分发给别人，见 `docs\分发说明.md`。

## 目录说明

> 本仓库仅含**源码**；`产出\`、`资料\` 不在仓库内（见下表标注）。

| 目录/文件 | 用途 | 是否入库 |
|---|---|---|
| `README.md` | 项目说明与构建指引 | ✅ |
| `docs\设计方案.md` | 需求、决策树、架构与实现要点 | ✅ |
| `docs\使用方法.md` | 成品使用说明（成品由构建生成，不在本仓库） | ✅ |
| `docs\分发说明.md` | 成品分发说明（分发的是构建出的安装包） | ✅ |
| `过程记录\` | 进度日志，每次会话追加 `YYYY-MM-DD-主题.md` | ✅ |
| `app\` | Electron 壳源码 + 打包配置 | ✅ |
| `产出\` | 构建产物（安装包/便携版），由 `app` 打包生成，发布走 GitHub Releases | ❌ 不入库 |
| `资料\` | 本地参考资料、素材 | ❌ 不入库（当前为空） |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-14 | 项目立项；开始 grill-me 需求访谈 |
| 2026-08-14 | 完成访谈、搭壳、冒烟测试、打包（NSIS + portable）、补图标、写使用方法文档 |
| 2026-08-15 | 修复数据污染：spawn dsh 显式指定 cwd；启动前探测 3080 已有实例则直接复用，杜绝双实例并发写 `~/.dsh` |
| 2026-08-17 | 源码验证运行通过；补齐 Node 24 侧车并重新打包（NSIS + portable）；发布 v0.1.0 到 GitHub Releases |
| 2026-08-22 | P0 修复：`@deepseek-ai/dsh` 改为精确版本并重新生成 lockfile；`afterPack` 增加依赖守卫（拒绝含 `compression: none` 的 dsh-base 构建，防止桌面端读不了 zstd 历史会话闪退）；安装依赖改用 `npm ci`。**待重新打包 NSIS + portable** |
| 2026-08-23 | 发布 v0.1.1：包含 P0 依赖修复（闪退）+ 不再自动打开系统浏览器（`--no-open`） |
