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
      log('active override unusable, falling back to bundled:', overrideState.activeVersion);
      updater.deactivate(updateBaseDir());
    }
  } catch (error) {
    log('override state check failed:', error.message);
  }

  ipcMain.handle('dsh:get-port', () => dshPort);
  ipcMain.handle('dsh:get-error', () => lastError);
  ipcMain.handle('dsh:restart', async () => {
    log('restart requested');
    stopHarness();
    await startHarness();
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

async function startHarness() {
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
  const childLogPath = path.join(app.getPath('userData'), 'dsh-child.log');
  let childLogFd = null;
  try {
    // 每次拉起 dsh 前先按大小轮转，避免崩溃堆栈把日志撑爆
    rotateLogIfTooLarge(childLogPath);
    childLogFd = fs.openSync(childLogPath, 'a');
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

  child.on('exit', (code, signal) => {
    if (childLogFd != null) {
      try {
        fs.closeSync(childLogFd);
      } catch {
        /* ignore */
      }
    }
    // 陈旧子进程的退出事件（stopHarness 杀掉的旧实例）不是当前实例的失败 → 忽略。
    // 否则更新流程「先 activate 再 stopHarness」会让旧进程的退出被误判为
    // 「覆盖版本启动失败」，当场 deactivate 掉刚激活的新版本（2026-09-24 实锤：
    // 旧进程 SIGTERM 退出后 1ms 就触发回退，覆盖版本从未被拉起过一次）。
    if (dshChild !== child) return;
    dshChild = null;
    log('dsh child exited: code=', code, 'signal=', signal, 'quitting=', quitting);
    if (quitting) return;
    // 覆盖版本启动失败 → 自动回退到内置版本并重启一次（内置版本是保底），
    // 只回退一次，避免回退后仍失败时无限重启。
    const overrideState = updater.readState(updateBaseDir());
    if (overrideState.activeVersion && !overrideFallbackDone) {
      overrideFallbackDone = true;
      log('[updater] 覆盖版本启动失败，回退内置版本：', overrideState.activeVersion);
      updater.deactivate(updateBaseDir());
      startHarness().catch((error) => log('fallback restart failed:', error.message));
      return;
    }
    showErrorPage(`harness 子进程已退出（code=${code}，signal=${signal}）`);
  });

  const launchUrl = await waitForLaunchUrl(TOKEN_WAIT_TIMEOUT_MS);
  tokenWaitSettled = true;
  log('waitForLaunchUrl result=', launchUrl === null ? 'null' : 'token-url');
  if (launchUrl !== null) {
    overrideFallbackDone = false;
    await mainWindow.loadURL(launchUrl);
    log('loaded web UI (token)');
    return;
  }

  // 兜底：老版本 dsh 不打 token 地址，退回「端口就绪即加载」
  const ready = await waitForReady(dshPort);
  log('waitForReady result=', ready);
  if (ready) {
    overrideFallbackDone = false;
    await mainWindow.loadURL(`http://127.0.0.1:${dshPort}/`);
    log('loaded web UI (legacy)');
  } else if (!quitting) {
    showErrorPage('harness 服务未在预期时间内就绪');
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
        click: async () => {
          stopHarness();
          await startHarness();
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
            click: async () => {
              stopHarness();
              await startHarness();
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
      stopHarness();
      overrideFallbackDone = false;
      await startHarness();
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
  updater.deactivate(updateBaseDir());
  log('[updater] 回退到内置版本 v' + bundledDshVersion());
  stopHarness();
  overrideFallbackDone = false;
  await startHarness();
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
  await dialog.showMessageBox(mainWindow, { type: 'info', title: '回到内置版本', message: result.message });
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
