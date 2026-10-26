// 合わせ具合を耳と目で確かめるための軽い確認動画を作る（3D は描かないので数秒〜数十秒で終わる）。
// 画面: カラオケ式に色が変わる歌詞、次の行、いまのセクション名、拍の点（小節頭は■）
// 音: 元の曲 + 拍のクリック（小節頭は高い音）。クリックが曲とずれて聞こえたら拍解析が、
//     歌詞の色変わりが歌とずれていたら歌詞の時刻がずれている。
// 使い方: node src/sync-check.mjs song.mp3 analysis.json lyrics.json check.mp4 [--no-click] [--from 秒 --to 秒]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toAss } from './lyrics.mjs';

export function syncCheck({ audio, analysis, lyrics, output, click = true, from = 0, to = null, width = 960, height = 540 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-sync-'));
  const empty = { version: 1, lines: [], sections: [] };
  fs.writeFileSync(path.join(dir, 'sub.ass'), toAss(lyrics || empty, { width, height, analysis }));
  const dur = analysis.duration;
  const inputs = ['-i', audio];
  let af = '[0:a]volume=0.8[a]';
  if (click) {
    const SR = 44100, buf = Buffer.alloc(44 + Math.ceil(dur * SR) * 2), n = Math.ceil(dur * SR);
    const pcm = new Float32Array(n), down = new Set(analysis.downbeats.map(d => d.toFixed(3)));
    for (const b of analysis.beats) {
      const f = down.has(b.toFixed(3)) ? 1760 : 1100, s0 = Math.round(b * SR);
      for (let i = 0; i < 0.03 * SR && s0 + i < n; i++) pcm[s0 + i] += 0.35 * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / SR * 120);
    }
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
    fs.writeFileSync(path.join(dir, 'click.wav'), buf);
    inputs.push('-i', path.join(dir, 'click.wav'));
    af = '[0:a]volume=0.8[m];[1:a]volume=1[c];[m][c]amix=inputs=2:duration=first:normalize=0[a]';
  }
  const end = to ?? dur;
  const args = [
    '-y', '-v', 'error', ...inputs,
    '-f', 'lavfi', '-i', `color=c=0x15141f:s=${width}x${height}:r=30:d=${dur}`,
    '-filter_complex', `${af};[${click ? 2 : 1}:v]ass=sub.ass[v]`,
    '-map', '[v]', '-map', '[a]', '-ss', String(from), '-t', String(end - from),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest',
    path.resolve(output),
  ];
  const r = spawnSync('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('ffmpeg が失敗しました');
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
  syncCheck({
    audio, analysis: read(analysisPath), lyrics: lyricsPath ? read(lyricsPath) : null, output,
    click: !opt.noClick, from: Number(opt.from || 0), to: opt.to ? Number(opt.to) : null,
  });
  console.log(`→ ${output}`);
}
