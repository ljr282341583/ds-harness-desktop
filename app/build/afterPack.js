'use strict';

/**
 * electron-builder afterPack 钩子。
 *
 * 做两件事：
 * 1. 覆盖 node_modules —— electron-builder 依赖 Go 二进制 `node-dep-tree` 计算生产
 *    依赖，对 `@deepseek-ai/*` 这种大规模（195+ 包）、大量 peerDependencies 的依赖树
 *    解析不完整，会漏掉大部分包。这里用开发期完整的 node_modules 覆盖。
 * 2. rcedit 嵌图标/版本信息 —— 因 `signAndEditExecutable:false`（为规避 winCodeSign
 *    符号链接解压失败），exe 资源编辑被跳过；这里手动调 app-builder 的 rcedit 把
 *    icon.ico 与版本信息嵌入 exe，安装器/便携版会随 win-unpacked 一起带上。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  // context.packager 是 PlatformPackager；应用目录在 packager.info.appDir
  const packager = context.packager;
  const appDir =
    (packager.info && packager.info.appDir) || packager.appDir || packager.projectDir;
  // AppInfo（含 productName / productFilename / version）在 packager.info.appInfo 上
  const appInfo =
    (packager.info && packager.info.appInfo) || packager.appInfo || { version: '0.1.0', productName: 'DS Harness Desktop', productFilename: 'DS Harness Desktop' };

  // ---- 1. 覆盖 node_modules ----
  const src = path.join(appDir, 'node_modules');
  const dest = path.join(appOutDir, 'resources', 'app', 'node_modules');

  if (fs.existsSync(src)) {
    const skipTopLevel = new Set(['electron', 'electron-builder', '.cache', '.package-lock.json']);
    const filter = (filePath) => {
      const rel = path.relative(src, filePath);
      if (rel === '') return true;
      const first = rel.split(path.sep)[0];
      return !skipTopLevel.has(first);
    };
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, filter });
    const count = fs.readdirSync(path.join(dest, '@deepseek-ai')).length;
    console.log(`[afterPack] replaced node_modules, @deepseek-ai packages: ${count}`);

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
