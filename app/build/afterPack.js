'use strict';

/**
 * electron-builder afterPack 钩子。
 *
 * 做三件事：
 * 1. 生成"仅运行时依赖"的 node_modules 并覆盖进去。
 *    - electron-builder 自带的依赖裁剪基于 Go 二进制 `node-dep-tree`，对
 *      `@deepseek-ai/*` 这种大规模（240 包）、大量 peerDependencies 的树解析不完整，
 *      历史上会漏包，所以这里不用它的结果。
 *    - 但也不能像以前那样把开发期完整 node_modules 原样塞进去：那会把整套构建工具链
 *      （@electron/*、7zip-bin、flatpak-bundler 等 260 个包）一起发给用户，
 *      安装包白白多出上百 MB、上万个文件，而安装速度主要就卡在文件数上。
 *    - 做法：用 `npm ci --omit=dev` 在临时目录装一份生产依赖（含全部 240 个
 *      `@deepseek-ai/*` 包），再按内容哈希缓存，避免每次构建重复安装。
 * 2. 修剪运行时用不到的文件：测试/示例/文档目录、sourcemap、Markdown、TypeScript
 *    源码与类型声明（已核实没有任何生产包的运行时入口指向 .ts）。
 * 3. rcedit 嵌图标/版本信息 —— 因 `signAndEditExecutable:false`（为规避 winCodeSign
 *    符号链接解压失败），exe 资源编辑被跳过；这里手动调 app-builder 的 rcedit 把
 *    icon.ico 与版本信息嵌入 exe，安装器/便携版会随 win-unpacked 一起带上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

/**
 * 运行时不需要的目录。
 *
 * 关键约束：**只在"包根目录"判定，绝不在包内部按名字删**。
 * 教训：`yaml` 包里有 `dist/doc/`，且 `dist/compose/composer.js` 会
 * `require('../doc/directives.js')`；早先按目录名全局删除会把运行时目录删掉，
 * 结果是 dsh 启动即失败。同理 `gaxios/build/cjs/test`、`zod/src/.../tests`
 * 这类"名字像测试、实际在运行时路径里"的目录也必须保留。
 */
const PRUNE_PACKAGE_DIRS = new Set([
  '.github',
  '.vscode',
  '.idea',
  'docs',
  'doc',
  'example',
  'examples',
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
  'samples',
]);

/** 运行时不会加载的文件：sourcemap。 */
const PRUNE_EXT = new Set(['.map']);
/** TypeScript 类型声明：运行时不会解析（已核实没有包的运行时入口指向 .ts）。 */
const PRUNE_DTS_SUFFIX = ['.d.ts', '.d.mts', '.d.cts'];

function shouldPruneFile(name) {
  const lower = name.toLowerCase();
  if (PRUNE_DTS_SUFFIX.some((suffix) => lower.endsWith(suffix))) return true;
  return PRUNE_EXT.has(path.extname(lower));
}

function hashFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/** 优先用捆绑的 Node 24 侧车 + 其自带 npm；找不到再退回 PATH 上的 npm。 */
function resolveNpmRunner(appDir) {
  const nodeExe = path.join(appDir, 'runtime', 'node.exe');
  const npmCli = path.join(appDir, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(nodeExe) && fs.existsSync(npmCli)) {
    return { command: nodeExe, prefixArgs: [npmCli] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [] };
}

/**
 * 准备（并缓存）仅含生产依赖的 node_modules。
 * 缓存键取 package.json + package-lock.json 的内容哈希，避免每次构建都重装。
 */
function prepareProductionDeps(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  const lockPath = path.join(appDir, 'package-lock.json');
  const key = hashFiles([pkgPath, lockPath]);
  const workDir = path.join(os.tmpdir(), 'dsh-desktop-prod-deps', key);
  const modulesDir = path.join(workDir, 'node_modules');
  const stampFile = path.join(workDir, '.ready');

  if (fs.existsSync(stampFile) && fs.existsSync(modulesDir)) {
    console.log(`[afterPack] 复用生产依赖缓存：${workDir}`);
    return modulesDir;
  }

  console.log('[afterPack] 安装生产依赖（npm ci --omit=dev）…');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    const from = path.join(appDir, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(workDir, name));
  }

  const npm = resolveNpmRunner(appDir);
  const result = spawnSync(
    npm.command,
    [...npm.prefixArgs, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error'],
    { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `[afterPack] 安装生产依赖失败（exit=${result.status}）：${(result.stderr || result.stdout || '').trim().slice(-500)}\n` +
        '提示：该步骤需要能访问 npm registry。若要离线构建，可先手工准备缓存。',
    );
  }

  if (!fs.existsSync(path.join(modulesDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('[afterPack] 生产依赖里缺少 @deepseek-ai/dsh，拒绝继续打包');
  }
  fs.writeFileSync(stampFile, `${new Date().toISOString()}\n`, 'utf8');
  return modulesDir;
}

/**
 * 递归复制并按规则修剪，同时统计。
 *
 * mode 的含义：
 * - `modules`：当前目录是 node_modules，子项是包目录或 @scope 目录
 * - `package`：当前目录是一个包的根，可以按名字修剪它的直接子目录
 * - `plain`  ：包内部目录，只按文件后缀修剪（不再按目录名删）
 */
function copyPruned(src, dest, stats, mode) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (mode === 'package' && PRUNE_PACKAGE_DIRS.has(entry.name)) {
        stats.prunedDirs += 1;
        continue;
      }
      let nextMode = 'plain';
      if (entry.name === 'node_modules') nextMode = 'modules';
      else if (mode === 'modules') nextMode = entry.name.startsWith('@') ? 'modules' : 'package';
      copyPruned(from, to, stats, nextMode);
    } else if (entry.isFile()) {
      if (shouldPruneFile(entry.name)) {
        stats.prunedFiles += 1;
        continue;
      }
      const size = fs.statSync(from).size;
      fs.copyFileSync(from, to);
      stats.files += 1;
      stats.bytes += size;
    } else {
      // 符号链接等：npm 树里不应存在必须保留的链接，跳过并计数
      stats.skipped += 1;
    }
  }
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  // context.packager 是 PlatformPackager；应用目录在 packager.info.appDir
  const packager = context.packager;
  const appDir =
    (packager.info && packager.info.appDir) || packager.appDir || packager.projectDir;
  // AppInfo（含 productName / productFilename / version）在 packager.info.appInfo 上
  const appInfo =
    (packager.info && packager.info.appInfo) || packager.appInfo || { version: '0.1.0', productName: 'DS Harness Desktop', productFilename: 'DS Harness Desktop' };

  // ---- 1. 用"仅运行时依赖 + 已修剪"的 node_modules 覆盖 ----
  const dest = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const prodModules = prepareProductionDeps(appDir);

  fs.rmSync(dest, { recursive: true, force: true });
  const stats = { files: 0, bytes: 0, prunedFiles: 0, prunedDirs: 0, skipped: 0 };
  copyPruned(prodModules, dest, stats, 'modules');
  const count = fs.readdirSync(path.join(dest, '@deepseek-ai')).length;
  console.log(
    `[afterPack] node_modules 已按运行时依赖重建：@deepseek-ai 包 ${count} 个，` +
      `写入 ${stats.files} 个文件 / ${(stats.bytes / 1048576).toFixed(1)} MB；` +
      `修剪掉 ${stats.prunedFiles} 个文件 + ${stats.prunedDirs} 个目录` +
      (stats.skipped ? `；跳过 ${stats.skipped} 个特殊条目` : ''),
  );

  // ---- 依赖守卫：拒绝会把会话后端设成「不压缩」的 dsh-base 构建 ----
  // 背景：@deepseek-ai/dsh-base 的 cordis.patch.yml 若含 `compression: none`，
  // 打包后的 dsh 将无法读取 ~/.dsh/sessions 下既有的 .jsonl.zstd 会话，
  // 表现为桌面版启动即闪退（dsh 子进程 exit code 1）。同版本号在不同
  // registry/时点的 tarball 内容可能不同，这里在打包期硬校验，不兼容就 fail。
  const dshBasePatch = path.join(dest, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
  if (fs.existsSync(dshBasePatch)) {
    const patchText = fs.readFileSync(dshBasePatch, 'utf8');
    if (/\bcompression:\s*none\b/.test(patchText)) {
      throw new Error(
        '[afterPack] 打包的 @deepseek-ai/dsh-base/cordis.patch.yml 包含 `compression: none`，' +
        '会让桌面版无法读取现有 .jsonl.zstd 历史会话（启动即闪退）。' +
        '请先用与 CLI 一致的 registry 执行 npm ci 重新安装依赖后再打包。'
      );
    }
    const dshPkgPath = path.join(dest, '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(dshPkgPath)) {
      const dshVersion = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')).version;
      const appPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      const wanted = appPkg.dependencies && appPkg.dependencies['@deepseek-ai/dsh'];
      console.log(`[afterPack] dsh guard: bundled @deepseek-ai/dsh=${dshVersion}, declared=${wanted}`);
      if (typeof wanted === 'string' && wanted.startsWith('^')) {
        console.warn(`[afterPack] 建议把 @deepseek-ai/dsh 依赖改为精确版本（去掉 ^），当前声明: ${wanted}`);
      }
    }
  }

  // ---- 2. rcedit 嵌图标 + 版本信息 ----
  const exeName = `${appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeName);
  const iconPath = path.join(appDir, 'build', 'icon.ico');
  // 直接用手动解压出的 rcedit-x64.exe（app-builder 的 rcedit 会去下载 winCodeSign，触发符号链接问题）
  const rceditExe = path.join(appDir, 'build', 'rcedit-x64.exe');

  if (fs.existsSync(exePath) && fs.existsSync(iconPath) && fs.existsSync(rceditExe)) {
    const version = appInfo.version || '0.1.0';
    const productName = appInfo.productName || 'DS Harness Desktop';
    const rceditArgs = [
      exePath,
      '--set-version-string', 'FileDescription', productName,
      '--set-version-string', 'ProductName', productName,
      '--set-version-string', 'CompanyName', productName,
      '--set-version-string', 'LegalCopyright', 'DeepSeek Harness Desktop',
      '--set-file-version', version,
      '--set-product-version', version,
      '--set-icon', iconPath,
    ];
    execFileSync(rceditExe, rceditArgs, {
      stdio: 'inherit',
      windowsHide: true,
    });
    console.log(`[afterPack] rcedit: embedded icon + version into ${exeName}`);
  } else {
    console.log('[afterPack] rcedit skipped (exe/icon/rcedit not found)');
  }
};
