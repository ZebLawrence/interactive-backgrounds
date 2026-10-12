# Guidelines for building a new interactive background

Lessons from building Fishbowl, Firefly Meadow and Balloon Dawn, written for whoever (or
whatever) builds the next one. They are generic on purpose: the scene will be different, the
mistakes won't be.

## 1. What "good" means here

- **Fun, detailed, interesting.** The owner wants something they will keep running on a desktop
  for hours, not a demo. Every element should reward a second look: real structure in trees,
  veins on a blade of grass, seams and a basket on a balloon, maria on the moon.
- **Detail must survive 4K.** The owner views on a large 4K monitor. Anything drawn to a canvas
  and magnified reads as a blurry brush stroke. Work out the pixels-per-metre a texture will get
  on screen at its distance and give the canvas at least that; draw in world units (metres) so
  detail is resolution-independent; prefer procedural geometry and shaders over bitmaps where
  the camera gets close. When a bitmap is truly better (the moon), use a real one with credit.
- **Real-world grounding.** Base behaviour on how the real thing works (firefly flash patterns,
  balloon buoyancy, dust lanes in the Milky Way) and say so in comments. The owner notices when
  something is "fake" (a pale band that looked like clouds) and asks for the real thing.
- **Slow and peaceful.** Backgrounds should breathe. First drafts have been too fast every
  single time: wind, fireflies, flash rates, gust response. Halve your first guess, then halve
  the fast things again. Motion should ease in and out; only reactions to the cursor or a click
  may be abrupt.
- **But not still.** Peaceful is not static. With no mouse input the scene must keep living on
  its own: ambient wind, creatures with their own agendas, pilots firing burners, things
  cooling and sinking. "They just sit there" is a bug.
- **Distance fades to black at night, to haze by day.** No light-grey fog at night.

## 2. The three cursor verbs, plus options

Every background so far gives the cursor three distinct roles and the owner expects them:

1. **Move fast**: something flees or is pushed (fish dart, fireflies scatter, a gust).
2. **Rest**: something approaches or acknowledges you (fish inspect, fireflies gather, crews wave).
3. **Click**: a deliberate, satisfying event (food, a clap, a burner).

Then a small menu, in the same style as the existing ones (top-right button, glass panel, fades
when idle): a population size, one or two mood toggles with keyboard shortcuts (night mode, storm,
moonlight), a reseed, Low Power, Full Screen, and URL flags for testing the modes.

## 3. Engineering conventions (follow the existing folders)

- One folder per background: `name/html/index.html`, `styles.css`, `js/*.js` as ES modules,
  Three.js from the CDN via an import map, **no build step**, served by GitHub Pages. Add a
  `name/README.md` and a row in the root `README.md` and `index.html`.
- Fixed 30/60 fps loop; shader time wraps hourly with every frequency quantised to that period;
  everything procedural unless there is a good reason (then credit the source in the README).
- Keep the scene code independent of the shell: it needs only the cursor in screen points, a
  click point, and the screen size. Map screen points into the world through the camera's real
  rotation (including any pan) so hit-tests and reactions stay under the cursor.
- Creatures react in **screen space** (projected distance to the cursor) so near and far things
  feel the same, and keep themselves inside the view with soft walls, not teleports.
- **Version the module URLs.** GitHub Pages caches JS for ten minutes and a refresh only
  revalidates the page, so a user can run a mix of old and new modules and report a working
  feature as broken. Each `index.html` maps `./js/x.js` to `./js/x.js?v=N` in its import map and
  loads `app.js?v=N`. Bump N whenever JS changes, before pushing. If a pushed change "doesn't
  work" while older behaviour shows, suspect this first.
- Wait for a real window size before building: some hosts report 0x0 during load, which turns
  into NaN aspect ratios and zero-size render targets.

## 4. Shader and rendering traps that bit us

- **NaN poisons the whole frame.** Bloom blurs a single NaN pixel across the screen and tone
  mapping turns it black. Sources we hit: `pow(x, y)` with x slightly negative (clamp the base),
  `normalize` of a zero vector (a blade bent flat along its own width; a bird flying vertically),
  copying a `Vector3` into a `Color` (gives NaN channels), fogged sprites reading a NaN fog
  colour. Guard every normalize and pow; when the frame goes black, hide objects one at a time
  to find the culprit.
- **`UniformsUtils.merge` clones uniforms.** After merging `UniformsLib.lights` into a custom
  material, re-point your shared uniform objects (time, gust, night, fog) at the live ones, or
  the material freezes while everything else moves. Symptom: "the grass doesn't move" or
  "doesn't respond to night mode".
- A shader-patch helper must write the edited `vertexShader`/`fragmentShader` strings back onto
  the shader object; forgetting that silently skips every patch (bulges, glows, detail maps).
- In three r170, map coordinates in standard materials are `vMapUv`, not `vUv`.
- Custom instanced materials that should cast shadows need a `customDepthMaterial` running the
  same vertex deformation; without it the shadow and the visible blade disagree and flicker.
  Thin geometry needs a tight, high-resolution shadow map (we used 4096 over the near grass)
  and a generous normal bias.
- Texture orientation: `CanvasTexture` flips on upload (canvas bottom = v 0). When an image
  appears upside down or missing, check the plane's vertical placement before blaming the flip.
- Alpha-tested silhouettes on planes work well for horizons (tree lines, ridges), but size
  them from real-world elevation angles: a tree line reaching 16 degrees up fills the sky.
- Point lights have a range; a burner's 30 m light will never reach a hill 100 m away. Fake the
  far effect deliberately (a stylised glint) instead of stretching the range.

## 5. Verify like the owner will look

- Take screenshots early and often, and **zoom the camera in** (drop the field of view) to see
  detail at 4K-equivalent density. A full-frame screenshot at 800 px hides everything.
- Test each cursor verb explicitly and each menu option, in each mode, and read the console for
  shader errors after every reload (old messages persist in the pane's console; look at uuids
  and line numbers to tell new from old).
- The browser pane throttles `requestAnimationFrame` when it is not in front, so time-based
  behaviour may appear frozen. Drive the simulation by hand (`step(dt)` in a loop) to test
  anything that takes seconds or minutes: burn cycles, gathering, synchronisation, drift.
- Measure rather than eyeball when the question is "does it move/light/shadow at all": read back
  pixel means with and without the effect, log positions over simulated time, count overlaps.
- Watch for balloons (or anything) wandering out of frame, through terrain, or behind a
  foreground slope; derive altitude limits from the real frame geometry at each distance.
- Before claiming "done", view the thing in the mode the owner is most likely to leave it in.
  The night tethers looked fine in a screenshot and were wrong as a background.

## 6. Working with the owner

- They delegate the concept but review hard. Expect a list of five to eight precise defects after
  each round, often with a screenshot or video; the video showed the mode they were in, which was
  the whole answer. Ask for one if a report doesn't reproduce.
- They say "commit and push" explicitly; don't push on your own. Write commit messages that
  explain the behaviour change, not the diff.
- When a request contradicts physics (burners lighting distant grass), honour the intent with a
  stylised effect and say what you did.
- Keep the README of each background current with every behaviour change; it is what they read.
- Shell commands over roughly 8 KB are truncated here; split large patches, and use the file
  tools for big source files.
