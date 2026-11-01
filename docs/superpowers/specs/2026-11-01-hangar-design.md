# Hangar — design

The eighth interactive background, and the first one you move through. A remastered take on
Doom's first level (E1M1, "Hangar"): a techbase on Phobos rebuilt the way the owner remembers
it feeling in 1993, with surfaces and light at a modern (UE5-class) standard, toured by a camera
that walks the base on its own. Web page only (`hangar/html/`).

## Why

Every existing background is a stage set seen from one fixed seat: a "shadow box". The worlds
are 3D, but the viewer never enters them, and their purely procedural textures and models have
always bothered the owner ("inconsistency and poor quality"). This one answers both: a real
place the camera walks through, built from the highest-quality scanned assets available.

E1M1 was chosen for nostalgia and because what made it "earth shattering" for the owner is
spatial, not pixel detail. In their words: looking out at the Phobos sky with a real feeling of
grand scale; the changes in elevation, ceiling height, angled surfaces and walls; the natural
walking camera movement. Those five qualities are the point of the whole project.

"UE5" in the request is shorthand for the quality bar. Anything that runs in a browser is fine.

## Goals

1. **Grand scale through windows and courtyards.** Openings look out across a vast, rugged
   Phobos surface with Mars hanging huge in the sky (seen from Phobos, Mars really is about 40°
   across, so the real thing is as dramatic as the memory). The sky and the view out are a
   destination the camera keeps returning to, built with as much care as the interior.
2. **Elevation you feel.** Stairs, ramps, raised platforms, a lift, the walkway over the toxic
   pool, pits and ledges. The camera's route climbs and descends constantly.
3. **Ceilings that breathe.** Low, tight corridors open into tall halls. Squeeze then release.
4. **Angles everywhere.** Walls at 45° and odd angles, slanted surfaces, chamfered corners,
   almost no plain box rooms.
5. **A walking camera, not a drone.** It reads as a person on foot (see "The camera").
6. **Every surface holds up at 4K, close up.** Real scanned PBR materials with height maps and
   correct specular, at a consistent texel density throughout.
7. **Randomness in the dressing.** Each launch and each reseed scatters props, grime and
   lighting quirks differently, and takes the camera on a different tour.

## Anti-goals (fails even if it works)

The owner named these:

- **Blurry or inconsistent textures.** No surface that is sharper or softer than its
  neighbours, nothing that smears or shimmers at distance. Same texel density everywhere
  (target on the order of 1024 px per metre for surfaces the camera passes within a couple of
  metres), proper mipmaps, anisotropic filtering at max.
- **A robotic camera.** No constant speed, no snapped turns, no straight lines between nodes,
  no visible loop.
- **Flat surfaces with no relief and no shine.** Every material carries a height map whose
  relief is visible as the camera moves past (grating, panel seams, rivets, cracked concrete),
  and proper specular response (wet floors, polished and worn metal, the slime catch and slide
  highlights; painted concrete stays dull). Light placement must make both visible: a grazing
  or near-field light on the surfaces the camera passes close to (guidelines section 1:
  "relief needs a light that can show it").

Also from `guidelines.md`, which applies in full: nothing floats, objects darken the ground
where they touch, slow and peaceful but never still, frame the edges.

## Non-goals

- No creatures, enemies, weapons, HUD, pickups-as-gameplay or player control (WASD).
- No id Software assets: no original textures, sprites, sounds or music, and no WAD files in
  the repo. The floor plan is traced (see "The place"), but every mesh and material is our own
  or openly licensed. The original graphics would clash with the realism anyway. Skip any
  downloaded model that bundles Doom's own art.
- No sound (consistent with the other backgrounds).
- No native Swift port for now. Web only.
- Not a pixel-faithful conversion. The traced layout may be stretched or adjusted wherever
  that serves the five qualities.

## Constraints

- **Target:** Chrome on the owner's RTX 3080 PC, 4K monitor. Running well on the Mac mini
  (also 4K) is a bonus; Low Power mode exists for it.
- **Sharpness beats frame rate (owner's call).** Render at native 3840x2160, no upscaling
  from a lower internal resolution. Aim for 60 fps; if the effects don't fit, the frame rate
  gives first (a steady 30 fps is acceptable for a slow walking camera), and baking lighting
  is the next lever. Never trade resolution for speed in the default mode. Since the Mac
  can't measure the 3080, performance on the target is confirmed by the owner.
- **Hosting:** GitHub Pages from this repo, like the others. GitHub caps single files at
  100 MB; keep the whole background's assets well under 1 GB, ideally a few hundred MB.
  A load of several seconds is acceptable for something that runs for hours, but show
  progress and start walking as soon as the first area is ready.
- **Conventions** (guidelines section 3): one folder, ES modules, Three.js from the CDN by
  import map, versioned module URLs, wait for a real window size. The *page* still has no
  build step. An offline asset-preparation script (texture compression, model optimisation)
  is allowed and lives in `hangar/tools/`; its outputs are committed.
- **Licensing:** CC0 sources first (Poly Haven, ambientCG). Sketchfab models are approved by
  the owner; use CC0 or CC-BY ones (Mac's call: not NC or ND, to stay clear of any doubt about
  redistribution and editing). Every asset credited in `hangar/README.md`. Mars
  and Phobos imagery from NASA/JPL/USGS (public domain), credited.

## The place

Units are metres. **The owner chose to trace the real E1M1 layout:** take the floor plan,
room order, floor and ceiling heights and the angled walls from published E1M1 map images
(top-down plans and the documented sector heights), convert at about 1 Doom unit = 3 cm, and
build that. Adjust it only where the five qualities or the camera need it (wider for a walking
camera, taller where a hall should tower, more openings to the sky). The rooms below are what
the trace should produce.

**Look (Mac's call):** recognisably Doom, reinterpreted as real materials. Echo the original's
motifs, so the brown tech panelling becomes weathered brown composite panels with real
seams and fasteners, the blue computer walls become real banks of consoles and glass, and the
silver door frames, hazard trim, lit wall strips and green slime keep their places and
colours. Not a generic sci-fi base.

- **Start room.** A raised platform with steps down into a wider space with angled walls, light
  strips, columns.
- **The slime hall.** A tall hall over a pool of glowing green toxic liquid, crossed by a
  zigzag walkway of steel grating with railings. The slime lights the walls and ceiling from
  below and slowly moves; the walkway casts shadows into it.
- **Corridors.** Low, tight, angled, with pipes and cable runs, opening onto the big spaces.
- **Computer room.** Banks of consoles and screens (animated, abstract readouts), a large
  window out onto the courtyard and Phobos beyond.
- **The courtyard.** Open to the sky: Phobos regolith and rock, a slime channel, a raised
  platform, the walls of the base rising round it, Mars overhead.
- **A dark zone.** A dim stretch lit mostly by flickering or emergency lamps, for contrast.
- **The way out.** A lift or stair up to a high exit room with the widest view.

Real E1M1 is laid out at roughly 1 Doom unit = 3 cm (a 56-unit player is 1.7 m). Where real
architecture and Doom's proportions disagree (a sensible 3 m ceiling versus a 15 m hall), the
Doom proportion wins: the spatial feeling overrides realism.

## Surfaces and light

- **Materials:** scanned PBR sets (colour, normal, roughness, height, AO; metalness where
  relevant): concrete in several states (painted, stained, cracked), brushed and painted steel,
  diamond plate, grating, rust, rubber, hazard stripes, glass, regolith. Decals for grime,
  leaks, scuffs and warning signage, varied by seed.
- **Relief:** parallax occlusion mapping (or real displacement) near the camera, fading to the
  normal map with distance; geometry, not texture, for anything the camera passes very close
  to (pipes, railings, grate bars, door frames).
- **Light:** a mix of cold fluorescent strips, warm sodium or amber lamps, red emergency lights,
  the green slime glow (emissive, and lighting its surroundings), and sunlight and Mars-light
  through the openings. Real-time shadows for the key lights near the camera's position.
  Wet patches and the slime surface should show reflections (screen-space reflections or
  probes).
- **Post:** ambient occlusion, bloom on emissives, subtle haze or light shafts in the tall
  spaces, tone mapping that keeps the darks dark. Temporal anti-aliasing so fine geometry
  (grating, railings) does not crawl.

## The camera

The camera walks the base on its own, forever.

- **Movement:** eye height about 1.7 m, walking pace around 1 m/s or slower (halve the first
  guess, per the guidelines), easing in and out of every move. A gentle step bob and sway, on
  stairs too. Smooth curved paths round corners, never node-to-node straight lines.
- **Attention:** the head leads the body. It glances at things, looks up when a room opens,
  slows near windows and the slime, sometimes stops for several seconds to take in a view.
- **Exploration:** it picks its next destination from a set of points of interest, weighted
  away from places it visited recently, so no two tours repeat. Doors slide open as it
  approaches and close behind it; it rides the lift.
- **Mouse:**
  - **Move:** the gaze drifts gently toward the cursor (a bias, not direct control).
  - **Rest:** when the cursor *comes to rest after moving*, the camera pauses for a few
    seconds and looks at what is under it, then carries on. A cursor that simply sits still
    for hours (the normal state on a desktop) does nothing: the tour is the default state,
    not the exception. (Mac's call.)
  - **Click:** a hint. Clicking a reachable spot sends the camera there; clicking a switch,
    door or console operates it (lights change, a door opens, a screen wakes).
  - After a short idle period it returns to exploring on its own.
- **Never breaks the illusion:** no clipping through walls or railings, never walks into a dead
  end it then visibly reverses out of, never shows the edge of the world.

## Randomness per seed

The layout is fixed (my call, see below). Each seed varies: prop scatter (crates, barrels,
debris, cables, tools, puddles) placed by rules (resting on surfaces, clustered against walls
and in corners, never floating, contact shade under each), decals and grime, which lamps
flicker or are dead, screen content, and the camera's tour.

## Menu

The same top-right glass menu as the others: **New Tour** (reseed), **Emergency Power**
(mood toggle, `E`: main lights die, red emergency lighting and the slime glow carry the scene),
**Low Power** (30 fps, lower resolution, fewer shadows), **Full Screen**. URL flags for seed and
modes, for testing.

## Decided by the owner

- The camera wanders on its own and takes cues from mouse movement and clicks.
- Browser only; any technique is fine.
- High-quality real assets instead of procedural textures and models; random placement a bonus.
- The place is Doom E1M1, detailed to the max, with the real layout traced. No creatures.
- Sketchfab models are fine (with credits).
- Sharpness over frame rate and over upscaling.
- The five qualities and the three anti-goals above, in their words.
- Target is Chrome on the RTX 3080 PC at 4K; the Mac mini is a bonus.

## Calls made by Mac (the owner can overrule)

- Three.js, using its WebGPU renderer if the effects need it, otherwise WebGL2; staying in the
  repo's existing stack keeps GitHub Pages hosting and no page build step.
- Fixed hand-designed layout with randomised dressing, rather than generated layouts.
- No sound, no Swift port, folder name `hangar`.
- Emergency Power as the one mood toggle.
- Doom's motifs reinterpreted as real materials (not a generic sci-fi base).
- Sketchfab limited to CC0 and CC-BY.
- Cursor "rest" means a brief pause after movement, not any stillness.
- Asset budget of a few hundred MB, compressed (KTX2 textures, optimised glTF).

## Left to the builder

The renderer choice within Three.js, the exact room shapes and route graph, the
camera-path maths, the post-processing stack, the asset list within the licensing rule, how
the asset-preparation script works, and how points of interest are chosen and weighted.
