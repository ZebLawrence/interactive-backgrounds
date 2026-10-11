// Firefly Meadow — The scene: camera, the cursor mapped into the world, day-to-storm blends,
// and the frame loop that moves everything.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, smoothstep, v3, unit, quatAxis, TIME_WRAP } from './util.js';
import { G, TRAIL_N, RING_N } from './shaders.js';
import { groundHeight, Ground } from './terrain.js';
import { GrassField } from './grass.js';
import { Swarm } from './fireflies.js';
import { Sky, Moon, Meteors, Horizon, Mist, SKY_RADIUS } from './sky.js';
import { Rain, Lightning } from './storm.js';

export const DENSITY = { few: 0.45, normal: 1, many: 2 };

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
// The meadow. Units are metres. The camera stands at the origin, a little above the grass,
// looking toward -z; the tree line is ~75 m away.
// ---------------------------------------------------------------------------------------------

const NIGHT_FOG = v3(0.05, 0.065, 0.125);
const STORM_FOG = v3(0.028, 0.032, 0.046);
const NIGHT_SKYLIGHT = v3(0.09, 0.11, 0.18);
const STORM_SKYLIGHT = v3(0.05, 0.055, 0.075);

export class Meadow {
  constructor(app, screenW, screenH, settings) {
    this.app = app;
    this.screenW = screenW;
    this.screenH = screenH;
    this.area = (screenW * screenH) / (1512 * 982);
    this.fov = 50;
    this.aspect = screenW / screenH;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.basePitch = -7 * Math.PI / 180;
    this.groundHeight = groundHeight;

    this.cursor = new Cursor();
    this.clock = 0;
    this.storm = settings.storm ? 1 : 0;
    this.moon = settings.moonlight ? 1 : 0;
    this.cursorStrength = 0;
    this.cursorGround = v3(0, 0, -10);
    this.trailIndex = 0;
    this.lastTrail = v3(1e9, 0, 1e9);
    this.rings = [];
    this.gust = 0;
    this.gustTimer = rnd(3, 8);
    this.cameraAngles = new THREE.Vector2();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), G.uFogNear.value, G.uFogFar.value);
    this.camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.1, SKY_RADIUS * 1.2);
    this.camera.position.set(0, groundHeight(0, 0) + 1.25, 0);
    this.scene.add(this.camera);
    this.setCameraTurn(0, 0);

    const layout = { halfWidth: (d) => this.halfWidth(d), groundHeight, area: this.area };
    this.ground = new Ground();
    this.grass = new GrassField(layout);
    this.sky = new Sky();
    this.moonSprite = new Moon();
    this.meteors = new Meteors();
    this.horizon = new Horizon();
    this.mist = new Mist(layout.halfWidth);
    this.rain = new Rain(groundHeight);
    this.lightning = new Lightning();
    this.scene.add(this.sky.mesh, this.moonSprite.sprite, this.meteors.mesh, this.horizon.group, this.lightning.mesh,
      this.ground.mesh, this.grass.group, this.mist.group, this.rain.points);
    this.swarm = null;
    this.setDensity(settings.density);
    this.applyBlends();
  }

  // MARK: - Geometry helpers

  /** Half the width of the meadow in view `d` metres out, with room for the camera to pan. */
  halfWidth(d) { return d * (Math.tan(this.fov / 2 * Math.PI / 180) * this.aspect + 0.07) + 1.0; }

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

  /** The line of sight through a screen point. */
  ray(s) {
    const dir = v3((s.x - this.screenW / 2) / this.focal, (s.y - this.screenH / 2) / this.focal, -1).applyQuaternion(this.camera.quaternion).normalize();
    return { origin: this.camera.position.clone(), dir };
  }

  /** Where the line of sight through a screen point meets the ground (or, above the horizon, a far point). */
  groundPoint(s) {
    const { origin, dir } = this.ray(s);
    let t = 45;
    if (dir.y < -0.004) {
      t = (groundHeight(0, -10) - origin.y) / dir.y;
      for (let i = 0; i < 3; i++) {
        const p = origin.clone().addScaledVector(dir, t);
        t = (groundHeight(p.x, p.z) - origin.y) / dir.y;
      }
    }
    t = clamp(t, 0.6, 60);
    return origin.clone().addScaledVector(dir, t);
  }

  /** The point on the cursor's line of sight at world depth z. */
  cursorPointAtDepth(z) {
    const { origin, dir } = this.ray(this.cursor.screen);
    const dz = Math.min(dir.z, -0.05);
    return origin.clone().addScaledVector(dir, (z - origin.z) / dz);
  }

  closestPointOnCursorRay(p) {
    const { origin, dir } = this.ray(this.cursor.screen);
    return origin.clone().addScaledVector(dir, Math.max(0, p.clone().sub(origin).dot(dir)));
  }

  // MARK: - Public actions

  setDensity(key) {
    if (this.swarm) { this.scene.remove(this.swarm.points); this.swarm.dispose(); }
    this.swarm = new Swarm(this, DENSITY[key] ?? 1);
    this.swarm.setPixelScale(this.pixelScale ?? this.focal);
    this.scene.add(this.swarm.points);
  }

  /** Point sprite scale: pixels per metre at one metre, for the current pixel ratio. */
  setPixelScale(px) {
    this.pixelScale = px;
    this.swarm?.setPixelScale(px);
  }

  /** A clap at a screen point: a ring runs out through the grass and nearby fireflies startle. */
  clap(s) {
    const p = this.groundPoint(s);
    if (this.rings.length >= RING_N) this.rings.shift();
    this.rings.push({ x: p.x, z: p.z, age: 0 });
    this.swarm.clap(p, 7);
  }

  // MARK: - Frame loop

  /** Near a screen edge the camera turns a few degrees toward it, and drifts back when it leaves. */
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

  updateCursorPush(dt) {
    const c = this.cursor;
    const want = c.present ? 1 : 0;
    this.cursorStrength += clamp(want - this.cursorStrength, -dt * 3, dt * 3);
    if (c.present) this.cursorGround = this.groundPoint(c.screen);
    const g = this.cursorGround;
    const dist = g.distanceTo(this.camera.position);
    const radius = 0.6 + dist * 0.08;
    G.uCursor.value.set(g.x, g.z, radius, this.cursorStrength * 1.1);

    // Leave a trail of flattened grass behind the cursor that slowly springs back.
    const trail = G.uTrail.value;
    if (c.present && g.distanceTo(this.lastTrail) > radius * 0.5) {
      trail[this.trailIndex].set(g.x, g.z, radius * 0.9, 0.85);
      this.trailIndex = (this.trailIndex + 1) % TRAIL_N;
      this.lastTrail.copy(g);
    }
    for (const t of trail) if (t.w > 0) t.w = Math.max(0, t.w - dt * 0.3);

    const rings = G.uRings.value;
    this.rings = this.rings.filter((r) => (r.age += dt) < 1.4);
    for (let i = 0; i < RING_N; i++) {
      const r = this.rings[i];
      if (r) rings[i].set(r.x, r.z, 0.3 + r.age * 7, 1.6 * (1 - r.age / 1.4)); else rings[i].set(0, 0, 0, 0);
    }
  }

  /** Ease moonlight and the storm in and out, and set everything that depends on them. */
  updateBlends(dt, settings) {
    const before = [this.storm, this.moon];
    this.storm += clamp((settings.storm ? 1 : 0) - this.storm, -dt * 0.35, dt * 0.35);
    this.moon += clamp((settings.moonlight ? 1 : 0) - this.moon, -dt * 0.5, dt * 0.5);
    // Gusts come and go, more in a storm.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) { this.gustTimer = rnd(3, 9); this.gustTarget = rnd(0, 0.5) + this.storm * rnd(0.3, 1.2); }
    this.gust += clamp((this.gustTarget ?? 0) - this.gust, -dt * 0.6, dt * 0.6);
    G.uWind.value = lerp(0.9, 2.6, this.storm) + this.gust;
    if (before[0] !== this.storm || before[1] !== this.moon) this.applyBlends();
  }

  applyBlends() {
    const s = this.storm, m = this.moon;
    G.uStorm.value = s;
    G.uMoon.value = m * (1 - s * 0.92);
    G.uFogColor.value.copy(NIGHT_FOG).lerp(STORM_FOG, s);
    G.uFogNear.value = lerp(15, 6, s);
    G.uFogFar.value = lerp(160, 80, s);
    G.uSkyLight.value.copy(NIGHT_SKYLIGHT).lerp(STORM_SKYLIGHT, s).multiplyScalar(lerp(0.75, 1, m));
    const fc = G.uFogColor.value;
    this.scene.fog.color.setRGB(fc.x, fc.y, fc.z);
    this.scene.fog.near = G.uFogNear.value;
    this.scene.fog.far = G.uFogFar.value;
    this.moonSprite.update(m, s);
  }

  step(dt, pointer, settings) {
    this.clock += dt;
    G.uTime.value = this.clock % TIME_WRAP;
    this.cursor.update(pointer, pointer.inside, dt);
    this.updateCamera(dt);
    this.updateBlends(dt, settings);
    this.updateCursorPush(dt);
    this.swarm.update(dt);
    this.mist.update(dt, (d) => this.halfWidth(d), G.uWind.value, this.storm);
    this.meteors.update(dt, this.storm);
    this.rain.update(dt, this.storm, G.uWind.value);
    this.lightning.update(dt, this.storm);
  }

  dispose() {
    for (const part of [this.ground, this.grass, this.sky, this.moonSprite, this.meteors, this.horizon, this.mist, this.rain, this.lightning, this.swarm]) part.dispose();
  }
}
