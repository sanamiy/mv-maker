// 曲を聴きながらキーを叩いて、歌詞の各行の時刻を LRC に打ち込むツール。
// 自動の時刻合わせ（tools/align_lyrics.py）がずれた所の手直しにも使える（既存の LRC / lyrics.json を読み込んで微調整できる）。
// 使い方: node src/tap.mjs song.mp3 lyrics.txt [-o song.lrc] [--from lyrics.json] → 表示された URL を開く
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME } from './fsurl.mjs';
import { parseLrc } from './lyrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < argv.length; i++) argv[i].startsWith('-') ? (opt[argv[i].replace(/^-+/, '')] = argv[++i]) : pos.push(argv[i]);
const [audio, lyricsTxt] = pos;
if (!audio || !lyricsTxt) { console.log('使い方: node src/tap.mjs song.mp3 lyrics.txt [-o song.lrc] [--from lyrics.json]'); process.exit(1); }
const out = path.resolve(opt.o || lyricsTxt.replace(/\.[^.]+$/, '') + '.lrc');

const items = [];
for (const raw of fs.readFileSync(lyricsTxt, 'utf8').split(/\r?\n/)) {
  const s = raw.trim(); if (!s) continue;
  const tag = s.match(/^\[([^\]]+)\]$/);
  items.push(tag ? { tag: tag[1] } : { text: s });
}
// 既存の時刻（--from の lyrics.json、無ければ出力先の LRC）を行の順に当てはめる
function initialTimes() {
  if (opt.from) return JSON.parse(fs.readFileSync(opt.from, 'utf8')).lines.map(l => ({ start: l.start, end: l.end }));
  if (!fs.existsSync(out)) return [];
  const { tokens } = parseLrc(fs.readFileSync(out, 'utf8'));
  // parseLrc は行の終わりを次の行の頭（または空行の印）にするので、次の行と繋がっているものは end 無しに戻す
  return tokens.map((t, i) => ({ start: t.start, end: t.open || (tokens[i + 1] && Math.abs(tokens[i + 1].start - t.end) < 1e-3) ? null : t.end }));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(ROOT, 'tools/tap.html')).pipe(res); return; }
  if (u.pathname === '/data') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items, times: initialTimes() })); return; }
  if (u.pathname === '/save' && req.method === 'POST') {
    let body = ''; req.setEncoding('utf8');
    req.on('data', c => (body += c)).on('end', () => { fs.writeFileSync(out, body); console.log(`saved ${out}`); res.writeHead(200).end(path.basename(out)); });
    return;
  }
  if (u.pathname === '/audio') {
    const ext = path.extname(audio).toLowerCase();
    const stat = fs.statSync(audio), type = MIME[ext] ?? { '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' }[ext] ?? 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(audio, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(audio).pipe(res);
    }
    return;
  }
  res.writeHead(404).end('not found');
}).listen(Number(process.env.PORT || 5174), '127.0.0.1', function () {
  console.log(`http://localhost:${this.address().port}/   （保存先: ${out}）`);
});
