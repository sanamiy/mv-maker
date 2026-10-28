// 音楽ファイルと歌詞から、MV を作るためのデータ一式をフォルダに書き出す（レンダラーとは独立した準備用ツール）。
//
// 使い方:
//   node src/prepare.mjs song.mp3 lyrics.txt -o my-mv/                 # 自動で歌詞の時刻を合わせる（stable-ts があれば）
//   node src/prepare.mjs song.mp3 lyrics.txt -o my-mv/ --timing song.lrc   # 手で打った / 手直しした LRC を使う
//   node src/prepare.mjs song.mp3 -o my-mv/                            # 歌詞なし（拍と盛り上がりだけ）
// オプション:
//   --backend stable-ts|command --command "..." --model small --language en --separate
//                     自動合わせの設定（tools/align_lyrics.py にそのまま渡す。モデルの差し替えは --backend で）
//   --python <パス>   stable-ts の入った Python（省略時は .venv/bin/python → python3 の順に探す）
//   --snap 0.5        行の頭を 8 分の拍に寄せる（0.1 秒以内のときだけ）
//   --vrm <パス>      scene.json に書くキャラ
//   --no-check        確認動画（check.mp4）を作らない
//
// 出力（my-mv/ の中）:
//   song.<拡張子>   音源のコピー
//   analysis.json   拍・小節頭・オンセット・音量・盛り上がり区間（src/analyze.mjs）
//   lyrics.txt      歌詞のコピー（[Verse] などの見出し付き）
//   aligned.json    自動合わせの生の結果（単語ごとの時刻）
//   lyrics.json     行・単語・セクションの時刻（runtime/lyrics.js で読む）
//   lyrics.lrc      行ごとの時刻（src/tap.mjs で手直しできる）
//   lyrics.html     文字レイヤー用の HTML（data-start / data-end 付き）
//   scene.json      シーンの下書き（セクションは歌詞の見出しから。既にあれば上書きしない）
//   check.mp4       合わせ具合の確認動画（歌詞の色変わり + 拍のクリック）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLyrics, loadTiming, toLrc, toHtml, toSceneSections } from './lyrics.mjs';
import { syncCheck } from './sync-check.mjs';

// 歌詞の見た目の下書き。lyrics.html は作り直すたびに上書きされるので、見た目はこちらで変える
const LYRICS_CSS = `.lyric {
  position: absolute; bottom: 9%; width: 100%; text-align: center; margin: 0;
  font-size: 44px; font-weight: bold; color: #fff;
  --edge: #1a1440;
  text-shadow: 3px 0 var(--edge), -3px 0 var(--edge), 0 3px var(--edge), 0 -3px var(--edge),
               2px 2px var(--edge), -2px 2px var(--edge), 2px -2px var(--edge), -2px -2px var(--edge);
}
/* 単語は歌われた瞬間に下からふわっと出る */
.lyric .mv-word { animation: word-in .18s ease-out both; }
@keyframes word-in { from { opacity: 0; translate: 0 12px; } to { opacity: 1; translate: 0 0; } }
.lyric[data-section="chorus"], .lyric[data-section="final-chorus"] { font-size: 56px; --edge: #8a1040; }
`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--separate' || argv[i] === '--no-check') opt[argv[i].slice(2)] = true;
  else if (argv[i].startsWith('-')) opt[argv[i].replace(/^-+/, '')] = argv[++i];
  else pos.push(argv[i]);
}
const [audioIn, lyricsIn] = pos;
if (!audioIn) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport')[0].replace(/^\/\/ ?/gm, '')); process.exit(1); }
const out = path.resolve(opt.o || 'mv-data');
fs.mkdirSync(out, { recursive: true });
const at = f => path.join(out, f);
const step = s => console.log(`\n■ ${s}`);
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${cmd} ${args[0]} が失敗しました`); };

step('音源をコピー');
const audio = at('song' + path.extname(audioIn).toLowerCase());
if (path.resolve(audioIn) !== audio) fs.copyFileSync(audioIn, audio);
console.log(audio);

step('曲を解析（拍・小節頭・音量・盛り上がり）');
run(process.execPath, [path.join(ROOT, 'src/analyze.mjs'), audio, at('analysis.json')]);
const analysis = JSON.parse(fs.readFileSync(at('analysis.json'), 'utf8'));

let lyrics = null;
if (lyricsIn) {
  if (path.resolve(lyricsIn) !== at('lyrics.txt')) fs.copyFileSync(lyricsIn, at('lyrics.txt'));
  let timingFile = opt.timing ? path.resolve(opt.timing) : null;
  if (!timingFile) {
    step('歌詞の時刻を自動で合わせる（手元で実行、APIキー不要）');
    const python = [opt.python, path.join(ROOT, '.venv/bin/python'), 'python3'].find(p => p && (p === 'python3' || fs.existsSync(p)));
    const backend = opt.backend || process.env.MV_ALIGN_BACKEND || 'stable-ts';
    const ok = backend !== 'stable-ts' || spawnSync(python, ['-c', 'import stable_whisper'], { stdio: 'ignore' }).status === 0;
    if (ok) {
      const args = [path.join(ROOT, 'tools/align_lyrics.py'), audio, at('lyrics.txt'), at('aligned.json')];
      args.push('--backend', backend);
      if (opt.command) args.push('--command', opt.command);
      if (opt.model) args.push('--model', opt.model);
      if (opt.language) args.push('--language', opt.language);
      if (opt.separate) args.push('--separate');
      run(python, args);
      timingFile = at('aligned.json');
    } else if (fs.existsSync(at('lyrics.lrc'))) {
      console.log('stable-ts が見つからないので、前回の lyrics.lrc を使います');
      timingFile = at('lyrics.lrc');
    } else {
      console.log(`stable-ts が見つかりません。どちらかで時刻を用意してから、もう一度実行してください:
  自動: python3 -m venv .venv && .venv/bin/pip install stable-ts
  手動: node src/tap.mjs ${audio} ${at('lyrics.txt')} -o ${at('lyrics.lrc')}`);
    }
  }
  if (timingFile) {
    step('歌詞データを作る');
    const timing = loadTiming(timingFile);
    const built = buildLyrics({ text: fs.readFileSync(at('lyrics.txt'), 'utf8'), timing, analysis, snap: Number(opt.snap || 0), hold: timing.lines ? 0 : 0.5 });
    lyrics = built.lyrics;
    fs.writeFileSync(at('lyrics.json'), JSON.stringify(lyrics, null, 1) + '\n');
    // 手直し用の LRC は、自動合わせの結果から作るときだけ書く（手で打った LRC を上書きしない）
    if (path.resolve(timingFile) !== at('lyrics.lrc')) fs.writeFileSync(at('lyrics.lrc'), toLrc(lyrics));
    fs.writeFileSync(at('lyrics.html'), toHtml(lyrics));
    const { coverage, guessedWords, totalWords } = built.report;
    console.log(`${lyrics.lines.length} 行, 文字の一致率 ${(coverage * 100).toFixed(1)}%, 推定で埋めた単語 ${guessedWords}/${totalWords}`);
    for (const s of lyrics.sections) console.log(`  ${s.from.toFixed(2).padStart(7)}s  ${s.label || s.name}`);
  }
}

step('scene.json の下書き');
const hasTags = lyrics && lyrics.sections.some(s => s.label);
if (fs.existsSync(at('scene.json'))) {
  // 手で直したシーンは壊さない。歌詞が後から用意できた場合だけ、歌詞と（自動のままなら）セクションを足す
  const scene = JSON.parse(fs.readFileSync(at('scene.json'), 'utf8'));
  if (lyrics && !scene.lyrics) {
    scene.lyrics = 'lyrics.json';
    if (!(scene.layers || []).some(l => l.src === 'lyrics.html')) scene.layers = [...(scene.layers || []), { src: 'lyrics.html', place: 'front' }];
    if (!(scene.styles || []).includes('lyrics.css')) scene.styles = [...(scene.styles || []), 'lyrics.css'];
    if (!fs.existsSync(at('lyrics.css'))) fs.writeFileSync(at('lyrics.css'), LYRICS_CSS);
    if (scene.sections === 'auto' && hasTags) scene.sections = toSceneSections(lyrics);
    fs.writeFileSync(at('scene.json'), JSON.stringify(scene, null, 2) + '\n');
    console.log('既存の scene.json に歌詞（と見出しからのセクション）を足しました');
  } else console.log('既にあるので上書きしません（セクションだけ欲しいときは: node src/lyrics.mjs export lyrics.json --format sections）');
} else {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/demo/scene.json'), 'utf8'));
  const vrm = opt.vrm ? path.resolve(opt.vrm) : path.join(ROOT, 'assets/test.vrm');
  // デモのレイヤー（背景・文字の HTML）はデモ用なので持ってこない。背景は組み込みのシェーダー、文字は歌詞だけ
  const { layers, styles, ...rest } = base;
  const scene = {
    ...rest,
    audio: path.basename(audio),
    analysis: 'analysis.json',
    background: base.background || { low: '#1d1b3a', high: '#ff4d8d' },
    ...(lyrics ? { lyrics: 'lyrics.json', layers: [{ src: 'lyrics.html', place: 'front' }], styles: ['lyrics.css'] } : {}),
    character: { ...base.character, vrm: path.relative(out, vrm).split(path.sep).join('/') },
    sections: hasTags ? toSceneSections(lyrics) : 'auto',
  };
  if (lyrics && !fs.existsSync(at('lyrics.css'))) fs.writeFileSync(at('lyrics.css'), LYRICS_CSS);
  fs.writeFileSync(at('scene.json'), JSON.stringify(scene, null, 2) + '\n');
  console.log(`${at('scene.json')}（セクション: ${hasTags ? '歌詞の見出しから' : '盛り上がりから自動'}）`);
}

if (!opt['no-check']) {
  step('確認動画を作る（歌詞の色変わり + 拍のクリック）');
  await syncCheck({ audio, analysis, lyrics, output: at('check.mp4') });
  console.log(at('check.mp4'));
}
console.log(`\n完了。書き出し: node src/render.mjs ${path.relative(process.cwd(), at('scene.json'))} out/mv.mp4`);
