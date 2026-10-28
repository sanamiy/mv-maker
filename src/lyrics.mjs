// 歌詞テキストと時刻情報をまとめて lyrics.json を作り、LRC / ASS / HTML / セクションに書き出す。
//
// 使い方:
//   node src/lyrics.mjs build lyrics.txt --timing aligned.json -o lyrics.json [--analysis analysis.json] [--snap 0.5] [--hold 0.5]
//   node src/lyrics.mjs build --timing song.lrc -o lyrics.json            # 歌詞テキスト無しで LRC だけから作る
//   node src/lyrics.mjs export lyrics.json --format lrc|lrc-words|ass|html|sections [-o 出力] [--analysis analysis.json]
//
// lyrics.txt は Suno / Udio と同じ書き方で、[Verse 1] [Chorus] のような行がセクションの見出しになる。
// --timing には次のどれかを渡す:
//   - tools/align_lyrics.py の出力（単語ごとの時刻）。WhisperX / stable-ts の JSON もそのまま読める
//   - LRC（行ごとの時刻。<mm:ss.xx> の単語時刻付きの拡張 LRC も可）。src/tap.mjs で打ったものなど
// 時刻側の文字と歌詞テキストは1文字ずつ突き合わせるので、表記ゆれや聞き取り違いが少しあっても対応が付く。
// --hold は歌い終わりから次の行まで表示を残す秒数（単語時刻のときの既定 0.5、LRC は行の終わりが決まっているので 0）。
import fs from 'node:fs';
import path from 'node:path';

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- 読み込み ----------

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー';
const WORD_RE = new RegExp(`[${CJK}][ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ]*|[^\\s${CJK}]+`, 'gu');
export const splitWords = text => text.match(WORD_RE) || [];

// 行の元の文字列から、各単語の前にあった区切り（空白など）を取り出す。日本語は単語間に空白を入れないため。
export function joinParts(text, words) {
  let pos = 0;
  return words.map(w => {
    const i = text.indexOf(w.text, pos);
    if (i < 0) return { sep: pos ? ' ' : '', w };
    const sep = text.slice(pos, i); pos = i + w.text.length;
    return { sep, w };
  });
}

// セクション見出し "Verse 1" → name "verse", "Pre-Chorus" → "pre-chorus"
export function sectionName(label) {
  return label.toLowerCase().replace(/[\s_]*\d+$/, '').trim().replace(/[\s_]+/g, '-') || 'section';
}

export function parseLyricsText(src) {
  const lines = [], sections = [];
  for (const raw of src.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    const tag = s.match(/^\[([^\]]+)\]$/);
    if (tag) { sections.push({ label: tag[1].trim(), name: sectionName(tag[1].trim()), lines: [] }); continue; }
    if (!sections.length) sections.push({ label: '', name: 'verse', lines: [] });
    sections.at(-1).lines.push(lines.length);
    lines.push({ text: s, section: sections.length - 1 });
  }
  return { lines, sections };
}

const parseClock = s => { const m = s.match(/(\d+):(\d+(?:\.\d+)?)/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

// LRC → 時刻付きトークン列。行時刻だけなら行全体を1トークン（次の行の頭まで）にする。
// 文字の無い行（[01:23.45] だけ）は直前の行の終わりの印として扱う。
export function parseLrc(src) {
  const entries = [];
  for (const raw of src.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+:\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.slice(stamps.at(-1).index + stamps.at(-1)[0].length).trim();
    for (const st of stamps) entries.push({ t: parseClock(st[1]), body });
  }
  entries.sort((a, b) => a.t - b.t);
  const tokens = [], lines = [];
  entries.forEach((e, i) => {
    const nextT = entries[i + 1]?.t ?? e.t + 4;
    if (!e.body) return;
    const text = e.body.replace(/<\d+:\d+(?:\.\d+)?>/g, '').replace(/\s+/g, ' ').trim();
    lines.push(text);
    const parts = [...e.body.matchAll(/<(\d+:\d+(?:\.\d+)?)>([^<]*)/g)];
    if (parts.length) {
      parts.forEach((p, k) => {
        if (!p[2].trim()) return;
        tokens.push({ text: p[2].trim(), start: parseClock(p[1]), end: parts[k + 1] ? parseClock(parts[k + 1][1]) : nextT });
      });
    } else tokens.push({ text, start: e.t, end: nextT, ...(entries[i + 1] ? {} : { open: true }) });
  });
  return { tokens, lines };
}

// 単語時刻の JSON（このツールの align 出力 / WhisperX / stable-ts）→ 時刻付きトークン列
export function parseAlignedJson(j) {
  const words = j.words || (j.segments || []).flatMap(s => s.words || []);
  return words
    .map(w => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
}

export function loadTiming(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\.lrc$/i.test(file) || /^\s*\[\d+:\d+/m.test(src)) return parseLrc(src);
  return { tokens: parseAlignedJson(JSON.parse(src)), lines: null };
}

// ---------- 1文字ずつの突き合わせ ----------

const norm = s => [...s.normalize('NFKC').toLowerCase()].filter(c => /[\p{L}\p{N}]/u.test(c));

// 歌詞の各単語に、時刻トークン列から開始・終了時刻を割り当てる（LCS で文字を対応付け、無い所は補間）
export function alignWords(words, tokens) {
  const A = [], B = [];
  words.forEach((w, wi) => { for (const c of norm(w)) A.push({ c, wi }); });
  for (const tk of tokens) {
    const cs = norm(tk.text), n = cs.length;
    cs.forEach((c, k) => B.push({ c, s: tk.start + (tk.end - tk.start) * k / n, e: tk.start + (tk.end - tk.start) * (k + 1) / n }));
  }
  const N = A.length, M = B.length;
  const dir = new Uint8Array((N + 1) * (M + 1));
  let prev = new Int32Array(M + 1), cur = new Int32Array(M + 1);
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const k = i * (M + 1) + j;
      if (A[i - 1].c === B[j - 1].c && prev[j - 1] + 1 >= Math.max(prev[j], cur[j - 1])) { cur[j] = prev[j - 1] + 1; dir[k] = 1; }
      else if (prev[j] >= cur[j - 1]) { cur[j] = prev[j]; dir[k] = 2; }
      else { cur[j] = cur[j - 1]; dir[k] = 3; }
    }
    [prev, cur] = [cur, prev];
  }
  const span = words.map(() => ({ s: Infinity, e: -Infinity, hit: 0 }));
  for (let i = N, j = M; i > 0 && j > 0;) {
    const d = dir[i * (M + 1) + j];
    if (d === 1) { const sp = span[A[i - 1].wi]; sp.s = Math.min(sp.s, B[j - 1].s); sp.e = Math.max(sp.e, B[j - 1].e); sp.hit++; i--; j--; }
    else if (d === 2) i--; else j--;
  }
  const matched = M ? prev[M] : 0;
  const len = words.map(w => Math.max(1, norm(w).length));
  // 半分以上の文字が対応した単語だけ信用する（別の単語の1文字にたまたま当たっただけのものは捨てる）
  const out = words.map((w, i) => (span[i].hit >= Math.ceil(len[i] / 2) ? { text: w, start: span[i].s, end: span[i].e } : null));
  // 対応の付かなかった単語は、前後の対応付いた単語のあいだを文字数で按分する
  for (let i = 0; i < out.length;) {
    if (out[i]) { i++; continue; }
    let j = i; while (j < out.length && !out[j]) j++;
    const a = out[i - 1]?.end, b = out[j]?.start;
    const total = len.slice(i, j).reduce((x, y) => x + y, 0);
    let t0 = a ?? (b !== undefined ? b - 0.3 * total : 0), t1 = b ?? t0 + 0.3 * total;
    if (t1 < t0) t1 = t0;
    let acc = 0;
    for (let k = i; k < j; k++) { const s = t0 + (t1 - t0) * acc / total; acc += len[k]; out[k] = { text: words[k], start: s, end: t0 + (t1 - t0) * acc / total, guessed: true }; }
    i = j;
  }
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
  for (const w of out) if (w.end < w.start) w.end = w.start;
  return { words: out, coverage: N ? matched / N : 1 };
}

// ---------- 拍への吸着 ----------

function gridTime(grid, pos) {
  const i = Math.max(0, Math.min(grid.length - 2, Math.floor(pos)));
  return grid[i] + (grid[i + 1] - grid[i]) * (pos - i);
}
function gridPos(grid, t) {
  let i = 0; while (i < grid.length - 2 && grid[i + 1] <= t) i++;
  return i + (t - grid[i]) / (grid[i + 1] - grid[i]);
}
// t を拍の細かさ step（0.5 なら8分）の格子へ、tol 秒以内なら寄せる
export function snapToBeat(t, beats, step, tol) {
  if (!beats || beats.length < 2 || !step) return t;
  const q = gridTime(beats, Math.round(gridPos(beats, t) / step) * step);
  return Math.abs(q - t) <= tol ? q : t;
}

// ---------- 組み立て ----------

export function buildLyrics({ text, timing, analysis, snap = 0, snapTol = 0.1, hold = 0.5 }) {
  const parsed = text ? parseLyricsText(text) : { lines: timing.lines.map(t => ({ text: t, section: 0 })), sections: [{ label: '', name: 'verse', lines: [] }] };
  if (!text) parsed.sections[0].lines = parsed.lines.map((_, i) => i);
  const wordLists = parsed.lines.map(l => splitWords(l.text));
  const flat = wordLists.flat();
  const { words, coverage } = alignWords(flat, timing.tokens);
  let k = 0;
  const lines = parsed.lines.map((l, i) => {
    const ws = words.slice(k, k += wordLists[i].length).map(w => ({ ...w }));
    return { start: ws[0]?.start ?? 0, end: ws.at(-1)?.end ?? 0, text: l.text, section: parsed.sections[l.section].name, sectionIndex: l.section, words: ws };
  });
  for (const [i, l] of lines.entries()) {
    if (snap && analysis) {
      const s = snapToBeat(l.start, analysis.beats, snap, snapTol);
      if (l.words[0]) l.words[0].start = s;
      l.start = s;
    }
    const next = lines[i + 1]?.start ?? Infinity;
    l.end = Math.min(Math.max(l.end, l.start) + hold, next);
    for (const w of l.words) { w.start = round(Math.max(l.start, w.start)); w.end = round(Math.min(l.end, w.end)); }
    l.start = round(l.start); l.end = round(l.end);
  }
  const sections = buildSectionsFromTags(parsed.sections, lines, analysis);
  const guessed = words.filter(w => w.guessed).length;
  return {
    lyrics: { version: 1, lines: lines.map(({ sectionIndex, ...l }) => ({ ...l, words: l.words.map(({ guessed, ...w }) => w) })), sections },
    report: { coverage, guessedWords: guessed, totalWords: words.length },
  };
}

// [Chorus] などの見出しから、曲の構成（いつから何のセクションか）を作る。
// 歌い出しの少し手前にある小節頭を区切りにする（歌は拍より先に入ることが多いので、近い方ではなく手前を優先）。
function buildSectionsFromTags(tags, lines, analysis) {
  const downbeats = analysis?.downbeats || [];
  const barLen = downbeats.length > 1 ? (downbeats.at(-1) - downbeats[0]) / (downbeats.length - 1) : 2;
  const toBar = t => {
    let best = null;
    for (const d of downbeats) if (d <= t + barLen * 0.25 && t - d < barLen * 0.75) best = d;
    return best ?? t;
  };
  const out = [];
  let lastEnd = 0;
  tags.forEach((tag, i) => {
    const ls = lines.filter(l => l.sectionIndex === i);
    let from;
    if (i === 0) from = 0;
    else if (ls.length) from = toBar(ls[0].start);
    else {
      // 歌詞の無いセクション（間奏など）は直前の歌の終わりの次の小節頭から
      from = downbeats.find(d => d >= lastEnd - 0.05) ?? lastEnd;
    }
    from = Math.max(from, out.at(-1)?.from ?? 0);
    if (ls.length) lastEnd = ls.at(-1).end;
    if (out.length && Math.abs(out.at(-1).from - from) < 1e-3 && i > 0) out.pop();
    out.push({ from: round(from), name: tag.name, label: tag.label });
  });
  return out;
}

// ---------- 書き出し ----------

const clock = (t, d = 2) => { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(d).padStart(3 + d, '0')}`; };

export function toLrc(lyrics, { words = false } = {}) {
  const out = [];
  lyrics.lines.forEach((l, i) => {
    const body = words ? joinParts(l.text, l.words).map(({ sep, w }) => `${sep}<${clock(w.start)}>${w.text}`).join('') + `<${clock(l.end)}>` : l.text;
    out.push(`[${clock(l.start)}]${body}`);
    const next = lyrics.lines[i + 1];
    if (!next || next.start - l.end > 0.05) out.push(`[${clock(l.end)}]`);
  });
  return out.join('\n') + '\n';
}

// scene.json の "sections" にそのまま入れられる形。energy / expression は名前からの目安なので好みで直す。
const SECTION_PRESETS = {
  intro: { energy: 0.4, expression: { relaxed: 0.5 } },
  verse: { energy: 0.8, expression: {} },
  'pre-chorus': { energy: 1.0, expression: {} },
  prechorus: { energy: 1.0, expression: {} },
  chorus: { energy: 1.4, expression: { happy: 1 } },
  'final-chorus': { energy: 1.6, expression: { happy: 1 } },
  hook: { energy: 1.3, expression: { happy: 0.8 } },
  drop: { energy: 1.6, expression: { happy: 1 } },
  bridge: { energy: 0.9, expression: { relaxed: 0.3 } },
  instrumental: { energy: 1.0, expression: {} },
  break: { energy: 0.7, expression: {} },
  outro: { energy: 0.3, expression: { relaxed: 0.7 } },
};
export const toSceneSections = lyrics =>
  lyrics.sections.map(s => ({ from: s.from, name: s.name, ...(SECTION_PRESETS[s.name] || { energy: 1, expression: {} }) }));

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 文字レイヤー（scene.json の "layers"）用の HTML。data-start / data-end は秒。
// 行 <p class="lyric"> は歌っている間だけ出る。単語 <span class="mv-word"> は歌われた瞬間に出て行の終わりまで残る
// （本来の単語の終わりは data-word-end に入れてある）。
export function toHtml(lyrics) {
  const rows = lyrics.lines.map(l => {
    const words = joinParts(l.text, l.words).map(({ sep, w }) =>
      `${esc(sep)}<span class="mv-word" data-start="${w.start.toFixed(3)}" data-end="${l.end.toFixed(3)}" data-word-end="${w.end.toFixed(3)}">${esc(w.text)}</span>`).join('');
    return `<p class="lyric" data-section="${esc(l.section)}" data-start="${l.start.toFixed(3)}" data-end="${l.end.toFixed(3)}">${words}</p>`;
  });
  return rows.join('\n') + '\n';
}

// ASS 字幕（カラオケ色変わり）。sync-check の確認動画で使う。
export function toAss(lyrics, { width = 1280, height = 720, analysis = null } = {}) {
  const t = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s - h * 3600 - m * 60; return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`; };
  const fs_ = Math.round(height / 14);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line,Noto Sans CJK JP,${fs_},&H0000D7FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,2,40,40,${Math.round(height * 0.12)},1
Style: Next,Noto Sans CJK JP,${Math.round(fs_ * 0.7)},&H00909090,&H00909090,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,${Math.round(height * 0.04)},1
Style: Info,DejaVu Sans Mono,${Math.round(fs_ * 0.6)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,30,30,24,1
Style: Beat,DejaVu Sans,${Math.round(fs_ * 1.2)},&H004D8DFF,&H004D8DFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,9,30,30,16,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  const k = cs => `{\\kf${Math.max(0, Math.round(cs))}}`;
  lyrics.lines.forEach((l, i) => {
    let cur = l.start, body = '';
    for (const { sep, w } of joinParts(l.text, l.words)) {
      body += sep;
      if (w.start > cur + 0.005) body += k((w.start - cur) * 100);
      body += k((w.end - Math.max(cur, w.start)) * 100) + w.text.replace(/[{}]/g, '');
      cur = Math.max(cur, w.end);
    }
    ev.push(`Dialogue: 1,${t(l.start)},${t(l.end)},Line,,0,0,0,,${body.trim()}`);
    const n = lyrics.lines[i + 1];
    if (n) ev.push(`Dialogue: 0,${t(Math.max(l.start, n.start - 3))},${t(n.start)},Next,,0,0,0,,${n.text.replace(/[{}]/g, '')}`);
  });
  lyrics.sections.forEach((s, i) => {
    const end = lyrics.sections[i + 1]?.from ?? (analysis?.duration ?? lyrics.lines.at(-1)?.end ?? s.from + 5);
    ev.push(`Dialogue: 0,${t(s.from)},${t(end)},Info,,0,0,0,,[${(s.label || s.name).replace(/[{}]/g, '')}]  from ${s.from.toFixed(2)}s`);
  });
  if (analysis) {
    const down = new Set(analysis.downbeats.map(d => d.toFixed(3)));
    for (const b of analysis.beats) {
      const big = down.has(b.toFixed(3));
      ev.push(`Dialogue: 0,${t(b)},${t(b + 0.12)},Beat,,0,0,0,,{\\fad(0,100)}${big ? '■' : '●'}`);
    }
  }
  return head + ev.join('\n') + '\n';
}

// ---------- CLI ----------

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') || argv[i] === '-o') opt[argv[i].replace(/^-+/, '')] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = args(rest);
  const analysis = opt.analysis ? JSON.parse(fs.readFileSync(opt.analysis, 'utf8')) : null;
  const write = (s, def) => { const o = opt.o || def; if (o) { fs.mkdirSync(path.dirname(path.resolve(o)), { recursive: true }); fs.writeFileSync(o, s); console.log(`→ ${o}`); } else process.stdout.write(s); };
  if (cmd === 'build') {
    if (!opt.timing) throw new Error('--timing aligned.json または song.lrc を指定してください');
    const text = pos[0] ? fs.readFileSync(pos[0], 'utf8') : null;
    const timing = loadTiming(opt.timing);
    if (!text && !timing.lines) throw new Error('単語時刻の JSON を使うときは歌詞テキスト（lyrics.txt）も渡してください');
    const { lyrics, report } = buildLyrics({ text, timing, analysis, snap: Number(opt.snap || 0), snapTol: Number(opt['snap-tol'] || 0.1), hold: Number(opt.hold ?? (timing.lines ? 0 : 0.5)) });
    write(JSON.stringify(lyrics, null, 1) + '\n', 'lyrics.json');
    console.log(`${lyrics.lines.length} 行, 文字の一致率 ${(report.coverage * 100).toFixed(1)}%, 推定で埋めた単語 ${report.guessedWords}/${report.totalWords}`);
    console.log(lyrics.sections.map(s => `  ${s.from.toFixed(2).padStart(7)}s  ${s.label || s.name}`).join('\n'));
    if (report.coverage < 0.8) console.log('※ 一致率が低めです。歌詞テキストと音源が同じ版か、sync-check で確認してください。');
  } else if (cmd === 'export') {
    const lyrics = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    const f = opt.format || 'lrc';
    if (f === 'lrc') write(toLrc(lyrics));
    else if (f === 'lrc-words') write(toLrc(lyrics, { words: true }));
    else if (f === 'html') write(toHtml(lyrics));
    else if (f === 'ass') write(toAss(lyrics, { analysis }));
    else if (f === 'sections') write(JSON.stringify(toSceneSections(lyrics), null, 1) + '\n');
    else throw new Error(`知らない形式: ${f}`);
  } else {
    console.log('使い方: node src/lyrics.mjs build lyrics.txt --timing aligned.json|song.lrc -o lyrics.json [--analysis analysis.json] [--snap 0.5]\n        node src/lyrics.mjs export lyrics.json --format lrc|lrc-words|ass|html|sections [-o 出力]');
    process.exit(cmd ? 1 : 0);
  }
}
