# Sketchfab wish list (for Zeb to download by hand)

The brief asked for a premade detailed boat interior rather than building one from scratch. There
isn't one this build could use.

What was checked, on 2026-11-08:

- **Poly Haven** — no wheelhouse, boat interior, or boat of any kind. Its props are what furnish the
  house here (the compass, the radio, the binoculars, the clock, the clipboard, the thermos, the
  torch, the hat, the stool, the extinguisher) and they are all CC0.
- **ambientCG** — materials only, no interiors.
- **Sketchfab** — has several good wheelhouses and ship bridges, but every download needs a logged-in
  account, which this build must not use; and of the ones that are free, the licences are CC BY-SA or
  not stated clearly enough to redistribute in a public repository.
- **TurboSquid, CGTrader, the Unreal and Unity stores** — paid, and their licences do not allow
  redistributing the model in a public repository even once bought.

So the shell of the house is built in code. That is the right answer anyway: the window openings
*are* the composition, and they have to be placed to the centimetre against the eye height, the sill
and the sightline over the bow (see the composition table in `trawler/README.md`). A downloaded
wheelhouse would have had to be re-cut to those numbers.

A downloaded interior is still worth having for the *dressing* — the panelling, the fittings, the
clutter — and that is what this list is for.

## What to look for

Search Sketchfab (or anywhere you have a licence for) for these, in roughly this order of value:

| | What | Why it would help |
|---|---|---|
| 1 | A fishing boat or coaster **wheelhouse interior** | the panelling, the window frames, the deckhead beams and the cable runs, which are the things that read as "a real boat" and are tedious to model |
| 2 | A ship's **helm console / bridge desk** | the console here is a lofted box with a teak top; a scanned one has the chamfers, the fiddles and the wear |
| 3 | A **ship's wheel** with turned spokes and bronze ferrules | the wheel is in frame constantly at the bottom of the view |
| 4 | **Marine instruments**: a radar set, a chart plotter, an echo sounder, a VHF | the screens are drawn procedurally; the *cases* around them are plain boxes |
| 5 | An **engine telegraph** or throttle quadrant | the one here is modelled in code |
| 6 | A **trawl winch** and **net drum** | the aft gear, which you see when you look astern |
| 7 | **Oilskins on a hook**, a chart table, a kettle | the small human things; the hat and the binoculars on the port wall are the only ones so far |

## Licence rule

Only bring in something that is **CC0** or **CC BY 4.0**. Not CC BY-SA (it would force the whole
repository to share-alike), not NC, not ND, and not "free" with no licence stated. Check the licence
on the page at the moment you download it — authors change them.

## How to bring one in

1. Download the **glTF** (not FBX) from the model page into
   `trawler/tools/raw/models/<name>/`, so you get one `.gltf`, one `.bin` and its maps.
2. `python trawler/tools/prepare-models.py <name>` converts the maps to WebP, repoints the glTF's
   image URIs and writes `trawler/html/assets/models/<name>/`.
3. Add a `models.<name>` entry to `trawler/html/assets/manifest.json` with `file`, `name`, `author`,
   `license` and `source`.
4. **Check its size before placing it.** Poly Haven models are in metres; many Sketchfab models are
   not. Load the page, call `trawler.propSizes()`, and compare the numbers against the real object.
   If the model is not in metres, give its `PROPS` entry an explicit `scale` rather than guessing a
   height — an earlier version of this scene normalised every prop to a guessed height and ended up
   with a 1.7 m clipboard standing through the port wall.
5. Place it: a row in `PilotHouse.PROPS` (`pilot.js`) for anything inside the house, or in
   `Deck.PROPS` (`deck.js`) for anything on deck. The deck table has the sightline arithmetic in its
   comment — anything abaft about z = −8.5 is under the window sill and will never be seen.
6. Credit it in the table in `trawler/README.md`, and run `node --test 'trawler/tests/*.test.mjs'`.
