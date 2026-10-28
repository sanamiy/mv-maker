// ブラウザでの確認用。音声を再生し、その再生位置に合わせてフレームを進める。
// 書き出し（render.mjs）とは違い実時間に追従するので、遅いPCではコマ落ちする。
// 下のバー: シークバー（ドラッグで移動）、セクションの帯（クリックでその頭へ）、現在時刻とセクション名。
// preview.mjs から変更の知らせが来たら、再生位置と再生中かどうかを覚えたまま読み込み直す。
const sceneUrl = new URL(new URLSearchParams(location.search).get('scene'), location.href).href;
const KEY = `mv-preview:${sceneUrl}`;
const saved = (() => { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; } })();

const css = `
body{--accent:#e5322d;--bar:#141414;--track:#2c2c2c;--track2:#232323;--text:#ddd;--dim:#888;display:flex;flex-direction:column;height:100vh;color:var(--text);font:13px/1.4 system-ui,sans-serif}
#mv{flex:1;min-height:0;width:100%;object-fit:contain;cursor:pointer}
.pv{flex:none;background:var(--bar);padding:6px 12px 8px;user-select:none}
.pv.hidden{display:none}
.pv-seek{position:relative;height:14px;cursor:pointer}
.pv-seek::before{content:"";position:absolute;left:0;right:0;top:5px;height:4px;background:var(--track);border-radius:2px}
.pv-fill{position:absolute;left:0;top:5px;height:4px;background:var(--accent);border-radius:2px}
.pv-knob{position:absolute;top:1px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--bar)}
.pv-hover{position:absolute;bottom:16px;transform:translateX(-50%);background:#000c;padding:1px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;display:none}
.pv-seek:hover .pv-hover{display:block}
.pv-secs{position:relative;height:20px;margin-top:3px}
.pv-sec{position:absolute;top:0;bottom:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:20px;padding:0 5px;box-sizing:border-box;border-left:1px solid var(--bar);cursor:pointer;background:var(--track);color:var(--dim)}
.pv-sec:nth-child(even){background:var(--track2)}
.pv-sec:hover{color:var(--text)}
.pv-sec.on{background:color-mix(in srgb,var(--accent) 30%,var(--track));color:#fff;font-weight:600;box-shadow:inset 0 -2px var(--accent)}
.pv-row{display:flex;align-items:center;gap:12px;margin-top:6px}
.pv-row button{background:var(--track);color:var(--text);border:0;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
.pv-row button:hover{background:color-mix(in srgb,var(--accent) 30%,var(--track))}
.pv-time{font-variant-numeric:tabular-nums}
.pv-name{font-weight:600;color:var(--accent)}
.pv-help{margin-left:auto;color:var(--dim);font-size:12px}
.pv-msg{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#000d;padding:6px 14px;border-radius:6px;pointer-events:none;transition:opacity .4s}
.pv-err{position:fixed;inset:12px;overflow:auto;background:#300e;color:#fcc;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:16px;border-radius:8px}
`;
document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; parent?.append(e); return e; };

const msgEl = el('div', 'pv-msg', document.body); msgEl.style.opacity = 0;
let msgTimer;
const toast = (text, ms = 1500) => { msgEl.textContent = text; msgEl.style.opacity = 1; clearTimeout(msgTimer); if (ms) msgTimer = setTimeout(() => (msgEl.style.opacity = 0), ms); };
const showError = e => { (document.querySelector('.pv-err') || el('div', 'pv-err', document.body)).textContent = `Failed to load. Fix the file and save to reload.\n\n${e?.stack || e}`; };

// 保存の知らせ。読み込みに失敗していても直して保存すれば戻れるよう、最初につないでおく
let audio = null, info = null;
const remember = () => { if (audio) try { sessionStorage.setItem(KEY, JSON.stringify({ t: audio.currentTime, playing: !audio.paused, hidden: bar.classList.contains('hidden') })); } catch {} };
const events = new EventSource('/__reload');
events.addEventListener('change', e => { remember(); toast(`Reloading: ${JSON.parse(e.data)}`, 0); location.reload(); });
addEventListener('beforeunload', remember);

const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };

const bar = el('div', 'pv', document.body);
if (saved.hidden) bar.classList.add('hidden');
const seek = el('div', 'pv-seek', bar), fill = el('div', 'pv-fill', seek), knob = el('div', 'pv-knob', seek), hover = el('div', 'pv-hover', seek);
const secsEl = el('div', 'pv-secs', bar);
const row = el('div', 'pv-row', bar);
const playBtn = el('button', '', row, '▶ Play');
const timeEl = el('span', 'pv-time', row, '0:00.0 / 0:00.0');
const nameEl = el('span', 'pv-name', row);
const idxEl = el('span', '', row);
el('span', 'pv-help', row, 'Space play/pause · ←→ 5s (Shift 1s) · ↑↓ prev/next section · , . 1 frame · H hide bar');

try {
  await new Promise(r => (window.MV_READY ? r() : setTimeout(r, 0)));
  info = await window.MV.load(sceneUrl);
} catch (e) { showError(e); throw e; }

const mv = window.MV, duration = info.duration;
const sections = mv.sections.map((s, i, a) => ({ name: s.name ?? `#${i + 1}`, from: s.from, to: a[i + 1]?.from ?? duration })).filter(s => s.from < duration);
audio = new Audio(info.audio);
const pct = t => `${(100 * Math.min(1, Math.max(0, t / duration))).toFixed(3)}%`;
const sectionIndexAt = t => { let k = 0; sections.forEach((s, i) => { if (s.from <= t + 1e-3) k = i; }); return k; };
const setTime = t => { audio.currentTime = Math.min(Math.max(0, t), duration - 0.01); update(); };
const toggle = () => (audio.paused ? audio.play().catch(() => toast('Could not start playback. Click again.')) : audio.pause());

const secEls = sections.map((s, i) => {
  const e = el('div', 'pv-sec', secsEl, s.name);
  Object.assign(e.style, { left: pct(s.from), width: `calc(${pct(s.to)} - ${pct(s.from)})` });
  e.title = `${s.name}  ${fmt(s.from)} – ${fmt(s.to)}  (click to jump)`;
  e.onclick = () => setTime(s.from);
  return e;
});

let shown = -1;
function update() {
  const t = audio.currentTime;
  fill.style.width = knob.style.left = pct(t);
  timeEl.textContent = `${fmt(t)} / ${fmt(duration)}`;
  const k = sectionIndexAt(t);
  if (k !== shown && sections.length) {
    secEls[shown]?.classList.remove('on'); secEls[k].classList.add('on'); shown = k;
    nameEl.textContent = sections[k].name; idxEl.textContent = `(${k + 1}/${sections.length})`;
  }
  playBtn.textContent = audio.paused ? '▶ Play' : '❚❚ Pause';
}

// シークバー: クリック・ドラッグで移動。乗せると時刻とセクション名が出る
const timeAtX = x => { const r = seek.getBoundingClientRect(); return duration * Math.min(1, Math.max(0, (x - r.left) / r.width)); };
seek.addEventListener('pointerdown', e => { seek.setPointerCapture(e.pointerId); setTime(timeAtX(e.clientX)); });
seek.addEventListener('pointermove', e => {
  const t = timeAtX(e.clientX);
  hover.style.left = pct(t); hover.textContent = `${fmt(t)}  ${sections[sectionIndexAt(t)]?.name ?? ''}`;
  if (seek.hasPointerCapture(e.pointerId)) setTime(t);
});

playBtn.onclick = toggle;
document.getElementById('mv').addEventListener('click', toggle);
audio.addEventListener('play', update); audio.addEventListener('pause', update); audio.addEventListener('ended', update);
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = audio.currentTime, k = sectionIndexAt(t), frame = 1 / info.fps;
  const keys = {
    ' ': toggle,
    ArrowRight: () => setTime(t + (e.shiftKey ? 1 : 5)),
    ArrowLeft: () => setTime(t - (e.shiftKey ? 1 : 5)),
    // ↑: 今のセクションに入って1秒以上たっていればその頭、そうでなければ1つ前へ
    ArrowUp: () => sections.length && setTime(sections[t - sections[k].from > 1 ? k : Math.max(0, k - 1)].from),
    ArrowDown: () => k + 1 < sections.length && setTime(sections[k + 1].from),
    ',': () => { audio.pause(); setTime(Math.round(t * info.fps) * frame - frame); },
    '.': () => { audio.pause(); setTime(Math.round(t * info.fps) * frame + frame); },
    Home: () => setTime(0),
    h: () => bar.classList.toggle('hidden'), H: () => bar.classList.toggle('hidden'),
  };
  if (!keys[e.key]) return;
  e.preventDefault(); keys[e.key]();
});

// 読み込み直す前の位置に戻る。自動再生が止められたら、クリックで続きから
await new Promise(r => (audio.readyState >= 1 ? r() : audio.addEventListener('loadedmetadata', r, { once: true })));
if (saved.t) { setTime(saved.t); mv.jump(Math.floor(audio.currentTime * info.fps)); }
if (saved.playing) audio.play().then(() => toast('Reloaded')).catch(() => toast('Reloaded (click to resume)', 4000));
else if (saved.t != null) toast('Reloaded');
update();

(async function loop() {
  const target = Math.min(info.frameCount - 1, Math.floor(audio.currentTime * info.fps));
  if (target < mv.next - 1 || target - mv.next > 15) mv.jump(target);
  while (mv.next <= target) await mv.frame(mv.next);
  update();
  requestAnimationFrame(loop);
})();
