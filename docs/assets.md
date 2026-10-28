# 素材の用意のしかた

mv-maker のリポジトリには **コードと、mv-maker が独自に作ったデータだけ** を入れています。
モデル・モーション・曲は配布条件がそれぞれ違うので、使う人が各自で入手して手元に置きます。
置き場所はどれも `.gitignore` 済みなので、誤ってコミットされることはありません。

## キャラクター（VRM）

| 置き場所 | 入手方法 |
| --- | --- |
| `assets/test.vrm` | `npm run demo:vrm` で [three-vrm](https://github.com/pixiv/three-vrm) リポジトリのサンプルモデルを取得します（動作確認用） |
| `assets/<好きな名前>.vrm` | 自作したもの、または [VRoid Hub](https://hub.vroid.com/) などで利用条件が合うものを `scene.json` の `character.vrm` に指定 |

VRM を使うときは、モデルごとの利用条件（VRM ファイルに埋め込まれたライセンス情報）を確認してください。

## Mixamo のモーション（FBX）

[Mixamo](https://www.mixamo.com/) の動きは Adobe の利用規約により、作品の中で使うのは自由ですが、
**FBX ファイルそのものを再配布することはできません**。そのためリポジトリには FBX を入れず、
動きの名前と mv-maker が独自に付けたタグ・解析値（`assets/mixamo/catalog.json`）だけを入れています。

1. Adobe アカウントで https://www.mixamo.com/ にログインする
2. Character は何でもよい（VRM に当てはめ直すので）。カタログにある名前（`mixamoName`）の動きを検索する
3. Download で **Format: FBX Binary / Skin: Without Skin / Frames per Second: 30** を選ぶ
4. ダウンロードしたファイルを `assets/mixamo/` に、カタログの `file` と同じ名前で置く

## CMU Graphics Lab Motion Capture Database（BVH など）

[CMU mocap](http://mocap.cs.cmu.edu/) のデータは、作品に組み込むのは自由ですが、
**データそのものを（変換した形でも）配布し直すことはできません**。使う場合は各自で
http://mocap.cs.cmu.edu/ から（または有志による BVH 変換版から）ダウンロードし、`assets/cmu/` に置いてください。
CMU の求めに従い、使った作品のクレジットには
「The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.」
を入れてください。

## MMD のモデル・モーション（PMX / VMD）

MMD の素材は作者ごとに利用規約が違い、多くは再配布を禁止しています。リポジトリには入れず、各素材の規約に従って手元でだけ使ってください。

## 曲・歌詞

自分で権利を持っている曲（または利用許諾のある曲）を使ってください。曲・歌詞・書き出した動画はコミットしません。
デモ曲 `examples/demo/song.wav` は `npm run demo:song` でその場で合成するテスト用の音です。
