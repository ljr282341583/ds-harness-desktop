# AGENTS.md — DS Harness Desktop

本仓库是 **DS Harness Desktop**：用 Electron 外壳包裹官方 DeepSeek Harness（`@deepseek-ai/dsh`），由捆绑的独立 Node 24 侧车运行 `dsh web`，产出 NSIS 安装包 + portable 分发。

指引语言：中文。稳定路径、命令、标识符保持英文原文。

**本项目不使用 `agent-loop`**（2026-09-25 起脱钩）：不加载 agent-loop skill，不设 Stage / Gate / artifact 体系，**无外部 `.agent-loop/` 记忆根**。本文件是本项目唯一主指引；`CLAUDE.md` 只是指针，不重复规则。

## 仓库速览

| 路径 | 职责 |
| --- | --- |
| `app/src/` | 主进程、preload、本地 loading/error 页面 |
| `app/build/` | 打包钩子 `afterPack.js`（依赖覆盖 + 兼容守卫 + 图标/版本嵌入）与资源 |
| `app/runtime/` | 捆绑的 Node 24 侧车（**不入库**；打包前由 `prepare-runtime.ps1` 补齐） |
| `app/test/` | `updater.test.js` 离线单测、`smoke.test.js` 打包/安装体检 |
| `docs/` | 设计方案、使用方法、分发说明、各版 release notes |
| `过程记录/` | 项目自身的按次会话日志 |

产品硬前提：内置 dsh 版本是保底；任何更新失败都必须能回到内置版本；不得破坏 `~/.dsh` 下的凭据、会话、skills 与 profiles。

## 工作方式

1. **代理直接推进**：先自己查代码 / Git / 文档 / 环境拿事实，再给出**一个**推荐动作，不等人类逐条点名；发现缺文档就主动补。
2. **无流程件**：不产出 Feature Spec / Plan / Delivery Contract 一类流程文档；需要留痕时写 `过程记录/`（本机按次）与大脑仓库（跨机）。
3. **判断与推断分开说**：成文约定与个人推断分别标明，不把推断说成约定；确实卡住时只问**一个**关键问题。
4. **规格把握**：产品定位、硬约束、发布节奏类事项先给结论再动手；纯实现细节自行决定并说明理由。

## 记忆与交接

- **跨机记忆 = 大脑仓库**：位置按本机 `%USERPROFILE%\.agent-brain` 里那一行路径解析；本项目笔记在 `<大脑根>\项目\ds-harness-desktop\`——`CONTEXT.md`（定位与阶段）、`NEXT.md`（断点）、`DECISIONS.md`（已拍板决策）、`JOURNAL\`（按次日志）。
- **本机按次细节 = 本仓库 `过程记录/`**。
- **开工**：先读 `CONTEXT.md` + `NEXT.md`；`DECISIONS.md` 里已否决的方案不要重提。
- **收尾**：用户说「收尾 / 交接」时按 `session-handoff` skill 蒸馏进度，并推送「项目仓库 + 大脑仓库」。
- 红线：密钥 / token / 内网地址不进大脑仓库；笔记只写结论与理由，不搬运原始对话。

## 验证与提交

- **改代码必须验证，不许口头交差**：默认 `cd app && npm run build:dir`（前置 `prepare-runtime` + 打包 + 自动冒烟）；动到安装器 / 发版链路时用 `npm run build`。做了更弱的验证要说明为什么。
- 单测 `npm test`；端到端 `npm run test:e2e`；体检单独跑 `npm run verify:smoke`。
- **发版走 tag → CI**：`.github/workflows/release.yml` 监听 `v*` tag 自动打包发布；tag 注释**标题不要用 `#` 开头**（会被 git 剥掉，改用 `**粗体**`）。
- **提交 / 推送 / 打 tag / 发版各自独立授权**：用户明确要求时才做；提交只含本次范围内的文件，保留人类未提交的改动。
- 提交信息沿用仓库风格：`type(scope): 中文摘要`，如 `fix(updater): …`、`feat(smoke): …`。

## 架构快照

- 形态：Electron 外壳（`app/src/`）托管本地 `dsh web` 子进程；UI 直接加载本地服务地址，不做前端改造。
- 运行时分层：Electron 自带 Node 版本过低，dsh 由捆绑的独立 Node 24 侧车（`runtime/node.exe`）执行。
- 数据边界：所有 dsh 数据位于 `~/.dsh`（凭据、会话、skills、profiles），由 dsh 自身管理，外壳不读写业务数据。
- 打包边界：`asar: false`（侧车不识别 asar）；`extraResources` 投放 `runtime/`；`afterPack.js` 覆盖依赖树并执行兼容守卫。
- 已安装布局（实测 v0.2.0）：`<安装目录>\resources\app\`（外壳 + `node_modules`）与 `<安装目录>\resources\runtime\node.exe`。

## 目录指引

- 目录级 `AGENTS.md` 只写长期边界规则：新建 app / package / service / test / 数据安全 / 插件 / docs 根时先提议、经人类确认再写。
- 普通组件、工具、临时或功能实现目录不建目录级 `AGENTS.md`。
- 当前状态：无目录级 `AGENTS.md`（`app/`、`app/src/`、`app/build/` 均记为 not needed）。

## 项目命令

```bash
cd app && npm ci                  # 按 lockfile 精确安装依赖（勿用 npm install）
cd app && npm start               # 开发运行（Electron 壳 + 托管 dsh web）
cd app && npm test                # 离线单测（updater）
cd app && npm run build:dir       # 打包到 产出\win-unpacked\ + 自动冒烟（日常验证首选）
cd app && npm run build           # 打包 NSIS + portable（发版前用），末尾含体检
cd app && npm run verify:smoke    # 单独跑体检（本机有真实安装时 [5] 默认 SKIP）
cd app && npm run build:smoketest # 生成体检专用「隔离命名」安装包（要跑 [5] 必须先出它）
```

## 硬约束

1. 内置 dsh 版本是保底：任何更新失败都必须能回到内置版本。
2. 打包守卫必须保留：拒绝 `@deepseek-ai/dsh-base/cordis.patch.yml` 含 `compression: none` 的构建（会导致读不了 `.jsonl.zstd` 历史会话而闪退）。
3. `app/runtime/` 不入库、本地初始**只有 `node.exe`、没有 npm**：打包前必须由 `scripts\prepare-runtime.ps1` 补齐（`build` / `build:dir` 已自动前置，smoke [2] 断言侧车含可执行 npm）。「侧车自带 npm」不能作为实现前提。
4. `~/.dsh` 是共享数据目录：涉及升级或测试时必须用 `DSH_HOME` 重定向到临时目录，不得污染真实凭据与会话。
5. 便携版（portable 单文件）每次启动自解压到临时目录，无法原地自更新。
6. 版本判断只认顶层 `@deepseek-ai/dsh` 的 dist-tags；同族子包的 `latest` 已过期（停在 `0.0.1-rc.1`）。
7. `@deepseek-ai/dsh` 依赖使用精确版本，不使用 `^`。
8. 上游 RC 包同版本号可能被重新发布为不同内容，需以 `dist.integrity` 而非仅版本号判断。
