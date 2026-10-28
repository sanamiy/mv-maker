// 描画（Chromium の WebGL）とエンコード（FFmpeg）に何を使うかを、OS に合わせて選ぶ。
import { spawnSync } from 'node:child_process';
import os from 'node:os';

// --gl auto: Mac は Metal、Windows は Direct3D 11。Linux やクラウドは GPU が無いことが多いので swiftshader（CPU）
export function angleBackend(gl = 'auto') {
  if (gl !== 'auto') return gl;
  return process.platform === 'darwin' ? 'metal' : process.platform === 'win32' ? 'd3d11' : 'swiftshader';
}

export const gpuArgs = gl => [`--use-angle=${angleBackend(gl)}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// 画質はおおむね libx264 -crf 18 に合わせる
const ENCODERS = {
  x264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-allow_sw', '0'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  h264_qsv: ['-c:v', 'h264_qsv', '-global_quality', '20'],
  h264_amf: ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20'],
};

// ビルドに入っていても、GPU やドライバーが無いと使えないので、黒い数フレームを実際にエンコードして確かめる
const works = name => spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', ...ENCODERS[name], '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { stdio: 'ignore' }).status === 0;

export function pickEncoder(opt = 'x264') {
  if (opt === 'x264' || opt === 'libx264') return { name: 'libx264', args: ENCODERS.x264 };
  if (opt !== 'hw') return { name: opt, args: ENCODERS[opt] ?? ['-c:v', opt] };
  const candidates = process.platform === 'darwin' ? ['h264_videotoolbox'] : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  const name = candidates.find(works);
  if (!name) { console.warn('ハードウェアエンコーダーが使えないので libx264 で書き出します'); return { name: 'libx264', args: ENCODERS.x264 }; }
  return { name, args: ENCODERS[name] };
}

// 同時に動かすブラウザの数。1 個あたり CPU を 3〜4 コア使う（ページの描画、HTML レイヤーの画像化、GPU プロセス、FFmpeg）。
// M1（8コア）で P(Doom) を測ると 1 個 20.5fps、2 個 27.6fps、3 個 27.2fps だったので、4 コアにつき 1 個にする。
// GPU が無いとき（swiftshader）は描画そのものが CPU なので 1 個
export function autoWorkers(gl) {
  if (gl === 'swiftshader') return 1;
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cpus / 4)));
}
