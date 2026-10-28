# v0.3.10 Release Notes（草稿：发布时直接贴到 GitHub Release 描述）

## 新增

- **升级前先做真实 profile 预检**：应用内「检查 dsh 更新」在下载安装完成后、**激活之前**，
  会用候选版本对**你当前的 profile** 跑一次 `dsh --profile web --dump-config`；只要出现
  `disabling profile plugin row` / `startup failed` / `did not activate` / `incompatible with dsh` /
  `cannot resolve profile bundle`，就丢弃刚下载的版本、保持原版本继续可用。
  背景：2026-10-28 引擎升 0.2.1-rc.4 时，冒烟测试（干净 `DSH_HOME`、不带第三方插件）全绿，
  但真实 profile 里被旧插件钉死的 `@deepseek-ai/dsh-tools` 让 `tools` 行被禁用、整条插件链
  pending，启动直接失败。
- **一键「回到上一个版本」**：托盘新增菜单项（显示目标版本号），切换后两个版本目录都保留、
  可来回切。错误页也从 1 个按钮扩到 3 个：**重启服务 / 回到 vX / 打开 profile 目录**。
  这比「回到内置版本」实用：内置是 0.1.5-rc.1，加载不了 0.2.x 的 profile。
- **`npm run verify:profile`**：拿当前生效的 dsh 对真实 profile 跑一次 `--dump-config`，
  退出码 0（通过）/ 1（发现不兼容并打印证据行）/ 2（环境问题）。补上打包体检永远抓不到的盲区。
- **单实例冲突给出说明**：当另一份实例（常见是旧安装版）占着同一用户数据目录时，后启动的实例
  不再静默退出，而是弹窗写明「本次启动的入口 / 本次安装位置 / 怎么退出旧实例」。

## 变更

- **产物目录 `产出\` → `dist\`**：`electron-builder` 输出、体检脚本与文档同步；旧目录整体改名为
  `历史产物\` 并加入 `.gitignore`。
- **新增 `unlock-artifacts.cmd` / `reset-dist.cmd`**：AI agent 会话会把仓库目录标成 Low integrity，
  在里面构建的 exe 会继承该标签 → Electron 起不来（`0x80000003`）、NSIS 报
  `Error writing temporary file`。`unlock-artifacts.cmd` 把 `dist` 重置为 Medium 完整性；
  重新打包前先跑 `reset-dist.cmd` 清空（Medium 文件 agent 删不掉）。

## 验证

- 离线单测 `npm test`：**42/42**（新增 10 例：预检输出判定 4、候选版本实跑 3、版本回退 3）。
- `npm run build` / `build:dir`：打包 + 冒烟体检 **通过 7 / 失败 0 / 跳过 1**
  （[5] 安装器端到端在本机有真实安装时按设计跳过，发版门禁由 CI 承担）。
- `npm run verify:profile` 对真实 profile：通过（退出码 0）。
- 实测定位并验证了 Low integrity 的影响：重置 `dist` 为 Medium 后，工作区内的
  `win-unpacked` 可直接启动；未重置时秒退 `0x80000003`。

## 升级方式

- 安装版：托盘「检查桌面端更新」自动下载安装；或从 Releases 下载
  `DS-Harness-Desktop-Setup-0.3.10.exe` 覆盖安装。
- 便携版：从 Releases 重新下载 `DS-Harness-Desktop-0.3.10-portable.exe` 替换旧文件。
- 升级向导**保持默认「全机」模式，不要切「仅当前用户」**（切错会产生双安装 / 孤儿安装）。

## 已知限制

- 便携版无法原地自更新（既有限制）。
- **内置 dsh 仍是 0.1.5-rc.1**：它加载不了当前 0.2.x profile，所以「回到内置版本」在这类
  不兼容场景里仍是死路；应急退路请用新的「回到上一个版本」。
- 从 git 工作区直接重打包时，记得按 `reset-dist.cmd → build → unlock-artifacts.cmd` 的顺序操作。
