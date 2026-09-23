# Fishbowl

An animated 3D aquarium wallpaper for macOS. The fish swim, school, and react to your cursor, and your desktop icons and windows stay on top as usual.

- **Move the mouse fast** near fish and they dart out of its path and retreat deeper into the tank.
- **Rest the cursor** and curious fish swim right up to the glass and turn to look at it.
- **Click empty desktop** to drop food; fish race to eat it.
- Seaweed sways and gets pushed around by the "current" from your cursor.

Built natively with Swift + SceneKit: a real 3D scene with sunlight and shadows, image-based
reflections, fog for depth, animated caustics, HDR bloom and 4x MSAA. It uses roughly 28% of one CPU
core at 60 fps on an Apple Silicon laptop; Low Power mode (30 fps, no MSAA) uses about 15%.
Everything (fish models, textures, plants, rocks, sand) is generated procedurally; there are no assets.

## Build & run

Requires macOS 14+ and the Xcode command line tools.

```sh
./build.sh             # builds build/Fishbowl.app
open build/Fishbowl.app
./build.sh --install   # or: copy to /Applications and launch
```

Control it from the fish icon in the menu bar: feed, add or remove fish, refill the tank, toggle click-to-feed, Low Power mode, Launch at Login, and Quit.

Developer flags:

```sh
swift run Fishbowl --preview                # run in a normal window instead of the desktop
swift run Fishbowl --snapshot out.png --at 6   # render a frame with a simulated cursor and exit
```

## How it works

- `WallpaperWindow` is a borderless, click-through window at `kCGDesktopWindowLevel + 1`: above the
  system wallpaper, below Finder's desktop icons. It joins all Spaces and stays put in Mission Control.
- `Tank` builds the 3D scene. 1 world unit = 100 screen points; the front glass is the plane z = 0 and
  exactly fills the screen, so a cursor position maps straight to a point on the glass and a ray into the tank.
- `RenderView` renders with `SCNRenderer` into a `CAMetalLayer`, once per simulation step. (`SCNView`
  ignores its frame-rate setting and renders at 120 Hz on ProMotion displays.)
- `FishModel` lofts each species' side-view outline into a 3D body, with the painted skin projected onto
  its flanks, fins/tail on one atlas-textured mesh and glossy eyes: three draw calls per fish.
- `Shaders` holds the SceneKit shader modifiers: the swimming body wave, seaweed sway (including the
  current stirred up by the cursor), caustics and the water surface. Shader time wraps hourly and every
  animation frequency is quantised to that period, so animation stays smooth however long it runs.
- `Fish` uses 3D steering behaviours (wander, separation, schooling, startle/flee, curiosity, food seeking).
  Its tail-beat phase runs on the GPU; the CPU only updates it when the rhythm changes, because setting
  shader values every frame is expensive in SceneKit.
- The cursor is polled each frame with `NSEvent.mouseLocation`, so no Accessibility permission is needed.
- Click-to-feed uses a global mouse monitor, plus a `CGWindowList` hit test so clicks on windows don't count.
