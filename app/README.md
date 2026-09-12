# DS Harness Desktop — 应用源码

Electron 壳，包裹 `@deepseek-ai/dsh` 的 web profile。内置两层更新能力：运行时更新
dsh 本体（不重打包），以及外壳自身更新（electron-updater + GitHub Releases）。

## 结构

| 文件 | 说明 |
|---|---|
| `src/main.js` | 主进程：单实例、端口解析、spawn dsh、就绪探测、托盘、生命周期、应用内更新入口 |
| `src/updater.js` | 应用内 dsh 更新器（版本检查 / 下载安装 / 兼容守卫 / 冒烟验证 / 激活 / 回滚 / 清理），不依赖 Electron，可独立测试 |
| `src/preload.js` | contextBridge 最小暴露（版本/端口/重启/更新） |
| `src/loading.html` | 启动加载页 |
| `src/error.html` | 服务不可用错误页 |
| `test/updater.test.js` | 更新器测试（离线单测 + `--e2e` 真实端到端） |
| `scripts/prepare-runtime.ps1` | 一键准备侧车运行时（Node 24 + 捆绑 npm） |
| `package.json` | 依赖（捆绑 `@deepseek-ai/dsh`）与脚本 |
| `electron-builder.yml` | 打包配置（NSIS + portable，产物到 `../产出`） |
| `build/afterPack.js` | 打包钩子：用 `npm ci --omit=dev` 重建"仅运行时依赖"的 node_modules（并按规则修剪），再做依赖守卫与 rcedit 嵌图标/版本 |
| `build/icon.ico` | 应用/安装器图标（多尺寸，由 `app-builder icon` 从 PNG 生成） |
| `build/rcedit-x64.exe` | 手动解压的 rcedit（用于嵌图标；app-builder 内置 rcedit 会去下载 winCodeSign 触发符号链接问题） |
| `runtime/` | 捆绑的独立 Node 24 运行时（侧车）：`node.exe` + `node_modules/npm`，用于运行 dsh 并在应用内安装新版本 |
| `assets/` | 托盘/应用图标 |

## 首次准备（clone 后）

1. 安装依赖：

   ```powershell
   # npm 11 起不再把 .npmrc 的 electron_mirror 传给安装脚本，改用环境变量指定镜像
   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
   npm ci
   ```

   > 必须用 `npm ci`（按 `package-lock.json` 精确安装）。`@deepseek-ai/*` 的
   > RC 版本在不同 registry/时点的 tarball 内容可能不一致，本项目依赖
   > 精确锁定 + 打包期守卫（见 `build/afterPack.js`），不满足会直接构建失败。

   > **已知问题**：部分 Windows 环境下 electron 自带的解压脚本会静默失败——
   > `npm ci` 返回 0，但 `node_modules\electron\dist` 里只有一个文件、且没有
   > `path.txt`，此时 `npm start` 会报 "Electron failed to install correctly"。
   > 打包（`npm run build`）不受影响，因为 electron-builder 用自己缓存的发行版。
   > 需要开发运行时分两种情况处理：
   >
   > - 若打算用已打包的程序验证，直接跳到下面的「打包」即可，无需修。
   > - 若要用 `npm start`，从缓存手动解压一次：
   >
   > ```powershell
   > $zip = "$env:LOCALAPPDATA\electron\Cache\electron-v33.4.11-win32-x64.zip"
   > Expand-Archive $zip "$env:TEMP\electron-dist" -Force
   > Copy-Item "$env:TEMP\electron-dist\*" .\node_modules\electron\dist -Recurse -Force
   > Set-Content .\node_modules\electron\path.txt 'electron.exe' -NoNewline -Encoding ascii
   > .\node_modules\.bin\electron.cmd --version   # 应输出 v33.4.11
   > ```

2. 准备侧车运行时（`runtime/` 不入库）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\prepare-runtime.ps1
   ```

   > 必须包含 **npm**（`runtime/node_modules/npm`）。侧车用 `node.exe` 运行 dsh；
   > 应用内更新（托盘「检查更新」）用同一个侧车的 npm 下载安装新版本。
   > 只投放 `node.exe` 的旧运行时会让更新提示「当前构建未捆绑 npm」。
   > 产物约 100 MB，其中 node.exe 约 92 MB、npm 约 7 MB。

## 运行

```sh
npm start          # 开发运行
npm run build      # 打包 NSIS 安装器 + portable exe（产物在 ../产出）
npm test           # 更新器离线单元测试（无网络）
npm run test:e2e   # 追加真实端到端：下载安装 rc.2 + 冒烟验证 + 激活 + 回滚
```

> `npm run test:e2e` 在开发态可直接运行（脚本会回退到本机 Node 自带的 npm）。
> 若要验证"出厂配置"（侧车 node + 侧车 npm），可注入环境变量：
> `DSH_TEST_NODE=runtime\node.exe`、`DSH_TEST_NPM_CLI=runtime\node_modules\npm\bin\npm-cli.js`。

## 应用内更新

托盘菜单提供：检查更新 / 更新通道 / 回到内置版本 / 打开数据目录。

- **通道**：`stable`（跟官方 `latest` 标签，默认）与 `preview`（跟 `next` 标签）。
  版本判断只认顶层 `@deepseek-ai/dsh` 的 dist-tags；同族子包的 `latest` 已过期。
- **安装位置**：`%APPDATA%\DS Harness Desktop\dsh-update\versions\<版本>\`，
  放在用户数据目录，因此 NSIS 安装版与 portable 便携版通用，重装不丢。
- **生效流程**：检查 → 下载安装（npm）→ 兼容守卫 → 冒烟验证（临时 `DSH_HOME` +
  空闲端口，确认能打印带 token 的地址）→ 激活 → 重启服务。
- **失败保护**：任一步失败都会丢弃新版本、保留当前版本；如果覆盖版本启动即退出，
  主进程会自动回退到内置版本并重启一次（内置版本永远可用）。
- **数据安全**：从不写入 `~/.dsh`，升级不触碰会话与凭据。
- **保留策略**：只保留当前版本与上一个可用版本，其余版本目录自动清理。

> 内置版本是保底：卸载更新版本只会回到随安装包捆绑的 dsh，不需要重新安装应用。

## 安装包体积与安装速度

安装包只该包含**运行时真正需要**的东西：

- `afterPack` 不再把开发态 `node_modules` 原样塞进安装包——那会把整套 Electron 构建工具链
  （`@electron/*`、`7zip-bin` 等 260 个包、上万文件）一起发给用户。
  现在改为用 `npm ci --omit=dev` 生成生产依赖树（含全部 240 个 `@deepseek-ai/*` 包），
  按内容哈希缓存在系统临时目录，避免每次构建重装。
- 同时修剪运行时不会加载的文件：sourcemap（`.map`）与 TypeScript 类型声明（`.d.ts`）。
  注意：**目录名只在"包根"判定**——`yaml/dist/doc/` 这类包内部目录是运行时依赖，
  按名字全局删除会导致 dsh 启动失败（曾真实踩到）。

效果：安装包约 213 MB → 130 MB，安装后约 811 MB / 3.4 万文件 → 462 MB / 1.3 万文件。
安装时间主要受文件数影响，因此这个改动对"装得慢"帮助最直接。

## 外壳自更新

托盘「检查桌面端更新」通过 `electron-updater` 从 GitHub Releases 获取新版本。

- **发布源**：`electron-builder.yml` 的 `publish` 段（GitHub / owner / repo），
  打包时会生成 `latest.yml` 并写入 `resources/app-update.yml`。
- **前置条件**：仓库必须公开，Release 必须包含 `latest.yml`、安装器与 `.blockmap`，
  否则客户端拿不到更新清单（错误会写进 `dsh-desktop.log`）。
- **只在打包态生效**：开发态 `npm start` 会提示「开发态不检查桌面端更新」。
- **便携版限制**：便携版每次启动自解压到临时目录，无法原地替换自身，
  「检查桌面端更新」会引导打开[发布页](https://github.com/ljr282341583/ds-harness-desktop/releases/latest)
  手动下载；dsh 本体更新不受此限制。
- **安装流程**：检查 → 确认 → 下载（托盘与任务栏显示进度）→ 确认后
  `quitAndInstall()`，安装完成自动重启。

### 发布新版本

打 tag 即触发 `.github/workflows/release.yml`：

```sh
git tag v0.3.0 && git push origin v0.3.0
```

工作流会：同步版本号（tag → `package.json` 与 lock）→ `npm ci` → 准备侧车运行时
→ 跑更新器单测 → `electron-builder --win --publish always` 发布安装器、便携版与
`latest.yml`。

> 日常的 dsh 版本升级**不需要**发新外壳 —— 运行时「检查 dsh 更新」会直接更新 dsh 本体。
> 只有外壳自身变更（或上游启动契约破坏）才需要发版。

## 说明

- 子进程用**捆绑的独立 Node 24 侧车**（`runtime/node.exe`）执行捆绑的
  `@deepseek-ai/dsh/lib/bin.js`，命令为 `web --port <p>`。不用 Electron 自带
  Node，因为 DSH 需要 Node 22.15+ 的 zstd / `stripTypeScriptTypes`，而
  Electron 自带 Node 版本过低。
- 复用 `~/.dsh`（凭据/会话/skills/profiles），与 CLI/web 版共享。
- 应用内更新只替换 dsh 本体，不替换 Electron 外壳；外壳自身更新见仓库 README 的后续计划。
