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

### Sky and ground

The sky is the real one. Stars are the Hipparcos catalogue (118,000 stars down to V 12, each at its
measured position, brightness and colour), drawn as sharp points. The Milky Way is NASA's Deep Star
Maps 2020 (built from Gaia DR2), drawn behind them. Both are turned so the galactic centre hangs beside
Mars, on the side away from the sun.

The ground outside is real terrain: a 4 km square of the Moon's Descartes highlands at the Apollo 16
site, measured by the Lunar Reconnaissance Orbiter. It has 2 m height posts and a 0.5 m photograph
draped over it as one continuous image (8192 x 8192), with the shading of the photo's own sun divided
out. No such data exists for Phobos (its best images are about 7 m a pixel), so the Moon stands in.
Each tour turns the square to a new angle round the base. The Phobos grooves, the far ridges, the
curve of the horizon and the flat pad round the base stay as before. The tiled regolith scan adds only
the fine grain near the camera, fading to half strength by 60 m so it never repeats visibly.
`tools/prepare-sky-ground.py` makes all of these files. The boulders strewn round the base are built in
code, two new shapes each tour: fractured blocks wearing the same regolith scan.

## Credits

Every asset the page loads is listed in `html/assets/manifest.json` with its source, author and
licence; this table mirrors it. Thanks to Poly Haven and ambientCG for CC0 scans, and to NASA / JPL /
USGS for the Viking mosaic, to NASA GSFC / Arizona State University for the LROC terrain model, to
NASA GSFC's Scientific Visualization Studio (and ESA/Gaia/DPAC) for the Milky Way, and to ESA's
Hipparcos mission (via NASA HEASARC) for the stars. How the files were fetched and encoded:
`tools/README.md`.

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
| Model | `drum-blue` | Barrel 02 | Jorge Camacho | CC0 | https://polyhaven.com/a/Barrel_02 |
| Model | `drum-red` | Barrel_01 | Jorge Camacho | CC0 | https://polyhaven.com/a/Barrel_01 |
| Model | `power-box` | Power Box 01 | Rico Cilliers, Yann Kervran | CC0 | https://polyhaven.com/a/power_box_01 |
| Image | `mars` | Mars Viking MDIM2.1 Colorized Global Mosaic (1 km/px release), resampled to 8192 x 4096 | NASA / JPL / USGS Astrogeology Science Center | PD | https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m |
| Image | `milkyway` | Deep Star Maps 2020, Milky Way without the Hipparcos/Tycho stars, 8192 x 4096 | NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC | PD | https://svs.gsfc.nasa.gov/4851 |
| Image | `ground-albedo` | LROC NAC DTM APOLLO16_1, orthophoto M119754107 at 0.5 m, a 4096 m window, shading divided out | NASA / GSFC / Arizona State University | PD | https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO16_1/ |
| Image | `ground-normal` | LROC NAC DTM APOLLO16_1, normals of the same window (2 m posts) | NASA / GSFC / Arizona State University | PD | https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO16_1/ |
| Data | `data/ground.bin` | LROC NAC DTM APOLLO16_1, heights of the same window (2 m posts, tilt removed) | NASA / GSFC / Arizona State University | PD | as above |
| Data | `data/stars.bin` | Hipparcos Main Catalogue (ESA 1997), HEASARC copy: positions, V magnitudes, B-V colours | ESA Hipparcos mission; NASA HEASARC | PD | https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/hipparcos.html |

Viking mosaic: USGS Astrogeology, *Mars Viking MDIM2.1 Colorized Global Mosaic*, downloaded from
https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg, resampled to 8192 x 4096.

Inspired by Doom (id Software, 1993); no id assets are used.
