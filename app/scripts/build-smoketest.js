'use strict';

/**
 * 体检专用「隔离命名」构建（`npm run build:smoketest`）。
 *
 * 为什么需要它：NSIS 的快捷方式名与注册表键名由**产品名/GUID**派生，与安装目录无关
 * （`app-builder-lib/out/targets/nsis/NsisTarget.js` L147 `UUID.v5(appId)` →
 * `${APP_GUID}`；`multiUser.nsh` L8-9 用它拼 `Software\<guid>` 与
 * `...\Uninstall\<guid>`，`SHORTCUT_NAME` 决定 lnk 文件名）。所以"装到临时目录"
 * 从来不是隔离——2026-09-24 的误删事故即由此而来。
 *
 * 本构建把 productName / 快捷方式名 / NSIS guid 三样一起换掉，使体检实例的
 * exe 名、进程名、快捷方式名、注册表键名与真实安装**完全不重叠**：即便安装/卸载
 * 再次失控，也碰不到用户的真实安装。
 *
 * 产物：`产出\smoketest\`（Setup 安装包 + `smoketest.json` 清单）。
 * verify:smoke 检测到清单后会自动优先使用该隔离构建。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, '..');
const repoDir = path.join(appDir, '..');
const outDir = path.join(repoDir, '产出', 'smoketest');

const PRODUCT_NAME = 'DS Harness Desktop SmokeTest';
const SHORTCUT_NAME = 'DS Harness Desktop SmokeTest';
// 固定（不随机）GUID：重复运行的键名一致，便于识别与清理残留
const SMOKETEST_GUID = '5f0a7c31-9b2e-4d64-8a17-3c6e5d9b0f42';
const EXE_NAME = `${PRODUCT_NAME}.exe`;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: false });
  if (r.error) throw new Error(`${path.basename(cmd)} 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码=${r.status}`);
}

console.log('[smoketest] 1/3 准备侧车运行时（幂等；已就绪时秒过）');
run('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  path.join(appDir, 'scripts', 'prepare-runtime.ps1'),
]);

console.log('[smoketest] 2/3 隔离命名打包');
console.log(`  productName  = ${PRODUCT_NAME}`);
console.log(`  shortcutName = ${SHORTCUT_NAME}`);
console.log(`  nsis.guid    = ${SMOKETEST_GUID}`);
console.log(`  输出目录     = ${outDir}`);
// 用 node 直接跑 electron-builder 的 CLI 入口：Node 24 禁止裸 spawn `.cmd`（项目已知坑）
run(process.execPath, [
  path.join(appDir, 'node_modules', 'electron-builder', 'cli.js'),
  '--win',
  `-c.productName=${PRODUCT_NAME}`,
  `-c.nsis.shortcutName=${SHORTCUT_NAME}`,
  `-c.nsis.guid=${SMOKETEST_GUID}`,
  `-c.directories.output=${path.relative(appDir, outDir).split(path.sep).join('/')}`,
]);

console.log('[smoketest] 3/3 写清单');
const version = require(path.join(appDir, 'package.json')).version;
const manifest = {
  productName: PRODUCT_NAME,
  shortcutName: SHORTCUT_NAME,
  guid: SMOKETEST_GUID,
  exeName: EXE_NAME,
  version,
  builtAt: new Date().toISOString(),
};
fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, 'smoketest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`  清单 → ${manifestPath}`);
console.log('[smoketest] 完成：verify:smoke 会自动优先使用该隔离构建（无需暂存真实安装、无需提权）');
