'use strict';

/**
 * DS Harness Desktop — 手机访问中继（运行在 Electron 主进程内）
 *
 * 作用：把"手机够得着的尾网地址"接到本机回环上的 dsh web（127.0.0.1:<dshPort>）。
 * 因为跑在主进程里，它天然随桌面端生死：App 退出 → 服务器随之关闭，不会留下孤儿进程。
 *
 * 为什么要改写 Host / Origin：dsh 的 /api 有一道信任围栏，只认三种 Host —— 回环、
 * 绑 0.0.0.0 时自动纳入的网卡 IP、或 --trusted-host 声明的地址；并且要求 Origin 的
 * host 等于 Host。桌面端启动 dsh 时只传了 --port，所以它只认回环；中继把这两个头
 * 改写成回环即可穿过围栏。**认证仍然由官方令牌 + 30 天 cookie 负责**，这里不持有
 * 任何凭据、也不放宽任何鉴权。
 *
 * 与 ds-harness-mobile 仓库 `tools/dsh-mobile-relay.mjs` 的关系：那是同一套转发规则的
 * **独立版本**（没装桌面端时在电脑上用）。改这里的规则时，那边要同步改，反之亦然。
 *
 * 两条用血换来的硬约束（手机端实测踩过，别删）：
 *   1. 客户端断开是常态（刷新 / 切后台 / 锁屏）：任何一侧报错都只能收拾这一条连接，
 *      **绝不能让整个进程倒下**（当年的表现是"外壳还在、数据全空"）。
 *   2. 未认证的 WebSocket 升级（cookie 过期 → 上游 401）必须把响应**原样回给客户端**，
 *      否则浏览器会一直等握手响应，表现为"无限转圈"且看不出原因。
 */

const http = require('node:http');

/**
 * @param {object} options
 * @param {string} options.listenHost 监听地址（手机要能到这个地址；本项目只绑尾网地址）
 * @param {number} options.listenPort 监听端口
 * @param {string} options.target     转发目标，形如 127.0.0.1:3080
 * @param {(msg: string) => void} [options.log]
 * @param {(info: object) => void} [options.onRequest] 请求日志（只记事实，绝不记 cookie 内容）
 * @returns {Promise<{port: number, host: string, close: () => Promise<void>}>}
 */
function startMobileRelay({ listenHost, listenPort, target, log = () => {}, onRequest = () => {} }) {
  const [targetHost, targetPortRaw] = String(target).split(':');
  const targetPort = Number(targetPortRaw);
  if (!targetHost || !Number.isInteger(targetPort)) {
    return Promise.reject(new Error(`转发目标写错了：${target}（应形如 127.0.0.1:3080）`));
  }
  const targetOrigin = `http://${target}`;

  /** 只取"判断谁拒了客户端"所需的事实；cookie 只记有没有、不记内容。 */
  const describe = (req) => {
    const cookie = req.headers.cookie ?? '';
    return {
      method: req.method,
      path: String(req.url ?? '/').split('?')[0],
      host: req.headers.host,
      origin: req.headers.origin,
      cookieHasAuth: cookie.includes('dsh-auth-'),
    };
  };

  /** 把请求头改写成"看起来来自本机回环"，其余原样透传。 */
  const rewriteHeaders = (headers) => {
    const out = { ...headers };
    out.host = target;
    if (out.origin !== undefined) out.origin = targetOrigin;
    if (out.referer !== undefined) out.referer = `${targetOrigin}/`;
    return out;
  };

  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers: rewriteHeaders(req.headers) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`[中继] 连不上本机 DSH（${target}）：${error.message}\n电脑上的 DSH 还在跑吗？`);
      } else {
        res.end();
      }
    });
    // 硬约束 1：任何一侧出错都只收拾这一条连接
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    res.on('finish', () => onRequest({ kind: 'http', ...describe(req), status: res.statusCode }));
    req.pipe(upstream);
  });

  // 畸形请求不该掀翻进程
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  // 协议升级透传：实时通道 /api/remote.mux 是 WebSocket
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const info = describe(req);
    const upstream = http.request({
      host: targetHost, port: targetPort, method: req.method, path: req.url, headers: rewriteHeaders(req.headers),
    });

    upstream.on('upgrade', (up, upSocket, upHead) => {
      upSocket.on('error', () => { socket.destroy(); upSocket.destroy(); });
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      const lines = Object.entries(up.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      onRequest({ kind: 'ws', ...info, status: 101 });
    });

    // 硬约束 2：上游拒绝了升级（例如 cookie 过期 → 401）必须原样回给客户端
    upstream.on('response', (up) => {
      socket.on('close', () => up.destroy());
      const lines = Object.entries(up.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      if (socket.writable) socket.write(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\n${lines}\r\n\r\n`);
      up.pipe(socket);
      up.on('end', () => { if (socket.writable) socket.end(); else socket.destroy(); });
      onRequest({ kind: 'ws', ...describe(req), status: up.statusCode });
    });

    upstream.on('error', () => socket.destroy());
    if (head && head.length) upstream.write(head);
    upstream.end();
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.on('error', (error) => log(`[中继] 服务器错误（已忽略，不影响转发）：${error.message}`));
      const port = server.address()?.port ?? listenPort;
      log(`[中继] 已就绪：${listenHost}:${port} -> ${target}`);
      resolve({
        port,
        host: listenHost,
        close: () => new Promise((done) => {
          try {
            server.close(() => done());
          } catch {
            done();
          }
          // close() 只停止接受新连接；长连接（WebSocket）会让它一直等，所以兜个超时
          setTimeout(done, 500);
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, listenHost);
  });
}

module.exports = { startMobileRelay };
