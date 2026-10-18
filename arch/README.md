# Sandstone Arch

A natural bridge of Navajo sandstone over a still lake at night, the aurora standing over it, a
craft hovering silently beneath it with its lights laid on the water. Built from the owner's
reference image of a Lake Powell bridge; the rock is wrapped in the owner's own Lake Powell
photographs when they are present. It reacts to your cursor. A web page for now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/arch/html/

- **Rest a fingertip on the water** and the carp come up to it: the nearest two or three turn,
  cruise over and hang under the spot, mouthing at the surface in little rings. Rest it anywhere
  for a second and the craft turns its red eye toward you.
- **Click the water** and a stone is tossed in: a plunk, a spray of drops, rings spreading out,
  the fish bolting; if it lands near the craft, the craft flinches and its lights flare. Click
  the shore and the stone thumps down in a puff of dust and stays there.
- **Click the craft** and it wakes: its running lights sweep round the hull, it dips and rises,
  and the eye brightens.
- **Click the sky** and the aurora answers: a bright surge starts in the nearest curtain where
  you clicked and runs off along it.
- **Move the cursor fast** over the water and a cat's-paw of ripples runs under it; the fish bolt.
- **Left alone**, the night goes on: the aurora runs its substorm cycle (quiet arcs that brighten
  and break into folded, rayed curtains, then fade to pulsing patches), the craft holds station
  with a slow breath and a slower drift, scanning, its lights pulsing, the carp and striped bass
  patrol the shallows and the carp slurp at the surface, the shrubs stir in the breeze, and the
  lake mirrors all of it.
- **Aurora** (menu, `A`), **Moonlight** (`M`) and **The Craft** (`C`) can each be turned off.
  **Aurora Surge** (`S`) jumps the display to the break-up of a substorm. **New Night** re-seeds
  the bridge's bulges and the scatter of blocks and shrubs. **Click to Splash** turns clicks
  off, for when the page is a background.

## Your photographs

Drop these into `html/assets/` (JPG, WebP or PNG; landscape; the bigger the better; no sky in
frame if possible) and reload. Each is optional; without them the rock is a plain procedural
sandstone.

| file | used for | drawn as |
|---|---|---|
| `wall.jpg` | every steep face: the bridge, the cliffs, the abutments | 70 m wide in the world |
| `wall2.jpg` | a second cliff face, blended in patches with the first to hide repetition | 55 m |
| `slickrock.jpg` | the tops: the bridge's back, the domes, the plateau | 60 m |
| `shore.jpg` | the beach, from the waterline to a few metres up | 18 m |

The widths are in `terrain.js` (`PHOTOS`), and matter: a photo that covers 20 m of cliff drawn at
70 m looks like the right rock at the wrong scale.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/arch/html/`. In the URL, `?aurora` /
`?noaurora`, `?moon` / `?nomoon` and `?craft` / `?nocraft` override the saved settings for testing.
From the console, `__view(x, y, z, fov)` aims the camera at a world point with a narrow field of
view and renders once, `__adv(seconds, px, py)` runs the simulation ahead with the pointer held at a
screen point, and `__resume()` returns to normal.

## How it works

- Units are metres. The water is y = 0; the viewer stands at the water's edge on a low rocky
  bank at the origin, 1.7 m up, looking across the lake (-z) at the bridge 150 m away, the
  camera lifted three and a half degrees so the waterline sits a little below centre and the
  whole arch stands in frame with sky above it (`scene.js`). A screen point maps to a ray, so
  clicks land on the water, the shore, the rock or the craft, and the creatures react in screen space.
- `terrain.js` is the land: one heightfield (fine near the viewer, coarse toward the skyline)
  from a function that sums rounded masses of rock: the cliff mass the bridge springs from on the
  left, a lower shoulder of it by the beach, the abutment on the right and the rise behind it,
  the wall beyond the bridge, and the mesas and the skyline in the distance; a beach that runs
  from the near bank along the left shore to the cliff foot; and a lake floor nine metres deep.
  The bridge is a rib of flattened elliptical section swept along an arc that rises steeply from
  the cliff, crests left of centre and runs down to the abutment, 160 m wall to wall, its
  opening about 38 m high, roughened by noise. The rock material projects the photographs
  triplanar in world metres (steep faces by their facing, tops by the up component), each photo
  sampled twice at different scales and offsets and blended by a slow noise so no repeat shows
  twice at one size, with the photo's own light and dark turned into relief so the moon rakes
  across its texture; the beach takes the shore photo; the aurora's green falls on upward faces
  and warm bounce on the bridge's underside.
- `craft.js` is the craft: a lens-shaped hull 32 m long, blunter below, whose skin is drawn in the
  shader (panels on a staggered grid, seams, rivets, a few darker panels, a dark girdle at the
  waist), with fourteen amber running lights round the waist that pulse and sweep when it is
  roused, a red lens forward in a dark ring that tracks and brightens, and point lights for the
  glow on the hull and the water. It holds station on a spring with a four-second breath and a
  drift that changes its mind every half minute, yaws to look at a resting cursor, flinches from
  a splash, and dips when clicked.
- `aurora.js` is Boreal Night's aurora: three curtains at a tenth of real scale with the Earth's
  curvature, rays, folds, and the substorm cycle, standing over the bridge to the north; its
  light is a uniform the rock and the sky read.
- `sky.js` is the night dome (the Milky Way painted once onto a canvas, four layers of hashed
  stars that wash out under a bright aurora, airglow, the moon's halo), the moon (NASA's LRO
  maps, see below) low behind the viewer's left shoulder, and the light state: a moon drawn
  stronger and warmer than a real one, as the reference has it, raking the bridge from the left,
  with a 4096 shadow map fitted round the bridge and the near shore.
- `water.js` is Loon Lake's water: a 2048-cell wave simulation over the near 48 m, a reflection
  pass through a mirror camera with an oblique clip plane, a refraction pass with depth, analytic
  rings farther out, the breeze's cat's-paws, and dark night water whose depth gives back almost
  nothing, so the lake is the mirror the reference shows.
- `shore.js`: shrubs (arching stems with feathery sprays on alpha cards, swaying in the breeze)
  along the left beach and at the near bank, blocks and cobbles in the rock material, and the
  dust and water-drop sprite pools.
- `fish.js`: common carp and striped bass in the shallows along the near shore, with Loon Lake's
  behaviour: cruise, hold, the carp's rise to slurp, investigate the fingertip, flee.
- Like the other backgrounds it renders at a fixed 30/60 fps, shader time wraps hourly with every
  frequency quantised to that period, and apart from the photographs everything is procedural.

The moon maps in `html/assets/` (`lroc_color_2k.jpg`, `ldem_3_8bit.jpg`) are from NASA's
Scientific Visualization Studio CGI Moon Kit (https://svs.gsfc.nasa.gov/4720); credit: NASA's
Scientific Visualization Studio. The rock photographs are the owner's own.
