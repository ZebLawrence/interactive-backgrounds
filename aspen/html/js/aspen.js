// Aspen Snow — The scene: a quaking-aspen grove in falling snow. Lays out the grove and what
// lives in it, owns the camera, the lights and the weather, turns the cursor into gusts, glances
// and clicks, and steps every system.
//
// Units are metres. The viewer stands among the trunks at the origin, eye 1.6 m above the snow,
// looking north (-z) into the grove. East is +x.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, noise2, v3, approach, seeded, TIME_WRAP } from './util.js';
import { G } from './shaders.js';
import { Sky, Moon, Weather } from './sky.js';
import { Snowpack, Horizon, Tufts, makeHeight, cacheHeight, bakeCanopy, bakeContact } from './ground.js';
import { buildAspen, buildStick, makeTreeMaterials, Grove } from './tree.js';
import { makeBarkTextures } from './bark.js';
import { Snowfall, Puffs } from './snow.js';
import { Hare, makeHareKit, makeHareTraits } from './hare.js';
import { Grouse } from './grouse.js';

export const HARES = { one: 1, two: 2, three: 3 };

const EYE = 1.6;
const PITCH = -0.03;
const FOV = 50;

export class Aspen {
  constructor(app, w, h, settings) {
    this.app = app;
    this.screenW = w;
    this.screenH = h;
    this.settings = settings;
    this.seed = Math.floor(Math.random() * 1e9);
    const rng = seeded(this.seed);
    this.rng = rng;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), G.uFogNear.value, G.uFogFar.value);

    // --- Layout -----------------------------------------------------------------------------
    const layout = this.layout(rng);
    this.exactHeight = makeHeight(layout.wells, layout.lumps, layout.capsules);
    this.height = cacheHeight(this.exactHeight);
    for (const t of layout.trees) t.y = this.height(t.x, t.z) - 0.04;
    for (const t of layout.suckers) t.y = this.height(t.x, t.z) - 0.02;
    for (const t of layout.sticks) t.y = this.height(t.x, t.z) + t.lift;
    for (const t of layout.tufts) t.y = this.height(t.x, t.z);
    this.eyeY = this.height(0, 0) + EYE;

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.15, 20000);
    this.camera.position.set(0, this.eyeY, 0);
    this.camera.rotation.order = 'YXZ';
    this.pan = { yaw: 0, pitch: 0 };
    this.applyCamera();

    // --- Sky --------------------------------------------------------------------------------
    this.sky = new Sky();
    this.moon = new Moon();
    this.weather = new Weather();
    this.scene.add(this.sky.mesh, this.moon.group);

    // --- Ground -----------------------------------------------------------------------------
    this.snowpack = new Snowpack(this.height);
    this.horizon = new Horizon(this.exactHeight, rng);
    this.tufts = new Tufts(layout.tufts, rng);
    this.scene.add(this.snowpack.mesh, this.horizon.group, this.tufts.mesh);

    // --- Trees ------------------------------------------------------------------------------
    this.treeMats = makeTreeMaterials(makeBarkTextures());
    this.grove = new Grove(layout.variants, layout.trees, this.treeMats);
    this.suckers = new Grove(layout.saplingVariants, layout.suckers, this.treeMats);
    this.sticks = new Grove(layout.stickVariants, layout.sticks, this.treeMats);
    this.scene.add(this.grove.group, this.suckers.group, this.sticks.group);

    // --- Snow in the air ----------------------------------------------------------------------
    this.snowfall = new Snowfall(20000, this.height);
    this.puffs = new Puffs(3500);
    this.scene.add(this.snowfall.points, this.puffs.points);

    // --- Lights ------------------------------------------------------------------------------
    const makeKey = (dir) => {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.position.copy(dir).multiplyScalar(160).add(v3(0, 0, -22));
      light.target.position.set(0, 0, -22);
      light.castShadow = true;
      const sc = light.shadow.camera;
      sc.left = -36; sc.right = 36; sc.top = 36; sc.bottom = -36; sc.near = 20; sc.far = 340;
      light.shadow.mapSize.set(4096, 4096);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.05;
      return light;
    };
    this.sunLight = makeKey(G.uSunDir.value);
    this.moonLight = makeKey(G.uMoonDir.value);
    this.hemi = new THREE.HemisphereLight(new THREE.Color(0.7, 0.73, 0.8), new THREE.Color(0.62, 0.64, 0.68), 2.6);
    this.scene.add(this.sunLight, this.sunLight.target, this.moonLight, this.moonLight.target, this.hemi);
    this.light = {};
    this.bakeShadows(layout);

    // --- Creatures ----------------------------------------------------------------------------
    this.hareKit = makeHareKit();
    this.hareTraits = makeHareTraits(rng, 3);
    this.hares = [];
    this.setHares(settings.hares);
    this.grouse = new Grouse(this);
    this.scene.add(this.grouse.root);

    // --- Cursor -------------------------------------------------------------------------------
    this.cursor = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, rest: 0, last: null, attention: 0, lastMove: -100 };
    this.gusts = [];
    this.gustTimer = 0;
    this.front = null;
    this.frontTimer = rnd(20, 50);
    this.vp = new THREE.Matrix4();
    this.tmpScreen = { x: 0, y: 0 };
    this.time = 0;
    this.weather.update(0, settings, this.light, 0);
    this.applyLight();
    // Start with a little settled sway so nothing is frozen on the first frame.
    for (let i = 0; i < 30; i++) this.grove.update(1 / 30, (x, z) => this.windAt(x, z), false, () => {});
  }

  // MARK: - Layout

  layout(rng) {
    const R = (lo, hi) => lo + rng() * (hi - lo);
    const variants = [];
    for (let i = 0; i < 6; i++) variants.push(buildAspen(rng, R(16, 23), 1));
    const midStart = variants.length;
    for (let i = 0; i < 4; i++) variants.push(buildAspen(rng, R(15, 22), 0.6));
    const farStart = variants.length;
    for (let i = 0; i < 4; i++) {
      const v = buildAspen(rng, R(14, 21), 0.3);
      v.castShadow = false;
      variants.push(v);
    }
    const youngStart = variants.length;
    for (let i = 0; i < 4; i++) variants.push(buildAspen(rng, R(3.5, 9), 1, { young: true }));
    const saplingVariants = [];
    for (let i = 0; i < 4; i++) saplingVariants.push(buildAspen(rng, R(0.5, 1.5), 1, { sapling: true }));
    const stickVariants = [];
    for (let i = 0; i < 4; i++) {
      const s = buildStick(rng, R(1, 3), R(0.025, 0.06));
      Object.assign(s, { height: 0.5, crownBase: 0, maxR: s.length / 2 });
      stickVariants.push(s);
    }
    const log = buildStick(rng, R(6, 9), R(0.16, 0.22));
    Object.assign(log, { height: 0.5, crownBase: 0, maxR: log.length / 2 });
    stickVariants.push(log);

    const trees = [], wells = [], lumps = [], capsules = [], suckers = [], sticks = [], tufts = [];
    const taken = [];
    const free = (x, z, r) => taken.every((p) => Math.hypot(p.x - x, p.z - z) > r + p.r);
    const add = (t) => { trees.push(t); taken.push({ x: t.x, z: t.z, r: t.r }); };
    const inView = (x, z, slack = 0) => Math.abs(Math.atan2(x, -z)) < 0.82 + slack;

    // Big trunks framing the view, close by at the sides.
    const framing = [[-2.4, -2.3], [3.1, -3.8], [-5.4, -7.6], [6.8, -8.5], [-1.4, -12.5], [2.6, -16]];
    for (const [x, z] of framing) {
      const fx = x + R(-0.4, 0.4), fz = z + R(-0.6, 0.6);
      add({ x: fx, z: fz, rot: R(0, TAU), scale: R(1.05, 1.3), variant: Math.floor(R(0, 6)), load: R(0.7, 1), r: 1.4 });
    }
    // The grove: a jittered grid with openings, thinning a little with distance.
    for (let gz = -120; gz < 2; gz += 2.3) {
      for (let gx = -110; gx < 110; gx += 2.3) {
        const x = gx + R(-1, 1), z = gz + R(-1, 1);
        const dist = Math.hypot(x, z);
        if (z > 1.5) continue;
        if (dist > 14 && !inView(x, z, 0.1)) continue;
        // Nothing right in the viewer's face.
        if (z > -7 && Math.abs(x) < 1.4) continue;
        const patch = noise2(x / 14 + 3, z / 14 + 9);
        const keep = (0.5 + 0.5 * patch) * (dist < 30 ? 0.8 : dist < 65 ? 0.65 : 0.45);
        if (rng() > keep) continue;
        // Young trees, suckers grown up, stand among the big ones.
        if (dist < 70 && rng() < 0.22 && free(x, z, 0.7)) {
          add({ x, z, rot: R(0, TAU), scale: R(0.8, 1.2), variant: youngStart + Math.floor(R(0, 4)), load: R(0.6, 1), r: 0.6 });
          continue;
        }
        if (!free(x, z, 1.5)) continue;
        add({
          x, z, rot: R(0, TAU), scale: R(0.85, 1.15),
          variant: dist < 30 ? Math.floor(R(0, 6)) : dist < 65 ? midStart + Math.floor(R(0, 4)) : farStart + Math.floor(R(0, 4)),
          load: R(0.6, 1), r: 1.3,
        });
      }
    }
    for (const t of trees) {
      const v = variants[t.variant];
      if (Math.hypot(t.x, t.z) < 80) wells.push({ x: t.x, z: t.z, r: v.baseR * t.scale * 5 + 0.3, depth: 0.07 });
    }
    // Buried shrubs and logs: lumps under the snow.
    for (let i = 0; i < 60; i++) {
      const x = R(-45, 45), z = R(-70, 2);
      if (!free(x, z, 0.8)) continue;
      lumps.push({ x, z, r: R(0.6, 1.8), h: R(0.12, 0.4) });
    }
    // A fallen trunk, half buried, in the near ground.
    {
      const x = R(2, 6) * (rng() < 0.5 ? 1 : -1), z = R(-9, -14), rot = R(0, TAU);
      const dx = Math.cos(rot), dz = -Math.sin(rot);
      sticks.push({ x, z, rot, scale: 1, variant: stickVariants.length - 1, load: 1, lift: -log.radius * 0.45 });
      capsules.push({ x, z, dx, dz, L: log.length, r: log.radius, h: log.radius * 0.5 });
      taken.push({ x: x + dx * log.length / 2, z: z + dz * log.length / 2, r: log.length / 2 });
    }
    // Fallen branches poking out of the snow.
    for (let i = 0; i < 40; i++) {
      const x = R(-30, 30), z = R(-40, 1);
      if (!inView(x, z) || !free(x, z, 0.9)) continue;
      const vi = Math.floor(R(0, 4));
      sticks.push({ x, z, rot: R(0, TAU), scale: R(0.8, 1.2), variant: vi, load: R(0.6, 1), lift: -stickVariants[vi].radius * 0.5 });
      if (sticks.length > 16) break;
    }
    // Aspen suckers in clumps, and dead grass everywhere.
    for (let i = 0; i < 26; i++) {
      const cx = R(-32, 32), cz = R(-45, -1.5);
      if (!inView(cx, cz) || (cz > -6 && Math.abs(cx) < 2)) continue;
      const n = 3 + Math.floor(R(0, 4));
      for (let k = 0; k < n; k++) {
        const x = cx + R(-0.9, 0.9), z = cz + R(-0.9, 0.9);
        if (!free(x, z, 0.25)) continue;
        suckers.push({ x, z, rot: R(0, TAU), scale: R(0.8, 1.3), variant: Math.floor(R(0, 4)), load: R(0.5, 1) });
      }
    }
    for (let i = 0; i < 1400; i++) {
      const x = R(-40, 40), z = R(-50, 1);
      if (!inView(x, z, 0.1) || (z > -4 && Math.abs(x) < 1.2)) continue;
      if (noise2(x / 5 + 7, z / 5 + 2) < 0.45) continue;
      tufts.push({ x, z, rot: R(0, TAU), scale: R(0.6, 1.4) });
      if (tufts.length >= 500) break;
    }
    const logEntry = sticks[0];
    return { variants, trees, wells, lumps, capsules, saplingVariants, suckers, stickVariants, sticks, tufts, log: logEntry };
  }

  /**
   * Bake the sun's shadows of every trunk outside the shadow map onto the snow, and the contact
   * shade at the foot of every trunk and along the fallen wood.
   */
  bakeShadows(layout) {
    const light = this.sunLight;
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    light.shadow.updateMatrices(light);
    const cam = light.shadow.camera;
    const inMap = (p) => {
      const q = p.clone().applyMatrix4(cam.matrixWorldInverse);
      return q.x > cam.left && q.x < cam.right && q.y > cam.bottom && q.y < cam.top;
    };
    const casters = [], contacts = [];
    for (const t of this.grove.trees) {
      const v = this.grove.variants[t.variant];
      const real = v.castShadow !== false && inMap(v3(t.x, t.y, t.z)) && inMap(v3(t.x, t.y + t.height, t.z));
      casters.push({ x: t.x, z: t.z, height: real ? 0 : t.height, crownBase: t.crownBase, maxR: t.maxR, baseR: t.baseR });
      contacts.push({ x: t.x, z: t.z, r: t.baseR * 3.0 + 0.25, k: 1.0 });
    }
    for (const s of this.sticks.trees) {
      const v = this.sticks.variants[s.variant];
      contacts.push({ x: s.x, z: s.z, dx: Math.cos(s.rot), dz: -Math.sin(s.rot), L: v.length * s.scale, r: v.radius * s.scale * 2.5 + 0.08, k: 0.85 });
    }
    for (const s of this.suckers.trees) contacts.push({ x: s.x, z: s.z, r: 0.12, k: 0.5 });
    for (const t of layout.tufts) contacts.push({ x: t.x, z: t.z, r: 0.1 * t.scale, k: 0.35 });
    this.snowpack.setCanopy(bakeCanopy(casters, G.uSunDir.value));
    this.snowpack.setContact(bakeContact(contacts));
  }

  heightAt(x, z) { return this.height(x, z); }

  /** Not within a trunk, a log or a sucker clump. */
  openSnow(x, z, margin = 0.4) {
    for (const t of this.grove.trees) if (Math.hypot(t.x - x, t.z - z) < t.baseR + margin) return false;
    for (const s of this.sticks.trees) {
      const v = this.sticks.variants[s.variant];
      const dx = Math.cos(s.rot), dz = -Math.sin(s.rot);
      const along = clamp((x - s.x) * dx + (z - s.z) * dz, 0, v.length * s.scale);
      if (Math.hypot(x - s.x - dx * along, z - s.z - dz * along) < v.radius * s.scale + margin) return false;
    }
    return true;
  }

  // MARK: - Creatures

  setHares(name) {
    const n = HARES[name] ?? 2;
    while (this.hares.length > n) {
      const h = this.hares.pop();
      this.scene.remove(h.root);
      h.dispose();
    }
    while (this.hares.length < n) {
      const h = new Hare(this.hareKit, this.hareTraits[this.hares.length], this);
      // Each starts somewhere in the open snow in view, sitting.
      for (let tries = 0; tries < 40; tries++) {
        const z = rnd(-6, -22), half = Math.min(10, -z * 0.5);
        const x = rnd(-half, half);
        if (!this.openSnow(x, z, 0.8) || this.hares.some((o) => Math.hypot(o.pos.x - x, o.pos.z - z) < 4)) continue;
        h.place(x, z, rnd(0, TAU));
        break;
      }
      h.timer = rnd(6, 20) + this.hares.length * 8;
      this.hares.push(h);
      this.scene.add(h.root);
    }
  }

  // MARK: - Input

  /** A ray from the eye through a screen point (points, y up from the bottom). */
  ray(pt) {
    const ndc = v3(pt.x / this.screenW * 2 - 1, pt.y / this.screenH * 2 - 1, 0.5);
    const dir = ndc.unproject(this.camera).sub(this.camera.position).normalize();
    return { origin: this.camera.position.clone(), dir };
  }

  /** Where a screen point meets the snow, or null for the sky. */
  groundHit(pt) {
    const { origin, dir } = this.ray(pt);
    if (dir.y > -0.002) return null;
    let t = (origin.y - 0) / -dir.y;
    for (let i = 0; i < 4; i++) {
      const p = origin.clone().addScaledVector(dir, t);
      const h = this.height(p.x, p.z);
      t = (origin.y - h) / -dir.y;
    }
    if (t > 400) return null;
    const p = origin.clone().addScaledVector(dir, t);
    p.y = this.height(p.x, p.z);
    return p;
  }

  /** The nearest trunk under a screen point, within 45 m, or null. */
  trunkHit(pt) {
    const base = { x: 0, y: 0 }, top = { x: 0, y: 0 };
    let best = null, bestD = Infinity;
    for (const t of this.grove.trees) {
      const dist = Math.hypot(t.x, t.z);
      if (dist > 45) continue;
      const b = this.project(this.grove.pointUp(t, 0), base);
      const u = this.project(this.grove.pointUp(t, 0.98), top);
      if (!b || !u) continue;
      // Distance from the point to the trunk's screen segment, against its screen width.
      const dx = u.x - b.x, dy = u.y - b.y, len2 = dx * dx + dy * dy;
      const s = len2 > 0 ? clamp(((pt.x - b.x) * dx + (pt.y - b.y) * dy) / len2, 0, 1) : 0;
      const px = b.x + dx * s, py = b.y + dy * s;
      const width = t.baseR * (1 - s * 0.7) * this.pixelScale / (this.app.pixelRatio || 1) / dist;
      const d = Math.hypot(pt.x - px, pt.y - py);
      if (d < width + 8 && dist < bestD) { bestD = dist; best = t; }
    }
    return best;
  }

  /** Screen position (points, y up) of a world point, or null if behind the camera. */
  project(p, out = { x: 0, y: 0 }) {
    const e = this.vp.elements;
    const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
    if (w <= 0.01) return null;
    out.x = ((e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / w * 0.5 + 0.5) * this.screenW;
    out.y = ((e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / w * 0.5 + 0.5) * this.screenH;
    return out;
  }

  click(pt, flushAllowed = true) {
    const tree = this.trunkHit(pt);
    if (tree) { this.grove.strike(tree); this.startle(this.grove.pointUp(tree, 0), 1); return; }
    const hit = this.groundHit(pt);
    if (!hit || hit.distanceTo(this.camera.position) > 60) return;
    if (flushAllowed && this.snowpack.inMap(hit.x, hit.z)) this.flushAt(hit);
    else { this.puffs.burst(hit.x, hit.y, hit.z, 0.08, 0.1); this.startle(hit, 0.6); }
  }

  /** The grouse bursts out of the snow at `p` (if it is roosting; otherwise a puff and a start). */
  flushAt(p) {
    // A click right against a trunk or a log flushes from the open snow beside it.
    if (!this.openSnow(p.x, p.z, 0.6)) {
      for (let r = 0.5; r <= 1.5 && !this.openSnow(p.x, p.z, 0.6); r += 0.5) {
        for (let a = 0; a < TAU; a += TAU / 8) {
          const q = v3(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
          if (this.openSnow(q.x, q.z, 0.6)) { p = q; p.y = this.height(q.x, q.z); break; }
        }
      }
    }
    if (this.grouse.flush(p)) { this.startle(p, 1.2); return; }
    this.puffs.burst(p.x, p.y, p.z, 0.12, 0.15);
    this.startle(p, 0.6);
  }

  flushSomewhere() {
    for (let tries = 0; tries < 40; tries++) {
      const z = rnd(-7, -24), half = Math.min(12, -z * 0.5);
      const x = rnd(-half, half);
      if (!this.openSnow(x, z, 0.8)) continue;
      this.flushAt(v3(x, this.height(x, z), z));
      return;
    }
  }

  /** Something sudden at `p`: the hares nearby react. */
  startle(p, strength) {
    for (const h of this.hares) h.startle(p, strength);
  }

  // MARK: - Wind

  /** The ambient wind at the crowns at (x, z), m/s. */
  windAt(x, z) {
    const t = this.time;
    const base = G.uWind.value;
    const wob = 0.7 + 0.5 * Math.sin(t * 0.05 + x * 0.02) * Math.sin(t * 0.031 + z * 0.03);
    let wx = base.x * wob, wz = base.y * wob;
    // A passing gust front, rolling across the grove from the west.
    const f = this.front;
    if (f) {
      const d = x - f.x;
      const k = Math.exp(-(d * d) / (f.w * f.w)) * f.s;
      wx += k; wz += k * 0.2;
    }
    return { x: wx, y: wz };
  }

  /** The air's velocity at a point, including the cursor's gusts (for snow in the air). */
  airAt(x, y, z, out) {
    const w = this.windAt(x, z);
    // Among the trunks the air is calm; the wind is up in the crowns.
    const low = 0.25 + 0.75 * smoothstep(2, 14, y - this.eyeY + EYE);
    out.set(w.x * low, 0, w.y * low);
    if (this.gusts.length) {
      const s = this.project({ x, y, z }, this.tmpScreen);
      if (s) {
        for (const g of this.gusts) {
          const dx = s.x - g.x, dy = s.y - g.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > g.r * g.r * 4) continue;
          const k = g.s * Math.exp(-d2 / (g.r * g.r));
          out.x += g.wx * k; out.y += g.wy * k; out.z += g.wz * k;
        }
      }
    }
    return out;
  }

  // MARK: - Frame

  applyCamera() {
    // `view` ({ fov, at }) is a testing aid: zoom in on a point to check detail.
    if (this.view) {
      this.camera.fov = this.view.fov;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.view.at);
    } else {
      if (this.camera.fov !== FOV) { this.camera.fov = FOV; this.camera.updateProjectionMatrix(); }
      this.camera.rotation.set(PITCH + this.pan.pitch, this.pan.yaw, 0);
    }
    this.camera.updateMatrixWorld();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pixelScale = h * (this.app.pixelRatio || 1) / (2 * Math.tan(FOV * Math.PI / 360));
  }

  applyLight() {
    const L = this.light;
    this.hemi.color.setRGB(L.sky.x, L.sky.y, L.sky.z);
    this.hemi.groundColor.setRGB(L.ground.x, L.ground.y, L.ground.z);
    this.hemi.intensity = L.hemi;
    this.sunLight.color.setRGB(L.sunColor.x, L.sunColor.y, L.sunColor.z);
    this.sunLight.intensity = L.sunI;
    this.sunLight.visible = L.sunI > 0.01;
    this.moonLight.color.setRGB(L.moonColor.x, L.moonColor.y, L.moonColor.z);
    this.moonLight.intensity = L.moonI;
    this.moonLight.visible = L.moonI > 0.01;
    this.scene.fog.color.setRGB(L.fog.x, L.fog.y, L.fog.z);
    // Falling snow closes the haze in; at night it closes in further.
    const snow = G.uSnowing.value;
    const near = lerp(lerp(12, 5, snow), 8, G.uNight.value), far = lerp(lerp(150, 70, snow), lerp(110, 60, snow), G.uNight.value);
    this.scene.fog.near = G.uFogNear.value = near;
    this.scene.fog.far = G.uFogFar.value = far;
    this.moon.update(G.uNight.value, G.uSun.value);
  }

  step(dt, pointer, settings) {
    this.time += dt;
    G.uTime.value = (G.uTime.value + dt) % TIME_WRAP;
    const c = this.cursor;

    // --- The cursor: speed, rest, attention ---------------------------------------------------
    if (pointer.inside) {
      if (c.last) {
        const dx = pointer.x - c.last.x, dy = pointer.y - c.last.y;
        const k = 1 - Math.exp(-dt / 0.08);
        c.vx += ((dt > 0 ? dx / dt : 0) - c.vx) * k;
        c.vy += ((dt > 0 ? dy / dt : 0) - c.vy) * k;
        if (Math.hypot(dx, dy) > 1.5) c.lastMove = this.time;
      }
      c.last = { x: pointer.x, y: pointer.y };
      c.x = pointer.x; c.y = pointer.y;
    } else {
      c.last = null;
      c.vx *= 0.8; c.vy *= 0.8;
    }
    c.speed = Math.hypot(c.vx, c.vy);
    c.rest = pointer.inside && c.speed < 40 ? c.rest + dt : 0;
    c.attention = pointer.inside && this.time - c.lastMove < 5 ? 1 : 0;

    // Pan the view a touch toward the cursor's side of the screen.
    const nx = pointer.inside ? clamp(pointer.x / this.screenW * 2 - 1, -1, 1) : 0;
    const ny = pointer.inside ? clamp(pointer.y / this.screenH * 2 - 1, -1, 1) : 0;
    this.pan.yaw = approach(this.pan.yaw, -nx * 0.035, 2.5, dt);
    this.pan.pitch = approach(this.pan.pitch, ny * 0.018, 2.5, dt);
    this.applyCamera();
    this.vp.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

    // --- Gusts from a fast cursor -------------------------------------------------------------
    this.gustTimer -= dt;
    if (pointer.inside && c.speed > 700 && this.gustTimer <= 0) {
      this.gustTimer = 0.05;
      const right = v3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = v3(0, 1, 0);
      const fwd = v3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0).normalize();
      const sp = Math.min(c.speed / 260, 5);
      const dir = right.multiplyScalar(c.vx / c.speed).addScaledVector(up, c.vy / c.speed * 0.6).addScaledVector(fwd, 0.35).normalize();
      this.gusts.push({ x: c.x, y: c.y, vx: c.vx * 0.3, vy: c.vy * 0.3, r: 150, s: sp, s0: sp, wx: dir.x, wy: dir.y, wz: dir.z, age: 0, life: 1.6 });
      if (this.gusts.length > 40) this.gusts.shift();
    }
    for (const g of this.gusts) {
      g.age += dt;
      g.x += g.vx * dt; g.y += g.vy * dt;
      g.vx *= Math.exp(-dt * 2); g.vy *= Math.exp(-dt * 2);
      g.r += 60 * dt;
      g.s = g.s0 * (1 - smoothstep(0.2, g.life, g.age));
    }
    this.gusts = this.gusts.filter((g) => g.age < g.life);

    // An ambient gust front now and then, rolling west to east through the crowns.
    this.frontTimer -= dt;
    if (!this.front && this.frontTimer <= 0) this.front = { x: -90, w: rnd(10, 22), s: rnd(1.6, 3.2), v: rnd(2.5, 4) };
    if (this.front) {
      this.front.x += this.front.v * dt;
      if (this.front.x > 90) { this.front = null; this.frontTimer = rnd(30, 90); }
    }

    // --- Trees: the cursor's gusts shake them -------------------------------------------------
    const pt = { x: 0, y: 0 };
    if (this.gusts.length) {
      for (const t of this.grove.trees) {
        if (Math.hypot(t.x, t.z) > 60) continue;
        const s = this.project(this.grove.pointUp(t, 0.7), pt);
        if (!s) continue;
        for (const g of this.gusts) {
          const dx = s.x - g.x, dy = s.y - g.y;
          const reach = g.r + 60;
          if (dx * dx + dy * dy > reach * reach) continue;
          const k = g.s * Math.exp(-(dx * dx + dy * dy) / (reach * reach)) * dt * 0.3 / Math.sqrt(t.height / 12);
          this.grove.shake(t, g.wx * k, g.wz * k + g.wy * k * 0.3);
        }
      }
    }
    const snowing = settings.snowfall;
    const shed = (t, amount, f) => {
      if (Math.hypot(t.x, t.z) > 80) return;
      const p = this.grove.pointUp(t, f);
      this.puffs.treeShed(p.x, p.y, p.z, t.maxR * 0.7, amount, { x: t.vx, z: t.vz });
    };
    this.grove.update(dt, (x, z) => this.windAt(x, z), snowing, shed);
    this.suckers.update(dt, (x, z) => this.windAt(x, z), snowing, () => {});
    this.sticks.update(dt, () => ({ x: 0, y: 0 }), snowing, () => {});

    // --- Creatures ------------------------------------------------------------------------------
    const hit = pointer.inside ? this.groundHit(c) : null;
    // The hare nearest the cursor's spot is the one that comes to look; the others watch.
    let nearestHare = null, nd = Infinity;
    if (hit) for (const h of this.hares) { const d = Math.hypot(h.pos.x - hit.x, h.pos.z - hit.z); if (d < nd) { nd = d; nearestHare = h; } }
    const info = { pointer, hit, rest: c.rest, speed: c.speed, attention: c.attention, x: c.x, y: c.y, nearestHare };
    for (const h of this.hares) h.update(dt, this, info);
    this.grouse.update(dt, this, info);

    // --- Sky and light ----------------------------------------------------------------------------
    this.weather.update(dt, settings, this.light, this.snowfall.amount);
    this.applyLight();

    // --- Snow -----------------------------------------------------------------------------------
    const air = (x, y, z, out) => this.airAt(x, y, z, out);
    this.snowfall.update(dt, air, snowing, this.pixelScale);
    this.puffs.update(dt, air, this.height, this.pixelScale);
    this.snowpack.update(dt, snowing);
  }

  dispose() {
    this.sky.dispose(); this.moon.dispose();
    this.snowpack.dispose(); this.horizon.dispose(); this.tufts.dispose();
    this.grove.dispose(); this.suckers.dispose(); this.sticks.dispose();
    for (const v of [...this.grove.variants, ...this.suckers.variants, ...this.sticks.variants]) { v.wood.dispose(); v.snow.dispose(); }
    for (const m of Object.values(this.treeMats)) m.dispose();
    this.snowfall.dispose(); this.puffs.dispose();
    for (const h of this.hares) h.dispose();
    this.hareKit.dispose();
    this.grouse.dispose();
    this.sunLight.shadow.map?.dispose();
    this.moonLight.shadow.map?.dispose();
  }
}
