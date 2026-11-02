# Hangar asset tools

Offline tools that fetch scanned materials, images and models and turn them into what the page loads
from `hangar/html/assets/`. Nothing here runs in the browser. Raw downloads go to `hangar/tools/raw/`,
which is git-ignored; only the processed KTX2 / GLB files and `manifest.json` are committed.

Sources are only ones that need no account (ruling R5): Poly Haven, ambientCG (both CC0) and
NASA / JPL / USGS (public domain). Sketchfab models are fetched by hand: see `SKETCHFAB-WISHLIST.md`.

## Requirements

- Node 20+ (uses the built-in `fetch`), `unzip`, Python 3 with Pillow.
- `basisu` from Homebrew: `brew install basis_universal`. The plan named `toktx` (`brew install ktx`),
  but Homebrew has no KTX-Software formula; `basisu` is the Basis Universal encoder that `toktx` wraps
  and writes the same KTX2 UASTC files (settings mapped in `prepare-textures.sh`).
- `npm install` in this folder once (gltf-transform libraries, for `prepare-models.sh`).

## Rebuild everything

```bash
T=hangar/tools
# materials: <asset> <tag> <tile metres>; tile = real-world metres one texture repeat covers
node $T/fetch-polyhaven.mjs metal_plate_02        mat:panel-brown      2
node $T/fetch-polyhaven.mjs hangar_concrete_floor mat:concrete         2
node $T/fetch-polyhaven.mjs blue_metal_plate      mat:computer         2
node $T/fetch-polyhaven.mjs moon_01               mat:regolith         2
node $T/fetch-polyhaven.mjs painted_concrete_02   mat:concrete-painted 2
node $T/fetch-polyhaven.mjs concrete_wall_006     mat:concrete-stained 2
node $T/fetch-polyhaven.mjs cracked_concrete      mat:concrete-cracked 2
node $T/fetch-polyhaven.mjs rust_coarse_01        mat:rust             2
node $T/fetch-polyhaven.mjs rubber_tiles          mat:rubber           2
node $T/fetch-ambientcg.mjs MetalPlates001        mat:steel            2
node $T/fetch-ambientcg.mjs Metal009              mat:steel-brushed    1
node $T/fetch-ambientcg.mjs MetalWalkway006       mat:grate            1
node $T/fetch-ambientcg.mjs DiamondPlate001       mat:diamond-plate    0.5
node $T/fetch-ambientcg.mjs PaintedMetal016       mat:hazard           1
bash $T/prepare-textures.sh

# Mars (USGS Viking colour mosaic, public domain), 8192 x 4096 KTX2
node $T/fetch-mars.mjs && bash $T/prepare-images.sh

# models: --model <asset> <name> <scale to metres>
node $T/fetch-polyhaven.mjs --model barrel_03          barrel    1
node $T/fetch-polyhaven.mjs --model old_military_crate crate     1
node $T/fetch-polyhaven.mjs --model moon_rock_01       boulder-a 1
node $T/fetch-polyhaven.mjs --model moon_rock_03       boulder-b 1
bash $T/prepare-models.sh

node --test 'hangar/tests/*.test.mjs'
```

Downloads are skipped when the raw file already exists, so reruns are cheap.

## What the files are

| Tool | Does |
|---|---|
| `fetch-polyhaven.mjs` | Poly Haven API: 2K PNG `Diffuse`, `nor_gl`, `arm` (AO/rough/metal), `Displacement`; or a 2K glTF with `--model`. Writes the manifest entry with name, author, `CC0`. |
| `fetch-ambientcg.mjs` | ambientCG 2K PNG zip, maps renamed to the same layout. For what Poly Haven lacks (brushed steel, plates, grating, diamond plate, hazard paint). |
| `fetch-mars.mjs` | USGS Viking MDIM2.1 colour mosaic, 1 km/px JPEG (the 232 m GeoTIFF is 12.7 GB). |
| `pack-maps.py` | Normalises a raw material: 2048², 8-bit, packs `orm` (AO R, roughness G, metalness B), puts grating opacity in the colour alpha. |
| `prepare-textures.sh` | KTX2 UASTC level 3, zstd 19, mipmaps: colour sRGB, normal `-normal_map`, orm and height linear. Stored bottom row first (`-y_flip`) so maps sit on the level's v-up UVs like TextureLoader images. |
| `prepare-images.sh` | Mars resampled to 8192 x 4096, same KTX2 settings. |
| `ktx2-textures.mjs` + `prepare-models.sh` | glTF textures to KTX2 (basisu), then `gltf-transform optimize --compress meshopt`. |
| `manifest-lib.mjs` | Shared paths, manifest read/write, downloads. |

## Manifest

`hangar/html/assets/manifest.json`, paths relative to `hangar/html/`:

```json
{ "materials": { "<tag>": { "tile": 2, "maps": { "color", "normal", "orm", "height" }, "source", "author", "license" } },
  "models":    { "<name>": { "file", "scale", "source", "author", "license" } },
  "images":    { "<name>": { "file", "source", "author", "license" } } }
```

`alpha: true` on a material means its colour map carries opacity in alpha (the grating). Licences are
`CC0`, `CC-BY-4.0` or `PD`. `hangar/tests/manifest.test.mjs` checks credits, files, sizes (each file
< 100 MB, all assets < 600 MB), that every `mat:` tag in `e1m1.json` has an entry, and that every tile
gives at least 1024 px per metre from a 2048 px map.
