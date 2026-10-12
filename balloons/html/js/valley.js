// Balloon Dawn — The scene: camera, the cursor mapped into the world as wind, dawn-to-night
// blends, the fleet of balloons, and the frame loop.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, smoothstep, v3, unit, quatAxis, TIME_WRAP } from './util.js';
import { G } from './shaders.js';
import { groundHeight, Ground } from './terrain.js';
import { Balloon } from './balloon.js';
import { Sky, Mountains, Mist, SKY_RADIUS } from './sky.js';
import { Flock } from './birds.js';
import { Grass } from './grass.js';

export const DENSITY = { few: 7, normal: 13, many: 22 };

// ---------------------------------------------------------------------------------------------
// The cursor in screen points (y up, origin bottom-left), with smoothed velocity
// ---------------------------------------------------------------------------------------------

export class Cursor {
  constructor() {
    this.screen = { x: -10000, y: -10000 };
    this.present = false;
    this.vel = { dx: 0, dy: 0 };
    this.speed = 0;
    this.stillTime = 0;
  }

  update(p, inside, dt) {
    if (inside && this.present && dt > 0) {
      const vx = (p.x - this.screen.x) / dt, vy = (p.y - this.screen.y) / dt;
      this.vel = { dx: this.vel.dx + (vx - this.vel.dx) * 0.35, dy: this.vel.dy + (vy - this.vel.dy) * 0.35 };
    } else {
      this.vel = { dx: 0, dy: 0 };
    }
    this.present = inside;
    this.screen = { x: p.x, y: p.y };
    this.speed = Math.hypot(this.vel.dx, this.vel.dy);
    this.stillTime = this.speed < 25 ? this.stillTime + dt : 0;
  }
}

// ---------------------------------------------------------------------------------------------
// The valley. Units are metres. The viewer stands on a hill at the origin looking toward -z,
// over a valley floor some fifty metres below, to mountains a few kilometres off.
// ---------------------------------------------------------------------------------------------

const DAWN_FOG = v3(0.78, 0.55, 0.42);
const NIGHT_FOG = v3(0.012, 0.014, 0.03);

export class Valley {
  constructor(app, screenW, screenH, settings) {
    this.app = app;
    this.screenW = screenW;
    this.screenH = screenH;
    this.aspect = screenW / screenH;
    this.fov = 50;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.basePitch = -2 * Math.PI / 180;
    this.groundHeight = groundHeight;
    this.cursor = new Cursor();
    this.clock = 0;
    this.night = settings.nightGlow ? 1 : 0;
    this.gust = { dir: v3(), strength: 0, screen: { x: 0, y: 0 }, speed: 0 };
    this.cameraAngles = new THREE.Vector2();
    this.windPhase = rnd(0, TAU);
    // Ambient gusts that come and go on their own.
    this.ambient = { dir: v3(1, 0, 0), strength: 0, target: 0, timer: rnd(3, 10), active: false };
    this.burnQueue = [];

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), G.uFogNear.value, G.uFogFar.value);
    this.camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.5, SKY_RADIUS * 1.3);
    this.camera.position.set(0, groundHeight(0, 0) + 1.7, 0);
    this.scene.add(this.camera);
    this.setCameraTurn(0, 0);

    this.sun = new THREE.DirectionalLight(0xffc693, 2.0);
    // The sun's shadows cover the knoll and the air just above it.
    this.sun.target.position.set(0, 12, -32);
    this.sun.position.copy(this.sun.target.position).addScaledVector(G.uSunDir.value, 400);
    this.sun.castShadow = true;
    // A tight, high-resolution map over the near grass: blades are only a few centimetres wide.
    const sc = this.sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 55; sc.bottom = -45; sc.near = 250; sc.far = 600;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.12;
    this.sun.shadow.radius = 2;
    this.hemi = new THREE.HemisphereLight(0x8a9ad8, 0x9a6a48, 0.6);
    this.scene.add(this.sun, this.sun.target, this.hemi);
    // A pool of point lights that follow whichever burners are firing.
    this.burnLights = Array.from({ length: 6 }, () => { const l = new THREE.PointLight(0xffa552, 0, 30, 2); this.scene.add(l); return l; });

    this.sky = new Sky();
    this.mountains = new Mountains();
    this.mist = new Mist(groundHeight);
    this.ground = new Ground();
    this.grass = new Grass({ halfWidth: (d) => this.halfWidth(d), groundHeight });
    this.scene.add(this.sky.mesh, this.mountains.group, this.ground.mesh, this.grass.mesh, this.mist.group);
    this.balloons = [];
    this.setDensity(settings.density);
    // Starting at night, the fleet begins low over the field, lit for the glow, then flies on.
    if (this.night > 0.5) for (const b of this.balloons) { b.pos.copy(b.tether); b.vel.set(0, 0, 0); b.heat = 0.5; }
    this.flock = null;
    this.setBirds(settings.birds);
    this.applyBlends();
  }

  // MARK: - Geometry helpers

  halfWidth(d) { return d * Math.tan(this.fov / 2 * Math.PI / 180) * this.aspect; }

  setCameraTurn(yaw, pitch) {
    this.camera.quaternion.copy(quatAxis(yaw, 0, 1, 0).multiply(quatAxis(this.basePitch + pitch, 1, 0, 0)));
    this.cameraInverse = this.camera.quaternion.clone().invert();
  }

  /** Screen position (points, y up) and depth of a world point, through the camera as turned. */
  project(p) {
    const q = p.clone().sub(this.camera.position).applyQuaternion(this.cameraInverse);
    const depth = Math.max(-q.z, 0.01);
    const f = this.focal / depth;
    return { x: this.screenW / 2 + q.x * f, y: this.screenH / 2 + q.y * f, depth };
  }

  ray(s) {
    const dir = v3((s.x - this.screenW / 2) / this.focal, (s.y - this.screenH / 2) / this.focal, -1).applyQuaternion(this.camera.quaternion).normalize();
    return { origin: this.camera.position.clone(), dir };
  }

  closestPointOnCursorRay(p) {
    const { origin, dir } = this.ray(this.cursor.screen);
    return origin.clone().addScaledVector(dir, Math.max(0, p.clone().sub(origin).dot(dir)));
  }

  /** The balloon under a screen point, if any: the nearest whose envelope covers it. */
  balloonAt(s, slack = 12) {
    let best = null, bestDepth = Infinity;
    for (const b of this.balloons) {
      const scr = this.project(b.pos.clone().add(v3(0, 9 * b.scale, 0)));
      if (scr.depth < 1) continue;
      const r = b.screenRadius(scr) * 1.1 + slack;
      if (Math.hypot(scr.x - s.x, scr.y - s.y) < r && scr.depth < bestDepth) { best = b; bestDepth = scr.depth; }
    }
    return best;
  }

  /** The balloon nearest a screen point. */
  nearestBalloon(s) {
    let best = null, bestD = Infinity;
    for (const b of this.balloons) {
      const scr = this.project(b.pos.clone().add(v3(0, 9 * b.scale, 0)));
      const d = Math.hypot(scr.x - s.x, scr.y - s.y) / (b.screenRadius(scr) + 1);
      if (d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  // MARK: - Wind

  /** The prevailing wind at a point: slow, and veering round over the minutes. */
  windAt(p) {
    const t = this.clock * 0.02 + this.windPhase;
    const strength = 1.4 + 0.5 * Math.sin(t * 0.7 + p.y * 0.01);
    const base = v3(Math.sin(t) * strength, 0, Math.cos(t * 0.83 + 1.0) * strength * 0.6);
    // A passing gust, uneven across the valley.
    const g = this.ambient;
    return base.addScaledVector(g.dir, g.strength * (0.7 + 0.5 * Math.sin(p.x * 0.013 + p.z * 0.009 + this.clock * 0.3)));
  }

  /** The cursor's gust on a balloon: a push along the cursor's motion, fading with distance from it. */
  gustAt(balloon) {
    const g = this.gust;
    if (g.strength <= 0.001) return v3();
    const scr = this.project(balloon.pos.clone().add(v3(0, 9 * balloon.scale, 0)));
    const d = Math.hypot(scr.x - g.screen.x, scr.y - g.screen.y);
    const radius = (240 + Math.min(g.speed, 2500) * 0.12) / (1 + scr.depth / 500);
    const falloff = Math.exp(-((d / radius) ** 2));
    return g.dir.clone().multiplyScalar(g.strength * 7 * falloff);
  }

  /** Soft walls keep every balloon somewhere in view. */
  keepInView(b) {
    const depth = -b.pos.z;
    const lim = this.halfWidth(depth) * 0.85;
    if (Math.abs(b.pos.x) > lim) b.vel.x -= (b.pos.x - Math.sign(b.pos.x) * lim) * 0.05;
    if (b.pos.z > -70) b.vel.z -= (b.pos.z + 70) * 0.05;
    if (b.pos.z < -950) b.vel.z += (-950 - b.pos.z) * 0.05;
  }

  // MARK: - Fleet

  setDensity(key) {
    const want = DENSITY[key] ?? DENSITY.normal;
    while (this.balloons.length > want) this.removeBalloon();
    while (this.balloons.length < want) this.addBalloon();
    this.assignTethers();
  }

  addBalloon() {
    const b = new Balloon(this, this.balloons.length + Math.floor(rnd(0, 1000)));
    // Spread through the valley: a couple close, most in the middle distance, some far off.
    const depth = this.balloons.length < 2 ? rnd(80, 160) : 70 + 850 * Math.pow(Math.random(), 1.4);
    const x = rnd(-0.8, 0.8) * this.halfWidth(depth);
    const z = -depth;
    // Low enough to stay in frame: between a little below eye level and a third of the depth above it.
    const alt = Math.max(groundHeight(x, z) + 25, this.camera.position.y - depth * 0.02, lerp(this.camera.position.y - depth * 0.3, this.camera.position.y + depth * 0.12, Math.random()));
    b.pos.set(x, alt, z);
    b.targetAlt = alt;
    b.vel.copy(this.windAt(b.pos));
    this.balloons.push(b);
    this.scene.add(b.node);
    this.assignTethers();
    return b;
  }

  removeBalloon() {
    const b = this.balloons.pop();
    if (!b) return;
    this.scene.remove(b.node);
    b.dispose();
  }

  /** Where each balloon starts when the page opens at night: spaced out low over the field. */
  assignTethers() {
    const taken = [];
    for (const b of this.balloons) {
      let p = null;
      for (let tries = 0; tries < 40; tries++) {
        const z = -rnd(60, 300), x = rnd(-0.75, 0.75) * this.halfWidth(-z);
        // Hovering on their tethers, high enough to clear the long grass on the knoll.
        if (taken.every((t) => Math.hypot(t.x - x, t.z - z) > 26)) { p = v3(x, groundHeight(x, z) + 24 + 6 * b.scale, z); break; }
      }
      if (!p) p = v3(rnd(-100, 100), groundHeight(0, -200) + 30, -200);
      taken.push(p);
      b.tether = p;
    }
  }

  setBirds(on) {
    if (on && !this.flock) { this.flock = new Flock(this, 48); this.scene.add(this.flock.mesh); }
    if (!on && this.flock) { this.scene.remove(this.flock.mesh); this.flock.dispose(); this.flock = null; }
  }

  // MARK: - Public actions

  /** A click: fire the balloon under the cursor, or failing that the nearest one. */
  click(s) {
    const b = this.balloonAt(s) ?? this.nearestBalloon(s);
    b?.fire(this.night > 0.5 ? 4 : 2.5);
  }

  fireRandom() {
    const b = this.balloons[Math.floor(Math.random() * this.balloons.length)];
    b?.fire(this.night > 0.5 ? 4 : 2.5);
  }

  /** Everyone burns, in a ragged wave across the field. */
  fireAll() {
    this.balloons.forEach((b) => this.burnQueue.push({ at: this.clock + rnd(0, 1.6), b }));
  }

  /** Envelopes shoulder past each other rather than passing through. */
  separateBalloons(dt) {
    const bs = this.balloons;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const ca = a.pos.clone().add(v3(0, 9 * a.scale, 0)), cb = b.pos.clone().add(v3(0, 9 * b.scale, 0));
        const d = ca.distanceTo(cb);
        const minD = 8.6 * (a.scale + b.scale) + 1.5;
        if (d >= minD || d < 1e-3) continue;
        const dir = cb.clone().sub(ca).divideScalar(d);
        const push = (minD - d);
        // Move them apart and bleed off the closing speed, softly, like two soft hulls meeting.
        const k = Math.min(1, dt * 2.5);
        a.pos.addScaledVector(dir, -push * 0.5 * k);
        b.pos.addScaledVector(dir, push * 0.5 * k);
        const closing = b.vel.clone().sub(a.vel).dot(dir);
        if (closing < 0) { a.vel.addScaledVector(dir, closing * 0.5); b.vel.addScaledVector(dir, -closing * 0.5); }
      }
    }
  }

  /** Hand the pool of burner lights to the brightest burners. */
  updateBurnLights() {
    const burning = this.balloons.filter((b) => b.burn > 0.02).sort((p, q) => q.burn - p.burn);
    this.burnLights.forEach((light, i) => {
      const b = burning[i];
      if (!b) { light.intensity = 0; return; }
      light.position.copy(b.pos).add(v3(0, -2.4 * b.scale, 0));
      light.intensity = b.burn * 900 * b.scale;
    });
  }

  // MARK: - Frame loop

  updateCamera(dt) {
    const maxYaw = 3.5 * Math.PI / 180, maxPitch = 2 * Math.PI / 180;
    const target = new THREE.Vector2();
    const c = this.cursor;
    if (c.present) {
      const w = this.screenW, h = this.screenH;
      const zoneX = w * 0.12, zoneY = h * 0.12;
      const right = smoothstep(w - zoneX, w, c.screen.x) - smoothstep(zoneX, 0, c.screen.x);
      const up = smoothstep(h - zoneY, h, c.screen.y) - smoothstep(zoneY, 0, c.screen.y);
      target.set(-right * maxYaw, up * maxPitch);
    }
    const before = this.cameraAngles.clone();
    this.cameraAngles.add(target.sub(this.cameraAngles).multiplyScalar(Math.min(1, dt * 1.2)));
    if (before.distanceTo(this.cameraAngles) > 1e-7) this.setCameraTurn(this.cameraAngles.x, this.cameraAngles.y);
  }

  /** The cursor's motion becomes a gust of wind: direction from its velocity, fading over a couple of seconds. */
  updateGust(dt) {
    const c = this.cursor, g = this.gust;
    g.strength *= Math.exp(-dt / 1.6);
    if (c.present && c.speed > 250) {
      const right = v3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = v3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const dir = right.multiplyScalar(c.vel.dx).add(up.multiplyScalar(c.vel.dy)).normalize();
      const s = clamp(c.speed / 1500, 0.2, 2.5);
      if (s > g.strength) { g.strength = s; g.dir.copy(dir); g.screen = { ...c.screen }; g.speed = c.speed; }
    }
    // Rest the cursor on a balloon and its crew wave back.
    if (c.present && c.stillTime > 0.6) this.balloonAt(c.screen, 0)?.wave();
  }

  /** Gusts of wind that arrive on their own: a few seconds of push, then calm. */
  updateAmbient(dt) {
    const g = this.ambient;
    g.timer -= dt;
    if (g.timer <= 0) {
      g.active = !g.active;
      if (g.active) {
        const a = rnd(0, TAU);
        g.dir.set(Math.cos(a), 0, Math.sin(a) * 0.5).normalize();
        g.target = rnd(0.8, 2.2);
        g.timer = rnd(4, 10);
      } else {
        g.target = 0;
        g.timer = rnd(8, 28);
      }
    }
    g.strength += clamp(g.target - g.strength, -dt * 0.4, dt * 0.6);
  }

  updateBlends(dt, settings) {
    const before = this.night;
    this.night += clamp((settings.nightGlow ? 1 : 0) - this.night, -dt * 0.25, dt * 0.25);
    if (before !== this.night) this.applyBlends();
  }

  applyBlends() {
    const n = this.night;
    G.uNight.value = n;
    G.uFogColor.value.copy(DAWN_FOG).lerp(NIGHT_FOG, n);
    G.uFogNear.value = lerp(150, 60, n);
    G.uFogFar.value = lerp(6000, 2200, n);
    const fc = G.uFogColor.value;
    this.scene.fog.color.setRGB(fc.x, fc.y, fc.z);
    this.scene.fog.near = G.uFogNear.value;
    this.scene.fog.far = G.uFogFar.value;
    this.sun.intensity = lerp(2.0, 0, n);
    this.hemi.intensity = lerp(0.6, 0.06, n);
    this.hemi.color.setRGB(lerp(0.54, 0.1, n), lerp(0.6, 0.12, n), lerp(0.85, 0.3, n));
    this.hemi.groundColor.setRGB(lerp(0.6, 0.03, n), lerp(0.42, 0.03, n), lerp(0.28, 0.05, n));
  }

  step(dt, pointer, settings) {
    this.clock += dt;
    G.uTime.value = this.clock % TIME_WRAP;
    this.cursor.update(pointer, pointer.inside, dt);
    this.updateCamera(dt);
    this.updateBlends(dt, settings);
    this.updateGust(dt);
    this.updateAmbient(dt);
    this.burnQueue = this.burnQueue.filter((q) => { if (q.at <= this.clock) { q.b.fire(this.night > 0.5 ? 5 : 3); return false; } return true; });
    for (const b of this.balloons) b.update(dt, this);
    this.separateBalloons(dt);
    this.updateBurnLights();
    // The grass feels the cursor's gust and the ambient one together.
    const combined = this.gust.dir.clone().multiplyScalar(this.gust.strength).addScaledVector(this.ambient.dir, this.ambient.strength * 0.7);
    const cs = combined.length();
    this.grass.update(dt, cs > 1e-4 ? combined.divideScalar(cs) : v3(1, 0, 0), cs);
    this.flock?.update(dt, this);
    this.mist.update(dt, this.night);
  }

  dispose() {
    for (const b of this.balloons) b.dispose();
    for (const part of [this.sky, this.mountains, this.mist, this.ground, this.grass, this.flock]) part?.dispose();
  }
}
