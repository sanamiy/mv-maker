# 曲と歌詞に合わせる（準備ツール）

レンダラー（`src/render.mjs`）とは別に、**音楽ファイルと歌詞から MV 用のデータ一式を作る**ツールです。
API キーや有料サービスは使いません（歌詞の自動合わせは Whisper を手元で動かします）。

```sh
node src/prepare.mjs song.mp3 lyrics.txt -o my-mv/
node src/render.mjs my-mv/scene.json out/my-mv.mp4
```

## 何ができるか

| 出力 | 中身 | 使いみち |
|---|---|---|
| `analysis.json` | 拍・小節頭・オンセット・音量・盛り上がり区間 | キャラの動き、背景の脈動 |
| `lyrics.json` | 行と単語ごとの開始・終了時刻、どのセクションか | 歌詞テロップ、口パク、行ごとの演出 |
| `lyrics.lrc` | 行ごとの時刻（一般的な LRC） | 手直し用、他のツールへの持ち出し |
| `lyrics.html` | `data-start` / `data-end` 付きの歌詞 HTML | 文字レイヤー（CSS でカラオケ風の色変わりなど） |
| `scene.json` | シーンの下書き。セクションは歌詞の `[Chorus]` などの見出しから作る | そのまま書き出せる |
| `check.mp4` | 歌詞の色変わり + 拍のクリック音だけの軽い確認動画 | ずれていないか耳と目で確かめる |

## 手順

### 1. 歌詞を用意する

`lyrics.txt` に、Suno / Udio と同じ書き方で書きます。`[ ]` だけの行がセクションの見出しです。

```
[Intro]

[Verse 1]
一行目の歌詞
二行目の歌詞

[Chorus]
サビの歌詞

[Instrumental]

[Outro]
最後の歌詞
```

- 見出しの名前（`verse` / `pre-chorus` / `chorus` / `bridge` / `outro` など）から、`scene.json` のセクションの勢い（energy）と表情の目安が決まります。
- 歌詞の無い見出し（`[Intro]` `[Instrumental]`）も区切りとして使われます（前の歌の終わりの次の小節頭から）。
- 英語でも日本語でも大丈夫です。日本語は1文字ずつ時刻が付きます。

### 2. 歌詞の時刻を合わせる

**自動（おすすめ）** — Whisper で歌詞を音に合わせます。初回だけ準備が要ります。

```sh
python3 -m venv .venv && .venv/bin/pip install stable-ts
.venv/bin/pip install demucs        # 任意: ボーカルを抜き出してから合わせる（伴奏が厚い曲で精度が上がる）
```

これで `prepare.mjs` が自動で使います。オプションは `--model small`（既定。歌詞は手元にあるので聞き取りの精度はそれほど要らない。`medium` / `large-v3` はより正確で重い）、
`--language en`、`--separate`（demucs を使う）。初回はモデル（small で約0.5GB）をダウンロードします。

**モデルの差し替え** — 合わせ処理は `--backend` で切り替えられます。

- `--backend stable-ts`（既定）: Whisper
- `--backend command --command "my-aligner {audio} {lyrics} {output}"`: 好きな外部ツールに任せる。`{output}` に `{"words":[{"text","start","end"}]}` を書いてくれれば何でも使えます
- 新しいモデルを組み込むときは `tools/align_lyrics.py` の `BACKENDS` に関数を1つ足すだけです。出力の形が同じなら、後段は何も変えずに使えます

**手動（タップ）** — 自動がうまくいかない所の手直しや、自分で打ちたいとき。

```sh
node src/tap.mjs my-mv/song.mp3 my-mv/lyrics.txt -o my-mv/lyrics.lrc
# → 表示された URL を開き、曲を流しながら各行の歌い出しで Space、行の終わりで Enter。Ctrl+S で保存
node src/prepare.mjs song.mp3 lyrics.txt -o my-mv/ --timing my-mv/lyrics.lrc
```

自動合わせのあとの `lyrics.lrc` を開けば、その時刻から微調整できます（`,` `.` で 0.05 秒ずつ）。
既に LRC を持っていれば、それを `--timing` に渡すだけでも使えます。

### 3. 確かめる

`my-mv/check.mp4` を再生します。
- **クリック音が曲の拍とずれる** → 拍解析の問題（`analysis.json`）
- **歌詞の色変わりが歌とずれる** → 歌詞の時刻の問題 → タップで手直し
- 左上のセクション名が切り替わる所が、曲の構成の区切りです

ずれを直したら、同じ `prepare.mjs` をもう一度実行すれば全部作り直されます（手で直した `scene.json` は上書きしません）。

## 部品を個別に使う

```sh
node src/lyrics.mjs build lyrics.txt --timing aligned.json|song.lrc -o lyrics.json [--analysis analysis.json] [--snap 0.5]
node src/lyrics.mjs export lyrics.json --format lrc|lrc-words|html|ass|sections
node src/sync-check.mjs song.mp3 analysis.json [lyrics.json] check.mp4 [--from 30 --to 60]
.venv/bin/python tools/align_lyrics.py song.mp3 lyrics.txt aligned.json [--separate]
```

- `--snap 0.5` は行の頭を8分の拍に寄せます（0.1 秒以内のときだけ）。テロップを拍ぴったりに出したいとき用。
- `--timing` は WhisperX / stable-ts の JSON もそのまま読めます。歌詞テキストとは1文字ずつ突き合わせるので、聞き取り違いが少しあっても対応が付きます（結果の「文字の一致率」が目安）。

### 文字レイヤーで使う

`lyrics.html` は文字レイヤー（scene.json の `"layers"`）の決まりに合わせてあり、`prepare.mjs` が作る `scene.json` には最初から
`{ "src": "lyrics.html", "place": "front" }` が入っています。

```html
<p class="lyric" data-section="chorus" data-start="15.050" data-end="17.500">
  <span class="mv-word" data-start="15.050" data-end="17.500" data-word-end="15.500">Boom</span> …
</p>
```

- 行（`.lyric`）は歌っている間だけ表示されます。
- 単語（`.mv-word`）は歌われた瞬間に現れ、行の終わりまで残ります（本来の単語の終わりは `data-word-end`）。
- 表示中の要素には `--local-t`（表示からの秒）/ `--remain` / `--progress`（0→1）が入るので、CSS の animation で出方を書けます。
- 見た目を変えたいときは HTML ではなく CSS を書きます。HTML は作り直しても上書きされるので手で直さないでください。

スクリプトから時刻で歌詞を引きたいときは `runtime/lyrics.js` を使います。

```js
import { lyricAt, sectionAt } from './lyrics.js';
const s = lyricAt(t, lyrics);   // { line, index, progress, word, wordIndex, wordProgress, prev, next, sinceStart, untilNext }
```

## 音源と歌詞について

音源ファイルはこのツールでは取得しません。手元にある、使ってよい音源を渡してください。
