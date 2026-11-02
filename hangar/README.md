# Hangar

A walkable remaster of Doom E1M1 as an interactive browser background (`hangar/html/`). The layout is
traced from published top-down maps (see `tools/REFERENCES.md`); no id Software files, art or WAD data
are used. Spec: `docs/superpowers/specs/2026-11-01-hangar-design.md`.

## What it is

You do not control it. A camera walks Doom's first level on its own at 1.7 m eye height and under
1 m/s: down the start room's steps, across the zigzag walkway over the glowing slime, through the
computer room (its big window looks out at Mars) and out into the courtyard, up the lift to the exit
room. The layout is a trace of E1M1 stretched for a walking camera; every surface is a scanned PBR
material, and the base is lit by fluorescent strips, amber lamps, the slime glow and the Phobos sun
and Mars-light through the openings. Web only: there is no Swift port.

Live: `https://zeblawrence.github.io/interactive-backgrounds/hangar/html/` (serve the repo root with
`python3 -m http.server 8000` and open `/hangar/html/` to run it locally). The first area loads
first and the walk starts as soon as it is ready; the rest of the textures and props stream in.

## The camera and the cursor

- **A person on foot.** The route is a graph of the level's walkable sectors (no walking through
  walls, ledges or props: the walker treats props as walls), string-pulled, meandered a little and
  smoothed. Speed eases in and out and slows on stairs and sharp turns; the body turns on a spring, the
  head looks ahead along the path, glances aside now and then, and bobs and sways a little.
- **Doors and the lift.** Each door is two panels meeting at a horizontal seam with hazard bands either
  side of it: as the camera approaches, the top panel rises into the lintel and the bottom one sinks
  into the floor, and they close again behind it. The camera waits for a closed door and rides the lift.
- **The cursor.** Moving the cursor biases the gaze: the head leans toward wherever it is. A cursor
  that comes to rest after moving (it travelled, then held still for 0.8 s) makes the camera stop,
  and look at the spot under it for about 4 s; a cursor that has not moved never triggers that pause.
- **Click the floor:** the camera walks there. **Click a door:** it opens (or closes, if the camera is
  not using it). **Click a wall switch:** that room's lights fade off, or back on (Emergency Power still
  overrides: its red lamps light the room either way). **Click a console:** its screen wakes and
  scrolls a burst of log text.
- **The courtyard is open to the sky.** Doom's tall courtyard walls on the open (south) side and the gaps
  between buildings are lowered to 1.1 m parapets, so Mars hangs over the courtyard and fills the
  computer-room window; the walkable layout is unchanged.
- Every launch and every New Tour scatters the props, grime and lamp quirks differently and takes a
  different route.

## Menu and URL flags

Top-right button (it fades when idle):

| Item | Key | What it does |
|---|---|---|
| New Tour | | reseeds the dressing and the route |
| Emergency Power | `E` | the main lights drop out; red emergency lamps and the slime carry the scene |
| Low Power | | 30 fps, the drawing buffer capped near 1920 x 1080 pixels (still 4x MSAA), no ambient occlusion, and fewer shadow casters |
| Full Screen | | |

Flags: `?seed=N` (fixed tour), `?emergency` / `?noemergency`, `?lowpower`, `?perf` (frame timing,
draw calls, texture memory). The settings are remembered in `localStorage`.

Default mode renders at the window size x `devicePixelRatio` (capped at 2) with 4x MSAA, ambient
occlusion and bloom: sharpness is the owner's priority. A frame-rate governor holds 60 fps, or a steady
30 when 60 cannot be held; it never lowers the resolution. On a 4K display with a modest GPU the
default mode can run well under 30 fps; Low Power exists for that.

## Asset pipeline

`tools/` holds offline scripts (nothing runs in the browser); `tools/README.md` has the full rebuild
recipe. In short: Poly Haven and ambientCG (CC0) downloads are packed into
colour / normal / ORM / height maps and encoded as KTX2 (UASTC, mipmapped) with `basisu`; props are
optimised to meshopt GLBs; the Viking mosaic of Mars is resampled to 8192 x 4096. Outputs and
`html/assets/manifest.json` (source, author and licence of every file) are committed; raw downloads
are git-ignored. The page loads the manifest, then the files by priority, and the scene swaps each
one in as it arrives. Only sources that need no account are used. `tools/SKETCHFAB-WISHLIST.md` lists
richer CC-BY props (consoles, doors, lift, railings) the owner can download by hand and drop in;
the current ones are modelled in code or Blender with the scanned materials. The floor plan is
traced from published top-down maps (`tools/REFERENCES.md`). Tests: `node --test 'hangar/tests/*.test.mjs'`.

## Credits

Every asset the page loads is listed in `html/assets/manifest.json` with its source, author and
licence; this table mirrors it. Thanks to Poly Haven and ambientCG for CC0 scans, and to NASA / JPL /
USGS for the Viking mosaic. How the files were fetched and encoded: `tools/README.md`.

| Kind | Key | Asset | Author | Licence | Source |
|---|---|---|---|---|---|
| Material | `mat:computer` | Blue Metal Plate | Rob Tuytel | CC0 | https://polyhaven.com/a/blue_metal_plate |
| Material | `mat:concrete` | Hangar Concrete Floor | Dimitrios Savva | CC0 | https://polyhaven.com/a/hangar_concrete_floor |
| Material | `mat:concrete-cracked` | Cracked Concrete | Dimitrios Savva | CC0 | https://polyhaven.com/a/cracked_concrete |
| Material | `mat:concrete-painted` | Painted Concrete 02 | Rob Tuytel | CC0 | https://polyhaven.com/a/painted_concrete_02 |
| Material | `mat:concrete-stained` | Concrete Wall 006 | Dario Barresi, Charlotte Baglioni | CC0 | https://polyhaven.com/a/concrete_wall_006 |
| Material | `mat:diamond-plate` | DiamondPlate001 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/DiamondPlate001 |
| Material | `mat:hazard` | PaintedMetal016 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/PaintedMetal016 |
| Material | `mat:panel-brown` | Metal Plate 02 | Rob Tuytel | CC0 | https://polyhaven.com/a/metal_plate_02 |
| Material | `mat:regolith` | Moon 01 | Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi | CC0 | https://polyhaven.com/a/moon_01 |
| Material | `mat:rubber` | Rubber Tiles | Amal Kumar | CC0 | https://polyhaven.com/a/rubber_tiles |
| Material | `mat:rust` | Rust Coarse 01 | Dimitrios Savva, Rico Cilliers | CC0 | https://polyhaven.com/a/rust_coarse_01 |
| Material | `mat:steel` | MetalPlates001 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/MetalPlates001 |
| Material | `mat:steel-brushed` | Metal009 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/Metal009 |
| Model | `boulder-a` | Moon Rock 01 | Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi | CC0 | https://polyhaven.com/a/moon_rock_01 |
| Model | `boulder-b` | Moon Rock 03 | Greg Zaal, Rico Cilliers, Jenelle van Heerden | CC0 | https://polyhaven.com/a/moon_rock_03 |
| Model | `crate` | Old Military Crate | Jack Mava | CC0 | https://polyhaven.com/a/old_military_crate |
| Model | `drum-blue` | Barrel 02 | Jorge Camacho | CC0 | https://polyhaven.com/a/Barrel_02 |
| Model | `drum-red` | Barrel_01 | Jorge Camacho | CC0 | https://polyhaven.com/a/Barrel_01 |
| Model | `extinguisher` | Korean Fire Extinguisher 01 | UM JOORIN | CC0 | https://polyhaven.com/a/korean_fire_extinguisher_01 |
| Model | `gas-tank` | Propane Tank | Slinc | CC0 | https://polyhaven.com/a/propane_tank |
| Model | `generator` | Portable Generator | James Ray Cock | CC0 | https://polyhaven.com/a/portable_generator |
| Model | `jerrycan` | Metal Jerrycan | Sean Buckley | CC0 | https://polyhaven.com/a/metal_jerrycan |
| Model | `power-box` | Power Box 01 | Rico Cilliers, Yann Kervran | CC0 | https://polyhaven.com/a/power_box_01 |
| Model | `tool-chest` | Metal Tool Chest | Yann Kervran, John Hutcheson | CC0 | https://polyhaven.com/a/metal_tool_chest |
| Model | `toolbox` | Metal Toolbox | Mateusz Sadek | CC0 | https://polyhaven.com/a/metal_toolbox |
| Model | `utility-box` | Utility Box 01 | James Ray Cock | CC0 | https://polyhaven.com/a/utility_box_01 |
| Image | `mars` | Mars Viking MDIM2.1 Colorized Global Mosaic (1 km/px release), resampled to 8192 x 4096 | NASA / JPL / USGS Astrogeology Science Center | PD | https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m |

Viking mosaic: USGS Astrogeology, *Mars Viking MDIM2.1 Colorized Global Mosaic*, downloaded from
https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg, resampled to 8192 x 4096.

Inspired by Doom (id Software, 1993); no id assets are used.
