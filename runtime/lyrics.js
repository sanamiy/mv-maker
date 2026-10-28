// 歌詞の時刻データ（lyrics.json）を引く。純粋関数のみ（Node とブラウザの両方で使う）。
//
// lyrics.json の形:
//   { version: 1,
//     lines: [{ start, end, text, section, words: [{ start, end, text }] }],
//     sections: [{ from, name, label }] }

function floorIndex(items, t, key) {
  let lo = 0, hi = items.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (items[m][key] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

const clamp01 = x => (x <= 0 ? 0 : x >= 1 ? 1 : x);

// 時刻 t の歌詞の状態。歌っていない所では line は null で、prev / next が入る。
export function lyricAt(t, lyrics) {
  const lines = lyrics?.lines || [];
  const i = floorIndex(lines, t, 'start');
  const cur = lines[i];
  const active = cur && t < cur.end;
  const out = {
    index: active ? i : -1,
    line: active ? cur : null,
    prev: active ? lines[i - 1] ?? null : cur ?? null,
    next: lines[i + 1] ?? null,
    progress: 0, // 行の中の進み 0〜1
    word: null, wordIndex: -1, wordProgress: 0,
    sinceStart: active ? t - cur.start : Infinity,
    untilNext: lines[i + 1] ? lines[i + 1].start - t : Infinity,
  };
  if (!active) return out;
  out.progress = clamp01((t - cur.start) / Math.max(1e-6, cur.end - cur.start));
  const words = cur.words || [];
  const wi = floorIndex(words, t, 'start');
  if (wi >= 0) {
    out.wordIndex = wi; out.word = words[wi];
    out.wordProgress = clamp01((t - words[wi].start) / Math.max(1e-6, words[wi].end - words[wi].start));
  }
  return out;
}

export function sectionAt(t, lyrics) {
  const s = lyrics?.sections || [];
  return s[Math.max(0, floorIndex(s, t, 'from'))] ?? null;
}

// data-start / data-end を持つ要素に、時刻 t での状態を付ける。
//   クラス: is-future / is-active / is-past
//   CSS 変数: --progress（要素内の進み 0〜1）, --local-t（開始からの秒、開始前は負）
// 文字レイヤー（runtime/layers.js）を使わずに lyrics.mjs の HTML を単体で動かすとき用。変数名はレイヤー側と揃えてある。
export function applyTimedClasses(root, t) {
  for (const el of root.querySelectorAll('[data-start]')) {
    const a = Number(el.dataset.start), b = Number(el.dataset.end ?? Infinity);
    const state = t < a ? 'is-future' : t < b ? 'is-active' : 'is-past';
    el.classList.remove('is-future', 'is-active', 'is-past');
    el.classList.add(state);
    el.style.setProperty('--progress', String(clamp01((t - a) / Math.max(1e-6, b - a))));
    el.style.setProperty('--local-t', (t - a).toFixed(3));
  }
}
