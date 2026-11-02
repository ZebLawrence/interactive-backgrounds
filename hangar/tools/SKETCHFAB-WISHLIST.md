# Sketchfab wish list (for Zeb to download by hand)

Sketchfab downloads need a logged-in account, which the build agent must not use (ruling R5). These
models would lift props that are otherwise modelled in code or Blender with the scanned materials.
All were listed by Sketchfab's public search API as downloadable under **CC Attribution** (CC BY 4.0)
on 2026-11-01. Check the licence on the page before downloading (authors can change it), and skip
anything that has become NC or ND.

## How to bring one in

1. Download the **glTF** (or GLB) from the model page into `hangar/tools/raw/models/<name>/`.
2. `bash hangar/tools/prepare-models.sh <name>` (KTX2 textures, meshopt geometry) writes
   `hangar/html/assets/models/<name>.glb`.
3. Add a `models.<name>` entry to `hangar/html/assets/manifest.json`: `file`, `scale` (to metres),
   `source` (the page URL below), `author`, `license: "CC-BY-4.0"`.
4. Credit it in `hangar/README.md`. Run `node --test 'hangar/tests/*.test.mjs'`.

## Models

| # | Model | Author | Licence | Page | Would replace |
|---|---|---|---|---|---|
| 1 | Old Nasa Style Computer Console | SUrusso613 | CC BY 4.0 | https://sketchfab.com/3d-models/2250dde29597458a809ca96757afdc8c | Computer room: the banks of consoles (Doom's blue computer walls as real consoles) |
| 2 | Large Wall-Mounted Computer Console | Inditrion Dradnon | CC BY 4.0 | https://sketchfab.com/3d-models/298b7d9b68064618a3819d1a8fae4baf | Wall consoles along the computer-room walls and by the doors |
| 3 | Server Rack | Shalmon | CC BY 4.0 | https://sketchfab.com/3d-models/c144d837358d446998c7b63cd1bdf825 | Rows of racks behind glass in the computer room |
| 4 | Free Airlock Door | michael_grodkowski | CC BY 4.0 | https://sketchfab.com/3d-models/58729c7672ae4e01a6103617c2f4f55e | Sliding door panels and frames (Task 11 doors) |
| 5 | Sci-fi Door (high poly) | Scarecrow_original | CC BY 4.0 | https://sketchfab.com/3d-models/2e8c613214144d12bce416ce437614d6 | Alternative door: heavier frame for the silver door-frame motif |
| 6 | Metal Railing Modular - 2048px² | Mark Peters | CC BY 4.0 | https://sketchfab.com/3d-models/fe569b1c83ba4daab50787c9e4bb181f | Railings on the zig-zag walkway over the slime |
| 7 | Weathered Fluorescent Light/Lamp - 4096px² | Mark Peters | CC BY 4.0 | https://sketchfab.com/3d-models/5d29d2370ec846a2a461de351bba8872 | Ceiling light fittings for the cold fluorescent strips |
| 8 | Fluorescent Light Fixtures - 4x 4096px² | Mark Peters | CC BY 4.0 | https://sketchfab.com/3d-models/2a05034d61dc49bf81b33de44add7aa8 | Variety for the same, so corridors don't repeat one fitting |
| 9 | Sci-Fi Machinery: Pipes Modular Asset Pack | somni | CC BY 4.0 | https://sketchfab.com/3d-models/0b8188107ef040149f2f71eb08e9ce16 | Pipes and cable runs in the low corridors |
| 10 | Barrels Of Toxic Waste | re1monsen | CC BY 4.0 | https://sketchfab.com/3d-models/79980848b6e94b9687ef8e195f5f22d8 | The green-slime barrels (an original design, not id's barrel) in place of Poly Haven `barrel_03` |
| 11 | Large Industrial Storage Tanks | Duane's Mind | CC BY 4.0 | https://sketchfab.com/3d-models/bd3ac97071104b64bc388a155b64f79e | Tanks in the courtyard and the tall hall |
| 12 | Elevator Buttons | darksoundlab | CC BY 4.0 | https://sketchfab.com/3d-models/aea17e8db7d049fcac7f9927e10a5b80 | The lift's call switch and the wall switch panels |

Deliberately left off: fan models of Doom's own barrel or weapons (they copy id Software art, which
the spec rules out) and anything marked NonCommercial, NoDerivs or ShareAlike.
