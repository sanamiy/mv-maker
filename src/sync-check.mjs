// 合わせ具合を耳と目で確かめるための軽い確認動画を作る（3D は描かないので数秒〜数十秒で終わる）。
// 画面: カラオケ式に色が変わる歌詞、次の行、いまのセクション名、拍の点（小節頭は■）
// 音: 元の曲 + 拍のクリック（小節頭は高い音）。クリックが曲とずれて聞こえたら拍解析が、
//     歌詞の色変わりが歌とずれていたら歌詞の時刻がずれている。
// 使い方: node src/sync-check.mjs song.mp3 analysis.json lyrics.json check.mp4 [--no-click] [--from 秒 --to 秒]
//
// 字幕は FFmpeg の ass フィルタ（libass）で焼く。libass の無い FFmpeg（Homebrew の標準など）では
// ヘッドレス Chromium の canvas に同じ内容を描いて流す（少し遅いが結果は同じ）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toAss, joinParts } from './lyrics.mjs';

const hasAss = () => / ass +V->V/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');

function clickTrack(analysis, file) {
  const SR = 44100, n = Math.ceil(analysis.duration * SR), buf = Buffer.alloc(44 + n * 2);
  const pcm = new Float32Array(n), down = new Set(analysis.downbeats.map(d => d.toFixed(3)));
  for (const b of analysis.beats) {
    const f = down.has(b.toFixed(3)) ? 1760 : 1100, s0 = Math.round(b * SR);
    for (let i = 0; i < 0.03 * SR && s0 + i < n; i++) pcm[s0 + i] += 0.35 * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / SR * 120);
  }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// libass が無いとき用: canvas に1コマずつ描いて JPEG で返す
function drawFrame(t, { lyrics, analysis, width: W, height: H }) {
  const c = window.__c || (window.__c = Object.assign(document.body.appendChild(document.createElement('canvas')), { width: W, height: H }));
  const g = c.getContext('2d'), fs_ = Math.round(H / 14), font = s => `bold ${s}px "Hiragino Sans", "Noto Sans CJK JP", "Helvetica Neue", sans-serif`;
  const find = (arr, key) => { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  g.fillStyle = '#15141f'; g.fillRect(0, 0, W, H);
  g.textBaseline = 'alphabetic';
  const sec = lyrics.sections[find(lyrics.sections, 'from')];
  if (sec) { g.font = `${Math.round(fs_ * 0.6)}px ui-monospace, Menlo, monospace`; g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(`[${sec.label || sec.name}]  from ${sec.from.toFixed(2)}s`, 30, 24 + fs_ * 0.6); }
  const bi = find(analysis.beats);
  if (bi >= 0 && t - analysis.beats[bi] < 0.12) {
    const down = analysis.downbeats.some(d => Math.abs(d - analysis.beats[bi]) < 1e-3), r = fs_ * 0.45;
    g.globalAlpha = 1 - (t - analysis.beats[bi]) / 0.12; g.fillStyle = '#ff8d4d';
    if (down) g.fillRect(W - 30 - 2 * r, 20, 2 * r, 2 * r); else { g.beginPath(); g.arc(W - 30 - r, 20 + r, r, 0, 7); g.fill(); }
    g.globalAlpha = 1;
  }
  const li = find(lyrics.lines, 'start'), line = lyrics.lines[li], next = lyrics.lines[li + 1];
  if (line && t < line.end) {
    g.font = font(fs_);
    const parts = line.parts, total = g.measureText(parts.map(p => p.sep + p.w.text).join('')).width;
    let x = (W - total) / 2, sung = x;
    for (const { sep, w } of parts) {
      x += g.measureText(sep).width;
      const ww = g.measureText(w.text).width;
      if (t >= w.end) sung = x + ww; else if (t >= w.start) sung = x + ww * (t - w.start) / Math.max(1e-3, w.end - w.start);
      x += ww;
    }
    const y = H - H * 0.12 - fs_ * 0.2, x0 = (W - total) / 2, text = parts.map(p => p.sep + p.w.text).join('');
    g.textAlign = 'left'; g.lineWidth = 6; g.strokeStyle = '#000'; g.strokeText(text, x0, y);
    g.fillStyle = '#fff'; g.fillText(text, x0, y);
    g.save(); g.beginPath(); g.rect(0, 0, sung, H); g.clip(); g.fillStyle = '#ffd700'; g.fillText(text, x0, y); g.restore();
  }
  if (next && next.start - t < 3 && next.start > t) {
    g.font = font(Math.round(fs_ * 0.7)); g.textAlign = 'center'; g.fillStyle = '#909090'; g.fillText(next.text, W / 2, H - H * 0.04 - fs_ * 0.1);
  }
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function browserFrames({ lyrics, analysis, width, height, fps, from, end, sink }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const data = { width, height, analysis: { beats: analysis.beats, downbeats: analysis.downbeats }, lyrics: { sections: lyrics.sections, lines: lyrics.lines.map(l => ({ ...l, parts: joinParts(l.text, l.words) })) } };
    await page.evaluate(`window.__d = ${JSON.stringify(data)}; window.__draw = ${drawFrame.toString()};`);
    for (let i = 0, n = Math.ceil((end - from) * fps); i < n; i++) {
      const b64 = await page.evaluate(t => window.__draw(t, window.__d), from + i / fps);
      if (!sink.write(Buffer.from(b64, 'base64'))) await new Promise(r => sink.once('drain', r));
    }
  } finally { await browser.close(); }
}

export async function syncCheck({ audio, analysis, lyrics, output, click = true, from = 0, to = null, width = 960, height = 540 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-sync-'));
  lyrics ||= { version: 1, lines: [], sections: [] };
  const dur = analysis.duration, end = to ?? dur, useAss = !process.env.MV_SYNC_BROWSER && hasAss(), fps = useAss ? 30 : 15;
  try {
    const video = useAss
      ? ['-f', 'lavfi', '-i', `color=c=0x15141f:s=${width}x${height}:r=${fps}:d=${dur}`]
      : ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
    // 映像を先頭(0番)に置き、音は from 秒から切り出して合わせる（ブラウザ描画は from から描くので）
    const inputs = [...video, ...(useAss ? [] : ['-ss', String(from)]), '-i', audio];
    let af = '[1:a]volume=0.8[a]';
    if (click) {
      clickTrack(analysis, path.join(dir, 'click.wav'));
      inputs.push(...(useAss ? [] : ['-ss', String(from)]), '-i', path.join(dir, 'click.wav'));
      af = '[1:a]volume=0.8[m];[2:a]volume=1[c];[m][c]amix=inputs=2:duration=first:normalize=0[a]';
    }
    let vf = '[0:v]null[v]';
    if (useAss) {
      fs.writeFileSync(path.join(dir, 'sub.ass'), toAss(lyrics, { width, height, analysis }));
      vf = '[0:v]ass=sub.ass[v]';
    }
    const args = [
      '-y', '-v', 'error', ...inputs,
      '-filter_complex', `${af};${vf}`,
      '-map', '[v]', '-map', '[a]', ...(useAss ? ['-ss', String(from)] : []), '-t', String(end - from),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest',
      path.resolve(output),
    ];
    const ff = spawn('ffmpeg', args, { cwd: dir, stdio: [useAss ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', code => (code === 0 ? res() : rej(new Error('ffmpeg が失敗しました')))));
    if (!useAss) {
      console.log('（この FFmpeg には libass が無いので、Chromium で字幕を描きます）');
      await browserFrames({ lyrics, analysis, width, height, fps, from, end, sink: ff.stdin });
      ff.stdin.end();
    }
    await done;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-click') opt.noClick = true;
    else if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  // lyrics.json は省略できる（拍だけ確かめたいとき）
  const [audio, analysisPath, ...rest] = pos;
  const lyricsPath = rest.find(p => p.endsWith('.json')), output = rest.find(p => !p.endsWith('.json')) || 'check.mp4';
  if (!audio || !analysisPath) { console.log('使い方: node src/sync-check.mjs song.mp3 analysis.json [lyrics.json] check.mp4 [--no-click] [--from 秒 --to 秒]'); process.exit(1); }
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  await syncCheck({
    audio, analysis: read(analysisPath), lyrics: lyricsPath ? read(lyricsPath) : null, output,
    click: !opt.noClick, from: Number(opt.from || 0), to: opt.to ? Number(opt.to) : null,
  });
  console.log(`→ ${output}`);
}
