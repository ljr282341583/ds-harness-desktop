'use strict';
/**
 * dsh 会话存储身份审计（离线、只读）
 *
 * 复刻 dsh-session-persistence-jsonl 的 projectKey / encodeSegment / 路径推导，
 * 对每个会话文件：解出 zstd 首行 header 的 id + cwd，推导"应在的路径"，
 * 与实际所在路径比对 —— 等价于 dsh 启动时的 assertStoredIdentity。
 *
 * 输出：mismatch（错位，可修）/ conflict（同一会话 v2+v3 各自期望不同目录，需人工）
 *       / readError / ok。只报告，不修改任何文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions';

// —— 以下两函数逐字复刻自 @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js ——
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment');
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error('cannot encode an empty project path');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
// —— 复刻结束 ——

function expectedDirFor(cwd, id) {
	const proj = cwd === undefined ? '_no-cwd' : projectKey(cwd);
	return path.join(ROOT, proj, encodeSegment(id));
}

function readFirstLine(file) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let rs;
		let dec;
		const done = (err, val) => {
			if (settled) return;
			settled = true;
			try { rs && rs.close(); } catch {}
			try { dec && dec.destroy(); } catch {}
			if (err) reject(err); else resolve(val);
		};
		try { dec = zlib.createZstdDecompress(); } catch (e) { return reject(e); }
		rs = fs.createReadStream(file);
		rs.on('error', (e) => done(e));
		dec.on('error', (e) => done(e));
		let buf = Buffer.alloc(0);
		dec.on('data', (chunk) => {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
			const idx = buf.indexOf(10);
			if (idx >= 0) done(null, buf.subarray(0, idx).toString('utf8'));
		});
		rs.pipe(dec);
	});
}

const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();

async function main() {
	if (typeof zlib.createZstdDecompress !== 'function') {
		console.error('FATAL: 本 node 无 createZstdDecompress，换 node >= 23.8');
		process.exit(2);
	}
	const report = { root: ROOT, sessionsOk: 0, mismatches: [], conflicts: [], readErrors: [] };
	const projDirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
	for (const pd of projDirs) {
		const projPath = path.join(ROOT, pd.name);
		let entries;
		try { entries = fs.readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
		for (const sd of entries.filter((e) => e.isDirectory() && e.name.startsWith('session-'))) {
			const sessionPath = path.join(projPath, sd.name);
			let files;
			try { files = fs.readdirSync(sessionPath).filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f)); } catch { continue; }
			if (files.length === 0) continue;
			const perFile = [];
			let anyReadError = false;
			for (const f of files) {
				const fp = path.join(sessionPath, f);
				let header;
				try { header = JSON.parse(await readFirstLine(fp)); } catch (e) {
					report.readErrors.push({ file: fp, error: String((e && e.message) || e) });
					anyReadError = true;
					continue;
				}
				if (!header || typeof header !== 'object' || typeof header.id !== 'string') {
					report.readErrors.push({ file: fp, error: 'header 缺 id' });
					anyReadError = true;
					continue;
				}
				let expected;
				try { expected = expectedDirFor(header.cwd, header.id); } catch (e) {
					report.readErrors.push({ file: fp, error: '路径推导失败: ' + e.message });
					anyReadError = true;
					continue;
				}
				perFile.push({
					file: f,
					id: header.id,
					cwd: header.cwd === undefined ? null : header.cwd,
					expectedDir: expected,
					cwdExists: typeof header.cwd === 'string' ? fs.existsSync(header.cwd) : null,
				});
			}
			if (perFile.length === 0) continue;
			const expectedSet = [...new Set(perFile.map((x) => norm(x.expectedDir)))];
			const actualN = norm(sessionPath);
			const rec = { sessionDir: sessionPath, files: perFile, hasReadError: anyReadError };
			if (expectedSet.length > 1) {
				// 同一会话里不同代的文件期望不同目录：整体搬家会修一个坏一个 → 冲突，人工处理
				report.conflicts.push(rec);
			} else if (expectedSet[0] !== actualN) {
				report.mismatches.push(rec);
			} else {
				report.sessionsOk++;
			}
		}
	}
	console.log('=== 摘要 ===');
	console.log(`身份一致会话: ${report.sessionsOk}`);
	console.log(`错位(可修):  ${report.mismatches.length}`);
	console.log(`冲突(人工):   ${report.conflicts.length}`);
	console.log(`读取失败:     ${report.readErrors.length}`);
	console.log('=== 错位明细 ===');
	for (const m of report.mismatches) {
		console.log(`\n[实际] ${m.sessionDir}`);
		for (const f of m.files) {
			console.log(`  ${f.file} -> [应居] ${f.expectedDir}`);
			console.log(`     cwd=${f.cwd} (目录${f.cwdExists ? '存在' : '不存在→修好后仅标记无效,非致命'})`);
		}
	}
	if (report.conflicts.length) {
		console.log('=== 冲突明细 ===');
		for (const c of report.conflicts) {
			console.log(`\n[冲突] ${c.sessionDir}`);
			for (const f of c.files) console.log(`  ${f.file} -> ${f.expectedDir}  cwd=${f.cwd}`);
		}
	}
	if (report.readErrors.length) {
		console.log('=== 读取失败 ===');
		for (const e of report.readErrors) console.log(`  ${e.file}: ${e.error}`);
	}
	fs.writeFileSync(path.join(path.dirname(__filename), 'dsh-session-audit.json'), JSON.stringify(report, null, 2));
	console.log(`\n完整 JSON: ${path.join(path.dirname(__filename), 'dsh-session-audit.json')}`);
}

setTimeout(() => { console.error('TIMEOUT 60s'); process.exit(2); }, 60000).unref();
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
