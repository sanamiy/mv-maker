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

export function musicAt(t, analysis, sections, fade = 0.4) {
  const period = 60 / (analysis.tempo || 120);
  const beatPos = gridPosition(analysis.beats, t, period);
  const barPos = gridPosition(analysis.downbeats, t, period * 4);
  const beatIndex = Math.floor(beatPos), beatPhase = beatPos - beatIndex;
  const barIndex = Math.floor(barPos), barPhase = barPos - barIndex;
  const { rate, loudness, onset } = analysis.envelope;

  const si = Math.max(0, floorIndex(sections.map(s => s.from), t));
  const cur = sections[si] || { energy: 1, expression: {} };
  const prev = sections[si - 1] || cur;
  const blend = smoothstep((t - (cur.from ?? 0)) / fade);
  const energy = (prev.energy ?? 1) + ((cur.energy ?? 1) - (prev.energy ?? 1)) * blend;
  const expression = {};
  for (const k of new Set([...Object.keys(prev.expression || {}), ...Object.keys(cur.expression || {})])) {
    const a = prev.expression?.[k] ?? 0, b = cur.expression?.[k] ?? 0;
    expression[k] = a + (b - a) * blend;
  }
  return {
    t, beatPos, beatIndex, beatPhase, barPos, barIndex, barPhase,
    // 拍の頭で1、すぐ減衰するパルス
    beatPulse: Math.exp(-beatPhase * 5),
    loudness: sampleEnvelope(loudness, rate, t),
    onset: sampleEnvelope(onset, rate, t),
    section: cur.name, sectionIndex: si, sectionBlend: blend, energy, expression,
  };
}
