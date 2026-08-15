# DS Harness Desktop — 应用源码

Electron 壳，包裹 `@deepseek-ai/dsh` 的 web profile。

## 结构

| 文件 | 说明 |
|---|---|
| `src/main.js` | 主进程：单实例、端口解析、spawn dsh、就绪探测、托盘、生命周期 |
| `src/preload.js` | contextBridge 最小暴露（版本/端口/重启） |
| `src/loading.html` | 启动加载页 |
| `src/error.html` | 服务不可用错误页 |
| `package.json` | 依赖（捆绑 `@deepseek-ai/dsh`）与脚本 |
| `electron-builder.yml` | 打包配置（NSIS + portable，产物到 `../产出`） |
| `build/afterPack.js` | 打包钩子：覆盖 electron-builder 的不完整依赖裁剪 + rcedit 嵌图标/版本 |
| `build/icon.ico` | 应用/安装器图标（多尺寸，由 `app-builder icon` 从 PNG 生成） |
| `build/rcedit-x64.exe` | 手动解压的 rcedit（用于嵌图标；app-builder 内置 rcedit 会去下载 winCodeSign 触发符号链接问题） |
| `runtime/` | 捆绑的独立 Node 24 运行时（侧车），用于运行 dsh |
| `assets/` | 托盘/应用图标 |

## 首次准备（clone 后）

1. 安装依赖：

   ```sh
   npm install
   ```

2. 准备 Node 24 侧车（`runtime/` 不入库，需自行下载，用于运行 dsh）：

   ```powershell
   $ver = 'v24.16.0'
   curl.exe -L -o "$env:TEMP\node.zip" "https://npmmirror.com/mirrors/node/$ver/node-$ver-win-x64.zip"
   Expand-Archive "$env:TEMP\node.zip" "$env:TEMP\node" -Force
   New-Item -ItemType Directory -Force -Path .\runtime | Out-Null
   Copy-Item "$env:TEMP\node\node-$ver-win-x64\*" .\runtime\ -Recurse -Force
   ```

## 运行

```sh
npm start          # 开发运行
npm run build      # 打包 NSIS 安装器 + portable exe（产物在 ../产出）
```

## 说明

- 子进程用**捆绑的独立 Node 24 侧车**（`runtime/node.exe`）执行捆绑的
  `@deepseek-ai/dsh/lib/bin.js`，命令为 `web --port <p>`。不用 Electron 自带
  Node，因为 DSH 需要 Node 22.15+ 的 zstd / `stripTypeScriptTypes`，而
  Electron 自带 Node 版本过低。
- 复用 `~/.dsh`（凭据/会话/skills/profiles），与 CLI/web 版共享。
