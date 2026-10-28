// 1曲ぶんの作業フォルダを songs/<名前>/ に作る。曲ごとにフォルダが分かれるので、複数の曲を並行で作れる。
// 使い方: node src/new-song.mjs <名前> [--audio song.mp3] [--vrm assets/model.vrm] [--title "曲名"] [--credit "Music: ..."] [--dir songs]
// 曲を渡すとフォルダにコピーして解析し、解析結果の盛り上がり区間からセクションの下書きを作る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, decode } from './analyze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const audio = flag('--audio');
const title = flag('--title');
const credit = flag('--credit', '');
const parent = path.resolve(flag('--dir', path.join(ROOT, 'songs')));
let vrm = flag('--vrm');
const [name] = args;
if (!name || !/^[\w.-]+$/.test(name)) {
  console.error('usage: node src/new-song.mjs <名前（英数字・-・_）> [--audio song.mp3] [--vrm model.vrm] [--title 曲名] [--credit クレジット]');
  process.exit(1);
}
const dir = path.join(parent, name);
if (fs.existsSync(dir)) { console.error(`already exists: ${dir}`); process.exit(1); }
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
fs.mkdirSync(path.join(dir, 'images'), { recursive: true });

const rel = p => path.relative(dir, path.resolve(p)).split(path.sep).join('/');
if (!vrm && fs.existsSync(path.join(ROOT, 'assets/test.vrm'))) vrm = path.join(ROOT, 'assets/test.vrm');

// 曲をコピーして解析する
let audioName = null, analysis = null;
if (audio) {
  audioName = 'song' + path.extname(audio).toLowerCase();
  fs.copyFileSync(audio, path.join(dir, audioName));
  analysis = analyze(decode(path.join(dir, audioName)));
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(analysis));
}

// 盛り上がり区間 → セクションの下書き。名前は仮（low1 / mid1 / high1 …）なので、曲を聴いて intro / verse / chorus などに直す
const PRESET = {
  low: { energy: 0.4, expression: { relaxed: 0.5 } },
  mid: { energy: 0.8, expression: {} },
  high: { energy: 1.3, expression: { happy: 1 } },
};
const count = {};
const sections = analysis
  ? analysis.segments.map(s => ({ from: s.start, name: `${s.level}${(count[s.level] = (count[s.level] ?? 0) + 1)}`, ...PRESET[s.level] }))
  : [{ from: 0, name: 'intro', ...PRESET.low }];

const scene = {
  width: 1280, height: 720, fps: 30,
  audio: audioName ?? 'song.mp3',
  analysis: 'analysis.json',
  layers: [{ src: 'background.html', place: 'back' }, { src: 'texts.html', place: 'front' }],
  styles: ['style.css'],
  camera: { position: [0, 1.3, 2.6], target: [0, 1.05, 0], fov: 30, beatZoom: 0.04, orbit: 0.3 },
  character: {
    ...(vrm ? { vrm: rel(vrm) } : {}),
    motions: [
      { use: 'idle' },
      { use: 'bounce', amount: 0.03 },
      { use: 'sway', amount: 0.07 },
      { use: 'headNod', amount: 0.12 },
      { use: 'armSwing', amount: 0.45 },
      { use: 'blink' },
    ],
  },
  sections,
};
fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(scene, null, 2) + '\n');

// ひな形をコピーして差し込む
const fill = s => s
  .replaceAll('{{name}}', name)
  .replaceAll('{{title}}', title ?? name)
  .replaceAll('{{credit}}', credit)
  .replaceAll('{{vrm}}', vrm ? rel(vrm) : '未定')
  .replaceAll('{{analysis}}', analysis
    ? `${analysis.tempo} BPM / ${analysis.duration} 秒 / 区間 ${analysis.segments.map(s => `${s.start}s ${s.level}`).join(', ')}`
    : '未解析（曲を置いてから node src/analyze.mjs で作る）');
const tpl = path.join(ROOT, 'templates/song');
for (const f of fs.readdirSync(tpl)) fs.writeFileSync(path.join(dir, f), fill(fs.readFileSync(path.join(tpl, f), 'utf8')));

console.log(`created ${path.relative(process.cwd(), dir) || dir}/`);
if (analysis) console.log(`  tempo ${analysis.tempo} BPM, ${analysis.duration}s, sections: ${sections.map(s => `${s.from}s ${s.name}`).join(' / ')}`);
else console.log('  曲がまだありません。曲を置いて node src/analyze.mjs <曲> <フォルダ>/analysis.json を実行し、scene.json の audio を直してください');
console.log('次: brief.md を埋める → scene.json のセクション名と表情を直す → texts.html / style.css を書く → node src/check.mjs で点検');
