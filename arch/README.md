# Sandstone Arch

A natural bridge of Navajo sandstone over a still lake at night, the aurora standing over it, a
weathered lens-shaped craft exploring the canyon beneath it with a red eye that lights whatever
it studies. Built to the owner's reference picture of a Lake Powell bridge: the land is shaped
to the picture's outlines and wears the picture itself. It reacts to your cursor. A web page for
now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/arch/html/

- **Rest a fingertip on the water** and it stirs under you: a cat's-paw of ripples that runs
  with a moving finger. Rest it anywhere for a second and the craft turns to look at the spot,
  its red eye brightening and its beam falling there.
- **Click the water** and a stone is tossed in: a plunk, a spray of drops, rings spreading out;
  if it lands near the craft, the craft flinches and its lights flare. Click the shore and the
  stone thumps down in a puff of dust and stays there.
- **Click the craft** and it wakes: its running lights sweep round the hull, it dips and rises,
  and the eye brightens.
- **Click the sky** and the aurora answers: a bright surge starts in the nearest curtain where
  you clicked and runs off along it.
- **Left alone**, the night goes on. The aurora runs its substorm cycle (quiet arcs that
  brighten and break into folded, rayed curtains, then fade to pulsing patches). The craft
  explores: a slow circuit of eight stations, out in front of the span, under the crown, and far
  up the canyon to the wall at its end, where it is small in the distance; at each it pauses,
  turns so its eye bears on something (the abutment, the underside of the span, the buttress,
  the beach, the far wall) and studies it with a red beam, then moves on. Its rim lamps lay
  small discs of warm light on rock it passes close to. The shrubs stir in the breeze and the
  lake mirrors all of it.
- **Rain** (menu, `R`) brings the storm: rain streaks the air and peppers the lake with rings,
  a lid of grey cloud hides the stars, aurora and moon, the fog draws in, the rock goes dark and
  glossy, and every few seconds a forked bolt strikes somewhere ahead and its flash lights the
  clouds, the canyon and the wet faces. The craft's dome takes the rain: rings where drops
  strike, a film running down it in rivulets that leaves it dark and glossy, and drips off its
  rim that ring the water where they land.
- **Aurora** (`A`), **Moonlight** (`M`) and **The Craft** (`C`) can each be turned off.
  **Aurora Surge** (`S`) jumps the display to the break-up of a substorm. **New Night** re-seeds
  the scatter of blocks and shrubs. **Click to Splash** turns clicks off, for when the page is a
  background. **Low Power** runs at 30 fps with a smaller wave simulation.
- `?aurora` / `?noaurora`, `?moon` / `?nomoon`, `?craft` / `?nocraft` and `?rain` / `?norain`
  on the URL override the saved settings, for testing.

## How it is built

- **The land is the picture.** The reference image (`html/assets/reference.webp`, 2000 × 1116)
  is taken to have been made by the viewer's own camera: at the origin 2.7 m above the water,
  looking down −z, pitched up 2°, with a 50° vertical field (`REF` in `terrain.js`). Its rock
  edges were measured off it column by column (the skyline, the span's underside, the far wall
  where it bounds the gap of sky) and cast back through that camera. Each rock mass is the
  visual hull of its traced skyline at a depth of our choosing (`hullMass`): full height between
  two picture columns and two depths, flat behind its front, so its outline from the eye is the
  picture's. The span is swept along x with vertical elliptical sections, each solved so the rays
  to its two traced edges are tangent to it. The shoreline is the picture's bank and beach edges
  cast onto the water plane. The picture fixes outlines, not distances; the depths are ours
  (bridge at 150 m, right dome at 165 m, far wall at 450 m).
- **The rock wears the picture.** The reference is projected onto the rock from that same camera
  and shown unlit at its own brightness (the moonlight is already in it), so scene lights barely
  touch it. A mask baked from the traced curves (`refMask`) keeps sky off the rock, and a
  surface point that lands within a few pixels of an edge steps off it into the rock. The
  picture's own craft is painted over with the wall beside it. Past the frame's edges the
  picture carries on mirrored, frame after frame, as does the traced skyline, so land outside the
  frame wears the same rock. Because the rock ignores scene lights, the craft's eye beam and
  rim lamps are drawn by the rock shader itself (`uBeam`, `uLamp`), the beam stopping at the
  first rock a ray from the eye strikes; so is the lightning's flash and its glint on wet faces.
- **The craft** (`craft.js`) is an ellipsoid with a channel cut round its waist and a dish sunk
  for the eye behind a raised bezel; its skin (panels of many sizes with inset gutters, hatches,
  weathering, rust, the rim lamps, the eye) is drawn in the shader from the surface position.
  It walks `ROUTE`; it yaws so the eye itself bears on what it studies and tilts to carry its
  gaze; the beam is cast along the eye's own facing, so it sweeps with the hull.
- **Water, waves, rings, the sky, the moon and the aurora** are carried over from Loon Lake and
  Boreal Night; the lightning bolt from Firefly Meadow.
- The rock photographs in `html/assets/` (`wall*.png`, `wall3.webp`, `streaks.png`) are the
  owner's Lake Powell pictures; they fill the little rock the projection cannot cover.

## Testing

Console aids, as in the other backgrounds: `__view(x, y, z, fov)` aims the camera at a world
point with a narrow field; `__adv(seconds, px, py)` runs the simulation ahead with the pointer
held at a screen point; `__resume()` returns to normal; `window.arch` is the app. To check the
land against the picture, lay `assets/reference.webp` over the page as an `<img>` at 50% opacity
sized to the viewport height; to check the shore, swap the water's material for a flat colour.
Force a lightning strike with `arch.canyon.lightning.timer = 0` under rain. Module URLs in
`index.html` carry `?v=N`; raise N whenever the JS changes.
