// 1曲ぶんを点検し、<フォルダ>/out/qa.md（点検結果と目視チェックリスト）と out/contact.png（要所のコマ一覧）を作る。
// 使い方: node src/check.mjs songs/<名前> [--video out/test.mp4]
// エラーがあれば終了コード 1。目視の項目はエージェント（か人）が contact.png と動画を見て埋める。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSections } from '../runtime/timeline.js';
import { parseTime } from '../runtime/layers.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const videoArg = flag('--video');
const target = path.resolve(args[0] ?? '.');
const scenePath = fs.statSync(target).isDirectory() ? path.join(target, 'scene.json') : target;
const dir = path.dirname(scenePath);
const outDir = path.join(dir, 'out');
fs.mkdirSync(outDir, { recursive: true });

const errors = [], warnings = [], notes = [];
const at = p => path.resolve(dir, p);
const exists = p => fs.existsSync(at(p));
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const probe = file => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};

// ---- scene.json と素材 ----
let scene;
try { scene = JSON.parse(fs.readFileSync(scenePath, 'utf8')); } catch (e) { console.error(`scene.json を読めません: ${e.message}`); process.exit(1); }
if (!scene.audio || !exists(scene.audio)) errors.push(`曲が見つかりません: ${scene.audio}`);
if (scene.character?.vrm && !exists(scene.character.vrm)) errors.push(`VRM が見つかりません: ${scene.character.vrm}`);
for (const l of scene.layers ?? []) if (!exists(l.src)) errors.push(`レイヤーが見つかりません: ${l.src}`);
for (const s of scene.styles ?? []) if (!exists(s)) errors.push(`CSS が見つかりません: ${s}`);

let analysis = null;
if (!scene.analysis || !exists(scene.analysis)) errors.push(`analysis.json がありません（node src/analyze.mjs ${scene.audio} ${scene.analysis ?? 'analysis.json'}）`);
else analysis = JSON.parse(fs.readFileSync(at(scene.analysis), 'utf8'));

const audioInfo = scene.audio && exists(scene.audio) ? probe(at(scene.audio)) : null;
const audioDur = audioInfo ? Number(audioInfo.format.duration) : null;
if (analysis && audioDur && Math.abs(analysis.duration - audioDur) > 0.5) errors.push(`analysis.json が曲と合っていません（解析 ${analysis.duration}s / 曲 ${audioDur.toFixed(2)}s）。曲を差し替えたら解析し直す`);
if (analysis) notes.push(`テンポ ${analysis.tempo} BPM、拍 ${analysis.beats.length} 個、長さ ${fmt(analysis.duration)}`);

// ---- セクション ----
let sections = [];
if (analysis) {
  sections = buildSections(scene, analysis);
  if (Array.isArray(scene.sections)) {
    const names = scene.sections.map(s => s.name);
    if (names.some(n => !n || !/^[\w-]+$/.test(n))) errors.push('セクション名は英数字・-・_ だけにする（texts.html の data-start から名前で参照するため）');
    if (scene.sections.some((s, i) => i && s.from <= scene.sections[i - 1].from)) errors.push('sections の from が時刻順になっていません');
    if (sections[0]?.from > 0.05) warnings.push(`最初のセクションが ${sections[0].from}s から始まっています（0 から始めると安全）`);
    if (/^(low|mid|high)\d+$/.test(names.join(' ').split(' ')[0] ?? '') && names.every(n => /^(low|mid|high)\d+$/.test(n))) warnings.push('セクション名が仮の名前（low1 / high1 …）のままです。intro / verse / chorus などに直す');
  }
  for (const s of sections) {
    if (s.from <= 0.05) continue;
    const near = analysis.downbeats.reduce((b, d) => (Math.abs(d - s.from) < Math.abs(b - s.from) ? d : b), Infinity);
    if (Math.abs(near - s.from) > 0.12) warnings.push(`セクション「${s.name}」(${s.from}s) が小節の頭からずれています。近い小節頭は ${near}s`);
  }
  notes.push(`セクション: ${sections.map(s => `${fmt(s.from)} ${s.name}（energy ${s.energy ?? 1}）`).join(' / ')}`);
}

// ---- 文字・図（data-start / data-end を持つ要素） ----
const timed = [];
if (analysis) {
  const ctx = { analysis, sections, duration: scene.duration ?? analysis.duration };
  for (const l of scene.layers ?? []) {
    if (!exists(l.src)) continue;
    const html = fs.readFileSync(at(l.src), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/<(\w+)([^>]*\sdata-(?:start|end)=[^>]*)>([^<]*)/g)) {
      const attr = n => m[2].match(new RegExp(`\\s${n}="([^"]*)"`))?.[1];
      const cls = attr('class') ?? '', label = (m[3].trim() || `<${m[1]} class="${cls}">`).slice(0, 24);
      try {
        const start = parseTime(attr('data-start'), ctx) ?? 0;
        const end = parseTime(attr('data-end'), ctx, start) ?? ctx.duration;
        if (start >= ctx.duration) errors.push(`${l.src}: 「${label}」の開始 ${start.toFixed(2)}s が曲の長さを超えています`);
        if (end <= start) errors.push(`${l.src}: 「${label}」の終わり (${end.toFixed(2)}s) が開始 (${start.toFixed(2)}s) より前です`);
        timed.push({ layer: l.src, cls, label, start, end });
      } catch (e) { errors.push(`${l.src}: 「${label}」の時刻を読めません: ${e.message}`); }
    }
    for (const m of html.matchAll(/<(?:img|image|source)\s[^>]*(?:src|href)="([^"]+)"/g)) if (!/^(data:|https?:)/.test(m[1]) && !exists(path.join(path.dirname(l.src), m[1]))) errors.push(`${l.src}: 画像が見つかりません: ${m[1]}`);
    if (/(src|href)="https?:/.test(html)) errors.push(`${l.src}: 外部URLの画像は読み込めません。ファイルを songs/<名前>/images/ に置く`);
  }
  // 同じクラスの文字が同時に出ていると重なって読めない
  const byClass = {};
  for (const t of timed) for (const c of t.cls.split(/\s+/).filter(c => /^(lyric|title|caption|credit)/.test(c))) (byClass[c] ??= []).push(t);
  for (const [c, list] of Object.entries(byClass)) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].end - 0.05) warnings.push(`.${c} が重なっています: 「${list[i - 1].label}」(〜${list[i - 1].end.toFixed(2)}s) と「${list[i].label}」(${list[i].start.toFixed(2)}s〜)`);
  }
  notes.push(`時刻付きの文字・図: ${timed.length} 個`);
}

// ---- 書き出した動画 ----
const pickVideo = () => {
  if (videoArg) return path.resolve(videoArg);
  if (fs.existsSync(path.join(outDir, 'final.mp4'))) return path.join(outDir, 'final.mp4');
  const mp4s = fs.readdirSync(outDir).filter(f => f.endsWith('.mp4')).map(f => path.join(outDir, f));
  return mp4s.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
};
const video = pickVideo();
let contact = null;
if (!video || !fs.existsSync(video)) warnings.push('書き出した動画がまだありません。node src/render.mjs で out/ に書き出してから点検し直す（コマ一覧が作られます）');
else {
  const v = probe(video), vs = v?.streams.find(s => s.codec_type === 'video'), hasAudio = v?.streams.some(s => s.codec_type === 'audio');
  const vDur = Number(v?.format.duration ?? 0);
  notes.push(`動画: ${path.relative(dir, video)}（${vs?.width}x${vs?.height}、${vDur.toFixed(2)}s、音声${hasAudio ? 'あり' : 'なし'}）`);
  if (!hasAudio) errors.push('動画に音声が入っていません');
  const full = audioDur && vDur > audioDur - 0.5;
  if (!full) warnings.push(`動画が曲の途中までです（${vDur.toFixed(1)}s / ${audioDur?.toFixed(1)}s）。試し書きなら問題なし、完成版は最後まで書き出す`);

  // 要所のコマ: 各セクションの頭と中ほど、各文字が出た直後
  let times = [];
  sections.forEach((s, i) => {
    const end = sections[i + 1]?.from ?? analysis.duration;
    times.push({ t: s.from + Math.min(0.8, (end - s.from) / 2), label: `${s.name} の頭` }, { t: (s.from + end) / 2, label: `${s.name} の中ほど` });
  });
  for (const t of timed) times.push({ t: Math.min(t.start + 0.6, (t.start + t.end) / 2), label: `「${t.label}」` });
  times = times.filter(x => x.t < vDur - 0.05).sort((a, b) => a.t - b.t).filter((x, i, a) => !i || x.t - a[i - 1].t > 0.4);
  if (times.length > 24) times = times.filter((_, i) => i % Math.ceil(times.length / 24) === 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-check-'));
  const cells = [];
  times.forEach((x, i) => {
    const png = path.join(tmp, `${i}.png`);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(x.t), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', png]);
    if (fs.existsSync(png)) cells.push({ ...x, src: 'data:image/png;base64,' + fs.readFileSync(png).toString('base64') });
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (cells.length) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111;color:#eee;font:14px sans-serif;width:1500px}
      .g{display:grid;grid-template-columns:repeat(3,480px);gap:12px;padding:12px}figure{margin:0}img{width:480px;display:block}figcaption{padding:4px 2px}</style>
      <div class="g">${cells.map(c => `<figure><img src="${c.src}"><figcaption>${fmt(c.t)}　${esc(c.label)}</figcaption></figure>`).join('')}</div>`;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 400 } });
    await page.setContent(html);
    contact = path.join(outDir, 'contact.png');
    await page.screenshot({ path: contact, fullPage: true });
    await browser.close();
  }
}

// ---- 結果 ----
const list = a => (a.length ? a.map(x => `- ${x}`).join('\n') : '- なし');
const report = `# 点検結果: ${path.basename(dir)}

点検日時: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}（node src/check.mjs で自動生成。目視の欄だけ手で埋める）

## 自動チェック

### エラー（直すまで完成にしない）
${list(errors)}

### 注意
${list(warnings)}

### 概要
${list(notes)}

## 目視チェック（${contact ? 'out/contact.png' : 'コマ一覧はまだ無い'} と動画を見て埋める）
- [ ] 文字が読める（小さすぎない・切れていない・背景に埋もれていない）
- [ ] 文字や図がキャラの顔に重なっていない
- [ ] セクションごとに見た目が変わり、サビが一番盛り上がって見える
- [ ] 表情がセクションに合っている（サビで笑顔など brief.md のとおり）
- [ ] brief.md の「見せ場」がすべて入っている
- [ ] 動画を再生して、動きが拍に、歌詞が歌に合っている（音は人が聞いて確認する）

## メモ
`;
fs.writeFileSync(path.join(outDir, 'qa.md'), report);
console.log(`errors: ${errors.length}, warnings: ${warnings.length}`);
for (const e of errors) console.log(`  ERROR ${e}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
console.log(`report: ${path.relative(process.cwd(), path.join(outDir, 'qa.md'))}${contact ? `\ncontact sheet: ${path.relative(process.cwd(), contact)}` : ''}`);
process.exit(errors.length ? 1 : 0);
