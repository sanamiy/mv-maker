// ブラウザで確認するための簡易サーバー。
// 使い方: node src/preview.mjs examples/demo/scene.json → 表示された URL を開く
// scene.json や、同じフォルダの HTML / CSS / 画像などを保存すると、開いているページが自動で読み込み直す
// （再生位置はそのまま。out/ の書き出し結果や .md などの変更では読み込み直さない）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, fsPath } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scene = path.resolve(process.argv[2] || 'examples/demo/scene.json');
const sceneDir = path.dirname(scene);

// 変更を知らせる口（Server-Sent Events）。ページはここにつないでおき、"change" が来たら読み込み直す
const clients = new Set();
const handlers = {
  'GET /__reload': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },
};
const { port } = await startServer({ port: 5173, handlers }); // 使用中なら次の番号を使う
console.log(`http://localhost:${port}${fsPath(path.join(ROOT, 'runtime/preview.html'))}?scene=${encodeURIComponent(fsPath(scene))}`);

// 見張るもの: 曲のフォルダ全体と runtime/（下の階層も）。
// scene.json がフォルダの外のファイル（assets/ の VRM や Mixamo など）を指していれば、そのファイルも見張る
const IGNORE_DIRS = new Set(['out', 'node_modules', '.git', '.venv']);
const IGNORE_EXT = new Set(['.mp4', '.mov', '.webm', '.md', '.txt', '.log', '.tmp', '.swp']);
const ignored = rel => {
  const parts = rel.split(/[\\/]/);
  const name = parts.at(-1);
  return parts.some(p => IGNORE_DIRS.has(p) || p.startsWith('.')) || name.endsWith('~') || IGNORE_EXT.has(path.extname(name).toLowerCase());
};

let timer = null;
const changed = file => {
  clearTimeout(timer); // エディタは1回の保存で何度か書くので、少し待ってまとめる
  timer = setTimeout(() => {
    console.log(`変更: ${path.relative(process.cwd(), file)} → 読み込み直します`);
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify(path.relative(sceneDir, file))}\n\n`);
    if (file === scene) watchOutside();
  }, 150);
};

// Mac / Windows は recursive がそのまま使える。Linux の recursive は、エディタがファイルを置き換えて保存すると
// そのファイルを見失うので、フォルダごとに見張り、新しくできたフォルダも足していく
function watchTree(root) {
  const onChange = rel => { if (rel && !ignored(rel)) changed(path.join(root, rel)); };
  if (process.platform !== 'linux') { fs.watch(root, { recursive: true }, (_, rel) => onChange(rel)); return; }
  const watched = new Map();
  const add = dir => {
    const rel = path.relative(root, dir);
    if (watched.has(dir) || (rel && ignored(rel))) return;
    try { watched.set(dir, fs.watch(dir, (_, name) => { if (!name) return; onChange(path.join(rel, name)); const sub = path.join(dir, name); if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) add(sub); })); } catch { return; }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) add(path.join(dir, e.name));
  };
  add(root);
}
watchTree(sceneDir);
watchTree(path.join(ROOT, 'runtime'));

// フォルダの外の参照先は、ファイルを置き換える保存（いったん消して書く）でも追えるように、親フォルダを見て名前で絞る
let outside = [];
function watchOutside() {
  for (const w of outside) w.close();
  outside = [];
  let s;
  try { s = JSON.parse(fs.readFileSync(scene, 'utf8')); } catch { return; } // 書きかけ。次の保存でやり直す
  const refs = [s.analysis, s.character?.vrm, ...(s.styles || []), ...(s.layers || []).map(l => l.src), ...(s.character?.motions || []).map(m => m.file)]
    .filter(r => typeof r === 'string' && !/^[a-z]+:/i.test(r)).map(r => path.resolve(sceneDir, r))
    .filter(f => path.relative(sceneDir, f).startsWith('..') && path.relative(path.join(ROOT, 'runtime'), f).startsWith('..'));
  const byDir = new Map();
  for (const f of refs) byDir.set(path.dirname(f), (byDir.get(path.dirname(f)) || new Set()).add(path.basename(f)));
  for (const [dir, names] of byDir) {
    if (!fs.existsSync(dir)) continue;
    outside.push(fs.watch(dir, (_, name) => { if (name && names.has(name)) changed(path.join(dir, name)); }));
  }
}
watchOutside();
