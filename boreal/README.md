# Boreal Night

A snowy spruce clearing in the far north under the aurora, seen from a low rise at the forest
edge, where a great grey owl hunts voles under the snow. It reacts to your cursor. A web page for
now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/boreal/html/

- **Rest the cursor** and the owl watches it: it turns its head (as far as 270 degrees, the body
  shuffling round beyond that) in quick owlish turns with stillness between, its eyes opening
  from a doze. Rest the cursor on the owl itself and it stares straight back at you, head tilting.
  Hold the cursor still over another part of the clearing for a few seconds and the owl flies to
  the perch nearest it, to have a closer look.
- **Click the snow** and a vole stirs under it there. The nearest owl hears it: it turns to the
  sound and bobs its head to fix it, crouches and springs off its perch, glides low across the
  clearing, hovers with its feet lowered, and drops with its wings flung up in a V, swinging its
  legs out ahead at the last moment with the talons spread wide. It sits half buried a moment,
  mantling with its wings drooped over the snow, and flies back up (with the vole in its talons
  about half the time), swooping up onto the perch: it rears upright, brakes with wide, slow
  beats, fans its tail, reaches out with open feet that close on the perch, rocks as it finds its
  balance and folds its wings away. Where it struck it
  leaves the classic owl print: a pit flanked by the long marks of its wings, the primaries spread
  like fingers, and the fan of its tail. Falling snow fills the prints in over ten minutes or so.
- **Click the sky** and a bright surge starts on the aurora there and travels west along the arc.
- **Move the cursor fast** and it's a gust: falling snow swirls after it, the spruce it passes
  sway on their springs, and the ones swung hard enough drop their snow in clumps and veils of
  powder, their boughs springing back up as the weight comes off. Sweep it fast past an owl and it
  sleeks itself tall and thin in alarm; keep at it and it leaves for the farthest perch.
- **Left alone**, the night carries on: the aurora runs through substorms every few minutes,
  quiet arcs brightening and edging closer, then breaking up into bright, folded, rayed curtains
  with a pink-purple lower fringe and a surge running west, then fading into pulsing patches;
  every minute or two each owl hears a vole of its own and hunts it, or moves perch, scans the
  clearing, preens, or shakes out its feathers; gust fronts roll across the clearing now and then
  and shake the trees; snow comes and goes in heavier and lighter spells and slowly loads the
  trees again; a shooting star crosses now and then.
- **Aurora Substorm** (menu, `A`) breaks the aurora up now. **Rustle a Vole** (`H`) sets an owl
  hunting somewhere in the clearing. **Snowfall** (`S`) and **Moonlight** (`M`) turn the snow and
  the moon on and off: without the moon the clearing is darker and the aurora and stars stand out.
- **Owls**: a lone owl, a pair, or three, and no two alike: each night deals out a big female, a
  small male and one in between (great grey females run a tenth or more bigger), each with its own
  build (stocky or slim, tall or squat, bigger or smaller head, longer or shorter tail), plumage
  (cool ash grey, dark dusky, crisp silver, warm brownish or pale, with stronger or fainter
  markings and breast streaks), eye colour from lemon to deep yellow, and habits of its own: one
  sits fluffed out round, another sleek and upright, one holds its head a little tilted. Bigger
  birds beat their wings more slowly. **New Night** re-seeds the forest and the aurora.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/boreal/html/`. In the URL, `?snow` / `?clear`
and `?moon` / `?dark` override the saved settings for testing, and `?substorm` starts with the aurora
breaking up.

## How it works

- Units are metres. The viewer stands at the origin, eye 1.6 m above a knoll at the south edge of a
  muskeg clearing, looking north (-z) over the bog to a far tree line 260 m off, low hills at 4 and
  9 km, and the aurora (`boreal.js`). A screen point maps to a ray, so clicks land on the snow, the
  owls are hit-tested on screen, and the cursor's motion becomes gusts that act on whatever lies
  under them on screen.
- `aurora.js` draws each auroral arc as a long vertical sheet built at a tenth of real size, 100 km
  up becoming 10 km, with the Earth's curvature, so the arcs bow toward the horizon at their ends.
  The sheet's path meanders and folds with time; the shader adds rays (field-aligned striations
  that drift along the arc), a bright lower border, green oxygen light fading up into faint red,
  a purple nitrogen fringe when active, brightening where the sheet is seen edge on (the line of
  sight runs a long way through it), and dimming low in the sky. A substorm state machine
  (quiet, growth, expansion, recovery, after Akasofu) drives brightness, activity, the arcs'
  equatorward drift, westward travelling surges and pulsating patches. The aurora's light tints
  the sky, the snow and everything in it green.
- `spruce.js` builds each tree branch by branch: a tapering trunk, whorls of arched sprays every
  20-35 cm in a narrow crown, secondary sprays, a leader, dead twigs low down. The needles are drawn
  in the shader in metres (side twigs at 5 cm, needles about 1.5 cm) with alpha to coverage, fading
  into a solid mass with distance. The snow on each spray is a separate pillow whose thickness and
  coverage follow the tree's load; the load also bends the boughs down. Each tree is a damped spring
  at its own natural frequency (0.25-1.2 Hz, slower when taller); a hard swing sheds snow. Snags are
  silver-grey dead spruce with the stubs of every whorl and a cap of snow.
- `owl.js` builds the owl from a heavy, fluffed lathe body, one big round head whose front is
  flattened and dished into the facial disc (concentric rings centred on each eye, a dark rim,
  white brows, black chin, white bow tie), yellow eyes with lids, a fanning tail, and feathered
  legs with four toes and black talons that grip, splay or tuck. The wings are skinned meshes on
  a bird's skeleton (shoulder, elbow, wrist, outer hand) with feather-fan bones that close the
  feathers up along the bones: folding is the real Z-fold, so folded wings lie along the flanks
  with the primaries crossing over the tail, and the joints flex on each upstroke and lag on each
  downstroke. Plumage is drawn in the shader (vermiculation, breast streaks, coverts, barred
  flight feathers, feather rows). Its behaviour is a small state machine: perch, listen, take
  off, fly, hover, plunge, in the snow, land.
- `ground.js` makes the snowpack: a mesh that is dense in the clearing and coarse toward the
  horizon, with drifts, buried hummocks and tree wells. Fine wind ripples and the owls' prints
  (a 1024-texel map over 48 m) shade it through the normal, and a sparse glitter of crystal
  facets (only the few steeply tilted ones can mirror the low moon into the eye) twinkles close
  by, fading out where a facet would be smaller than a couple of pixels. The shadow map covers
  the near clearing; the moon shadows of every tree beyond it, and of the far tree line, are
  baked once onto the snow (a run of discs per tree, away from the moon, as wide as the crown at
  each height), so the snow darkens toward the forest. The horizon is a band of black
  spruce spires drawn in metres on a canvas (sharp at 4K) and two ranges of hills.
- `snow.js` runs the falling snow (flakes falling at 0.45-1 m/s, rocking as they go, following the
  air almost at once) and the puffs: clumps that drop like stones and burst where they land, and
  veils of powder that drift and settle.
- `sky.js` renders the stars, a faint Milky Way, airglow and the moon's halo in one dome shader;
  the moon is a sphere with NASA's LRO maps (see below), lit by its own sun as a waning gibbous.
- Like the other backgrounds it renders at a fixed 30/60 fps, shader time wraps hourly with every
  frequency quantised to that period (and the aurora's drifting noise is periodic so its phase can
  wrap too), and everything else is procedural.

The only image assets are the moon maps in `html/assets/` (`lroc_color_2k.jpg`, `ldem_3_8bit.jpg`),
from NASA's Scientific Visualization Studio CGI Moon Kit (https://svs.gsfc.nasa.gov/4720); credit:
NASA's Scientific Visualization Studio.
