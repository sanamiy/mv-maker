// 動きのライブラリ（open-vrma）から、条件で探す・取ってくる・クレジットを出す。
// 使い方:
//   node src/motions.mjs search --section chorus --energy 4-5 --bpm 128 --facing front --license cc0,cc-by,cmu
//   node src/motions.mjs show <id>             メタデータ（Motion Meta）を表示
//   node src/motions.mjs pull <id> [...]       open-vrma の VRMA とメタデータを assets/open-vrma/ に取ってくる
//   node src/motions.mjs pull --scene songs/<名前>   scene.json で使っている動きをまとめて取ってくる
//   node src/motions.mjs update                open-vrma の一覧（catalog.jsonl）を取り直す
//   node src/motions.mjs credits songs/<名前>  scene.json で使っている動きのクレジット文
// render / stills / preview は、scene.json で使っている動きが手元に無ければ始める前に自動で取ってくる（ensureSceneMotions）
// search のほかの条件: --kind --genre --mood --bodyParts --locomotion --loop --in-place
//   --after <id>（直前の動き。姿勢がつながるものを上に）--text <語> --max-duration 秒 --limit 件数 --json
// open-vrma の取得元は OPEN_VRMA_REPO（既定 Sanami/open-vrma）。非公開のあいだは HF_TOKEN が要る
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLibrary, search } from '../runtime/library.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPEN_VRMA_DIR = path.join(ROOT, 'assets/open-vrma');
const REPO = process.env.OPEN_VRMA_REPO ?? 'Sanami/open-vrma';
const hfUrl = file => `https://huggingface.co/datasets/${REPO}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;

const readText = async u => fs.readFileSync(fileURLToPath(u), 'utf8');
const dirUrl = d => pathToFileURL(d).href + '/';

// scene.json の motionLibraries（scene.json からの相対パス）か、既定の assets/open-vrma/
export function libraryDirs(scene, sceneDir) {
  if (scene?.motionLibraries) return scene.motionLibraries.map(p => ({ url: dirUrl(path.resolve(sceneDir, p)) }));
  return [{ url: dirUrl(OPEN_VRMA_DIR), name: 'open-vrma' }];
}
export const openLibrary = (scene, sceneDir) => loadLibrary(libraryDirs(scene, sceneDir), readText);

async function download(file, dest) {
  const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const res = await fetch(hfUrl(file), { headers });
  if (!res.ok) throw new Error(`${file} を取得できません（HTTP ${res.status}）${res.status === 401 || res.status === 404 ? '。非公開なら HF_TOKEN を設定する' : ''}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function update() {
  await download('catalog.jsonl', path.join(OPEN_VRMA_DIR, 'catalog.jsonl'));
  const n = fs.readFileSync(path.join(OPEN_VRMA_DIR, 'catalog.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  console.log(`open-vrma の一覧を更新しました（${n} 本、${REPO}）`);
}

// scene.json から、id で指定した動き（{ "use": "clip", "motion": "<id>" }）を集める
export function sceneMotionIds(scene) {
  return [...new Set((scene.character?.motions ?? []).filter(m => m.use === 'clip' && m.motion).map(m => m.motion))];
}
const readScene = p => { const f = fs.statSync(p).isDirectory() ? path.join(p, 'scene.json') : p; return { scene: JSON.parse(fs.readFileSync(f, 'utf8')), dir: path.dirname(path.resolve(f)) }; };

// scene.json で id 指定した動きのうち、手元に無いものを取ってくる。motionLibraries で別の一覧を使うときは何もしない
// 取れなかったものは警告だけ出す（読み込みのときに、取ってくる方法つきのエラーになる）
export async function ensureSceneMotions(scenePath) {
  const { scene } = readScene(scenePath);
  const ids = sceneMotionIds(scene);
  if (!ids.length || scene.motionLibraries) return;
  const catalog = path.join(OPEN_VRMA_DIR, 'catalog.jsonl');
  const lib = fs.existsSync(catalog) ? await loadLibrary([{ url: dirUrl(OPEN_VRMA_DIR) }], readText) : null;
  const missing = ids.filter(id => { const r = lib?.find(id); return !r || !fs.existsSync(path.join(OPEN_VRMA_DIR, r.file)); });
  if (!missing.length) return;
  console.log(`手元に無い動きを取ってきます: ${missing.join(', ')}`);
  try {
    if (missing.some(id => !lib?.find(id))) await update();
    await pull(missing);
  } catch (e) { console.error(`動きを取ってこられませんでした: ${e.message}`); }
}

async function pull(ids) {
  const lib = await loadLibrary([{ url: dirUrl(OPEN_VRMA_DIR), name: 'open-vrma' }], readText);
  for (const id of ids) {
    const row = lib.find(id);
    if (!row) { console.error(`${id}: open-vrma の一覧にありません`); process.exitCode = 1; continue; }
    const dest = path.join(OPEN_VRMA_DIR, row.file);
    if (fs.existsSync(dest)) { console.log(`${id}: もうあります（${path.relative(ROOT, dest)}）`); continue; }
    await download(row.file, dest);
    await download(row.file.replace(/\.vrma$/i, '.motion.json'), dest.replace(/\.vrma$/i, '.motion.json'));
    console.log(`${id}: ${path.relative(ROOT, dest)}`);
  }
}

const pad = (s, n) => { s = String(s ?? ''); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)); };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next == null || next.startsWith('--')) opts[key] = true; else { opts[key] = next; i++; }
  }
  if (cmd === 'update') return update();
  if (cmd === 'pull') {
    const ids = opts.scene ? sceneMotionIds(readScene(opts.scene).scene) : pos;
    if (!fs.existsSync(path.join(OPEN_VRMA_DIR, 'catalog.jsonl'))) await update();
    return pull(ids);
  }
  const { scene, dir } = opts.scene ? readScene(opts.scene) : cmd === 'credits' && pos[0] ? readScene(pos[0]) : { scene: null, dir: ROOT };
  if (cmd === 'search' && !scene?.motionLibraries && !fs.existsSync(path.join(OPEN_VRMA_DIR, 'catalog.jsonl'))) {
    try { await update(); } catch (e) { console.error(`open-vrma の一覧を取れませんでした: ${e.message}`); }
  }
  const lib = await openLibrary(scene, dir);
  if (cmd === 'show') {
    const meta = await lib.meta(pos[0]);
    const row = lib.find(pos[0]);
    if (!row) { console.error(`${pos[0]} はありません`); process.exit(1); }
    console.log(JSON.stringify(meta ?? row, null, 1));
    if (!meta) console.log(`（メタデータの本体はまだ手元にありません。node src/motions.mjs pull ${pos[0]}）`);
    return;
  }
  if (cmd === 'credits') {
    const ids = sceneMotionIds(scene);
    const lines = new Set();
    for (const id of ids) { const r = lib.find(id); if (r?.attribution) lines.add(r.attribution); else console.error(`${id}: クレジットが見つかりません`); }
    console.log([...lines].join('\n'));
    return;
  }
  if (cmd !== 'search') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 1 : 0); }

  const found = search(lib, opts);
  const limit = Number(opts.limit ?? 20);
  if (opts.json) { console.log(JSON.stringify(found.slice(0, limit), null, 1)); return; }
  for (const s of lib.sources) if (s.missing) console.error(`（一覧がありません: ${fileURLToPath(s.url)}）`);
  console.log(`${found.length} 本見つかりました${found.length > limit ? `（上位 ${limit} 本）` : ''}`);
  const head = ['id', 'kind', 'genre', '強さ', 'BPM', opts.bpm ? '速度' : null, 'ループ', '向き', '移動', '秒', 'ライセンス'].filter(Boolean);
  const W = [30, 9, 14, 4, 6, opts.bpm ? 9 : null, 6, 8, 10, 6, 22].filter(Boolean);
  console.log(head.map((h, i) => pad(h, W[i])).join(' '));
  for (const r of found.slice(0, limit)) {
    const cells = [r.id, r.kind, [].concat(r.genre ?? []).join(','), r.energy, r.bpm ? Math.round(r.bpm) : '-', opts.bpm ? (r.fit ? `×${r.fit.rate}${r.fit.songBeatsPerMotionBeat !== 1 ? `(${r.fit.songBeatsPerMotionBeat}拍)` : ''}` : '-') : null,
      r.loopable ? (r.loopBeats ? `${r.loopBeats}拍` : 'する') : '-', r.facing ?? '', r.locomotion ?? '', r.duration?.toFixed(1), r.license].filter(c => c !== null);
    console.log(cells.map((c, i) => pad(c, W[i])).join(' '));
  }
  if (found.length) console.log(`\nscene.json には { "use": "clip", "motion": "${found[0].id}" } のように書きます`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
