# open-motions

再配布できるモーション素材を VRM Animation（.vrma）に変換し、タグ付きの一覧を作るツールです。できあがったデータセットは Hugging Face で配布しています（`README.dataset.md` がそのデータセットカード）。

| 素材 | ライセンス | 取得元 |
|---|---|---|
| CMU Graphics Lab Motion Capture Database（2,505本） | 複製・改変・再配布可、データ単体の販売は不可、謝辞の記載を依頼 | GitHub ミラー（cgspeed 2010 年版 BVH） |
| Quaternius Universal Animation Library 1・2（Standard 版） | CC0 | OpenGameArt |

```bash
npm install
tools/open-motions/build.sh ~/open-motions-work 4   # 作業フォルダ, 並列数
```

| ファイル | 役割 |
|---|---|
| `build.sh` | 元データの取得 → 変換 → 一覧づくりをまとめて行う |
| `cmu2vrma.mjs` | CMU の BVH 1本 → VRMA と解析値 |
| `quaternius2vrma.mjs` | Quaternius の GLB（全モーション入り）→ モーションごとの VRMA と解析値 |
| `quantize.mjs` | 回転を 16bit 整数にして容量を約半分にする（見た目はほぼ変わらない） |
| `vrma.mjs` | VRM 正規化ボーンの回転列を VRMA（glTF + `VRMC_vrm_animation`）に書き出す |
| `analyze.mjs` | 移動・回転・手足の動き・拍・ループ可否などの解析値 |
| `catalog.mjs` | 解析値と元の説明文から `catalog.jsonl` / `catalog.csv` を作る |

VRMA のレストポーズは VRM 1.0 の正規化 Tポーズ（全ボーン回転なし）で、元データの Tポーズからの差分を各ボーンの回転として書き出します。three-vrm-animation の `createVRMAnimationClip` でそのまま再生できます。
