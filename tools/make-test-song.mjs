// テスト用の合成曲を作る（128BPM・32小節弱）。intro / verse / chorus / outro の構成。
// 使い方: node tools/make-test-song.mjs out.wav
import fs from 'node:fs';

const SR = 44100, BPM = 128, BEAT = 60 / BPM;
const sections = [
  { name: 'intro', bars: 4 },
  { name: 'verse', bars: 4 },
  { name: 'chorus', bars: 8 },
  { name: 'outro', bars: 2 },
];
const totalBeats = sections.reduce((a, s) => a + s.bars * 4, 0);
const N = Math.ceil((totalBeats * BEAT + 1) * SR);
const L = new Float32Array(N), R = new Float32Array(N);
const add = (i, v, pan = 0) => { if (i < N) { L[i] += v * (1 - pan); R[i] += v * (1 + pan); } };
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function kick(t0, g) { const s = Math.floor(t0 * SR); for (let i = 0; i < 0.35 * SR; i++) { const t = i / SR; const f = 45 + 120 * Math.exp(-t * 30); add(s + i, g * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9)); } }
function hat(t0, g) { const s = Math.floor(t0 * SR); for (let i = 0; i < 0.05 * SR; i++) { const t = i / SR; add(s + i, g * rnd() * Math.exp(-t * 80), 0.3); } }
function snare(t0, g) { const s = Math.floor(t0 * SR); for (let i = 0; i < 0.2 * SR; i++) { const t = i / SR; add(s + i, g * (0.7 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 18), -0.1); } }
function tone(t0, dur, freq, g, pan = 0) { const s = Math.floor(t0 * SR); for (let i = 0; i < dur * SR; i++) { const t = i / SR; const env = Math.min(1, t * 50) * Math.exp(-t * 1.5); const saw = 2 * ((freq * t) % 1) - 1; add(s + i, g * env * (0.6 * saw + 0.4 * Math.sin(2 * Math.PI * freq * t)), pan); } }

const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 293.7]];
let beat = 0;
for (const sec of sections) {
  for (let b = 0; b < sec.bars * 4; b++, beat++) {
    const t = beat * BEAT, bar = Math.floor(b / 4), chord = chords[bar % 4];
    if (sec.name === 'intro') { if (b % 2 === 0) kick(t, 0.5); hat(t + BEAT / 2, 0.1); if (b % 4 === 0) chord.forEach(f => tone(t, BEAT * 4, f / 2, 0.04)); }
    if (sec.name === 'verse') { kick(t, 0.7); hat(t + BEAT / 2, 0.15); if (b % 4 === 0) chord.forEach(f => tone(t, BEAT * 4, f, 0.05)); tone(t, BEAT * 0.9, chord[0] / 2, 0.12); }
    if (sec.name === 'chorus') { kick(t, 0.9); hat(t + BEAT / 2, 0.2); hat(t + BEAT / 4 * 3, 0.1); if (b % 2 === 1) snare(t, 0.45); chord.forEach((f, k) => tone(t, BEAT, f * 2, 0.05, k - 1)); tone(t, BEAT * 0.5, chord[0] / 2, 0.18); tone(t + BEAT / 2, BEAT * 0.5, chord[0] / 2, 0.14); }
    if (sec.name === 'outro') { if (b === 0) kick(t, 0.8); if (b % 4 === 0) chord.forEach(f => tone(t, BEAT * 4, f, 0.05)); }
  }
}
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] / peak * 0.9 * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] / peak * 0.9 * 32767), 46 + i * 4); }
fs.writeFileSync(process.argv[2] || 'song.wav', buf);
let acc = 0; console.log(sections.map(s => { const a = acc; acc += s.bars * 4 * BEAT; return `${s.name}: ${a.toFixed(2)}s`; }).join(', '));
