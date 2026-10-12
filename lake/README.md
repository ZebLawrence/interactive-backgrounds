# Loon Lake

A still mountain lake in the last hour of sun, seen from the water's edge, that reacts to your cursor as if it were
your fingertip in the water. A web page for now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/lake/html/

- **Move the cursor** over the water and your fingertip drags through it, leaving a wake of real
  ripples that spread, cross and fade. Trout underneath bolt from a fast hand, dragonflies scatter,
  and a loon close by dives.
- **Rest the cursor** and the lake comes to you. A trout or two rise to nose the still spot under
  your finger, nudging the surface now and then; a dragonfly flies over and lands on your fingertip,
  wings flat, until you move; the nearest loon turns its head to look, and if you stay a while, paddles
  over.
- **Click to skip a stone.** It flies from your hand to where you clicked and hops on across the lake,
  each skip a smaller ring, until it runs out of speed and sinks with a plunk. Everything near a
  splash startles. Click empty sky and it goes out into the middle of the lake.
- **Left alone**, the lake lives on its own: trout rise for insects and leave rings; loons paddle,
  dive for half a minute and surface somewhere else; dragonflies patrol the shallows in darts and
  hovers and perch on the reed tops; a breeze veers and freshens over the minutes, running cat's paws
  of fine ripples across the water; mist lies on the far water; the first stars come out overhead.
- **Night** (menu, `N`): the afterglow goes, the moon rises over the right-hand shore with the Milky
  Way across the sky, and the moon, the stars and the dark shore all lie on the water, broken by every
  ripple.
- **Rain** (menu, `R`): a low grey ceiling, rain falling through the view, and every drop dimpling the
  surface with its own short-lived ring. The dragonflies shelter in the reeds until it passes.
- **Life**: a quiet evening, a living lake, or teeming. **New Evening** re-seeds the reeds and the
  shore and starts the creatures over.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/lake/html/`. `?night`, `?dusk`, `?rain` and
`?dry` in the URL override the saved settings for testing.

## How it works

- **Light and shadow.** The sun hangs low over the ridges to the left and is the one key light:
  a 4096-pixel shadow map over the near thirty metres, drawn once per frame during the refraction
  pass, so rocks, logs, pondweed, reed stems and trout all cast long shadows across the bed, and
  the reeds and the stones shade one another. At night the key light becomes the moon. Under
  everything that sits on the bed a baked contact-occlusion map darkens the sand, so rocks and
  stems look set into it rather than floating. The reeds are rooted on the bed and seen through
  the water below the line, and the mirror camera is clipped at the surface so the submerged
  parts never show in the reflection.
- Units are metres. The viewer stands at the origin with eyes 1.5 m above the water, looking toward
  -z, pitched down 4.5° with a 50° vertical field of view, and panning a few degrees toward the cursor
  when it nears a screen edge (`lake.js`). A screen point maps to a ray, and the ray to a point on the
  water, so the cursor has a fingertip in the world; creatures react to it in screen space so near and
  far ones feel the same.
- `water.js` is the heart. A **wave simulation** runs on the GPU over the 64 m of water nearest the
  viewer: a 2048² float texture holds the height field, ping-ponged each frame through the 2D wave
  equation (fixed 1/60 s sub-steps so it stays stable, wave speed about 0.6 m/s like the ripples a
  stone makes, light damping plus a touch of diffusion so the finest ripples die first). Disturbances
  are "splats": soft dents pressed in by the fingertip, a stone, a trout's nose or a loon's hull. A
  second pass turns the heights into a mipmapped slope map. Beyond the patch, rings are analytic wave
  packets (a stone's last skips, a loon surfacing far out). Rain is a hashed field of tiny, short-lived
  rings in the shader, because a single-speed simulation has no dispersion and would grow every
  raindrop into a stone's ring.
- The **surface** samples three things: a reflection of the shore and sky rendered from a camera
  mirrored in the water plane, a refraction of the lake bed and the fish rendered from the real
  camera into a second target with a depth texture, and the slope map (plus wind ripples and the
  analytic rings). Reflection and refraction are bent by the slope, the depth texture gives the length
  of water each ray passes through for Beer-Lambert absorption (red goes first) and a veil of scattered
  skylight, Fresnel mixes the two (glassy at a grazing angle, see-through looking down), and the moon's
  glitter is a specular term on the rippled normal. The bed is a shader of shaded, speckled pebbles on
  sand, with caustics taken from the curvature of the height field; on it (`bedlife.js`) lie
  noise-sculpted granite cobbles and a few boulders, beds of eelgrass ribbons swaying in the drift,
  and waterlogged branches with their stubs, all drawn in the refraction pass.
- `fish.js` builds each trout from a ring tube along a trout profile, fins as fans, and a 1024×512
  skin painted per species: rainbows (olive back, pink band, dense black spots), brook trout (pale
  vermiculation over a dark back, yellow and red spots with blue halos, orange belly, white-edged
  fins) and browns (golden flanks, big haloed spots). A travelling lateral wave in the vertex shader
  swims the body, bigger toward the tail and faster the harder the fish works; turning bends it. The
  behaviour is a small state machine: cruise, hold station, rise to the surface and sip (a ring and a
  roll of the flank), dive, investigate a resting fingertip, and flee with a C-start.
- `loons.js` builds common loons from a lathe hull, a tube neck and a dagger bill, painted with the
  chequered back, the striped necklace and the red eye. They paddle (a shallow moving dent under the
  hull is their wake), look about, dive and surface with a ring, and are startled into diving by a fast
  cursor or a nearby splash.
- `dragonflies.js` has darners, meadowhawks and skimmers: segmented bodies and four veined
  membrane wings drawn in metres, with three ghosted copies that blur when the wings beat (real beats
  are 30 Hz, far too fast to draw) and a single still pair when perched. They dart and hover between
  waypoints, perch on cattail tops (`reeds.js`, whose sway they follow), scatter from a fast cursor and
  land on a resting fingertip, or on a lily pad. The shallows along both sides are planted
  (`reeds.js`, `lilies.js`): cattails built as the plant is (a round stalk, the brown velvet spike
  with its thin spire, a fan of long strap leaves arching from the base), bulrushes (tall round stems
  with a drooping tuft of spikelets below the tip), sedge tussocks (dense mounds of narrow arching
  blades), reed grass, and patches of water lilies: notched, veined pads floating in the lee of the
  reeds with a few white flowers open among them, their stems running down to the bed.
- `sky.js` paints the sky in one dome shader (dusk afterglow toward where the sun set, altostratus
  bands lit from below, Venus, the first stars; at night a painted Milky Way, three star layers and the
  moon's halo; in rain a scrolling grey ceiling), the moon as NASA's Lunar Reconnaissance Orbiter
  colour and height maps on a sphere lit in its own shader for a waxing gibbous (the maps live in
  `meadow/html/assets/`, from NASA's Scientific Visualization Studio CGI Moon Kit,
  https://svs.gsfc.nasa.gov/4720; credit: NASA's Scientific Visualization Studio), the far shore as
  alpha-tested pines drawn in metres on an 8192-pixel mask (trunks, drooping branches with needle
  tufts, snags and birches over a rocky bank) with a wooded point nearer on the left, fbm ridges
  dissolving into the haze, mist sprites on the far water, and the rain as a wrapping point cloud.
- Like the other backgrounds it renders at a fixed 30/60 fps, shader time wraps hourly with every
  frequency quantised to that period, and every texture but the moon's is drawn on a canvas at start.
