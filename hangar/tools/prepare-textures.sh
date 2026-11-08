#!/usr/bin/env bash
# Encodes every raw material in hangar/tools/raw/materials/<slug>/ to KTX2 UASTC (zstd, full mip chain) in
# hangar/html/assets/materials/<slug>/. Run after fetch-polyhaven.mjs / fetch-ambientcg.mjs.
#
#   bash hangar/tools/prepare-textures.sh [slug ...]      (no slugs = all of them)
#
# Encoder: basisu (Homebrew `basis_universal`). The plan named toktx (`brew install ktx`), but Homebrew has no
# KTX-Software formula, so this uses the Basis Universal encoder that toktx wraps, with the same settings:
#   toktx --t2 --encode uastc --uastc_quality 3 --zcmp 19 --genmipmap
#   = basisu -ktx2 -uastc -uastc_level 3 -ktx2_zstandard_level 19 -mipmap
# color is sRGB; normal uses -normal_map (linear, tuned for normals, like toktx --normal_mode); orm and height
# are linear. The output is the same KTX2 UASTC format either way.
#
# -y_flip stores each image bottom row first. three.js uploads compressed textures without flipping, so this
# makes a KTX2 map land on the level's UVs (v up) the same way a PNG through TextureLoader (flipY) would; in
# particular the normal map's green channel keeps pointing up the surface.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
raw="$here/raw/materials"
out="$here/../html/assets/materials"
command -v basisu >/dev/null || { echo "basisu not found: brew install basis_universal" >&2; exit 1; }

common=(-ktx2 -uastc -uastc_level 3 -ktx2_zstandard_level 19 -mipmap -y_flip)

slugs=("$@")
if [ ${#slugs[@]} -eq 0 ]; then
  for d in "$raw"/*/; do slugs+=("$(basename "$d")"); done
fi

for slug in "${slugs[@]}"; do
  src="$raw/$slug"
  [ -d "$src" ] || { echo "no raw folder $src" >&2; exit 1; }
  python3 "$here/pack-maps.py" "$src"
  mkdir -p "$out/$slug"
  enc() { # map, extra flags...
    local map="$1"; shift
    local dst="$out/$slug/$map.ktx2" log="$src/out/$map.basisu.log"
    rm -f "$dst"
    # basisu is chatty; keep its log and show it if the encode fails or writes nothing.
    if ! basisu "${common[@]}" "$@" "$src/out/$map.png" -output_file "$dst" >"$log" 2>&1 || [ ! -s "$dst" ]; then
      echo "basisu failed for $slug/$map:" >&2; tail -20 "$log" >&2; exit 1
    fi
  }
  enc color
  enc normal -normal_map
  enc orm -linear
  enc height -linear
  echo "$slug: $(du -ch "$out/$slug"/*.ktx2 | tail -1 | cut -f1)"
done
