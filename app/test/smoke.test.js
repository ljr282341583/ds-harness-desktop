'use strict';

/**
 * DS Harness Desktop — verify:smoke 冒烟验证
 *
 * 一条命令回答一个问题：改完「更新器 / 打包 / 依赖修剪」之后，应用还打得开吗？
 *
 * 用法：
 *   npm run verify:smoke               # 完整冒烟；见下方各步的 SKIP 规则
 *   npm run verify:smoke -- --packaged # 强制要求 win-unpacked 存在，缺失即失败
 *   npm run verify:smoke -- --audit-stash # 只演练「暂存/还原本机卸载键」，不跑安装器
 *   npm run build / build:dir          # 打包脚本已挂本体检（打包成功即自动执行）
 *
 * 步骤：
 *   [1] 离线单测：复用 test/updater.test.js（版本比较 / 通道 / 守卫 / 状态 / 环境收敛）
 *   [2] 静态检查：侧车 Node ≥ 22、侧车含可执行 npm（应用内 dsh 更新的前提，
 *       CI 发布物由 release.yml 保证、本地由打包钩子 prepare-runtime.ps1 保证）、
 *       内置 dsh 版本与声明精确一致（无 ^）、compression: none 两处守卫都在位
 *   [3] 侧车启动冒烟：runtime/node.exe 拉起内置 dsh web，临时 DSH_HOME，
 *       等到带 token 的启动地址（复用 updater.smokeTest，与更新器同一套判定）
 *   [4] 打包产物启动冒烟：无窗口拉起 产出/win-unpacked 的 exe，等端口真正监听
 *       且进程仍存活 —— 最接近「更新完还打得开吗」的一步
 *   [5] 安装器端到端：NSIS 安装包静默装进临时目录 → 启动 → 端口监听 → 卸载还原。
 *       安装包缺失或比 win-unpacked 旧 → SKIP（build:dir 不产安装包，用 npm run build）。
 *       本机存在真实安装（注册表三 hive 里有该应用的卸载键）→ **默认 SKIP**：NSIS 的
 *       快捷方式路径与注册表键名由产品名/GUID 派生、与安装目录无关，"装到临时目录"
 *       隔离不了这些命名空间（2026-09-24 事故的设计级根因）；发版门禁交给 CI（干净机器，
 *       无物可毁）。确要在本机跑必须显式 --force-installer，届时暂存/复查/还原护栏生效。
 *       temp 安装一律带 `/currentuser`（模板 assistedInstaller.nsh L129-133 支持该参数）：
 *       强制落在每用户命名空间（HKCU + 用户级快捷方式），不写公共桌面/HKLM，从接触面上
 *       隔离真实安装；安装后打印它实际注册到哪个 hive，隔离是否成立当场可见。
 *       本机有正在运行的 DS Harness Desktop 实例 → SKIP：NSIS 模板会
 *       `taskkill /im <exe>` 按进程名全杀，会连坐用户正在用的窗口。
 *
 * 硬约束：
 *   - 全程 DSH_HOME / userData / cwd 指向临时目录，不触碰真实 ~/.dsh 与真实安装状态
 *   - [5] 对本机既有安装的桌面/开始菜单快捷方式先快照后还原，不留痕迹
 *   - [5] 动安装器前有两道 fail-closed 防线：三 hive 暂存本机卸载键与安装记忆键 +
 *     独立实现复查，复查不干净或扫描失败一律中止（2026-09-24 事故：只暂存 HKCU，
 *     全机安装被 NSIS 当旧版静默卸载；复盘见大脑 JOURNAL/2026-09-24，--audit-stash 零风险演练）
 *   - [5] 跑完必须"痕迹全无"：快捷方式（含公共桌面/所有用户开始菜单）逐项复查在位、
 *     本机卸载键数回到基线，任一不满足即判红——不再有静默的"已还原为安装前状态"
 *   - 只杀自己拉起的进程树；不联网安装任何东西（更新链路端到端另有 npm run test:e2e）
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:net');

const updater = require('../src/updater.js');

const appDir = path.join(__dirname, '..');
const repoDir = path.join(appDir, '..');
const outDir = path.join(repoDir, '产出');
const packedDir = path.join(outDir, 'win-unpacked');
const requirePackaged = process.argv.includes('--packaged');
const APP_EXE_NAME = 'DS Harness Desktop.exe';
const SHORTCUT_NAME = 'DS Harness Desktop';

let passed = 0;
let failed = 0;
let skipped = 0;

function indent(text, prefix = '       ') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join('\n');
}

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(indent(error && error.message ? error.message : error));
  }
}

function skipStep(name, reason) {
  skipped++;
  console.log(`  SKIP ${name}（${reason}）`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findFreePort(start, tries = 10) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= tries) return reject(new Error(`端口 ${start}~${start + tries - 1} 全部被占用`));
      const server = createServer();
      server.unref();
      server.once('error', () => tryPort(i + 1));
      server.once('listening', () => server.close(() => resolve(start + i)));
      server.listen(start + i, '127.0.0.1');
    };
    tryPort(0);
  });
}

/** 对单端口发一次 HTTP 探测；拿到任意响应（含 401/500）即视为「已监听」。 */
function probeOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
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

/** 轮询 [startPort, startPort+span] 直到有端口存活、被测进程退出或到达截止时间。 */
async function waitAnyPortAlive(startPort, span, deadlineAt, isExited) {
  while (Date.now() < deadlineAt) {
    if (isExited()) return { alive: false, port: null };
    for (let port = startPort; port <= startPort + span; port++) {
      // eslint-disable-next-line no-await-in-loop
      if (await probeOnce(port)) return { alive: true, port };
    }
    await sleep(500);
  }
  return { alive: false, port: null };
}

/** 结束自己拉起的进程树（taskkill /T 覆盖 dsh 派生的子进程）。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {
      /* ignore */
    }
    setTimeout(resolve, 800);
  });
}

function tailLines(file, count = 20) {
  try {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    return lines.slice(-count).join('\n');
  } catch {
    return '';
  }
}

/** 验证实例的隔离环境：DSH_HOME / userData / cwd 全进 tempBase，另加端口与不抢单实例锁。 */
function isolationEnv(tempBase, port) {
  const dirs = {
    home: path.join(tempBase, 'dsh-home'),
    userData: path.join(tempBase, 'user-data'),
    cwd: path.join(tempBase, 'cwd'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return {
    dirs,
    env: {
      ...process.env,
      DSH_HOME: dirs.home,
      DSH_DESKTOP_USER_DATA: dirs.userData,
      DSH_DESKTOP_CWD: dirs.cwd,
      DSH_DESKTOP_PORT: String(port),
      DSH_DESKTOP_SMOKE: '1',
      DSH_TELEMETRY_DISABLED: '1',
    },
  };
}

/**
 * 拉起一个 exe 并等待端口监听：端口通 + 进程仍存活才算成功。
 * 无论成败，函数返回前都会回收自己拉起的进程树；失败时附带 userData 日志尾巴。
 * 返回 { port, secs }。
 */
async function launchAndProbe(exePath, launchCwd, env, options = {}) {
  const portStart = options.portStart || 3490;
  const deadlineMs = options.deadlineMs || 150_000;
  const userDataDir = options.userDataDir || null;
  const started = Date.now();
  const port = await findFreePort(portStart);

  let child = null;
  let rawOut = '';
  let exitInfo = null;
  try {
    child = spawn(exePath, [], {
      cwd: launchCwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onChunk = (chunk) => {
      rawOut = (rawOut + chunk.toString('utf8')).slice(-8192);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (error) => {
      exitInfo = { code: -1, signal: null, error: error.message };
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, error: null };
    });

    const probe = await waitAnyPortAlive(port, 10, Date.now() + deadlineMs, () => exitInfo !== null);
    const secs = Math.round((Date.now() - started) / 1000);

    if (!probe.alive) {
      if (exitInfo) {
        // 注意：不能用 assert + 模板串消息——消息是提前求值的，exitInfo 为 null 时会 TypeError。
        const hint =
          exitInfo.code === 0
            ? '进程主动退出（code=0）——常见原因：初始化即退出或锁冲突'
            : '启动失败 / 闪退';
        const logs = userDataDir
          ? [tailLines(path.join(userDataDir, 'dsh-desktop.log')), tailLines(path.join(userDataDir, 'dsh-child.log'))]
              .filter(Boolean)
              .join('\n---\n')
          : '';
        const extra = exitInfo.error ? ` error=${exitInfo.error}` : '';
        throw new Error(
          `${hint}：code=${exitInfo.code} signal=${exitInfo.signal || '-'}${extra}（${secs}s）\n` +
            indent(logs || '（暂无日志）'),
        );
      }
      throw new Error(
        `超时（${Math.round(deadlineMs / 1000)}s）仍未监听 ${port}..${port + 10}（${secs}s）\n` +
          indent(rawOut || '（无进程输出）'),
      );
    }
    if (exitInfo) {
      throw new Error(
        `端口 ${probe.port} 有响应但被测进程已退出（code=${exitInfo.code}）——该端口响应可能来自其他进程`,
      );
    }
    return { port: probe.port, secs };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await killTree(child.pid);
    }
  }
}

// ---------------------------------------------------------------------------
// [5] 安装器端到端用的辅助：Shell 目录解析与快捷方式快照/还原
// ---------------------------------------------------------------------------

/** 从注册表 Shell Folders 取真实目录（防 OneDrive 等重定向），失败回退默认值。 */
function shellFolder(name, fallback) {
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', name],
      { encoding: 'utf8', windowsHide: true },
    );
    const m = String(r.stdout || '').match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i'));
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch {
    /* fall back */
  }
  return fallback;
}

function shortcutTargets() {
  const desktop = shellFolder('Desktop', path.join(process.env.USERPROFILE || '', 'Desktop'));
  const programs = shellFolder(
    'Programs',
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  );
  // 全机安装的图标在公共桌面 + 所有用户开始菜单（2026-09-24 事故：真卸载器删的是这两处，
  // 只备份用户级位置的"还原"根本找不回来）。
  const publicDesktop = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  const commonPrograms = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  return [
    { id: 'desktop', file: path.join(desktop, `${SHORTCUT_NAME}.lnk`), dir: null },
    { id: 'startmenu', file: path.join(programs, `${SHORTCUT_NAME}.lnk`), dir: path.join(programs, SHORTCUT_NAME) },
    { id: 'public-desktop', file: path.join(publicDesktop, `${SHORTCUT_NAME}.lnk`), dir: null },
    { id: 'common-startmenu', file: path.join(commonPrograms, `${SHORTCUT_NAME}.lnk`), dir: path.join(commonPrograms, SHORTCUT_NAME) },
  ];
}

/**
 * 把本机既有安装的快捷方式（桌面/开始菜单）备份出来。
 * 安装会把它们指向临时目录、卸载会删掉它们——必须先备份，之后原样还原，
 * 保证本机正式安装的快捷方式不被验证流程破坏。
 */
function snapshotShortcuts(backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const snap = [];
  for (const t of shortcutTargets()) {
    for (const [kind, p] of [
      ['file', t.file],
      ['dir', t.dir],
    ]) {
      if (p && fs.existsSync(p)) {
        const dest = path.join(backupDir, `${t.id}-${kind}`);
        fs.cpSync(p, dest, { recursive: true });
        snap.push({ original: p, backup: dest });
      }
    }
  }
  return snap;
}

/**
 * 还原备份的快捷方式；没备份过但残留下来的（本次测试创建的）则删除。
 * 返回"未能原样还原"的原路径列表——调用方必须据此硬断言（2026-09-24 教训：
 * 还原失败若只 warn，用户就会在绿色输出里丢掉自己的快捷方式）。
 */
function restoreShortcuts(snap, backupDir) {
  const failures = [];
  const restored = new Set(snap.map((s) => s.original));
  for (const s of snap) {
    try {
      fs.rmSync(s.original, { recursive: true, force: true });
      fs.cpSync(s.backup, s.original, { recursive: true });
    } catch (error) {
      failures.push(`${s.original}（复制失败：${error.message}）`);
    }
  }
  for (const t of shortcutTargets()) {
    for (const p of [t.file, t.dir]) {
      if (p && !restored.has(p) && fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  // 逐个复查：快照里有的原路径，还原后必须真的都在
  for (const s of snap) {
    if (!fs.existsSync(s.original)) failures.push(`${s.original}（还原后不存在）`);
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
  return failures;
}

/** 产出\ 下最新的 NSIS 安装包（*Setup*.exe）。 */
function newestInstaller() {
  if (!fs.existsSync(outDir)) return null;
  const candidates = fs
    .readdirSync(outDir)
    .filter((name) => /Setup.*\.exe$/i.test(name))
    .map((name) => path.join(outDir, name))
    .filter((file) => fs.statSync(file).isFile());
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * 本机正在运行的 DS Harness Desktop 实例数（此刻测试尚未启动任何实例，全是"别人的"）。
 *
 * 为什么必须查：NSIS 安装/卸载模板 allowOnlyOneInstallerInstance.nsh 会执行
 * `taskkill /im "DS Harness Desktop.exe"`——按进程名全杀。不拦住就会把用户
 * 正在用的正式实例（承载当前会话的窗口）连坐杀掉。
 */
function countForeignInstances() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DS Harness Desktop.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(r.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes('ds harness desktop.exe')).length;
}

/**
 * 结束命令行里引用了 dir 的残留进程（隔离实例的 dsh/node 后代可能逃出进程树，
 * 清理时还占着句柄 → Windows 删除必现 EPERM）。dir 经环境变量传递，避免筛选串
 * 出现在自身命令行里造成自匹配；找不到任何进程时无副作用。
 */
function killProcessesUnder(dir) {
  const cmd =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $env:DSH_SWEEP_DIR + '*') -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, DSH_SWEEP_DIR: dir },
  });
}

/**
 * 删临时树的稳妥版：先清只读位（Windows 只读文件 unlink 必现 EPERM，重试也救不了），
 * 再带重试删除。失败直接抛，由调用方决定告警还是计为失败。
 */
function removeTreeSafe(root) {
  if (!fs.existsSync(root)) return;
  const clearReadOnly = (target) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    try {
      if ((stat.mode & 0o200) === 0) fs.chmodSync(target, stat.mode | 0o666);
    } catch {
      // 单个文件清不掉就先继续，交给 rmSync 重试
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) clearReadOnly(path.join(target, entry));
    }
  };
  clearReadOnly(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

/**
 * 把本机已登记的卸载注册表键导出暂存并删除。
 *
 * NSIS 安装器的 uninstallOldVersion 宏（installSection.nsh）会按注册表找到"旧安装"
 * 并先静默跑它的卸载器——temp 验证安装若不先藏起这些键，会把用户的真实安装整个
 * 当旧版卸掉（本项目实测踩过：真实目录被清空、快捷方式被删）。2026-09-24 二次复发：
 * 全机安装的键在 HKLM，旧实现只扫 HKCU 暂存扑空，真卸载器清空了 D:\ 安装与公共图标
 * ——现在三个 hive 全扫，任何"该藏的没藏住"（导出失败/删除失败=大概率未提权）一律
 * 抛错中止（fail-closed），绝不带病运行安装器。
 * 同时返回真实安装目录，供最后断言"真安装体未被测试破坏"。
 */
// entries 直接写入调用方数组：中途抛错时调用方 finally 仍持有一份，能把已藏的键导回。
function stashUninstallKeys(backupDir, entries) {
  fs.mkdirSync(backupDir, { recursive: true });
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const realDirs = [];
  for (const root of roots) {
    const prefix = root.replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE');
    const q = spawnSync('reg', ['query', root], { encoding: 'utf8', windowsHide: true });
    const subKeys = String(q.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${prefix}\\`))
      .map((line) => line.slice(prefix.length + 1))
      .filter((name) => name && !name.includes('\\'));
    for (const name of subKeys) {
      const key = `${root}\\${name}`;
      const dn = spawnSync('reg', ['query', key, '/v', 'DisplayName'], { encoding: 'utf8', windowsHide: true });
      if (!/DS Harness Desktop/i.test(String(dn.stdout || ''))) continue;
      const file = path.join(backupDir, `regkey-${entries.length}.reg`);
      const ex = spawnSync('reg', ['export', key, file, '/y'], { encoding: 'utf8', windowsHide: true });
      if (ex.status !== 0 || !fs.existsSync(file)) {
        throw new Error(`卸载键 ${key} 匹配成功但导出失败——无法安全暂存，中止（否则安装器会把真安装当旧版卸掉）`);
      }
      // 推断真实安装目录：优先 InstallLocation，退化到 UninstallString 的引号内路径
      //（UninstallString 形如 `"C:\path\Uninstall DS Harness Desktop.exe" /currentuser`，
      //  末尾带 /currentuser，不能用行尾锚点匹配）
      const loc = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
      const ul = spawnSync('reg', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
      const locM = String(loc.stdout || '').match(/InstallLocation\s+REG_\w+\s+(.+)$/m);
      const ulM =
        String(ul.stdout || '').match(/UninstallString\s+REG_\w+\s+"([^"]+)"/) ||
        String(ul.stdout || '').match(/UninstallString\s+REG_\w+\s+(\S+)/);
      const dir = locM && locM[1].trim()
        ? locM[1].trim()
        : ulM
          ? path.dirname(ulM[1].trim().replace(/^"|"$/g, ''))
          : null;
      if (dir && fs.existsSync(path.join(dir, APP_EXE_NAME))) realDirs.push(dir);
      const del = spawnSync('reg', ['delete', key, '/f'], { encoding: 'utf8', windowsHide: true });
      if (del.status !== 0) {
        throw new Error(
          `无法删除卸载键 ${key}——最常见原因是未提权（请用「以管理员身份运行」的 PowerShell 重跑）；` +
            '继续运行会让安装器把真实安装当旧版卸掉，已中止',
        );
      }
      entries.push({ key, file });
      console.log(`       | 暂存卸载键 ${key}${dir ? `（真实安装 ${dir}）` : ''}`);

      // 同一个 GUID 也是"安装记忆键"（electron-builder 的 INSTALL_REGISTRY_KEY = Software\<GUID>）：
      // temp 安装会覆盖它、temp 卸载器会把它删掉。不一起暂存，[5] 跑完本机就丢了安装记忆，
      // 下次更新向导失去"原地回填"依据 → 漂移/双安装风险（见大脑已知坑「更新向导模式页陷阱」）。
      const memoryKey = `${root.replace(/\\Microsoft\\Windows\\CurrentVersion\\Uninstall$/, '')}\\${name}`;
      const memQuery = spawnSync('reg', ['query', memoryKey], { encoding: 'utf8', windowsHide: true });
      if (memQuery.status === 0) {
        const memFile = path.join(backupDir, `regkey-memory-${entries.length}.reg`);
        const memExport = spawnSync('reg', ['export', memoryKey, memFile, '/y'], { encoding: 'utf8', windowsHide: true });
        if (memExport.status !== 0 || !fs.existsSync(memFile)) {
          throw new Error(`安装记忆键 ${memoryKey} 导出失败——无法安全暂存，中止`);
        }
        const memDelete = spawnSync('reg', ['delete', memoryKey, '/f'], { encoding: 'utf8', windowsHide: true });
        if (memDelete.status !== 0) {
          throw new Error(`无法删除安装记忆键 ${memoryKey}（大概率未提权）——已中止`);
        }
        entries.push({ key: memoryKey, file: memFile });
        console.log(`       | 暂存安装记忆键 ${memoryKey}`);
      }
    }
  }
  return realDirs;
}

/** 把暂存的卸载注册表键原样导回（temp 安装会占用同名键，必须恢复原内容）。 */
function restoreUninstallKeys(entries) {
  for (const e of entries) {
    if (fs.existsSync(e.file)) {
      const r = spawnSync('reg', ['import', e.file], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) console.warn(`       ! 卸载键恢复失败 ${e.key}：${String(r.stderr || '').trim()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 失控前防线：独立实现的只读复查 + 零风险自检模式（都不启动安装器）
// ---------------------------------------------------------------------------

/**
 * 独立实现（PowerShell 注册表提供程序，与暂存用的 reg.exe 解析互为对照）只读扫描：
 * 本机还有没有能让 NSIS uninstallOldVersion 找到"旧版"的卸载键。
 * 返回键路径数组；返回 null 表示扫描失败——调用方必须按 fail-closed 处理。
 */
const UNINSTALL_SCAN_PS = [
  '$roots = @(',
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
  "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
  "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')",
  '$hits = @()',
  'foreach ($r in $roots) {',
  '  if (-not (Test-Path $r)) { continue }',
  '  Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object {',
  '    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  '    $d = [string]$p.DisplayName',
  '    $u = [string]$p.UninstallString',
  "    if ($d -match 'DS Harness Desktop' -or $u -match 'DS Harness Desktop') {",
  "      $hits += ($_.Name -replace '^HKEY_CURRENT_USER', 'HKCU' -replace '^HKEY_LOCAL_MACHINE', 'HKLM')",
  '    }',
  '  }',
  '}',
  '$hits | ForEach-Object { Write-Output ("KEY=" + $_) }',
  'Write-Output ("SCAN-DONE " + $hits.Count)',
].join('\n');

function findVisibleUninstallKeys() {
  const script = path.join(os.tmpdir(), `dsh-uninst-scan-${process.pid}.ps1`);
  try {
    fs.writeFileSync(script, UNINSTALL_SCAN_PS, 'utf8');
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    if (r.error) return null;
    const lines = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 哨兵行是"脚本真的跑完了"的唯一凭据（不能拿 JSON 形态判断：PS 5.1 对单元素数组
    // 会退化成裸字符串）——没有哨兵或计数对不上一律按扫描失败处理（fail-closed）。
    const doneLine = [...lines].reverse().find((l) => /^SCAN-DONE \d+$/.test(l));
    if (!doneLine) return null;
    const expected = Number(doneLine.split(' ')[1]);
    const keys = lines.filter((l) => l.startsWith('KEY=')).map((l) => l.slice(4));
    if (keys.length !== expected) return null;
    return keys;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(script, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 只有复查判定为"干净"才放行安装器；扫描失败（null）或仍有键一律中止。 */
function assertNoVisibleUninstallKeys(stage) {
  const visible = findVisibleUninstallKeys();
  if (visible === null) {
    throw new Error(`${stage}复查失败（PowerShell 扫描无结果）——拒绝继续，fail-closed`);
  }
  if (visible.length > 0) {
    throw new Error(
      `${stage}复查仍发现 ${visible.length} 个未暂存的卸载键，拒绝继续（否则安装器会执行真卸载器）：\n  ` +
        visible.join('\n  '),
    );
  }
  console.log(`       | ${stage}复查通过：HKCU/HKLM/HKLM-WOW6432Node 均无未暂存的卸载键`);
}

/**
 * 零风险自检：不跑安装器，只演练「扫描 → 暂存 → 复查 → 还原 → 再复查」，
 * 回答"防护网真的能挡住误删吗"。用法：npm run verify:smoke -- --audit-stash
 * 会临时删除本机卸载键并随即导回；若中途被打断，用 产出\reg-backup-*\*.reg 手工导回。
 */
async function auditStashSafety() {
  console.log('\n[自检] 暂存/还原演练（不启动任何安装器、不碰应用文件）');
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-stash-'));
  const backupDir = path.join(tempBase, 'reg-backup');
  const entries = [];
  let ok = false;
  try {
    const before = findVisibleUninstallKeys();
    if (before === null) throw new Error('扫描失败（PowerShell 无输出）');
    console.log(`  1) 扫描本机卸载键：命中 ${before.length} 个`);
    for (const k of before) console.log(`       ${k}`);

    const realDirs = stashUninstallKeys(backupDir, entries);
    console.log(
      `  2) 真实暂存：导出并删除 ${entries.length} 个键（卸载键 + 安装记忆键）；推断真实安装目录 ${realDirs.length} 个`,
    );
    for (const e of entries) console.log(`       ${e.key}`);
    for (const d of realDirs) console.log(`       真实安装：${d}`);

    const after = findVisibleUninstallKeys();
    if (after === null) throw new Error('暂存后复查扫描失败');
    console.log(`  3) 暂存后复查：命中 ${after.length} 个（期望 0）`);
    for (const k of after) console.log(`       ! 泄漏 ${k}`);

    restoreUninstallKeys(entries);
    const restored = findVisibleUninstallKeys();
    if (restored === null) throw new Error('还原后扫描失败');
    console.log(`  4) 还原后复查：命中 ${restored.length} 个（期望 ${before.length}）`);

    if (before.length === 0) {
      console.log('  结论：本机没有已登记的安装键（全新环境），防护网无事可做 → 视为通过 ✓');
      ok = true;
    } else {
      // entries 含卸载键 + 安装记忆键，故用 >=；复查/还原一律以"卸载键可见数"为准
      ok = entries.length >= before.length && after.length === 0 && restored.length === before.length;
      console.log(
        ok
          ? '  结论：防护网有效——暂存藏住了本机键、独立复查确认干净、还原完整 ✓'
          : '  结论：未达预期 ✗（对照上面各步数字，先别跑完整 [5]）',
      );
    }
  } catch (error) {
    console.log(`  ! 自检中止：${error.message}`);
    console.log('    fail-closed：没有删除任何应用文件；已暂存的键会在收尾时导回');
  } finally {
    try {
      restoreUninstallKeys(entries);
    } catch (error) {
      console.warn(`       ! 还原异常：${error.message}`);
    }
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
async function main() {
  if (process.argv.includes('--audit-stash')) {
    await auditStashSafety();
    return;
  }
  // -------------------------------------------------------------------------
  console.log('\n[1] 离线单测（test/updater.test.js）');
  // -------------------------------------------------------------------------
  await step('离线单测全部通过', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'updater.test.js')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (r.status === 0) {
      const last = out.split(/\r?\n/).filter(Boolean).pop();
      if (last) console.log(`       ${last}`);
    } else {
      console.log(indent(out || '（无输出）'));
    }
    assert.equal(r.status, 0, `离线单测退出码=${r.status}`);
  });

  // -------------------------------------------------------------------------
  console.log('\n[2] 静态检查');
  // -------------------------------------------------------------------------
  const nodeExe = path.join(appDir, 'runtime', 'node.exe');

  await step('侧车 runtime/node.exe 存在且 Node ≥ 22（dsh 依赖 zstd 等新 API）', () => {
    assert.ok(fs.existsSync(nodeExe), `缺少 ${nodeExe}（按 README 准备 Node 24 侧车）`);
    const r = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `node --version 失败：${(r.stderr || '').trim()}`);
    const version = String(r.stdout || '').trim();
    const major = Number(version.replace(/^v/, '').split('.')[0]);
    assert.ok(major >= 22, `侧车 Node 版本过低：${version}（需要 ≥ 22）`);
    console.log(`       侧车 ${version}`);
  });

  await step('侧车含可执行 npm（应用内「检查 dsh 更新」的前提，防 prepare-runtime 被绕过）', () => {
    assert.ok(fs.existsSync(nodeExe), `缺少 ${nodeExe}`);
    const npmCli = path.join(appDir, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert.ok(
      fs.existsSync(npmCli),
      `侧车缺少 ${npmCli} —— 打包前须经 scripts/prepare-runtime.ps1（npm run build 已自动挂钩；CI 由 release.yml 保证）`,
    );
    const r = spawnSync(nodeExe, [npmCli, '--version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `侧车 npm 不可执行（exit=${r.status}）：${(r.stderr || '').trim()}`);
    const npmVersion = String(r.stdout || '').trim();
    assert.ok(/^\d+\./.test(npmVersion), `npm --version 输出异常：${npmVersion || '（空）'}`);
    console.log(`       侧车 npm ${npmVersion}`);
  });

  await step('内置 dsh 版本与 package.json 声明精确一致（依赖不带 ^）', () => {
    const appPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    const declared = (appPkg.dependencies || {})['@deepseek-ai/dsh'];
    assert.ok(typeof declared === 'string' && declared.length > 0, 'package.json 未声明 @deepseek-ai/dsh');
    assert.ok(!/^[\^~]/.test(declared), `依赖必须是精确版本，当前声明：${declared}`);
    const dshPkgPath = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    assert.ok(fs.existsSync(dshPkgPath), '开发树缺少 node_modules/@deepseek-ai/dsh（先 cd app && npm ci）');
    const installed = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')).version;
    assert.equal(installed, declared, `声明 ${declared} ≠ 已安装 ${installed}（依赖不可复现）`);
    console.log(`       dsh ${installed}（精确钉死）`);
  });

  await step('compression: none 守卫在位（开发树干净 + afterPack 仍有硬失败逻辑）', () => {
    const guard = updater.checkCompatibility(appDir);
    assert.ok(guard.ok, `开发树被守卫拒绝：${guard.reason}`);
    const afterPackSrc = fs.readFileSync(path.join(appDir, 'build', 'afterPack.js'), 'utf8');
    assert.ok(afterPackSrc.includes('compression:\\s*none'), 'afterPack.js 的 compression: none 守卫疑似被删除');
    assert.ok(afterPackSrc.includes('throw new Error'), 'afterPack.js 似乎不再硬失败（throw）');
  });

  // -------------------------------------------------------------------------
  console.log('\n[3] 侧车启动冒烟（临时 DSH_HOME，绝不触碰真实 ~/.dsh）');
  // -------------------------------------------------------------------------
  await step('内置 dsh web 能启动并打出带 token 的地址', async () => {
    assert.ok(fs.existsSync(nodeExe), `缺少 ${nodeExe}`);
    const started = Date.now();
    const result = await updater.smokeTest({
      root: appDir,
      nodePath: nodeExe,
      cwd: os.homedir(),
      portStart: 3199,
      timeoutMs: 120_000,
      log: (message) => console.log(`       | ${message}`),
    });
    assert.ok(result.ok, result.reason || '冒烟失败');
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`       监听于 127.0.0.1:${result.port}（耗时 ${secs}s，token 已隐去）`);
  });

  // -------------------------------------------------------------------------
  console.log('\n[4] 打包产物启动冒烟（win-unpacked，最接近「更新完还打得开吗」）');
  // -------------------------------------------------------------------------
  let exePath = null;
  if (fs.existsSync(packedDir)) {
    const exe = fs.readdirSync(packedDir).find((name) => name.toLowerCase().endsWith('.exe'));
    if (exe) exePath = path.join(packedDir, exe);
  }

  if (!exePath) {
    const reason = '未找到 产出/win-unpacked/*.exe，先跑 npm run build:dir 再验证';
    if (requirePackaged) {
      await step('打包产物存在', () => assert.fail(reason));
    } else {
      skipStep('打包产物启动', reason);
    }
  } else {
    await step('exe 拉起后端口真正监听且进程存活', async () => {
      const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'));
      try {
        const port = await findFreePort(3490);
        const { dirs, env } = isolationEnv(tempBase, port);
        console.log(`       | 启动 ${path.basename(exePath)}（隔离端口 ${port}）`);
        const { port: alivePort, secs } = await launchAndProbe(exePath, packedDir, env, {
          portStart: port,
          userDataDir: dirs.userData,
        });
        console.log(`       监听于 127.0.0.1:${alivePort}，进程存活（耗时 ${secs}s）`);
      } finally {
        try {
          killProcessesUnder(tempBase);
          removeTreeSafe(tempBase);
        } catch (error) {
          console.warn(`       ! 临时目录清理失败（不影响判定）：${error.message}`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  console.log('\n[5] 安装器端到端（静默安装 → 启动监听 → 卸载还原）');
  // -------------------------------------------------------------------------
  const installer = newestInstaller();
  const packedExePath = exePath || path.join(packedDir, APP_EXE_NAME);
  const foreignCount = countForeignInstances();
  const forceInstaller = process.argv.includes('--force-installer');

  // 第一优先守卫：本机已有真实安装 → 默认跳过（2026-09-24 事故的设计级根因——
  // NSIS 的快捷方式路径与注册表键名由产品名/GUID 派生、与安装目录无关，"装到临时目录"
  // 隔离不了这些命名空间；全机模式下安装器还会去执行真实安装的卸载器）。
  // 发版门禁交给 CI（干净机器无物可毁）；确要在本机跑必须显式 --force-installer。
  const localInstallKeys = findVisibleUninstallKeys();
  const localInstallCount = localInstallKeys === null ? null : localInstallKeys.length;

  if (!forceInstaller && localInstallCount === null) {
    skipStep(
      '安装器端到端',
      '无法确认本机是否已有该应用的真实安装（注册表扫描失败）——默认不跑破坏性步骤；确认环境干净后加 --force-installer',
    );
  } else if (!forceInstaller && localInstallCount > 0) {
    skipStep(
      '安装器端到端',
      `本机存在真实安装（${localInstallCount} 个已登记卸载键，如 ${localInstallKeys[0]}）——` +
        'NSIS 快捷方式/注册表命名空间由产品名/GUID 派生、与安装目录无关，"装到临时目录"隔离不了它；' +
        '发版门禁由 CI（干净机器）承担；确要在本机跑请加 --force-installer（暂存/复查/快照还原护栏会启用）',
    );
  } else if (foreignCount > 0 && !forceInstaller) {
    skipStep(
      '安装器端到端',
      `检测到 ${foreignCount} 个正在运行的 DS Harness Desktop 实例——NSIS 安装/卸载会按进程名杀掉所有同名进程（会误杀你正在用的窗口），已跳过；退出正式实例后重跑，或加 --force-installer 强行`,
    );
  } else if (!installer) {
    skipStep('安装器端到端', '产出\\ 下无 *Setup*.exe（npm run build 才产安装包；build:dir 不产）');
  } else if (fs.existsSync(packedExePath) && fs.statSync(installer).mtimeMs < fs.statSync(packedExePath).mtimeMs) {
    skipStep('安装器端到端', `安装包比当前 win-unpacked 旧（${path.basename(installer)}），先 npm run build 再验证`);
  } else {
    if (forceInstaller && localInstallCount > 0) {
      console.warn(
        `       ! --force-installer 已生效：本机存在真实安装（${localInstallCount} 个卸载键），` +
          '请确认你用的是管理员 PowerShell——暂存/复查/还原护栏生效，跑完核对收尾复查行',
      );
    }
    await step('静默安装到临时目录 → 启动 → 端口监听 → 卸载并还原快捷方式', async () => {
      const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-inst-'));
      const installDir = path.join(tempBase, 'installed-app');
      const backupDir = path.join(tempBase, 'shortcut-backup');
      let snap = null;
      let keyStash = [];
      const realDirs = [];
      let baselineKeys = null;
      let bodyError = null;
      const shortcutFailures = [];
      try {
        console.log(`       | 安装包 ${path.basename(installer)}`);
        snap = snapshotShortcuts(backupDir);
        // 基线：跑之前本机可见的卸载键数量（跑完必须回到这个数）
        baselineKeys = findVisibleUninstallKeys();
        if (baselineKeys === null) {
          throw new Error('安装前基线扫描失败（PowerShell 无输出）——fail-closed 中止');
        }
        // entries 用调用方数组逐步写入：中途抛错时 finally 仍能把已藏的键导回
        const stashedRealDirs = stashUninstallKeys(backupDir, keyStash);
        realDirs.push(...stashedRealDirs);
        if (keyStash.length > 0) {
          console.log(`       | 已暂存 ${keyStash.length} 个卸载注册表键（防 temp 安装把真安装当旧版卸载）`);
          console.log(
            `       | 中断恢复：若本次运行被强制中断，对 ${backupDir} 下每个 .reg 执行 reg import 即可复原`,
          );
        } else {
          console.log('       | 未发现本机已登记的卸载键（全新环境）');
        }

        // 硬闸（fail-closed）：以独立实现复查，只要还能读到本机卸载键就绝不启动安装器
        assertNoVisibleUninstallKeys('安装前');

        // /S 静默安装；/currentuser 强制每用户命名空间（不碰公共桌面/HKLM，隔离真实安装）；
        // /D= 必须是最后一个参数且不带引号（NSIS 约定）
        const t0 = Date.now();
        const ins = spawnSync(installer, ['/S', '/currentuser', `/D=${installDir}`], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 300_000,
        });
        const installSecs = Math.round((Date.now() - t0) / 1000);
        if (ins.error) throw new Error(`安装器启动失败：${ins.error.message}`);
        if (ins.status !== 0) {
          const detail = `${(ins.stderr || '') + (ins.stdout || '')}`.trim().slice(-600);
          throw new Error(`安装器退出码=${ins.status}（${installSecs}s）\n${indent(detail || '（无输出）')}`);
        }

        const installedExe = path.join(installDir, APP_EXE_NAME);
        assert.ok(fs.existsSync(installedExe), `安装完成但缺少 ${installedExe}`);
        console.log(`       | 安装完成（${installSecs}s）→ ${installDir}`);

        // 观测 temp 实例把自己登记到哪个命名空间——/currentuser 的隔离要"看得见"才算数
        const tempRegistrations = findVisibleUninstallKeys();
        if (tempRegistrations === null) {
          console.warn('       ! temp 实例注册位置未知（扫描失败）——请人工确认它没写 HKLM');
        } else if (tempRegistrations.length === 0) {
          console.warn('       ! temp 实例未登记卸载键（静默安装可能未注册；继续，但请留意）');
        } else {
          const inMachine = tempRegistrations.filter((k) => k.startsWith('HKLM'));
          console.log(
            `       | temp 实例注册于 ${tempRegistrations.join('、')}` +
              (inMachine.length > 0 ? '  ⚠ 含 HKLM（每用户隔离未生效！）' : '  ✓ 仅 HKCU（每用户命名空间）'),
          );
        }

        const port = await findFreePort(3590);
        const { dirs, env } = isolationEnv(tempBase, port);
        const { port: alivePort, secs } = await launchAndProbe(installedExe, installDir, env, {
          portStart: port,
          userDataDir: dirs.userData,
        });
        console.log(`       监听于 127.0.0.1:${alivePort}，进程存活（启动耗时 ${secs}s）`);

        // ---- 卸载：先杀进程（launchAndProbe 已回收），跑官方卸载器清注册表与快捷方式 ----
        const uninstallExe = fs.existsSync(installDir)
          ? fs
              .readdirSync(installDir)
              .filter((name) => /\.exe$/i.test(name) && /uninstall/i.test(name))
              .map((name) => path.join(installDir, name))[0]
          : null;
        if (uninstallExe) {
          const t1 = Date.now();
          // _?= 让卸载器就地同步执行：不带它时 NSIS 会把卸载器复制到 %TEMP% 异步跑、
          // 父进程 0 秒返回——子进程会在我们还原快捷方式之后才删它们，还会留下句柄竞态（EPERM）
          const un = spawnSync(uninstallExe, ['/S', `_?=${installDir}`], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
          console.log(
            `       | 卸载器返回（${Math.round((Date.now() - t1) / 1000)}s，退出码=${un.status}` +
              `${fs.existsSync(installedExe) ? '，应用文件仍有残留' : '，应用文件已移除'}）`,
          );
          // NSIS 卸载器可能延迟释放句柄，给它 1.5s 再清扫
          await sleep(1500);
        }
        killProcessesUnder(installDir);
        removeTreeSafe(installDir);
        console.log('       | 临时安装目录已清理');
        // 硬红线：本机真实安装体在整个验证过程中必须毫发无损
        for (const realDir of realDirs) {
          assert.ok(
            fs.existsSync(path.join(realDir, APP_EXE_NAME)),
            `测试破坏了真实安装体：${path.join(realDir, APP_EXE_NAME)} 已不存在（uninstallOldVersion 泄漏？）`,
          );
        }
        if (realDirs.length > 0) console.log(`       真实安装体完好（${realDirs.join('; ')}）`);
      } catch (error) {
        bodyError = error;
        throw error;
      } finally {
        // 收尾异常绝不能顶掉主流程的真实报错；但"清理没做干净"必须在主流程成功时判红
        try {
          restoreUninstallKeys(keyStash);
        } catch (error) {
          console.warn(`       ! 卸载键恢复异常：${error.message}`);
        }
        try {
          if (snap) {
            const failures = restoreShortcuts(snap, backupDir);
            shortcutFailures.push(...failures);
            if (failures.length === 0) {
              console.log(`       快捷方式已还原为安装前状态（${snap.length} 项快照逐项复查在位）`);
            } else {
              console.warn(`       ! 快捷方式未能原样还原：${failures.join('；')}`);
            }
          }
        } catch (error) {
          shortcutFailures.push(`快捷方式还原异常：${error.message}`);
        }
        // 收尾复查：本机卸载键必须回到基线（用独立实现扫描，避免"自己说自己好了"）
        let afterKeys = null;
        try {
          afterKeys = findVisibleUninstallKeys();
        } catch {
          afterKeys = null;
        }
        if (afterKeys === null) {
          shortcutFailures.push('收尾复查扫描失败（无法确认本机卸载键已还原）');
        } else if (baselineKeys === null) {
          console.log(`       收尾复查：本机卸载键可见 ${afterKeys.length} 个（基线缺失，未作比较）`);
        } else if (afterKeys.length !== baselineKeys.length) {
          shortcutFailures.push(
            `本机卸载键未回到基线（跑前 ${baselineKeys.length} 个，跑后 ${afterKeys.length} 个）`,
          );
        } else {
          console.log(`       收尾复查通过：本机卸载键回到基线 ${afterKeys.length} 个`);
        }
        try {
          killProcessesUnder(tempBase);
          removeTreeSafe(tempBase);
        } catch (error) {
          console.warn(`       ! 临时目录清理失败：${error.message}`);
        }
        // 主流程成功时，"痕迹未清干净"必须判红（宁可报红，也不留静默损失）
        if (!bodyError && shortcutFailures.length > 0) {
          throw new Error(
            `跑完未能做到痕迹全无（快捷方式/注册表）：\n  ${shortcutFailures.join('\n  ')}\n` +
              '  恢复：产出\\reg-backup-*\\*.reg 手工 reg import；快捷方式重新安装即为原样',
          );
        }
      }
    });
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}，跳过 ${skipped}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n冒烟脚本自身异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
