# v0.3.7 Release Notes（草稿：发布时直接贴到 GitHub Release 描述）

## 修复

- **应用内「检查 dsh 更新」的覆盖版本从未真正生效过（激活后秒回退）**：主进程
  `child.on('exit')` 不区分退出的是哪个子进程。更新流程是「先 activate 新版本 →
  再 stopHarness 杀旧进程 → 才 startHarness 拉起新版本」，旧进程的 exit 事件迟到时，
  回调读到 `activeVersion` 已有值，就把这次退出误判成「覆盖版本启动失败」，1 毫秒内
  deactivate 并回退内置版本。
- **实证**：2026-09-24 日志中旧进程 SIGTERM 退出后 1ms 即触发回退，紧随其后的两次
  `startHarness` 用的都是内置版路径 —— 新版本从头到尾没被拉起过一次。该缺陷自
  v0.3.0 引入两层更新能力起就存在：09-12、09-20（两次）、09-24 共 4 次尝试全部同因失败。
- **修复**：exit 回调加子进程身份守卫 `if (dshChild !== child) return;`，置于关闭日志
  文件描述符之后、`dshChild = null` 之前；`dshExitPromise` 用的是独立的
  `child.once('exit')` 监听，不受影响。顺带消除回退分支与更新流程并发双 spawn 的问题。

## 验证

- 本机实机验证：托盘「重启服务」不再回退（修复前必掉），`dsh-update\state.json` 的
  `activeVersion` 保持不变；壳日志中「覆盖版本启动失败，回退内置版本」不再新增。

## 升级方式

- 安装版：托盘「检查桌面端更新」自动下载安装；或从 Releases 下载
  `DS-Harness-Desktop-Setup-0.3.7.exe` 覆盖安装。
- 便携版：从 Releases 重新下载 `DS-Harness-Desktop-0.3.7-portable.exe` 替换旧文件。
- 升级弹出向导时**保持默认「全机」模式、不要切换「仅当前用户」**（切错会产生双安装 /
  孤儿安装）；升级后可查看 `resources\app\package.json` 确认版本为 0.3.7。

## 已知限制

- 便携版无法原地自更新（既有限制，需手动下载新文件替换）。
- **dsh 本体的启动冒烟验证用干净的临时 `DSH_HOME`，不含第三方插件**，因此无法发现
  「引擎升级导致第三方插件不兼容」这一类失败。2026-09-24 实测：dsh 0.1.7 移除了
  `settingsScope` 服务，旧版 Command Code provider 因 `inject` 它而永久 pending，
  整个页面打不开 —— 而冒烟验证与自动回退都盖不住这一类。**升级 dsh 前后请先更新插件。**
