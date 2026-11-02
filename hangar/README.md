# Hangar

A walkable remaster of Doom E1M1 as an interactive browser background (`hangar/html/`). The layout is
traced from published top-down maps (see `tools/REFERENCES.md`); no id Software files, art or WAD data
are used. Spec: `docs/superpowers/specs/2026-11-01-hangar-design.md`.

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
| Material | `mat:grate` | MetalWalkway006 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/MetalWalkway006 |
| Material | `mat:hazard` | PaintedMetal016 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/PaintedMetal016 |
| Material | `mat:panel-brown` | Metal Plate 02 | Rob Tuytel | CC0 | https://polyhaven.com/a/metal_plate_02 |
| Material | `mat:regolith` | Moon 01 | Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi | CC0 | https://polyhaven.com/a/moon_01 |
| Material | `mat:rubber` | Rubber Tiles | Amal Kumar | CC0 | https://polyhaven.com/a/rubber_tiles |
| Material | `mat:rust` | Rust Coarse 01 | Dimitrios Savva, Rico Cilliers | CC0 | https://polyhaven.com/a/rust_coarse_01 |
| Material | `mat:steel` | MetalPlates001 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/MetalPlates001 |
| Material | `mat:steel-brushed` | Metal009 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/Metal009 |
| Model | `barrel` | Barrel 03 | Serhii Khromov | CC0 | https://polyhaven.com/a/barrel_03 |
| Model | `boulder-a` | Moon Rock 01 | Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi | CC0 | https://polyhaven.com/a/moon_rock_01 |
| Model | `boulder-b` | Moon Rock 03 | Greg Zaal, Rico Cilliers, Jenelle van Heerden | CC0 | https://polyhaven.com/a/moon_rock_03 |
| Model | `crate` | Old Military Crate | Jack Mava | CC0 | https://polyhaven.com/a/old_military_crate |
| Image | `mars` | Mars Viking MDIM2.1 Colorized Global Mosaic (1 km/px release), resampled to 8192 x 4096 | NASA / JPL / USGS Astrogeology Science Center | PD | https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m |

Viking mosaic: USGS Astrogeology, *Mars Viking MDIM2.1 Colorized Global Mosaic*, downloaded from
https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg, resampled to 8192 x 4096.
