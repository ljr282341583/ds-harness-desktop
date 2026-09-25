'use strict';

/**
 * DS Harness Desktop — 二维码 → 真·正方形 PNG（8 位灰度）
 *
 * 为什么要自己编码 PNG：不想为一个二维码再引一个第三方依赖（仓库里唯一的第三方代码
 * 是那份 MIT 的二维码编码库）。只用 node:zlib + 自算 CRC32 就够，约 50 行。
 *
 * 与 ds-harness-mobile 仓库 `tools/qr-png.mjs` 是同一套逻辑（那边给电脑终端用）。
 * 输出"方像素"图，避开终端/字体把二维码画歪的一类问题（手机端实测踩过）。
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * @param {{getModuleCount: () => number, isDark: (r: number, c: number) => boolean}} qr 已 make() 的二维码
 * @param {{scale?: number, margin?: number}} [options] scale=每模块像素，margin=静默区模块数
 * @returns {{buffer: Buffer, size: number, modules: number}}
 */
function qrToPng(qr, { scale = 10, margin = 4 } = {}) {
  const modules = qr.getModuleCount();
  const size = (modules + margin * 2) * scale;

  // 每行 = 1 字节 filter(0) + size 个灰度字节；先整块填白(0xff)
  const raw = Buffer.alloc((size + 1) * size, 0xff);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size + 1);
    raw[rowStart] = 0;
    const r = Math.floor(y / scale) - margin;
    if (r < 0 || r >= modules) continue;
    for (let x = 0; x < size; x += 1) {
      const c = Math.floor(x / scale) - margin;
      if (c < 0 || c >= modules) continue;
      if (qr.isDark(r, c)) raw[rowStart + 1 + x] = 0x00;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 0;   // 颜色类型：灰度

  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { buffer, size, modules };
}

module.exports = { qrToPng };
