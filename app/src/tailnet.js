'use strict';

/**
 * DS Harness Desktop — 尾网地址探测（手机访问中继的监听地址）
 *
 * 为什么需要它：中继**只绑尾网地址**（项目约定：不把监听地址改成 0.0.0.0），
 * 所以得先问出"手机够得着的那个地址"。
 *
 * 顺序：
 *   1. `tailscale status --json` → 取本机的 MagicDNS 名（*.ts.net）与 IPv4；
 *   2. tailscale 命令不可用（没装 / 不在 PATH）时，扫网卡找 100.64.0.0/10
 *      （Tailscale 用的 CGNAT 段）；
 *   3. 都没有 → 返回 null，由调用方给出人话原因（不静默失败）。
 *
 * ⚠️ 地址是会"绑 cookie"的：官方签名 cookie 与访问时用的 authority 绑定。
 * 所以**域名 ↔ IP 之间切换，手机上必须重新扫一次二维码**。基于这一点，默认优先用
 * MagicDNS 名（稳定、且与配对时的地址一致），只有连不上时才让人手动切 IP。
 */

const { execFile } = require('node:child_process');
const os = require('node:os');

const TS_TIMEOUT_MS = 5000;

/** @returns {Promise<{ip: string|null, dns: string|null, source: string}|null>} */
function tailscaleIdentity() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: TS_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        const status = JSON.parse(String(stdout));
        const ips = status && status.Self && status.Self.TailscaleIPs ? status.Self.TailscaleIPs : [];
        const ip = ips.find((x) => !String(x).includes(':')) || null;
        const dns = String((status && status.Self && status.Self.DNSName) || '').replace(/\.$/, '') || null;
        if (!ip && !dns) {
          resolve(null);
          return;
        }
        resolve({ ip, dns, source: 'tailscale' });
      } catch {
        resolve(null);
      }
    });
  });
}

/** 扫网卡找 100.64.0.0/10（Tailscale 的 CGNAT 段）；只兜底，拿不到名字。 */
function interfaceIdentity() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const parts = String(net.address).split('.').map(Number);
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
        return { ip: net.address, dns: null, source: 'interface' };
      }
    }
  }
  return null;
}

/** 拿到本机的尾网身份（域名优先用于展示/配对，IP 用于实际监听）。 */
async function resolveTailnetAddress() {
  const identity = (await tailscaleIdentity()) || interfaceIdentity();
  if (!identity) return null;
  return {
    ip: identity.ip || null,          // 监听用：必须是具体 IP
    dns: identity.dns || null,        // 配对地址优先用它
    source: identity.source,
  };
}

/**
 * 手机该访问的 host 部分：优先 MagicDNS 名（与已配对手机的 cookie 一致），
 * 传 preferIp 时改用 IPv4（MagicDNS 没开/解析不了时的逃生口）。
 */
function pickHost(address, { preferIp = false } = {}) {
  if (!address) return null;
  if (preferIp && address.ip) return address.ip;
  return address.dns || address.ip;
}

module.exports = { resolveTailnetAddress, pickHost };
