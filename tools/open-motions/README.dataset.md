---
license: other
license_name: cc0-1.0-and-cmu-mocap
license_link: LICENSE.md
pretty_name: Open VRMA Motions
language:
- en
- ja
tags:
- vrm
- vrma
- motion-capture
- animation
- dance
- 3d
size_categories:
- 1K<n<10K
configs:
- config_name: default
  data_files: catalog.csv
---

# Open VRMA Motions

再配布できるモーションキャプチャ／アニメーション素材を、**どの VRM モデルにもそのまま当てられる VRM Animation（.vrma）** に変換し、検索用のタグを付けたデータセットです。ログインなしで `huggingface_hub` や `git clone` から取得でき、作品への組み込みは商用でも可能です（各素材の条件は下記）。

Freely redistributable motion data (CMU Graphics Lab Motion Capture Database and Quaternius Universal Animation Library), converted to **VRM Animation (.vrma)** so it plays on any VRM avatar, with machine-readable tags for searching.

| | 本数 | 合計時間 | ライセンス |
|---|---:|---:|---|
{{SUMMARY_ROWS}}

## 中身

```
cmu/<subject>_<trial>.vrma          CMU mocap（例 cmu/60_01.vrma = サルサ）
quaternius/ual1/<name>.vrma         Quaternius Universal Animation Library
quaternius/ual2/<name>.vrma         Quaternius Universal Animation Library 2
catalog.jsonl / catalog.csv         1行1モーションの一覧（タグ・解析値）
```

### 使い方（three-vrm）

```js
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
loader.register(parser => new VRMAnimationLoaderPlugin(parser));
const gltf = await loader.loadAsync('cmu/60_01.vrma');
const clip = createVRMAnimationClip(gltf.userData.vrmAnimations[0], vrm);
new THREE.AnimationMixer(vrm.scene).clipAction(clip).play();
```

### 取得

```bash
hf download {{REPO}} --repo-type dataset --include "catalog.csv"     # 一覧だけ
hf download {{REPO}} --repo-type dataset --include "cmu/60_*.vrma"   # 必要な分だけ
```

## タグ（catalog の列）

| 列 | 意味 |
|---|---|
| `kind` | dance / idle / walk / run / jump / gesture / sit / sports / acrobatics / action / other。元の説明文・名前のキーワードから付けています |
| `genre` | ダンスのジャンル（salsa / charleston / modern / indian / breakdance / lambada / pop / chicken-dance / casual） |
| `energy` | 1 ほぼ静止 ～ 5 全身で激しい（手足と頭の平均の速さから） |
| `bpm`, `tempoBand` | 動きの周期から推定した拍（slow 90 未満 / mid 90〜120 / fast 120 超）。周期がはっきりしない動きは空 |
| `bodyParts` | full / upper（脚がほぼ動かず、その場で上半身だけ動くもの） |
| `locomotion` | in-place / stepping / traveling / spinning |
| `loopable` | 最初と最後のポーズが近く、そのままループできる |
| `floorWork`, `airborne` | 腰を低く落とす時間が長い／両足が浮く時間が長い |
| `fingers` | 指の動きを含む（Quaternius のみ） |
| `rootMotion` | 腰の移動を含む（CMU は全部、Quaternius は `_RM` 付きのもの） |
| `analysis` | タグの元になった解析値（catalog.jsonl のみ） |

タグは自動で付けたもので、間違いを含みます。特に `bpm` は音楽ではなく動きから推定した値です。

## 変換について

- VRMA のレストポーズは VRM 1.0 の正規化 Tポーズ（全ボーン回転なし、+Z 向き）です。元データの Tポーズ（CMU は cgspeed 版の1コマ目、Quaternius は `A_TPose`）からの差分として各ボーンの回転を書き出しています。
- 30fps に間引いています。表情・視線のトラックはありません。
- CMU は 120fps の光学式モーキャプ（2000年代）で、手指はありません。ノイズや床の貫通が残るクリップがあります。
- 変換ツール: [mv-maker / tools/open-motions](https://github.com/sanamiy/mv-maker/tree/main/tools/open-motions)

## ライセンスとクレジット

**Quaternius Universal Animation Library 1・2（`quaternius/`）** — CC0 1.0 Universal。クレジット不要です。Animations by Quaternius (https://quaternius.com/)。

**CMU Graphics Lab Motion Capture Database（`cmu/`）** — CMU の FAQ によると、このデータは許可なく複製・改変・再配布でき、商用製品に含めることもできます。データそのものを（変換した形でも）販売することはできません。また全件をクロールしないよう求められているので、CMU のサイトではなくこのデータセットか GitHub のミラーから取得してください。作品には次の謝辞を入れてください。

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

BVH 変換は Bruce Hahne による cgspeed の Motionbuilder-friendly 版（2010）で、変換者は追加の制限を設けていません。取得元は GitHub のミラー [Shriinivas/cmubvh](https://github.com/Shriinivas/cmubvh) です。

このデータセットの変換・タグ付けの部分は CC0 として提供します。
