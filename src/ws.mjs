// 最小限の WebSocket 受信（ブラウザからのバイナリメッセージと、短い文字の返事だけ）。
// 書き出し時にブラウザからフレームの生ピクセルを受け取るのに使う。
// page.evaluate の戻り値（CDP）だと base64 文字列になって 1 フレーム(3.7MB)に 40ms ほど、
// fetch の POST は Chromium 内部で細かく区切られてさらに遅い。WebSocket ならそのままのバイナリで速い。
import crypto from 'node:crypto';

// route(pathname) が返した関数に、届いたメッセージを (buf, reply) で渡す。null を返せば接続を断る
export function acceptWebSocket(server, route) {
  server.on('upgrade', (req, socket) => {
    const onMessage = route(new URL(req.url, 'http://x').pathname);
    if (!onMessage) return socket.destroy();
    const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    socket.setNoDelay(true);
    const send = (op, payload = Buffer.alloc(0)) => socket.write(Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload])); // 125バイトまで

    // 届いた断片はつなげずに溜めておき、必要な長さがそろってから1回だけコピーする（大きなフレームで遅くならないように）
    let chunks = [], have = 0, parts = [];
    const take = n => {
      const out = Buffer.allocUnsafe(n);
      let o = 0;
      while (o < n) {
        const c = chunks[0], k = Math.min(c.length, n - o);
        c.copy(out, o, 0, k); o += k;
        if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
      }
      have -= n;
      return out;
    };
    const peek = n => (chunks[0].length >= n ? chunks[0] : Buffer.concat(chunks).subarray(0, n));
    socket.on('data', chunk => {
      chunks.push(chunk); have += chunk.length;
      for (;;) {
        if (have < 2) return;
        let h = peek(2), len = h[1] & 0x7f, off = 2;
        if (len === 126) { if (have < 4) return; len = peek(4).readUInt16BE(2); off = 4; }
        else if (len === 127) { if (have < 10) return; len = Number(peek(10).readBigUInt64BE(2)); off = 10; }
        if (have < off + 4 + len) return;
        const head = take(off + 4), fin = head[0] & 0x80, op = head[0] & 0x0f, mask = head.subarray(off, off + 4);
        const data = take(len);
        unmask(data, mask);
        if (op === 0x8) { send(0x8); socket.end(); return; }
        if (op === 0x9) { send(0xa, data); continue; }
        if (op === 0x2 || op === 0x0) {
          parts.push(data);
          if (fin) { const msg = parts.length === 1 ? parts[0] : Buffer.concat(parts); parts = []; onMessage(msg, text => send(0x1, Buffer.from(text))); }
        }
      }
    });
    socket.on('error', () => {});
  });
}

// 4バイトずつまとめて XOR する（1バイトずつより数倍速い）
function unmask(data, mask) {
  const n4 = data.length >>> 2;
  if (data.byteOffset % 4 === 0 && n4) {
    const w = new Uint32Array(data.buffer, data.byteOffset, n4), m = mask.readUInt32LE(0);
    for (let i = 0; i < n4; i++) w[i] ^= m;
  } else for (let i = 0; i < n4 * 4; i++) data[i] ^= mask[i & 3];
  for (let i = n4 * 4; i < data.length; i++) data[i] ^= mask[i & 3];
}
