# Interactive Backgrounds

Animated backgrounds that react to the mouse. Each one has its own folder, with a native app and/or a
static web page.

| Background | macOS app | Web page |
|---|---|---|
| [Fishbowl](fishbowl/) — a 3D aquarium whose fish school, flee a fast cursor, inspect a resting one and race for food | [`fishbowl/swift`](fishbowl/swift) | [`fishbowl/html`](fishbowl/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/fishbowl/html/) |
| [Firefly Meadow](meadow/) — a 3D meadow at night whose grass parts around the cursor and whose fireflies scatter, gather and fall into step with it | [`meadow/swift`](meadow/swift) | [`meadow/html`](meadow/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/meadow/html/) |
| [Balloon Dawn](balloons/) — a 3D hot-air balloon fiesta over a misty valley at sunrise; the cursor is the wind, a click fires a burner, and at night the balloons glow like lanterns | [`balloons/swift`](balloons/swift) | [`balloons/html`](balloons/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/balloons/html/) |
| [Loon Lake](lake/) — a 3D mountain lake at dusk, reflected in simulated water; your fingertip stirs the surface, trout and dragonflies come to it when it rests, a click skips a stone, and at night the moon and the Milky Way lie on the lake | [`lake/swift`](lake/swift) | [`lake/html`](lake/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/lake/html/) |
| [Boreal Night](boreal/) — a snowy spruce clearing under the aurora; a great grey owl watches a resting cursor and plunges into the snow for the vole you click, and a fast cursor shakes snow from the trees | [`boreal/swift`](boreal/swift) | [`boreal/html`](boreal/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/boreal/html/) |
| [Aspen Snow](aspen/) — a quaking-aspen grove in falling snow, at eye level among the trunks; snowshoe hares come to look at a resting cursor and bolt from a fast one, a click on the snow flushes a ruffed grouse from its snow roost, and a click on a trunk brings its snow down in a cascade | [`aspen/swift`](aspen/swift) | [`aspen/html`](aspen/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/aspen/html/) |
| [Sandstone Arch](arch/) — a natural bridge over a still lake at night under the aurora, with a weathered craft exploring the canyon beneath it; a fingertip stirs the water, a click tosses a stone or rouses the craft, the craft turns its red eye on a resting cursor, and rain mode brings a storm sky with lightning | [`arch/swift`](arch/swift) | [`arch/html`](arch/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/arch/html/) |
| [Hangar](hangar/) — a walkable remaster of Doom's E1M1 on Phobos, in scanned PBR materials; a camera strolls the base on its own (stairs, the zigzag walkway over the glowing slime, the computer-room window onto Mars, the courtyard), doors slide open ahead of it, a resting cursor draws its gaze, a click sends it somewhere or works a door, and Emergency Power drops the lights to red | web only | [`hangar/html`](hangar/html) · [live](https://zeblawrence.github.io/interactive-backgrounds/hangar/html/) |

The web pages are served by GitHub Pages straight from this repository (no build step):
`https://zeblawrence.github.io/interactive-backgrounds/<background>/html/`.

Every background with a night sky (all but Fishbowl) shares one real sky, `assets/sky/realsky.js`:
NASA's photographic Milky Way and the Hipparcos catalogue of 118,218 stars, standing at each
scene's own latitude and turning about the celestial pole once a sidereal day, 15 degrees an hour,
the way the sky really turns over an evening. It is progressive — each scene keeps its own painted
sky until the files land, and keeps it for good if they never do.
The macOS apps draw the same sky with `assets/sky/RealSky.swift`, a Swift port of it copied into
each app, at the same latitude, north and hour. Their `build.sh` transcodes Hangar's Milky Way map to
ASTC, which Apple GPUs sample directly (`assets/sky/tools/prepare-macos.sh`: it needs Node and a
network connection the first time, and keeps the result in the git-ignored `assets/sky/build/`), and
bundles it with the star catalogue; an app built without them keeps its painted sky.

Building a new one? Read [guidelines.md](guidelines.md) first: the quality bar, the conventions, and the
traps the existing backgrounds fell into.
