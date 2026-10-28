// シーンを mp4 に書き出す。
// ヘッドレス Chromium で canvas を1フレームずつ描き、RGBA の生ピクセルを FFmpeg の stdin へ流す（PNG化しない）。
// 使い方: node src/render.mjs examples/demo/scene.json out/demo.mp4 [--frames N] [--scale 0.5]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toUrl, fromUrl, MIME } from './fsurl.mjs';
import { ensureSceneMotions } from './motions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const maxFrames = Number(flag('--frames', Infinity));
const scale = Number(flag('--scale', 1));
const batch = Number(flag('--batch', 4));
const gl = flag('--gl', 'swiftshader'); // swiftshader（どこでも同じ絵） / metal・gl など（GPU があれば速い）
const [scenePath, outPath = 'out/out.mp4'] = args;
if (!scenePath) { console.error('usage: node src/render.mjs scene.json out.mp4'); process.exit(1); }

const browser = await chromium.launch({ args: [`--use-angle=${gl}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });
page.on('pageerror', e => console.error('[page]', e));
await page.route('http://mv.local/**', route => {
  const file = fromUrl(route.request().url());
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
  route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] ?? 'application/octet-stream' });
});
await page.goto(toUrl(path.join(ROOT, 'runtime/index.html')));
await page.waitForFunction(() => window.MV_READY);

const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
await ensureSceneMotions(scenePath);
const W = Math.round((scene.width ?? 1280) * scale / 2) * 2, H = Math.round((scene.height ?? 720) * scale / 2) * 2;
const info = await page.evaluate(([u, w, h]) => window.MV.load(u, { width: w, height: h }), [toUrl(scenePath), W, H]);
const frames = Math.min(info.frameCount, maxFrames);
console.log(`${info.width}x${info.height} ${info.fps}fps, ${frames} frames`);
console.log(`expressions: ${info.expressions.join(', ')}`);
console.log(`sections: ${info.sections.join(' / ')}`);
for (const mx of info.mixamo ?? []) console.log(`mixamo: ${JSON.stringify(mx)}`);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
const ff = spawn('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.width}x${info.height}`, '-r', String(info.fps), '-i', '-',
  ...(info.audio ? ['-i', fromUrl(info.audio)] : []),
  '-vf', 'vflip', // readPixels は下の行から返るため
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  ...(info.audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
  '-movflags', '+faststart', outPath,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise((ok, ng) => ff.on('close', c => (c === 0 ? ok() : ng(new Error(`ffmpeg exited ${c}`)))));
const write = buf => new Promise(r => (ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r)));

const t0 = Date.now();
for (let i = 0; i < frames; i += batch) {
  const n = Math.min(batch, frames - i);
  const b64 = await page.evaluate(([s, n]) => window.MV.renderBatch(s, n), [i, n]);
  await write(Buffer.from(b64, 'base64'));
  if ((i / batch) % 15 === 0) process.stdout.write(`\r${i + n}/${frames} (${((i + n) / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`);
}
ff.stdin.end();
await ffDone;
await browser.close();
console.log(`\ndone: ${outPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
