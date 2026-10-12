# Balloon Dawn

A hot-air balloon fiesta drifting over a misty valley at sunrise, seen from a grassy hill, that
reacts to your cursor. A web page for now; no native app yet.

**Live:** https://zeblawrence.github.io/interactive-backgrounds/balloons/html/

- **Move the cursor** and you stir the wind: balloons near its path drift with it and lean into the
  gust, baskets swinging gently beneath them, and the long grass on the hill bends too.
- **Rest the cursor** on a balloon and its crew wave back.
- **Click a balloon** to fire its burner: a roaring flame lights the envelope from inside, throws
  warm light over the basket and rigging, glints off the long grass on the hill, and the balloon lifts, slowly, and keeps rising for a
  while after the flame as the heat lingers. Click empty sky and the nearest balloon fires instead.
- **Left alone**, the valley flies itself: envelopes slowly cool and sink, pilots fire their burners
  when they get low or just now and then, and gusts of wind come and go across the valley, pushing
  the balloons, leaning them, and bending the grass.
- **Night Glow** (menu, `N`): the fiesta's night show. The fleet flies on under a starry sky,
  starting low over the field, and each burn lights an envelope up like a lantern; **All Burn**
  (`A`) lights the lot in a ragged wave.
- **Every balloon is different**: a quilted envelope of 24 gores painted with its own pattern
  (gores, checkers, chevrons, diamonds, rainbow bands, sunburst, spiral, bands with a badge) in its
  own palette, with fabric weave, load tapes, a parachute vent, cables, a burner frame, a woven
  wicker basket with a leather rim, and a crew of two or three. Balloons shoulder past one another
  rather than passing through.
- **The valley**: a patchwork of fields, hedges, woods, a lane with farms along it and a river
  catching the sky, under banks of mist; three mountain ridges in dawn haze; a low sun with cirrus
  overhead; and a flock of swallows that scatters from a fast cursor and wheels around a resting one.
- **Balloons**: a handful, a fiesta, or the whole sky. **New Morning** re-seeds everything.

## Running it

It's a plain static page in `html/` (`index.html`, `styles.css` and ES modules in `html/js/`, with
Three.js loaded from a CDN), so there's no build step: serve the folder with any static server, e.g.
`python3 -m http.server` from the repo root, and open `/balloons/html/`. `?night` and `?dawn` in the
URL override the saved setting for testing.

## How it works

- Units are metres. The viewer stands on a knoll at the origin, 1.7 m above the grass, looking toward
  -z over a valley floor some thirty metres below to mountains 2.6 to 5.4 km away (`valley.js`). A
  screen point maps to a ray, so balloons can be hit-tested on screen and the cursor's motion can be
  turned into a wind vector in the world.
- `balloon.js` builds each balloon from shared geometry: the envelope is a lathe of a resampled
  Catmull-Rom profile, bulged between gore seams in the vertex shader and shaded with a normal map
  of the quilting; the pattern is painted on a 2048x1024 canvas and dressed with seams, tapes and a
  weave. Flying is simple physics: velocity relaxes toward the local wind (a slow veering breeze
  plus passing gusts), vertical speed follows the envelope's heat, which the burner raises and
  which leaks away slowly, a pilot burns when low or cool, and a damped pendulum leans the whole
  balloon into any horizontal acceleration. The burner is a noise-driven flame billboard, an emissive term in the
  envelope's shader that glows brightest near the throat, and one of a small pool of point lights
  that follow whichever burners are firing. The basket's wicker is a bump map as well as a colour.
- `terrain.js` draws the valley onto a 4096-pixel canvas (jittered field quads with hedgerows and
  furrows, copses, a lane, farms, the river) and displaces a large plane into the knoll, the floor,
  the river's dip and the foothills, multiplying in a tiled grass detail map close up and shading the
  ground under the long grass. `grass.js` is the meadow's instanced grass with a veined surface map,
  lit by the low sun with a backlit glow in the tips, bending in the wind and easing into the
  cursor's gusts. The sun casts a 2048-pixel shadow map over the knoll: blades shade each other (a
  custom depth pass bends them the same way), balloons cast onto the grass, the ground receives.
- `sky.js` renders the dawn gradient, sun disc and glow, drifting cirrus and the night's stars in one
  dome shader; the mountain ridges are fbm silhouettes on planes in the fog; the mist is soft sprites
  drifting over the valley floor.
- `birds.js` runs boids for the swallows and draws them as one instanced mesh whose wings beat in
  the vertex shader.
- Like the other backgrounds it renders at a fixed 30/60 fps, shader time wraps hourly with every
  frequency quantised to that period, and there are no assets: every texture is drawn on a canvas.
