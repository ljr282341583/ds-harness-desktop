@echo off
rem 把 dist\ 下的产物重置为「中等完整性」，随后才能双击运行。
rem
rem 背景：AI agent 会话把仓库目录标成了 Low integrity（低完整性），打包产物会继承这个标签；
rem 低完整性进程写不了 %TEMP%、也初始化不了 Chromium 沙箱，所以工作区里的 exe 双击会
rem 秒退 0x80000003，NSIS 安装包会报 "Error writing temporary file"。
rem
rem 用法：每次 npm run build / build:dir 之后，双击本文件即可（普通双击 = 中等完整性，有权改标签）。
rem 本文件必须用「普通资源管理器双击」或普通 PowerShell 运行；在 agent 会话里跑无效。

setlocal
set "TARGET=%~dp0dist"
if not exist "%TARGET%" (
  echo 没找到 dist 目录：%TARGET%
  echo 先跑一次 npm run build:dir 或 npm run build。
  pause
  exit /b 1
)

echo 正在把 %TARGET% 重置为 Medium 完整性……
icacls "%TARGET%" /setintegritylevel Medium /T /C >nul 2>&1
if errorlevel 1 (
  echo 失败：可能需要管理员权限，或部分文件被占用（先关掉正在运行的 DS Harness Desktop）。
  pause
  exit /b 1
)

echo 完成。现在 dist\win-unpacked\DS Harness Desktop.exe 和 dist\*Setup*.exe 可以直接双击了。
pause
