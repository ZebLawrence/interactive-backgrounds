# Aspen Snow — design

The sixth interactive background: a quaking-aspen grove in falling snow, seen at eye level
among the trunks. Web page only for now (`aspen/html/`), built to the bar in `guidelines.md`,
ported to native apps later by other agents.

## The scene

- **Where you stand.** Units are metres. The viewer stands at the origin, eye 1.6 m above the
  snow, looking north (-z) into a dense aspen grove on gently rolling ground, the camera level
  (horizon at mid-frame) so the trunks run out of the top of the view and the snow fills the
  lower half. Two or three big trunks stand within 2-4 m of the viewer at the sides of the
  frame; the grove thickens behind them and fades into snow haze about 120 m off.
- **Aspens.** Quaking aspen (*Populus tremuloides*): a grove is one clonal organism, so the
  trunks are alike in bark and build and stand 1.5-4 m apart. Trunks 20-50 cm thick and 15-22 m
  tall, straight with a slight lean; bark smooth, chalky greenish-white, with black eyes (old
  branch scars), short dark horizontal lenticel lines, dark cankers and wounds, and rough black
  furrowed bark on the lowest 1-2 m of the older trunks. Bare of branches to about 60% of their
  height (self-pruned in the shade of the grove), then an open crown of ascending branches that
  end in fine twigs. Winter: no leaves. A ridge of snow lies along the top of every branch and
  bends it slightly. Everything is drawn in metres in the shader so the bark is sharp at 4K.
- **Snow.** A snowpack with soft hummocks and drifts, a shallow well and a collar of snow around
  each trunk base, buried logs and shrubs as lumps, and a map of prints (hare tracks, the
  grouse's roost and burst crater, the pits where snow fell from the trees) that fresh snow
  fills in over ten minutes. Debris on it: fallen branches and twigs poking out, dead grass and
  shrub stems, aspen suckers (knee-high saplings with buds) in clumps, a fallen trunk with snow
  on top. Wind ripples and a faint sparkle in sunlight.
- **Sky and light.** Overcast by default: a flat pale grey dome, slightly darker overhead, with
  a soft bright spot where the sun is; soft hemisphere light and a weak diffuse sun; distance
  fades to the grey of the sky (haze, not black). **Sunlight** mode: the cloud thins and breaks,
  a low winter sun (about 20 degrees up, front-left) throws long blue trunk shadows across the
  snow (4096 shadow map over the near 40 m, baked shadows of the far trunks beyond), the bark
  glows and the snow sparkles. **Night** mode: a dark blue sky, a moon as the key light, the
  snow blue-white, haze fading to near black.
- **Falling snow.** Flakes at 0.5-1 m/s that rock as they fall and follow the air, in heavier and
  lighter spells; puffs and clumps when snow falls from the trees or is kicked up; swirls after
  a gust.
- **Left alone:** hares hop about, sit, groom, nibble suckers and bark, and sprint off now and
  then; the grouse flies up into a crown to pick buds and later dives back into the snow; gust
  fronts cross the grove and sway the trunks, shaking snow off a branch here and there; snow
  comes and goes in spells; by day the light shifts slowly as the cloud thins and thickens.

## The cursor

1. **Move fast:** a gust. Falling snow swirls after it, the trunks it passes sway on their
   springs, hard-shaken branches drop their snow ridges in clumps and veils of powder, and any
   hare near it bolts in long zigzag bounds, kicking up snow, until it is well away.
2. **Rest:** the nearest hare notices. It sits up tall, ears swivelling toward the cursor, nose
   working; held a few seconds, it hops over in a few bounds to sit and watch it from a couple
   of metres, and settles into a loaf if nothing happens. Rest the cursor on a hare and it
   freezes, then stares straight back.
3. **Click:** on the snow, a ruffed grouse bursts out of its snow roost there in an explosion of
   powder, whirring off low between the trunks to land in a crown, where it picks buds for a
   while before diving back into the snow somewhere else (if it is already up, the click just
   raises a puff and startles the hares). On a trunk, the tree shivers and its snow comes down
   in a cascade from the top, branch after branch, in clumps and powder.

## Menu (top-right button, glass panel, fades when idle)

Flush the Grouse (`G`), Hares (one / two / three), New Grove; Snowfall (`S`), Sunlight (`L`),
Night (`N`), Click to Flush, Low Power (30 fps), Full Screen. URL flags `?snow`/`?clear`,
`?sun`/`?overcast`, `?night`/`?day` override the saved settings.

## Modules (`aspen/html/js/`)

| file | owns |
|---|---|
| `app.js` | settings, menu, input, renderer, composer, fixed 30/60 fps loop |
| `util.js`, `shaders.js` | math, seeded random, canvas art, the hourly shader clock; shared uniforms, haze fog, `patchMaterial`/`patchDepth`, noise GLSL |
| `aspen.js` | the scene: layout of the grove, camera, lights and modes, cursor verbs, stepping every system |
| `tree.js` | the aspen builder (trunk, branches, twig fans, snow ridges), the bark shader, the instanced grove with per-tree springs and snow loads, the cascade |
| `ground.js` | snowpack mesh and shader, prints map, baked far shadows and contact darkening, debris, the far grove wall |
| `sky.js` | the sky dome (overcast / sun / night), the sun disc and the moon, the weather state |
| `snow.js` | falling snow and puffs |
| `hare.js` | snowshoe hare: procedural body, fur shader, gait, behaviour state machine, tracks |
| `grouse.js` | ruffed grouse: body, wings, tail fan, roost / burst / fly / perch / dive |

Conventions as the other backgrounds: Three.js r170 from the CDN via an import map, versioned
module URLs, no build step, everything procedural, hourly time wrap with quantised frequencies,
screen-space creature reactions with soft walls, fixed sub-steps for anything stiff.

## Verification

Screenshots at the default view and zoomed (a `view` aid with a narrow field of view aimed at
a world point), in each mode; hand-stepping the simulation to test the hares' approach, the
grouse's cycle and the print fill-in; console checked for shader errors after every reload.
