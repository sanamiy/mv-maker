#!/bin/bash
# 再配布できるモーション素材（CMU mocap・Quaternius UAL1/2）を VRMA にまとめ、一覧を作る。
# 使い方: tools/open-motions/build.sh <作業フォルダ> [並列数]
#   <作業フォルダ>/src/  元データ（CMU の BVH ミラーと Quaternius の zip）を置く・取ってくる
#   <作業フォルダ>/dataset/  できあがり（cmu/ quaternius/ に .vrma と .motion.json、catalog.jsonl catalog.csv）
#   <作業フォルダ>/analysis/ メタデータの元になる解析値（配らない）
# 環境変数 MOTION_META_VALIDATOR に Motion Meta の validate.mjs を渡すと、通らないものを除外する
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mkdir -p "${1:?作業フォルダを指定してください}" && cd "$1" && pwd)
JOBS=${2:-4}
SRC=$WORK/src; OUT=$WORK/dataset
mkdir -p "$SRC" "$OUT/cmu" "$OUT/quaternius" "$WORK/logs" "$WORK/analysis/cmu"

# CMU: cgspeed 2010 年版 BVH（1コマ目が Tポーズ）の GitHub ミラー
[ -d "$SRC/cmubvh" ] || git clone -q --depth 1 https://github.com/Shriinivas/cmubvh "$SRC/cmubvh"
convert_cmu() {
  local z=$1 id t bvh; id=$(basename "$z" .zip)
  [ -f "$WORK/analysis/cmu/$id.json" ] && return 0
  t=$(mktemp -d); unzip -q -o "$z" -d "$t"; bvh=$(find "$t" -iname '*.bvh' | head -1)
  if [ -n "$bvh" ]; then node "$HERE/cmu2vrma.mjs" "$bvh" "$OUT/cmu/$id.vrma" "$WORK/analysis/cmu/$id.json" 2>"$WORK/logs/$id.log" || echo "失敗: $id"; fi
  rm -rf "$t"
}
export -f convert_cmu; export HERE OUT WORK
find "$SRC/cmubvh/" -name '*.zip' | sort | xargs -P "$JOBS" -I{} bash -c 'convert_cmu "$@"' _ {}

# Quaternius: OpenGameArt の Standard 版（CC0）
for pair in "ual1 https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip" \
            "ual2 https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip"; do
  set -- $pair
  [ -f "$SRC/$1.zip" ] || curl -fsSL -o "$SRC/$1.zip" "$2"
  [ -d "$SRC/$1" ] || unzip -q -o "$SRC/$1.zip" -d "$SRC/$1"
  glb=$(find "$SRC/$1" -iname '*.glb' ! -iname '*Mannequin*' | head -1)
  mkdir -p "$OUT/quaternius/$1" "$WORK/analysis/$1"
  node "$HERE/quaternius2vrma.mjs" "$glb" "$1" "$WORK/q-$1"
  for f in "$WORK/q-$1"/*.vrma; do b=$(basename "$f"); mv "$f" "$OUT/quaternius/$1/${b#"$1"_}"; done
  mv "$WORK/q-$1"/*.json "$WORK/analysis/$1/"
done

# CMU の説明文の一覧（各フォルダの README の表）
python3 - "$SRC/cmubvh" "$WORK/cmu-index.json" <<'EOF'
import glob, json, re, sys
rows = []
for f in sorted(glob.glob(sys.argv[1] + '/Sequence-*/*/README.md')):
    lines = open(f, encoding='utf-8').read().splitlines()
    cat = lines[0].lstrip('# ').strip()
    for l in lines:
        m = re.match(r'\|\[(\d+_\d+)\]\((\S+)\)\|(\d+)\|([^|]*)\|', l)
        if m: rows.append(dict(id=m[1], frames=int(m[3]), desc=m[4].strip(), category=cat))
json.dump(rows, open(sys.argv[2], 'w'), ensure_ascii=False)
EOF
node "$HERE/metadata.mjs" "$WORK/analysis" "$OUT" "$WORK/cmu-index.json" ${MOTION_META_VALIDATOR:-}

# 回転を 16bit にして容量を約半分にする（まだ float のものだけ）
node "$HERE/quantize.mjs" "$OUT"
