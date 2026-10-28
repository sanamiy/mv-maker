// シーンを mp4 に書き出す。
// ヘッドレス Chromium で canvas を1フレームずつ描き、RGBA の生ピクセルを WebSocket で受けて FFmpeg の stdin へ流す（PNG化しない）。
// 使い方: node src/render.mjs examples/demo/scene.json out/demo.mp4 [--frames N] [--scale 0.5]
// オプション:
//   --gl auto|metal|d3d11|gl|vulkan|swiftshader   描画に使うもの（auto: Mac は metal、Windows は d3d11、ほかは swiftshader）
//   --workers N|auto   N 個のブラウザで区間を分けて同時に描く（auto: CPU の数から決める）。
//                      各ブラウザは担当区間の頭まで描かずに状態だけ進めるので、1 個で書いたときと同じ絵になる
//   --allow-cpu        GPU が無い（SwiftShader で CPU 描画になる）環境でも 10 秒を超えて書き出す。
//                      既定では止める（クラウドだと 3 分の曲で 1 時間ほどかかるため。本番は GPU のある実機で書き出す）
//   --encoder x264|hw|<ffmpeg のエンコーダー名>   hw は Mac の VideoToolbox、Windows の NVENC / QSV / AMF から使えるものを選ぶ
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from './fsurl.mjs';
import { startServer, fsPath } from './server.mjs';
import { acceptWebSocket } from './ws.mjs';
import { angleBackend, gpuArgs, pickEncoder, autoWorkers } from './gpu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const maxFrames = Number(flag('--frames', Infinity));
const scale = Number(flag('--scale', 1));
const gl = angleBackend(flag('--gl', 'auto'));
const workersOpt = flag('--workers', 'auto');
const encoderOpt = flag('--encoder', 'x264');
const allowCpu = args.includes('--allow-cpu') && !!args.splice(args.indexOf('--allow-cpu'), 1);
const [scenePath, outPath = 'out/out.mp4'] = args;
if (!scenePath) { console.error('usage: node src/render.mjs scene.json out.mp4'); process.exit(1); }

const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const W = Math.round((scene.width ?? 1280) * scale / 2) * 2, H = Math.round((scene.height ?? 720) * scale / 2) * 2;

// 書き出し係（ブラウザ）ごとに WebSocket の口 /frames/<k> を用意し、届いたフレームをその係の FFmpeg へ書く。
// 書けたら返事をして、ブラウザに先へ進ませる
const sinks = new Map();
const { server, origin } = await startServer();
acceptWebSocket(server, pathname => {
  const sink = sinks.get(pathname);
  return sink && (async (buf, reply) => {
    if (!sink.ff.stdin.write(buf)) await new Promise(r => sink.ff.stdin.once('drain', r));
    sink.written++;
    reply('ok');
  });
});

const encoder = pickEncoder(encoderOpt);
const ffmpeg = (info, out, audio) => {
  const ff = spawn('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.width}x${info.height}`, '-r', String(info.fps), '-i', '-',
    ...(audio ? ['-i', audio] : []),
    '-vf', 'vflip', // readPixels は下の行から返るため
    ...encoder.args, '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  ff.done = new Promise((ok, ng) => ff.on('close', c => (c === 0 ? ok() : ng(new Error(`ffmpeg exited ${c}`)))));
  return ff;
};

async function openPlayer() {
  const browser = await chromium.launch({ args: gpuArgs(gl) });
  const page = await browser.newPage();
  // PBO の読み出しについての Chromium の性能上の注意は毎フレーム出るが、測ると遅くなっていないので出さない
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/READ-usage buffer/.test(m.text())) console.error('[page]', m.text()); });
  page.on('pageerror', e => console.error('[page]', e));
  await page.goto(origin + fsPath(path.join(ROOT, 'runtime/index.html')));
  await page.waitForFunction(() => window.MV_READY);
  const info = await page.evaluate(([u, w, h]) => window.MV.load(u, { width: w, height: h }), [origin + fsPath(scenePath), W, H]);
  return { browser, page, info };
}

// 1 個目のブラウザでシーンを読み、フレーム数などを決める
const first = await openPlayer();
const { info } = first;
const frames = Math.min(info.frameCount, maxFrames);
const renderer = await first.page.evaluate(() => { const g = window.MV.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
const cpuOnly = /swiftshader|llvmpipe|software/i.test(renderer);
if (cpuOnly && frames > info.fps * 10 && !allowCpu) {
  console.error(`gpu: ${renderer}
GPU が使えない環境（クラウドなど）なので、ここでの書き出しは止めます。CPU で描くと 3 分の曲で 1 時間ほどかかります。
- 本番の書き出しは GPU のある実機（Mac / Windows / レンダリング用 PC）で: node src/render.mjs ${scenePath} ${outPath}
- ここでは静止画の一覧（node src/stills.mjs）や、10 秒までの短い確認（--frames 300 --scale 0.5 など）にしてください
- それでもここで書き出すときは --allow-cpu を付けてください`);
  await first.browser.close();
  server.close();
  process.exit(2);
}
const workers = Math.max(1, Math.min(workersOpt === 'auto' ? autoWorkers(gl) : Number(workersOpt), Math.ceil(frames / info.fps)));
console.log(`${info.width}x${info.height} ${info.fps}fps, ${frames} frames`);
console.log(`gpu: ${renderer}${cpuOnly ? '（GPU が使えず CPU で描いています。とても遅くなります）' : ''}`);
console.log(`encoder: ${encoder.name}, workers: ${workers}`);
console.log(`expressions: ${info.expressions.join(', ')}`);
console.log(`sections: ${info.sections.join(' / ')}`);
for (const mx of info.mixamo ?? []) console.log(`mixamo: ${JSON.stringify(mx)}`);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
const audio = info.audio ? fromUrl(info.audio) : null;
// 1 個なら音声ごと直接書く。複数なら区間ごとの映像を一時フォルダに書き、最後につなげて音声を足す
const tmp = workers > 1 ? fs.mkdtempSync(path.join(os.tmpdir(), 'mv-render-')) : null;
const jobs = Array.from({ length: workers }, (_, k) => {
  const start = Math.round(frames * k / workers), end = Math.round(frames * (k + 1) / workers);
  const out = tmp ? path.join(tmp, `part${k}.mp4`) : outPath;
  return { k, start, end, out, sink: { ff: ffmpeg(info, out, tmp ? null : audio), written: 0 } };
});
for (const j of jobs) sinks.set(`/frames/${j.k}`, j.sink);

const t0 = Date.now();
const done = () => jobs.reduce((s, j) => s + j.sink.written, 0);
const progress = setInterval(() => process.stdout.write(`\r${done()}/${frames} (${(done() / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`), 1000);
await Promise.all(jobs.map(async j => {
  const p = j.k === 0 ? first : await openPlayer();
  await p.page.evaluate(([u, s, e]) => window.MV.streamTo(u, s, e), [`${origin.replace('http', 'ws')}/frames/${j.k}`, j.start, j.end]);
  j.sink.ff.stdin.end();
  await j.sink.ff.done;
  await p.browser.close();
}));
clearInterval(progress);
if (tmp) {
  // 区間ごとの映像は再エンコードせずにつなぐ
  fs.writeFileSync(path.join(tmp, 'list.txt'), jobs.map(j => `file '${j.out.replace(/'/g, "'\\''")}'`).join('\n'));
  const cat = spawn('ffmpeg', [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'),
    ...(audio ? ['-i', audio, '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'copy', '-movflags', '+faststart', outPath,
  ], { stdio: 'inherit' });
  await new Promise((ok, ng) => cat.on('close', c => (c === 0 ? ok() : ng(new Error(`ffmpeg concat exited ${c}`)))));
  fs.rmSync(tmp, { recursive: true, force: true });
}
server.close();
const sec = (Date.now() - t0) / 1000;
console.log(`\ndone: ${outPath} in ${sec.toFixed(1)}s (${(frames / sec).toFixed(1)} fps)`);
