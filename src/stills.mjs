// 静止画の一覧（コンタクトシート）を作る。書き出し前に全体の絵づくりを一目で確かめるためのもの。
// 各時刻の少し前から数フレーム描いてから撮る（揺れものを落ち着かせるため。本番と完全には同じにならない）。
// 使い方:
//   node src/stills.mjs my/scene.json out/sheet.png                      # 4秒ごと
//   node src/stills.mjs my/scene.json out/sheet.png --every 2 --from 30 --to 60
//   node src/stills.mjs my/scene.json out/sheet.png --times 1.5,20,chorus#2
// オプション: --cols 5  --scale 0.3（1枚の大きさ）  --gl metal（GPU を使う）
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toUrl, fromUrl, MIME } from './fsurl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const every = Number(flag('--every', 4)), from = Number(flag('--from', 0)), to = flag('--to', null);
const times = flag('--times', null), cols = Number(flag('--cols', 5)), scale = Number(flag('--scale', 0.3));
const gl = flag('--gl', 'swiftshader');
const [scenePath, outPath = 'out/stills.png'] = args;
if (!scenePath) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport')[0].replace(/^\/\/ ?/gm, '')); process.exit(1); }

const browser = await chromium.launch({ args: [`--use-angle=${gl}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('[page]', e));
await page.route('http://mv.local/**', route => {
  const file = fromUrl(route.request().url());
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
  route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] ?? 'application/octet-stream' });
});
await page.goto(toUrl(path.join(ROOT, 'runtime/index.html')));
await page.waitForFunction(() => window.MV_READY);
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const W = Math.round((scene.width ?? 1280) * scale / 2) * 2, H = Math.round((scene.height ?? 720) * scale / 2) * 2;
await page.evaluate(([u, w, h]) => window.MV.load(u, { width: w, height: h }), [toUrl(scenePath), W, H]);

const png = await page.evaluate(async ([spec, every, from, to, cols]) => {
  const { parseTime } = await import('./layers.js');
  const mv = window.MV, ctx = { analysis: mv.analysis, sections: mv.sections, duration: mv.duration };
  const end = to != null ? Number(to) : mv.duration;
  const list = spec ? spec.split(',').map(s => parseTime(s.trim(), ctx)) : [];
  if (!spec) for (let t = from; t < end; t += every) list.push(t);
  const rows = Math.ceil(list.length / cols), pad = 4, label = 18;
  const sheet = Object.assign(document.createElement('canvas'), { width: cols * (mv.width + pad) + pad, height: rows * (mv.height + pad + label) + pad });
  const g = sheet.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = '13px monospace'; g.textBaseline = 'top';
  const src = document.getElementById('mv');
  for (let k = 0; k < list.length; k++) {
    const i = Math.min(mv.frameCount - 1, Math.round(list[k] * mv.fps));
    mv.jump(Math.max(0, i - 8));
    let m;
    while (mv.next <= i) m = await mv.frame(mv.next);
    const x = pad + (k % cols) * (mv.width + pad), y = pad + Math.floor(k / cols) * (mv.height + pad + label);
    g.drawImage(src, x, y + label);
    g.fillStyle = '#ddd';
    const mm = Math.floor(list[k] / 60), ss = (list[k] % 60).toFixed(1).padStart(4, '0');
    g.fillText(`${mm}:${ss}  ${m.section ?? ''}`, x + 2, y + 2);
  }
  return sheet.toDataURL('image/png');
}, [times, every, from, to, cols]);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(png.split(',')[1], 'base64'));
await browser.close();
console.log(`done: ${outPath}`);
