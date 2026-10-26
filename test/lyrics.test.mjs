// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLyricsText, parseLrc, alignWords, buildLyrics, splitWords, toHtml, toLrc } from '../src/lyrics.mjs';
import { lyricAt } from '../runtime/lyrics.js';

const TEXT = `[Intro]

[Verse 1]
Hello brave new world
we are counting the stars

[Chorus]
きらきら光る
`;
const analysis = { duration: 30, beats: Array.from({ length: 60 }, (_, i) => i * 0.5), downbeats: Array.from({ length: 15 }, (_, i) => i * 2) };

test('見出しと行を読む', () => {
  const { lines, sections } = parseLyricsText(TEXT);
  assert.deepEqual(sections.map(s => s.name), ['intro', 'verse', 'chorus']);
  assert.equal(lines.length, 3);
  assert.equal(lines[2].section, 2);
  assert.deepEqual(splitWords('きらきら光る'), ['き', 'ら', 'き', 'ら', '光', 'る']);
});

test('聞き取り違いがあっても単語に時刻が付く', () => {
  const tokens = [{ text: 'Hello', start: 1, end: 1.4 }, { text: 'grave', start: 1.4, end: 1.8 }, { text: 'world', start: 2.2, end: 3 }];
  const { words } = alignWords(['Hello', 'brave', 'new', 'world'], tokens);
  assert.equal(words[0].start, 1);
  assert.ok(words[1].start >= 1.4 && words[1].start < 1.8);
  assert.ok(words[2].guessed && words[2].start >= words[1].end - 1e-9 && words[2].end <= 2.2 + 1e-9);
  assert.equal(words[3].start, 2.2);
});

test('LRC から作り、セクションは手前の小節頭に揃う', () => {
  const lrc = '[00:07.90]Hello brave new world\n[00:10.00]\n[00:11.00]we are counting the stars\n[00:16.10]きらきら光る\n[00:19.00]\n';
  const { lyrics, report } = buildLyrics({ text: TEXT, timing: parseLrc(lrc), analysis, hold: 0 });
  assert.equal(report.coverage, 1);
  assert.deepEqual(lyrics.lines.map(l => [l.start, l.end]), [[7.9, 10], [11, 16.1], [16.1, 19]]);
  assert.deepEqual(lyrics.sections.map(s => [s.name, s.from]), [['intro', 0], ['verse', 8], ['chorus', 16]]);
  assert.match(toHtml(lyrics), /data-start="16.100"[^>]*>き<\/span><span/); // 日本語は単語間に空白を入れない
  assert.match(toLrc(lyrics), /^\[00:07\.90\]Hello brave new world\n\[00:10\.00\]\n/);
});

test('lyricAt', () => {
  const lyrics = { lines: [{ start: 1, end: 3, text: 'a b', words: [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 3, text: 'b' }] }, { start: 5, end: 6, text: 'c', words: [] }] };
  assert.equal(lyricAt(0.5, lyrics).line, null);
  assert.equal(lyricAt(0.5, lyrics).next.text, 'a b');
  const s = lyricAt(2.5, lyrics);
  assert.equal(s.index, 0); assert.equal(s.word.text, 'b'); assert.equal(s.progress, 0.75); assert.equal(s.wordProgress, 0.5);
  assert.equal(lyricAt(4, lyrics).prev.text, 'a b');
});
