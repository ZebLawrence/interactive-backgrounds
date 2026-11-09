# Trawler

The view out of a fishing boat's pilot house, somewhere in the fjords (`trawler/html/`). Spec:
`docs/superpowers/specs/2026-11-08-trawler-design.md`.

## What it is

You are standing at the wheel of a 22 m wooden trawler, eye 5.5 m above the water, looking forward
over her own foredeck through three raked panes of glass. She is under way at six or seven knots and
she is navigating herself: she picks a passage through the islands, holds it, alters for shoaling
water, loiters a while in a sound and goes on. The sea runs from a glassy calm to a full gale and
back over the course of an hour, the boat rides it as a boat of her tonnage and stability really
would, and the sun and the moon go round at latitude 62 on a day that takes twenty-four minutes.

Live: `https://zeblawrence.github.io/interactive-backgrounds/trawler/html/` (serve the repo root with
`python3 -m http.server 8000` and open `/trawler/html/` to run it locally). The sea, the sky and the
house are there immediately; the scanned materials and props stream in behind them.

## The cursor

- **Move the mouse** and the gaze swings round the pilot house: 115 degrees each way reaches the side
  windows and the aft bulkhead, 28 degrees up and down reaches the deckhead and the console. The head
  turns on a spring and leans with the roll; with the cursor in the middle of the window she looks
  three degrees down, which is where a helmsman's eye sits.
- **Click out through the glass** and she alters course to the bearing you clicked, holds it for
  about two minutes, and then goes back to her own passage. **Click the wheel** and she has it back
  at once.
- **Let the cursor come to rest** and the porpoises come over to ride her bow wave. They lose
  interest when it moves again, and they will not come at all when she is barely making way.
- **Click a control** and it works: the throttle quadrant steps through four notches (dead slow to
  full), the deckhead lamp cycles white, red and out, the first switch on the overhead panel starts
  the wipers whatever the weather, the dash steps the radar's range, and the overhead console
  sounds the horn.

## Menu and URL flags

Top-right button (it fades when idle):

| Item | Key | What it does |
|---|---|---|
| Drifting weather | `0` | the sea state wanders on its own, with fronts going through |
| Calm / Moderate / Rough / Storm | `1`–`4` | holds a sea state |
| Full day and night | | the clock runs: a day every twenty-four minutes |
| Dawn / Midday / Dusk / Night | `N` for night | holds the clock |
| Rain | `R` | rain on the glass and in the air, and the wipers go |
| Red night lighting | `L` | the wheelhouse goes to red, which is what you steer by at night |
| Low Power (30 fps) | | 30 fps, the drawing buffer capped near 1920 x 1080 (still 4x MSAA), no ambient occlusion, fewer shadow casters |
| New Waters | | a new seed: another archipelago, another boat's worth of dressing, another passage |
| Full Screen | | |

Flags: `?seed=N`, `?calm` / `?moderate` / `?rough` / `?storm`, `?sea=0..1`, `?dawn` / `?noon` /
`?dusk` / `?night`, `?time=0..1`, `?rain` / `?norain`, `?red`, `?lowpower`, `?perf` (frame timing,
draw calls, texture memory). The settings are remembered in `localStorage`.

Default mode renders at the window size x `devicePixelRatio` (capped at 2) with 4x MSAA, ambient
occlusion and bloom. A frame-rate governor holds 60 fps, or a steady 30 when 60 cannot be held; it
never lowers the resolution. At 1400 x 900 a frame costs about 6 ms on a modest discrete GPU and
about 9.5 ms at 6.1 megapixels; Low Power exists for a 4K panel that cannot hold either.

## The sea

The sea is a spectrum, not a sum of sine waves. A directional JONSWAP spectrum for the wind speed
and fetch of the moment is spread over direction by Mitsuyasu's cos^2s law (normalised properly, via
a Lanczos log-gamma, because an unnormalised spreading function gives a slope variance several times
too large and the sun glitter goes to tinsel), and the result is inverse-transformed on the GPU every
frame in three cascades — 2048 m for the swell, 256 m for the wind sea, 32 m for the chop — each a
256 x 256 Stockham FFT with a precomputed butterfly table, writing displacement and slope into a
multiple-render-target pair. The three bands are split by wavenumber so every wave is counted once
and none is counted twice.

Three checks keep it honest, and all of them are in `tests/`:

- the mean square slope matches Cox and Munk's measurements of sun glitter on a real sea
  (0.003 + 0.00512 U10) within a few per cent across the wind range;
- the significant wave height matches the spectrum's own fourth root of its zeroth moment;
- the surface the hull rides and the surface the GPU draws are the same surface. The hull is driven
  by a CPU sum of the longest components; `trawler.verifyOcean()` reads the GPU displacement back
  and compares the two at random points. Worst error: **0.49 mm on a 0.32 m RMS sea.**

The sea is drawn as a geometry clipmap centred on the camera, out to the curved horizon
(`y -= d²/2R`, which puts it 8.4 km off a 5.6 m eye and lets an island rise over it). Rings morph
onto their coarser neighbour's grid at the shared edge — and, less obviously, ramp the level of
detail they read the cascades at over the same band, because two rings reading the same vertex at two
different levels put it in two different places and open a hairline crack along the whole ring.

Her wake is the real Kelvin pattern: transverse crests at 2 pi V²/g and divergent crests along the
arms of a wedge 19.47 degrees either side of her track, whatever her speed, over a world-space foam
trail that she lays down behind her and that stays where she laid it. In shoal water the waves feel
the bottom and break, at the shallow-water celerity sqrt(gh), which is what puts white along every
rock whatever the sea is doing offshore.

The land is in the water. The sky's reflection comes from the atmosphere table per reflected ray,
which is a better sky than any mirror; the shore, the islands and the mountains come from a mirror
render of the terrain alone — the camera's image below the surface, with its near plane laid onto
the water (the oblique-projection trick three's `Reflector` uses) so the seabed the terrain also
carries cannot come up as land in the sky — looked up where each point of the sea projects in that
mirror and nudged by the wave slope, which is what breaks a shoreline into the streaks real water
makes of it. The land is a million triangles, so the mirror is drawn every other frame.

## The boat

A six-degree-of-freedom rigid body, not an animation curve. Twenty-seven pressure columns over nine
stations of a real hull form (22.4 x 6.6 m, 2.8 m draught, 200 tonnes, KG 2.84 m) are asked every
frame how deep they are under the sea surface at that very point; the buoyancy, the added mass, the
Froude–Krylov excitation of the wave's own pressure gradient, the quadratic roll damping of her
bilge keels and the lift of her rudder do the rest. Her metacentric height comes out of the form
(GM = KB + BM − KG), and `tests/boat.test.mjs` pulls her over and lets go: her roll period and her
decay are what a boat of her beam and stability has.

She navigates with an A* search over a chart of depth and clearance baked from the terrain, string-
pulled and smoothed, and a cross-track PID holds her on it. She will not stand into water she cannot
float in; shoaling under her overrides everything else she is doing.

## The sky

Real sun and moon positions for latitude 62, and real atmosphere: Bruneton's single-scattering model,
with transmittance baked once into a 64 x 64 table and the sky itself into a 192 x 108 table every
frame, shared by the sky, the sea and the land so that all three are in the same air. Aerial
perspective comes from the same tables. The camera adapts its exposure the way an eye does, over
three orders of magnitude between a bright noon and a moonless night, and everything that glows —
the stars, the moon, the instruments, the nav lights, the channel marks — is specified as a
brightness on the screen and divided by that exposure, because a lamp that is right at noon is a
white hole at midnight otherwise.

Stars are the Hipparcos catalogue at their measured positions, magnitudes and colours. Behind them
is NASA's Deep Star Maps 2020 — the real Milky Way, built from Gaia DR2, with the Hipparcos and
Tycho stars taken back out of it so the bright ones are not drawn twice. Both come from
`assets/sky/realsky.js`, the sky every background in this repository shares: the two files live
inside Hangar and are loaded from that one URL, so a visitor who has opened another of these
backgrounds already has them and nothing here is a second copy. It is turned by the same
equatorial-to-world matrix as the stars and the moon, so the band stands where it really stands: at
latitude 62 in September it lies up through Cygnus in the west after midnight, and the galactic
centre never clears the horizon. The moon is the Lunar Reconnaissance Orbiter's colour mosaic and
its height model, with the real libration and phase. Cumulus is a volumetric march; cirrus is a
sheet above it; both are lit by the same sun.

How bright the band is, checked rather than chosen: looking at Cygnus 54 degrees up on a moonless
night, the frame's median pixel is 4 of 255 and its ninetieth percentile 16, against 3.3 and 10.3
for a frame the same size 36 degrees off the galactic plane; with the band switched off the same
frame falls to 0.23, which is to say that out here it is the Milky Way and not the airglow that
lights the night sky. It costs 0.3 ms a frame.

## The fjord

The land is a height function written once in GLSL and baked into three textures: a near field
(4 km at 4 m posts) for everything you can see detail in, a far field (48 km at 47 m) for the ranges
beyond it, and a coarse chart (32 km at 125 m) read back to the CPU for the navigation. Ridges,
sounds, skerries and the snowline all come out of the same function, so the chart the boat navigates
by and the land you see are the same land. It is drawn as a second geometry clipmap, with rock,
cliff, scree, heath, shore and snow blended by height, slope and aspect.

Four channel marks follow her about, moored on shoals — four to thirty metres of water with deep
water within a hundred and seventy — and re-sited ahead of her when one falls three kilometres
astern. They float on the same sea the hull rides and their lights flash at night.

## The pilot house

### No premade interior exists

The brief asked for a premade detailed boat interior rather than building one from scratch. There
isn't one that can be used here. Poly Haven has no wheelhouse or boat interior of any kind. Sketchfab
has several good ones, but they need an account to download, and the ones that are free are CC BY-SA
or have no clear licence; the marketplaces (TurboSquid, CGTrader, Unreal/Unity) are paid and their
licences do not allow redistribution in a public repository. Only sources that need no account are
used here, and everything shipped is CC0.

So the whole house is built in code, to the owner's reference photograph of a trawler yacht's
wheelhouse — which is the right answer anyway, because the window openings *are* the composition and
they have to be placed to the centimetre. Nothing in it is a downloaded model. The joinery, the
leather and the paint are CC0 scans (Poly Haven's lacquered cherry, cherry veneer, white leather and
painted plaster); everything else is modelled in `pilot.js` and `panel.js`. `tools/SKETCHFAB-WISHLIST.md`
lists the richer CC-BY interiors and fittings the owner can download by hand and drop in.

### What is in the room

Region by region, as the photograph has it:

- **Windows** with radiused inner corners, in cherry frames with a bevelled room-side edge and a
  black rubber gasket between frame and glass, set in the cream-painted house side. Three forward,
  one in each angled corner wall, two each side, and a glazed light in the saloon door aft. The
  house is planned as walls: the front to `frontHalf`, a corner wall each side at 52 degrees to it,
  then the sides, each wall one piece of house side with its own openings cut in it and a cherry
  post on each joint — which is why there is no overlap at the corners.
- **The dash**: a cherry counter that follows the walls round the corners and meets the side desks
  flush, with a bullnose edge and a raked pod standing on it, carrying the
  nav display (radar and chart side by side, with soft keys down its edge), the fishfinder, the
  autopilot head over the loudhailer with its hand mic on a clip, three engine gauges and a compass
  in a black binnacle under a glass dome. The twin-lever chrome engine control sits on the counter to
  starboard; the throttle lever follows the order and the gear lever sits in ahead.
- **The wheel**: a thin-rimmed five-spoke stainless destroyer wheel on a chrome column from the
  dash's face, with a knuckle where a tilt helm has one, following the rudder.
- **Four breaker panels** in raised cherry frames across the dash's face — AC, DC, electronics,
  pumps and tanks — each with two digital meters, a legend for every circuit and a black toggle
  with a red tell-tale beside it that lights when the circuit is live. Clicking the DC panel throws
  the wipers' breaker.
- **The overhead fascia**, raked down toward the helmsman: a blanking panel, the AIS, the
  stabiliser display, a lighting switch panel, a rudder gauge, a six-gauge engine cluster, a heel
  gauge, a deck switch panel, the VHF with its handset hanging on a clip and its coiled cord
  dropping to the socket, a blue-faced heading repeater and the nav data display.
- **Side desks** with fiddle rails cut with oval handholds, two rows of drawers with routed finger
  pulls over louvred doors, and a gooseneck chart light each. To starboard a monitor on its stand,
  a keyboard and mouse, two handheld VHFs standing in a cherry cradle and the thruster stick; to
  port the chart table's binder and dividers. White outlets and a switch plate on the walls.
- **Two helm chairs** in cream leather: bolstered seats, winged backs with a headrest roll, padded
  arms on chrome brackets, chrome pedestals.
- A cream vinyl **headliner** with cherry trim and four recessed lights (white by day, red at night),
  a teak-and-holly sole, a brass clock and barometer aft, a shelf, and a mug on the dash that slides
  when she rolls.

### How the devices are made

The rule in `panel.js`: what is *printed* is a texture, because printing is flat; everything that
catches the light is geometry. A case is a bevelled, rounded extrusion, not a box. A key is a raised
cap with its legend on top. A knob is turned on a lathe with its pointer. A gauge bezel stands proud
of the dial and the needle stands proud of that. A toggle is a stem and a tip that tilt. The ICOM
VHF has its twelve-key pad, soft keys, amber LCD showing channel 16, channel and volume knobs, and
the red DISTRESS button under a propped translucent cover. Fascias are drawn at 5,000–6,000 pixels
to the metre, so they survive a 4K screen with the owner leaning in.

Every screen shows the real thing: the radar walks out along 256 bearings until the chart says rock,
the chart draws the same coast and the track she has run, the fishfinder reads the water under her
keel, the stabiliser display reads the hull's own roll, the autopilot head and the nav data page show
the heading and speed she is making. The gauges read the boat too; at night their dials are backlit.

### Light from the windows, and shadows

The room is lit three ways. A hemisphere fill stands in for the bounce round a varnished room with
a cream deckhead (three has no global illumination). Two directional **window lights** from the
forward quarters, scaled by the sky's irradiance, are the sky coming in through the glass as direct
light; each has a shadow map fitted to the house, so the pod throws its shadow across the counter
and the wheel across the panels. And the sun itself: when it is low and ahead it comes through the
windscreen and puts sunlit patches and hard shadows across the dash. At night the two forward
recessed lights are spots with shadow maps and the aft pair plain points.

One bug worth recording: three's shadow pass draws *back* faces, so a single-sided plane casts no
shadow at all. The roof and the bulkheads were planes, and at noon the sun was walking straight
through them — it put more light on the dash than the windows did, and that flat, shadowless room
was the result. The shell's plane materials now have `shadowSide = DoubleSide`. The house's maps are
refreshed every third frame (the lights ride the house, so only the wheel and the levers move in
them) and only while there is sky or lamplight to cast; the renderer's manual shadow refresh in
`scene.js` runs whenever either the sun or the house asks for it.

### Contact shadows, and the night

Where surfaces close on each other — the pod on the counter, a drawer in its carcass, the mug on
the dash — three's lights alone leave them as cut-outs laid on each other, because there is no
global illumination to darken a crease. Ground-truth ambient occlusion in screen space (three's
`GTAOPass`) puts that darkening back. It works from the beauty pass's own depth buffer, with
normals rebuilt from it, rather than rendering the room a second time for a normal buffer, which
was most of the pass's cost; the glass is kept out of that depth so the view through a window is
not darkened round its frame. Low Power drops the pass.

At night the room is the lamps' and nothing else's. The fill and the window lights are daylight
and go out with the sky; the four recessed lights are spots with shadow maps of their own (the
forward pair the larger), each desk lamp throws a narrow warm cone onto its desk with a shadow
map of its own, and the two big screens carry a point light a hand in front of them, as bright as
the screen, so the counter glows under the displays. The house refreshes one of these maps a
frame, in turn. The beams are not drawn in the air: a downlight's cone shows where it lands - on
the counter, the chair, the dash - and nowhere else. Two things had been lighting the cabin at
night that should not have: the sky's ambient floor, three times what
the lamps put on a surface, now a fifth of it; and the deck floods on the crosstree — half a
candela, five hundred times a cabin lamp — which had no shadow maps and so shone straight through
the roof onto everything that faced forward. The floods are gone (their fixtures remain); what
they lit was never in frame.

The channel marks' lights glitter on the water: each is a point source in the ocean shader with
the same rough-specular lobe the sun and moon use, in the mark's own colour, flashing with it. Its
strength is a screen brightness like the lens on the mark, because a lantern's true radiance
against a night sea is far past anything a display can hold.

### Polished stainless: a cube map of the room

A mirror-finish metal is nothing but its reflections, so the chrome — the wheel, the column, the
engine control, every knob ring and bezel lip — reflects a cube map the house renders of itself from
a point beside the wheel's hub, one face every other frame, at 128 pixels a side, in the scene's own
linear radiance. The lookup is a small shader of its own rather than a standard material with an
environment map: three's physical materials want that map pre-filtered through PMREM, which renders
black on the owner's GPU (see `sky.js`), and a mirror needs nothing a BRDF offers beyond the
reflected radiance, a little Fresnel and the slightly warm, slightly dark tint of stainless. Because
it is radiance, the chrome follows the exposure from noon to a lamplit night with no scaling of its
own; while a face is being drawn the chrome is handed no map at all, so it never samples the
texture it is rendering into.

### The composition, worked out from numbers

```
 4.00  the wheelhouse sole
 4.80  the dash top and the side desks
 4.90  the wheel's centre
 4.98  the windscreen sill
 5.52  the helmsman's eye
 6.02  the windscreen head
 6.14  the deckhead
```

The eye is 1.58 m back from the glass, whose sill is 0.54 m below it and whose head 0.50 m above.
Through a 62 degree lens pitched three degrees down the glass fills the middle of the frame, the pod
on the dash takes the bottom sixth and the deckhead and the overhead fascia the top fifth. Three
front windows with the middle one wide: the two divisions sit 24 degrees off the centreline, well
clear of where the bow and the horizon are. The windscreen is vertical, as the reference yacht's
is: a raked front meeting vertical corner glass makes a slanted joint that no post can cover.

The cherry scan is a dark cherry and the photograph's is a honey one: at noon the scan's dash top
rendered at 73 of 255 in red against the photograph's 190, with the hue right, so the material's
tint is a gain (a colour with components past one) tuned to put the dash top where the photograph's
is, and the grain's normal map is turned down to a satin.

The glass is its own layer: rain beading and running (climbing, above about five knots, because the
airflow beats gravity), salt drying on from the spray and washing off in the rain, misting from the
warm wheelhouse on a cold night, two wipers on the outer panes and a spinning clear-view screen in
the middle.

The props out on the foredeck — crates, jerrycans, fenders, a lifebuoy, a lifejacket, a caged light —
are Poly Haven scans at their real size, placed and not scaled. `trawler.propSizes()` prints the
bounding box of every one in metres, which is how you check it rather than squinting at a screenshot.

## Modules

`html/js/`, about 9,500 lines, no build step:

| Module | What it is |
|---|---|
| `mathutil.js`, `util.js` | pure maths and the three-dependent helpers; `mathutil` imports nothing, so node can test the boat and the navigation |
| `shaders.js` | the shared uniforms, the atmosphere read, noise, shadows, BRDF, the fog override |
| `oceanspec.js`, `fft.js` | the wave spectrum and the Stockham transform, both pure and both tested |
| `ocean.js` | the cascades, the simulation passes and the sea's clipmap and shading |
| `seastate.js` | the weather: an Ornstein–Uhlenbeck wander with fronts going through |
| `boat.js`, `nav.js` | the rigid body and the pressure columns; the chart, the A* and the autopilot |
| `wake.js` | the Kelvin pattern, the world-space foam trail and the spray |
| `sky.js` | the atmosphere tables, sun and moon, stars, clouds |
| `terrain.js` | the height function, the three bakes and the land's clipmap |
| `pilot.js`, `glass.js`, `instruments.js`, `deck.js` | the house, the glazing, the screens and the boat you see out of the window |
| `materials.js`, `assets.js` | the manifest-driven material set and the loader |
| `wildlife.js` | porpoises, rain and the channel marks |
| `post.js`, `governor.js`, `scene.js`, `app.js` | bloom and AO, the frame-rate governor, the scene and the shell |

Tests: `node --test 'trawler/tests/*.test.mjs'` — 37 of them, covering the spectrum, the transform,
the hull, the navigation and the shader sources.

## Asset pipeline

`tools/` holds offline scripts (nothing runs in the browser); `tools/README.md` has the full rebuild
recipe. In short: Poly Haven and ambientCG (CC0) downloads are packed into colour / normal / ORM maps
at 1024 px per metre and encoded as WebP, and props are optimised to glTF. Outputs and
`html/assets/manifest.json` (source, author and licence of every file) are committed; raw downloads
are git-ignored. Only sources that need no account are used.

WebP rather than KTX2: the KTX2 route needs Binomial's `basisu` encoder, and running the downloaded
WASM build was not possible here. WebP at 1024² is sharper than UASTC at the same size, needs no
toolchain, and still gives 1024 px per metre at a 1 m tile — which is the number that matters, since
every surface in the house is within two metres of the viewer.

## Credits

Every asset the page loads is listed in `html/assets/manifest.json` with its source, author and
licence; this table mirrors it. Thanks to Poly Haven and ambientCG for the CC0 scans, to NASA GSFC's
Scientific Visualization Studio (and ESA/Gaia/DPAC) for the Milky Way, to NASA's Scientific
Visualization Studio for the CGI Moon Kit, and to ESA's Hipparcos mission (via NASA HEASARC) for the
stars.

| Kind | Key | Asset | Author | Licence | Source |
|---|---|---|---|---|---|
| Material | `mat:deck` | Wood Floor Deck | Dimitrios Savva | CC0 | https://polyhaven.com/a/wood_floor_deck |
| Material | `mat:enamel` | Painted Plaster Wall | Amal Kumar | CC0 | https://polyhaven.com/a/painted_plaster_wall |
| Material | `mat:heath` | Forest Ground 06 | Charlotte Baglioni | CC0 | https://polyhaven.com/a/forest_ground_06 |
| Material | `mat:leather` | Brown Leather | Rob Tuytel | CC0 | https://polyhaven.com/a/brown_leather |
| Material | `mat:paint` | Painted Metal Shutter | Dario Barresi, Rico Cilliers, Charlotte Baglioni | CC0 | https://polyhaven.com/a/painted_metal_shutter |
| Material | `mat:paint-worn` | Rusty Painted Metal | Amal Kumar | CC0 | https://polyhaven.com/a/rusty_painted_metal |
| Material | `mat:plywood` | Plywood | Rob Tuytel | CC0 | https://polyhaven.com/a/plywood |
| Material | `mat:rock` | Dark Rock | Amal Kumar | CC0 | https://polyhaven.com/a/dark_rock |
| Material | `mat:rock-cliff` | Cliff Side | James Ray Cock, Jenelle van Heerden, Dario Barresi | CC0 | https://polyhaven.com/a/cliff_side |
| Material | `mat:rubber` | Rubber Tiles | Amal Kumar | CC0 | https://polyhaven.com/a/rubber_tiles |
| Material | `mat:scree` | Brown Mud Rocks 01 | Rob Tuytel | CC0 | https://polyhaven.com/a/brown_mud_rocks_01 |
| Material | `mat:shore` | Coast Land Rocks 01 | Rob Tuytel, Rico Cilliers | CC0 | https://polyhaven.com/a/coast_land_rocks_01 |
| Material | `mat:snow` | Snow006 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/Snow006 |
| Material | `mat:steel` | MetalPlates001 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/MetalPlates001 |
| Material | `mat:steel-brushed` | Metal009 | ambientCG (Lennart Demes) | CC0 | https://ambientcg.com/a/Metal009 |
| Material | `mat:steel-rust` | Rusty Metal 03 | Amal Kumar | CC0 | https://polyhaven.com/a/rusty_metal_03 |
| Material | `mat:teak` | Teak Veneer | Jenelle van Heerden | CC0 | https://polyhaven.com/a/teak_veneer |
| Model | `binoculars` | Binoculars | Derek Wight | CC0 | https://polyhaven.com/a/binoculars |
| Model | `buoy` | Ocean Buoy | Mateusz Sadek | CC0 | https://polyhaven.com/a/ocean_buoy |
| Model | `caged_light` | Caged Hanging Light | Ulan Cabanilla | CC0 | https://polyhaven.com/a/caged_hanging_light |
| Model | `clipboard` | Clipboard | ProgrammerOnCoffee | CC0 | https://polyhaven.com/a/clipboard |
| Model | `clock` | Wall Clock | PierreB3D | CC0 | https://polyhaven.com/a/wall_clock |
| Model | `compass` | Seadogs Compass | Benny Weimer | CC0 | https://polyhaven.com/a/seadogs_compass |
| Model | `crate` | Plastic Crate 02 | Fabi_G | CC0 | https://polyhaven.com/a/plastic_crate_02 |
| Model | `extinguisher` | Korean Fire Extinguisher 01 | UM JOORIN | CC0 | https://polyhaven.com/a/korean_fire_extinguisher_01 |
| Model | `fender` | Old Tyre | MP | CC0 | https://polyhaven.com/a/old_tyre |
| Model | `hat` | Fishermans Hat | PierreB3D | CC0 | https://polyhaven.com/a/fishermans_hat |
| Model | `jerrycan` | Metal Jerrycan | Sean Buckley | CC0 | https://polyhaven.com/a/metal_jerrycan |
| Model | `lifebuoy` | Lifebuoy | Hank Kaamura | CC0 | https://polyhaven.com/a/lifebuoy |
| Model | `lifejacket` | Life Jacket | PierreB3D | CC0 | https://polyhaven.com/a/life_jacket |
| Model | `seamark` | Lateral Sea Marker | James Ray Cock, Kuutti Siitonen | CC0 | https://polyhaven.com/a/lateral_sea_marker |
| Model | `stool` | Metal Stool 02 | Ulan Cabanilla | CC0 | https://polyhaven.com/a/metal_stool_02 |
| Model | `thermos` | Plastic Thermos | PierreB3D | CC0 | https://polyhaven.com/a/plastic_thermos |
| Model | `torch` | Vintage Flashlight | Omar M. El-Safy | CC0 | https://polyhaven.com/a/vintage_flashlight |
| Model | `vhf` | Vintage Radio Transceiver | Mateusz Sadek | CC0 | https://polyhaven.com/a/vintage_radio_transceiver |
| Image | `lroc_color_2k.jpg` | CGI Moon Kit, LROC WAC colour mosaic | NASA's Scientific Visualization Studio | PD | https://svs.gsfc.nasa.gov/4720 |
| Image | `ldem_3_8bit.jpg` | CGI Moon Kit, LOLA displacement map | NASA's Scientific Visualization Studio | PD | https://svs.gsfc.nasa.gov/4720 |

The night sky's two files are not in this folder: they are the repository's shared copies, loaded
through `assets/sky/realsky.js` from `hangar/html/`, and Hangar's README credits them.

| Shared | `hangar/html/assets/images/milkyway.ktx2` | Deep Star Maps 2020, the Milky Way without the Hipparcos/Tycho stars, 8192 x 4096 equatorial | NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC | PD | https://svs.gsfc.nasa.gov/4851 |
| Shared | `hangar/html/data/stars.bin` | Hipparcos Main Catalogue (ESA 1997), HEASARC copy: positions, V magnitudes, B-V colours | ESA Hipparcos mission; NASA HEASARC | PD | https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/hipparcos.html |
