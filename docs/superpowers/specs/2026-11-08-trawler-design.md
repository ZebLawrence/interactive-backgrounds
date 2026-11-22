# Trawler — design

The ninth interactive background, and the second one you inhabit rather than watch. The first-person
view from the pilot house of a working fishing trawler cruising a fjord coast: the sea as the main
subject, from glassy calm to a full gale, with real day and night cycles. Web page only
(`trawler/html/`).

## Why

The owner's brief, verbatim:

- the first-person view from the pilot house of a trawler cruising through fjords and islands,
  "as realistic as we can make it"
- the water changes state from calm to stormy
- find a premade detailed boat interior rather than building one from scratch
- like Hangar, every shader as detailed as possible
- the shoreline and islands are procedurally generated
- left alone, the boat slowly moves about and explores on its own
- the mouse points the camera around the pilot house
- the boat reacts realistically to the sea state
- full day and night cycles

Hangar proved the "you are inside it" idea and the scanned-material pipeline. This one takes the same
bar to a scene whose subject is **water and sky**, which is where a browser scene can actually beat a
game: there is one dominant surface, it can take the whole frame budget, and the physics of it is
well understood and published.

## Goals

1. **The sea is the star, and it is a real sea.** An oceanographic wave field, not scrolling noise:
   a directional JONSWAP spectrum inverse-FFT'd on the GPU in three cascades, so the same simulation
   produces the 200 m swell, the 10 m wind waves and the centimetre capillary ripple. Wind speed is
   the one knob; wave height, steepness, whitecap coverage, spray and the sound of the thing all
   follow from it the way they do at sea.
2. **The boat is a body in that sea.** Six degrees of freedom driven by buoyancy integrated over the
   hull waterplane against the *same* wave field, with added mass, bilge-keel damping and a real
   righting moment. Calm gives a 2° lazy roll; a gale gives 25° rolls, pitching that buries the bow,
   slams, and spray over the wheelhouse glass. Nothing is keyframed.
3. **A pilot house you could work in.** Every surface within arm's reach at 1024 px/m: the
   windscreen mullions, the teak console, the wheel, a compass binnacle, instruments that read the
   *actual* state of the boat (depth from the terrain under the keel, roll from the rigid body, a
   radar sweep showing the real islands around you), a mug that slides when she rolls.
4. **Fjords that go on.** An unbounded procedural archipelago: granite walls, islands, skerries,
   a navigable channel network, conifers below the treeline, snow above, surf where the water meets
   the rock. Nothing hand-placed, everything reseedable.
5. **Full day and night.** A physically-based atmosphere, a sun and a moon on real paths at 62° N,
   the Hipparcos stars and the Milky Way at night, cloud that thickens with the weather, cabin
   lights and a lighthouse ashore after dark, and instrument backlights in the house.
6. **It sails itself.** With no input the boat picks somewhere to be, routes through the channels,
   steers to it, slows for narrows, loiters when something is interesting, and heads up into the
   weather when it blows.
7. **The owner's three cursor verbs**, with the mouse's main job being the camera (their request).

## Anti-goals (fails even if it works)

- **A water plane with a normal map.** Anything that reads as a texture scrolling over a flat
  surface, or whose horizon is a hard line between two flat colours, has failed.
- **A boat on rails.** Motion that does not come from the wave field (a sine-wave rock, a fixed
  bob) fails. So does a boat that is *too* lively in calm weather: the guidelines' "halve your
  first guess" applies to roll periods as much as to wind.
- **An empty sea.** With no cursor input there must be gulls, porpoises, a distant vessel, a buoy
  going by, a lighthouse flashing, weather changing. "It just sits there" is a bug.
- **A cockpit that is a photograph.** The interior is the frame of every shot; a flat panel with a
  painted-on dial fails the 4K test the moment the owner leans in.
- **Shimmering water.** A sea shaded with per-pixel noise aliases horribly at the horizon. Slope
  variance must be filtered through mips so the far water goes smoothly glossy-grey, not sparkly.
- **Grey fog at night** (guidelines §1), **floating objects** (the boat must part the water and leave
  a wake), **a horizon that ends in a hard vertical edge** (headlands taper).

## Non-goals

- No Swift port (as with Hangar: web only).
- No player control of the boat beyond the cursor verbs; it is a background, not a simulator.
- No crew figures. Hands on the wheel were considered and dropped: a convincing animated human is a
  project of its own, and their absence reads as "you are the helmsman".
- No underwater camera, no fishing operation, no harbour.

## Constraints

- Three.js from the CDN, ES modules, **no build step**, GitHub Pages, one folder (`trawler/html/`).
- Fixed 30/60 fps loop with the Hangar frame governor: resolution never moves, the frame rate does.
- `?v=N` on every module URL, bumped on every push (guidelines §3).
- Assets only from sources that need no account: Poly Haven and ambientCG (CC0) and public-domain
  NASA/ESA data. Anything needing a login goes on a wish list for the owner.
- Everything else procedural, in world units (metres), painted at load where the camera gets close.

## The premade interior: what we found

The brief asks for a premade detailed boat interior. We looked, and there is not one we can use:

- **Poly Haven** (CC0, no account, already in our pipeline) has 521 models and no vessel interior.
  It does have the *contents* of a wheelhouse — see "Props" below.
- **ambientCG** is materials, not interiors.
- **Sketchfab** has wheelhouses (a Charleston tug wheelhouse, an RNLI lifeboat wheelhouse, a Lake
  Champlain vessel's upper cabin), but every download needs a logged-in account, and the closest
  matches are CC BY-SA or unclear. They go on `trawler/tools/SKETCHFAB-WISHLIST.md` for the owner,
  exactly as Hangar's console and door models did.
- The marketplaces (CGTrader, TurboSquid) have excellent trawler wheelhouses, all paid.

So: **the pilot house shell, console, wheel and glazing are modelled in code** — which the scene
needs anyway, because the window openings, the mullion positions and the sight lines over the bow
*are* the composition, and a bought interior would have to be rebuilt to frame this view. Everything
that sits *on* the console or hangs in the house is a real scanned CC0 model. That is the same
answer Hangar reached (doors and consoles in code, props scanned), and the same escape hatch: if the
owner downloads one of the wish-list wheelhouses, `pilot.js` can swap its shell for the model.

### Props (Poly Haven, CC0, fetched by the tools)

`seadogs_compass` (binnacle), `vintage_radio_transceiver` (VHF), `binoculars` and
`vintage_binocular`, `wall_clock`, `korean_fire_extinguisher_01`, `metal_stool_02` (helm stool),
`plastic_thermos`, `clipboard`, `plastic_torch_6v`, `vintage_flashlight`, `signal_flashlight`,
`retro_multimeter` and `vintage_spacecraft_instrument` (panel gauges), `fishermans_hat`,
`rubber_boots`, `lifebuoy`, `life_jacket`, `old_tyre` (fenders on the bulwark),
`metal_jerrycan`, `wooden_crate_01`, `plastic_crate_02`, `caged_hanging_light`,
`ocean_buoy` and `lateral_sea_marker` (channel marks in the water),
`coast_rocks_01/02/03/05`, `coast_land_rocks_02/03/04`, `coastal_cliff_01/02` (the shoreline),
`island_tree_01`, `tree_small_02`, `shrub_01..04` (the islands), `modular_wooden_pier`.

### Materials (Poly Haven / ambientCG, CC0)

`teak_veneer` (console facing), `plywood` (deckhead), `painted_metal_shutter` and
`rusty_painted_metal` (mullions, bulkheads), `brown_leather` (stool, chart-table edge),
`rubber_tiles` (wheelhouse deck), `wood_floor_deck` (the foredeck), `rusty_metal_03` (deck
machinery), `rock_face_01/02` + a granite set (the fjord walls), plus ambientCG plates for the
brass and chrome trim. Tiled at 1 m or 2 m so every one of them is ≥ 1024 px/m in the house.

## The sea

### Spectrum and simulation

- **Spectrum**: JONSWAP with fetch-limited peak frequency, driven by `U10` (wind at 10 m). Directional
  spreading `cos^{2s}((θ-θw)/2)` with `s` falling away from the peak (Donelan-style), so the sea is
  short-crested and confused in a gale and long-crested in a dying swell. A separate, slower swell
  train from a different quarter is always present, as it is at sea.
- **Three cascades**, patch sizes 512 m / 64 m / 8 m, N = 256 each, each band-limited to its own
  wavenumber window so they do not overlap or beat. Together they cover 0.03–100 rad/m: a 200 m
  swell down to 6 cm ripple, with no visible tiling.
- **Per frame**: evolve `h0(k)` by `e^{iω(k)t}` with deep-water dispersion `ω² = gk(1 + (k/km)²)`
  (the capillary term matters for the smallest cascade), then four complex inverse FFTs per cascade
  (eight real fields packed as real/imaginary pairs): displacement `Dx, Dy, Dz`, the two slopes of
  `Dy` for the normal, and the three horizontal derivatives for the folding Jacobian. Stockham
  ping-pong, `log2(256) = 8` passes each way.
- **Choppiness** `λ` rises with wind: crests sharpen and the troughs flatten, which is what makes a
  gale look like a gale rather than a big swell.
- **Foam**: the Jacobian of horizontal displacement marks folding crests; those feed a persistent
  foam buffer that is advected by the Stokes drift and decays over ~12 s, so whitecaps leave trails
  behind them instead of blinking on and off. Bubble/spray texture over the top.

### Surface and shading

- **Mesh**: a camera-centred clipmap of concentric rings out to 12 km (the horizon from a 4.4 m eye
  is 7.5 km, so the far rings only carry the haze and the sky's own curve). Cell size doubles per
  ring; each cascade's displacement fades out at the distance where its wavelength is under a pixel,
  which is what stops the crawl.
- **Shading**: Fresnel (Schlick, F0 = 0.0204) between
  - a **sky reflection** evaluated by calling the sky's own scattering function on the reflected
    ray, so the water and the sky can never disagree; plus the sun as a GGX lobe whose roughness
    comes from the *filtered* slope variance of the cascades (mip level chosen by distance), which
    is the whole anti-shimmer trick,
  - and an **upwelling colour**: depth-dependent (turquoise over a 4 m sand shelf, slate blue-green
    over the deep), with the classic backlit-crest glow where the sun is behind a wave, and a
    Lambertian sky term.
- **Shoreline**: depth comes from the terrain height function, so the water reads the bottom. A wet
  band, a surf line whose foam travels in along the shore normal at the shallow-water celerity
  `√(gh)`, and spray where it hits rock.
- **Wake**: the boat's own Kelvin pattern (cusp lines at 19.47°, transverse waves behind the stern)
  drawn in boat-local coordinates, a foam trail that decays over 60 s and bends with the turns,
  bow spray and a propeller wash that boils when she backs down.

### Sea state

One number, `sea` ∈ [0, 1], mapped onto the Douglas scale: `U10` 2 → 20 m/s, `Hs` 0.1 → 5.5 m.
It drives the spectrum, the choppiness, the foam coverage, the spray rate, the cloud cover and
base, the haze distance, the rain, the boat's speed and the autopilot's nerve. Left alone it is a
slow weather process (an Ornstein–Uhlenbeck walk with ~8-minute correlation plus a chance of a
front coming through), so the scene really does go from calm to stormy and back while you watch.
The menu pins it to Calm / Moderate / Rough / Storm, or lets it drift.

## The sky

- Single-scattering Rayleigh + Mie + ozone, with a transmittance LUT baked at load and an aerial
  perspective applied to every distant surface, so the islands and the sea haze come from the same
  atmosphere as the sky.
- Sun and moon on real paths for latitude 62° N (the Norwegian coast), so the summer night is a long
  blue twilight and the winter day is a low orange one. One cycle is 24 minutes of wall time by
  default (a minute an hour).
- Night: the **Hipparcos** catalogue (the same `stars.bin` Hangar built, 118,000 stars at measured
  position, magnitude and colour) and **NASA's Deep Star Maps 2020** Milky Way, both reused with
  their credits, turned to the right sky for the date and latitude. Moonlight is a cool key light
  with its own shadow; moonless nights fall back to a starlit sea, which is nearly black water with
  a silver sheen along the glitter path.
- Cloud: a cumulus layer whose height field is raymarched a few steps for self-shadow (silver
  linings at sunset, orange undersides, a dark base in a squall), a cirrus veil, and low scud in a
  gale. Cover, base height, thickness and darkness all come from `sea`.
- Rain in the top third of the range: streaks in the air, rings on the water, and the windscreen.

## The pilot house

2.6 m wide, 2.2 m deep, 2.05 m of headroom, the deck 4.0 m above the waterline, eye 1.65 m above
that deck. Built in code:

- **Windscreen**: five panes raked 10° forward in a bolted painted-steel frame with rubber glazing
  seals; two side windows each side (one slides); an aft bulkhead with a door, a window and a chart
  table. Glass is clean and nearly non-reflective by day (Hangar's lesson: a mirror pane smears
  bands across the view out) and picks up a faint interior reflection only at night, which is the
  real look.
- **Console**: teak facing, brass guard rail, the wheel (turned rim, six spokes, bronze hub),
  throttle and gear levers, a compass binnacle, a radar screen with a live sweep over the real
  islands, a plotter with the boat's own track on the real coastline, a depth sounder reading the
  real keel clearance, engine gauges that follow the throttle, a clinometer that shows the real
  roll, switch panels and a chart light.
- **Deckhead**: plywood panels, a conduit run, a grab rail, a dome lamp that switches white → red →
  off, a wiper motor.
- **Lived in**: a helm stool, rolled charts, a mug that slides on the console with the roll, hanging
  binoculars, a fire extinguisher, a thermos, a clipboard on a hook, a jacket, a clock.
- **Out of the windows**: the foredeck, bulwarks and rail, the foremast and boom, hatch covers, the
  anchor windlass, and aft the gantry and net drum — the scene's frame edges (guidelines §1).
- **Weather on the glass**: rain beads and rivulets that run with the airflow, two wipers, a spinning
  clear-view screen on the centre pane, salt film that builds in spray and washes in rain, and inside
  fogging that clears from the demister.

## The boat

22.4 m LOA, 6.6 m beam, 2.8 m draught, 95 t displacement — a west-coast steel trawler.

- Buoyancy integrated over nine waterplane stations against the CPU wave field (the same lowest-`k`
  components as the GPU cascades, so the boat rides the waves you can see), with added mass per
  axis, linear + quadratic damping, bilge-keel roll damping and a `GZ` curve.
- Natural roll period ~6.5 s, pitch ~4.1 s: she is tender and rolls lazily in calm, and synchronous
  rolling in a beam sea is a thing that can happen to you.
- Rudder and propeller: a PID autopilot on the route, speed 4–9 kn, slowing in narrows and turns.
- Slams when the bow re-enters (a measured vertical acceleration threshold) and throws spray.
- The camera is a person standing at the wheel: it rides the body transform, but the head is on a
  spring that lags the motion and keeps itself about 60% level, as a helmsman's does.

## The fjord

- **Height function** in GLSL, baked on the GPU into a near field (2 km / 2 m posts) and a far field
  (16 km / 16 m posts) that re-bake as the boat moves. The terrain clipmap samples those, so the
  shader is the single source of truth; a coarse read-back of the far field gives the CPU its
  navigation mask and the keel clearance.
- An unbounded archipelago: 2 km hash cells, each with a chance of a massif (60–900 m) at a jittered
  centre, plus long fjord walls along slowly curving spines, a glacial U-profile near the water,
  ridged multifractal rock, and skerries. Underwater it carries on to a −180 m floor with shelves.
- **Clipmap**: 7 levels, 128² each, 4 m posts out to 32 km.
- **Cover**: granite scans, triplanar by slope; moss and heather on gentle lower ground; scree below
  cliffs; snow above a snowline that follows the season and the aspect. Instanced conifers below the
  treeline, denser in the gullies, thinning to a treeline texture in the distance. Shoreline rocks,
  a wet tide band, kelp.
- **Signs of life**: a few cabins with warm windows at night, a lighthouse with a real flash
  character (Fl(2) W 10 s), channel markers and buoys, a salmon pen, the odd distant vessel.

## The cursor

1. **Move it** — points the camera around the pilot house (the owner's request): yaw ±115°, pitch
   ±28°, on a spring, so you can look out the side windows and back at the chart table.
2. **Rest it** — the view settles and studies whatever is under it: the gaze locks on, the
   helmsman steadies, and if it is the sea, a pod of porpoises or a raft of gulls comes over to
   look. (A cursor that has not moved at all never triggers it — Hangar's rule.)
3. **Click** — something deliberate, depending on what is under it:
   - the sea or the shore → she alters course for that bearing: the wheel turns, she heels into it
   - the throttle → one notch up, or back to slow
   - the horn → a blast (steam from the whistle, the gulls lift off)
   - the wiper switch → wipers on/off; the deckhead lamp → white / red / off
   - the radar or plotter → change range

## Menu

Top-right glass button in the house style, fading when idle:

| Item | Key | What |
|---|---|---|
| Sea state: Drifting / Calm / Moderate / Rough / Storm | `1`–`4`, `S` cycles | pins or frees the weather |
| Time: Cycle / Dawn / Noon / Dusk / Night | `N` | pins or frees the clock |
| Rain | `R` | |
| Red night lighting | `L` | the deckhead lamp |
| New Waters | | reseed: new archipelago, new route |
| Low Power (30 fps) | | 30 fps, buffer capped near 1080p, MSAA kept |
| Full Screen | | |

Flags: `?seed=N`, `?sea=0..1`, `?time=0..1` (0 = midnight), `?storm`, `?calm`, `?night`, `?noon`,
`?rain`, `?lowpower`, `?perf`.

## Modules

```
app.js  scene.js  util.js  shaders.js  governor.js  post.js  assets.js  assetjobs.js
ocean.js  oceanspec.js  seastate.js  waves.js        the sea
boat.js   nav.js                                     the hull and where it goes
pilot.js  instruments.js  deck.js  glass.js          the pilot house
terrain.js  flora.js                                 the fjord
sky.js  wake.js  wildlife.js                         sky, wake, life
```

Pure modules (`oceanspec`, `seastate`, `waves`, `nav`, `assetjobs`, plus the manifest check) get
node tests: `node --test "trawler/tests/*.test.mjs"`.

## Order of work

Each step must *look* like something before the next one starts:

1. Shell, governor, post chain, sky with the day/night cycle, a flat sea reflecting it.
2. The FFT ocean: spectrum → cascades → clipmap → shading → foam.
3. The hull: CPU wave field, 6-DOF body, the camera on it, the wake.
4. The pilot house, the glass, the deck outside.
5. The fjord: height bake, clipmap, cover, flora, shore surf, navigation.
6. Instruments, wildlife, lights ashore, spray and rain.
7. Assets: fetch and encode the scanned materials and props; swap them in.
8. Menu, modes, flags, verification at 4K-equivalent zoom in every mode, README, root listing, PR.

## Calls made by the builder (the owner can overrule)

- **No bought or logged-in interior**: modelled in code, with a wish list for the owner (above).
- **The camera is the only thing the mouse drives**, per the brief; the course change moved onto a
  click so the three verbs still exist.
- **A 24-minute day** so a sitting shows dawn and night, with the clock pinnable from the menu.
- **62° N and a summer date** by default: long twilights are the most beautiful sky this scene can
  have, and the menu's Night still gives a properly dark one.
- **No crew**, no hands on the wheel (above).
- **Reusing Hangar's `stars.bin` and Milky Way** rather than rebuilding them, with the same credits.
