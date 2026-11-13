// フレーム時刻から音楽情報（拍・小節・音量・セクション）を引く。純粋関数のみ。

// sorted[i] <= t となる最大の i（無ければ -1）
function floorIndex(sorted, t) {
  let lo = 0, hi = sorted.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

// 拍の列から「何拍目か（小数込み）」を出す。範囲外は平均周期で外挿する。
function gridPosition(grid, t, fallbackPeriod) {
  if (grid.length === 0) return t / fallbackPeriod;
  const period = grid.length > 1 ? (grid.at(-1) - grid[0]) / (grid.length - 1) : fallbackPeriod;
  const i = floorIndex(grid, t);
  if (i < 0) return (t - grid[0]) / period;
  if (i >= grid.length - 1) return i + (t - grid[i]) / period;
  return i + (t - grid[i]) / (grid[i + 1] - grid[i]);
}

const smoothstep = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function sampleEnvelope(env, rate, t) {
  const x = t * rate, i = Math.floor(x), f = x - i;
  const a = env[Math.max(0, Math.min(env.length - 1, i))] ?? 0, b = env[Math.max(0, Math.min(env.length - 1, i + 1))] ?? 0;
  return a + (b - a) * f;
}

const LEVEL_PRESETS = {
  low: { name: 'low', energy: 0.4, expression: { relaxed: 0.4 } },
  mid: { name: 'mid', energy: 0.8, expression: {} },
  high: { name: 'high', energy: 1.3, expression: { happy: 1 } },
};

// sections: シーンで明示した配列、または "auto"（解析の盛り上がり区間から作る）
export function buildSections(scene, analysis) {
  if (Array.isArray(scene.sections)) return [...scene.sections].sort((a, b) => a.from - b.from);
  const presets = { ...LEVEL_PRESETS, ...(scene.levels || {}) };
  return analysis.segments.map(s => ({ ...presets[s.level], from: s.start }));
}

// 拍の列に直線を当てはめた「揺れない拍の時計」（拍ごとの検出のばらつきを除いたもの）。analysis ごとに1回だけ計算する
const steadyCache = new WeakMap();
function steadyGrid(analysis, period) {
  if (steadyCache.has(analysis)) return steadyCache.get(analysis);
  const b = analysis.beats, n = b.length;
  let fit = { t0: b[0] ?? 0, period };
  if (n > 2) {
    const mx = (n - 1) / 2, my = b.reduce((a, x) => a + x, 0) / n;
    let sxy = 0, sxx = 0;
    b.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
    const k = sxy / sxx;
    fit = { t0: my - k * mx, period: k };
  }
  steadyCache.set(analysis, fit);
  return fit;
}

// セクションごとに混ぜる値。energy に加えて、カメラ（cameraEnergy）と照明（lightEnergy）を別に決められる（書かなければ energy と同じ）
const lerp = (a, b, k) => a + (b - a) * k;
const secEnergy = (s, key) => s[key] ?? s.energy ?? 1;

// 拍子。analysis.beatsPerBar（analyze.mjs --beats-per-bar）か、scene.json の beatsPerBar。既定は 4
export const beatsPerBar = analysis => analysis?.beatsPerBar ?? 4;

// scene.json の beatsPerBar / firstDownbeat（何拍目が最初の小節頭か、1 始まり）で小節頭を作り直す。
// どちらも書いていなければ analysis をそのまま返す
export function applyMeter(analysis, scene = {}) {
  if (scene.beatsPerBar == null && scene.firstDownbeat == null) return analysis;
  const n = scene.beatsPerBar ?? beatsPerBar(analysis);
  let first = scene.firstDownbeat != null ? scene.firstDownbeat - 1 : Math.max(0, analysis.beats.indexOf(analysis.downbeats?.[0]));
  first = ((first % n) + n) % n;
  return { ...analysis, beatsPerBar: n, downbeats: analysis.beats.filter((_, i) => i >= first && (i - first) % n === 0) };
}

export function musicAt(t, analysis, sections, fade = 0.4) {
  const period = 60 / (analysis.tempo || 120), bpb = beatsPerBar(analysis);
  const beatPos = gridPosition(analysis.beats, t, period);
  const barPos = gridPosition(analysis.downbeats, t, period * bpb);
  const beatIndex = Math.floor(beatPos), beatPhase = beatPos - beatIndex;
  const barIndex = Math.floor(barPos), barPhase = barPos - barIndex;
  const { rate, loudness, onset } = analysis.envelope;

  const si = Math.max(0, floorIndex(sections.map(s => s.from), t));
  const cur = sections[si] || { energy: 1, expression: {} };
  const prev = sections[si - 1] || cur;
  // 境目で混ざる秒数は、入ってくるセクションの fade（既定 0.4 秒）。0 ならすぐ切り替わる
  const f = cur.fade ?? fade;
  const blend = f > 0 ? smoothstep((t - (cur.from ?? 0)) / f) : (t >= (cur.from ?? 0) ? 1 : 0);
  const energy = lerp(prev.energy ?? 1, cur.energy ?? 1, blend);
  const expression = {};
  for (const k of new Set([...Object.keys(prev.expression || {}), ...Object.keys(cur.expression || {})])) {
    const a = prev.expression?.[k] ?? 0, b = cur.expression?.[k] ?? 0;
    expression[k] = a + (b - a) * blend;
  }
  return {
    t, beatPos, beatIndex, beatPhase, barPos, barIndex, barPhase, beatsPerBar: bpb,
    // 小節の中で何拍目か（0 始まり）
    beatInBar: Math.min(bpb - 1, Math.floor(barPhase * bpb + 1e-3)),
    // 揺れない拍の時計（Mixamo の再生など、速さが変わると困るもの用）と1拍の秒数
    steadyBeat: (t - steadyGrid(analysis, period).t0) / steadyGrid(analysis, period).period, beatPeriod: steadyGrid(analysis, period).period,
    // 拍の頭で1、すぐ減衰するパルス
    beatPulse: Math.exp(-beatPhase * 5),
    loudness: sampleEnvelope(loudness, rate, t),
    onset: sampleEnvelope(onset, rate, t),
    section: cur.name, sectionIndex: si, sectionBlend: blend, energy, expression,
    cameraEnergy: lerp(secEnergy(prev, 'cameraEnergy'), secEnergy(cur, 'cameraEnergy'), blend),
    lightEnergy: lerp(secEnergy(prev, 'lightEnergy'), secEnergy(cur, 'lightEnergy'), blend),
  };
}

// 前後 fade 秒でなめらかに 0→1→0 になる窓（from〜to の間が 1）
export function windowWeight(t, from, to, fade = 0) {
  if (t < from || t >= to) return 0;
  if (!(fade > 0)) return 1;
  return Math.min(smoothstep((t - from) / fade), Number.isFinite(to) ? smoothstep((to - t) / fade) : 1);
}

// 時刻を決めて表情を足す（scene.json の expressions）。
// cues: [{ start, end, set: { 表情名: 強さ }, fade, keep }]（start / end は秒に直したもの）
// 出ているあいだ set の表情へ寄せ、keep: true でなければ、ほかの表情（セクションの表情）は弱める
export function applyExpressionCues(expression, cues, t) {
  let out = expression;
  for (const c of cues) {
    const w = windowWeight(t, c.start, c.end, c.fade ?? 0.12);
    if (w <= 0) continue;
    if (out === expression) out = { ...expression };
    if (!c.keep) for (const k of Object.keys(out)) if (!(k in c.set)) out[k] *= 1 - w;
    for (const [k, v] of Object.entries(c.set)) out[k] = lerp(out[k] ?? 0, v, w);
  }
  return out;
}
