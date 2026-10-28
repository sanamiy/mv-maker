// HTML/CSS で書いた背景・文字・図を、フレームごとに決定的に canvas へ描く。
//
// 仕組み:
// - レイヤーのHTMLは、ページ内の見えない場所（display:none）に置いた「生きたDOM」として持つ。
//   ここでは時刻に応じた表示/非表示とCSS変数を更新し、getComputedStyle でアニメーションの指定だけを読む。
// - 各要素のアニメーションは「いつ始まったか」を自前で記録し、
//   animation-play-state: paused + 負の animation-delay で「今その瞬間の見た目」に固定する。
// - それを SVG の foreignObject に入れて画像化し、canvas に描く。レイアウトと描画はブラウザ自身に任せるので、
//   普通の HTML/CSS（グラデーション、フィルター、変形、Webフォント…）がそのまま使える。
// 実時間には依存しないので、同じフレーム番号なら必ず同じ絵になる。

const XHTML = 'http://www.w3.org/1999/xhtml';

const toDataUrl = async url => {
  const blob = await (await fetch(url)).blob();
  return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
};

// CSS 内の url(...) を data URL に置き換える（SVG画像の中からは外部ファイルを読めないため）
async function inlineCssUrls(css, base) {
  const urls = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(m => m[2]).filter(u => !u.startsWith('data:')))];
  for (const u of urls) {
    const data = await toDataUrl(new URL(u, base).href);
    css = css.split(u).join(data);
  }
  return css;
}

// "15.2" / "1:23.5" / "bar 8" / "beat 32" / "chorus" / "chorus#2" / "chorus end" / "+2.5"（data-end のみ、開始からの相対）
export function parseTime(spec, ctx, relativeTo = null) {
  if (spec == null || spec === '') return null;
  const s = String(spec).trim();
  let m;
  if ((m = s.match(/^\+\s*([\d.]+)$/)) && relativeTo != null) return relativeTo + Number(m[1]);
  if ((m = s.match(/^(\d+):([\d.]+)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if (/^[\d.]+$/.test(s)) return Number(s);
  if ((m = s.match(/^bar\s+([\d.]+)$/i))) return gridTime(ctx.analysis.downbeats, Number(m[1]) - 1, 60 / ctx.analysis.tempo * 4);
  if ((m = s.match(/^beat\s+([\d.]+)$/i))) return gridTime(ctx.analysis.beats, Number(m[1]) - 1, 60 / ctx.analysis.tempo);
  if ((m = s.match(/^([\w-]+)(?:#(\d+))?(\s+end)?$/))) {
    const list = ctx.sections.map((sec, i) => ({ ...sec, i })).filter(sec => sec.name === m[1]);
    const sec = list[(Number(m[2]) || 1) - 1];
    if (!sec) throw new Error(`unknown section in time "${s}"`);
    return m[3] ? (ctx.sections[sec.i + 1]?.from ?? ctx.duration) : sec.from;
  }
  throw new Error(`cannot parse time "${s}"`);
}
function gridTime(grid, idx, period) {
  if (!grid.length) return idx * period;
  const i = Math.floor(idx), f = idx - i;
  const at = k => (k < grid.length ? grid[k] : grid.at(-1) + (k - grid.length + 1) * period);
  return at(i) + (at(i + 1) - at(i)) * f;
}

function splitText(el, mode) {
  let i = 0;
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = mode === 'words' ? child.textContent.split(/(\s+)/) : [...child.textContent];
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (!p) continue;
          if (/^\s+$/.test(p) && mode === 'words') { frag.append(p); continue; }
          const span = document.createElement('span');
          span.className = mode === 'words' ? 'mv-word' : 'mv-ch';
          span.style.setProperty('--i', i++);
          span.textContent = p;
          frag.append(span);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    }
  };
  walk(el);
  el.style.setProperty('--n', i);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const parseSeconds = v => (v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v) || 0);

export class HtmlLayers {
  async load({ layers, styles = [], baseUrl, runtimeCss, width, height, outWidth, outHeight, ctx }) {
    this.width = width; this.height = height; this.outWidth = outWidth; this.outHeight = outHeight;
    let css = await inlineCssUrls(await (await fetch(runtimeCss)).text(), runtimeCss);
    for (const s of styles) { const u = new URL(s, baseUrl).href; css += '\n' + await inlineCssUrls(await (await fetch(u)).text(), u); }

    // 生きたDOMは Shadow DOM に入れて、ユーザーのCSSがこのページ自体に効かないようにする
    this.host = document.createElement('div');
    this.host.style.display = 'none';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.liveStyle = document.createElement('style');
    this.stage = document.createElement('div');
    this.stage.className = 'mv-stage';
    this.shadow.append(this.liveStyle, this.stage);
    document.body.append(this.host);

    this.layers = [];
    for (const def of layers) {
      const url = new URL(def.src, baseUrl).href;
      const doc = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html');
      for (const st of doc.querySelectorAll('style')) { css += '\n' + await inlineCssUrls(st.textContent, url); st.remove(); }
      for (const ln of doc.querySelectorAll('link[rel=stylesheet]')) { const u = new URL(ln.getAttribute('href'), url).href; css += '\n' + await inlineCssUrls(await (await fetch(u)).text(), u); ln.remove(); }
      for (const img of doc.querySelectorAll('img[src], image[href], source[src]')) {
        const attr = img.hasAttribute('src') ? 'src' : 'href';
        img.setAttribute(attr, await toDataUrl(new URL(img.getAttribute(attr), url).href));
      }
      for (const el of doc.querySelectorAll('[style*="url("]')) el.setAttribute('style', await inlineCssUrls(el.getAttribute('style'), url));
      for (const el of doc.querySelectorAll('[data-split]')) splitText(el, el.dataset.split);
      const root = document.createElement('div');
      root.dataset.layer = def.place ?? 'front';
      root.append(...doc.body.childNodes);
      this.stage.append(root);

      const timed = [...root.querySelectorAll('[data-start], [data-end]')].map(el => {
        const start = parseTime(el.dataset.start, ctx) ?? 0;
        const end = parseTime(el.dataset.end, ctx, start) ?? Infinity;
        return { el, start, end };
      });
      const all = [...root.querySelectorAll('*')].map(el => ({ el, baseStyle: el.getAttribute('style'), anim: null, origin: 0 }));
      this.layers.push({ def, root, timed, all, place: root.dataset.layer, canvas: null, last: '' });
    }
    this.liveStyle.textContent = css;
    this.styleXml = `<style>${css.replace(/</g, '\\3c ')}</style>`;
    for (const l of this.layers) {
      l.canvas = document.createElement('canvas');
      l.canvas.width = outWidth; l.canvas.height = outHeight;
      l.ctx2d = l.canvas.getContext('2d');
    }
    return this.layers;
  }

  // m: musicAt() の結果。終わると各レイヤーの canvas が最新になる（変化が無ければ描き直さない）
  async update(m) {
    const t = m.t, st = this.stage;
    const vars = {
      '--t': t, '--beat': m.beatPos, '--beat-phase': m.beatPhase, '--beat-pulse': m.beatPulse, '--beat-index': m.beatIndex,
      '--bar': m.barPos, '--bar-phase': m.barPhase, '--bar-index': m.barIndex,
      '--energy': m.energy, '--loudness': m.loudness, '--onset': m.onset,
    };
    st.setAttribute('style', `width:${this.width}px;height:${this.height}px;` + Object.entries(vars).map(([k, v]) => `${k}:${+v.toFixed(4)}`).join(';'));
    st.dataset.section = m.section ?? '';

    for (const l of this.layers) {
      // 1) 元のインライン指定に戻し、時刻に応じた表示/非表示と要素ごとの時間変数を入れる
      for (const a of l.all) { if (a.baseStyle == null) a.el.removeAttribute('style'); else a.el.setAttribute('style', a.baseStyle); }
      for (const { el, start, end } of l.timed) {
        const on = t >= start && t < end;
        el.toggleAttribute('data-mv-hidden', !on);
        if (on) {
          el.style.setProperty('--local-t', +(t - start).toFixed(4));
          el.style.setProperty('--remain', +(Math.min(end - t, 1e4)).toFixed(4));
          el.style.setProperty('--progress', Number.isFinite(end) ? +((t - start) / (end - start)).toFixed(4) : 0);
        }
      }
      // 2) まとめて読む（読み書きを交互にすると毎回スタイル再計算が走るため）
      const reads = l.all.map(a => {
        const hidden = a.el.closest('[data-mv-hidden]') !== null;
        if (hidden) return { hidden };
        const cs = getComputedStyle(a.el);
        return { hidden, name: cs.animationName, delay: cs.animationDelay };
      });
      // 3) アニメーションを「始まってから経った時間」の見た目に固定する
      l.all.forEach((a, k) => {
        const r = reads[k];
        if (r.hidden || r.name === 'none') { a.anim = null; return; }
        if (r.name !== a.anim) { a.anim = r.name; a.origin = t; }
        const elapsed = t - a.origin;
        a.el.style.animationDelay = r.delay.split(',').map(d => `${(parseSeconds(d) - elapsed).toFixed(4)}s`).join(',');
        a.el.style.animationPlayState = 'paused';
      });
      // 4) SVG 画像にして描く
      const body = new XMLSerializer().serializeToString(l.root);
      const xml = `<div xmlns="${XHTML}" class="mv-stage" data-section="${esc(st.dataset.section)}" style="${esc(st.getAttribute('style'))}">${this.styleXml}${body}</div>`;
      if (xml === l.last) continue;
      l.last = xml;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.outWidth}" height="${this.outHeight}" viewBox="0 0 ${this.width} ${this.height}"><foreignObject x="0" y="0" width="${this.width}" height="${this.height}">${xml}</foreignObject></svg>`;
      const img = new Image();
      // blob: URL だと canvas が「汚染」扱いになり WebGL に渡せないので data: URL にする
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      l.ctx2d.clearRect(0, 0, this.outWidth, this.outHeight);
      l.ctx2d.drawImage(img, 0, 0, this.outWidth, this.outHeight);
      l.dirty = true;
    }
  }
}
