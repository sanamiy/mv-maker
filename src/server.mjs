// ローカルファイルを http://127.0.0.1:<port>/@fs/<絶対パス> として見せる簡易サーバー（127.0.0.1 のみ）。
// preview.mjs と render.mjs で使う（render.mjs はさらに ws.mjs でフレームを受け取る）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { MIME, fsPath, fsFile } from './fsurl.mjs';
import { listenFree } from './net.mjs';

export { fsPath };

export function serveFile(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/@fs/')) { res.writeHead(404).end('not found'); return; }
  const file = fsFile(u.pathname);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
  const stat = fs.statSync(file), type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  // no-store: 保存した内容をプレビューの読み込み直しですぐ反映させるため
  if (range) { // 音声のシークに必要
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

// handlers: { 'POST /frame': (req, res, url) => ... } のように、ファイル以外の口を足せる
// port: 0 なら OS が選ぶ空きポート。番号を渡すと、使用中なら次の番号を順に試す（PORT 環境変数があればそれだけ）
export async function startServer({ port = 0, handlers = {} } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const h = handlers[`${req.method} ${u.pathname}`];
    if (h) return h(req, res, u);
    serveFile(req, res);
  });
  if (port) await listenFree(server, port);
  else await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
}
