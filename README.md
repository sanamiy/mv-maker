# mv-maker

音楽に合わせて VRM キャラクターが動く MV を mp4 で書き出す、軽量なフレームワークです。

- キャラは VRM（three.js + @pixiv/three-vrm）
- シーンは JSON で宣言的に書く（どのモーションを使うか、どこがサビで何の表情か）
- 曲は事前に解析して `analysis.json`（拍・小節頭・オンセット・音量包絡・盛り上がり区間）にしておく
- 書き出しはヘッドレス Chromium で canvas 1枚だけを描き、フレーム時刻を `1/fps` ずつ決定的に進め、生ピクセルを WebSocket で受けて FFmpeg の stdin に流す（PNG化もスクショもしない）
- Mac は Metal、Windows は Direct3D 11 の GPU で描き、CPU のコア数に合わせて複数のブラウザで区間を分けて同時に描く
- SpringBone（髪・服の揺れ）は 0 フレーム目から順に積み上げるので、何度書き出しても同じ映像になる

## 必要なもの

- Node.js 24 以上（`.nvmrc` あり。`nvm use` で合わせられます）
- FFmpeg（`ffmpeg` にパスが通っていること）
- `npx playwright install chromium`（初回のみ）

## 試す

```sh
npm install
npx playwright install chromium
npm run demo        # テスト曲の生成 → サンプルVRM取得 → 解析 → out/demo.mp4
```

## 自分の曲で作る

1曲ごとに `songs/<名前>/` のフォルダを作って、その中で作業します（`songs/` は `.gitignore` 済み）。
曲ごとにフォルダが分かれているので、複数の曲を同時に作れます（書き出しも並行で動きます）。

```sh
node src/new-song.mjs my-song --audio ~/Music/my-song.mp3 --title "曲名" --credit "Music: ..."
#   → songs/my-song/ に曲のコピー・解析結果・brief.md・scene.json・背景/文字/CSS のひな形ができる
node src/preview.mjs songs/my-song/scene.json            # ブラウザで音付きプレビュー（空いているポートを自動で使う）
node src/render.mjs songs/my-song/scene.json songs/my-song/out/test.mp4 --scale 0.5   # 半分の解像度で試し書き
node src/check.mjs songs/my-song                         # 点検 → out/qa.md と out/contact.png（要所のコマ一覧）
node src/render.mjs songs/my-song/scene.json songs/my-song/out/final.mp4             # 本番
```

エージェントに作ってもらうときの手順と完成の条件は [`.claude/skills/make-mv/SKILL.md`](.claude/skills/make-mv/SKILL.md)
（入口は [`AGENTS.md`](AGENTS.md)）にあります。

| コマンド | すること |
|---|---|
| `src/new-song.mjs <名前> [--audio 曲] [--vrm モデル] [--title] [--credit]` | 1曲ぶんの作業フォルダを作る。曲を渡すと解析して、セクションの下書きも作る |
| `src/analyze.mjs <曲> <analysis.json>` | 曲を解析する（拍・小節頭・音量・盛り上がり区間） |
| `src/preview.mjs <scene.json>` | ブラウザで音付きプレビュー。下のバーでシーク・セクションの頭へジャンプ（↑↓ でも）。scene.json や HTML/CSS を保存すると、再生位置はそのままで自動で読み込み直す |
| `src/render.mjs <scene.json> <out.mp4> [--scale 0.5] [--frames N] [--workers N] [--encoder hw]` | mp4 に書き出す（Mac / Windows では GPU を使い、複数のブラウザで並列に描く。下の「書き出しの速さ」） |
| `src/stills.mjs <scene.json> <sheet.png> [--every 4]` | 4秒ごとなどの静止画の一覧（書き出し前の確認用） |
| `src/check.mjs <フォルダ> [--video 動画]` | 素材・時刻・セクションの点検と、要所のコマ一覧・QA記録の作成。エラーがあれば終了コード 1 |

### 書き出しの速さ

既定（`--gl auto --workers auto`）で、Mac は Metal、Windows は Direct3D 11 の GPU を使い、CPU のコア数に合わせて複数のブラウザで区間を分けて同時に描きます。
各ブラウザは担当区間の頭まで「描かずに動きだけ進める」ので、1 個で頭から描いたときと同じ絵になります。

```sh
node src/render.mjs my/scene.json out/my.mp4 --workers 1          # 並列にしない
node src/render.mjs my/scene.json out/my.mp4 --gl swiftshader     # GPU を使わない（どの PC でも同じ絵。とても遅い）
node src/render.mjs my/scene.json out/my.mp4 --encoder hw         # エンコードも GPU（Mac: VideoToolbox、Windows: NVENC / QSV / AMF）
```

M1 MacBook（8コア）で 720p・30fps・HTML レイヤー3枚の曲（約4,200フレーム）の目安:

| 設定 | 速さ |
|---|---|
| 以前の既定（swiftshader） | 約 1 fps（約 1 時間） |
| 以前の `--gl metal` | 約 13 fps（約 5 分半） |
| 今の既定（M1 では 2 並列） | 約 27 fps（約 2 分半） |
| 今の `--workers 1` | 約 20 fps（約 3 分半） |

Windows（Direct3D 11・NVENC / QSV / AMF）はまだ実機で試していません。うまく動かないときは `--gl swiftshader` や `--encoder x264` に戻せます。

エンコード（libx264）は 400fps 以上出るので、ほとんど待ち時間になりません。`--encoder hw` は CPU を描画側に回したいときや、高解像度のときに使ってください。
GPU が無い環境（クラウド等）では CPU で描くことになり、10 秒を超える書き出しは止まります（`--allow-cpu` で続行）。
本番の書き出しは GPU のある実機（Mac / Windows / レンダリング用 PC）で行い、クラウドでは静止画の一覧や 10 秒までの短い確認だけにしてください（[AGENTS.md](AGENTS.md)）。

## 書き方

1本のMVは、次のファイルでできています（例: `examples/demo/`）。

| ファイル | 書くこと |
|---|---|
| `scene.json` | 曲・キャラ・カメラ・曲の構成（どこがサビか）と、使うレイヤーの一覧 |
| `background.html` | 背景に置くもの（キャラの後ろ） |
| `texts.html` | 歌詞・タイトル・図など（キャラの手前） |
| `style.css` | 見せ方。背景も文字も同じCSSで書く |

HTMLには「何を・いつ出すか」だけ、CSSには「どう見せるか」だけを書きます。どちらも普通のHTML/CSSです。

### scene.json

パスはすべて scene.json からの相対パスです。

```jsonc
{
  "width": 1280, "height": 720, "fps": 30,
  "audio": "song.wav",
  "analysis": "analysis.json",
  "layers": [
    { "src": "background.html", "place": "back" },   // キャラの後ろ
    { "src": "texts.html",      "place": "front" }   // キャラの手前
  ],
  "styles": ["style.css"],
  // "background": { "low": "#1d1b3a", "high": "#ff4d8d" },  // HTMLを使わず、組み込みのシェーダー背景にする場合
  "camera": { "position": [0, 1.3, 2.6], "target": [0, 1.05, 0], "fov": 30, "beatZoom": 0.04, "orbit": 0.3 },
  "character": {
    "vrm": "../../assets/test.vrm",
    "motions": [                       // 上から順に重ねがけされる
      { "use": "idle" },
      { "use": "bounce", "amount": 0.03 },
      { "use": "sway", "amount": 0.07 },
      { "use": "headNod", "amount": 0.12 },
      { "use": "armSwing", "amount": 0.45 },
      { "use": "blink" }
    ]
  },
  // 曲の構成。energy は動きの大きさの倍率、expression は VRM の表情名と強さ。境目では 0.4 秒かけて混ざる。
  // "sections": "auto" にすると解析結果の盛り上がり（low / mid / high）から自動で作る。
  "sections": [
    { "from": 0,   "name": "intro",  "energy": 0.4, "expression": { "relaxed": 0.5 } },
    { "from": 7.5, "name": "verse",  "energy": 0.8, "expression": {} },
    { "from": 15,  "name": "chorus", "energy": 1.4, "expression": { "happy": 1 } },
    { "from": 30,  "name": "outro",  "energy": 0.3, "expression": { "relaxed": 0.7 } }
  ]
}
```

### HTML（何を・いつ出すか）

```html
<h1 class="title zoom-in fade-out" data-start="0.5" data-end="6.5">mv-maker demo</h1>
<p class="lyric chars-pop fade-out" data-split="chars" data-start="chorus" data-end="+3.6">いま 光の中で</p>
<p class="lyric" data-start="bar 11" data-end="bar 13">踊ろう 朝まで</p>
<div class="badge" data-start="chorus" data-end="chorus end">CHORUS</div>
<img src="logo.png" class="pop-in" data-start="1:02.5">
```

- `data-start` / `data-end` の書き方: 秒（`15.2`）、分:秒（`1:02.5`）、小節（`bar 11`＝11小節目の頭）、拍（`beat 32`）、
  セクション名（`chorus`、2回目なら `chorus#2`、終わりは `chorus end`）。`data-end` は `+3.6` で開始からの秒数も書ける
- 時刻指定の無い要素はずっと表示される（背景など）
- `data-split="chars"`（または `words`）で1文字ずつ `<span class="mv-ch" style="--i:番号">` に分かれるので、1文字ずつのアニメーションが書ける
- 画像（PNG/JPG/SVG）、インラインSVG、CSSの `background: url(...)`、`@font-face` のフォントも使える

### CSS（どう見せるか）

普通のCSSです。`@keyframes` のアニメーションは、その要素が表示された瞬間から再生されます。
それに加えて、mv-maker が毎フレーム次の値を入れるので、音楽に合わせた見た目を `calc()` で書けます。

| 変数 / 属性 | 中身 |
|---|---|
| `--t` | 曲の経過秒 |
| `--beat` / `--beat-phase` / `--beat-pulse` | 何拍目か（小数込み） / 拍の中の位置 0→1 / 拍の頭で1→すぐ0になるパルス |
| `--bar` / `--bar-phase` | 何小節目か / 小節の中の位置 |
| `--energy` / `--loudness` / `--onset` | セクションの energy / 音量 0〜1 / 音の立ち上がり 0〜1 |
| `--local-t` / `--remain` / `--progress` | （時刻指定した要素のみ）表示されてからの秒 / 消えるまでの秒 / 0→1 |
| `[data-section="chorus"]` | 今のセクション名。`[data-section="chorus"] .lyric { ... }` のように使う |

```css
.lyric { font-size: 44px; scale: calc(1 + var(--beat-pulse) * .1); }
[data-section="chorus"] .sky { background: radial-gradient(#ff7aa8, #2a0a2e); }
.ring { scale: var(--beat-phase); opacity: calc(1 - var(--beat-phase)); }
```

最初から使える部品（`runtime/mv.css`）:

| クラス | 内容 |
|---|---|
| `fade-in` `pop-in` `slide-up` `slide-left` `zoom-in` `blur-in` | 出方 |
| `chars-pop` `chars-fade` `chars-drop` | `data-split="chars"` と組み合わせて1文字ずつ（間隔は `--stagger`） |
| `fade-out` | `data-end` の `--out-dur`（既定 0.3 秒）前から消える |
| `beat-pulse` `beat-flash` `beat-sway` `beat-bob` | 拍に合わせて拡大 / 点滅 / 揺れ / 跳ねる（強さは `--amount`） |

### カメラのショット・照明・床

```jsonc
"camera": { "position": [0, 1.3, 5], "target": [0, 1.15, 0], "fov": 30, "orbit": 0.35,
  "shots": [                                   // at の時刻で切り替わる（書き方は data-start と同じ）
    { "at": "chorus", "position": [0, 1.3, 5], "target": [0, 1.15, 0], "roll": -3 },
    { "at": "bar 14", "position": [1, 0.45, 3.8], "target": [0, 1.45, 0],
      "to": { "position": [0, 1.6, 3] }, "ease": "inOut" },   // 次のショットまで（または dur 秒で）to へ動く
    { "at": "73.2", "position": [-0.6, 1.6, 4.2], "target": [-0.6, 1.4, 0], "to": { "roll": -14 }, "dur": 1, "ease": "out" }
  ] },
"light": { "color": "#ffffff", "intensity": 2.2, "ambient": 0.7, "rim": "#7fd8ff" },   // セクションに "light": "#ffc0c8" でキーライトの色を変えられる
"floor": { "color": "#0d1020", "glow": "#ff2e4d", "radius": 1.5 }                      // false で床なし
```

モーションには `"only": ["chorus"]` / `"except": ["pre-chorus"]` を書くと、そのセクションだけ（以外だけ）で動きます。

### Mixamo のモーションを使う

[Mixamo](https://www.mixamo.com/) の動きを VRM に当てはめて使えます（three-vrm 公式サンプルと同じ変換）。

1. Mixamo で動きを選び、**Format: FBX Binary(.fbx) / Skin: Without Skin / Frames per Second: 30 / Keyframe Reduction: none** でダウンロード（歩く・走る系は **In Place** にチェック）
2. `assets/mixamo/` に置く（git には入りません。Mixamo の素材はリポジトリに含めないでください）
3. モーションに書く

```jsonc
{ "use": "mixamo", "file": "../assets/mixamo/Hip Hop Dancing.fbx", "only": ["chorus"] },
{ "use": "headNod", "amount": 0.1 }   // 下に書いたモーションは Mixamo の上に足される
```

| パラメータ | 内容 |
|---|---|
| `beats` | 1ループを何拍に合わせるか（省略時は元の長さに近い拍数。曲のテンポに合わせて伸び縮みする） |
| `offset` | 何拍目からループを始めるか |
| `sync: "time"` / `speed` | 拍に合わせず元の速さ（の `speed` 倍）で再生 |
| `weight` | 今の姿勢と混ぜる割合（0〜1）。`only` / `except` の境目でも自動でなめらかに混ざる |
| `inPlace` / `faceFront` / `hips: false` | 腰の移動を止める / いつも正面を向かせる / 腰の位置を使わない |
| `mask` | `["leftUpperArm", ...]` のように当てるボーンを絞る（腕だけ Mixamo、脚は手作り、など） |

#### 動きのカタログ（`assets/mixamo/catalog.json`）

MV に使えそうな Mixamo の動き（ダンス中心に28個）を、AI や人が選びやすいように タグ（ジャンル・エネルギー1〜5・合う曲のテンポ帯・主に動く部位・その場か移動か・ループ可否・向き・向くセクション・雰囲気）と解析値で引ける一覧です。形式は `assets/mixamo/catalog.schema.json`。Mixamo の FBX・説明文・サムネイルは入れず、動きの名前と自前のタグ・解析値だけを持ちます。

```sh
node tools/mixamo-catalog.mjs            # assets/mixamo/ の FBX を解析して analysis / derived を書き込み、まだ無い動きを一覧表示
node tools/mixamo-catalog.mjs --missing  # ダウンロードしてほしい動きの一覧だけ出す
```

- `tags` は人（や AI）が付けたタグ。`tagSource: "guess"` は名前からの推測なので、動きを見て直したら `"reviewed"` にする
- `analysis` の bpm・拍数・位相・強さ・移動量は `runtime/mixamo.js` の `analyzeMotion`（再生時に曲の拍へ合わせるのと同じ解析）。ほかにループのつながり・部位ごとの動きの割合・向きの変化を足している
- `derived` は解析値から機械的に決めたタグ。`tags` と食い違うところは見直しの手がかりに
- ファイル名は Mixamo の初期名のままか動きの名前（大文字小文字・空白は問わない）。別名なら `file` に書く

### 用意してあるモーション

> ここにある動き（`blink`・`mouth` 以外）は、関節を数式で回した**仮の動き**です。動きの元は Mixamo などのモーションデータにするのが基本で、
> 再配布できるモーションデータ（CMU・Quaternius などを変換したもの）が入ったら、デモをそちらに差し替えてから消す予定です。

| use | 内容 | 主なパラメータ |
|---|---|---|
| `idle` | 腕を下ろした立ち姿勢と呼吸 | `armDown` |
| `bounce` | 拍ごとに膝を曲げて沈む | `amount`（沈む量 m） |
| `sway` | 2拍で左右に揺れる | `amount` |
| `headNod` | 拍の頭でうなずく | `amount` |
| `armSwing` | 歩くように腕を前後に振る（肘は少し遅れる）。energy が `liftFrom` を超えると腕が横に上がる | `amount`, `liftFrom`, `lift` |
| `blink` | 決定的なまばたき | `interval` |
| `mouth` | 音量で口を開ける | `amount` |
| `stepSide` | 拍ごとに左右へ体重移動 | `amount` |
| `turn` | 小節単位で体の向きを左右に振る | `amount`, `speed` |
| `pump` | 拍の頭で片腕ずつ突き上げ、次の拍までにゆっくり下ろす | `amount` |
| `jump` | `every` 拍ごとに跳ぶ（しゃがむ→跳ぶ→着地で沈む） | `every`, `offset`, `height`, `arms` |
| `headTilt` | `every` 拍ごとに首をかしげて止める | `every`, `amount` |
| `wave` | 片手を上げて振る | `side`, `speed` |
| `clap` | 胸の前で手拍子（既定は2拍目と4拍目） | `beats`, `width` |
| `choreo` | 拍ごとにポーズ（`up` `v` `cross` `wide` `point` `down`）を切り替える振り付け | `poses`, `beatsPerPose`, `blend`, `amount` |

`character.smoothing`（秒、例 `0.06`）を書くと、全ボーンがその時定数で少し遅れて追従し、動きの角が取れます。

モーションを足すときは `runtime/behaviors.js` に関数を1つ追加します。引数の `m` には
`beatPos`、`beatPhase`、`beatPulse`、`barPos` / `barPhase`、`loudness`、`onset`、`energy`、`section`、`t` が入っています。

## HTML/CSS をどう描いているか

ブラウザの画面をスクショしているのではありません。レイヤーのHTMLは見えない場所に置いておき、
フレームごとに「表示/非表示」「CSS変数」「各アニメーションを何秒の時点で止めるか」を決めてから、
SVG の foreignObject 経由で画像にして canvas に描いています。レイアウトと描画はブラウザ自身が行うので普通のCSSがそのまま使え、
実時間には依存しないので、何度書き出しても同じ映像になります。見た目が前のフレームと同じなら描き直しません。

注意点:
- 外部URLの読み込みはできません（画像・フォントは手元のファイルを指定する。読み込み時に埋め込まれます）
- `@font-face` で大きな日本語フォントを使うと、毎フレームの描画が少し重くなります。PCに入っているフォントは名前で指定するだけで使えます
- `transition` は使えません（時刻で決まる `animation` か、CSS変数の `calc()` で書いてください）

## 構成

```
src/analyze.mjs      音声 → analysis.json（FFmpegでデコード、スペクトルフラックスでオンセット、自己相関+全体フィットでテンポと拍）
src/render.mjs       scene.json → mp4（Playwright + FFmpeg）
src/preview.mjs      ブラウザ確認用のローカルサーバー（127.0.0.1 のみ、空きポートを自動で選ぶ）
src/new-song.mjs     1曲ぶんの作業フォルダを作る
src/check.mjs        点検（qa.md と contact.png）
templates/song/      new-song がコピーするひな形
src/gpu.mjs          OS に合わせた GPU・エンコーダー・並列数の選び方
src/server.mjs       ローカルファイルを見せる簡易サーバー（127.0.0.1 のみ）
src/ws.mjs           書き出し時にフレームを受け取る最小限の WebSocket
runtime/player.js    ブラウザ側の描画。frame(i) で i フレーム目を描く
runtime/layers.js    HTML/CSS のレイヤーを決定的に canvas へ描く
runtime/mv.css       最初から使えるCSSの部品
runtime/timeline.js  時刻 → 拍・小節・セクション・表情の補間
runtime/behaviors.js モーション集
runtime/mixamo.js    Mixamo の FBX を VRM 用に変換して再生
tools/               テスト曲の生成、サンプルVRMの取得、Mixamo の動きのカタログ更新
```

## メモ

- `assets/test.vrm` は three-vrm リポジトリのサンプルモデルで、動作確認用です（リポジトリには含めていません）。
- GPU の無い環境（クラウド等）では SwiftShader で描くので 720p で 2fps 前後です。GPU のある PC ではもっと速くなります。

## 素材について

このリポジトリにはモデル・モーション・曲は入っていません。Mixamo の FBX、CMU のモーションキャプチャ、MMD の素材は再配布できないため、各自で入手して手元に置きます。入手方法と置き場所は [docs/assets.md](docs/assets.md) にまとめています。

## クレジット

- [three.js](https://threejs.org/)（MIT）
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)（MIT）。動作確認用のサンプル VRM もこのリポジトリから取得します
- [Playwright](https://playwright.dev/)（Apache-2.0）
- [FFmpeg](https://ffmpeg.org/)（LGPL/GPL。別途インストールして使います）
- 歌詞の自動合わせ: [stable-ts](https://github.com/jianfch/stable-ts)（MIT）/ [OpenAI Whisper](https://github.com/openai/whisper)（MIT）、ボーカル分離: [Demucs](https://github.com/facebookresearch/demucs)（MIT）
- モーション: [Mixamo](https://www.mixamo.com/)（Adobe）、[CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu/)（使う場合。各自で入手）

## ライセンス

コードは [MIT License](LICENSE) です。各自で用意した素材には、それぞれの素材の利用条件が適用されます。
- GPU の無い環境（クラウド等）では SwiftShader で描くので 720p で 1〜2fps です。Mac / Windows の PC で書き出すと数十倍速くなります。
