# Trawler asset tools

Offline tools that fetch the scanned materials and props the page loads from `trawler/html/assets/`.
Nothing here runs in the browser. Raw downloads go to `trawler/tools/raw/`, which is git-ignored;
only the processed WebP / glTF files and `manifest.json` are committed.

Sources are only ones that need no account: Poly Haven and ambientCG, both CC0. Sketchfab models
would have to be fetched by hand — see `SKETCHFAB-WISHLIST.md`.

## Requirements

- Node 20+ (uses the built-in `fetch`) and `unzip` for the ambientCG archives.
- Python 3 with Pillow (`pip install pillow`).

No encoder toolchain is needed. Hangar encoded its maps as KTX2 with Binomial's `basisu`, which is a
Homebrew package and a macOS build; there is no equivalent to hand here, and the only portable
encoder is a WebAssembly build that would have to be downloaded and executed, which this environment
does not permit. WebP costs more GPU memory than a block-compressed format, but it is *sharper* (no
4x4 block artefacts) and at 1024 px over a 1 m tile it still meets the project's 1024 px per metre
rule for everything within arm's reach — which, in a pilot house, is nearly everything.

## Rebuild everything

```bash
T=trawler/tools
# Materials: <library> <assetId> <tag> <tile metres>. The tile is the real-world size one repeat of
# the texture covers, and it is what sets the pixels per metre once pack.py has written 1024 px maps.
node $T/fetch.mjs material polyhaven teak_veneer            mat:teak          1
node $T/fetch.mjs material polyhaven plywood                mat:plywood       1
node $T/fetch.mjs material polyhaven painted_metal_shutter  mat:paint         1
node $T/fetch.mjs material polyhaven rusty_painted_metal    mat:paint-worn    1
node $T/fetch.mjs material polyhaven rubber_tiles           mat:rubber        1
node $T/fetch.mjs material polyhaven brown_leather          mat:leather       0.6
node $T/fetch.mjs material polyhaven wood_floor_deck        mat:deck          1
node $T/fetch.mjs material polyhaven painted_plaster_wall   mat:enamel        1
node $T/fetch.mjs material polyhaven rusty_metal_03         mat:steel-rust    1
node $T/fetch.mjs material polyhaven dark_rock              mat:rock          3
node $T/fetch.mjs material polyhaven cliff_side             mat:rock-cliff    4
node $T/fetch.mjs material polyhaven brown_mud_rocks_01     mat:scree         2
node $T/fetch.mjs material polyhaven forest_ground_06       mat:heath         2
node $T/fetch.mjs material polyhaven coast_land_rocks_01    mat:shore         2
node $T/fetch.mjs material ambientcg Snow006                mat:snow          2
node $T/fetch.mjs material ambientcg MetalPlates001         mat:steel         1
node $T/fetch.mjs material ambientcg Metal009               mat:steel-brushed 0.6
python $T/pack.py                      # raw/materials/* -> html/assets/materials/*

# Props: <assetId> <name>. Poly Haven models are modelled at their real size in metres, which is the
# unit this scene is in, so nothing is rescaled here or in the page — they are placed.
for a in seadogs_compass:compass vintage_radio_transceiver:vhf binoculars:binoculars \
         wall_clock:clock clipboard:clipboard plastic_thermos:thermos \
         vintage_flashlight:torch fishermans_hat:hat metal_stool_02:stool \
         korean_fire_extinguisher_01:extinguisher plastic_crate_02:crate \
         metal_jerrycan:jerrycan lifebuoy:lifebuoy life_jacket:lifejacket \
         old_tyre:fender caged_hanging_light:caged_light \
         ocean_buoy:buoy lateral_sea_marker:seamark; do
  node $T/fetch.mjs model "${a%%:*}" "${a##*:}"
done
python $T/prepare-models.py            # raw/models/* -> html/assets/models/*

# The Milky Way: NASA SVS Deep Star Maps 2020, the starless equatorial map, public domain.
mkdir -p $T/raw/sky
curl -L -o $T/raw/sky/milkyway_2020_4k.exr \
  https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr
python $T/prepare-sky.py               # raw/sky/*.exr -> html/assets/milkyway.webp
```

`prepare-sky.py` needs an EXR reader: `pip install OpenEXR`. It prints where it finds the galactic
centre in the packed image, which is the check that the map's own convention (RA 0 at the centre,
RA rising to the left, north along the top) is the one the page assumes.

Each `fetch.mjs` run records the asset's name, author, licence and source URL in
`html/assets/manifest.json`, which is what the README's credits table mirrors and what the page reads
at load time. The sky's two moon maps and `html/data/stars.bin` are copied from the other scenes in
this repository rather than refetched; their provenance is in the README. `milkyway.webp` is built
here, from the same NASA release Hangar uses, at a quarter of Hangar's width: the sky in this scene
is a strip seen through a window rather than the whole frame, so 4096 x 2048 is enough and it costs
4 MB instead of 38.

## What each script does

| Script | What it does |
|---|---|
| `fetch.mjs` | downloads a Poly Haven or ambientCG material or a Poly Haven model into `raw/`, and writes its credits into the manifest |
| `manifest-lib.mjs` | the shared bits: paths, slugs, the manifest read/write, HTTP with retries |
| `pack.py` | a raw material folder to the three WebP maps the page loads: `color` (sRGB, quality 92), `normal` (lossless — a normal map is a vector field and lossy chroma puts facets in it), `orm` (AO / roughness / metalness packed into R / G / B, quality 95) |
| `prepare-models.py` | a raw glTF prop to `html/assets/models/<name>/`, with its PNG maps converted to WebP and the glTF's image URIs repointed. The geometry is left exactly as downloaded: these are a handful of objects seen close up, not a forest |
| `prepare-sky.py` | NASA's starless Milky Way EXR to `html/assets/milkyway.webp`: linear radiance divided by 0.2 and sRGB-encoded, 4096 x 2048, north along the top row (no flip, because a `THREE.Texture` uploads with `flipY` and SphereGeometry puts v = 1 at +y) |

Height maps are deliberately not packed. Hangar's lesson was that parallax on a surface seen at a
grazing angle smears and shimmers, and that relief the camera gets close to is better built as
geometry; the normal map carries the rest.

## Checking the result

The page has a debug API (`window.trawler`) for the things that have to be measured rather than
looked at:

| Call | What it tells you |
|---|---|
| `trawler.propSizes()` | the bounding box of every scanned prop, in metres, in the pilot house's own frame. A prop whose numbers do not read like the real object is placed or scaled wrong |
| `trawler.verifyOcean()` | the sea the GPU draws against the sea the hull rides, at random points |
| `trawler.shaderErrors()` | any shader that failed to compile, by name |
| `scene.sky.skyMatrix`, `scene.sky.milkyWay.matrix` | the equatorial-to-world matrix and the band's own frame: invert the second and a world direction comes back as a texel of the map, which is how the band's orientation was checked against the galactic centre and the two galactic poles |
| `trawler.bench(n)` | milliseconds a frame, averaged over n frames |
| `trawler.look(x, y, z, yaw, pitch, fov)` / `trawler.at(...)` | puts the camera somewhere and renders one frame |
| `trawler.run(seconds)` | steps the simulation at 1/60 s without waiting for real time |
