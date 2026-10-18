# Aspen Snow

A quaking-aspen grove in falling snow, seen at eye level among the trunks, where snowshoe hares
live and a ruffed grouse roosts under the snow. It reacts to your cursor. A web page for now; no
native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/aspen/html/

- **Rest the cursor** and the hares notice: the nearest sits up, ears swivelling toward the spot,
  nose working. Hold it still a few seconds and that hare hops over in a run of bounds to sit up
  tall a couple of metres short of it and watch, leaving its tracks in the snow; the others watch
  from where they are. Rest the cursor on a hare itself and it freezes mid-whatever, then slowly
  turns to stare straight back at you.
- **Click the snow** and a ruffed grouse explodes out of its snow roost there in a burst of powder
  and a thunder of wingbeats, climbs, and whirs off low between the trunks, bursts of flapping
  alternating with glides, steering round the trees, up into a crown twenty to forty metres off,
  where it flares, fans its tail and settles to pick aspen buds for a minute or so before flying
  down and plunging back into the snow somewhere else to roost (so the next click can flush it
  again). Where it burst out it leaves a ragged crater with the snow thrown back round it; where
  it dived in, a hole and a short tunnel. If it is already up, a click just raises a puff and
  startles the hares.
- **Click a trunk** and the tree shivers and its snow comes down in a cascade from the top,
  branch after branch, in clumps that drop like stones and veils of powder that drift.
- **Move the cursor fast** and it's a gust: falling snow swirls after it, the trunks it passes
  sway on their springs, hard-shaken branches drop their ridges of snow, and any hare near it
  bolts in long zigzag bounds, kicking up snow at every landing, until it is well away, then sits
  up tall to see what happened.
- **Left alone**, the grove carries on: the hares loaf in their forms, sit up, groom with a fore
  paw, nibble the suckers, hop to a new spot, blink, flick an ear and breathe; the grouse comes
  out on its own every few minutes to feed; gust fronts roll through the crowns and shake snow
  off a branch here and there; the snow comes and goes in heavier and lighter spells and slowly
  fills every track and crater in again; the overcast thins and thickens. While it snows the sky
  and the far grove go to a flat, very light grey and the haze closes in.
- **Sunlight** (menu, `L`) breaks the cloud: a low winter sun throws long blue trunk shadows
  across the snow, the bark glows and the snow sparkles. **Night** (`N`) is a snowy night, dark
  blue under the cloud; with Sunlight on as well the sky clears to stars and a moon that lights
  the grove and throws its own shadows. **Snowfall** (`S`) turns the falling snow on and off.
  **Flush the Grouse** (`G`) flushes it from wherever it is roosting. **Click to Flush** turns
  clicks on the snow off, for when the page is a background.
- **Hares**: a lone hare, a pair, or three, each a little different in size, coat and the tilt of
  its ears. **New Grove** re-seeds the grove.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/aspen/html/`. In the URL, `?snow` / `?clear`,
`?sun` / `?overcast` and `?night` / `?day` override the saved settings for testing.

## How it works

- Units are metres. The viewer stands among the trunks at the origin, eye 1.6 m above the snow,
  looking north (-z) into the grove (`aspen.js`). A screen point maps to a ray, so clicks land on
  the snow or hit a trunk (tested against the trunk's swayed screen segment), the hares and the
  grouse react in screen space, and the cursor's motion becomes gusts that act on whatever lies
  under them on screen.
- `tree.js` builds each aspen like the real thing (*Populus tremuloides* in a dense clonal stand):
  a slender trunk with a slight lean and bend, its section wandering in and out and swelling
  at old branch stubs (no trunk is a true cylinder), bare to about half its height where the grove shades it,
  then ascending branches that fork twice and end in fans of fine twigs (drawn in the shader on
  cards, curving upward, merging into a grey mist far off). The bark is painted once at load
  (`bark.js`) into mipmapped textures in metres, so the detail is the same resolution from foot to
  crown and sharp at 4K without shimmering, with the relief of every feature baked in so it shows
  in flat light too: a feature map a metre round by four up (chalky white with a breath of the
  green living bark, grey weathered bands, long faint horizontal wrinkles ringing the trunk,
  lenticels in loose rows, the black "eyes" of shed branches with a pale raised rim and a faint tear below,
  cankers), a fine-grain tile at five pixels a millimetre, and a tile of the rough furrowed bark
  of a trunk's foot (narrow wandering ridges over dark furrows, broken into plates), which the
  older trunks wear to a metre or two up and the rest only as a dark collar at the snow, with a
  sharp tongued edge. Each trunk samples them at its own offset, squeezed to its own
  circumference, so no two show the same eyes. A ridge of snow lies along
  the top of every branch and twig, bending it a little; its coverage follows the tree's load.
  Each tree is a damped spring at its own natural frequency (0.2-0.5 Hz, slower when taller); a
  hard swing sheds snow, and a struck trunk runs a cascade front down its crown. Young trees and
  knee-high suckers are the same builder at other sizes; fallen branches and a log are dead grey
  wood half sunk in the snow.
- `ground.js` makes the snowpack: a mesh dense in front of the viewer and coarse toward the
  horizon, with soft swells, hummocks, a shallow well and collar round every trunk, lumps where
  shrubs and logs lie buried, and the snow banked along the fallen trunk. Its shader adds the
  fine grain and wind ripples through the normal, a glitter of crystal facets in sunlight, the
  prints (a 2048-texel map over 64 m: the hares' sets of four, the grouse's burst crater and
  roost hole) and two baked maps: the sun's shadows of every trunk beyond the shadow map's
  reach, and the contact shade at the foot of every trunk and under the fallen wood, so nothing
  floats. Dead grass pokes through in tufts that nod in the wind; a far grove wall drawn in
  metres on a canvas stands where the real trees end and the haze takes over.
- `hare.js` builds the snowshoe hare on a small rig (torso, head, ears, three-segment hind legs
  with the big snowshoe feet, fore legs, tail), clothed in about 800 fur cards drawn as hair
  strands, with dark eyes and their catchlights, a nose that works when it is alert,
  black ear tips and a contact shadow. Poses (loaf, sit, tall, crouch, stretch, land, nibble,
  groom) are blended; a bound runs crouch, stretch, land, gather with the real hare's sequence
  (hind feet land ahead of the fore feet), stamping the set of four prints at each landing, with
  steep walls and a rim of pushed-up snow so they read in flat light. The body and head are
  lofted from side-view profiles of the real animal (high rump, deep belly, domed skull, convex
  nose line, cheeks), and the pelt is shaded by the sky so the belly and undersides fall into a
  cool shade, which is what gives a white animal its shape on a white day. Its behaviour is
  a state machine driven by timers and the cursor: loaf, sit, tall, hop, bolt, nibble, groom,
  freeze. It keeps to the open snow in front of the viewer with soft limits, steers round the
  trunks, and turns to watch a point of interest with its head and ears.
- `grouse.js` builds the ruffed grouse: a plump lofted body, head with crest, feather-card wings
  (hinged at the shoulder, a ghost copy trailing the beat to blur a fast wing) and a fan tail
  with the black band, all in a feather-by-feather plumage shader. Its states are roost (hidden
  in the snow), burst, fly (steering round trunks, flapping and gliding), alight, perch (picking
  buds) and descend (ending in a folded-wing plunge).
- `sky.js` is one dome shader for the overcast, the broken cloud and sun, and the starry night
  with the moon's halo, plus the weather state that eases the sun and night amounts and sets the
  hemisphere light, the key light (sun or moon, each with a 4096 shadow map over the near 70 m)
  and the haze colour. The moon is a sphere with NASA's LRO maps (see below).
- `snow.js` runs the falling snow (flakes at 0.45-1 m/s, rocking as they go, following the air
  almost at once) and the puffs: clumps that drop like stones and burst where they land, and
  powder that drifts and settles.
- Like the other backgrounds it renders at a fixed 30/60 fps, shader time wraps hourly with every
  frequency quantised to that period, and everything is procedural.

The only image assets are the moon maps in `html/assets/` (`lroc_color_2k.jpg`, `ldem_3_8bit.jpg`),
from NASA's Scientific Visualization Studio CGI Moon Kit (https://svs.gsfc.nasa.gov/4720); credit:
NASA's Scientific Visualization Studio.
