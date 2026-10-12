# Firefly Meadow

An animated 3D meadow at night, seen from low in the grass, that reacts to your cursor: a macOS
desktop background (`swift/`) and a web page (`html/`).

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
  silhouetted on the horizon before everything fades to black. The moon is the real one: NASA's
  Lunar Reconnaissance Orbiter colour and height maps wrapped on a sphere and lit by its own sun.
- **Moonlight** (menu, `M`): turn the moon off for a darker meadow with brighter stars.
- **Storm** (menu, `S`): rain, gusting wind, a low cloud ceiling, and lightning that forks down behind
  the trees and lights the whole meadow for an instant. The fireflies shelter in the grass until it
  passes.
- **Fireflies**: a few, a meadow full, or a swarm. **New Meadow** re-seeds the grass, flowers and
  tree line.

## macOS app

`swift/` is a native port: a menu-bar app that draws the meadow behind your desktop icons and
windows, on every screen. Requires macOS 14+ and the Xcode command line tools.

```sh
cd swift
./build.sh             # builds build/Meadow.app ("Firefly Meadow")
open build/Meadow.app
./build.sh --install   # or: copy to /Applications and launch
```

Control it from the sparkles icon in the menu bar: Clap, Fireflies (a few / a meadow full / a
swarm), New Meadow, Moonlight, Storm, Click Desktop to Clap, Low Power (30 fps, no MSAA), Launch at
Login, and Quit. Clicking empty desktop claps (a `CGWindowList` hit test ignores clicks on windows),
and the cursor is polled each frame, so no Accessibility permission is needed. Run only one of Fishbowl
and Firefly Meadow at a time: both draw at the same desktop level.

Developer flags:

```sh
swift run Meadow --preview                        # a normal window instead of the desktop
swift run Meadow --snapshot out.png --at 6        # render with a resting cursor, save a frame, exit
swift run Meadow --snapshot out.png --clap-at 5.5 # ... clapping first
swift run Meadow --storm                          # force the storm (or --calm); --dark / --moon likewise
swift run Meadow --lightning-now                  # a storm whose first strike comes after a second
swift run Meadow --preview --stats                # log the GPU time per frame
```

It's a straight port of the web version, file for file (`Meadow.swift` ← `meadow.js`, `Grass.swift` ←
`grass.js`, and so on), but it renders with Metal directly rather than SceneKit: the scene is almost
all custom shaders, the grass is ~27k instanced blades, and 32 firefly lights, the cursor's 24-point
trail and the clap rings change every frame, all of which SceneKit handles poorly. The GLSL is ported
to Metal in `Shaders.swift`, and `RenderView` reproduces three.js's post-processing: 4x MSAA into a
16-bit float target, UnrealBloomPass (bright pass, five blur levels), the grade, and ACES filmic tone
mapping. The procedural textures are drawn with Core Graphics using the same calls as the canvas
code; the moon maps are copied from `html/assets` into the app bundle. At 60 fps it uses about 10% of
one CPU core and ~7 ms of GPU time per frame at 2560x1600 on an Apple Silicon laptop.

## Web page

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
  layers with colour temperature and twinkle, the moon's halo, storm cloud), the moon as a textured
  sphere with a directional light for its phase, meteors as a streak
  quad on the sky sphere, and the tree line and hills as alpha-tested silhouettes in the fog. The
  tree line is drawn in metres (trunks, drooping branches with needle tufts, forking limbs, leaf
  clusters, bare twigs, bushes) onto an 8192-pixel mask, about 45 pixels per metre, so it stays
  sharp on a 4K display.
- `storm.js` has the rain (a point cloud that falls and wraps) and lightning (a bolt walked onto a
  canvas each strike, with a flickering flash that every shader reads).
- Like Fishbowl, it renders at a fixed 30/60 fps, shader time wraps hourly with every frequency
  quantised to that period, and every texture but two is drawn on a canvas at start. The exceptions
  are the moon maps in `html/assets/` (`lroc_color_2k.jpg`, `ldem_3_8bit.jpg`), from NASA's
  Scientific Visualization Studio CGI Moon Kit (https://svs.gsfc.nasa.gov/4720); credit: NASA's
  Scientific Visualization Studio.
