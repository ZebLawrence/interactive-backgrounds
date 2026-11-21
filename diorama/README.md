# Diorama

A new kind of background (`diorama/html/`): the webcam follows your head, and the screen stops being a picture
and becomes a window. Sit in the middle and you look straight in; lean to the right and you see more of
the left wall, as you would through a real opening. What is behind the glass is a "skin". There are three:

- **The Office** (`js/noir.js`, the default): a private investigator's office in the rain, as a 1:10
  miniature, in which a four-night mystery is told by what changes on the pinboard and the desk, by the
  shadows that come to the frosted door, and by the light through the blinds. See "The office".
- **Computer** (`js/pc.js`): the inside of a desktop PC, seen through its glass side panel, at
  about real size. The motherboard is on the far wall, and the tower cooler, the memory and the graphics card
  stand out of it toward you, so there is always something to look round.
- **Test Box** (`js/room.js`): the plain ruled box the technique was proved with, kept for checking the
  tracking.

Live: `https://zeblawrence.github.io/interactive-backgrounds/diorama/html/` (or serve the repo root with
`python3 -m http.server 8000` and open `/diorama/html/`). A camera needs https or `localhost`; a page opened
from a `file:` path cannot have one.

## Using it

- The first visit asks whether to use the webcam or the mouse. **The picture is read in the tab only: nothing
  is recorded, stored or sent anywhere.** The choice is remembered.
- **Move your head** and the view follows: left and right, up and down, nearer and further. When your face
  leaves the picture the view drifts back to the middle, and picks you up again when you return.
- **Calibrate once** (`K`): sit straight in front of the middle of the window with your eyes 60 cm from the
  screen (about an arm's length) and press `K`. That measures the camera's field of view and where its lens
  is, which the page otherwise has to guess. Do it again if you move the camera. Set **Display Size** to
  your monitor's diagonal first: it is what makes the box real size.
- **Without a camera** the mouse stands in for your head, and the wheel moves you nearer and further.

## Menu and URL flags

Top-right button (it fades when idle):

| Item | Key | What it does |
|---|---|---|
| Scene | `S` | The Office, Computer or Test Box |
| Chapter / Lighting | `L` | in the office, on to the next night; in the computer, its mood: Dread (red, a slow heartbeat), Abyss (deep blue), Toxic (green), Spectrum, Work Light (the case's strip turned up, to see how it is made), Off |
| Track My Head (Webcam) | `C` | the webcam on or off; off, the mouse is your head |
| Calibrate | `K` | sit centred, 60 cm back, and press it (above) |
| Clear Calibration | | back to the guesses |
| Display Size | | steps through monitor diagonals, 13 to 43 inches |
| Camera Preview | `P` | the camera's picture, mirrored, with the irises and the eye point marked |
| Readout | `H` | the eye's position in centimetres, the tracker's rate, the glass's size |
| Full Resolution | | never draw fewer pixels than the display has; the frame rate gives instead (see "Frame rate") |
| Low Power (30 fps) | | 30 fps, no ambient occlusion, smaller shadow maps |
| Full Screen | | |

Not in the menu: a click on the scene is a knock on the glass (in the office it switches the desk lamp and the picture light off and on),
and `E` starts the next of the things that
otherwise happen by themselves (see "What goes on in there").

Flags: `?skin=office` / `?skin=computer` / `?skin=box`, `?leds=abyss` (a lighting mode by name, or one of the
office's nights: `client`, `trail`, `warning`, `answer`), `?event=crawl` (start one of
the random events three seconds in: `crawl`, `eyes`, `descend`, `code`, `morse`, `sag`), `?camera` / `?mouse`,
`?preview`, `?hud`, `?fullres`, `?lowpower`, `?diag=27` (display diagonal in inches). The
settings and the calibration are remembered in `localStorage`.

## How it works

Three steps, each in its own module.

**1. Find the eyes (`tracker.js`).** Each camera frame goes to MediaPipe's Face Landmarker, running in the
tab (WebAssembly, on the GPU where there is one), which returns 478 points on the face including the edge of
each iris. It is fetched only when the camera is switched on.

**2. Turn that into a position in metres (`headpose.js`).** One camera cannot see depth, but it can see a
ruler of known length. A human iris is 11.7 mm across in every adult, give or take half a millimetre, but it
is only 20 pixels wide and it disappears in a blink: read off the iris alone, the distance jumped every time
the viewer blinked and the scene lurched. So the ruler is the span between the outer corners of the eyes,
which is 150 pixels wide, rigid and indifferent to blinking, and the irises only calibrate it: while both
eyes are open, this viewer's span is learned as `11.7 mm x the span's angle / the iris's angle` (a second or
so; the Readout shows it). Sizes are compared as angles between rays from the lens, not as pixel lengths,
because a flat picture stretches things toward its edges and a face near the side of the frame otherwise
reads as nearer than it is and its sideways position comes out short. A turned head's foreshortened span
is corrected from the landmarks' own depth. The result is moved from the camera's frame to the window's
(a webcam picture is not a mirror, so left and right swap), using the window's physical size and the lens's
place on top of the display. A One Euro filter steadies it: hard smoothing while the head is still, almost
none while it moves, because shiver and lag are the two ways this effect fails.

**The backup: head and shoulders.** The face tracker needs the face, and lets go of it when the viewer turns
aside or leans toward the edge of the camera's view, which is exactly when they are looking round the side
of the box. So a second model, MediaPipe's Pose Landmarker, stands behind it. It finds the nose, eyes, ears
and shoulders from the outline of the head and upper body, in profile or half out of the frame. While the
face tracker has the viewer it runs on every sixth camera frame and is taught by it: the width of this
viewer's shoulders (its ruler for distance, since shoulders do not turn with the head) and the small
difference between the two models' idea of where the eyes are, so the view does not jump at the handover.
When the face is lost it runs on every frame and takes over; with the shoulders out of the picture too, the
last distance from the screen is held and only the direction is followed. The face tracker takes back over
the moment it has the face again. The Readout says which of the two has you, and the Camera Preview marks
the backup's points in orange.

**3. Draw the view for that eye (`offaxis.js`).** The window is the rectangle of the screen in the plane
z = 0, and the eye is a real point in front of it. The right picture is an off-axis projection: a frustum
that leans so its four side planes pass through the four edges of the window wherever the eye is (Kooima's
generalised perspective projection; the idea behind Johnny Lee's head-tracked Wii demo). The camera never
turns, only its frustum moves. Turning an ordinary camera instead looks plausible and is wrong: the walls
stop meeting the edges of the screen.

A consequence worth knowing: a still screenshot taken with the head off to one side looks stretched. It is
only right from where the head was.

## Skins

A skin is everything behind the glass, and the shell asks only this of it:

```js
new Skin(scene, renderer, { width, height }, { camera, lowPower, mode })  // the window is width x height metres at z = 0; build behind it (-z), in metres
skin.step(dt, time, eye)   // eye: the viewer's eye in the window's frame, metres
skin.update(renderer)   // optional: work to do before each frame is drawn (light probes)
skin.look               // optional: { ao: { radius, intensity }, bloom: { strength, radius, threshold }, exposure, vignette }
skin.cycleMode()        // optional: a mood toggle the menu shows as "Lighting"
skin.knock()            // optional: the scene was clicked
skin.trigger(name)      // optional: start one of its random events
skin.dispose()          // the window was resized
```

The Test Box is sized from the window, so its open face is exactly the screen. What is in it is there to
give the eye depth to measure: a ruled grid on every wall, things hung at six depths, shadows that pin each
to a wall, and one ball on a rod that comes out through the glass.

## The office

A room box, the kind a miniaturist builds: the screen is its fourth wall, 3 m of ceiling in the height of
the window and 4 m deep, so on a 27-inch display it is a 1:9 model about 45 cm deep. It is a corner office:
the back-left corner is cut off by a wall at 45 degrees with the door in it, so the door's frosted glass
half-faces you. The pinboard and the window are on the back wall, the desk in front of the window, the
filing cabinets on the left, the bookcase and the safe on the right. (`js/noirparts.js` builds it,
`js/noirprint.js` paints everything flat, `js/noirstory.js` is the story and has no three.js in it.)

### The story

Nobody is ever in the room while you watch. A night lasts two and a half minutes; then the day between is
run through in sixteen seconds (the sun's stripes sweep the floor, the clock's hands spin, and the room is
rearranged in the dark before dawn), and the next night begins with one line of caption. `L` goes straight
on to the next night. Four nights, then Monday again:

| Night | What the room shows | What happens |
|---|---|---|
| Monday, **The Client** | An empty board with the city's map on it; no coat on the stand | The telephone rings out. A woman in a wide hat comes to the door, knocks, waits, and pushes an envelope under it. |
| Tuesday, **The Trail** | The front page stood against the typewriter: JEWELLER VANISHES. The board begun: the jeweller, his shop, a pawn ticket, string to the map, WHO GAINS? Quill's coat and hat on the stand, a cigarette still going | Across the street a window lights up with somebody in it, and the binoculars catch the light. A heavy man in a bowler tries the door handle. |
| Wednesday, **The Warning** | Turned over: drawers out, paper across the floor, the visitor's chair on its side, a bullet hole in the door glass, and DROP IT knifed to the front of the desk. The board has grown: the man in the bowler, the hotel, the sapphire, an insurance policy in the wife's name | Lightning. The telephone rings seven times. The man in the bowler stands at the door for a while, then goes. |
| Thursday, **The Answer** | Every string on the board now ends at the client's photograph, ringed in red: "she hired me to look everywhere else". FINCH FOUND ALIVE. A folder stamped CASE CLOSED. The safe stands open with the sapphire in it. The hole in the glass is taped | A patrol car's lights turn in the street. Two officers walk her past the door. The rain stops. |

Things that happen on any night: the hotel sign across the street goes on and off and its E is failing, the
elevated train passes with its windows lit, somebody walks down the corridor, a mouse comes out of the
skirting to the waste bin (move your head fast and it bolts), a moth finds the lamp.

### What is in it

- **The door**: its pane is a painting redone whenever somebody stands behind it: the corridor's light, the
  lettering (painted on the far side, so it reads backwards from in here), and each visitor as a shadow that
  grows sharper and darker as they come up to the glass. The leaf rattles on its hinge when it is knocked.
- **The window**: a sash window in a 25 cm reveal behind a venetian blind of thirty-nine slats on two tapes,
  three of them bent where somebody keeps parting them to look down at the street. Outside: the brick front
  of the hotel 9 m away with its lit rooms and its sign, the train's track between, and rain.
- **The pinboard** is one painting per night, 1.2 pixels to the millimetre of the room: cork, photographs,
  clippings, notes, pins, and string with the shadow it throws.
- **The desk**: a banker's lamp, a typewriter with a sheet in it, a telephone whose handset jumps when it
  rings, a brass nameplate, an ashtray, and what each night leaves on it.
- **The rest**: two filing cabinets with every drawer its own, a bookcase full of books and box
  files, a safe standing cornerwise with a brass dial, a cast-iron radiator, a swivel chair left as it
  stopped turning, a coat stand that has a coat on it when Quill has been in, a ceiling fan, a wall clock
  that keeps the story's time, a calendar that turns a page a night, a framed licence, a rug, a waste bin,
  an umbrella stand, skirting, dado, chair rail and cornice on every wall.

### How it is lit

- **The street** is one spot lamp outside the window with a 2048 shadow map, shining in through the blinds:
  the stripes across the floor are real shadows of the slats. Its colour is whatever is out there at the
  moment: the street lamp's blue-white, the sign's red while it is lit, lightning, a patrol car, the train's
  windows. Between nights the same lamp is the sun and is carried across the sky.
- **The desk lamp** is a warm spot under the green shade, with a shadow map. A click switches it and the picture light over the board off and on.
- **The corridor's light** through the door's pane is a third spot with a shadow map, so the filing cabinets
  and the coat stand shadow the floor behind them. The picture light over the board has none (nothing
  stands between it and the board), and the sapphire's is a cone aimed out through the safe's doorway, so
  it cannot shine through the steel. The lamps' glowing parts are kept out of the reflection cube: a
  reflection from the cube is not shadowed by furniture, and each has a real lamp for its highlight.
  Everything else is the computer's: the probe volume for bounced light, the corrected
  reflection cube, ambient occlusion, bloom.
- **A thing learned.** three.js stops the inverse-square law at 10 cm: it clamps the squared distance at
  0.01. That is right for rooms in metres and wrong for a room 30 cm tall, where every lamp within a metre
  of the miniature lit as if it were a metre away and the desk lamp threw no pool at all. The office's
  materials replace that clamp (3 mm).

### Limits

- Things lying flat on the desk are seen nearly edge-on, because your eye is level with the middle of the
  room. Everything the story needs you to read is on a wall or stood up.
- The people are shadows on a pane. There is nobody to model, and the story is written so that there need
  not be.
- No sound. A telephone that rings silently is a handset that jumps.
- During the sixteen seconds of daylight a hairline of sun still gets in along the top of the right-hand
  wall (the shadow map's bias against a coincident edge).

## The computer

A mid-tower's main chamber seen through its left side panel, so the rear of the case is on the left. It is
built in metres at the real parts' sizes (`js/pcparts.js`) and scaled to fill the window's height: real size
on a display about 31 cm tall, 8% over on a 27-inch one.

- **The motherboard** is full-size ATX. The board itself is painted at load, ten pixels to the millimetre
  (`js/pcboard.js`): matte black solder mask, some 250 routed bundles of traces with mitred 45-degree bends
  (the memory bus with its length-matching serpentines, differential pairs down to the slots, fat power
  traces from the regulators), 1,400 vias, a few hundred painted chip resistors and capacitors and small ICs
  with laser marking, tinned mounting holes and white silkscreen. A normal map made from a height map painted
  alongside lifts each trace its real 35 microns, so a raking light picks them out. Everything taller than
  half a millimetre is geometry: the regulator heatsinks with milled fins, rows of polymer capacitors and
  chokes, four DIMM slots, armoured expansion slots, M.2 and chipset heatsinks, power and SATA connectors,
  pin headers with every pin, the clock battery.
- **The tower cooler** has a nickel cold plate, six heat pipes that run up through sixty aluminium fins and
  end in caps above the top plate, and a 120 mm fan clipped to its side.
- **The memory** is four sticks in aluminium jackets with a light bar along the top of each.
- **The graphics card** is a 2.75-slot, 30 cm card standing out of its slot: a printed backplate, a stack of
  130 fins you look into edge-on, three fans underneath (lean down to see them), a lit name along the
  edge that faces you, and a strip under it that lights the shroud below.
- **Fans**: rear, two front, two top, each a frame with a duct, four struts, a nine-blade swept and twisted
  rotor and a light ring. They turn at about 50 rpm. A real fan turns ten times faster, which at 60 frames
  a second is either a blur or a strobe; slow, you can watch the blades.
- **Cables** are individually sleeved wires: the 24-pin as a 12 x 2 ribbon into a rubber grommet, the 8-pin
  processor lead, and two 8-pin leads from the graphics card down through the shroud.
- The names printed on things are invented.

### The mood

It is dark in there. The case's own strip is a failing tube: it gives a little cold light and stutters now
and then. Most of what you see is lit by the LEDs' colour and its bounce, the room outside the glass is
moonlit, and the corners of the picture fall away. In Dread the LEDs beat, twice to the bar, about forty
times a minute. Work Light turns the strip up so the build can be looked at.

### What goes on in there

Always (`js/pclife.js`): dust drifting on the fans' air from the front intake to the rear, lit by whichever
lamp it is passing; the motherboard's two-digit debug display reading the processor's temperature; the
drive-activity light flickering by the front-panel header.

Now and then, each on its own random timer (the first of each within half a minute to five minutes, then every two to nine):

| Event | What happens |
|---|---|
| `crawl` | A black widow comes out of the lower cable grommet, walks about the tray and over a drive's label, and goes back in. Her feet stay where she plants them until she has walked past them. |
| `descend` | She lets herself down on a thread just behind the glass, in front of the lit memory, hangs there turning (the red hourglass is on her underside, which is the side she shows), and climbs back up. |
| `eyes` | Something in that grommet opens its eyes. They follow your head. |
| `sag` | The power sags: the lights stutter and go out, the fans coast down, and after two seconds of dark it all comes back with the fans racing and the display running through boot codes. Sometimes the eyes are open in the dark. |
| `code` | The debug display stops showing a temperature and says something else, twice. |
| `morse` | The drive light stops flickering and starts spelling. |

The head is the cursor here, so the three verbs are the head's. **Move fast** and the spider freezes (on her
thread she draws her legs in) and the eyes shut. **Lean in** closer than about 40 cm and the eyes will not
open. **Click** (a knock on the glass) and whatever is out bolts for where it came from, and the strip
stutters.

### How it is lit

- **Every glow is a lamp.** The case's white strip (two lamps along it), the memory's light bars and the strip
  under the graphics card are real lights with shadow maps, so they throw shadows and highlights that move as
  your head does. The scene is still (only fan blades turn, and they cast nothing), so each shadow map is
  drawn once.
- **Bounced light** (`js/gi.js`). three.js lights a surface only with light straight from a lamp, which in a
  closed box is most of the way to wrong. So a grid of light probes fills the chamber (about 250 of them, 5 cm
  apart). At each the scene is rendered into a small cube map and reduced to order-1 spherical harmonics, in
  a 3D texture that every surface reads its indirect light from. The probes see surfaces lit by the lamps and
  by the volume as it stood a moment ago, so each pass round the grid adds a bounce and it converges on the
  multi-bounce answer. Two probes are redone every frame, for ever, so when the LEDs change colour the
  bounced light follows within a second or two. The fan rings, the card's name and the board's accent strips
  have no lamp: the probes see them glowing, and that is their light.
- **Reflections** (`js/gi.js`). A cube map of the chamber, one face redrawn each frame, with mip levels standing
  in for roughness. The lookup is corrected for parallax against the chamber's own walls, so a reflection on
  brushed aluminium slides as your head moves, and it is held down where the probes say little light
  arrives, so a bright wall does not shine out of a crevice.
- **The room.** Outside the glass is a room with a window in it, which only the probes and the reflections
  see. Each lighting mode multiplies it by a colour (moonlight, in all but Work Light). It is all that lights
  the chamber when the LEDs are off and is what the polished parts facing you reflect.
- **Contact shadows** (`js/post.js`). Ground-truth ambient occlusion in screen space, at half resolution,
  darkens the creases the lamps and probes are too coarse for. Then bloom on whatever glows, and ACES.

What this is not: it is not path tracing. The bounced light is smooth (a probe every 5 cm cannot shadow a
capacitor), the lamps are points, so their shadows have hard edges where a real strip's would be soft, and
the reflections are of a box, not of the parts in front of one another. The shadow maps are drawn once, so
what moves (the spider, the fan blades) casts no shadow from the lamps; ambient occlusion is what sits the
spider on the tray.

### Materials

Fourteen scanned sets from ambientCG (CC0), fetched by `tools/fetch.mjs` and listed with their sources in
`html/assets/manifest.json`. The computer's are tiled 2 to 30 cm to the repeat, because this is a small world: on a 4K
display 60 cm wide a surface at the glass gets 6,400 pixels a metre, six times Hangar's budget.

| Key | Asset | Used for | Licence | Source |
|---|---|---|---|---|
| `aluminium` | Metal 011 | heatsinks, memory jackets, the backplate, fins | CC0 | https://ambientcg.com/a/Metal011 |
| `paint` | Metal 027 | the case: powder-coated steel | CC0 | https://ambientcg.com/a/Metal027 |
| `plastic` | Plastic 006 | fan frames and blades, shrouds | CC0 | https://ambientcg.com/a/Plastic006 |
| `mesh` | Sheet Metal 001 | perforated panels | CC0 | https://ambientcg.com/a/SheetMetal001 |
| `weave` | Fabric 004 | cable sleeving | CC0 | https://ambientcg.com/a/Fabric004 |
| `rubber` | Rubber 004 | grommets | CC0 | https://ambientcg.com/a/Rubber004 |
| `floor` | Wood Floor 051 | the office floor | CC0 | https://ambientcg.com/a/WoodFloor051 |
| `wood` | Wood 049 | the desk, the door, the chairs, the mouldings | CC0 | https://ambientcg.com/a/Wood049 |
| `woodLight` | Wood 051 | the bookcase, the window frame, panels | CC0 | https://ambientcg.com/a/Wood051 |
| `plaster` | Painted Plaster 017 | the office walls, dado and ceiling | CC0 | https://ambientcg.com/a/PaintedPlaster017 |
| `leather` | Leather 037 | the swivel chair, the blotter | CC0 | https://ambientcg.com/a/Leather037 |
| `cloth` | Fabric 026 | the coat, the hats | CC0 | https://ambientcg.com/a/Fabric026 |
| `carpet` | Carpet 016 | the rug | CC0 | https://ambientcg.com/a/Carpet016 |
| `paper` | Paper 001 | files, loose sheets, money | CC0 | https://ambientcg.com/a/Paper001 |

The office also uses `paint` (the filing cabinets, the safe, the radiator, the blinds).

Author: ambientCG (Lennart Demes); as in Hangar, that credit is an assumption about who makes ambientCG's
assets, not a field from its API. The circuit board, the labels and the room are painted in code.

## Frame rate

Hangar's rule was that the frame rate gives way before the resolution. Here the picture is steered by your
own head, and one that lags or stutters stops reading as a window. So `js/governor.js` does it the other way
round: it holds 60 frames a second by drawing fewer pixels (100, 80, 65, then 50% of native each way; the
canvas still fills the window and keeps 4x MSAA), and only if half is not enough settles for a steady 30. It
only steps down; a resize or a change of scene starts again from the top. **Full Resolution** in the menu
turns that off: the pixels stay and the frame rate gives. The Readout shows what is being drawn.

## What has and has not been checked

- `node --test 'diorama/tests/*.test.mjs'` (Node 22 or newer; 31 tests): the window's corners land on the screen's
  corners for any eye; a point in the plane of the glass does not move; things behind it follow the head and
  things in front move against it; a head put at a known place is recovered from synthetic landmarks, at
  the centre, 30 degrees off the lens's axis and with the head turned; a blink changes neither the distance
  nor what was learned; the focal length moves the distance but not the sideways position; the picture's
  left is the viewer's right; the window's size in metres; the filter's steadiness and lag.
- In a browser, with a photograph fed to the tracker as a fake camera: the model loads and runs at the
  stream's 30 Hz, a face moved to the picture's left moves the eye right, up moves it up, a face two-thirds
  the size reads half as far again (40 to 60 cm), the eye span is learned from the irises, Calibrate puts
  the eye at (0, 0, 60 cm) and leaves sideways distances as they were, and a lost face lets the view drift
  home. With the face painted out of the photograph the backup took over on the next frame and followed
  the head sideways within 2 cm of where the face tracker had put it (distance within 4 cm). A blink cannot be tested with a photograph: that is covered by the node test, with synthetic lids.
- The computer, in a browser at 1400 x 788 with the eye pinned from the console: the centred view, views from
  the upper right and lower left, close-ups at a 4K display's pixel density, every lighting mode including
  Off, switching scenes, and three rebuilds without a leaked texture or geometry. No shader errors.
- The office, in a browser at 1400 x 788 and 1600 x 900 with the eye pinned from the console: each of the
  four nights and the day between looked at; the pinboard, the door with a visitor at it and the safe at
  three to four times magnification; the whole cycle of four nights run through at thirty steps a second
  with every beat and caption counted (the envelope arrives, the door rattles); the lamp's chain, the mouse,
  the moth and the train started by hand; two rebuilds and a round of the three scenes without a leaked
  texture or geometry. No shader errors. `noirstory.js` has seven node tests of its own.
  **Not checked:** any of it with a real head in front of a real display; whether two and a half minutes a
  night is the right length to live with; the frame rate, which was not measured for this scene at all (it
  has one 2048 and one 1024 shadow map where the computer has two cube maps, so it should cost less, but
  that is an expectation, not a measurement).
- What goes on in there, the same way: each event started from the console and looked at (the spider on the
  tray and on her thread at nine times magnification, the eyes, the display reading `HE`, the dark of a power
  sag and the recovery from it); a knock sends the spider home and up her thread; the eyes shut when the eye
  is put 30 cm from the glass; twenty minutes of simulated time with every timer running, without an error.
  **Not checked:** how any of it reads in motion at 60 fps on a real display, whether the dark modes are too
  dark or the heartbeat too insistent in a lit room, and the Morse (its timing was not decoded by eye).
- **Not measured reliably: the computer's frame time.** On this M3 at 3840 x 2160 a frame took about 50 ms
  (the main pass 37, ambient occlusion 7, bloom 6), which is 20 frames a second at full resolution, and the
  governor walked it down to 1920 x 1080. But those numbers were taken while another browser on the same
  machine had this page open with the webcam running, so they are pessimistic by an unknown amount. The cost
  is pixels (lamps, MSAA, full-screen passes), not geometry: a depth pre-pass was tried and made it slower.
- **Not checked: a real head turning to profile or leaving the edge of a real camera's view.** A photograph
  cannot turn; the backup's behaviour there rests on the pose model and on the node tests' synthetic
  profiles.
- **Not checked: a real webcam with a real person in front of it.** The automated browser has no camera.
  How steady it feels, how much it lags, and whether the default field of view (62 degrees before
  calibration) is near enough for a first look are for the owner to judge.

## Limits of the proof of concept

- One viewer: the picture can only be right for one pair of eyes, and it is drawn for the point between them
  (no stereo, so the depth comes from motion, not from the two eyes disagreeing).
- The lens is assumed to sit on top of the display the page is on and to look straight out. A laptop lid
  tilted back, or a camera on a different monitor, puts an error on the position that Calibrate removes at
  the calibrated spot and mostly removes elsewhere.
- Tracking runs on the main thread at the camera's frame rate, so the view is a camera frame or two behind
  the head. There is no prediction yet. While the backup has the viewer both models run on every frame, and
  the tracking rate fell from 30 to about 20 a second on an M3.
- The backup is cruder than the face tracker: a few centimetres off, more when the shoulders are out of view.
- The glass's size depends on the Display Size setting; browsers do not report a monitor's real size.

## Credits

Tracking: MediaPipe Face Landmarker and Pose Landmarker (lite) (`@mediapipe/tasks-vision` 0.10.14 from
jsDelivr, models from Google's `mediapipe-models` bucket), Apache 2.0. The method: Robert Kooima, *Generalized Perspective
Projection* (2008); Johnny Chung Lee, *Head Tracking for Desktop VR Displays using the Wii Remote* (2007);
Casiez, Roussel and Vogel, *1 Euro Filter* (CHI 2012).
