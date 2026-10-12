// Loon Lake — The scene: camera, the cursor mapped into the world as a fingertip in the water,
// skipped stones, the breeze, dusk-to-night and dry-to-rain blends, the reflection and
// refraction passes the water needs, and the frame loop.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, smoothstep, v3, unit, quatAxis, TIME_WRAP } from './util.js';
import { G, LAYER } from './shaders.js';
import { WaveSim, Rings, Water, LakeBed, inSim } from './water.js';
import { Sky, Moon, Shore, Mist, Rain, SKY_RADIUS } from './sky.js';
import { Reeds } from './reeds.js';
import { BedLife } from './bedlife.js';
import { Lilies } from './lilies.js';
import { Shoal } from './fish.js';
import { Loons } from './loons.js';
import { Dragonflies } from './dragonflies.js';

export const DENSITY = {
  few: { fish: 5, loons: 1, dragonflies: 4 },
  normal: { fish: 9, loons: 2, dragonflies: 8 },
  many: { fish: 15, loons: 4, dragonflies: 14 },
};

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
// A skipped stone: thrown from the hand to where you clicked, then hopping on across the water
// in shrinking bounds until it runs out of speed and sinks.
// ---------------------------------------------------------------------------------------------

const GRAVITY = 9.81;

class Stone {
  constructor(lake, target) {
    this.lake = lake;
    this.pos = v3(0.3, 1.15, -0.4);
    const to = target.clone().sub(this.pos);
    const D = Math.hypot(to.x, to.z);
    const vh = clamp(D / 1.1, 7, 26);
    const T = D / vh;
    this.vel = v3(to.x / D * vh, (GRAVITY * T * T / 2 - this.pos.y) / T, to.z / D * vh);
    this.hops = Math.floor(rnd(3, 8));
    this.state = 'fly';
    this.sink = 0;
    this.spin = rnd(0, TAU);
    this.size = rnd(0.028, 0.04);
    this.mesh = new THREE.Mesh(lake.stoneGeometry, lake.stoneMaterial);
    this.mesh.scale.set(this.size, this.size * 0.35, this.size * 0.85);
    this.mesh.layers.enable(LAYER.ABOVE);
    this.mesh.frustumCulled = false;
    lake.scene.add(this.mesh);
  }

  update(dt) {
    const lake = this.lake;
    if (this.state === 'fly') {
      this.vel.y -= GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.spin += dt * 25;
      if (this.pos.y <= 0 && this.vel.y < 0) {
        this.pos.y = 0;
        const vh = Math.hypot(this.vel.x, this.vel.z);
        // Each touch presses the water down and startles anything close.
        const strength = clamp(vh / 12, 0.4, 1.2);
        lake.disturb(this.pos.x, this.pos.z, 0.12 + 0.04 * strength, -0.03 * strength, 1.0 * strength);
        lake.startles.push({ x: this.pos.x, z: this.pos.z, radius: 4 + 2 * strength });
        // The next hop is shorter and lower; the stone keeps most of its forward speed.
        const hopLen = (vh * 2 * Math.abs(this.vel.y) / GRAVITY) * 0.58;
        if (this.hops > 0 && vh > 3 && hopLen > 0.3) {
          this.hops--;
          const newVh = vh * 0.86;
          this.vel.x *= newVh / vh; this.vel.z *= newVh / vh;
          this.vel.y = GRAVITY * hopLen / (2 * newVh);
        } else {
          this.state = 'sink';
          lake.disturb(this.pos.x, this.pos.z, 0.16, -0.04, 1.2);
          this.vel.multiplyScalar(0.3);
          this.mesh.layers.set(LAYER.BELOW);
        }
      }
    } else {
      // Sinking: slows, drifts down, and is gone.
      this.sink += dt;
      this.vel.multiplyScalar(Math.exp(-dt * 3));
      this.vel.y = -0.5;
      this.pos.addScaledVector(this.vel, dt);
      this.spin += dt * 4;
      if (this.sink > 3 || this.pos.y < -3) this.done = true;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(quatAxis(this.spin, 0, 1, 0)).multiply(quatAxis(0.18 * Math.sin(this.spin * 0.3), 1, 0, 0));
  }

  dispose() { this.lake.scene.remove(this.mesh); }
}

// ---------------------------------------------------------------------------------------------
// The lake. Units are metres. The viewer stands at the water's edge at the origin, eye 1.5 m
// above the surface, looking out toward -z across the lake to the far shore.
// ---------------------------------------------------------------------------------------------

const DUSK_FOG = v3(0.44, 0.37, 0.47);
const NIGHT_FOG = v3(0.008, 0.01, 0.022);
const RAIN_FOG = v3(0.3, 0.32, 0.36);

export class Lake {
  constructor(app, renderer, screenW, screenH, settings) {
    this.app = app;
    this.renderer = renderer;
    this.screenW = screenW;
    this.screenH = screenH;
    this.aspect = screenW / screenH;
    this.fov = 50;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.basePitch = -4.5 * Math.PI / 180;
    this.cursor = new Cursor();
    this.clock = 0;
    this.night = settings.night ? 1 : 0;
    this.rain = settings.rain ? 1 : 0;
    this.cameraAngles = new THREE.Vector2();
    this.finger = { point: v3(), inWater: false, valid: false, prev: null };
    this.startles = [];
    this.stones = [];
    this.breeze = { angle: rnd(0, TAU), strength: 0.3, target: 0.3, timer: rnd(10, 30) };
    this.loonApproacher = null;
    this.fingerPercher = null;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), G.uFogNear.value, G.uFogFar.value);
    this.camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.2, SKY_RADIUS * 1.4);
    this.camera.position.set(0, 1.5, 0);
    this.camera.layers.enable(LAYER.ABOVE);
    this.scene.add(this.camera);
    this.setCameraTurn(0, 0);
    this.mirrorCamera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.2, SKY_RADIUS * 1.4);
    this.mirrorCamera.layers.set(LAYER.ABOVE);

    // Light: the sky overhead, the last warmth from where the sun set, and the moon at night.
    this.hemi = new THREE.HemisphereLight(0x8c78a0, 0x101418, 2.0);
    // One key light casts the shadows: the low afterglow at dusk, the moon at night. Its shadow
    // map covers the near thirty metres of the lake, where the bed, rocks and reeds can be seen.
    this.key = new THREE.DirectionalLight(0xffa070, 6.0);
    this.key.castShadow = true;
    this.key.target.position.set(0, -3, -14);
    const sc = this.key.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 18; sc.bottom = -18; sc.near = 40; sc.far = 220;
    sc.updateProjectionMatrix();
    this.key.shadow.mapSize.set(4096, 4096);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.04;
    this.key.shadow.radius = 3;
    this.glowDir = G.uSunDir.value.clone();
    for (const l of [this.hemi, this.key]) { l.layers.enable(LAYER.ABOVE); l.layers.enable(LAYER.BELOW); this.scene.add(l); }
    this.scene.add(this.key.target);

    // The water and what is in and around it.
    this.sim = new WaveSim(renderer, settings.lowPower ? 1536 : 2048);
    this.rings = new Rings();
    this.water = new Water(renderer, this.sim, this.rings);
    this.sky = new Sky();
    this.moon = new Moon();
    this.shore = new Shore((d) => this.halfWidth(d));
    this.mist = new Mist((d) => this.halfWidth(d));
    this.rainFx = new Rain();
    this.reeds = new Reeds((d) => this.halfWidth(d));
    this.bedLife = new BedLife({ halfWidth: (d) => this.halfWidth(d) }, this.reeds.bases);
    this.bed = new LakeBed(this.sim, this.bedLife.aoTexture);
    this.lilies = new Lilies({ halfWidth: (d) => this.halfWidth(d) });
    /** Everywhere a dragonfly may land: reed tops and lily pads. */
    this.perches = [...this.reeds.perches, ...this.lilies.perches];
    this.scene.add(this.sky.mesh, this.moon.mesh, this.shore.group, this.mist.group, this.rainFx.points, this.water.mesh, this.bed.mesh, this.bedLife.group, this.reeds.group, this.lilies.group);

    this.stoneGeometry = new THREE.SphereGeometry(1, 14, 10);
    this.stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.7, metalness: 0.05 });

    // Where each kind of creature lives.
    this.fishBounds = { near: -1.8, far: -28, halfWidth: (d) => this.halfWidth(d) };
    this.loonBounds = { near: -14, far: -60, halfWidth: (d) => this.halfWidth(d) };
    this.dragonflyBounds = { near: -1.2, far: -16, halfWidth: (d) => this.halfWidth(d) };
    const dens = DENSITY[settings.density] ?? DENSITY.normal;
    this.shoal = new Shoal(this, dens.fish);
    this.loons = new Loons(this, dens.loons);
    this.dragonflies = new Dragonflies(this, dens.dragonflies);
    this.scene.add(this.shoal.group, this.loons.group, this.dragonflies.group);

    this.buildTargets();
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

  /** Where a screen point meets the water, if it does within `maxDist` metres. */
  waterPoint(s, maxDist = 150) {
    const { origin, dir } = this.ray(s);
    if (dir.y >= -1e-4) return null;
    const t = -origin.y / dir.y;
    if (t > maxDist) return null;
    return origin.clone().addScaledVector(dir, t);
  }

  // MARK: - Disturbing the water

  /** A dent in the water: simulated near by, an analytic ring far out. */
  disturb(x, z, radius, amount, ringAmp = 0) {
    if (this.sim.splat(x, z, radius, amount)) return;
    if (ringAmp > 0) this.rings.add(x, z, ringAmp * 0.006, this.clock);
  }

  /** Skip a stone toward a screen point. */
  skipStone(s) {
    let target = this.waterPoint(s, 400);
    if (!target) {
      const { dir } = this.ray(s);
      const h = unit(v3(dir.x, 0, dir.z));
      if (h.lengthSq() < 0.5 || h.z > -0.2) h.set(0, 0, -1);
      target = h.multiplyScalar(60);
      target.y = 0;
    }
    if (target.z > -2) target.z = -2;
    this.stones.push(new Stone(this, target));
  }

  /** The cursor's fingertip in the world: on the water if the cursor is over water, else in the air. */
  updateFinger(dt) {
    const c = this.cursor, f = this.finger;
    if (!c.present) { f.valid = false; f.inWater = false; f.prev = null; return; }
    const wp = this.waterPoint(c.screen, 120);
    const wasInWater = f.inWater && f.prev;
    if (wp) {
      f.point.copy(wp).setY(0);
      f.inWater = true;
      f.valid = true;
    } else {
      const { origin, dir } = this.ray(c.screen);
      f.point.copy(origin).addScaledVector(dir, 6);
      f.inWater = false;
      f.valid = f.point.y < 4;
    }
    // A finger dragged through the water leaves a wake: dents along its path, deeper the faster it moves.
    if (f.inWater && inSim(f.point.x, f.point.z)) {
      const segLen = wasInWater ? f.prev.distanceTo(f.point) : 0;
      // A hand cannot cross two metres of water in a frame: that is a jump, not a drag.
      if (wasInWater && c.speed > 30 && segLen < 2) {
        const from = f.prev, to = f.point;
        const n = clamp(Math.ceil(segLen / 0.05), 1, 8);
        const amount = -0.004 * clamp(c.speed / 600, 0.4, 1.6);
        for (let i = 1; i <= n; i++) {
          const p = from.clone().lerp(to, i / n);
          this.sim.splat(p.x, p.z, 0.06 + 0.03 * clamp(c.speed / 1000, 0, 1), amount / Math.sqrt(n));
        }
      } else if (!wasInWater) {
        this.sim.splat(f.point.x, f.point.z, 0.08, -0.005);
      }
    }
    f.prev = f.inWater ? f.point.clone() : null;
  }

  // MARK: - Population and modes

  setDensity(key) {
    const d = DENSITY[key] ?? DENSITY.normal;
    this.shoal.setCount(d.fish);
    this.loons.setCount(d.loons);
    this.dragonflies.setCount(d.dragonflies);
  }

  get population() { return this.shoal.fish.length + this.loons.list.length + this.dragonflies.list.length; }

  // MARK: - Frame loop

  updateCamera(dt) {
    const maxYaw = 3 * Math.PI / 180, maxPitch = 1.5 * Math.PI / 180;
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
    this.cameraAngles.add(target.sub(this.cameraAngles).multiplyScalar(Math.min(1, dt * 1.0)));
    if (before.distanceTo(this.cameraAngles) > 1e-7) this.setCameraTurn(this.cameraAngles.x, this.cameraAngles.y);
  }

  /** The breeze: veering slowly, freshening and dying over minutes; stronger in the rain. */
  updateBreeze(dt) {
    const b = this.breeze;
    b.timer -= dt;
    if (b.timer <= 0) { b.target = rnd(0.1, 0.7); b.timer = rnd(20, 60); }
    b.strength += clamp(b.target - b.strength, -dt * 0.01, dt * 0.01);
    b.angle += dt * 0.004 * Math.sin(this.clock * 0.013 + 1);
    const s = b.strength * (1 + this.rain * 0.8);
    G.uWind.value.set(Math.cos(b.angle), Math.sin(b.angle), s);
  }

  updateBlends(dt, settings) {
    const n0 = this.night, r0 = this.rain;
    this.night += clamp((settings.night ? 1 : 0) - this.night, -dt * 0.2, dt * 0.2);
    this.rain += clamp((settings.rain ? 1 : 0) - this.rain, -dt * 0.25, dt * 0.25);
    if (n0 !== this.night || r0 !== this.rain) this.applyBlends();
  }

  applyBlends() {
    const n = this.night, r = this.rain;
    G.uNight.value = n;
    G.uRain.value = r;
    const fog = DUSK_FOG.clone().lerp(RAIN_FOG, r).lerp(NIGHT_FOG, n);
    G.uFogColor.value.copy(fog);
    G.uFogNear.value = lerp(lerp(200, 60, r), 40, n);
    G.uFogFar.value = lerp(lerp(5000, 1600, r), 1800, n);
    this.scene.fog.color.setRGB(fog.x, fog.y, fog.z);
    this.scene.fog.near = G.uFogNear.value;
    this.scene.fog.far = G.uFogFar.value;
    this.hemi.intensity = lerp(lerp(2.0, 2.0, r), 0.7, n);
    this.hemi.color.setRGB(lerp(lerp(0.55, 0.45, r), 0.1, n), lerp(lerp(0.47, 0.47, r), 0.12, n), lerp(lerp(0.63, 0.52, r), 0.22, n));
    this.hemi.groundColor.setRGB(lerp(0.06, 0.01, n), lerp(0.08, 0.012, n), lerp(0.09, 0.02, n));
    // The key light swings from the afterglow to the moon as night falls, and dims in the rain.
    const dir = this.glowDir.clone().lerp(G.uMoonDir.value, n).normalize();
    this.key.position.copy(this.key.target.position).addScaledVector(dir, 120);
    this.key.color.setRGB(lerp(1.0, 0.62, n), lerp(0.6, 0.7, n), lerp(0.36, 1.0, n));
    this.key.intensity = lerp(6.0, 1.6, n) * (1 - r * 0.9);
  }

  step(dt, pointer, settings) {
    this.clock += dt;
    G.uTime.value = this.clock % TIME_WRAP;
    this.cursor.update(pointer, pointer.inside, dt);
    this.updateCamera(dt);
    this.updateBlends(dt, settings);
    this.updateBreeze(dt);
    this.startles = [];
    this.updateFinger(dt);
    for (const s of this.stones) s.update(dt);
    this.stones = this.stones.filter((s) => { if (s.done) { s.dispose(); return false; } return true; });
    this.shoal.update(dt, this);
    this.loons.update(dt, this);
    this.dragonflies.update(dt, this);
    this.mist.update(dt, this.night, this.rain);
    this.rainFx.update(this.rain);
    this.moon.update(this.night, this.rain);
    this.water.uniforms.uRingCount.value = this.rings.update(this.clock);
    this.sim.step(dt);
  }

  // MARK: - Render passes

  /** Render targets at the drawing-buffer size. */
  buildTargets() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, size.x), h = Math.max(1, size.y);
    this.reflTarget?.dispose();
    this.refrTarget?.dispose();
    this.reflTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.reflTarget.texture.minFilter = THREE.LinearFilter;
    this.refrTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.refrTarget.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    const u = this.water.uniforms;
    u.uReflection.value = this.reflTarget.texture;
    u.uRefraction.value = this.refrTarget.texture;
    u.uRefrDepth.value = this.refrTarget.depthTexture;
    u.uResolution.value.set(w, h);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
  }

  resize(screenW, screenH) {
    this.screenW = screenW;
    this.screenH = screenH;
    this.aspect = screenW / screenH;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.buildTargets();
  }

  /** Draw what the water reflects and what lies beneath it, before the main pass. */
  renderPasses() {
    const r = this.renderer;
    const cam = this.camera, m = this.mirrorCamera;
    // The mirror camera: the viewer's camera reflected in the plane of the water.
    cam.updateMatrixWorld();
    m.position.set(cam.position.x, -cam.position.y, cam.position.z);
    const f = v3(0, 0, -1).applyQuaternion(cam.quaternion), up = v3(0, 1, 0).applyQuaternion(cam.quaternion);
    f.y = -f.y; up.y = -up.y;
    m.up.copy(up);
    m.lookAt(m.position.clone().add(f));
    m.aspect = cam.aspect; m.fov = cam.fov; m.near = cam.near; m.far = cam.far;
    m.updateProjectionMatrix();
    m.updateMatrixWorld();
    const tm = this.water.uniforms.uMirrorMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
    // Clip the mirror's view at the water plane (an oblique near plane, as three's Reflector does)
    // so nothing below the surface, reed stems or a loon's hull, shows in the reflection.
    const plane = new THREE.Plane(v3(0, 1, 0), 0).applyMatrix4(m.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = m.projectionMatrix, q = new THREE.Vector4();
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1;
    q.w = (1 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1; pm.elements[14] = clip.w;

    const prevTarget = r.getRenderTarget();
    const fog = G.uFogColor.value;
    r.setRenderTarget(this.reflTarget);
    r.setClearColor(new THREE.Color(fog.x, fog.y, fog.z), 1);
    r.clear();
    r.render(this.scene, m);

    // The shadow map is rendered here: with the camera on the BELOW layer the casters are the
    // reeds (which stand in every layer), the rocks, weeds, logs and fish, and the receivers the bed.
    cam.layers.set(LAYER.BELOW);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.refrTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, cam);
    cam.layers.set(LAYER.MAIN);
    cam.layers.enable(LAYER.ABOVE);
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    for (const s of this.stones) s.dispose();
    for (const part of [this.shoal, this.loons, this.dragonflies, this.sky, this.moon, this.shore, this.mist, this.rainFx, this.reeds, this.lilies, this.bedLife, this.water, this.bed, this.sim]) part?.dispose();
    this.reflTarget?.dispose();
    this.refrTarget?.dispose();
    this.stoneGeometry.dispose();
    this.stoneMaterial.dispose();
  }
}
