#!/usr/bin/env bash
# Makes the browser copy of the Mars mosaic: resample to 8192 x 4096 (equirectangular) and encode as KTX2
# UASTC (sRGB, zstd, mipmaps, bottom row first like the materials; see prepare-textures.sh).
#
#   bash hangar/tools/prepare-images.sh
#
# KTX2 rather than JPEG: the 8K map stays block-compressed on the GPU (about 45 MB with mips instead of
# 180 MB as RGBA8), and it loads through the same KTX2Loader as everything else.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/raw/images/mars/mars_viking_mdim21_clrmosaic_1km.jpg"
tmp="$here/raw/images/mars/mars_8k.png"
out="$here/../html/assets/images"
command -v basisu >/dev/null || { echo "basisu not found: brew install basis_universal" >&2; exit 1; }
[ -f "$src" ] || { echo "missing $src: run node hangar/tools/fetch-mars.mjs" >&2; exit 1; }

python3 - "$src" "$tmp" <<'EOF'
import sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None  # the source is ~225 Mpx, above Pillow's bomb guard
im = Image.open(sys.argv[1]).convert('RGB')
print('source', im.size)
im.resize((8192, 4096), Image.LANCZOS).save(sys.argv[2])
EOF
mkdir -p "$out"
log="$here/raw/images/mars/basisu.log"
rm -f "$out/mars.ktx2"
if ! basisu -ktx2 -uastc -uastc_level 3 -ktx2_zstandard_level 19 -mipmap -y_flip "$tmp" -output_file "$out/mars.ktx2" >"$log" 2>&1 || [ ! -s "$out/mars.ktx2" ]; then
  echo "basisu failed for mars:" >&2; tail -20 "$log" >&2; exit 1
fi
ls -la "$out/mars.ktx2"
