// node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { musicAt, applyMeter, windowWeight, applyExpressionCues, buildSections } from '../runtime/timeline.js';
import { parseTime } from '../runtime/layers.js';

const beats = Array.from({ length: 48 }, (_, i) => i * 0.5);
const analysis = { duration: 24, tempo: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), envelope: { rate: 100, loudness: [0.5], onset: [0] }, segments: [] };
const sections = [
  { from: 0, name: 'verse', energy: 0.5, expression: { relaxed: 1 } },
  { from: 8, name: 'chorus', energy: 1.4, cameraEnergy: 0.2, expression: { happy: 1 } },
  { from: 16, name: 'outro', energy: 0.3, fade: 0, expression: {} },
];

test('cameraEnergy / lightEnergy は書かなければ energy と同じ', () => {
  const m = musicAt(4, analysis, sections);
  assert.equal(m.cameraEnergy, m.energy);
  assert.equal(m.lightEnergy, m.energy);
});

test('cameraEnergy を書いたセクションではカメラだけ別の値になる', () => {
  const m = musicAt(12, analysis, sections);
  assert.equal(m.energy, 1.4);
  assert.equal(m.cameraEnergy, 0.2);
  assert.equal(m.lightEnergy, 1.4);
});

test('セクションの fade: 既定は 0.4 秒で混ざり、0 ならすぐ切り替わる', () => {
  const mid = musicAt(8.2, analysis, sections);
  assert.ok(mid.energy > 0.5 && mid.energy < 1.4);
  assert.ok(Math.abs(musicAt(16.01, analysis, sections).energy - 0.3) < 1e-9);
});

test('既定の 4 拍子では今までと同じ値（beatInBar も出る）', () => {
  const m = musicAt(2.75, analysis, sections);
  assert.equal(m.beatsPerBar, 4);
  assert.equal(m.barIndex, 1);
  assert.equal(m.beatInBar, 1);
  assert.equal(applyMeter(analysis, {}), analysis);
});

test('beatsPerBar: 3 で小節頭が 3 拍ごとになり、bar の時刻もそれに従う', () => {
  const a3 = applyMeter(analysis, { beatsPerBar: 3 });
  assert.deepEqual(a3.downbeats.slice(0, 3), [0, 1.5, 3]);
  const ctx = { analysis: a3, sections, duration: 24 };
  assert.equal(parseTime('bar 3', ctx), 3);
  assert.equal(musicAt(3.6, a3, sections).beatInBar, 1);
  // firstDownbeat で小節頭をずらせる（2 拍目から）
  assert.equal(applyMeter(analysis, { beatsPerBar: 3, firstDownbeat: 2 }).downbeats[0], 0.5);
});

test('windowWeight: 窓の外は 0、中は 1、fade の分だけなめらかに', () => {
  assert.equal(windowWeight(1, 2, 4), 0);
  assert.equal(windowWeight(3, 2, 4), 1);
  assert.equal(windowWeight(4, 2, 4), 0);
  const w = windowWeight(2.1, 2, 4, 0.2);
  assert.ok(w > 0 && w < 1);
  assert.equal(windowWeight(100, 2, Infinity, 0.2), 1);
});

test('表情のキュー: 出ているあいだ set の表情に寄せ、ほかは弱める（keep で残す）', () => {
  const base = { happy: 1 };
  const cues = [{ start: 2, end: 3, set: { surprised: 1 }, fade: 0 }];
  assert.deepEqual(applyExpressionCues(base, cues, 1), base);
  assert.deepEqual(applyExpressionCues(base, cues, 2.5), { happy: 0, surprised: 1 });
  assert.deepEqual(applyExpressionCues(base, [{ ...cues[0], keep: true }], 2.5), { happy: 1, surprised: 1 });
  assert.deepEqual(base, { happy: 1 }); // 元は書き換えない
});

test('buildSections は今までどおり', () => {
  assert.equal(buildSections({ sections }, analysis)[1].name, 'chorus');
});

test('html-karaoke: 単語に data-keep が付き、行に karaoke クラスが付く（既定の html は今までどおり）', async () => {
  const { toHtml } = await import('../src/lyrics.mjs');
  const lyrics = { lines: [{ start: 1, end: 3, text: 'a b', section: 'verse', words: [{ start: 1, end: 1.5, text: 'a' }, { start: 2, end: 2.8, text: 'b' }] }], sections: [] };
  const k = toHtml(lyrics, { karaoke: true });
  assert.match(k, /class="lyric karaoke"/);
  assert.match(k, /<span class="mv-word" data-keep data-start="2.000" data-end="2.800">b<\/span>/);
  assert.doesNotMatch(toHtml(lyrics), /data-keep|karaoke/);
});
