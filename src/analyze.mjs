// 音声を事前解析して analysis.json を作る。
// 出力: tempo / beats / downbeats / onsets / 100Hz の音量・オンセット包絡 / 盛り上がり区間
// 使い方: node src/analyze.mjs song.wav analysis.json
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SR = 22050, HOP = 512, WIN = 1024, ENV_RATE = 100;

export function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], j = i + k + len / 2;
        const vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const normalize = a => { const m = Math.max(1e-9, ...a); return a.map(v => v / m); };
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function analyze(x) {
  const frames = Math.max(1, Math.floor((x.length - WIN) / HOP) + 1);
  const hann = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN));
  const rms = new Float32Array(frames), flux = new Float32Array(frames), lowFlux = new Float32Array(frames);
  const lowBins = Math.ceil(200 / (SR / WIN));
  let prev = new Float32Array(WIN / 2);
  for (let f = 0; f < frames; f++) {
    const re = new Float32Array(WIN), im = new Float32Array(WIN);
    let e = 0;
    for (let i = 0; i < WIN; i++) { const v = x[f * HOP + i]; e += v * v; re[i] = v * hann[i]; }
    rms[f] = Math.sqrt(e / WIN);
    fft(re, im);
    const mag = new Float32Array(WIN / 2);
    let d = 0, dl = 0;
    for (let k = 1; k < WIN / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const inc = Math.max(0, mag[k] - prev[k]); d += inc; if (k < lowBins) dl += inc;
    }
    flux[f] = d; lowFlux[f] = dl; prev = mag;
  }
  // フレーム f の値は窓の中央付近の出来事なので、時刻は窓半分ずらす
  const hopT = HOP / SR, T0 = WIN / 2 / SR, duration = x.length / SR;
  // 移動平均を引いて局所的な立ち上がりだけ残す
  const detrend = src => {
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0, c = 0; for (let k = Math.max(0, f - 8); k <= Math.min(frames - 1, f + 8); k++) { s += src[k]; c++; }
      out[f] = Math.max(0, src[f] - s / c);
    }
    return normalize(out);
  };
  // 全帯域 + 低域（キック）を強めに混ぜた拍検出用の包絡
  const broad = detrend(flux), low = detrend(lowFlux);
  const onsetEnv = broad.map((v, i) => v + 2 * low[i]);
  // テンポ: オンセット包絡の自己相関（60〜180BPM、120付近を少し優遇）
  const lagMin = Math.floor(60 / 180 / hopT), lagMax = Math.ceil(60 / 60 / hopT);
  const ac = []; let bestLag = lagMin, best = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0; for (let f = 0; f + lag < frames; f++) s += onsetEnv[f] * onsetEnv[f + lag];
    const bpm = 60 / (lag * hopT), w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    ac[lag] = s; if (s * w > best) { best = s * w; bestLag = lag; }
  }
  // 周期と位相を曲全体で同時に詰める（自己相関だけだとホップ単位の誤差が残るため）
  const at = t => { const i = Math.floor(t), fr = t - i; return (onsetEnv[i] || 0) * (1 - fr) + (onsetEnv[i + 1] || 0) * fr; };
  let lag = bestLag, bestPhase = 0; best = -1;
  for (let L = bestLag * 0.96; L <= bestLag * 1.04; L += 0.002 * bestLag) {
    for (let p = 0; p < L; p += 0.25) {
      let s = 0, c = 0; for (let t = p; t < frames; t += L) { s += at(t); c++; }
      if (s / c > best) { best = s / c; lag = L; bestPhase = p; }
    }
  }
  const tempo = 60 / (lag * hopT);
  // グリッドを基準に、近くのオンセットピークへ少しだけ吸着させる
  const beats = [];
  for (let t = bestPhase; t < frames; t += lag) {
    const c = Math.round(t), r = Math.max(1, Math.round(lag * 0.08));
    let bi = c, bv = -1; for (let k = c - r; k <= c + r; k++) if (onsetEnv[k] > bv) { bv = onsetEnv[k]; bi = k; }
    beats.push(round((bv > 0 ? bi : t) * hopT + T0));
  }
  // 小節頭: 4拍周期のうちオンセットと低域が最も強い位相
  let dbPhase = 0; best = -1;
  for (let p = 0; p < 4; p++) { let s = 0; for (let i = p; i < beats.length; i += 4) s += low[Math.round((beats[i] - T0) / hopT)] + broad[Math.round((beats[i] - T0) / hopT)]; if (s > best) { best = s; dbPhase = p; } }
  const downbeats = beats.filter((_, i) => i % 4 === dbPhase);
  // オンセット（ピーク検出）
  const onN = normalize(Array.from(broad)), onsets = [];
  for (let f = 1; f < frames - 1; f++) if (onN[f] > 0.15 && onN[f] >= onN[f - 1] && onN[f] > onN[f + 1] && (!onsets.length || f * hopT + T0 - onsets.at(-1) > 0.05)) onsets.push(round(f * hopT + T0));
  // 100Hz の包絡に揃える
  const n = Math.ceil(duration * ENV_RATE), sample = (arr, i) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((i / ENV_RATE - T0) / hopT)))];
  const rmsN = normalize(Array.from(rms)), loud = [], onset = [];
  for (let i = 0; i < n; i++) { loud.push(round(sample(rmsN, i), 3)); onset.push(round(sample(onN, i), 3)); }
  // 盛り上がり区間: 小節ごとの音量を3段階に分け、同じ段階の小節をまとめる
  const bars = downbeats.map((t, i) => [t, downbeats[i + 1] ?? duration]);
  const barE = bars.map(([a, b]) => { let s = 0, c = 0; for (let f = Math.floor((a - T0) / hopT); f < Math.min(frames, (b - T0) / hopT); f++) { s += rms[f]; c++; } return c ? s / c : 0; });
  const sorted = [...barE].sort((a, b) => a - b), q = p => sorted[Math.floor(p * (sorted.length - 1))];
  const lo = q(0.33), hi = (q(0.66) + Math.max(...barE)) / 2 * 0.85;
  const level = e => (e >= hi ? 'high' : e >= lo ? 'mid' : 'low');
  const segments = [];
  if (bars.length && bars[0][0] > 0.05) segments.push({ start: 0, end: bars[0][0], level: 'low' });
  bars.forEach(([a, b], i) => {
    const lv = level(barE[i]), last = segments.at(-1);
    if (last && last.level === lv) last.end = round(b); else segments.push({ start: round(a), end: round(b), level: lv });
  });
  return { version: 1, duration: round(duration), tempo: round(tempo, 2), beats, downbeats, onsets, segments, envelope: { rate: ENV_RATE, loudness: loud, onset } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output = 'analysis.json'] = process.argv;
  const a = analyze(decode(input));
  fs.writeFileSync(output, JSON.stringify(a));
  console.log(`tempo ${a.tempo} BPM, ${a.beats.length} beats, ${a.onsets.length} onsets`);
  console.log(a.segments.map(s => `${s.start}-${s.end}s ${s.level}`).join('\n'));
}
