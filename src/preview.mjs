// ブラウザで確認するための簡易サーバー。
// 使い方: node src/preview.mjs examples/demo/scene.json → 表示された URL を開く
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME } from './fsurl.mjs';
import { listenFree } from './net.mjs';
import { ensureSceneMotions } from './motions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scene = path.resolve(process.argv[2] || 'examples/demo/scene.json');
await ensureSceneMotions(scene);
const fsUrl = p => '/@fs' + p.split(path.sep).map(encodeURIComponent).join('/');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = decodeURIComponent(u.pathname.replace(/^\/@fs/, ''));
  if (!u.pathname.startsWith('/@fs/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
  const stat = fs.statSync(file), type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) { // 音声のシークに必要
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
});
const port = await listenFree(server, 5173);
console.log(`http://localhost:${port}${fsUrl(path.join(ROOT, 'runtime/preview.html'))}?scene=${encodeURIComponent(fsUrl(scene))}`);
