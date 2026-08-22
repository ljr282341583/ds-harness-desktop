'use strict';

/**
 * DS Harness Desktop — Electron 主进程
 *
 * 职责：单实例锁 → 解析端口 → spawn 捆绑的 dsh web 子进程 → 就绪探测 →
 *       窗口加载本地 URL → 托盘（显示/重启/检查更新/退出）→ 生命周期管理。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DEFAULT_PORT = 3080;
const MAX_PORT_TRIES = 10;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

let mainWindow = null;
let tray = null;
let dshChild = null;
let dshPort = DEFAULT_PORT;
let quitting = false;
let lastError = '';

// 简单文件日志（GUI 应用无控制台，重定向又不可靠，写文件最稳）
let _logFile = null;
function log(...args) {
  try {
    if (_logFile === null) {
      _logFile = path.join(app.getPath('userData'), 'dsh-desktop.log');
    }
    fs.appendFileSync(_logFile, `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 单实例锁：二次启动时聚焦已有窗口
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();

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
});

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------
async function bootstrap() {
  log('bootstrap start, userData=', app.getPath('userData'));
  ipcMain.handle('dsh:get-port', () => dshPort);
  ipcMain.handle('dsh:get-error', () => lastError);
  ipcMain.handle('dsh:restart', async () => {
    log('restart requested');
    stopHarness();
    await startHarness();
    return dshPort;
  });

  createWindow();
  log('window created');
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
  const dshRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
  return path.join(dshRoot, 'lib', 'bin.js');
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
 * 探测某端口是否已有 DSH web 实例在跑。
 * 若已有（例如用户已开网页版），桌面版应直接复用而不是新开一个实例，
 * 否则两个实例会并发读写共享的 ~/.dsh，污染 workspace/会话索引。
 */
function probeDsh(port, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startHarness() {
  // 1) 默认端口已有 DSH 实例 → 直接复用，避免双实例并发写 ~/.dsh
  if (await probeDsh(DEFAULT_PORT)) {
    dshPort = DEFAULT_PORT;
    log('reusing existing dsh instance on port', dshPort);
    await mainWindow.loadURL(`http://127.0.0.1:${dshPort}/`);
    return;
  }

  dshPort = await findFreePort(DEFAULT_PORT);
  const bin = dshBinPath();
  const nodePath = resolveNodePath();
  const cwd = resolveCwd();
  log('startHarness: port=', dshPort, 'node=', nodePath, 'bin=', bin, 'cwd=', cwd);

  // dsh 子进程输出写到日志文件（GUI 应用无控制台，inherit 会弹出 cmd 窗口）
  const childLogPath = path.join(app.getPath('userData'), 'dsh-child.log');
  let childLogFd = null;
  try {
    childLogFd = fs.openSync(childLogPath, 'a');
  } catch {
    /* ignore */
  }

  // --no-open：dsh web 默认会用系统浏览器打开 UI，桌面版自己已有窗口，
  // 不要再弹浏览器标签页。
  const child = spawn(nodePath, [bin, 'web', '--port', String(dshPort), '--no-open'], {
    cwd,
    env: { ...process.env },
    stdio: childLogFd != null ? ['ignore', childLogFd, childLogFd] : 'ignore',
    windowsHide: true, // 关键：隐藏 dsh 子进程的控制台窗口
  });
  dshChild = child;
  log('spawned dsh pid=', child.pid);

  child.on('exit', (code, signal) => {
    if (childLogFd != null) {
      try {
        fs.closeSync(childLogFd);
      } catch {
        /* ignore */
      }
    }
    dshChild = null;
    log('dsh child exited: code=', code, 'signal=', signal, 'quitting=', quitting);
    if (!quitting) {
      showErrorPage(`harness 子进程已退出（code=${code}，signal=${signal}）`);
    }
  });

  const ready = await waitForReady(dshPort);
  log('waitForReady result=', ready);
  if (ready) {
    await mainWindow.loadURL(`http://127.0.0.1:${dshPort}/`);
    log('loaded web UI');
  } else if (!quitting) {
    showErrorPage('harness 服务未在预期时间内就绪');
  }
}

function stopHarness() {
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
  tray.setToolTip('DS Harness Desktop');
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
      {
        label: '检查更新',
        click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '检查更新',
            message: '当前版本 0.1.0',
            detail: '自动更新将在后续版本提供，届时可在此处一键升级。',
          });
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
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}
