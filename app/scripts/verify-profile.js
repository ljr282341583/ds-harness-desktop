#!/usr/bin/env node
'use strict';

/**
 * npm run verify:profile —— 用「当前实际生效的 dsh」检查你真实 profile 的兼容性
 *
 * 为什么需要它：`verify:smoke` 全程用临时 DSH_HOME、不带第三方插件，所以「插件与引擎
 * 版本不兼容」这类问题在体检里永远是绿的（2026-10-28 实锤：引擎升到 0.2.1-rc.4 后，
 * 被旧插件钉住的 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 让 `tools` 行被禁用，整条工具链
 * pending，启动直接失败）。本脚本拿**真实 profile** 跑一次 `--dump-config`：
 *
 *   - 组树成功、没有「disabling profile plugin row / startup failed」→ 退出码 0
 *   - 发现不兼容 → 打印证据行，退出码 1
 *   - 环境/路径问题（找不到 dsh、找不到 node）→ 退出码 2
 *
 * 只组配置树、不启动服务；不写 profile、不碰凭据与会话。
 *
 * 用法：
 *   npm run verify:profile
 *   npm run verify:profile -- --json
 *   npm run verify:profile -- --profile web
 * 环境变量：
 *   DSH_HOME               指向别的 home（默认真实 ~/.dsh）
 *   DSH_DESKTOP_UPDATE_DIR 指向别的 dsh-update 根（默认 %APPDATA%\ds-harness-desktop\dsh-update）
 *   DSH_DESKTOP_NODE       指定 node.exe
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../src/updater.js');

const appDir = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const profileFlag = argv.indexOf('--profile');
const profileName = profileFlag >= 0 && argv[profileFlag + 1] ? argv[profileFlag + 1] : 'web';

function updateBaseDir() {
  if (process.env.DSH_DESKTOP_UPDATE_DIR) return process.env.DSH_DESKTOP_UPDATE_DIR;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'ds-harness-desktop', 'dsh-update');
}

/** 当前生效的 dsh：优先应用内更新版本，其次内置版本。 */
function resolveActiveInstall(baseDir) {
  const state = updater.readState(baseDir);
  if (state.activeVersion) {
    const root = updater.versionRoot(baseDir, state.activeVersion);
    const bin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(bin)) return { root, version: state.activeVersion, source: 'updated', state };
  }
  // 内置版本：开发树是 app/node_modules，打包后是 resources/app/node_modules
  const dshDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh');
  if (fs.existsSync(path.join(dshDir, 'lib', 'bin.js'))) {
    return {
      root: path.resolve(dshDir, '..', '..', '..'),
      version: updater.readPackageVersion(dshDir),
      source: 'bundled',
      state,
    };
  }
  return { root: null, version: null, source: null, state };
}

function resolveNode() {
  if (process.env.DSH_DESKTOP_NODE) return process.env.DSH_DESKTOP_NODE;
  const sidecar = path.join(appDir, 'runtime', 'node.exe');
  return fs.existsSync(sidecar) ? sidecar : process.execPath;
}

function resolveHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

async function main() {
  const baseDir = updateBaseDir();
  const active = resolveActiveInstall(baseDir);
  const home = resolveHome();
  const profileDir = path.join(home, 'profiles', profileName);

  if (!active.root) {
    const message = '定位不到可用的 dsh 安装（既没有应用内更新版本，也没有内置版本）';
    if (asJson) console.log(JSON.stringify({ ok: false, stage: 'resolve', message }, null, 2));
    else console.error(`❌ ${message}`);
    process.exit(2);
  }

  const header = {
    dsh: active.version,
    source: active.source === 'updated' ? '应用内更新版本' : '内置版本',
    sourceKey: active.source,
    profile: profileDir,
    home,
    state: active.state,
  };
  if (!asJson) {
    console.log(`dsh     : v${header.dsh}（${header.source}）`);
    console.log(`profile : ${profileDir}`);
    console.log(`home    : ${home}`);
    console.log('预检中（--dump-config，不启动服务）…');
  }

  const report = await updater.precheckProfile({
    root: active.root,
    nodePath: resolveNode(),
    cwd: os.homedir(),
    profile: profileName,
  });

  if (asJson) {
    console.log(JSON.stringify({ ...header, ...report }, null, 2));
  } else if (report.ok) {
    console.log('✅ profile 预检通过：这个 dsh 版本加载得了你当前的 profile');
  } else {
    console.error(`❌ profile 预检未通过：${report.reason}`);
    for (const problem of report.problems) console.error(`   - ${problem}`);
    if (report.problems.length === 0 && report.outputTail) console.error(report.outputTail);
    // 在 agent 会话里跑时：凡镜像在会话工作区内的进程，写工作区外一律 EPERM
    // （app/runtime/node.exe 就是这种镜像）。换成系统 node 即可，不是 profile 真有问题。
    if (/EPERM|EACCES|operation not permitted/i.test(`${report.reason || ''}\n${report.outputTail || ''}`)) {
      console.error('\n提示：这看起来是「工作区内的 node 镜像写不了工作区外」的环境限制（agent 会话常见），');
      console.error('      不是 profile 真的坏了。换一个 node 再跑：');
      console.error('      $env:DSH_DESKTOP_NODE=\'C:\\Program Files\\nodejs\\node.exe\'; npm run verify:profile');
    }
    console.error('\n常见原因：某个插件用 dependencies 钉死了旧版 @deepseek-ai/* 包，或插件还没适配这个引擎版本。');
    console.error('处理：升插件，或「回到上一个版本」；临时绕过见 NEXT.md 的具体步骤。');
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  if (asJson) console.log(JSON.stringify({ ok: false, stage: 'crash', message: String(error && error.message || error) }, null, 2));
  else console.error(error);
  process.exit(2);
});
