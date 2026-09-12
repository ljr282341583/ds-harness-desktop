'use strict';

/**
 * DS Harness Desktop — updater.js 测试
 *
 * 无第三方测试框架，直接用 Node 运行：
 *   node test/updater.test.js          仅跑离线单元测试
 *   node test/updater.test.js --e2e    追加真实网络端到端（安装 rc.2 + 冒烟 + 激活 + 回滚）
 *
 * 端到端测试使用临时目录作为版本根，全程不触碰真实 ~/.dsh。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../src/updater.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

function tmpRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`));
  return dir;
}

/** 造一棵假的已安装版本树，用于离线测试守卫与状态。 */
function fakeVersionTree(baseDir, version, options = {}) {
  const root = updater.versionRoot(baseDir, version);
  const dshDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const baseDirPkg = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-base');
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true });
  fs.mkdirSync(baseDirPkg, { recursive: true });
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '// fake\n', 'utf8');
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8');
  if (options.compression) {
    fs.writeFileSync(path.join(baseDirPkg, 'cordis.patch.yml'), `- insert:\n    - id: x\n      config:\n        compression: ${options.compression}\n`, 'utf8');
  }
  return root;
}

// ---------------------------------------------------------------------------
console.log('\n[1] 版本比较（semver 预发布规则）');
// ---------------------------------------------------------------------------

test('相同版本返回 0', () => {
  assert.equal(updater.compareVersions('0.1.5-rc.1', '0.1.5-rc.1'), 0);
});

test('rc.2 大于 rc.1', () => {
  assert.equal(updater.compareVersions('0.1.5-rc.2', '0.1.5-rc.1'), 1);
  assert.equal(updater.compareVersions('0.1.5-rc.1', '0.1.5-rc.2'), -1);
});

test('正式版大于同号预发布版', () => {
  assert.equal(updater.compareVersions('0.1.5', '0.1.5-rc.2'), 1);
  assert.equal(updater.compareVersions('0.1.5-rc.2', '0.1.5'), -1);
});

test('数字标识符优先级低于字母标识符（1.0.0-1 < 1.0.0-alpha）', () => {
  assert.equal(updater.compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('alpha 早于 rc（0.1.5-alpha.2 < 0.1.5-rc.1）', () => {
  assert.equal(updater.compareVersions('0.1.5-alpha.2', '0.1.5-rc.1'), -1);
});

test('跨小版本比较正确（0.1.3-alpha.2 < 0.1.5-rc.1）', () => {
  assert.equal(updater.compareVersions('0.1.5-rc.1', '0.1.3-alpha.2'), 1);
});

test('无法解析的版本返回 null', () => {
  assert.equal(updater.compareVersions('not-a-version', '1.0.0'), null);
});

// ---------------------------------------------------------------------------
console.log('\n[2] 通道 → 标签映射');
// ---------------------------------------------------------------------------

test('stable → latest，preview → next', () => {
  const packument = { 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2', alpha: '0.1.5-alpha.2' } };
  assert.deepEqual(updater.resolveTargetVersion(packument, 'stable'), { tag: 'latest', version: '0.1.5-rc.1' });
  assert.deepEqual(updater.resolveTargetVersion(packument, 'preview'), { tag: 'next', version: '0.1.5-rc.2' });
});

test('未知通道回退 stable', () => {
  const packument = { 'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' } };
  assert.equal(updater.resolveTargetVersion(packument, 'whatever').tag, 'latest');
});

test('next 缺失时回退 latest', () => {
  const packument = { 'dist-tags': { latest: '0.1.5-rc.1' } };
  assert.deepEqual(updater.resolveTargetVersion(packument, 'preview'), { tag: 'next', version: '0.1.5-rc.1' });
});

// ---------------------------------------------------------------------------
console.log('\n[3] checkForUpdate 判定');
// ---------------------------------------------------------------------------

(async () => {
  const packument = {
    'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' },
    versions: {
      '0.1.5-rc.1': { dist: { integrity: 'sha512-aaa' } },
      '0.1.5-rc.2': { dist: { integrity: 'sha512-bbb' } },
    },
    time: { '0.1.5-rc.2': '2026-09-10T14:57:10.790Z' },
  };

  await testAsync('stable 通道 + 内置 rc.1 → 无更新', async () => {
    const r = await updater.checkForUpdate({ currentVersion: '0.1.5-rc.1', channel: 'stable', packument });
    assert.equal(r.hasUpdate, false);
    assert.equal(r.target, '0.1.5-rc.1');
  });

  await testAsync('preview 通道 + 内置 rc.1 → 有更新且带 integrity', async () => {
    const r = await updater.checkForUpdate({ currentVersion: '0.1.5-rc.1', channel: 'preview', packument });
    assert.equal(r.hasUpdate, true);
    assert.equal(r.target, '0.1.5-rc.2');
    assert.equal(r.integrity, 'sha512-bbb');
    assert.equal(r.publishedAt, '2026-09-10T14:57:10.790Z');
  });

  await testAsync('当前版本高于通道版本 → 标记为可回退而非更新', async () => {
    const r = await updater.checkForUpdate({ currentVersion: '0.1.6', channel: 'stable', packument });
    assert.equal(r.hasUpdate, false);
    assert.equal(r.isDowngrade, true);
  });

  // -------------------------------------------------------------------------
  console.log('\n[4] 兼容守卫');
  // -------------------------------------------------------------------------

  const guardRoot = tmpRoot('guard');
  test('构建含 compression: none → 拒绝', () => {
    const root = fakeVersionTree(guardRoot, '9.9.9-bad', { compression: 'none' });
    const result = updater.checkCompatibility(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /compression: none/);
  });

  test('构建含 compression: gzip → 通过', () => {
    const root = fakeVersionTree(guardRoot, '9.9.9-good', { compression: 'gzip' });
    assert.equal(updater.checkCompatibility(root).ok, true);
  });

  test('无 cordis.patch.yml → 通过', () => {
    const root = fakeVersionTree(guardRoot, '9.9.9-nopatch', {});
    assert.equal(updater.checkCompatibility(root).ok, true);
  });

  test('缺 bin.js → 拒绝', () => {
    const root = path.join(updater.versionsDir(guardRoot), '9.9.9-empty');
    fs.mkdirSync(root, { recursive: true });
    assert.equal(updater.checkCompatibility(root).ok, false);
  });

  // -------------------------------------------------------------------------
  console.log('\n[5] 状态、激活、回滚与清理');
  // -------------------------------------------------------------------------

  const stateRoot = tmpRoot('state');
  test('初始状态为 stable 且无激活版本', () => {
    const s = updater.readState(stateRoot);
    assert.equal(s.activeVersion, null);
    assert.equal(s.channel, 'stable');
  });

  test('激活后 resolveActiveRoot 返回该目录', () => {
    fakeVersionTree(stateRoot, '1.0.0');
    updater.activate(stateRoot, '1.0.0');
    assert.equal(updater.resolveActiveRoot(stateRoot), updater.versionRoot(stateRoot, '1.0.0'));
    assert.equal(updater.readState(stateRoot).activeVersion, '1.0.0');
  });

  test('激活被守卫拒绝的版本会抛错', () => {
    fakeVersionTree(stateRoot, '1.0.1-bad', { compression: 'none' });
    assert.throws(() => updater.activate(stateRoot, '1.0.1-bad'), /compression: none/);
  });

  test('回滚到内置版本后 resolveActiveRoot 返回 null', () => {
    updater.deactivate(stateRoot);
    assert.equal(updater.resolveActiveRoot(stateRoot), null);
    assert.equal(updater.readState(stateRoot).previousVersion, '1.0.0');
  });

  test('清理只保留激活版本与上一可用版本', () => {
    fakeVersionTree(stateRoot, '2.0.0');
    fakeVersionTree(stateRoot, '2.0.1');
    fakeVersionTree(stateRoot, '2.0.2');
    updater.activate(stateRoot, '2.0.2');
    const removed = updater.cleanup(stateRoot);
    assert.ok(fs.existsSync(updater.versionRoot(stateRoot, '2.0.2')), '激活版本必须保留');
    assert.ok(fs.existsSync(updater.versionRoot(stateRoot, '1.0.0')), '上一可用版本必须保留');
    assert.ok(!fs.existsSync(updater.versionRoot(stateRoot, '2.0.1')), '中间版本应被清理');
    assert.ok(!fs.existsSync(updater.versionRoot(stateRoot, '2.0.0')), '中间版本应被清理');
    assert.ok(!fs.existsSync(updater.versionRoot(stateRoot, '1.0.1-bad')), '未激活版本应被清理');
    assert.ok(removed.length >= 3, `removed=${removed.join(',')}`);
  });

  // -------------------------------------------------------------------------
  console.log('\n[6] 冒烟验证的环境收敛');
  // -------------------------------------------------------------------------

  test('minimalSmokeEnv 不携带调用方的敏感变量', () => {
    process.env.DSH_TEST_FAKE_SECRET = 'sk-should-not-leak-0123456789';
    const env = updater.minimalSmokeEnv('C:\\tmp\\smoke-home');
    assert.equal(env.DSH_TEST_FAKE_SECRET, undefined);
    assert.equal(env.DSH_HOME, 'C:\\tmp\\smoke-home');
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
    delete process.env.DSH_TEST_FAKE_SECRET;
  });

  test('minimalSmokeEnv 保留进程启动所需的系统变量', () => {
    const env = updater.minimalSmokeEnv('/tmp/home');
    assert.ok(env.PATH || env.Path, '应保留 PATH');
    assert.ok(env.SystemRoot, '应保留 SystemRoot');
  });

  // -------------------------------------------------------------------------
  const runE2E = process.argv.includes('--e2e');
  if (runE2E) {
    console.log('\n[7] 端到端：真实下载安装 + 冒烟验证 + 激活 + 回滚');
    const e2eRoot = tmpRoot('e2e');
    const npmCli = process.env.DSH_TEST_NPM_CLI;
    // 允许注入侧车 node.exe，以验证"出厂配置"（捆绑 node + 捆绑 npm）真实可用
    const nodeExe = process.env.DSH_TEST_NODE || process.execPath;
    console.log(`       使用 node: ${nodeExe}`);
    console.log(`       使用 npm : ${npmCli || 'null'}`);
    if (!npmCli || !fs.existsSync(npmCli)) {
      console.log(`  SKIP 未提供 DSH_TEST_NPM_CLI（当前=${npmCli || 'null'}）`);
    } else {
      const started = Date.now();
      await testAsync('updateToLatest 能从 rc.1 更新到 rc.2 并通过冒烟验证', async () => {
        const result = await updater.updateToLatest({
          baseDir: e2eRoot,
          nodePath: nodeExe,
          npmCliPath: npmCli,
          currentVersion: '0.1.5-rc.1',
          channel: 'preview',
          log: (m) => console.log(`       | ${m}`),
        });
        assert.equal(result.status, 'updated', JSON.stringify(result).slice(0, 400));
        assert.equal(result.install.version, '0.1.5-rc.2');
        assert.equal(updater.readState(e2eRoot).activeVersion, '0.1.5-rc.2');
        assert.ok(updater.resolveActiveRoot(e2eRoot), '激活后应能解析出覆盖版本根');
      });
      console.log(`       （端到端耗时 ${Math.round((Date.now() - started) / 1000)} 秒）`);

      await testAsync('再次检查：stable 通道下 rc.2 高于 latest(rc.1)，判定为可回退', async () => {
        const r = await updater.checkForUpdate({ currentVersion: '0.1.5-rc.2', channel: 'stable' });
        assert.equal(r.hasUpdate, false);
        assert.equal(r.isDowngrade, true);
      });

      test('回滚到内置版本', () => {
        updater.deactivate(e2eRoot);
        assert.equal(updater.resolveActiveRoot(e2eRoot), null);
      });

      fs.rmSync(e2eRoot, { recursive: true, force: true });
    }
  }

  fs.rmSync(guardRoot, { recursive: true, force: true });
  fs.rmSync(stateRoot, { recursive: true, force: true });

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
