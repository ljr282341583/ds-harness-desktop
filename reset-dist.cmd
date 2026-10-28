@echo off
rem 打包前清空 dist\（普通双击运行 = 中等完整性，才有权限删掉被 unlock-artifacts.cmd 升过级的文件）。
rem
rem 为什么需要：unlock-artifacts.cmd 会把 dist 里的产物升成 Medium 完整性，
rem 而 agent 会话（Low 完整性）之后就没法删除/覆盖这些文件，重新打包会报
rem "remove ...: Access is denied"。所以：要重新打包 → 先双击本文件清空 dist。
rem
rem 顺序：reset-dist.cmd → npm run build(dir) → unlock-artifacts.cmd

setlocal
set "TARGET=%~dp0dist"
if not exist "%TARGET%" (
  echo 没有 dist 目录，无需清理。
  pause
  exit /b 0
)

echo 正在删除 %TARGET% ……
rmdir /s /q "%TARGET%"
if exist "%TARGET%" (
  echo 删除失败：可能有进程占用（先退出 DS Harness Desktop）或权限不足。
  pause
  exit /b 1
)

echo 完成，现在可以重新打包了。
pause
