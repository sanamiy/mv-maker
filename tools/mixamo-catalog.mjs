// Mixamo のモーションのカタログ（assets/mixamo/catalog.json）を更新する。
// カタログには Mixamo の動きの名前・自前のタグ・自前の解析値だけを書く（FBX 本体や Mixamo の説明文・サムネイルは入れない）。
// assets/mixamo/ に置いた FBX を解析して analysis と derived を書き込み、まだ無い動きはダウンロードしてほしい一覧として出す。
// 使い方: node tools/mixamo-catalog.mjs [--vrm assets/oomofu.vrm] [--missing] [--gl swiftshader]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toUrl, fromUrl, MIME } from '../src/fsurl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets/mixamo');
const CATALOG = path.join(DIR, 'catalog.json');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const vrmPath = path.resolve(flag('--vrm', path.join(ROOT, 'assets/oomofu.vrm')));
const gl = flag('--gl', 'swiftshader');
const onlyMissing = args.includes('--missing');

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
// ファイル名の照合: 書かれた file → 動きの名前そのまま → 大文字小文字・空白・記号を無視して一致
const norm = s => s.toLowerCase().replace(/\.fbx$/, '').replace(/[^a-z0-9]/g, '');
const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.fbx'));
const findFile = m => (m.file && files.includes(m.file) ? m.file : files.find(f => norm(f) === norm(m.mixamoName)));

const found = catalog.motions.map(m => [m, findFile(m)]);
const missing = found.filter(([, f]) => !f).map(([m]) => m);
const known = new Set(found.map(([, f]) => f).filter(Boolean));
const unknown = files.filter(f => !known.has(f));

const printMissing = () => {
  if (!missing.length) return console.log('カタログの動きはすべて assets/mixamo/ にあります');
  console.log(`\nまだ無い動き（${missing.length}個）: Mixamo で検索してダウンロードし、assets/mixamo/ に置いてください`);
  console.log('設定: Format FBX Binary(.fbx) / Skin Without Skin / Frames per Second 30 / Keyframe Reduction none（In Place の項目がある動きはチェック）');
  for (const m of missing) console.log(`  - ${m.mixamoName}`);
  console.log('ファイル名は Mixamo の初期名のままか、動きの名前（大文字小文字・空白は問わない）にしてください');
};
if (onlyMissing) { printMissing(); process.exit(0); }

const browser = await chromium.launch({ args: [`--use-angle=${gl}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('[page]', e));
await page.route('http://mv.local/**', route => {
  const file = fromUrl(route.request().url());
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
  route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] ?? 'application/octet-stream' });
});
await page.goto(toUrl(path.join(ROOT, 'tools/mixamo-catalog.html')));
await page.waitForFunction(() => window.READY);
await page.evaluate(u => window.loadVrm(u), toUrl(vrmPath));

// 解析値から機械的に決まるタグ。人が付けたタグ（tags）とは分けて持つ
const derive = a => ({
  tempoBand: a.bpm < 90 ? 'slow' : a.bpm <= 120 ? 'mid' : 'fast',
  locomotion: a.travel > 1 ? 'traveling' : a.travel > 0.25 ? 'stepping' : 'in-place',
  loopable: a.loopDeg < 8,
  turning: Math.abs(a.yawNet) > 45 || a.yawRange > 120,
  energy: Math.min(5, Math.max(1, Math.round(1 + a.strength / 0.35))),
  mainParts: Object.entries(a.bodyShare).filter(([, s]) => s >= 0.25).map(([g]) => g),
});

for (const [m, file] of found) {
  if (!file) continue;
  process.stdout.write(`${m.id} (${file}) ... `);
  try {
    m.file = file;
    m.analysis = await page.evaluate(u => window.analyze(u), toUrl(path.join(DIR, file)));
    m.derived = derive(m.analysis);
    console.log(`${m.analysis.bpm} BPM, ${m.analysis.beats}拍, 強さ ${m.analysis.strength}, 移動 ${m.analysis.travel}m`);
  } catch (e) { console.log(`失敗: ${e.message}`); }
}
await browser.close();

catalog.analyzedWith = { vrm: path.basename(vrmPath), date: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
console.log(`\n${path.relative(ROOT, CATALOG)} を更新しました（解析 ${found.filter(([, f]) => f).length} / ${catalog.motions.length}）`);
if (unknown.length) console.log(`カタログに無い FBX: ${unknown.join(', ')}（catalog.json の motions に足すとタグ付けと解析の対象になります）`);
printMissing();
