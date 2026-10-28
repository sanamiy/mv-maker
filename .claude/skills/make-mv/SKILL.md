---
name: make-mv
description: mv-maker で1曲ぶんのMVを作るときの手順（素材の準備・ブリーフ・曲の構成・背景・文字・動き・点検・書き出し）。曲からMVを作る、MVを直す、複数の曲のMVを並行で作るときに使う。
---

# MVを1本作る

1曲 = `songs/<名前>/` の1フォルダ。曲・解析・設定・HTML/CSS・画像・出力は全部その中に置き、ほかの曲のフォルダには触らない。
これを守れば、複数の曲を別々のエージェントで同時に作っても衝突しない。

書き方の細かい決まり（scene.json の項目、`data-start` の書き方、CSS変数、部品のクラス）は README の「書き方」を見る。

## 完成の条件

次をすべて満たすまで「完成」と報告しない。ビルドや書き出しが通っただけでは完成ではない。

- `node src/check.mjs songs/<名前>` がエラー0（注意が残るなら、理由を `out/qa.md` のメモに書く）
- `out/final.mp4` が曲の最後まで書き出されている
- `out/contact.png` を**実際に画像として開いて見た**うえで、`out/qa.md` の目視チェックを埋めた
- 音（拍と動き、歌と歌詞のずれ）は自分では聞けないので、依頼者に `out/final.mp4` を再生して確認してもらうよう頼む

報告では `out/final.mp4`、`out/contact.png`、`out/qa.md` を渡し、直した点と残っている気になる点を書く。

## 手順

### 1. フォルダを作る

```sh
node src/new-song.mjs <名前> --audio <曲ファイル> [--vrm assets/<モデル>.vrm] [--title "曲名"] [--credit "Music: ..."]
```

曲をコピーして解析し（`analysis.json`）、ひな形（`brief.md`・`scene.json`・`background.html`・`texts.html`・`style.css`）を置く。
名前は英数字・`-`・`_` だけ。曲の権利（自作か、使ってよいか）が分からなければ、作り始める前に依頼者に聞く。

### 2. ブリーフを埋める（`brief.md`）

雰囲気・キャラ・色・文字・セクションごとの見せ場を埋める。依頼に書かれていないことは勝手に決めず「未定」にし、
まとめて依頼者に聞く。ただし色やフォントのように後で直せるものは、仮で決めて進め、報告で「仮にこうした」と伝える。
以降の作業で決めたことはブリーフに書き足し、ほかのファイルと食い違わないようにする。

### 3. 曲の構成を決める（`scene.json` の `sections`）

new-song は音量の大きさから仮の区間（`low1` / `mid1` / `high1` …）を作るだけ。
曲の構成（歌詞の見出し、依頼者の説明、`analysis.json` の `segments` と小節頭 `downbeats`）を見て、
`intro` / `verse` / `chorus` / `bridge` / `outro` などの名前に直し、境目を小節頭にそろえる。
`energy`（動きの大きさ、0.3〜1.5）と `expression`（VRMの表情名と強さ）は、ブリーフの見せ場の表に合わせる。
サビが一番 energy が高く、明るい表情になっているのが基本。

### 4. 背景を作る（`background.html` + `style.css`）

何を置くかを HTML に、見た目を CSS に書く。拍や区間に合わせるのは `var(--beat-pulse)`、`var(--beat-phase)`、
`var(--energy)`、`[data-section="chorus"]` を使う（`transition` は使えない。時刻で決まる `animation` か `calc()` で書く）。

画像が要るときは `songs/<名前>/images/` に置いて `<img src="images/...">` で使う（外部URLは読めない）。
手元に画像生成コマンド（例: `codex-imagegen`）があれば、ブリーフの色と雰囲気を伝えて生成し、images/ に保存してよい。
無ければ CSS のグラデーションや図形で描く。生成した画像を使ったら、何で作ったかを `brief.md` に書く。

### 5. 文字を入れる（`texts.html` + `style.css`）

タイトル・クレジット・歌詞・図を、時刻付きの要素として書く。時刻は秒より `bar 9`（9小節目の頭）や
セクション名（`chorus`、`chorus end`）で書くと、曲と合わせやすい。歌詞は1行ずつ `class="lyric"` にし、同じ時刻に2行出さない。
見た目は CSS で、出方は `fade-in` / `pop-in` / `chars-pop`（`data-split="chars"` と一緒に）などの部品を使う。
文字はキャラの顔（画面の上半分の中央）に重ねない。タイトルは上、歌詞は下が基本。

### 6. 動きを付ける（`scene.json` の `character`）

動きの元は、人が作った・人から撮ったモーションデータ（Mixamo、CMU、撮影した動画からの取り込み）にする。
一から振り付けを作らない（関節を数式やキーで回した動きは、人の動きに見えない）。
エージェントの仕事は、曲の区間ごとに合う動きをカタログから選び、なめらかにつなぎ、速さを変えて踏み込みや決めポーズを拍・小節頭に合わせること。

動きは open-vrma の一覧から選ぶ（README「open-vrma の動きを使う」）。区間ごとに次の順で絞る。
1. `node src/motions.mjs search --section <区間> --bpm <analysis.json の tempo> --facing front` で候補を出す（`--energy` で盛り上がりに合わせ、作品の使い道に合わせて `--license` を付ける）
2. 何小節も続く区間は `--loop` で、ループできるものを優先する。ループできない動きは出番より長いものを選ぶか、区間を分けて別の動きをつなぐ
3. 前の区間の動きを `--after <id>` に渡し、姿勢がつながるものを選ぶ
4. scene.json に `{ "use": "clip", "motion": "<id>", "only": ["<区間>"] }` と書き（render / stills / preview が足りない動きを自動で取ってくる。先に取るなら `node src/motions.mjs pull --scene songs/<名前>`）
5. `node src/check.mjs` の動きの警告（テンポが合わない・出番より短い）を直し、出てきたクレジットを概要欄の案に入れる

### 7. 試しに書き出して点検する

```sh
node src/render.mjs songs/<名前>/scene.json songs/<名前>/out/test.mp4 --scale 0.5
node src/check.mjs songs/<名前> --video songs/<名前>/out/test.mp4
```

`out/contact.png`（各区間の頭と中ほど、各文字が出た直後のコマ）を開いて見る。読めない文字、顔に重なる文字、
区間で見た目が変わっていない所、ブリーフの見せ場が無い所を直し、もう一度書き出して点検する。
書き出しは CPU を多く使う（GPU無しで720pなら1秒あたり2〜3コマ）。半分の解像度で試し、確認したい所だけなら `--frames` で短くする。
ブラウザで見たいときは `node src/preview.mjs songs/<名前>/scene.json`（空いているポートを自動で使う）。

### 8. 本番を書き出す

**クラウドの環境（GPU無し）では本番を書き出さない。** SwiftShader だと 720p・2分半の曲で約1時間かかる（P(Doom) で 1.2fps）。
クラウドでは静止画の一覧（`src/stills.mjs`）と、`--scale 0.5 --frames` での短い試し書きまでにし、
本番は依頼者の Mac で `--gl metal` を付けて書き出す（10倍ほど速い）。Mac に頼めないときは、書き出す前に依頼者に聞く。

```sh
node src/render.mjs songs/<名前>/scene.json songs/<名前>/out/final.mp4
node src/check.mjs songs/<名前>
```

エラー0を確かめ、`out/contact.png` を見て `out/qa.md` の目視チェックを埋めてから、「完成の条件」に沿って報告する。

## 複数の曲を同時に作るとき

- 1曲につき1フォルダ・1担当。ほかの曲のフォルダ、`templates/`、`runtime/`、`src/` は曲の作業の中で変更しない
  （フレームワーク自体を直す必要があれば、曲の作業とは分けて依頼者に相談する）
- 書き出しは同時に動かせるが、本数を増やすほど1本あたりは遅くなる。同時に書き出すのは2〜3本までにする
- `songs/` は `.gitignore` 済み（曲や歌詞の権利は各自のもの）。制作物を残したいときは依頼者に確認する
