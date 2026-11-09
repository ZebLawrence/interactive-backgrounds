// Trawler — The scene: the camera at the wheel, the subsystems, the frame step and the render.
//
// new Scene(app, renderer, w, h, settings, seed) builds everything; step(dt, pointer, settings)
// advances it and render() draws it. The scene knows nothing about the shell: it is given the
// cursor in screen points, a click point and the screen size (guidelines section 3).
//
// The camera is a person standing at the wheel. Its seat is the boat's rigid-body transform; on top
// of that the head keeps itself partly level (a helmsman's does), lags the motion on a spring, and
// is pointed by the cursor: left and right across the windscreen and out through the side windows,
// up and down between the deckhead and the foredeck.

import * as THREE from 'three';
import { G, LAYER } from './shaders.js';
import { Rng, DEG, TAU, clamp, clamp01, lerp, smoothstep, approach, approachAngle, v3, TIME_WRAP } from './util.js';
import { Sky, loadRealSky } from './sky.js';
import { Weather } from './seastate.js';
import { Ocean } from './ocean.js';
import { Boat, HULL } from './boat.js';
import { ORIGIN_STEP } from './oceanspec.js';
import { Materials } from './materials.js';
import { PilotHouse, HOUSE } from './pilot.js';
import { Instruments } from './instruments.js';
import { Deck } from './deck.js';
import { Glazing, PANE } from './glass.js';
import { Terrain, LAND } from './terrain.js';
import { Pilot, buildChart, NAV } from './nav.js';
import { WakeField, Spray } from './wake.js';
import { Gulls, Porpoises, Rain, SeaMarks } from './wildlife.js';
import { loadManifest, loadAssets } from './assets.js';
import { buildPost, textureMemory } from './post.js';

// Where the eye sits in the pilot house, in the boat's own frame: the wheelhouse deck is 4 m above
// the waterline and a standing helmsman's eye is 1.6 m above that, a little abaft the windscreen.
export const EYE = HULL.eye;
export const FOV = 62;
// How far the cursor can swing the gaze. 115 degrees reaches the side windows and the aft bulkhead.
export const GAZE = {
  yaw: 115 * DEG,
  pitch: 28 * DEG,
  tau: 0.42,
  // Where the gaze sits with the cursor in the middle of the window: three degrees down, which
  // puts the horizon above centre and the bow in the lower third.
  rest: -3 * DEG,
};
// A helmsman does not ride the boat like a camera bolted to the deck. He keeps his head most of the
// way level and his legs take the rest, and what is left lags the hull by a fraction of a second.
// Without this the view is unwatchable in anything above a calm; with too much of it the boat stops
// feeling like a boat, so about a third of the roll and half the pitch are left in.
export const HEAD = { keepRoll: 0.34, keepPitch: 0.52, lag: 0.14, swayLag: 0.22 };

// Adaptation. The scene is lit in physical units, so a correct twilight is about forty times
// dimmer than noon and a moonless night a thousand times: rendered at a fixed exposure the screen
// simply goes black, which is true and useless. The eye adapts, so the camera does too. The target
// follows the sky's own irradiance on a power law (a stop of light buys about two thirds of a stop
// of exposure, which is roughly how human adaptation behaves), and it eases over a few seconds so
// a cloud crossing the sun does not pump the picture.
// `key` is where the meter is pointed. This camera never leaves the wheelhouse, and a camera
// inside a room looking out does not expose for the view: it opens up for what is around it and
// lets the windows go bright. That is why the owner's reference photograph has honey-coloured
// joinery and water you cannot see into. Metering for the open sky instead - which is what this
// did - is also true, and gives a black cabin behind a perfect sea.
//
// So the key is lifted by the stop and a half that choice is worth. Measured at noon with it: the
// joinery reads 128 of 255 against the sea's 236, which is the reference's own relationship; the
// sea keeps its texture rather than going flat white, and nothing else in the scene changes shape
// because every emissive thing is divided by this same number.
export const EXPOSURE = { key: 2.5, power: 0.62, min: 0.80, max: 1000, tau: 3.5 };

/** The exposure the current sky asks for. Pure, so the night test can assert on it. */
export function targetExposure(skyIrradianceY, sunIrradianceY) {
  const L = Math.max(skyIrradianceY + 0.045 * sunIrradianceY, 1e-5);
  return clamp(Math.pow(EXPOSURE.key / L, EXPOSURE.power), EXPOSURE.min, EXPOSURE.max);
}

export class Scene {
  constructor(app, renderer, w, h, settings, seed) {
    this.app = app;
    this.renderer = renderer;
    this.width = w;
    this.height = h;
    this.settings = settings;
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.time = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.06, 42000);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(EYE.x, EYE.y, EYE.z);
    this.camera.layers.enable(LAYER.WORLD);
    this.camera.layers.enable(LAYER.INTERIOR);
    this.camera.layers.enable(LAYER.SKYONLY);
    this.scene.add(this.camera);

    // The gaze: where the cursor is asking the head to look, and where it has got to.
    this.gaze = { yaw: 0, pitch: GAZE.rest, targetYaw: 0, targetPitch: GAZE.rest };
    // Base heading of the body (the boat's yaw once boat.js exists).
    this.heading = 0;
    this.pointerHeld = { x: -10000, y: -10000, inside: false, still: 0, moved: false };

    this.weather = new Weather(this.rng.fork('weather'), settings.startSea ?? null);
    this.pushWeather();
    this.sky = new Sky(this.scene, renderer, this.rng.fork('sky'), {
      dayTime: settings.startTime ?? 0.28,
    });
    this.ocean = new Ocean(this.scene, renderer, this.rng.fork('ocean'), this.weather);
    this.terrain = new Terrain(this.scene, renderer, this.materials ?? null, this.rng.fork('land'));
    this.ocean.useTerrain(this.terrain);
    this.boat = new Boat(this.ocean, this.rng.fork('boat'));
    this.findSeaRoom();
    this.autopilot = new Pilot(this.rng.fork('pilot'));
    this.refreshChart();
    this.wake = new WakeField(renderer);
    this.spray = new Spray(this.scene, this.rng.fork('spray'));
    this.ocean.useWake(this.wake);
    this.gulls = new Gulls(this.scene, this.rng.fork('gulls'), 9);
    this.porpoises = new Porpoises(this.scene, this.rng.fork('porpoises'), 5);
    this.rain = new Rain(this.scene, this.rng.fork('rain'));
    this.marks = new SeaMarks(this.scene, this.rng.fork('marks'));

    // The house she is seen from, the deck she is seen over, and the glass between.
    this.materials = new Materials();
    this.glazing = new Glazing();
    this.pilot = new PilotHouse(this.scene, this.materials, this.rng.fork('house'), this.glazing.material, renderer);
    this.deck = new Deck(this.scene, this.materials, this.rng.fork('deck'));
    this.instruments = new Instruments(this.pilot.group, HOUSE, this.rng.fork('instruments'), this.pilot);
    this.registerPanes();
    // The rain is told where the wheelhouse is so it does not fall through the deckhead. The box
    // reaches out to the glass on every face and no further, so a drop a hand's breadth outside
    // the side window still streaks past.
    this.rain.useHouse(this.pilot.group,
      v3(0, (HOUSE.sole + HOUSE.deckhead) / 2, (HOUSE.front + HOUSE.back) / 2),
      v3(HOUSE.halfWidth - 0.02, (HOUSE.deckhead - HOUSE.sole) / 2, (HOUSE.back - HOUSE.front) / 2));
    // The render origin. The boat covers hundreds of kilometres in a day, which would eventually
    // eat the precision of a 32-bit world position, so the whole scene is drawn about an origin
    // that follows her in 2048 m steps. Every cascade size divides that, so the sea does not
    // notice; the cloud field and the land add it back (G.uWorldOrigin).
    this.origin = v3();
    this.headRoll = 0;
    this.headPitch = 0;
    this.eyePos = v3();
    this.bodyMatrix = new THREE.Matrix4();
    // The catalogue and the Milky Way map arrive after the first frames; the sky adds each as it
    // lands. They are the repository's shared copies, so a visitor who has opened another of these
    // backgrounds already has them.
    this.ready = loadRealSky(renderer).then((real) => {
      if (this.disposed || !real) return;
      this.sky.setRealSky(real);
      this.sky.applyLights();
    });
    this.loadAssets();

    this.post = buildPost(renderer, this.scene, this.camera, w, h, app.pixelRatio, settings.lowPower);
    this.exposure = targetExposure(G.uSkyLight.value.y, G.uSunColor.value.y);
    this.applyExposure();
  }

  /** Pushes the current exposure into the renderer and into the things drawn at a fixed brightness. */
  applyExposure() {
    this.renderer.toneMappingExposure = this.exposure;
    // The stars and the moon's disc are drawn at a chosen screen brightness rather than their true
    // radiance (a real magnitude-6 star against a real night sky is a handful of photons), so they
    // have to be divided back out of the adaptation or they would bloom into discs at night.
    this.sky.setExposure(this.exposure);
  }

  /**
   * Keeps the sun's shadow box on the boat. Everything that casts a shadow here is on her, so the
   * box only has to be as big as she is; the renderer's shadow map is refreshed by hand once a
   * frame rather than on every render call, because a frame is several passes and re-rendering
   * the map for each of them is pure waste (guidelines section 3).
   */
  followShadow() {
    const l = this.sky.sunLight;
    // The house has shadow lights of its own - the sky through the windows, the lamps at night -
    // which schedule their own maps (pilot.js) but need the renderer's pass to run.
    const houseWants = this.pilot?.shadowWanted ?? false;
    if (!l.visible && !houseWants) { this.renderer.shadowMap.needsUpdate = false; return; }
    if (l.visible) {
      const p = this.boat.position;
      l.target.position.set(p.x, p.y + 3, p.z);
      l.target.updateMatrixWorld();
      l.position.set(p.x + this.sky.sunDir.x * 120, p.y + this.sky.sunDir.y * 120 + 3, p.z + this.sky.sunDir.z * 120);
      l.updateMatrixWorld();
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Eases the exposure toward what the sky asks for. `snap` jumps straight there (a mode change). */
  stepExposure(dt, snap = false) {
    const want = targetExposure(G.uSkyLight.value.y, G.uSunColor.value.y);
    this.exposure = snap ? want : approach(this.exposure, want, EXPOSURE.tau, dt);
    this.applyExposure();
  }

  /**
   * Tells the glazing the size and kind of every pane the house built, so the rain and the wipers
   * land in the right place on each one.
   */
  registerPanes() {
    // The house says what each pane is and how big it is, rather than this end counting them: the
    // wheelhouse was rebuilt once already and a hard-coded pane order does not survive that.
    this.pilot.panes.forEach(({ mesh, kind, width, height }, i) => {
      const k = kind === 'DOOR' ? PANE.DOOR
        : kind === 'SIDE' ? PANE.SIDE
          : (i === 1 ? PANE.FRONT_CENTRE : PANE.FRONT_SIDE);
      this.glazing.register(mesh, k, width, height);
    });
  }

  /**
   * Fetches the scanned materials and the props. The house is already standing in plain colours;
   * each scan swaps itself in as it lands, so nothing waits for the whole set.
   */
  async loadAssets() {
    const bar = document.getElementById('loadbar');
    const progress = (f) => {
      if (!bar) return;
      bar.style.transform = `scaleX(${f})`;
      bar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    };
    const { manifest, failures } = await loadManifest();
    if (this.disposed) return;
    this.materials.setManifest(manifest);
    const assets = await loadAssets(this.app.renderer, manifest, progress, {
      // The house first: it is what the viewer is sitting in.
      priority: ['mat:cherry', 'mat:cherry-panel', 'mat:leather-cream', 'mat:enamel',
        'mat:steel-brushed', 'mat:paint-worn', 'mat:deck', 'mat:steel-rust',
        // Then the props that are in the view every moment: the ones out on the foredeck.
        'crate', 'lifebuoy', 'fender', 'jerrycan', 'seamark', 'buoy'],
      onItem: (kind, name, asset) => {
        if (this.disposed) return;
        if (kind === 'material') { this.materials.setAsset(name, asset); this.terrain.setAsset(name, asset); }
        else this.applyModel(name, asset);
      },
    });
    progress(1);
    bar?.classList.add('done');
    this.assets = assets;
    const bad = [...failures, ...assets.failures];
    if (bad.length) console.warn(`Trawler: ${bad.length} asset file(s) missing, using stand-ins:`, bad.join(', '));
  }

  /** A loaded prop goes wherever the house or the deck wants it. */
  applyModel(name, model) {
    this.models ??= new Map();
    this.models.set(name, model);
    this.deck.addProp(name, model);
    this.marks.setModel(name, model);
  }

  // --- input -------------------------------------------------------------------------------------

  /**
   * Turns the cursor's screen position into the gaze target. Screen points, origin bottom left, as
   * the shell reports them. A cursor outside the window lets the gaze drift back to dead ahead.
   */
  aimFromPointer(pointer, dt) {
    const p = this.pointerHeld;
    const moved = pointer.inside && (Math.abs(pointer.x - p.x) > 1.5 || Math.abs(pointer.y - p.y) > 1.5);
    if (moved) { p.still = 0; p.moved = true; } else p.still += dt;
    p.x = pointer.x; p.y = pointer.y; p.inside = pointer.inside;

    if (pointer.inside) {
      // Centre of the window is dead ahead; the edges are the full swing. The response eases out of
      // the middle so small movements near the centre are gentle.
      const nx = clamp((pointer.x / this.width) * 2 - 1, -1, 1);
      const ny = clamp((pointer.y / this.height) * 2 - 1, -1, 1);
      const ease = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.45);
      // Cursor to the right looks to starboard, which is a rising bearing.
      this.gaze.targetYaw = ease(nx) * GAZE.yaw;
      this.gaze.targetPitch = GAZE.rest + ease(ny) * GAZE.pitch;
    } else {
      this.gaze.targetYaw *= Math.exp(-dt / 2.5);
      this.gaze.targetPitch = approach(this.gaze.targetPitch, GAZE.rest, 2.5, dt);
    }
    this.gaze.yaw = approachAngle(this.gaze.yaw, this.gaze.targetYaw, GAZE.tau, dt);
    this.gaze.pitch = approach(this.gaze.pitch, this.gaze.targetPitch, GAZE.tau, dt);
  }

  /** True when the cursor travelled and then held still: the "resting cursor" verb. */
  get resting() { return this.pointerHeld.inside && this.pointerHeld.moved && this.pointerHeld.still > 0.8; }

  /**
   * A click. First it asks the pilot house whether anything in it was hit — a lever, a switch, a
   * screen — and works that; if nothing was, the click goes out through the window and she alters
   * course for whatever was pointed at. The ray is built through the camera's real rotation, so
   * the hit stays under the cursor however far the gaze has swung (guidelines section 3).
   */
  click(point) {
    this.lastClick = { ...point, at: this.time };
    const ndc = new THREE.Vector2(
      (point.x / this.width) * 2 - 1,
      (point.y / this.height) * 2 - 1,
    );
    this.raycaster ??= new THREE.Raycaster();
    this.raycaster.layers.set(LAYER.DEFAULT);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.pilot.pick(this.raycaster);
    if (hit) { this.workControl(hit); return; }
    // Out through the glass: the bearing of whatever she was pointed at.
    const d = this.raycaster.ray.direction;
    const bearing = Math.atan2(d.x, -d.z);
    this.autopilot.steerCourse(bearing, 110);
    this.wheelOrder = bearing;
  }

  /** What each thing in the house does when it is worked. */
  workControl(hit) {
    switch (hit) {
      case 'throttle':
        this.throttleNotch = ((this.throttleNotch ?? 2) + 1) % 4;
        this.autopilot.throttleBias = [0.12, 0.42, 0.68, 0.95][this.throttleNotch];
        this.boat.orderThrottle(this.autopilot.throttleBias);
        break;
      case 'lamp':
        this.lampMode = ((this.lampMode ?? 0) + 1) % 3;
        this.redLight = this.lampMode === 2;
        this.lampsOff = this.lampMode === 0;
        break;
      case 'horn':
        this.hornAt = this.time;
        this.gulls.startle();
        break;
      case 'radar':
        this.instruments.nextRange();
        break;
      case 'wheel':
        // She has the wheel again: whatever course she was handed is let go now.
        this.autopilot.releaseCourse();
        this.wheelOrder = null;
        break;
      case 'wipers':
        this.wipersForced = !this.wipersForced;
        break;
      default:
        break;
    }
  }

  // --- the frame ---------------------------------------------------------------------------------

  step(dt, pointer, settings) {
    this.time += dt;
    G.uTime.value = this.time % TIME_WRAP;
    this.aimFromPointer(pointer, dt);
    this.placeCamera();
    this.camera.updateMatrixWorld();
    this.weather.step(dt);
    this.pushWeather();
    // She steers herself unless the cursor has just told her otherwise.
    this.autopilot.step(dt, this.boat, {
      sea: this.weather.derived.sea,
      windDir: this.weather.windDir,
    }, this.depthAt);
    this.boat.step(dt);
    this.maintainOrigin();
    if (this.terrain.step(dt, this.camera, settings)) this.refreshChart();
    this.heading = this.boat.heading;
    this.stepHead(dt);
    const d = this.weather.derived;
    // Everything that glows is specified as a brightness on the screen rather than a radiance,
    // so it is divided by the exposure the camera has adapted to.
    const emissiveScale = 1 / Math.max(this.exposure, 1e-3);
    this.pilot.update(dt, this.boat, { redLight: this.redLight, lampsOff: this.lampsOff, emissiveScale, wipers: this.wipersForced ?? false });
    this.instruments.step(dt, this.boat, this.depthAt, this.origin, G.uNight.value, emissiveScale);
    this.deck.update(dt, this.boat, { emissiveScale });
    // What a white surface out there is actually reflecting. Anything drawn with a fixed colour
    // rather than a reflectance — the spray, the rain, the glow of the instruments on the glass —
    // has to be multiplied by this, or it stays at its daytime brightness while the camera opens
    // up a thousandfold for the night and goes white.
    this.lit ??= v3();
    this.lit.copy(G.uSkyLight.value)
      .addScaledVector(G.uSunColor.value, Math.max(this.sky.sunDir.y, 0))
      .addScaledVector(G.uMoonColor.value, Math.max(this.sky.moonDir.y, 0))
      .multiplyScalar(0.3183);
    this.cabinLight ??= v3();
    this.cabinLight.set(0.040, 0.031, 0.018).multiplyScalar(emissiveScale);
    this.glazing.update(dt, {
      rain: G.uRain.value,
      spray: d.spray + (this.boat.bowDry ? 0.1 : 0),
      speedKnots: this.boat.speedKnots,
      night: G.uNight.value,
      cabin: this.cabinLight,
      wipers: this.wipersForced ?? false,
    });
    // Spray and rain are water: they show whatever light is falling on them and nothing else.
    this.spray.material.uniforms.uColor.value.set(this.lit.x * 1.5, this.lit.y * 1.55, this.lit.z * 1.6);
    this.rain.material.uniforms.uColor.value.set(this.lit.x * 1.1, this.lit.y * 1.2, this.lit.z * 1.35);
    this.wake.step(dt, this.boat);
    this.ocean.wakeTexture = this.wake.texture;
    this.spray.step(dt, this.boat, this.weather.derived, G.uWind.value, this.app.pixelRatio);
    this.gulls.step(dt, this.boat, this.weather.derived);
    // The second cursor verb: a cursor that travelled and then came to rest brings them over.
    this.porpoises.setInterest(this.resting ? 1 : 0);
    this.porpoises.step(dt, this.boat, this.weather.derived);
    this.rain.step(dt, this.camera, G.uRain.value, G.uWind.value, this.weather.derived.u10);
    this.marks.step(dt, this.boat, this.depthAt, G.uNight.value, emissiveScale, this.ocean.time);
    this.sky.step(dt, this.camera, { pixelRatio: this.app.pixelRatio });
    this.followShadow();
    this.ocean.step(dt, this.camera, { pixelHeight: this.height * this.app.pixelRatio });
    this.stepExposure(dt);
    this.post.setNight(G.uNight.value);
    this.post.setExposure(this.exposure);
  }

  /**
   * Keeps the render origin within one step of the boat, so nothing the shaders see is ever far
   * from zero. Everything in the scene is drawn in this frame; `worldPosition` is the real one.
   */
  maintainOrigin() {
    const p = this.boat.position;
    const dx = Math.abs(p.x) > ORIGIN_STEP ? Math.round(p.x / ORIGIN_STEP) * ORIGIN_STEP : 0;
    const dz = Math.abs(p.z) > ORIGIN_STEP ? Math.round(p.z / ORIGIN_STEP) * ORIGIN_STEP : 0;
    if (dx === 0 && dz === 0) return;
    p.x -= dx;
    p.z -= dz;
    this.origin.x += dx;
    this.origin.z += dz;
    this.marks.shift(dx, dz);
    G.uWorldOrigin.value.set(this.origin.x, this.origin.z);
  }

  /**
   * Puts her somewhere with water under her. The archipelago is generated, so wherever the seed
   * lands her she might be on a hilltop; this bakes the chart, then walks outward from the
   * starting point until it finds somewhere with thirty metres under the keel and sea room all
   * round, which is what a boat picking her way out of a sound would have.
   */
  findSeaRoom() {
    this.terrain.follow({ x: 0, z: 0 });
    const rng = this.rng.fork('start');
    const clear = (x, z) => {
      if (this.terrain.depthAt(x, z) < 30) return false;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * TAU;
        for (const r of [250, 600, 1100]) {
          if (this.terrain.depthAt(x + Math.cos(th) * r, z + Math.sin(th) * r) < 12) return false;
        }
      }
      return true;
    };
    for (let i = 0; i < 400; i++) {
      const r = 200 + i * 28;
      const a = rng.range(0, TAU);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (clear(x, z)) {
        this.boat.position.x = x;
        this.boat.position.z = z;
        this.terrain.follow(this.boat.position);
        return;
      }
    }
    // Nothing found: stay where she is rather than putting her ashore somewhere definite.
  }

  /** The sea bed under a point, as the autopilot and the hull see it. */
  depthAt = (x, z) => this.terrain.depthAt(x, z);

  /** Hands the autopilot a fresh chart centred on the boat. A few milliseconds, done rarely. */
  refreshChart() {
    this.autopilot?.setChart(buildChart(this.depthAt, this.boat.position.x, this.boat.position.z));
  }

  /** Where she really is, in the world the land is generated in. */
  worldPosition(out = v3()) {
    return out.set(this.boat.position.x + this.origin.x, this.boat.position.y, this.boat.position.z + this.origin.z);
  }

  /** Eases the head's share of the hull's roll and pitch. */
  stepHead(dt) {
    const b = this.boat;
    this.headRoll = approach(this.headRoll, b.roll * HEAD.keepRoll, HEAD.lag, dt);
    this.headPitch = approach(this.headPitch, b.pitch * HEAD.keepPitch, HEAD.lag, dt);
    // The eye rides the hull: full translation, because a helmsman's feet are on the deck.
    b.toWorld(EYE.x, EYE.y, EYE.z, this.eyePos);
    G.uBoatPos.value.set(b.position.x, b.position.y, b.position.z);
    G.uBoatYaw.value = b.heading;
  }

  /** Puts the camera where the head is: the boat's seat, plus the gaze. */
  placeCamera() {
    if (this.freeCamera) return; // a debug look() is holding the camera
    this.camera.position.set(this.eyePos.x, this.eyePos.y, this.eyePos.z);
    // three's camera looks down its own -z, so a yaw of -B points it along the bearing B.
    this.camera.rotation.set(
      this.headPitch + this.gaze.pitch,
      -(this.boat.heading + this.gaze.yaw),
      this.headRoll,
    );
  }

  /** Copies what the weather decided into the uniforms and the sky, once a frame. */
  pushWeather() {
    const d = this.weather.derived;
    G.uSea.value = d.sea;
    G.uWindSpeed.value = d.u10;
    G.uWind.value.set(Math.cos(this.weather.windDir), Math.sin(this.weather.windDir));
    G.uHaze.value = d.haze;
    G.uHazeFar.value = d.hazeFar;
    G.uRain.value = this.rainOn ? Math.max(d.rainChance, 0.55) : d.rainChance * 0.6;
    G.uSpray.value = d.spray;
    this.sky?.setCloud(d.cloudCover, d.cloudBase, d.cloudThick, d.cloudDark);
  }

  /** Pins the sea state (eased), or lets the weather drift again with `null`. */
  setSeaTarget(value, snap = false) {
    this.weather.pin(value ?? null);
    if (snap && value !== null && value !== undefined) this.weather.set(value);
    this.pushWeather();
    this.ocean?.rebuildSpectrum();
  }

  setRain(on) { this.rainOn = !!on; this.pushWeather(); }

  setRedLight(on) { this.redLight = !!on; }

  /** Two lines for the ?perf overlay. */
  describe() {
    return `${this.ocean?.describe?.() ?? ''}\n${this.boat?.describe?.() ?? ''}`;
  }

  render() {
    this.post.render();
  }

  resize(w, h, pixelRatio) {
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, pixelRatio);
  }

  setLowPower(on, pixelRatio) {
    this.post.setSize(this.width, this.height, pixelRatio);
  }

  textureBytes() {
    const targets = [this.post.target];
    for (const c of this.ocean?.cascades ?? []) targets.push(c.ping, c.pong, c.maps, c.foam[0], c.foam[1]);
    return textureMemory(this.scene, targets);
  }

  dispose() {
    this.disposed = true;
    G.uWorldOrigin.value.set(0, 0);
    this.terrain.dispose();
    this.wake.dispose();
    this.spray.dispose();
    this.gulls.dispose();
    this.porpoises.dispose();
    this.marks.dispose();
    this.rain.dispose();
    this.instruments.dispose();
    this.pilot.dispose();
    this.deck.dispose();
    this.glazing.dispose();
    this.materials.dispose();
    this.ocean.dispose();
    this.sky.dispose();
    this.post.dispose();
  }
}
