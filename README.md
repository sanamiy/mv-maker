# mv-maker

音楽に合わせて VRM キャラクターが動く MV を mp4 で書き出す、軽量なフレームワークです。

- キャラは VRM（three.js + @pixiv/three-vrm）
- シーンは JSON で宣言的に書く（どのモーションを使うか、どこがサビで何の表情か）
- 曲は事前に解析して `analysis.json`（拍・小節頭・オンセット・音量包絡・盛り上がり区間）にしておく
- 書き出しはヘッドレス Chromium で canvas 1枚だけを描き、フレーム時刻を `1/fps` ずつ決定的に進め、生ピクセルを FFmpeg の stdin に流す（PNG化もスクショもしない）
- SpringBone（髪・服の揺れ）は 0 フレーム目から順に積み上げるので、何度書き出しても同じ映像になる

## 必要なもの

- Node.js 20 以上
- FFmpeg（`ffmpeg` にパスが通っていること）
- `npx playwright install chromium`（初回のみ）

## 試す

```sh
npm install
npx playwright install chromium
npm run demo        # テスト曲の生成 → サンプルVRM取得 → 解析 → out/demo.mp4
```

自分の曲で作るとき:

```sh
node src/analyze.mjs my-song.mp3 my/analysis.json
node src/render.mjs my/scene.json out/my.mp4
node src/render.mjs my/scene.json out/quick.mp4 --scale 0.5 --frames 300   # 半分の解像度で先頭10秒だけ
node src/preview.mjs my/scene.json   # ブラウザで音付きプレビュー（実時間に追従するので本番より粗い）
```

## シーン定義（scene.json）

パスはすべて scene.json からの相対パスです。

```jsonc
{
  "width": 1280, "height": 720, "fps": 30,
  "audio": "song.wav",
  "analysis": "analysis.json",
  "background": { "low": "#1d1b3a", "high": "#ff4d8d" },   // 静かな所 / 盛り上がった所の色
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
  // 曲の構成。energy は動きの大きさの倍率、expression は VRM の表情名と強さ。
  // 境目では 0.4 秒かけて混ざる。"sections": "auto" にすると解析結果の盛り上がり区間から自動で作る。
  "sections": [
    { "from": 0,   "name": "intro",  "energy": 0.4, "expression": { "relaxed": 0.5 } },
    { "from": 7.5, "name": "verse",  "energy": 0.8, "expression": {} },
    { "from": 15,  "name": "chorus", "energy": 1.4, "expression": { "happy": 1 } },
    { "from": 30,  "name": "outro",  "energy": 0.3, "expression": { "relaxed": 0.7 } }
  ]
}
```

### 用意してあるモーション

| use | 内容 | 主なパラメータ |
|---|---|---|
| `idle` | 腕を下ろした立ち姿勢と呼吸 | `armDown` |
| `bounce` | 拍ごとに膝を曲げて沈む | `amount`（沈む量 m） |
| `sway` | 2拍で左右に揺れる | `amount` |
| `headNod` | 拍の頭でうなずく | `amount` |
| `armSwing` | 左右交互に腕を振る。energy が `liftFrom` を超えると腕が上がる | `amount`, `liftFrom`, `lift` |
| `blink` | 決定的なまばたき | `interval` |
| `mouth` | 音量で口を開ける | `amount` |

モーションを足すときは `runtime/behaviors.js` に関数を1つ追加します。引数の `m` には
`beatPos`（何拍目か・小数込み）、`beatPhase`（拍内の位置 0〜1）、`beatPulse`（拍頭で1→減衰）、
`barPos` / `barPhase`、`loudness`、`onset`、`energy`、`section`、`t` が入っています。

## 構成

```
src/analyze.mjs      音声 → analysis.json（FFmpegでデコード、スペクトルフラックスでオンセット、自己相関+全体フィットでテンポと拍）
src/render.mjs       scene.json → mp4（Playwright + FFmpeg）
src/preview.mjs      ブラウザ確認用のローカルサーバー（127.0.0.1 のみ）
runtime/player.js    ブラウザ側の描画。frame(i) で i フレーム目を描く
runtime/timeline.js  時刻 → 拍・小節・セクション・表情の補間
runtime/behaviors.js モーション集
tools/               テスト曲の生成、サンプルVRMの取得
```

## メモ

- `assets/test.vrm` は three-vrm リポジトリのサンプルモデルで、動作確認用です（リポジトリには含めていません）。
- GPU の無い環境（クラウド等）では SwiftShader で描くので 720p で 2fps 前後です。GPU のある PC ではもっと速くなります。
