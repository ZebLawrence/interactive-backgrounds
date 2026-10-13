# Guidelines for building a new interactive background

Lessons from building Fishbowl, Firefly Meadow, Balloon Dawn and Loon Lake, written for whoever
(or whatever) builds the next one. They are generic on purpose: the scene will be different, the
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
- **Nothing floats.** Every object must visibly belong to the world it stands in: rooted in the
  ground (not on a surface above it), casting a shadow from the main light, and darkening the
  ground where it touches (a baked contact-occlusion map is cheap and reads immediately). The
  owner spotted both "sitting on top of the water" and "no shadows from the main light" in one
  look. Decide the key light and its shadow map on day one, not after the review.
- **Grounds are not textures.** A floor, bed, field or seabed needs three-dimensional things on
  it (rocks, plants, debris, fallen branches) before it stops reading as "generic", however good
  the surface shader is.
- **Build the plant, not the icon.** Vegetation gets reviewed against the real species: a stalk
  alone is not a cattail, it needs the head, the spire and the fan of leaves from the base, in the
  real proportions. Look up the anatomy, then build each part. The same goes for animals: the
  owner will zoom in.
- **Frame the edges.** The near corners and sides of the view are where the owner asks for more:
  foreground vegetation and objects at the frame edges give the scene depth and are the first
  thing a second look lands on.
- **Silhouettes must end plausibly.** A horizon plane, headland or tree line that stops in a hard
  vertical edge looks like a cut-out "in the middle of the lake". Taper it to nothing.

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
- **Check the forward axis of anything that moves.** A procedural body built nose-at-origin,
  tail-along-+x, driven along +x, swims backwards, and it is not obvious at a distance. Build
  bodies centred, with the nose on the axis the mover uses, and confirm with a close-up along
  the velocity before the review does.
- **Multi-pass scenes use layers.** Reflection, refraction and similar passes each render a
  subset of the scene; put every object in the layers of the passes that should see it (one
  mesh can be in several) and set the camera's layers per pass. Lights have layers too and
  must be enabled for every pass that lights anything. Three re-renders the shadow map on every
  `render()` call with the current camera's layers, so set `shadowMap.autoUpdate = false` and
  raise `needsUpdate` once per frame, before the pass whose camera can see all the casters.
- **A mirror camera needs a clip plane.** Anything crossing the mirror plane (stems under the
  water, a hull) shows up in the reflection unless the virtual camera's near plane is made
  oblique at the plane, as three's `Reflector` does.
- **Simulate on the GPU with fixed sub-steps.** A height-field or particle sim stepped with the
  frame's `dt` goes unstable the first time a frame stalls; step it in fixed `1/60` increments,
  clamped to a few per frame. A single-speed wave equation has no dispersion, so use it for the
  slow large-scale waves and draw the small fast ripples analytically in the shader.
- **Pushing a sim every frame accumulates.** A dent re-applied each frame (a wake, a drag) is a
  constant force and digs a trough; use small per-splat amounts, and skip impossible jumps (a
  cursor that crosses metres in one frame is a teleport, not a drag).

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
  and a generous normal bias. For a `ShaderMaterial` the cheapest depth twin reuses its vertex
  shader verbatim with a fragment of `packDepthToRGBA(gl_FragCoord.z)`; for a patched standard
  material, patch a `MeshDepthMaterial` with the same vertex code. After changing a shadow
  camera's bounds, call `updateProjectionMatrix()` yourself.
- **Shadows need a light that reaches the ground.** A key light a few degrees above the horizon
  lights a horizontal surface by its sine (9° gives 16%), so its shadows are invisible however
  sharp the map. For visible ground shadows the key light wants 15° or more and several times
  the sky light's intensity; if the scene is meant to be after sunset, pick between the mood and
  the shadows deliberately and say which you chose.
- `out`, `in`, `inout`, `input`, `output`, `filter` and `sample` are reserved words in GLSL;
  naming a variable `out` breaks every shader that includes the helper. Find failures with
  `renderer.info.programs.filter((p) => p.diagnostics)` rather than scrolling the console.
- Lathe and tube geometries put their seam and "top" at whatever angle the generator starts
  from: paint the texture, then check which `u` range faces up and shift `texture.offset` to
  match rather than repainting.
- `ShaderMaterial.clone()` clones the uniform objects, so a clone stops sharing time, wind and
  mode uniforms with the rest of the scene; re-point its `uniforms` at the shared objects.
- Keep high-frequency procedural detail (ripples, grain, veins) fading with distance, and read
  derived maps (normals, slopes) through a mipmapped texture: far pixels that average many
  cells stop shimmering, and a noise function evaluated at sub-pixel scale aliases.
- Texture orientation: `CanvasTexture` flips on upload (canvas bottom = v 0). When an image
  appears upside down or missing, check the plane's vertical placement before blaming the flip.
- Alpha-tested silhouettes on planes work well for horizons (tree lines, ridges), but size
  them from real-world elevation angles: a tree line reaching 16 degrees up fills the sky.
- A varying must be linear in world space to interpolate correctly across a big triangle. A
  view-space *depth* is; a view-space *distance* (`length(mvPosition)`) is not, and on a 9 km water
  plane with 140 m triangles it came out thirty times too big. Compute lengths per fragment.
- Three r155+ lights are in physical units: a hemisphere light of intensity 1 gives a dull surface
  about 1/π of its albedo. Dusk needs hemisphere intensities around 3, not 0.6.
- Point lights have a range; a burner's 30 m light will never reach a hill 100 m away. Fake the
  far effect deliberately (a stylised glint) instead of stretching the range.

## 5. Verify like the owner will look

- Take screenshots early and often, and **zoom the camera in** (drop the field of view) to see
  detail at 4K-equivalent density. A full-frame screenshot at 800 px hides everything. A
  console helper that aims the camera at a world point with a narrow field of view and renders
  once is worth defining in the first hour; the pane's own zoom crops a downscaled screenshot
  and resizes between actions, so it shows nothing new.
- Test each cursor verb explicitly and each menu option, in each mode, and read the console for
  shader errors after every reload (old messages persist in the pane's console; look at uuids
  and line numbers to tell new from old).
- The browser pane throttles `requestAnimationFrame` when it is not in front, so time-based
  behaviour may appear frozen. Drive the simulation by hand (`step(dt)` in a loop) to test
  anything that takes seconds or minutes: burn cycles, gathering, synchronisation, drift.
  A helper defined from the console that runs `step(1/60)` N times with a given pointer and
  then renders once makes a minute of scene time cost a second, and lets you hold the cursor
  still or drag it along a path without touching the mouse.
- Measure rather than eyeball when the question is "does it move/light/shadow at all": read back
  pixel means with and without the effect, log positions over simulated time, count overlaps.
  `readRenderTargetPixels` on an intermediate target (a refraction or shadow pass) answers "is
  the texture right or is the shader reading it wrong" in one call; that is how a varying
  thirty times too large and a depth read that was fine were told apart.
- Time frames with `gl.finish()` before and after, and only after everything else has settled:
  hand-stepping the sim queues seconds of GPU work, and toggling a material feature forces a
  recompile, and either one makes a 5 ms frame read as 50.
- When the browser's module cache serves stale code mid-session, bump the `?v=` numbers for the
  test too; "the fix did nothing" was twice the old module.
- Watch for balloons (or anything) wandering out of frame, through terrain, or behind a
  foreground slope; derive altitude limits from the real frame geometry at each distance.
- Before claiming "done", view the thing in the mode the owner is most likely to leave it in.
  The night tethers looked fine in a screenshot and were wrong as a background.

## 6. Working with the owner

- They delegate the concept but review hard. Expect a list of two to eight precise defects after
  each round, often with a screenshot or video; the video showed the mode they were in, which was
  the whole answer. Ask for one if a report doesn't reproduce. Rounds are short and quick: fix
  everything in the list, verify each item with a close-up, and report in the same order.
- When they say it "turned out great", the next message is usually an addition rather than a
  fix (more of something they liked, at the edges of the view). Build additions in the same
  style and idiom as the thing they praised.
- They say "commit and push" explicitly; don't push on your own. Write commit messages that
  explain the behaviour change, not the diff. When they ask for a branch and a pull request,
  other work may have landed on `main` in the meantime (other backgrounds' native ports):
  fetch, merge `main` into the branch, and resolve the root README table by keeping every row,
  then confirm GitHub reports the PR mergeable before saying so.
- When a request contradicts physics (burners lighting distant grass), honour the intent with a
  stylised effect and say what you did.
- Keep the README of each background current with every behaviour change; it is what they read.
- Shell commands over roughly 8 KB are truncated here, and a truncated heredoc fails as a shell
  syntax error without applying anything. For a multi-file patch, write a small Python script
  to the scratchpad with the file tool (anchor-replace pairs that report any anchor not found)
  and run that; use the file tools directly for whole new source files.
