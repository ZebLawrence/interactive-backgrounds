# Sandstone Arch — design

## Rebuilt (same day)

The owner reviewed the slot-canyon build and asked to start over from a fourth reference image: a
natural bridge over a still lake at night, the aurora standing over it, a lens-shaped craft
hovering beneath it with amber running lights and a red eye, its lights mirrored in the water,
the moon lighting the bridge from the left. They also expected real Lake Powell photographs for
the rock and chose to supply their own (`wall.jpg`, `wall2.jpg`, `slickrock.jpg`,
`shore.jpg` in `html/assets/`) rather than public-domain downloads. The scene below the line is
the original design and is superseded; what stands now:

- An open landscape, not a slot: a heightfield of rounded rock masses round a lake (the cliff
  mass the bridge springs from on the left, the abutment on the right, a wall beyond, mesas and a
  skyline in the distance), a beach along the left shore, a rocky near bank the viewer stands on.
- The bridge spans 160 m wall to wall 150 m away, its opening about 38 m high; the camera looks
  three and a half degrees up so the whole arch stands in frame with sky above it and the
  waterline sits a little below centre, as in the image.
- Night only: Boreal Night's aurora curtains over the bridge, the Milky Way and stars washing out
  under a bright display, a warm moon low behind the viewer's left shoulder as the key light.
- The craft: 32 m, panelled in the shader, fourteen amber lamps that sweep when roused, a red
  lens that tracks a resting cursor, point lights; station-keeping with a breath and a drift.
- Photographs projected triplanar in world metres at two blended scales, their luminance as
  relief; procedural sandstone only as the fallback for a missing file.
- Verbs: rest (carp come up; the craft looks at you), click (stone on the water or the shore;
  the craft wakes; the aurora surges where you click the sky), fast (cat's-paw, fish bolt).
  Menu: Aurora Surge, New Night, Aurora, Moonlight, The Craft, Click to Splash, Low Power, Full Screen.
- Dropped from the first build: the slot-canyon walls and their shader, the rockfall, the
  swallows and ravens, the lizard, the skiff, the dust motes, the day and dusk skies.

---


The seventh interactive background: a flooded side canyon of Lake Powell, seen from a sand bar
under an alcove, looking down the canyon through a great sandstone bridge to the water beyond.
Web page only (`arch/html/`), built to the bar in `guidelines.md`.

The owner supplied three reference images (an aurora over a bridge reflected in still water, a
boat moored in an alcove at dusk with turquoise shallows, and a thick arch over green water in
golden light with dust in the sunbeams) and asked for "something like" them, suggesting real
imagery as texture the way the Powell 3D map does. That map drapes top-down satellite tiles over
5 m terrain tiles: fine from the air, useless for a cliff face seen edge-on from the waterline.
So the sandstone here is procedural, drawn in metres in the shader, and the only bitmaps are
NASA's moon maps.

## The scene

- **Where you stand.** Units are metres. The viewer stands on a sand bar at the head of the
  canyon, at the origin, eye 1.7 m above the water, looking down the canyon (-z). Behind and
  above, the canyon head is an alcove whose ceiling overhangs the viewer; its lip crosses the
  top corners of the frame. The water begins a few metres ahead and runs under the arch
  65 m out, then on down the canyon, which bends right 200 m away so its end is hidden in haze.
- **The walls.** Navajo sandstone: a single surface per side, parametrised along a horseshoe
  centreline (left wall, round the alcove, right wall) and by height, offset outward by a width
  profile and noise. Vertical to overhanging near the water (the undercut and the alcove), bulges
  and shallow alcoves at the 5-20 m scale, ledges where harder beds stand out, rounding over
  at the rim (50-90 m up) into slickrock domes. Rim lower toward the mouth.
- **The arch.** A thick natural bridge 65 m out spanning wall to wall: a swept tube of
  elliptical section, 10 m through at the crown, thickening into the abutments, underside about
  24 m above the water, displaced by the same strata and noise as the walls.
- **The rock shader.** Procedural in world units: strata as bands in height with a gentle dip
  along the canyon, aeolian cross-bedding (fine inclined laminae within bands), colour from
  salmon through orange to pale cream by band, desert-varnish streaks running down from the rim
  (the Powell "tapestry" walls) with their dark manganese sheen, iron-concretion speckle, lichen
  flecks on shaded faces, and the pale bathtub ring: the calcium-carbonate band left by the old
  high-water line, about 8 m up from the present waterline with a fuzzy top. Fine detail is a
  procedural bump that fades with distance so it never shimmers.
- **The water.** Lake Powell water in a side canyon: still, clear, turquoise over the sand
  shallows and deep green-blue beyond. Loon Lake's architecture: a GPU wave simulation over the
  near 48 m, a reflection pass through a mirror camera with an oblique clip plane, a refraction
  pass with depth, analytic ripples and a breeze cat's-paw far out, sun glitter.
- **The bed and the bar.** Sand with ripple marks sloping from the bar into the water, dropping
  to 10 m within 30 m; fallen blocks and boulders from the walls half-buried in it, cobbles,
  mats of filamentous algae in the shallows, a driftwood log on the bar, footprints. Contact
  occlusion baked under everything that sits on the sand.
- **Light.** Default is late afternoon: the sun behind the viewer to the right, 28 degrees up,
  so it shines through the arch onto the far wall and the water, and the arch throws its shadow
  across the water under it. The near walls are in shade and glow orange from light bounced
  off the sunlit wall (a hemisphere light with an orange ground colour plus a weak unshadowed
  bounce light). A single 4096 shadow map covers the bar, the near water and the arch. Dust
  motes drift in the sunlit volume (their lighting from an analytic test against the arch and
  the rim) and glow where the beam crosses the canyon. **Dusk** (`D`): the sun gone, pink and
  mauve sky, the walls cooling, the water a mirror. **Night** (`N`): the dark skies of Glen
  Canyon, stars and the Milky Way, a moon lighting the arch and laying its path on the water.
  **Aurora** (`A`, night only): the display of May 2024, when a G5 storm brought the aurora as
  far south as Lake Powell: a low red-and-green glow to the north, reflected in the water.
- **Life.** Violet-green swallows and white-throated swifts hunting over the water and under the
  arch, dipping to drink; a pair of ravens soaring along the rim and perching on the arch,
  croaking; carp and striped bass cruising the shallows; a side-blotched lizard doing push-ups on
  a boulder at the frame's edge; tamarisk and rabbitbrush on the bar at the sides. A small
  aluminium boat lies at anchor off the bar, swinging slowly, rocking when the water is stirred.
- **Left alone:** swallows hunt, ravens cruise and call, fish patrol and rise, the boat swings,
  the breeze comes and goes across the water, motes drift, a block falls from the wall every
  few minutes with its splash and echoing rings, the lizard moves from rock to rock.

## The cursor

1. **Move fast:** a gust. The swallows scatter from it, the fish bolt, a cat's-paw runs over the
   water under it, sand grains blow off the bar, and the ravens flare away.
2. **Rest:** over the water, the carp come up to the fingertip and nose it, the swallows start
   dipping to drink around it; on the bar, the nearest raven glides down and walks over to look;
   on a wall, swallows gather to the spot (their nests are in the shade of the alcove).
3. **Click:** on the water, a stone is tossed in with a plunk, a splash and spreading rings (the
   fish scatter and the boat rocks if it is near); on a wall or the arch, a block breaks away
   where you clicked and tumbles down the face, bouncing, to splash into the lake; in the sky,
   a raven calls and both ravens come across the canyon.

## Menu (top-right button, glass panel, fades when idle)

Birds (few / normal / many), Drop a Block (`B`), New Canyon; Dusk (`D`), Night (`N`),
Aurora (`A`), Click to Splash, Low Power (30 fps), Full Screen. URL flags `?dusk`/`?afternoon`,
`?night`/`?day`, `?aurora`/`?noaurora` override the saved settings.

## Modules (`arch/html/js/`)

| file | owns |
|---|---|
| `app.js` | settings, menu, input, renderer, composer, fixed 30/60 fps loop, the passes |
| `util.js`, `shaders.js` | math, seeded random, canvas art, the hourly shader clock; shared uniforms, fog, `patchMaterial`/`patchDepth`, noise GLSL, layers |
| `canyon.js` | the scene: layout, camera, lights and modes, cursor verbs, stepping every system |
| `rock.js` | the canyon geometry (walls, alcove, arch), the sandstone shader, rockfall |
| `water.js` | wave sim, rings, the surface, the bed |
| `shore.js` | the sand bar, boulders, cobbles, driftwood, algae, tamarisk, contact map, motes, the boat |
| `sky.js` | the sky dome (afternoon / dusk / night), sun and moon, the aurora glow, the weather state |
| `birds.js` | swallows and swifts (instanced boids), the ravens |
| `fish.js` | carp and striped bass |
| `lizard.js` | the side-blotched lizard |

Conventions as the other backgrounds: Three.js r170 from the CDN via an import map, versioned
module URLs, no build step, everything procedural, hourly time wrap with quantised frequencies,
screen-space creature reactions with soft walls, fixed sub-steps for the water.

## Decided during the build

- The viewer stands 3 m back from the origin (the shoreline is six metres ahead) so the near
  sand, cobbles, the lizard's blocks and the tamarisks frame the bottom of the view; with the
  viewer at the water's edge the whole bar was below the frame.
- The sun is in front of the viewer, not behind: 20.5 degrees up and 4 degrees left, hidden behind
  the crown of the bridge (which spans 17 to 24 degrees up at 70 m). It is a low, orange sun of
  modest intensity: at full strength every sunlit face beyond the shadow map's reach went white. That is the reference
  images' light: the arch dark against the glare, the water a mirror of the bright canyon, the
  walls side-lit on their down-canyon faces, shadows pointing at the viewer, the bridge's shadow a
  band across the near water with sunlit water beyond it, the dust motes brightest where they
  are backlit. A sun behind the viewer lit everything flat and put the bridge's shadow out of view.
- The moon is behind the viewer, high to the right, so at night it lights the near face of the
  bridge and the walls, and the Milky Way stands in the dark strip of sky above the crown.
- The ravens' third verb (coming to a block on the bar when the cursor rests on the sand) and
  the lizard were kept; the "swallows gather to a wall" rest reaction was dropped in favour of
  gathering to a resting cursor anywhere over the water or in the air.
- The water shader and the motes read the key light's shadow map directly (three packs depth
  into RGBA; a manual 3x3 lookup with the light's shadow matrix) rather than through three's
  lighting chunks.

## Verification

Screenshots at the default view and zoomed (a `view` aid with a narrow field of view aimed at a
world point), in each mode; hand-stepping the simulation for the fish approach, the ravens'
cycle, the rockfall and the boat; console checked for shader errors after every reload.
