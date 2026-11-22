#!/bin/bash
# Makes the macOS apps' copy of the Milky Way map (assets/sky/build/milkyway.astc) if it isn't there yet:
# fetches three.js's Basis Universal transcoder (the version the web pages load) and runs
# milkyway-astc.mjs on Hangar's milkyway.ktx2. Needs node and a network connection the first time only.
# Every app's build.sh runs this; an app built without the file keeps its painted sky.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/milkyway.astc
SRC=../../hangar/html/assets/images/milkyway.ktx2
if [[ -f "$OUT" && "$OUT" -nt "$SRC" ]]; then exit 0; fi
BASIS=build/basis
mkdir -p "$BASIS"
for f in basis_transcoder.js basis_transcoder.wasm; do
    [[ -f "$BASIS/$f" ]] || curl -sSfL -o "$BASIS/$f" "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/$f"
done
node tools/milkyway-astc.mjs "$BASIS" "$OUT"
