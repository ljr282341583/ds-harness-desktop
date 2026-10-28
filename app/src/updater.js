'use strict';

/**
 * DS Harness Desktop — 应用内 dsh 更新器
 *
 * 设计约束（来自项目既有前提）：
 * 1) 内置版本是保底：任何升级失败都必须能回到内置的 dsh。
 * 2) 不污染用户数据：升级过程不修改 ~/.dsh 下的凭据、会话、skills、profiles。
 * 3) 必须保留兼容守卫：拒绝 dsh-base/cordis.patch.yml 含 compression: none 的构建。
 * 4) 版本判断只认顶层 @deepseek-ai/dsh 的 dist-tags（同族子包的 latest 已过期）。
 * 5) RC 同版本号可能被重新发布为不同内容，因此记录 dist.integrity 供修复比对。
 *
 * 本模块刻意不依赖 Electron：node 可执行文件、npm CLI、目录、日志全部由调用方注入，
 * 因此可以用纯 Node 直接跑测试（见 test/updater.test.js）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');

const PKG_NAME = '@deepseek-ai/dsh';
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
const CHANNEL_TAGS = { stable: 'latest', preview: 'next' };

// ---------------------------------------------------------------------------
// 版本比较（semver 子集，含预发布规则：1.0.0 > 1.0.0-rc.2 > 1.0.0-rc.1）
// ---------------------------------------------------------------------------

function parseVersion(input) {
  const match = String(input).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版大于同号预发布版
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识符优先级低于字母标识符
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 返回 >0 表示 a 更新，<0 表示 a 更旧，0 表示相同；无法解析时返回 null。 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

// ---------------------------------------------------------------------------
// 注册表查询
// ---------------------------------------------------------------------------

function logNoop() {}

async function fetchPackument(registry, timeoutMs = 20_000) {
  const url = `${String(registry).replace(/\/+$/, '')}/${PKG_NAME.replace('/', '%2f')}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
  });
  if (!res.ok) throw new Error(`registry ${res.status} for ${PKG_NAME}`);
  return res.json();
}

/** 解析目标版本：stable → latest，preview → next（缺标签时回退 latest）。 */
function resolveTargetVersion(packument, channel) {
  const tags = packument['dist-tags'] || {};
  const tag = CHANNEL_TAGS[channel] || CHANNEL_TAGS.stable;
  return { tag, version: tags[tag] || tags.latest || null };
}

/**
 * 检查更新。返回结构化结果，调用方据此决定是否继续安装。
 */
async function checkForUpdate(options) {
  const channel = options.channel === 'preview' ? 'preview' : 'stable';
  const registry = options.registry || DEFAULT_REGISTRY;
  const packument = options.packument || (await fetchPackument(registry));
  const { tag, version } = resolveTargetVersion(packument, channel);
  const current = String(options.currentVersion || '');
  const cmp = version ? compareVersions(version, current) : null;
  const meta = version && packument.versions ? packument.versions[version] : null;
  return {
    channel,
    tag,
    current,
    target: version,
    hasUpdate: cmp === 1,
    isDowngrade: cmp === -1,
    integrity: meta && meta.dist ? meta.dist.integrity || null : null,
    publishedAt: version && packument.time ? packument.time[version] || null : null,
  };
}

// ---------------------------------------------------------------------------
// 目录与状态
// ---------------------------------------------------------------------------

function versionsDir(baseDir) {
  return path.join(baseDir, 'versions');
}

function versionRoot(baseDir, version) {
  return path.join(versionsDir(baseDir), version);
}

function statePath(baseDir) {
  return path.join(baseDir, 'state.json');
}

function readState(baseDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(baseDir), 'utf8'));
    return {
      activeVersion: typeof parsed.activeVersion === 'string' ? parsed.activeVersion : null,
      channel: parsed.channel === 'preview' ? 'preview' : 'stable',
      previousVersion: typeof parsed.previousVersion === 'string' ? parsed.previousVersion : null,
      lastResult: typeof parsed.lastResult === 'string' ? parsed.lastResult : null,
    };
  } catch {
    return { activeVersion: null, channel: 'stable', previousVersion: null, lastResult: null };
  }
}

function writeState(baseDir, next) {
  const merged = { ...readState(baseDir), ...next };
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(statePath(baseDir), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

/** 返回可用覆盖版本的安装根（内含 node_modules），不可用则返回 null。 */
function resolveActiveRoot(baseDir) {
  const state = readState(baseDir);
  if (!state.activeVersion) return null;
  const root = versionRoot(baseDir, state.activeVersion);
  const bin = path.join(root, 'node_modules', PKG_NAME, 'lib', 'bin.js');
  return fs.existsSync(bin) ? root : null;
}

function readPackageVersion(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 兼容守卫（与 build/afterPack.js 保持同一判断）
// ---------------------------------------------------------------------------

function checkCompatibility(root) {
  const binPath = path.join(root, 'node_modules', PKG_NAME, 'lib', 'bin.js');
  if (!fs.existsSync(binPath)) {
    return { ok: false, reason: `缺少 ${PKG_NAME}/lib/bin.js` };
  }
  const patchPath = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
  if (fs.existsSync(patchPath)) {
    const text = fs.readFileSync(patchPath, 'utf8');
    if (/\bcompression:\s*none\b/.test(text)) {
      return {
        ok: false,
        reason:
          '该版本的 dsh-base 使用 compression: none，会无法读取既有 .jsonl.zstd 历史会话（有会话丢失风险），已拒绝安装',
      };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// profile 依赖预检（回退/降级前问一句「回退真的有用吗」）
// ---------------------------------------------------------------------------

/**
 * 预检：某个 dsh 安装能不能解析 profile 的 `dsh.profile.bundles` 列表。
 *
 * 判据必须与上游 `dsh-app-boot` 的 `packageDirFromAnchor` **完全一致**，否则会假报
 * 「缺 bundle」，把本来能用的回退也拒掉：
 *
 *   for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
 *     if (existsSync(join(searchPath, name, 'package.json'))) → 命中
 *   }
 *
 * 锚点两处、有先后：内置安装的 dsh 包 package.json → profile 目录的 package.json。
 * 注意这是 Node 的 node_modules **父目录链**，所以 `$DSH_HOME/profiles/node_modules`
 * （本机是 junction 指向 npm 全局树）与「dsh 包内嵌 node_modules」也算命中 ——
 * 只盯 `<installRoot>/node_modules` 与 `<profileDir>/node_modules` 两个目录会漏。
 *
 * 两处都解析不到 → 该版本启动时必抛 `dsh: cannot resolve profile bundle …`，整个 boot
 * 失败（上游不会跳过缺失 bundle）。用途：回退/降级前的预检。2026-09-30 实锤：profile
 * 里有一个只在 dsh ≥ 0.1.7 发布过的 bundle，而壳的「保底」内置版本是 0.1.5-rc.1 ——
 * 回退过去必然起不来，于是「保底」变成了永久锁死。
 *
 * 读不到 profile 清单（不存在 / JSON 坏了）时返回 `checked: false`，不阻断调用方。
 */
function checkProfileBundles(options = {}) {
  const { installRoot, profileDir } = options;
  if (!installRoot || !profileDir) {
    return { ok: true, checked: false, missing: [], reason: '缺少 installRoot / profileDir' };
  }
  let bundles;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  } catch (error) {
    return { ok: true, checked: false, missing: [], reason: `读不到 profile 清单：${error.message}` };
  }

  // 与上游同序的两个锚点
  const anchors = [
    path.join(installRoot, 'node_modules', PKG_NAME, 'package.json'),
    path.join(profileDir, 'package.json'),
  ];
  const resolvable = (packageName) => {
    for (const anchor of anchors) {
      let searchPaths = [];
      try {
        searchPaths = createRequire(anchor).resolve.paths(packageName) ?? [];
      } catch {
        searchPaths = [];
      }
      for (const searchPath of searchPaths) {
        if (fs.existsSync(path.join(searchPath, packageName, 'package.json'))) return true;
      }
    }
    return false;
  };

  const missing = bundles.filter((name) => !resolvable(String(name)));
  return {
    ok: missing.length === 0,
    checked: true,
    missing,
    reason: missing.length > 0 ? `缺少 bundle：${missing.join('、')}` : null,
  };
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options.onStdout) options.onStdout(text);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 用捆绑的 npm 把指定版本的 dsh 安装到 <baseDir>/versions/<version>。
 * 安装完成后立即执行兼容守卫并记录 dist.integrity。
 */
async function installVersion(options) {
  const { version, nodePath, npmCliPath, baseDir } = options;
  const registry = options.registry || DEFAULT_REGISTRY;
  const log = options.log || logNoop;
  if (!version) throw new Error('installVersion: version is required');
  if (!nodePath) throw new Error('installVersion: nodePath is required');
  if (!npmCliPath || !fs.existsSync(npmCliPath)) {
    throw new Error(
      `installVersion: 未找到捆绑的 npm（${npmCliPath || 'null'}）。` +
        '请在打包前把 npm 放进侧车运行时（见 app/README.md「准备 Node 24 侧车」）。',
    );
  }

  const root = versionRoot(baseDir, version);
  // 干净重装：目录可能残留上次失败的半成品
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  log(`install: npm install --prefix ${root} ${PKG_NAME}@${version}`);
  const result = await run(
    nodePath,
    [
      npmCliPath,
      'install',
      '--prefix',
      root,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--loglevel',
      'error',
      '--registry',
      registry,
      `${PKG_NAME}@${version}`,
    ],
    {
      cwd: root,
      timeoutMs: options.timeoutMs || 15 * 60_000,
      onStdout: options.onProgress,
    },
  );
  if (result.code !== 0) {
    throw new Error(`npm install 失败（exit=${result.code}）：${result.stderr.trim().slice(-600)}`);
  }

  const installed = readPackageVersion(path.join(root, 'node_modules', PKG_NAME));
  if (installed !== version) {
    throw new Error(`安装校验失败：期望 ${version}，实际 ${installed || 'unknown'}`);
  }
  const guard = checkCompatibility(root);
  if (!guard.ok) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`兼容守卫拒绝该版本：${guard.reason}`);
  }

  let integrity = null;
  try {
    const packument = await fetchPackument(registry);
    const meta = (packument.versions || {})[version];
    integrity = meta && meta.dist ? meta.dist.integrity || null : null;
  } catch {
    /* 记录不到 integrity 不阻断安装 */
  }

  fs.writeFileSync(
    path.join(root, 'install.json'),
    `${JSON.stringify({ version, integrity, installedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  log(`install: 完成 v${version}（integrity=${integrity || 'n/a'}）`);
  return { root, version, integrity };
}

// ---------------------------------------------------------------------------
// 冒烟验证：用临时 DSH_HOME 与空闲端口启动候选版本，确认能打印带 token 的地址
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start) {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(start + i)) return start + i;
  }
  throw new Error(`端口 ${start}~${start + 19} 全部被占用`);
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const pid = child.pid;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    setTimeout(resolve, 500);
  });
}

/**
 * 冒烟验证用的最小环境变量集合。
 *
 * 冒烟跑的是**刚从网络下载下来的包**，不应把调用方的完整环境交给它 —— 里面可能
 * 有 API Key、访问令牌、代理凭据等。这里只保留进程正常启动所需的系统变量，
 * 外加把 DSH_HOME 指向临时目录。
 */
const SMOKE_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
];

function minimalSmokeEnv(smokeHome) {
  const env = {};
  for (const key of SMOKE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.DSH_HOME = smokeHome;
  // 冒烟只验证能否启动，不需要上报遥测
  env.DSH_TELEMETRY_DISABLED = '1';
  return env;
}

/**
 * 冒烟验证候选版本。成功条件：在超时前打印出带 token 的启动地址。
 * 全程使用临时 DSH_HOME，绝不触碰用户真实的 ~/.dsh。
 */
async function smokeTest(options) {
  const { root, nodePath } = options;
  const log = options.log || logNoop;
  const timeoutMs = options.timeoutMs || 90_000;
  const binPath = path.join(root, 'node_modules', PKG_NAME, 'lib', 'bin.js');
  if (!fs.existsSync(binPath)) return { ok: false, reason: `缺少 ${PKG_NAME}/lib/bin.js` };

  const port = await findFreePort(options.portStart || 3199);
  const smokeHome = path.join(root, 'smoke-home');
  fs.rmSync(smokeHome, { recursive: true, force: true });
  fs.mkdirSync(smokeHome, { recursive: true });

  log(`smoke: node ${binPath} web --port ${port} (DSH_HOME=${smokeHome})`);
  const child = spawn(nodePath, [binPath, 'web', '--port', String(port), '--no-open'], {
    cwd: options.cwd,
    env: minimalSmokeEnv(smokeHome),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tokenPattern = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/;
  const result = await new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => resolve({ ok: false, reason: `冒烟验证超时（${timeoutMs}ms）` }), timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(tokenPattern);
      if (match) finish({ ok: true, reason: null, url: match[0], port });
    });
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      finish({ ok: false, reason: `冒烟进程提前退出（code=${code}）：${buffer.trim().slice(-400)}` });
    });
    child.on('error', (error) => finish({ ok: false, reason: `无法启动冒烟进程：${error.message}` }));
  });

  await killTree(child);
  fs.rmSync(smokeHome, { recursive: true, force: true });
  log(`smoke: ${result.ok ? '通过' : '失败'} ${result.reason || result.url || ''}`);
  return result;
}

// ---------------------------------------------------------------------------
// profile 预检：候选版本能不能加载「你当前这份 profile」
// ---------------------------------------------------------------------------

/**
 * 「这个引擎加载不了当前 profile」的证据行。
 *
 * 2026-10-28 实锤：引擎升到 0.2.1-rc.4 后，profile 里的 `@deepseek-ai/dsh-tools` 仍被
 * 旧插件钉在 0.2.0-rc.2 → `tools` 行被判不兼容并被禁用 → 所有 inject `tools` 的插件
 * 全部 pending → `startup failed: 1 required plugin did not activate`。
 *
 * 冒烟测试（干净 DSH_HOME、不带第三方插件）永远抓不到这一类，只有拿**真实 profile**
 * 组一次树才会现形。
 */
const PROFILE_REPORT_MARKERS = [
  /disabling profile plugin row/i,
  /startup failed/i,
  /did not activate/i,
  /incompatible with dsh/i,
  /cannot resolve profile bundle/i,
];

/**
 * 解析 `dsh --profile web --dump-config` 的输出，挑出「加载不了」的证据。
 * 纯函数，便于离线单测。
 */
function analyzeProfileReport(text, exitCode) {
  const problems = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!PROFILE_REPORT_MARKERS.some((re) => re.test(line))) continue;
    // stdout / stderr 会各出现一次同样的行，按前缀去重
    const key = line.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
    if (problems.length >= 5) break;
  }
  const code = typeof exitCode === 'number' ? exitCode : null;
  const ok = problems.length === 0 && code === 0;
  const reason = problems[0] || (ok ? null : `dump-config 退出码 ${code === null ? 'null' : code}`);
  return { ok, problems, exitCode: code, reason };
}

/**
 * 跑一个子进程，输出落临时文件再读回（**不用管道**）。
 *
 * 两个理由：
 * 1) 受限环境下管道 stdio 会 `spawn EPERM`（shell 沙箱不允许开命名管道），落文件可以；
 * 2) `--dump-config` 可能吐很大一棵树，写文件不会撑爆管道缓冲。
 */
function runToFile(command, args, options = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-precheck-'));
    const outPath = path.join(dir, 'stdout.txt');
    const errPath = path.join(dir, 'stderr.txt');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const collect = () => {
      let stdout = '';
      let stderr = '';
      try {
        stdout = fs.readFileSync(outPath, 'utf8');
      } catch {
        /* 读不到就当空 */
      }
      try {
        stderr = fs.readFileSync(errPath, 'utf8');
      } catch {
        /* 同上 */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清不掉不影响结果 */
      }
      return { stdout, stderr };
    };
    const closeFds = () => {
      try {
        fs.closeSync(outFd);
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(errFd);
      } catch {
        /* ignore */
      }
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (error) {
      closeFds();
      const collected = collect();
      resolve({ code: -1, ...collected, stderr: `${collected.stderr}${error.message}` });
      return;
    }

    let settled = false;
    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      closeFds();
      const collected = collect();
      resolve({ code, ...collected, stderr: extra ? `${collected.stderr}${extra}` : collected.stderr });
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          finish(null, '\n[precheck] 超时被终止');
        }, options.timeoutMs)
      : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      finish(-1, error.message);
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      finish(code);
    });
  });
}

/**
 * 用候选版本对**当前 profile** 组一次配置树（`--dump-config`，不启动服务）。
 *
 * 结果决定「装完要不要激活」：加载不了就当没装过，继续保持原版本可用。
 * 环境默认继承调用方（即真实 `~/.dsh`，或冒烟时的临时 DSH_HOME），只在显式给了
 * `home` 时覆盖。
 */
async function precheckProfile(options = {}) {
  const log = options.log || logNoop;
  const root = options.root;
  if (!root) return { ok: false, problems: [], exitCode: null, reason: '缺少候选安装根' };
  const binPath = path.join(root, 'node_modules', PKG_NAME, 'lib', 'bin.js');
  if (!fs.existsSync(binPath)) {
    return { ok: false, problems: [], exitCode: null, reason: `缺少 ${PKG_NAME}/lib/bin.js` };
  }
  const profile = String(options.profile || 'web');
  const env = {};
  if (options.home) env.DSH_HOME = options.home;
  log(`precheck: ${binPath} --profile ${profile} --dump-config${options.home ? `（DSH_HOME=${options.home}）` : ''}`);
  const result = await runToFile(options.nodePath || process.execPath, [binPath, '--profile', profile, '--dump-config'], {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs || 180_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const report = analyzeProfileReport(combined, result.code);
  // 进程根本没起来（EPERM/ENOENT 等）：这不是「profile 不兼容」，要说清楚
  if (!report.ok && result.code === -1) {
    const last = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '无法启动子进程';
    return { ...report, reason: `预检进程启动失败：${last}`, outputTail: combined.trim().slice(-1200) };
  }
  // 没有已知标记但退出码非 0：把最后一行真实报错带上，别只丢一个退出码
  if (!report.ok && report.problems.length === 0) {
    const last = combined.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    report.reason = `dump-config 退出码 ${report.exitCode === null ? 'null' : report.exitCode}${last ? `：${last.slice(0, 200)}` : ''}`;
  }
  log(`precheck: ${report.ok ? '通过' : `未通过（${report.reason}）`}`);
  return { ...report, outputTail: combined.trim().slice(-1200) };
}

// ---------------------------------------------------------------------------
// 激活 / 回滚 / 清理
// ---------------------------------------------------------------------------

function activate(baseDir, version, options = {}) {
  const root = versionRoot(baseDir, version);
  const guard = checkCompatibility(root);
  if (!guard.ok) throw new Error(`无法激活 v${version}：${guard.reason}`);
  const state = readState(baseDir);
  return writeState(baseDir, {
    activeVersion: version,
    // 上一可用版本：优先取刚被替换掉的版本；若当前处于内置回退态则沿用既有记录，
    // 这样"只保留当前 + 上一个可用版本"的清理策略在回退后仍然成立。
    previousVersion: state.activeVersion || state.previousVersion || null,
    lastResult: options.lastResult || 'activated',
  });
}

function deactivate(baseDir) {
  const state = readState(baseDir);
  return writeState(baseDir, {
    activeVersion: null,
    previousVersion: state.activeVersion || null,
    lastResult: 'rolled-back-to-bundled',
  });
}

/**
 * 回退到上一个可用版本（`state.previousVersion`）。
 *
 * 与「回到内置版本」的区别：这条只在两个覆盖版本之间切换，**不依赖内置版本能不能解析
 * 当前 profile**。2026-10-28 事故里，内置 0.1.5-rc.1 帮不上忙，能捞人的就是这一条。
 * 语义与 `activate` 一致：切换后两者互换，因此可以来回点。
 */
function rollbackToPrevious(baseDir) {
  const state = readState(baseDir);
  const target = state.previousVersion;
  if (!target) return { ok: false, reason: '没有可回退的上一个版本' };
  if (target === state.activeVersion) return { ok: false, reason: '上一个版本与当前版本相同' };
  const root = versionRoot(baseDir, target);
  if (!fs.existsSync(path.join(root, 'node_modules', PKG_NAME, 'lib', 'bin.js'))) {
    return { ok: false, reason: `上一个版本 v${target} 的安装目录已不存在` };
  }
  const next = activate(baseDir, target, { lastResult: 'rolled-back-to-previous' });
  return { ok: true, version: target, state: next };
}

/** 仅保留当前激活版本与上一个可用版本，其余版本目录删除。 */
function cleanup(baseDir, options = {}) {
  const dir = versionsDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  const state = readState(baseDir);
  const keep = new Set([state.activeVersion, state.previousVersion].filter(Boolean));
  if (options.keepVersion) keep.add(options.keepVersion);
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 端到端：检查 → 安装 → 冒烟 → 激活
// ---------------------------------------------------------------------------

/**
 * 一次完整的更新流程。返回结构化结果，供界面、日志与测试使用。
 */
async function updateToLatest(options) {
  const log = options.log || logNoop;
  const onProgress = options.onProgress || logNoop;
  const baseDir = options.baseDir;

  onProgress('正在检查官方版本…');
  const check = await checkForUpdate({
    currentVersion: options.currentVersion,
    channel: options.channel,
    registry: options.registry,
  });
  if (!check.target) {
    return { status: 'error', stage: 'check', message: '无法从注册表解析目标版本', check };
  }
  if (!check.hasUpdate) {
    return {
      status: 'up-to-date',
      stage: 'check',
      message: check.isDowngrade
        ? `当前版本 v${check.current} 高于 ${check.tag} 通道的 v${check.target}（官方可能已撤回），可选择回退`
        : `已是最新版本 v${check.current}`,
      check,
    };
  }

  onProgress(`发现新版本 v${check.target}，开始下载安装…`);
  const install = await installVersion({
    version: check.target,
    nodePath: options.nodePath,
    npmCliPath: options.npmCliPath,
    baseDir,
    registry: options.registry,
    log,
    onProgress,
  });

  if (!options.skipSmoke) {
    onProgress('正在验证候选版本能否正常启动…');
    const smoke = await smokeTest({
      root: install.root,
      nodePath: options.nodePath,
      log,
      // 与真实运行保持同一工作目录，避免冒烟结果与线上行为不一致
      cwd: options.cwd,
      portStart: options.smokePortStart,
    });
    if (!smoke.ok) {
      fs.rmSync(install.root, { recursive: true, force: true });
      return {
        status: 'error',
        stage: 'smoke',
        message: `新版本 v${check.target} 冒烟验证失败，已丢弃并保持原版本：${smoke.reason}`,
        check,
        smoke,
      };
    }
  }

  // 冒烟只证明「这个引擎自己起得来」；这里再证明「它加载得了你现在这份 profile」。
  // 2026-10-28 的事故就发生在这一步之前没做检查：装好、激活、重启，然后整条工具链 pending。
  if (options.profilePrecheck !== false) {
    onProgress('正在用当前 profile 预检候选版本…');
    const pre = await precheckProfile({
      root: install.root,
      nodePath: options.nodePath,
      cwd: options.cwd,
      home: options.home,
      log,
    });
    if (!pre.ok) {
      fs.rmSync(install.root, { recursive: true, force: true });
      return {
        status: 'error',
        stage: 'profile-precheck',
        message:
          `新版本 v${check.target} 加载不了你当前的 profile，已放弃并保持 v${check.current}：${pre.reason}` +
          '（原因通常是某个插件钉死了旧版 @deepseek-ai/* 包，或插件还没适配这个引擎版本）',
        check,
        profile: pre,
      };
    }
  }

  const state = activate(baseDir, check.target, { lastResult: 'activated' });
  const removed = cleanup(baseDir);
  return {
    status: 'updated',
    stage: 'activate',
    message: `已更新到 v${check.target}，重启服务后生效`,
    check,
    install: { version: install.version, root: install.root, integrity: install.integrity },
    state,
    removedVersions: removed,
  };
}

module.exports = {
  PKG_NAME,
  DEFAULT_REGISTRY,
  CHANNEL_TAGS,
  parseVersion,
  compareVersions,
  fetchPackument,
  resolveTargetVersion,
  checkForUpdate,
  versionsDir,
  versionRoot,
  statePath,
  readState,
  writeState,
  resolveActiveRoot,
  readPackageVersion,
  checkCompatibility,
  checkProfileBundles,
  installVersion,
  SMOKE_ENV_ALLOWLIST,
  minimalSmokeEnv,
  smokeTest,
  analyzeProfileReport,
  precheckProfile,
  activate,
  deactivate,
  rollbackToPrevious,
  cleanup,
  updateToLatest,
};
