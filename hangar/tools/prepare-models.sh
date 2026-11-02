#!/usr/bin/env bash
# Turns each downloaded model in hangar/tools/raw/models/<name>/ into hangar/html/assets/models/<name>.glb:
# textures as KTX2 UASTC, geometry meshopt-compressed.
#
#   bash hangar/tools/prepare-models.sh [name ...]       (no names = all of them)
#
# The plan's one-liner was
#   npx @gltf-transform/cli optimize <in> <out> --texture-compress ktx2 --compress meshopt
# but `--texture-compress ktx2` needs KTX-Software's `ktx` CLI, which Homebrew does not package. So the KTX2
# step is ktx2-textures.mjs (basisu, same settings as the materials) and the CLI then does the rest with
# texture compression off. Needs `npm install` in hangar/tools once.
#
# A Sketchfab model downloaded by hand goes in raw/models/<name>/ the same way; add its manifest entry
# (file, scale, source page URL, author, licence) by hand.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
raw="$here/raw/models"
out="$here/../html/assets/models"
command -v basisu >/dev/null || { echo "basisu not found: brew install basis_universal" >&2; exit 1; }
[ -d "$here/node_modules/@gltf-transform/core" ] || (cd "$here" && npm install --no-audit --no-fund)
mkdir -p "$out"

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for d in "$raw"/*/; do names+=("$(basename "$d")"); done
fi

for name in "${names[@]}"; do
  src="$(find "$raw/$name" -maxdepth 1 \( -name '*.gltf' -o -name '*.glb' \) ! -name '.*' | head -1)"
  [ -n "$src" ] || { echo "no .gltf/.glb in $raw/$name" >&2; exit 1; }
  tmp="$raw/$name/.ktx2.glb"
  node "$here/ktx2-textures.mjs" "$src" "$tmp"
  npx -y @gltf-transform/cli@4.5.1 optimize "$tmp" "$out/$name.glb" --texture-compress false --compress meshopt >/dev/null
  rm -f "$tmp"
  echo "$name: $(du -h "$out/$name.glb" | cut -f1)"
done
