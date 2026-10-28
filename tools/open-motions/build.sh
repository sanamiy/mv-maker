#!/bin/bash
# 再配布できるモーション素材（CMU mocap・Quaternius UAL1/2）を VRMA にまとめ、一覧を作る。
# 使い方: tools/open-motions/build.sh <作業フォルダ> [並列数]
#   <作業フォルダ>/src/  元データ（CMU の BVH ミラーと Quaternius の zip）を置く・取ってくる
#   <作業フォルダ>/dataset/  できあがり（cmu/ quaternius/ catalog.jsonl catalog.csv）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mkdir -p "${1:?作業フォルダを指定してください}" && cd "$1" && pwd)
JOBS=${2:-4}
SRC=$WORK/src; OUT=$WORK/dataset
mkdir -p "$SRC" "$OUT/cmu" "$OUT/quaternius" "$WORK/logs"

# CMU: cgspeed 2010 年版 BVH（1コマ目が Tポーズ）の GitHub ミラー
[ -d "$SRC/cmubvh" ] || git clone -q --depth 1 https://github.com/Shriinivas/cmubvh "$SRC/cmubvh"
convert_cmu() {
  local z=$1 id t bvh; id=$(basename "$z" .zip)
  [ -f "$OUT/cmu/$id.json" ] && return 0
  t=$(mktemp -d); unzip -q -o "$z" -d "$t"; bvh=$(find "$t" -iname '*.bvh' | head -1)
  if [ -n "$bvh" ]; then node "$HERE/cmu2vrma.mjs" "$bvh" "$OUT/cmu/$id.vrma" "$OUT/cmu/$id.json" 2>"$WORK/logs/$id.log" || echo "失敗: $id"; fi
  rm -rf "$t"
}
export -f convert_cmu; export HERE OUT WORK
find "$SRC/cmubvh" -name '*.zip' | sort | xargs -P "$JOBS" -I{} bash -c 'convert_cmu "$@"' _ {}

# Quaternius: OpenGameArt の Standard 版（CC0）
for pair in "ual1 https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip" \
            "ual2 https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip"; do
  set -- $pair
  [ -f "$SRC/$1.zip" ] || curl -fsSL -o "$SRC/$1.zip" "$2"
  [ -d "$SRC/$1" ] || unzip -q -o "$SRC/$1.zip" -d "$SRC/$1"
  glb=$(find "$SRC/$1" -iname '*.glb' ! -iname '*Mannequin*' | head -1)
  mkdir -p "$OUT/quaternius/$1"
  node "$HERE/quaternius2vrma.mjs" "$glb" "$1" "$WORK/q-$1"
  for f in "$WORK/q-$1"/*; do b=$(basename "$f"); mv "$f" "$OUT/quaternius/$1/${b#"$1"_}"; done
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
node "$HERE/catalog.mjs" "$OUT" "$WORK/cmu-index.json"

# 回転を 16bit にして容量を約半分にする（まだ float のものだけ）
node --input-type=module -e '
import fs from "node:fs"; import path from "node:path";
const { quantizeVRMA } = await import(process.argv[1]);
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".vrma") ? [path.join(d, e.name)] : []);
for (const f of walk(process.argv[2])) { const b = fs.readFileSync(f); if (b.includes("\"normalized\":true")) continue; fs.writeFileSync(f, quantizeVRMA(b)); }
' "$HERE/quantize.mjs" "$OUT"
