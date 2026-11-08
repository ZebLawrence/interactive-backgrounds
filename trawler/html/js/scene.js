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
import { Sky, loadStars } from './sky.js';
import { Weather } from './seastate.js';
import { Ocean } from './ocean.js';
import { Boat, HULL } from './boat.js';
import { ORIGIN_STEP } from './oceanspec.js';
import { buildPost, textureMemory } from './post.js';

// Where the eye sits in the pilot house, in the boat's own frame: the wheelhouse deck is 4 m above
// the waterline and a standing helmsman's eye is 1.6 m above that, a little abaft the windscreen.
export const EYE = HULL.eye;
export const FOV = 62;
// How far the cursor can swing the gaze. 115 degrees reaches the side windows and the aft bulkhead.
export const GAZE = { yaw: 115 * DEG, pitch: 28 * DEG, tau: 0.42 };
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
export const EXPOSURE = { key: 0.9, power: 0.62, min: 0.80, max: 1000, tau: 3.5 };

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
    this.gaze = { yaw: 0, pitch: -0.03, targetYaw: 0, targetPitch: -0.03 };
    // Base heading of the body (the boat's yaw once boat.js exists).
    this.heading = 0;
    this.pointerHeld = { x: -10000, y: -10000, inside: false, still: 0, moved: false };

    this.weather = new Weather(this.rng.fork('weather'), settings.startSea ?? null);
    this.pushWeather();
    this.sky = new Sky(this.scene, renderer, this.rng.fork('sky'), {
      dayTime: settings.startTime ?? 0.28,
    });
    this.ocean = new Ocean(this.scene, renderer, this.rng.fork('ocean'), this.weather);
    this.boat = new Boat(this.ocean, this.rng.fork('boat'));
    // The render origin. The boat covers hundreds of kilometres in a day, which would eventually
    // eat the precision of a 32-bit world position, so the whole scene is drawn about an origin
    // that follows her in 2048 m steps. Every cascade size divides that, so the sea does not
    // notice; the cloud field and the land add it back (G.uWorldOrigin).
    this.origin = v3();
    this.headRoll = 0;
    this.headPitch = 0;
    this.eyePos = v3();
    this.bodyMatrix = new THREE.Matrix4();
    // The star catalogue arrives after the first frames; the sky adds it when it does.
    this.ready = loadStars().then((cat) => {
      if (this.disposed || !cat) return;
      this.sky.buildStars(cat);
      this.sky.applyLights();
    });

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

  /** Eases the exposure toward what the sky asks for. `snap` jumps straight there (a mode change). */
  stepExposure(dt, snap = false) {
    const want = targetExposure(G.uSkyLight.value.y, G.uSunColor.value.y);
    this.exposure = snap ? want : approach(this.exposure, want, EXPOSURE.tau, dt);
    this.applyExposure();
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
      this.gaze.targetYaw = -ease(nx) * GAZE.yaw;
      this.gaze.targetPitch = ease(ny) * GAZE.pitch;
    } else {
      this.gaze.targetYaw *= Math.exp(-dt / 2.5);
      this.gaze.targetPitch = approach(this.gaze.targetPitch, -0.03, 2.5, dt);
    }
    this.gaze.yaw = approachAngle(this.gaze.yaw, this.gaze.targetYaw, GAZE.tau, dt);
    this.gaze.pitch = approach(this.gaze.pitch, this.gaze.targetPitch, GAZE.tau, dt);
  }

  /** True when the cursor travelled and then held still: the "resting cursor" verb. */
  get resting() { return this.pointerHeld.inside && this.pointerHeld.moved && this.pointerHeld.still > 0.8; }

  /** A click at a screen point. */
  click(point) {
    this.lastClick = { ...point, at: this.time };
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
    this.boat.step(dt);
    this.maintainOrigin();
    this.heading = this.boat.heading;
    this.stepHead(dt);
    this.sky.step(dt, this.camera, { pixelRatio: this.app.pixelRatio });
    this.ocean.step(dt, this.camera, { pixelHeight: this.height * this.app.pixelRatio });
    this.stepExposure(dt);
    this.post.setNight(G.uNight.value);
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
    G.uWorldOrigin.value.set(this.origin.x, this.origin.z);
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
    this.camera.rotation.set(
      this.headPitch + this.gaze.pitch,
      this.boat.heading + this.gaze.yaw,
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
    this.ocean.dispose();
    this.sky.dispose();
    this.post.dispose();
  }
}
