# Firefly Meadow

An animated 3D meadow at night, seen from low in the grass, that reacts to your cursor. A web page
for now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/meadow/html/

- **Move the cursor** and the grass parts around it as if you were walking through, springing back
  slowly along the trail you leave.
- **Move fast** near fireflies and they go dark and dart away.
- **Rest the cursor** and curious fireflies drift over to orbit it. The synchronous species falls
  into step, so the cloud around your cursor starts to flash in unison.
- **Click to clap**: a ring runs out through the grass and every firefly nearby flashes at once and
  bolts.
- **Four species**, each with its own slow rhythm and way of flying: the Big Dipper's long rising
  glow, the synchronous firefly's shared pulse, Photuris's pair of glows high over the meadow, and
  dim blue ghosts creeping low in the grass. Lanterns ease in and out over several seconds; only a
  fright or a clap switches one abruptly. Their light falls on the grass and flowers around them.
- **Sky**: stars of every colour and size, a Milky Way with a glowing core, cool outer arms and
  dark dust lanes threaded through it, a gibbous moon with a halo, shooting stars now and then,
  mist drifting over the grass, and a tree line of spruce, broadleaf and bare winter trees
  silhouetted on the horizon before everything fades to black.
- **Moonlight** (menu, `M`): turn the moon off for a darker meadow with brighter stars.
- **Storm** (menu, `S`): rain, gusting wind, a low cloud ceiling, and lightning that forks down behind
  the trees and lights the whole meadow for an instant. The fireflies shelter in the grass until it
  passes.
- **Fireflies**: a few, a meadow full, or a swarm. **New Meadow** re-seeds the grass, flowers and
  tree line.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/meadow/html/`. `?storm`, `?calm`, `?dark` and
`?moon` in the URL override the saved settings for testing.

## How it works

- Units are metres. The camera stands at the origin 1.25 m above the grass looking toward -z,
  pitched down 7° with a 50° vertical field of view, and pans a few degrees toward the cursor when it
  nears a screen edge (`meadow.js`). A screen point maps to a ray, and the ray to a point on the
  ground, so the cursor has a position in the world.
- `grass.js` draws ~30k blades (scaled with the window) as one instanced draw call. Each blade is an
  arc of constant curvature bent in the vertex shader by the wind, the cursor's ground point, a
  ring buffer of the cursor's recent positions (the trail) and expanding clap rings. Blades thin out
  with distance and grow a little to compensate. A procedural surface map (midrib, veins, streaks)
  shades each blade and tilts its normal, so moonlight glints along the veins. Wildflowers are a
  second instanced mesh with veined petals and textured centres.
- `fireflies.js` holds the species table, the behaviour (wander, flee a fast cursor in screen
  space, gather round a resting one, hide from rain) and the point sprites. The synchronous species
  uses Kuramoto phase coupling with its neighbours, strengthened when gathered, so bursts of flashing
  sweep across the meadow and lock together around the cursor. The 32 brightest fireflies are sent to
  the grass and ground shaders as point lights in their own colours, so blue ghosts cast blue light.
- `sky.js` paints the Milky Way once onto an equirectangular canvas (core, arms, dust lanes, nebula
  tints) and renders the sky in a fragment shader (gradient, that haze map, three hashed star
  layers with colour temperature and twinkle, the moon's halo, storm cloud), the moon as a canvas sprite, meteors as a streak
  quad on the sky sphere, and the tree line and hills as alpha-tested silhouettes in the fog.
- `storm.js` has the rain (a point cloud that falls and wraps) and lightning (a bolt walked onto a
  canvas each strike, with a flickering flash that every shader reads).
- Like Fishbowl, it renders at a fixed 30/60 fps, shader time wraps hourly with every frequency
  quantised to that period, and there are no assets: every texture is drawn on a canvas at start.
