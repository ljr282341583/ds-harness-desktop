'use strict';

/**
 * DS Harness Desktop — Electron 主进程
 *
 * 职责：单实例锁 → 解析端口 → spawn 捆绑的 dsh web 子进程 → 就绪探测 →
 *       窗口加载本地 URL → 托盘（显示/重启/检查更新/退出）→ 生命周期管理。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const updater = require('./updater.js');
const { startMobileRelay } = require('./relay.js');
const { resolveTailnetAddress, pickHost } = require('./tailnet.js');
const { qrToPng } = require('./qr-png.js');
const { autoUpdater } = require('electron-updater');

// 起始端口可用 DSH_DESKTOP_PORT 覆盖：冒烟/验证时本机往往已有 dsh web 占着 3080，
// 固定端口会走到「复用已有实例」分支，验证就测不到真实启动路径。
const DEFAULT_PORT = Number(process.env.DSH_DESKTOP_PORT) || 3080;
const MAX_PORT_TRIES = 10;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
// 判定「启动失败」还是「运行中途崩溃」的时间窗：只有在这个窗口内退出、且**从未成功
// 加载过 UI**，才算启动失败（才可能触发回退内置版本）。2026-09-30 事故就是旧判据把
// 「跑了 4.6 小时后的静默崩溃」当成「覆盖版本启动失败」，当场永久降级。
const STARTUP_GRACE_MS = 60_000;
// 运行中途崩溃后的自动重启预算（滑动窗口内最多几次）；预算用尽只报错，不再改版本状态。
const CRASH_RESTART_LIMIT = 3;
const CRASH_RESTART_WINDOW_MS = 30 * 60_000;
// 「健康长跑」门槛：跑够这么久再崩，视为独立事故，清空重启预算。
const HEALTHY_UPTIME_MS = 10 * 60_000;
// 等待 dsh 打印带 token 地址的上限。首次启动或刚换到新版本时，
// dsh 需要初始化 profile（实测冷启动可达 60 秒以上），因此这里明显长于就绪探测超时。
const TOKEN_WAIT_TIMEOUT_MS = 120_000;

let mainWindow = null;
let tray = null;
let dshChild = null;
let dshPort = DEFAULT_PORT;
let quitting = false;
let lastError = '';
// dsh 0.1.5+ 的 Web UI 需要进程级 token：启动时它会把带 token 的地址打到 stdout，
// 拿它加载一次即可换成签名 cookie，之后裸地址也能访问。
let webLaunchUrl = null;
let childOutBuffer = '';
// 是否已经结束「等待 token 地址」；用于识别「迟到一步」的 token 地址并补救
let tokenWaitSettled = false;

// 应用内热更新的安装根：放在用户数据目录，NSIS 安装版与 portable 便携版通用，重装不丢。
// 惰性取值：app.getPath 在主进程 ready 之前调用不被官方保证。
let _updateBaseDir = null;
function updateBaseDir() {
  if (_updateBaseDir === null) _updateBaseDir = path.join(app.getPath('userData'), 'dsh-update');
  return _updateBaseDir;
}
let updateInProgress = false;
// 覆盖版本启动失败时只自动回退一次，避免回退失败后无限重启
let overrideFallbackDone = false;
// 因自动回退而被停用的覆盖版本：内置版本同样起不来时，用它把 state.json 恢复回去。
// 2026-09-30 事故只能靠手工改 state.json 才恢复；这里让壳自己完成这一步。
let fallbackFromVersion = null;
// 运行中途崩溃的自动重启时间戳（滑动窗口，见 CRASH_RESTART_LIMIT）
let crashRestarts = [];
// 串行化 harness 的「停/起」操作（2026-09-30 实锤：同一秒两次 restart 拉起两个子进程）
let harnessQueue = Promise.resolve();
// 本次启动在 dsh-child.log 里的起始字节偏移：错误页只展示本次输出（日志是追加+轮转的）
let childLogStart = 0;

// 外壳（桌面端自身）更新状态
const SHELL_RELEASES_URL = 'https://github.com/ljr282341583/ds-harness-desktop/releases/latest';
let shellUpdateInProgress = false;
let shellUpdateReady = null;
// 记录当前 dsh 子进程的退出，供"干净停机"等待使用
let dshExitPromise = null;

// ---------------------------------------------------------------------------
// 手机访问（中继跑在主进程内 → 天然随桌面端生死，不留孤儿进程）
// ---------------------------------------------------------------------------
// 它只把"手机够得着的尾网地址"接到 127.0.0.1:<dshPort>，**不持有任何凭据**：
// 认证仍由官方启动令牌 + 30 天 cookie 负责。因此：
//   · 起中继不需要令牌（dsh 重启换令牌也不影响已配对的手机）；
//   · 只有"扫码配对"那一下需要带令牌的地址，按需从 webLaunchUrl 现算。
const MOBILE_PORT_START = 8787;
const MOBILE_PORT_TRIES = 8;
let mobileRelay = null;        // { port, host, close() }
let mobileAddress = null;      // { ip, dns, source }
let mobileError = '';          // 人话原因：拿不到尾网地址 / 端口起不来
let mobilePrefs = { enabled: true, preferIp: false };
let pairWindow = null;         // 「配对二维码」小窗

// 简单文件日志（GUI 应用无控制台，重定向又不可靠，写文件最稳）
// 日志只增不减会越积越大（dsh 出错时会打印几十 KB 的堆栈），因此做单份轮转：
// 超过上限就把当前文件改名为 <file>.1（覆盖旧的 .1），保持最多两份。
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_CHECK_EVERY_WRITES = 200;
let _logFile = null;
let _logWrites = 0;

/** 日志超过上限则轮转；失败不影响主流程。 */
function rotateLogIfTooLarge(file) {
  try {
    if (fs.statSync(file).size < LOG_MAX_BYTES) return false;
    const backup = `${file}.1`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(file, backup);
    return true;
  } catch {
    return false;
  }
}

function log(...args) {
  try {
    const isFirstWrite = _logFile === null;
    if (isFirstWrite) {
      _logFile = path.join(app.getPath('userData'), 'dsh-desktop.log');
    }
    let rotated = false;
    if (isFirstWrite) {
      // 启动时兜底检查：上次会话可能已经留下超大日志
      rotated = rotateLogIfTooLarge(_logFile);
    } else if (++_logWrites >= LOG_CHECK_EVERY_WRITES) {
      // 长跑时定期检查，避免每条日志都 stat
      _logWrites = 0;
      rotated = rotateLogIfTooLarge(_logFile);
    }
    if (rotated) {
      fs.appendFileSync(_logFile, `[${new Date().toISOString()}] 日志超过 5 MB，已轮转为 dsh-desktop.log.1\n`);
    }
    fs.appendFileSync(_logFile, `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 单实例锁：二次启动时聚焦已有窗口
// ---------------------------------------------------------------------------
// 冒烟/验证隔离：DSH_DESKTOP_USER_DATA 重定向用户数据目录（日志、更新状态、单实例锁），
// 让验证实例与真实安装实例互不干扰，也不污染真实日志。必须在取单实例锁之前生效。
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}

// 验证/冒烟模式（DSH_DESKTOP_SMOKE=1）：不抢单实例锁，允许与正在运行的正式实例并存。
// 仅验证用途；三个隔离 env（端口 / userData / 本开关）齐用才能保证互不干扰。
const gotLock = process.env.DSH_DESKTOP_SMOKE === '1' || app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[dsh-desktop] bootstrap failed:', err);
    app.quit();
  });
}

// Windows：关闭所有窗口后不退出，常驻托盘
app.on('window-all-closed', () => {
  /* keep running in tray */
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  stopHarness();
  void stopMobileAccess();
});

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------
async function bootstrap() {
  log('bootstrap start, userData=', app.getPath('userData'));

  // 覆盖版本目录缺失或损坏时清理状态，避免用坏路径启动（内置版本是保底）
  try {
    const overrideState = updater.readState(updateBaseDir());
    if (overrideState.activeVersion && !updater.resolveActiveRoot(updateBaseDir())) {
      // 覆盖版本目录坏了。能不能降级到内置版本，取决于内置版本能不能满足当前 profile：
      // 满足不了时降级 = 把用户永久锁死（2026-09-30 那次就是靠手工改 state.json 才恢复）。
      // 这种情况宁可保留 state 不动：启动失败会走「报真实原因」那条路，用户修好或重装
      // 覆盖版本即可恢复，而 state 一旦被清掉就再也回不去了。
      const gaps = bundledProfileGaps();
      if (gaps.checked && !gaps.ok) {
        log(
          '[updater] 覆盖版本目录不可用，但内置版本解析不了当前 profile，保留 state 不做降级：',
          overrideState.activeVersion, '|', gaps.reason,
        );
      } else {
        log('active override unusable, falling back to bundled:', overrideState.activeVersion);
        updater.deactivate(updateBaseDir());
      }
    }
  } catch (error) {
    log('override state check failed:', error.message);
  }

  ipcMain.handle('dsh:get-port', () => dshPort);
  ipcMain.handle('dsh:get-error', () => lastError);
  ipcMain.handle('dsh:restart', async () => {
    log('restart requested');
    await restartHarness();
    return dshPort;
  });
  ipcMain.handle('dsh:get-versions', () => describeVersions());
  ipcMain.handle('dsh:update-check', async () => performUpdate({ silent: true }));
  ipcMain.handle('dsh:update-channel', async (_event, channel) => {
    setUpdateChannel(channel);
    return describeVersions();
  });
  ipcMain.handle('dsh:update-rollback', async () => rollbackToBundled());
  ipcMain.handle('dsh:shell-update-check', async () => checkShellUpdate({ silent: true }));
  ipcMain.handle('dsh:shell-update-install', async () => installShellUpdate());

  // 手机访问：状态 / 开关 / 二维码 / 复制地址
  mobilePrefs = loadMobilePrefs();
  ipcMain.handle('mobile:status', () => mobileStatus());
  ipcMain.handle('mobile:set-enabled', (_event, enabled) => setMobileEnabled(Boolean(enabled)));
  ipcMain.handle('mobile:set-prefer-ip', (_event, preferIp) => setMobilePreferIp(Boolean(preferIp)));
  ipcMain.handle('mobile:qr', () => mobileQrPayload());
  ipcMain.handle('mobile:copy-address', () => copyMobileAddress());
  ipcMain.handle('mobile:show-qr', () => {
    showPairWindow();
    return true;
  });

  initShellUpdater();

  createWindow();
  log('window created');
  buildAppMenu();
  createTray();
  log('tray created');
  await startHarness();
  log('bootstrap done');
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'DS Harness Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 先显示本地 loading 页，harness 就绪后再切换
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    if (!quitting) mainWindow.show();
  });

  // 关闭 = 最小化到托盘（除非正在退出）
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 新窗口/外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// 端口解析
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
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const candidate = start + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`no free port in range ${start}..${start + MAX_PORT_TRIES - 1}`);
}

// ---------------------------------------------------------------------------
// harness 子进程
// ---------------------------------------------------------------------------
function dshBinPath() {
  // 优先使用应用内更新下载的版本；没有则回退到随安装包捆绑的内置版本
  const overrideRoot = updater.resolveActiveRoot(updateBaseDir());
  if (overrideRoot) {
    return path.join(overrideRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
  const dshRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
  return path.join(dshRoot, 'lib', 'bin.js');
}

/** 随安装包捆绑的 dsh 版本（保底版本）。 */
function bundledDshVersion() {
  try {
    const dshRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
    return updater.readPackageVersion(dshRoot);
  } catch {
    return null;
  }
}

/** 内置 dsh 安装根（打包态 resources/app、开发态 app/），即 `node_modules` 的父目录。 */
function bundledInstallRoot() {
  try {
    // require.resolve 从本文件出发，命中的永远是壳自带的 dsh = 内置版本（不是覆盖版本）
    return path.resolve(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), '..', '..', '..');
  } catch {
    return null;
  }
}

/** 当前 dsh profile 目录（`dsh web` 的默认 profile 名是 web）。 */
function profileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'web');
}

/**
 * 回退前的预检：内置版本能不能解析当前 profile 的 bundle 列表？
 *
 * `dsh-app-boot` 解析 bundle 只查两个锚点（该安装的 node_modules + profile 自己的
 * node_modules），任一处缺失就 throw、整个 boot 失败。2026-09-30 实锤：profile 里的
 * 语音输入 bundle 只在 dsh ≥ 0.1.7 发布过，内置 0.1.5-rc.1 永远解析不了 —— 此时
 * 「回退到内置版本」不是保底，而是把用户锁死在注定起不来的版本上。所以先问一句。
 *
 * 读不到 profile 清单（不存在 / 解析失败）时不阻断，保持原有回退行为。
 */
function bundledProfileGaps() {
  const installRoot = bundledInstallRoot();
  if (!installRoot) return { ok: true, checked: false, missing: [], reason: '定位不到内置安装根' };
  return updater.checkProfileBundles({ installRoot, profileDir: profileDir() });
}

/** 当前实际生效的 dsh 版本：有覆盖版本则用覆盖版本，否则是内置版本。 */
function currentDshVersion() {
  const state = updater.readState(updateBaseDir());
  return state.activeVersion || bundledDshVersion();
}

/** 供界面与托盘使用的版本/通道快照。 */
function describeVersions() {
  const state = updater.readState(updateBaseDir());
  return {
    shell: app.getVersion(),
    dsh: currentDshVersion(),
    dshSource: state.activeVersion ? 'updated' : 'bundled',
    bundledDsh: bundledDshVersion(),
    activeVersion: state.activeVersion,
    previousVersion: state.previousVersion,
    lastResult: state.lastResult,
    channel: state.channel,
    updateBaseDir: updateBaseDir(),
    updateInProgress,
  };
}

/**
 * 定位用于执行安装的 npm CLI。
 * 打包时需把 npm 一并放进侧车运行时（见 app/README.md「准备 Node 24 侧车」）；
 * 开发态回退到本机 Node 自带 npm。
 */
function resolveNpmCliPath() {
  const candidates = [
    process.env.DSH_DESKTOP_NPM_CLI,
    path.join(path.dirname(resolveNodePath()), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.resourcesPath || '', 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(__dirname, '..', 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => candidate && fs.existsSync(candidate));
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * 解析用于运行 dsh 的 Node 运行时。
 *
 * DSH 依赖 Node 22.15+ 的新 API（node:zlib 的 zstd、node:module 的
 * stripTypeScriptTypes），而 Electron 自带 Node 版本可能过低（Electron 33 为
 * Node 20）。因此优先使用捆绑的独立 Node 侧车，而不是 Electron 自带 Node。
 */
function resolveNodePath() {
  const candidates = [
    process.env.DSH_DESKTOP_NODE,                                  // 显式覆盖
    path.join(process.resourcesPath || '', 'runtime', 'node.exe'), // 打包态：resources/runtime
    path.join(__dirname, '..', 'runtime', 'node.exe'),             // 开发态：app/runtime
  ].filter((candidate) => candidate && fs.existsSync(candidate));
  if (candidates.length > 0) return candidates[0];
  return 'node'; // 开发期回退到 PATH 上的 node（本机为 Node 24）
}

/**
 * 解析桌面版 dsh 的工作目录（workspace 根）。
 * 关键：必须显式指定，否则 dsh 会继承 Electron 的 cwd（可能是项目目录/桌面），
 * 导致 workspace 识别错误并污染共享的 ~/.dsh 索引。
 * 默认用户主目录，可用环境变量 DSH_DESKTOP_CWD 覆盖。
 */
function resolveCwd() {
  return process.env.DSH_DESKTOP_CWD || os.homedir();
}

/**
 * 探测某端口是否已有 DSH web 实例在跑，并区分「可复用」与「要求鉴权」。
 * 若已有（例如用户已开网页版），桌面版应直接复用而不是新开一个实例，
 * 否则两个实例会并发读写共享的 ~/.dsh，污染 workspace/会话索引。
 *
 * 用 Electron 会话发起请求（会带上本应用已获得的 dsh-auth cookie）：
 *  - 200 等非 401 响应 → 'ok'，可复用
 *  - 401 → 'auth-required'，该实例要 token，本应用没有可用 cookie，不能直接复用
 *  - 连接失败 → null，端口空闲
 */
async function probeExistingInstance(port, timeout = 2000) {
  try {
    const res = await session.defaultSession.fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 401) return 'auth-required';
    return res.status < 500 ? 'ok' : null;
  } catch {
    return null;
  }
}

/** 从 dsh 子进程输出里解析带 token 的启动地址。 */
function captureLaunchUrl(text) {
  childOutBuffer = (childOutBuffer + text).slice(-16_384);
  if (webLaunchUrl !== null) return;
  const match = childOutBuffer.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
  if (match) {
    webLaunchUrl = match[0];
    log('captured token launch url');
    // 冷启动时 dsh 可能晚于等待超时才打印 token 地址。此时窗口很可能已经按兜底逻辑
    // 加载了裸地址，而新版 Web UI 对裸地址返回 401 —— 必须改用带 token 的地址重载。
    if (tokenWaitSettled && !quitting && dshChild !== null && mainWindow) {
      log('late token url → reloading with token');
      mainWindow.loadURL(webLaunchUrl).catch((error) => log('late token reload failed:', error.message));
    }
  }
}

/** 等待 dsh 打出带 token 的地址；子进程提前退出或超时则返回 null。 */
function waitForLaunchUrl(timeout = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const tick = () => {
      if (webLaunchUrl !== null) return resolve(webLaunchUrl);
      if (quitting || dshChild === null) return resolve(null);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * 串行化 harness 的「停/起」操作：同一时刻只允许一个启动流程在跑。
 *
 * 2026-09-30 实锤：两次 restart 请求在同一秒各自 stop+start，3080 上出现两个 dsh 子进程、
 * 手机中继同时占了 8787 与 8788。凡改动子进程状态的操作，一律从这里排队。
 */
function runHarnessOp(fn) {
  const run = () => fn();
  const result = harnessQueue.then(run, run);
  harnessQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** 启动 harness（排队执行）。 */
function startHarness() {
  return runHarnessOp(() => startHarnessNow());
}

/** 先停再起（托盘「重启服务」/ 更新后重启 / 手动回退都走这里，起这一步天然互斥）。 */
function restartHarness() {
  // 立刻停：正在等待启动的流程会因为「子进程没了」马上收尾，不必干等 token（最长 120 秒）。
  // 起这一步再排队，保证同一时刻只有一个子进程被拉起。
  stopHarness();
  return runHarnessOp(() => startHarnessNow());
}

async function startHarnessNow() {
  if (quitting) {
    log('startHarness: 正在退出，跳过拉起');
    return;
  }
  // 已有存活子进程：吸收重复的启动请求，不重复拉起
  if (dshChild && dshChild.exitCode === null && !dshChild.killed) {
    log('startHarness: 已有存活子进程，跳过本次拉起');
    return;
  }
  // 1) 默认端口已有 DSH 实例 → 直接复用，避免双实例并发写 ~/.dsh
  const existing = await probeExistingInstance(DEFAULT_PORT);
  if (existing === 'auth-required') {
    dshPort = DEFAULT_PORT;
    log('existing instance requires token, will not reuse');
    showErrorPage(
      '端口 3080 上已有 DSH 实例在运行，但新版 harness 要求带 token 访问：' +
      '请用它启动时打印的地址（形如 http://127.0.0.1:3080/?token=…）在浏览器打开，' +
      '或先退出那个实例再启动桌面版。',
    );
    return;
  }
  if (existing === 'ok') {
    dshPort = DEFAULT_PORT;
    log('reusing existing dsh instance on port', dshPort);
    await mainWindow.loadURL(`http://127.0.0.1:${dshPort}/`);
    return;
  }

  dshPort = await findFreePort(DEFAULT_PORT);
  const bin = dshBinPath();
  const nodePath = resolveNodePath();
  const cwd = resolveCwd();
  webLaunchUrl = null;
  childOutBuffer = '';
  tokenWaitSettled = false;
  log('startHarness: port=', dshPort, 'node=', nodePath, 'bin=', bin, 'cwd=', cwd);

  // dsh 子进程输出写到日志文件（GUI 应用无控制台，inherit 会弹出 cmd 窗口）
  // 每次拉起 dsh 前先按大小轮转，避免崩溃堆栈把日志撑爆
  const logPath = childLogPath();
  let childLogFd = null;
  let childLogClosed = false;
  const closeChildLog = () => {
    if (childLogClosed) return;
    childLogClosed = true;
    try {
      if (childLogFd != null) fs.closeSync(childLogFd);
    } catch {
      /* ignore */
    }
  };
  try {
    rotateLogIfTooLarge(logPath);
    // 记下本次启动在日志里的起点：错误页只展示「本次」的输出，别把上一趟的堆栈当成本次原因
    childLogStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    childLogFd = fs.openSync(logPath, 'a');
  } catch {
    /* ignore */
  }

  // --no-open：dsh web 默认会用系统浏览器打开 UI，桌面版自己已有窗口，
  // 不要再弹浏览器标签页。
  const child = spawn(nodePath, [bin, 'web', '--port', String(dshPort), '--no-open'], {
    cwd,
    env: { ...process.env },
    // stdout 要读（提取带 token 的启动地址），同时落盘到日志文件
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // 关键：隐藏 dsh 子进程的控制台窗口
  });
  dshChild = child;
  const startedAt = Date.now();
  // 本次子进程是否成功加载过 UI —— 区分「启动失败」与「运行中途崩溃」的判据
  let reachedUi = false;
  dshExitPromise = new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  log('spawned dsh pid=', child.pid);
  // 中继只依赖 dshPort（配对地址在需要时现算，令牌可能稍后才到）
  void startMobileAccess();

  const teeToLog = (chunk) => {
    if (childLogFd == null) return;
    try {
      fs.writeSync(childLogFd, chunk);
    } catch {
      /* ignore */
    }
  };
  child.stdout?.on('data', (chunk) => {
    teeToLog(chunk);
    captureLaunchUrl(chunk.toString('utf8'));
  });
  child.stderr?.on('data', teeToLog);

  // spawn 失败（node.exe 不在 / 被杀软拦下）只触发 'error'、不触发 'exit'：不在这里接住，
  // 下面那一整套「启动失败 → 回退/重启」判定一次都不会跑，界面要空等 150 秒才报一句
  // 零信息文案（120 秒 token 等待 + 30 秒就绪探测）。
  child.on('error', (error) => {
    closeChildLog();
    if (dshChild !== child) return;
    dshChild = null;
    log('dsh child spawn error:', error.code || '', error.message);
    if (quitting) return;
    if (scheduleCrashRestart(`无法启动 dsh 进程（${error.code || error.message}）`)) return;
    showHarnessErrorPage(`无法启动 dsh 进程：${error.message}`);
  });

  child.on('exit', (code, signal) => {
    closeChildLog();
    // 陈旧子进程的退出事件（stopHarness 杀掉的旧实例）不是当前实例的失败 → 忽略。
    // 否则更新流程「先 activate 再 stopHarness」会让旧进程的退出被误判为
    // 「覆盖版本启动失败」，当场 deactivate 掉刚激活的新版本（2026-09-24 实锤：
    // 旧进程 SIGTERM 退出后 1ms 就触发回退，覆盖版本从未被拉起过一次）。
    if (dshChild !== child) return;
    dshChild = null;
    const uptimeMs = Date.now() - startedAt;
    log(
      'dsh child exited: code=', code, 'signal=', signal, 'quitting=', quitting,
      'uptimeMs=', uptimeMs, 'reachedUi=', reachedUi,
    );
    if (quitting) return;

    // 跑够久且真的起过 UI = 健康长跑，清空重启预算（别让偶发崩溃累加成「崩溃循环」）
    if (reachedUi && uptimeMs >= HEALTHY_UPTIME_MS) crashRestarts = [];

    // 判据必须窄：只有「从未加载过 UI + 仍在启动阶段」才算启动失败（才可能回退版本）。
    // 「仍在启动阶段」= 未到宽限期，或 token 等待（120 秒）本身还没结束 —— 一个卡了 90 秒
    // 才崩、从未起过 UI 的进程同样算启动失败，不能因为超过宽限期就永远不回退。
    // 2026-09-30 实锤：跑满 4.6 小时后的 code=1 静默退出被当成「覆盖版本启动失败」，
    // 当场 deactivate → 用户被永久锁死在注定起不来的内置版本上。
    const startupFailure = !reachedUi && (uptimeMs < STARTUP_GRACE_MS || !tokenWaitSettled);
    if (!startupFailure) {
      if (scheduleCrashRestart(`运行中途崩溃（code=${code}，已运行 ${Math.round(uptimeMs / 1000)} 秒）`)) return;
      showHarnessErrorPage(`harness 子进程反复崩溃（code=${code}，signal=${signal}）`);
      return;
    }

    const overrideState = updater.readState(updateBaseDir());
    // 覆盖版本启动失败 → 自动回退到内置版本并重启一次（内置版本是保底），只回退一次。
    // 回退前先确认回退真的有用：内置版本解析不了当前 profile 时，回退等于把用户锁死。
    if (overrideState.activeVersion && !overrideFallbackDone) {
      const gaps = bundledProfileGaps();
      if (!gaps.ok) {
        log('[updater] 覆盖版本启动失败，但内置版本解析不了当前 profile，跳过回退：', gaps.reason);
        if (scheduleCrashRestart('覆盖版本启动失败（回退无意义）')) return;
        showHarnessErrorPage(
          `覆盖版本 dsh v${overrideState.activeVersion} 启动失败；内置版本也无法加载当前 profile（${gaps.reason}）。\n` +
          `profile 清单：${path.join(profileDir(), 'package.json')}`,
        );
        return;
      }
      overrideFallbackDone = true;
      fallbackFromVersion = overrideState.activeVersion;
      log('[updater] 覆盖版本启动失败，回退内置版本：', overrideState.activeVersion);
      updater.deactivate(updateBaseDir());
      startHarness().catch((error) => log('fallback restart failed:', error.message));
      return;
    }

    // 已回退过、内置版本也起不来 → 把覆盖版本恢复回去：宁可回到用户原本能用的版本，
    // 也不要停在注定起不来的内置版本上（2026-09-30 靠手工改 state.json 才恢复）。
    // 只恢复一次（用完即把 overrideFallbackDone 置回，避免两个版本互相踢皮球）。
    if (!overrideState.activeVersion && fallbackFromVersion) {
      const version = fallbackFromVersion;
      fallbackFromVersion = null;
      overrideFallbackDone = true;
      try {
        updater.activate(updateBaseDir(), version, { lastResult: 'auto-restored-after-bundled-failure' });
        log('[updater] 内置版本同样起不来，已恢复覆盖版本：', version);
        startHarness().catch((error) => log('restore restart failed:', error.message));
        return;
      } catch (error) {
        log('[updater] 恢复覆盖版本失败：', error.message);
      }
    }

    showHarnessErrorPage(`harness 子进程已退出（code=${code}，signal=${signal}）`);
  });

  const launchUrl = await waitForLaunchUrl(TOKEN_WAIT_TIMEOUT_MS);
  tokenWaitSettled = true;
  log('waitForLaunchUrl result=', launchUrl === null ? 'null' : 'token-url');
  if (launchUrl !== null) {
    overrideFallbackDone = false;
    reachedUi = true;
    await mainWindow.loadURL(launchUrl);
    log('loaded web UI (token)');
    return;
  }

  // 子进程已经退出：不再空等 30 秒就绪探测。退出回调要么已安排好回退/重启，要么已把
  // 真实原因写上错误页。2026-09-30 事故里这一步空等 30 秒，最后只报出「服务未在预期
  // 时间内就绪」这句零信息文案，把「子进程一启动就崩」掩盖成了「启动慢」。
  if (!quitting && dshChild === null) {
    log('startup aborted: 子进程已退出，跳过就绪探测');
    return;
  }

  // 兜底：老版本 dsh 不打 token 地址，退回「端口就绪即加载」
  const ready = dshChild === null ? false : await waitForReady(dshPort);
  log('waitForReady result=', ready);
  if (ready) {
    overrideFallbackDone = false;
    reachedUi = true;
    await mainWindow.loadURL(`http://127.0.0.1:${dshPort}/`);
    log('loaded web UI (legacy)');
  } else if (!quitting) {
    showHarnessErrorPage(
      `harness 服务未在预期时间内就绪（当前 dsh v${currentDshVersion() || '未知'}，端口 ${dshPort} 无监听）`,
    );
  }
}

function stopHarness() {
  void stopMobileAccess();   // 先收中继：dsh 没了它也转发不出去
  if (!dshChild) return;
  const pid = dshChild.pid;
  try {
    dshChild.kill(); // Windows 上 Node 直接终止进程
  } catch {
    /* ignore */
  }
  // 清理整棵进程树（dsh 会派生 bash/pwsh 等终端子进程）
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    /* ignore */
  }
  dshChild = null;
}

/**
 * 停止 dsh 子进程并等待它真正退出。
 *
 * 自动更新必须用这个：安装器一旦开跑就会删除/替换安装目录里的文件，
 * 若此时 dsh 子进程（resources\runtime\node.exe）还活着，文件被占用会导致
 * 「删了一半、装不回来」的残缺安装 —— v0.3.1 的自动更新就是这样把应用装坏的。
 */
function stopHarnessAndWait(timeoutMs = 8000) {
  const exitPromise = dshExitPromise;
  stopHarness();
  if (exitPromise === null) return Promise.resolve(true);
  return Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// 就绪探测
// ---------------------------------------------------------------------------
function waitForReady(port, timeout = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const tick = () => {
      if (quitting) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, READY_POLL_MS);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

function showErrorPage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastError = message;
  // 不用 loadFile 的 query（file:// 带 query 会触发 ERR_ABORTED），改经 IPC 传错误信息
  mainWindow.loadFile(path.join(__dirname, 'error.html'));
  if (!mainWindow.isVisible()) mainWindow.show();
}

/** dsh 子进程日志文件路径（拉起子进程与错误页都用它）。 */
function childLogPath() {
  return path.join(app.getPath('userData'), 'dsh-child.log');
}

/** 子进程日志尾部：错误页靠它给出真实原因，而不是一句「服务未就绪」的零信息文案。 */
function childLogTail(maxLines = 20, maxChars = 2000) {
  try {
    const buf = fs.readFileSync(childLogPath());
    // 从本次启动的起点读起：日志是追加写的，不截断就会把上一趟的堆栈当成本次原因
    const from = Math.max(0, Math.min(childLogStart, buf.length));
    const lines = buf
      .subarray(from)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    const tail = lines.slice(-maxLines).join('\n');
    // 令牌脱敏：dsh 启动时会把带 token 的地址打到 stdout，而错误页会被截图/贴进 issue
    const masked = tail.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    return masked.length > maxChars ? masked.slice(-maxChars) : masked;
  } catch {
    return '';
  }
}

/** 错误页 + 子进程日志尾部（bundle 解析失败、插件报错等真实原因都在里面）。 */
function showHarnessErrorPage(message) {
  const tail = childLogTail();
  showErrorPage(tail ? `${message}\n\n—— dsh 子进程最后输出 ——\n${tail}` : message);
}

/**
 * 运行中途崩溃后的自动重启（限次 + 退避）。返回 false 表示预算已用尽，调用方应报错页。
 *
 * 与「回退内置版本」的区别：这里只重启**同一个版本**。中途崩溃多半与版本无关
 * （外部强杀、内存压力、进程内 abort），先原地重启；连版本状态都不该动。
 */
function scheduleCrashRestart(reason) {
  const now = Date.now();
  crashRestarts = crashRestarts.filter((ts) => now - ts < CRASH_RESTART_WINDOW_MS);
  if (crashRestarts.length >= CRASH_RESTART_LIMIT) {
    log(
      '[recovery] 自动重启预算用尽（',
      `${CRASH_RESTART_LIMIT} 次 / ${Math.round(CRASH_RESTART_WINDOW_MS / 60_000)} 分钟）：`,
      reason,
    );
    return false;
  }
  crashRestarts.push(now);
  const attempt = crashRestarts.length;
  const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  log(`[recovery] ${reason} → ${Math.round(delayMs / 1000)} 秒后按同一版本重启（第 ${attempt}/${CRASH_RESTART_LIMIT} 次）`);
  setTimeout(() => {
    if (quitting) return;
    startHarness().catch((error) => log('crash restart failed:', error.message));
  }, delayMs);
  return true;
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let icon = nativeImage.createEmpty();
  try {
    if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath);
  } catch {
    /* fall back to empty */
  }

  tray = new Tray(icon);
  refreshTrayMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

/** 重建托盘菜单与提示语（版本、通道、更新状态变化后调用）。 */
function refreshTrayMenu() {
  if (!tray) return;
  const info = describeVersions();
  const sourceLabel = info.dshSource === 'updated' ? '已更新' : '内置';
  tray.setToolTip(`DS Harness Desktop — dsh v${info.dsh}（${sourceLabel}）`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: showWindow },
      {
        label: '重启服务',
        click: () => {
          log('restart requested (tray)');
          restartHarness().catch((error) => log('restart failed:', error.message));
        },
      },
      { type: 'separator' },
      { label: mobileMenuLabel(), click: () => showPairWindow() },
      {
        label: '手机访问',
        type: 'checkbox',
        checked: mobilePrefs.enabled,
        click: (item) => {
          void setMobileEnabled(item.checked);
        },
      },
      {
        label: '复制手机地址',
        enabled: Boolean(currentMobileUrl()),
        click: () => {
          void copyMobileAddress();
        },
      },
      { type: 'separator' },
      {
        label: `桌面端 v${info.shell} ｜ dsh v${info.dsh}（${sourceLabel}）`,
        enabled: false,
      },
      {
        label: updateInProgress ? '正在更新 dsh…' : '检查 dsh 更新',
        enabled: !updateInProgress,
        click: () => {
          performUpdate({ silent: false }).catch((error) => log('[updater] 未处理异常：', error.message));
        },
      },
      {
        label: '更新通道',
        submenu: [
          {
            label: '官方推荐（stable → latest）',
            type: 'radio',
            checked: info.channel === 'stable',
            click: () => setUpdateChannel('stable'),
          },
          {
            label: '尝鲜（preview → next）',
            type: 'radio',
            checked: info.channel === 'preview',
            click: () => setUpdateChannel('preview'),
          },
        ],
      },
      {
        label: shellUpdateReady ? `重启并安装 v${shellUpdateReady.version}` : '检查桌面端更新',
        enabled: !shellUpdateInProgress && !updateInProgress,
        click: () => {
          const task = shellUpdateReady ? installShellUpdate() : checkShellUpdate({ silent: false });
          task.catch((error) => log('[shell-update] 未处理异常：', error.message));
        },
      },
      {
        label: '回到内置版本',
        enabled: Boolean(info.activeVersion) && !updateInProgress,
        click: () => {
          rollbackToBundledInteractive().catch((error) => log('[updater] 回退异常：', error.message));
        },
      },
      { type: 'separator' },
      {
        label: '打开数据目录',
        click: () => {
          shell.openPath(app.getPath('userData'));
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 手机访问（中继 + 配对二维码 + 状态/开关）
// ---------------------------------------------------------------------------
// 中继跑在主进程内 → 随 App 生死，不留孤儿进程。只绑尾网地址（不碰 0.0.0.0）。
// 认证仍由官方令牌 + cookie 负责，这里不持有任何凭据。
const MOBILE_PREFS_FILE = 'mobile-access.json';

function mobilePrefsPath() {
  return path.join(app.getPath('userData'), MOBILE_PREFS_FILE);
}

function loadMobilePrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(mobilePrefsPath(), 'utf8'));
    return { enabled: raw.enabled !== false, preferIp: raw.preferIp === true };
  } catch {
    return { enabled: true, preferIp: false };
  }
}

function saveMobilePrefs() {
  try {
    fs.writeFileSync(mobilePrefsPath(), JSON.stringify(mobilePrefs, null, 2));
  } catch {
    /* 记不住偏好不影响功能 */
  }
}

/** 手机该访问的地址：有令牌就带上（扫码配对要用），没有就给裸地址。 */
function currentMobileUrl() {
  if (!mobileRelay || !mobileAddress) return null;
  const host = pickHost(mobileAddress, { preferIp: mobilePrefs.preferIp });
  if (!host) return null;
  const base = `http://${host}:${mobileRelay.port}`;
  if (!webLaunchUrl) return `${base}/`;
  return webLaunchUrl.replace(/^https?:\/\/127\.0\.0\.1:\d+/, base);
}

function mobileStatus() {
  return {
    enabled: mobilePrefs.enabled,
    running: Boolean(mobileRelay),
    url: currentMobileUrl(),
    hasToken: Boolean(webLaunchUrl),
    preferIp: mobilePrefs.preferIp,
    host: mobileAddress ? pickHost(mobileAddress, { preferIp: mobilePrefs.preferIp }) : null,
    dns: mobileAddress ? mobileAddress.dns : null,
    ip: mobileAddress ? mobileAddress.ip : null,
    port: mobileRelay ? mobileRelay.port : null,
    source: mobileAddress ? mobileAddress.source : null,
    error: mobileError,
  };
}

function mobileMenuLabel() {
  if (!mobilePrefs.enabled) return '手机访问：已关闭';
  if (mobileRelay && mobileAddress) {
    return `手机访问：已开启（${pickHost(mobileAddress, { preferIp: mobilePrefs.preferIp })}:${mobileRelay.port}）· 显示配对二维码`;
  }
  return mobileError ? `手机访问：不可用（${mobileError}）` : '手机访问：未就绪';
}

/** 起中继（幂等：先收旧的）。端口从 8787 起顺延，最多试 8 个。 */
async function startMobileAccess() {
  await stopMobileAccess();
  mobileError = '';
  if (!mobilePrefs.enabled) {
    refreshTrayMenu();
    return null;
  }
  const address = await resolveTailnetAddress();
  if (!address || !address.ip) {
    mobileAddress = null;
    mobileError = '没找到 Tailscale 地址（需要装 Tailscale 并登录）';
    log('[mobile] 未启动：', mobileError);
    refreshTrayMenu();
    return null;
  }
  mobileAddress = address;
  for (let i = 0; i < MOBILE_PORT_TRIES; i += 1) {
    const port = MOBILE_PORT_START + i;
    try {
      // eslint-disable-next-line no-await-in-loop
      mobileRelay = await startMobileRelay({
        listenHost: address.ip,
        listenPort: port,
        target: `127.0.0.1:${dshPort}`,
        log: (m) => log('[mobile]', m),
        onRequest: (info) => {
          if (info.status >= 400) log('[mobile] 请求', JSON.stringify(info));
        },
      });
      log('[mobile] 中继就绪', `${address.ip}:${mobileRelay.port}`, `-> 127.0.0.1:${dshPort}`);
      refreshTrayMenu();
      return mobileRelay;
    } catch (error) {
      if (error && error.code !== 'EADDRINUSE') {
        mobileRelay = null;
        mobileError = `中继起不来：${error.message}`;
        log('[mobile]', mobileError);
        refreshTrayMenu();
        return null;
      }
    }
  }
  mobileRelay = null;
  mobileError = `端口 ${MOBILE_PORT_START}~${MOBILE_PORT_START + MOBILE_PORT_TRIES - 1} 都被占用了`;
  log('[mobile]', mobileError);
  refreshTrayMenu();
  return null;
}

async function stopMobileAccess() {
  if (!mobileRelay) return;
  const relay = mobileRelay;
  mobileRelay = null;
  try {
    await relay.close();
  } catch {
    /* ignore */
  }
  log('[mobile] 中继已停止');
  refreshTrayMenu();
}

async function setMobileEnabled(enabled) {
  mobilePrefs.enabled = enabled;
  saveMobilePrefs();
  if (enabled) await startMobileAccess();
  else await stopMobileAccess();
  refreshTrayMenu();
  return mobileStatus();
}

async function setMobilePreferIp(preferIp) {
  mobilePrefs.preferIp = preferIp;
  saveMobilePrefs();
  refreshTrayMenu();
  return mobileQrPayload();
}

/** 给二维码小窗的数据：地址 + PNG data URL（自己编码，不引第三方）。 */
async function mobileQrPayload() {
  const url = currentMobileUrl();
  if (!url) {
    return { error: mobilePrefs.enabled ? (mobileError || '手机访问未就绪') : '手机访问已关闭（托盘菜单里可打开）' };
  }
  try {
    return { url, dataUrl: await makeQrDataUrl(url), preferIp: mobilePrefs.preferIp, hasToken: Boolean(webLaunchUrl) };
  } catch (error) {
    return { error: `生成二维码失败：${error.message}` };
  }
}

async function makeQrDataUrl(text) {
  const mod = await import('./vendor/qrcode-generator/qrcode.mjs');
  const qrcode = mod.default || mod;
  let qr = null;
  for (let v = 0; v <= 40 && qr === null; v += 1) {
    try {
      const candidate = qrcode(v, 'M');
      candidate.addData(text, 'Byte');
      candidate.make();
      qr = candidate;
    } catch {
      /* 这个版本装不下就试下一个（v=0 表示自动选版本） */
    }
  }
  if (qr === null) throw new Error('内容太长，二维码装不下');
  const { buffer } = qrToPng(qr, { scale: 10, margin: 4 });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function showPairWindow() {
  if (pairWindow && !pairWindow.isDestroyed()) {
    pairWindow.show();
    pairWindow.focus();
    return pairWindow;
  }
  pairWindow = new BrowserWindow({
    width: 420,
    height: 660,
    minimizable: false,
    maximizable: false,
    title: '手机访问 · 配对二维码',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  pairWindow.setMenuBarVisibility(false);
  pairWindow.loadFile(path.join(__dirname, 'pair-qr.html'));
  pairWindow.on('closed', () => {
    pairWindow = null;
  });
  return pairWindow;
}

async function copyMobileAddress() {
  const url = currentMobileUrl();
  if (!url) return false;
  const { clipboard } = require('electron');
  clipboard.writeText(url);
  return true;
}

/** 应用菜单（窗口菜单栏；autoHideMenuBar 下用 Alt 唤出）。 */
function buildAppMenu() {
  const mobile = {
    label: '手机访问',
    submenu: [
      { label: '显示配对二维码', click: () => showPairWindow() },
      {
        label: '复制手机地址',
        enabled: Boolean(currentMobileUrl()),
        click: () => {
          void copyMobileAddress();
        },
      },
      { type: 'separator' },
      {
        label: '启用手机访问（中继）',
        type: 'checkbox',
        checked: mobilePrefs.enabled,
        click: (item) => {
          void setMobileEnabled(item.checked);
        },
      },
      {
        label: '用 IP 画码（MagicDNS 连不上时）',
        type: 'checkbox',
        checked: mobilePrefs.preferIp,
        click: (item) => {
          void setMobilePreferIp(item.checked);
        },
      },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '显示窗口', click: showWindow },
          {
            label: '重启服务',
            click: () => {
              log('restart requested (menu)');
              restartHarness().catch((error) => log('restart failed:', error.message));
            },
          },
          { type: 'separator' },
          {
            label: '退出',
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      mobile,
    ]),
  );
}

// ---------------------------------------------------------------------------
// 应用内 dsh 更新
// ---------------------------------------------------------------------------

function setUpdateChannel(channel) {
  const next = channel === 'preview' ? 'preview' : 'stable';
  updater.writeState(updateBaseDir(), { channel: next });
  log('[updater] 更新通道 →', next);
  refreshTrayMenu();
  return next;
}

function setBusyIndicator(busy, text) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(busy ? 2 : -1);
  } catch {
    /* ignore */
  }
  if (busy && text) tray?.setToolTip(`DS Harness Desktop — ${text}`);
}

/**
 * 执行一次完整更新：检查 → 下载安装 → 兼容守卫 → 冒烟验证 → 激活 → 重启服务。
 * silent=true 时不弹任何对话框（供 IPC 调用方自行决定呈现方式）。
 */
async function performUpdate(options = {}) {
  const silent = options.silent === true;
  if (updateInProgress) {
    const busy = { ok: false, status: 'busy', message: '已有更新任务正在进行中' };
    if (!silent) await dialog.showMessageBox(mainWindow, { type: 'info', title: '检查更新', message: busy.message });
    return busy;
  }

  const state = updater.readState(updateBaseDir());
  const current = currentDshVersion();
  const npmCliPath = resolveNpmCliPath();

  updateInProgress = true;
  setBusyIndicator(true, '正在更新 dsh…');
  refreshTrayMenu();
  try {
    const check = await updater.checkForUpdate({ currentVersion: current, channel: state.channel });
    if (!check.target) {
      const result = { ok: false, status: 'error', check, message: '无法从注册表解析目标版本，请检查网络后重试' };
      if (!silent) await dialog.showMessageBox(mainWindow, { type: 'warning', title: '检查更新', message: '检查失败', detail: result.message });
      return result;
    }
    if (!check.hasUpdate) {
      const message = check.isDowngrade
        ? `当前 v${current} 高于 ${check.tag} 通道的 v${check.target}（官方可能已撤回该版本）`
        : `已是最新版本 v${current}`;
      if (!silent) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '检查更新',
          message,
          detail: `更新通道：${state.channel === 'preview' ? 'preview（next）' : 'stable（latest）'}`,
        });
      }
      return { ok: true, status: check.isDowngrade ? 'downgrade-available' : 'up-to-date', check, message };
    }
    if (!npmCliPath) {
      const result = {
        ok: false,
        status: 'error',
        check,
        message: '当前构建未捆绑 npm，无法在应用内安装新版本。请使用含更新能力的桌面端版本。',
      };
      if (!silent) await dialog.showMessageBox(mainWindow, { type: 'warning', title: '检查更新', message: '无法应用更新', detail: result.message });
      return result;
    }

    if (!silent) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['立即更新', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `发现 dsh 新版本 v${check.target}`,
        detail:
          `当前版本：v${current}\n目标版本：v${check.target}（${check.tag} 通道）\n` +
          `发布时间：${check.publishedAt ? new Date(check.publishedAt).toLocaleString() : '未知'}\n\n` +
          '更新会下载到用户数据目录，经启动冒烟验证通过后才启用；失败会自动保留当前版本，' +
          '不会影响 ~/.dsh 中的会话与凭据。下载安装可能需要 1–3 分钟。',
      });
      if (response !== 0) return { ok: false, status: 'cancelled', check, message: '已取消更新' };
    }

    const result = await updater.updateToLatest({
      baseDir: updateBaseDir(),
      nodePath: resolveNodePath(),
      npmCliPath,
      currentVersion: current,
      channel: state.channel,
      cwd: resolveCwd(),
      log: (...args) => log('[updater]', ...args),
      onProgress: (message) => {
        log('[updater]', message);
        tray?.setToolTip(`DS Harness Desktop — ${message}`);
      },
    });

    if (result.status === 'updated') {
      log('[updater] 激活 v' + result.install.version + '，重启服务');
      // 新版本 = 新一轮：清掉上一版的回退/重启记忆
      overrideFallbackDone = false;
      fallbackFromVersion = null;
      crashRestarts = [];
      await restartHarness();
      if (!silent) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '更新完成',
          message: result.message,
          detail: `桌面端 v${app.getVersion()} ｜ dsh v${result.install.version}`,
        });
      }
      return { ok: true, ...result };
    }

    if (!silent) {
      await dialog.showMessageBox(mainWindow, {
        type: result.status === 'error' ? 'warning' : 'info',
        title: '检查更新',
        message: result.message,
      });
    }
    return { ok: false, ...result };
  } catch (error) {
    const message = String((error && error.message) || error);
    log('[updater] 更新失败：', message);
    if (!silent) {
      await dialog.showMessageBox(mainWindow, { type: 'warning', title: '更新失败', message: '应用内更新未完成', detail: message });
    }
    return { ok: false, status: 'error', message };
  } finally {
    updateInProgress = false;
    setBusyIndicator(false);
    refreshTrayMenu();
  }
}

async function rollbackToBundled() {
  const state = updater.readState(updateBaseDir());
  if (!state.activeVersion) {
    return { ok: false, status: 'already-bundled', message: `当前已在运行内置版本 v${bundledDshVersion()}` };
  }
  // 回退前预检：内置版本解析不了当前 profile 时，回退后必然打不开（2026-09-30 实锤：
  // 一个「回到内置版本」的点击就能把应用永久锁死）。与其把用户推进坑，不如当场拒绝。
  const gaps = bundledProfileGaps();
  if (gaps.checked && !gaps.ok) {
    log('[updater] 拒绝回退：内置版本解析不了当前 profile ——', gaps.reason);
    return {
      ok: false,
      status: 'profile-mismatch',
      message:
        `无法回到内置版本 v${bundledDshVersion()}：它加载不了当前 profile 的 bundle（${gaps.missing.join('、')}）。` +
        '回退后应用将无法启动，因此已取消。',
    };
  }
  updater.deactivate(updateBaseDir());
  log('[updater] 回退到内置版本 v' + bundledDshVersion());
  overrideFallbackDone = false;
  fallbackFromVersion = null;
  crashRestarts = [];
  await restartHarness();
  refreshTrayMenu();
  return { ok: true, status: 'rolled-back', message: `已回到内置版本 v${bundledDshVersion()}` };
}

async function rollbackToBundledInteractive() {
  const state = updater.readState(updateBaseDir());
  if (!state.activeVersion) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '回到内置版本',
      message: `当前已在运行内置版本 v${bundledDshVersion()}`,
    });
    return;
  }
  // 注定打不开的回退：不给按钮，直接把原因说清（否则用户点一次就永久打不开）
  const gaps = bundledProfileGaps();
  if (gaps.checked && !gaps.ok) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '不能回到内置版本',
      message: `内置的 dsh v${bundledDshVersion()} 加载不了当前 profile 的 bundle`,
      detail:
        `缺少：${gaps.missing.join('、')}\n\n` +
        '这些 bundle 只存在于较新的 dsh 版本里，回退后应用会启动失败，因此已取消。' +
        '确实需要回到内置版本时，请先到「插件管理」里关掉用到它们的插件（如语音输入、Agent Teams）。',
    });
    return;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['回到内置版本', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '回到内置版本',
    message: `当前使用 App 内更新的 dsh v${state.activeVersion}`,
    detail: `将停止服务并切回内置的 v${bundledDshVersion()}。已下载的版本目录会保留，可再次更新；` +
      '不会影响 ~/.dsh 中的会话与凭据。',
  });
  if (response !== 0) return;
  const result = await rollbackToBundled();
  await dialog.showMessageBox(mainWindow, {
    type: result.ok ? 'info' : 'warning',
    title: '回到内置版本',
    message: result.message,
  });
}

// ---------------------------------------------------------------------------
// 外壳（桌面端自身）更新 —— electron-updater
// ---------------------------------------------------------------------------

/** electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_DIR。 */
function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
}

function initShellUpdater() {
  try {
    autoUpdater.logger = {
      info: (...args) => log('[shell-update]', ...args),
      warn: (...args) => log('[shell-update][warn]', ...args),
      error: (...args) => log('[shell-update][error]', ...args),
      debug: () => {},
    };
    // autoDownload=false：点「检查」只查不下载，下载需用户确认。
    // autoInstallOnAppQuit=false：不在「退出应用」时静默安装。退出路径里我们无法
    //   等待 dsh 子进程完全退出，安装器会和它抢安装目录里的文件，导致残缺安装
    //   （v0.3.1 的自动更新就是这样把应用装坏的）。安装只在用户点托盘
    //   「重启并安装」时进行 —— 那时会先做干净停机再交给安装器。
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent || 0);
      tray?.setToolTip(`DS Harness Desktop — 正在下载桌面端更新 ${percent}%`);
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar((progress.percent || 0) / 100);
      } catch {
        /* ignore */
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      shellUpdateReady = info;
      shellUpdateInProgress = false;
      setBusyIndicator(false);
      refreshTrayMenu();
      log('[shell-update] 下载完成 v' + info.version);
      // 此前完成时只改托盘菜单文字、零主动提示，用户不知道下完了——补弹窗
      notifyShellUpdateDownloaded(info);
    });
    autoUpdater.on('error', (error) => {
      shellUpdateInProgress = false;
      setBusyIndicator(false);
      refreshTrayMenu();
      log('[shell-update][error]', error == null ? 'unknown' : error.message || String(error));
    });
  } catch (error) {
    log('[shell-update] 初始化失败：', error.message);
  }
}

/** 等待一次检查结束；以事件为准，避免依赖 checkForUpdates 的返回结构差异。 */
function checkShellUpdateOnce(timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    function cleanup() {
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNone);
      autoUpdater.removeListener('error', onError);
    }
    const onAvailable = (info) => finish({ status: 'available', info });
    const onNone = (info) => finish({ status: 'none', info });
    const onError = (error) => finish({ status: 'error', message: (error && error.message) || String(error) });
    const timer = setTimeout(() => finish({ status: 'error', message: '检查超时（网络不可达？）' }), timeoutMs);

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNone);
    autoUpdater.once('error', onError);
    Promise.resolve(autoUpdater.checkForUpdates()).catch((error) => onError(error));
  });
}

/**
 * 检查桌面端外壳更新。
 * 便携版无法原地自更新（每次启动都自解压到临时目录），改为引导到发布页手动下载。
 */
async function checkShellUpdate(options = {}) {
  const silent = options.silent === true;
  if (shellUpdateInProgress) {
    const busy = { ok: false, status: 'busy', message: '桌面端更新任务正在进行中' };
    if (!silent) await dialog.showMessageBox(mainWindow, { type: 'info', title: '桌面端更新', message: busy.message });
    return busy;
  }
  if (!app.isPackaged) {
    const message = '开发态不检查桌面端更新（electron-updater 只在安装版/便携版中生效）';
    if (!silent) await dialog.showMessageBox(mainWindow, { type: 'info', title: '桌面端更新', message });
    return { ok: false, status: 'dev-mode', message };
  }
  if (isPortableBuild()) {
    if (!silent) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['打开发布页', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '桌面端更新',
        message: '便携版需要手动更新',
        detail:
          '便携版每次启动都会自解压到临时目录，无法在原地替换正在运行的程序。\n' +
          '请从发布页下载新的便携版文件替换旧文件；会话与凭据存放在 ~/.dsh，替换不会影响它们。',
      });
      if (response === 0) shell.openExternal(SHELL_RELEASES_URL);
    }
    return { ok: false, status: 'portable-manual', message: '便携版请从发布页手动下载新版本' };
  }

  shellUpdateInProgress = true;
  setBusyIndicator(true, '正在检查桌面端更新…');
  refreshTrayMenu();
  let keepBusy = false;
  try {
    const result = await checkShellUpdateOnce();
    if (result.status === 'error') {
      const message = `检查失败：${result.message}`;
      if (!silent) {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '桌面端更新',
          message: '检查桌面端更新失败',
          detail: `${message}\n\n提示：仓库必须公开且存在 Release（含 latest.yml）时，客户端才能获取更新。`,
        });
      }
      return { ok: false, status: 'error', message };
    }
    if (result.status === 'none') {
      const message = `已是最新版本 v${app.getVersion()}`;
      if (!silent) await dialog.showMessageBox(mainWindow, { type: 'info', title: '桌面端更新', message });
      return { ok: true, status: 'up-to-date', message };
    }

    const info = result.info;
    if (!silent) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['下载并安装', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '桌面端更新',
        message: `发现桌面端新版本 v${info.version}`,
        detail:
          `当前版本：v${app.getVersion()}\n目标版本：v${info.version}\n\n` +
          '下载完成后可立即重启安装；选择「稍后」则暂不安装，之后可从托盘的「重启并安装」再装。\n' +
          'dsh 的会话与凭据存放在 ~/.dsh，不受影响。',
      });
      if (response !== 0) return { ok: false, status: 'cancelled', message: '已取消下载' };
    }

    keepBusy = true;
    setBusyIndicator(true, `正在下载桌面端 v${info.version}…`);
    autoUpdater.downloadUpdate().catch(async (error) => {
      shellUpdateInProgress = false;
      setBusyIndicator(false);
      refreshTrayMenu();
      log('[shell-update] 下载失败：', error.message);
      // 此前下载失败只写日志、界面毫无动静——补失败弹窗（silent 调用不弹）
      if (!silent) {
        try {
          await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '桌面端更新',
            message: '桌面端更新下载失败',
            detail: `${(error && error.message) || error}\n\n可稍后重试：托盘 →「检查桌面端更新」。`,
          });
        } catch {
          /* ignore */
        }
      }
    });
    return { ok: true, status: 'downloading', version: info.version, message: `正在下载桌面端 v${info.version}…` };
  } finally {
    if (!keepBusy) {
      shellUpdateInProgress = false;
      setBusyIndicator(false);
      refreshTrayMenu();
    }
  }
}

/** 下载完成的主动提示：给「立即重启并安装 / 稍后」选择（此前零提示）。 */
async function notifyShellUpdateDownloaded(info) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '桌面端更新',
      message: `v${info.version} 下载完成`,
      detail:
        '点击「立即重启并安装」马上更新：会先停止本地 dsh 服务再安装，完成后应用自动重启。\n' +
        '选择「稍后」则暂不安装，之后可从托盘「重启并安装」再装；会话与凭据存放在 ~/.dsh，不受影响。',
    });
    if (response === 0) await applyShellInstall(info);
  } catch (error) {
    log('[shell-update] 下载完成提示失败：', error.message);
  }
}

/** 实际执行外壳安装：干净停机后交给安装器（确认对话框由调用方负责）。 */
async function applyShellInstall(info) {
  if (quitting) return { ok: false, status: 'busy', message: '安装已在进行中' };
  log('[shell-update] quitAndInstall v' + info.version);
  quitting = true;
  // 关键顺序：先等 dsh 子进程真正退出，再让安装器接管安装目录
  const exited = await stopHarnessAndWait();
  log('[shell-update] dsh 子进程已退出 =', exited, '，交给安装器');
  // 再留一点时间让 Electron 释放文件句柄，避免与安装器抢文件
  setTimeout(() => autoUpdater.quitAndInstall(), 1500);
  return { ok: true, status: 'installing', message: `正在安装 v${info.version}` };
}

/** 安装已下载的外壳更新（未下载时先走一次检查）。 */
async function installShellUpdate() {
  if (!shellUpdateReady) return checkShellUpdate({ silent: false });
  const info = shellUpdateReady;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['立即重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '安装桌面端更新',
    message: `安装 v${info.version} 并重启应用`,
    detail: '将先停止本地 dsh 服务再安装，安装完成后应用会自动重新启动。',
  });
  if (response !== 0) return { ok: false, status: 'postponed', message: '已暂缓；之后可从托盘「重启并安装」再装' };
  return applyShellInstall(info);
}
