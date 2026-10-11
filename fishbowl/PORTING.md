# Porting Fishbowl to JavaScript + Three.js

A guide for re-implementing Fishbowl (`swift/`: Swift + SceneKit, macOS) as a JavaScript / Three.js
app (now done in `html/`). The Swift source is the reference implementation: read the file named in each section before
porting it. This document captures the design, the numbers that were tuned by eye, and the lessons
that were learned the hard way and aren't obvious from the code.

## Where will it run?

Decide first; it changes the shell, not the scene code.

- **Browser page**: simplest. `mousemove` gives the cursor; no desktop integration.
- **macOS wallpaper via [Plash](https://sindresorhus.com/plash)**: Plash shows a web page as the
  desktop background. Least work, but Plash's "browsing mode" is needed for mouse input, so the
  cursor-reactive parts need checking there.
- **Electron / Tauri wrapper**: a borderless, click-through window at desktop level (as
  `WallpaperWindow.swift` does) plus native access to the global cursor position and clicks.
  Electron: `setIgnoreMouseEvents(true)`, `screen.getCursorScreenPoint()` polled each frame (the
  window never receives mouse events), and a desktop-level window type.

Whatever the shell, keep the scene code independent of it: the scene only needs "cursor position in
screen points, or absent", "a click at this point" and the screen size.

## File map: Swift → Three.js

| Swift | Role | Three.js approach |
|---|---|---|
| `main.swift`, `AppDelegate.swift`, `Settings.swift` | App shell, menu bar, settings, click-to-feed hit test | Shell-specific (see above); settings in `localStorage` or the wrapper's store |
| `WallpaperWindow.swift` | Desktop-level click-through window | Shell-specific |
| `RenderView.swift` | Renders exactly one frame per simulation step at a chosen fps | `WebGLRenderer` + your own `requestAnimationFrame` loop that skips frames to hit 30/60 fps |
| `Tank.swift` | Scene setup, camera, fog, scenery layout, frame loop, cursor↔world mapping | Main scene module |
| `Lighting.swift` | Day/night blend, sun/fill/ambient, cursor-aimed night spotlight + beam | `DirectionalLight`s, `AmbientLight`, `SpotLight` (+ `target`), a cone mesh for the beam |
| `Shaders.swift` | Shader modifiers: caustics, plant sway, reef triplanar detail, spotlight beam | `onBeforeCompile` on `MeshStandardMaterial` (inject into vertex/fragment chunks), or `ShaderMaterial` |
| `Mesh.swift` | Minimal indexed mesh builder | `BufferGeometry` + `BufferAttribute`s; `mergeGeometries` from `three/examples/jsm/utils/BufferGeometryUtils.js` |
| `Art.swift` | Procedural textures drawn with Core Graphics | Canvas 2D → `CanvasTexture` (set `colorSpace = SRGBColorSpace` for colour, leave data/normal maps linear) |
| `Detail.swift` | Procedural normal maps (sand ripples, porous rock, fish scales) | Generate height fields in JS → normal map into a `DataTexture` |
| `Occlusion.swift` | Baked contact shadows (AO) | Same algorithm in JS; floor AO as a `DataTexture` multiplied in the sand shader; per-vertex AO for the reef |
| `Coral.swift`, `Plants.swift` | Procedural reef and plants, each merged into one mesh | Same builders → one merged `BufferGeometry` each |
| `Species.swift` | Species data (sizes, colours, fins, speeds, body profiles) | Plain JS objects — port the numbers verbatim |
| `FishArt.swift` | Painted fish skin, fins, tail, pectoral images | Canvas 2D; same paths and gradients |
| `FishBody.swift` | Body loft (asymmetric back/belly, superellipse cross-sections), skin UVs, `section(atX)` | Same loft into `BufferGeometry` |
| `FishFins.swift` | All fins in one mesh + atlas; per-vertex fin data | One `BufferGeometry` with custom attributes |
| `FishEyes.swift` | Eyeball mesh + iris texture; per-eye tracking | Small sphere + `MeshPhysicalMaterial` (`clearcoat`) |
| `FishMaterials.swift` | Body material: iridescence, per-fish colour morphs | `onBeforeCompile` on `MeshStandardMaterial` |
| `FishShaders.swift` | Swim wave, breathing, fin motion, backlit fin glow | Vertex shader injection |
| `FishRig.swift` | Per-fish nodes, materials, swim rhythm/bend uniforms, shark jaw | `Group` per fish; per-fish uniforms |
| `Fish.swift` | Behaviour: steering, schooling, curiosity, fear, food, glide-and-burst, C-start | Plain JS class — pure maths, ports directly |
| `Shark.swift`, `SharkJaw.swift` | Shark state machine (lurk → hunt → retreat), articulated jaw | Plain JS + a jaw `Group` pivoting at the hinge |
| `Food.swift` | Sinking food flakes | Small meshes or `InstancedMesh` |

## World layout and camera (Tank.swift)

This is the foundation of every cursor interaction. Get it right first.

- **Units**: 1 world unit = 100 screen points. `width = screenWidth / 100`, `height = screenHeight / 100`.
- **The screen is the front glass**: the plane z = 0 exactly fills the view. The camera sits on the
  +z axis looking toward −z with a vertical fov of **40°**, at
  `eyeDistance = (height / 2) / tan(20°)`. So a screen point (sx, sy) maps to the glass point
  `((sx − W/2)/100, (sy − H/2)/100, 0)` and the ray from the eye through it.
- **Tank depth**: `depth = clamp(height * 1.0, 6, 12)`; the tank runs from z = 0 back to z = −depth.
  Fish may also swim *in front of* the glass up to `frontZ = eyeDistance * 0.35`.
- **Visible extent at depth z** (the frustum widens with distance): `halfWidth(z) = width/2 * (eyeDistance − z) / eyeDistance`,
  same for `halfHeight(z)`. Fish bounds use these so fish never leave the screen.
- `surfaceY = height/2 − menuBarHeight * 0.3` (just under the menu bar), `floorBase = −height/2 + 0.3`.
- **Screen y**: SceneKit / Core Graphics have y up (origin bottom-left). Browser `clientY` is y down —
  flip it once at the input boundary.
- **Camera pan/tilt**: near a screen edge (outer 12%, ignoring the menu bar strip) the camera turns
  up to 3.5° yaw / 2° pitch toward it, easing at `dt * 1.2`. **`project()` and
  `glassPoint(atScreen:)` must use the camera's actual rotation** (see Tank.swift), otherwise
  everything aimed at the cursor drifts off it while the camera is turned.
- **Fog**: linear-ish, start `eyeDistance + 1`, end `eyeDistance + depth + 14`, exponent 1.3. The
  background colour must equal the fog colour so distant sand dissolves seamlessly. Three.js `Fog`
  is linear; for the exponent, patch the fog chunk or accept linear.
- Day water `rgb(0.035, 0.2, 0.29)`, night water `rgb(0.004, 0.022, 0.045)` (sRGB 0..1).
- Post: HDR, bloom (intensity 0.5, threshold 0.85, radius 10), vignette. In Three.js:
  `EffectComposer` + `UnrealBloomPass` + a vignette pass; test the cost.

## Cursor interaction rules

- **Fish react to where they appear on screen, not 3D distance**: project the fish, compare to the
  cursor in screen points. A fast cursor (> 140 pt/s) startles within `110 + min(speed, 2500) * 0.1` pt
  (shrunk for distant fish). Fish flee away from the cursor *ray* and sideways out of its path.
- **Curious fish**: when the cursor rests ~0.7 s, some fish swim up to hover beside the cursor's line
  of sight, well in front of the glass, and face the viewer.
- **Plants** bend with the cursor's horizontal velocity if it passes over them on screen (done in the
  vertex shader using the cursor's glass point and each vertex's projection onto the glass).
- **Click-to-feed**: only clicks on bare desktop (the Swift app hit-tests other windows). Food drops
  where the click ray meets z = −1.4.
- Cursor velocity is smoothed: `vel += (instant − vel) * 0.35` per frame; "still" = speed < 25 pt/s.

## Lessons learned (read these)

1. **Per-frame uniform updates were the biggest CPU cost** in SceneKit (~23% of a core for ~25 fish).
   Three.js uniforms are cheap by comparison, but the design that fixed it is still good: run the tail
   beat on the GPU as `phase = time * freq + offset` and only send new `freq/offset/amp` when the
   rhythm changes noticeably (keeping phase continuous). Same for the turn bend and fin hover/brake.
2. **Draw calls matter**: merge all static scenery into one mesh (reef) and everything that sways into
   one mesh (plants) with per-vertex data (height fraction, plant height, phase, amplitude) driving the
   sway shader. Each fish is 3–4 draw calls: body, fins (one atlas), eyes.
3. **Shader time wraps hourly** (`timeWrap = 3600` s) to keep float precision, and **every animation
   frequency is quantized** to a whole number of cycles per wrap (`floor(w * k + 0.5) / k` with
   `k = 3600 / 2π`) so the wrap is invisible. JS's `performance.now()/1000` grows forever; do the same.
4. **Render only when you step the simulation**, at a fixed 30/60 fps. SceneKit's view rendered at
   the display's 120 Hz regardless of settings; a browser `requestAnimationFrame` loop will do the same
   on ProMotion displays unless you skip frames.
5. **Contact shadows are baked once** (Occlusion.swift): every reef piece and plant base registers a
   sphere; the sand gets an occlusion map (multiply), reef vertices darken near the floor, facing down
   and against neighbours. Scenery never moves, so it costs nothing per frame.
6. **Opaque textured cut-outs**: SceneKit pushed any texture with alpha through the transparent pass,
   making the shark's solid fins look see-through; fixed with alpha-test discard + opaque blending. In
   Three.js use `alphaTest: 0.5` with `transparent: false` for the shark's fins.
7. **Things that only showed up when looking**: a custom mesh without UVs was silently not drawn; the
   2D overlay was drawn in pixels instead of points (half size in a corner) on Retina; painting the
   shark's mouth interior onto the body skin left a dark stripe when the body flexed (now a separate
   piece, hidden while the mouth is shut). Take real screenshots early and often.
8. **Night spotlight**: a lamp hangs above the middle of the water (`y = surfaceY + 5`,
   `z = −depth * 0.45`, half-angle 16°) and *swivels* to aim at the cursor's ray in its depth plane;
   caustics and the beam are masked to its cone in the shaders. Turn only the lamp's shadow on at night
   (sun shadow off) and keep its shadow far plane tight — a far `zFar` cost ~8% CPU.
9. **Fog decides the shark's visibility**: it lurks 11.5–13 units behind the fish zone, just short of
   where the fog turns opaque (14 units back), so only a faint shape shows. Change the fog and the shark
   must move with it.
10. **The live wallpaper is the user's desktop**: test builds should run as a separate preview window
    and never replace the running wallpaper without asking.

## Behaviour (Fish.swift, Shark.swift) — port verbatim

- Steering: seek a target (wander goal / school goal / food / cursor hover), separation, schooling
  (tetras: align + cohere within 1.6 units), obstacle spheres, soft walls from `bounds(at:)`, flee.
  `vel += (desired − vel) * min(1, dt * agility)`; limit speed; limit climb.
- Speeds are in species points/s × `speedUnit = 1.2/100`.
- Orientation: yaw from velocity (or toward a look target when nearly still), pitch clamped ±0.6,
  roll into turns, slerped. The body curls into turns via a `swimBend` uniform (shark ×2.5).
- Glide-and-burst per species, C-start escapes on a new startle, clownfish stay near their anemone,
  fish drift toward the night spotlight's beam.
- Shark: lurk (slow patrols deep in the haze, gliding) for 15–40 s at first, then 30–110 s between
  hunts → hunt (charge at 5.5 u/s, lunge at 9 u/s, jaws open) → catch (jaw snaps shut, prey vanishes,
  a replacement fades in 45–90 s later) → retreat fast into the fog. Gives up after 10 s.
- Population per species scales with screen area: `population * clamp(area / (1512×982), 0.5, 2.5) * 1.3`.

## Scale factors

- Fish model units: species points × `FishModel.unit = 1.3/100`, then × a per-fish size of 0.85–1.15.
- Species data (lengths, heights, fins, colours, profiles) is in `Species.swift`; port it as-is.

## Suggested order

1. Scene, camera, fog, sand, cursor mapping (with a debug marker at the cursor's glass point).
2. One species of fish: body loft + skin + swim wave; then steering and cursor reactions.
3. Remaining species, fins, eyes, schooling, food.
4. Reef, plants (merged meshes + sway), caustics, baked AO.
5. Night mode + spotlight; shark; camera pan; per-fish variety and iridescence.
6. Measure GPU/CPU cost continuously — it's an always-on background.
