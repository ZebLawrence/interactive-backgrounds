// Boreal Night — The scene: a clearing in the spruce under the aurora. Lays out the forest and the
// perches, owns the camera and the lights, turns the cursor into gusts, glances and rustles, and
// steps every system.
//
// Units are metres. The viewer stands at the south edge of a snowy muskeg clearing at the origin,
// eye 1.6 m above the snow, looking north (-z) across the bog to the far tree line, with the
// aurora over it. East is +x.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, noise2, v3, approach, seeded, TIME_WRAP } from './util.js';
import { G } from './shaders.js';
import { Sky, Moon, Meteors } from './sky.js';
import { Aurora } from './aurora.js';
import { Snowpack, Horizon, makeHeight, cacheHeight, bakeCanopy, PRINTS } from './ground.js';
import { buildSpruce, buildSnag, makeTreeMaterials, Forest } from './spruce.js';
import { Snowfall, Puffs } from './snow.js';
import { Owl, makeOwlKit, makeTraits } from './owl.js';

export const OWLS = { one: 1, pair: 2, three: 3 };

const EYE = 1.6;
const PITCH = 0.15;
const FOV = 50;
const CLEARING = { x: 0, z: -40 };

export class Boreal {
  constructor(app, w, h, settings) {
    this.app = app;
    this.screenW = w;
    this.screenH = h;
    this.settings = settings;
    this.seed = Math.floor(Math.random() * 1e9);
    const rng = seeded(this.seed);
    this.rng = rng;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), 40, 900);
    this.scene.fog.color.setRGB(...G.uFogColor.value.toArray());

    // --- Layout -----------------------------------------------------------------------------
    const layout = this.layout(rng);
    this.exactHeight = makeHeight(layout.wells);
    this.height = cacheHeight(this.exactHeight);
    for (const t of layout.trees) t.y = this.height(t.x, t.z) - 0.05;
    this.eyeY = this.height(0, 0) + EYE;

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.15, 200000);
    this.camera.position.set(0, this.eyeY, 0);
    this.camera.rotation.order = 'YXZ';
    this.pan = { yaw: 0, pitch: 0 };
    this.applyCamera();

    // --- Sky --------------------------------------------------------------------------------
    this.sky = new Sky();
    this.moon = new Moon();
    this.meteors = new Meteors();
    this.aurora = new Aurora();
    this.scene.add(this.sky.mesh, this.moon.group, this.meteors.mesh, this.aurora.group);

    // --- Ground -----------------------------------------------------------------------------
    this.snowpack = new Snowpack(this.height);
    this.horizon = new Horizon(this.exactHeight);
    this.scene.add(this.snowpack.mesh, this.horizon.group);

    // --- Trees ------------------------------------------------------------------------------
    this.treeMats = makeTreeMaterials();
    this.forest = new Forest(layout.variants, layout.trees, this.treeMats);
    this.scene.add(this.forest.group);
    this.perches = layout.perches;

    // --- Snow in the air ----------------------------------------------------------------------
    this.snowfall = new Snowfall(7000, this.height);
    this.puffs = new Puffs(3500);
    this.scene.add(this.snowfall.points, this.puffs.points);

    // --- Lights ------------------------------------------------------------------------------
    const moonLight = new THREE.DirectionalLight(new THREE.Color(0.72, 0.8, 1.0), 1.0);
    moonLight.position.copy(G.uMoonDir.value).multiplyScalar(160).add(v3(0, 0, -26));
    moonLight.target.position.set(0, 0, -26);
    moonLight.castShadow = true;
    const sc = moonLight.shadow.camera;
    sc.left = -42; sc.right = 42; sc.top = 42; sc.bottom = -42; sc.near = 20; sc.far = 340;
    moonLight.shadow.mapSize.set(4096, 4096);
    moonLight.shadow.bias = -0.0004;
    moonLight.shadow.normalBias = 0.05;
    this.moonLight = moonLight;
    this.hemi = new THREE.HemisphereLight(new THREE.Color(0.05, 0.07, 0.14), new THREE.Color(0.05, 0.06, 0.09), 1.0);
    this.scene.add(moonLight, moonLight.target, this.hemi);
    this.bakeShadows(rng);

    // --- Owls ---------------------------------------------------------------------------------
    this.owlKit = makeOwlKit();
    // Three individuals for the night, so adding owls brings in different birds.
    this.owlTraits = makeTraits(rng, 3);
    this.owls = [];
    this.setOwls(settings.owls);

    // --- Cursor -------------------------------------------------------------------------------
    this.cursor = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, rest: 0, last: null, attention: 0, lastMove: -100 };
    this.gusts = [];
    this.gustTimer = 0;
    this.front = null;
    this.frontTimer = rnd(25, 60);
    this.pendingVoles = [];
    this.vp = new THREE.Matrix4();
    this.time = 0;
    G.uMoon.value = settings.moonlight ? 1 : 0;
    // Start with a little settled sway so nothing is frozen on the first frame.
    for (let i = 0; i < 30; i++) this.forest.update(1 / 30, (x, z) => this.windAt(x, z), false, () => {});
  }

  // MARK: - Layout

  layout(rng) {
    const R = (lo, hi) => lo + rng() * (hi - lo);
    // Tree variants: tall spruce near, a few saplings for the bog, simpler ones far off.
    const variants = [];
    // Near trees: four full white spruce and three slender black spruce.
    for (let i = 0; i < 7; i++) variants.push(buildSpruce(rng, R(8, 15), 1, { black: i >= 4 }));
    const saplingStart = variants.length;
    for (let i = 0; i < 3; i++) variants.push(buildSpruce(rng, R(1.6, 3.8), 1, { black: true }));
    const midStart = variants.length;
    for (let i = 0; i < 4; i++) variants.push(buildSpruce(rng, R(8, 15), 0.6));
    const farStart = variants.length;
    for (let i = 0; i < 4; i++) {
      const v = buildSpruce(rng, R(8, 14), 0.35);
      v.castShadow = false;
      variants.push(v);
    }
    const snagStart = variants.length;
    const snagDefs = [
      { x: R(-4.2, -2.8), z: R(-10.5, -8.5), h: R(3.6, 4.3) },
      { x: R(5.5, 7.5), z: R(-19, -16), h: R(4.6, 5.6) },
      { x: R(-15, -12.5), z: R(-27, -23), h: R(5.8, 6.8) },
    ];
    for (const s of snagDefs) variants.push(buildSnag(rng, s.h));

    const trees = [];
    const wells = [];
    const taken = [];
    const free = (x, z, r) => taken.every((p) => Math.hypot(p.x - x, p.z - z) > r + p.r);
    const clearR = (x, z) => {
      const a = Math.atan2(z - CLEARING.z, x - CLEARING.x);
      return 31 + 6 * Math.sin(a * 2 + 1.3) + 4 * Math.sin(a * 3 + 0.4) + 3 * noise2(Math.cos(a) * 2 + 5, Math.sin(a) * 2);
    };
    const add = (t) => { trees.push(t); taken.push({ x: t.x, z: t.z, r: t.r }); };

    // The snags first, each a perch.
    snagDefs.forEach((s, i) => {
      add({ x: s.x, z: s.z, rot: R(0, TAU), scale: 1, variant: snagStart + i, load: 1, r: 1.5, snag: true });
    });
    // Big spruce framing the view either side of the viewer.
    const framing = [[-7.5, -5.5], [-11.5, -13], [-6.5, -19], [8.5, -4.5], [12, -12], [15.5, -21], [-17, -8], [19, -7]];
    for (const [x, z] of framing) {
      const fx = x + R(-1, 1), fz = z + R(-1, 1);
      add({ x: fx, z: fz, rot: R(0, TAU), scale: R(0.95, 1.2), variant: Math.floor(R(0, 4)), load: R(0.7, 1), r: 2 });
    }
    // The forest round the clearing, thinning into the bog.
    let near = 0, far = 0;
    for (let gz = -240; gz < 6; gz += 2.4) {
      for (let gx = -170; gx < 170; gx += 2.4) {
        const x = gx + R(-1, 1), z = gz + R(-1, 1);
        const dist = Math.hypot(x, z);
        const az = Math.atan2(x, -z);
        if (z > 4 || (Math.abs(az) > 1.3 && dist > 22)) continue;
        // Keep the view open in front of the viewer.
        if (z < 2 && z > -16 && Math.abs(x) < 4.5 + -z * 0.25) continue;
        const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z) - clearR(x, z);
        const patch = noise2(x / 18 + 3, z / 18 + 9);
        if (dc < 0) {
          // Stunted black spruce dotted about the bog.
          if (rng() < 0.012 && dist > 7 && free(x, z, 1)) add({ x, z, rot: R(0, TAU), scale: R(0.7, 1.2), variant: saplingStart + Math.floor(R(0, 3)), load: R(0.85, 1), r: 0.8 });
          continue;
        }
        const keep = smoothstep(0, 10, dc) * (0.35 + 0.65 * patch) * (dist < 70 ? 0.6 : 0.45);
        if (rng() > keep) continue;
        const isNear = dist < 70;
        if (isNear && near > 130) continue;
        if (!isNear && far > 650) continue;
        if (!free(x, z, isNear ? 1.6 : 1.4)) continue;
        if (isNear) near++; else far++;
        add({
          x, z, rot: R(0, TAU), scale: R(0.85, 1.15),
          variant: dist < 32 ? Math.floor(R(0, 7)) : isNear ? midStart + Math.floor(R(0, 4)) : farStart + Math.floor(R(0, 4)),
          load: R(0.55, 1), r: isNear ? 1.6 : 1.4,
        });
      }
    }
    // Tree wells under the near trees.
    for (const t of trees) {
      const v = variants[t.variant];
      if (Math.hypot(t.x, t.z) < 120) wells.push({ x: t.x, z: t.z, r: Math.max(0.6, v.maxR * t.scale * 0.85), depth: t.snag ? 0.12 : 0.22 * Math.min(1, v.height / 6) });
    }
    // Perches: the snags' broken tops and the leaders of a few spruce at the clearing's edge.
    const perches = trees.filter((t) => t.snag).map((t) => ({ tree: t, kind: 'snag', owl: null }));
    const tips = trees.filter((t) => !t.snag && t.variant < 7 && Math.hypot(t.x, t.z) > 10 && Math.hypot(t.x, t.z) < 34 && Math.abs(Math.atan2(t.x, -t.z)) < 0.7)
      .sort((a, b) => variants[a.variant].height * a.scale - variants[b.variant].height * b.scale);
    for (const t of tips.slice(0, 3)) perches.push({ tree: t, kind: 'tip', owl: null });
    return { variants, trees, wells, perches };
  }

  /**
   * Bake the moon shadows of every tree outside the shadow map (and of the far tree line) onto
   * the snow, so the ground darkens toward the horizon the way the forest does.
   */
  bakeShadows(rng) {
    const light = this.moonLight;
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    light.shadow.updateMatrices(light);
    const cam = light.shadow.camera;
    const inMap = (p) => {
      const q = p.clone().applyMatrix4(cam.matrixWorldInverse);
      return q.x > cam.left && q.x < cam.right && q.y > cam.bottom && q.y < cam.top;
    };
    const casters = [];
    for (const t of this.forest.trees) {
      const v = this.forest.variants[t.variant];
      const real = v.castShadow !== false && inMap(v3(t.x, t.y, t.z)) && inMap(v3(t.x, t.y + t.height, t.z));
      if (!real) casters.push({ x: t.x, z: t.z, height: t.height, crownBase: t.crownBase, maxR: t.maxR });
    }
    // The spires of the far tree line, 260 m out.
    for (let a = -1.4; a < 1.4; a += 0.006 + rng() * 0.008) {
      const d = 258 + rng() * 6;
      casters.push({ x: Math.sin(a) * d, z: -Math.cos(a) * d, height: 5 + rng() * 8, crownBase: 0.5, maxR: 0.9 + rng() * 0.6 });
    }
    this.snowpack.setCanopy(bakeCanopy(casters, G.uMoonDir.value));
  }

  /** Where an owl sits on a perch, following the tree's sway. */
  perchPoint(perch) {
    const t = perch.tree;
    if (perch.kind === 'snag') {
      const top = this.forest.variants[t.variant].top;
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      return v3(t.x + top.x * c + top.z * s, t.y + top.y, t.z - top.x * s + top.z * c);
    }
    return this.forest.pointUp(t, 0.985).add(v3(0, -0.12, 0));
  }

  heightAt(x, z) { return this.height(x, z); }

  // MARK: - Owls

  setOwls(name) {
    const n = OWLS[name] ?? 1;
    while (this.owls.length > n) {
      const o = this.owls.pop();
      if (o.perch) o.perch.owl = null;
      this.scene.remove(o.root);
      o.dispose();
    }
    while (this.owls.length < n) {
      const o = new Owl(this.owlKit, this.owlTraits[this.owls.length]);
      // The first owl takes the nearest snag; others the free perches in order.
      const perch = this.perches.find((p) => !p.owl);
      if (!perch) break;
      perch.owl = o;
      o.perch = perch;
      o.root.position.copy(this.perchPoint(perch));
      // Facing out over the clearing, roughly toward the viewer.
      o.yaw = Math.atan2(-o.root.position.x, -o.root.position.z) + rnd(-0.5, 0.5);
      o.timer = rnd(20, 60) + this.owls.length * 25;
      this.owls.push(o);
      this.scene.add(o.root);
    }
  }

  freeOwl(p) {
    let best = null, bestD = Infinity;
    for (const o of this.owls) {
      if (o.state !== 'perch') continue;
      const d = o.root.position.distanceTo(p);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  selfHunt(owl) {
    const from = owl.root.position;
    for (let tries = 0; tries < 20; tries++) {
      const z = rnd(-8, -30), half = Math.min(15, -z * 0.55);
      const x = rnd(-half, half);
      if (Math.hypot(x - from.x, z - from.z) > 24) continue;
      if (!this.inPrints(x, z) || !this.openSnow(x, z)) continue;
      owl.hunt(v3(x, this.height(x, z), z));
      return;
    }
    this.relocate(owl);
  }

  relocate(owl) {
    const options = this.perches.filter((p) => !p.owl && p !== owl.perch);
    if (!options.length) return;
    owl.goTo(options[Math.floor(Math.random() * options.length)], this);
  }

  choosePerch(owl, near = null) {
    const ref = near ?? owl.root.position;
    const options = this.perches.filter((p) => !p.owl || p.owl === owl);
    options.sort((a, b) => this.perchPoint(a).distanceTo(ref) - this.perchPoint(b).distanceTo(ref));
    // Usually the nearest, sometimes the next.
    return options[Math.random() < 0.7 ? 0 : Math.min(1, options.length - 1)];
  }

  strike(owl, x, z, yaw) {
    // The print map's heading runs from +x toward +z.
    const heading = Math.atan2(Math.cos(yaw), Math.sin(yaw));
    this.snowpack.stampStrike(x, z, heading);
    this.burstAt(x, this.height(x, z), z, 1);
  }

  burstAt(x, y, z, strength) { this.puffs.burst(x, y, z, strength); }

  inPrints(x, z) {
    return x > PRINTS.x0 + 1 && x < PRINTS.x0 + PRINTS.size - 1 && z > PRINTS.z0 + 1 && z < PRINTS.z0 + PRINTS.size - 1;
  }

  /** Not under a tree. */
  openSnow(x, z) {
    return this.forest.trees.every((t) => Math.hypot(t.x - x, t.z - z) > (t.snag ? 0.8 : t.maxR + 0.4) || Math.hypot(t.x, t.z) > 60);
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
    if (t > 600) return null;
    const p = origin.clone().addScaledVector(dir, t);
    p.y = this.height(p.x, p.z);
    return p;
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

  click(pt) {
    const hit = this.groundHit(pt);
    if (!hit || hit.distanceTo(this.camera.position) > 60 || !this.inPrints(hit.x, hit.z)) {
      // The sky: a bright surge starts on the aurora there.
      const { dir } = this.ray(pt);
      if (dir.y > 0.03) this.aurora.flare(dir);
      return;
    }
    this.rustle(hit);
  }

  /** A vole stirs under the snow at `p`: the nearest owl hears it. */
  rustle(p) {
    this.snowpack.stampRustle(p.x, p.z);
    this.puffs.burst(p.x, p.y, p.z, 0.05, 0.06);
    const owl = this.freeOwl(p);
    if (owl) owl.hunt(p);
    else if (this.pendingVoles.length < 3) this.pendingVoles.push({ p, t: 8 });
  }

  huntSomewhere() {
    for (let tries = 0; tries < 30; tries++) {
      const z = rnd(-8, -26), half = Math.min(14, -z * 0.5);
      const x = rnd(-half, half);
      if (!this.inPrints(x, z) || !this.openSnow(x, z)) continue;
      this.rustle(v3(x, this.height(x, z), z));
      return;
    }
  }

  substorm() { this.aurora.substorm(); }

  // MARK: - Wind

  /** The ambient wind near the tree tops at (x, z), m/s. */
  windAt(x, z) {
    const t = this.time;
    const base = G.uWind.value;
    const wob = 0.7 + 0.5 * Math.sin(t * 0.05 + x * 0.02) * Math.sin(t * 0.031 + z * 0.03);
    let wx = base.x * wob, wz = base.y * wob;
    // A passing gust front, rolling across the clearing from the west.
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
    const low = 0.35 + 0.65 * smoothstep(0, 10, y - this.eyeY + EYE);
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
    this.tmpScreen = { x: 0, y: 0 };

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

    // An ambient gust front now and then, rolling west to east across the clearing.
    this.frontTimer -= dt;
    if (!this.front && this.frontTimer <= 0) this.front = { x: -90, w: rnd(10, 22), s: rnd(1.8, 3.4), v: rnd(2.5, 4) };
    if (this.front) {
      this.front.x += this.front.v * dt;
      if (this.front.x > 90) { this.front = null; this.frontTimer = rnd(30, 90); }
    }

    // --- Trees: the cursor's gusts shake them -------------------------------------------------
    const pt = { x: 0, y: 0 };
    if (this.gusts.length) {
      for (const t of this.forest.trees) {
        if (t.snag || Math.hypot(t.x, t.z) > 70) continue;
        const s = this.project(this.forest.pointUp(t, 0.6), pt);
        if (!s) continue;
        for (const g of this.gusts) {
          const dx = s.x - g.x, dy = s.y - g.y;
          const reach = g.r + 60;
          if (dx * dx + dy * dy > reach * reach) continue;
          const k = g.s * Math.exp(-(dx * dx + dy * dy) / (reach * reach)) * dt * 2.2 / Math.sqrt(t.height / 8);
          this.forest.shake(t, g.wx * k, g.wz * k + g.wy * k * 0.3);
        }
      }
    }
    const snowing = settings.snowfall;
    this.forest.update(dt, (x, z) => this.windAt(x, z), snowing, (t, amount) => {
      if (Math.hypot(t.x, t.z) > 80) return;
      const mid = this.forest.pointUp(t, 0.55);
      this.puffs.treeShed(mid.x, mid.y, mid.z, t.maxR * 0.8, amount, { x: t.vx, z: t.vz });
    });

    // --- Owls -----------------------------------------------------------------------------------
    const hit = pointer.inside ? this.groundHit(c) : null;
    const cursorRay = pointer.inside && (c.attention || c.rest > 0.3) ? this.ray(c) : null;
    for (const o of this.owls) {
      const head = o.headWorld();
      const s = this.project(head, pt);
      const near = s && pointer.inside ? Math.hypot(s.x - c.x, s.y - c.y) : Infinity;
      const stare = near < 70;
      // A fast cursor sweeping past alarms it; again and again, and it leaves.
      if (near < 170 && c.speed > 900 && o.state === 'perch') {
        o.alarm = Math.min(2, o.alarm + dt * 3);
        if (o.alarm > 1.3 && o.cooldown <= 0) {
          const away = hit ?? this.camera.position;
          const options = this.perches.filter((p) => !p.owl);
          options.sort((a, b) => this.perchPoint(b).distanceTo(away) - this.perchPoint(a).distanceTo(away));
          if (options.length) { o.goTo(options[0], this); o.cooldown = 20; o.alarm = 0; }
        }
      }
      // A resting cursor, held a while over the snow somewhere else: it moves closer to look.
      if (o.state === 'perch' && c.rest > 6 && hit && o.cooldown <= 0) {
        const best = this.choosePerch(o, hit);
        const cur = this.perchPoint(o.perch).distanceTo(hit);
        if (best && best !== o.perch && this.perchPoint(best).distanceTo(hit) < cur - 6) {
          o.goTo(best, this);
          o.cooldown = 30;
        } else o.cooldown = 3;
      }
      // The owl follows the cursor as if it were something moving between it and the viewer: a
      // point on the cursor's ray, short of the owl, so its face swings toward us as it watches.
      let point = null;
      if (stare) point = this.camera.position;
      else if (cursorRay) point = cursorRay.origin.clone().addScaledVector(cursorRay.dir, head.distanceTo(this.camera.position) * 0.6);
      o.update(dt, this, { point, stare, attention: c.attention });
    }
    // Voles waiting for a free owl.
    for (const v of this.pendingVoles) v.t -= dt;
    this.pendingVoles = this.pendingVoles.filter((v) => {
      if (v.t <= 0) return false;
      const owl = this.freeOwl(v.p);
      if (owl) { owl.hunt(v.p); return false; }
      return true;
    });

    // --- Sky and light ----------------------------------------------------------------------------
    G.uMoon.value = approach(G.uMoon.value, settings.moonlight ? 1 : 0, 1.2, dt);
    this.moon.update(G.uMoon.value);
    this.moonLight.intensity = 1.15 * G.uMoon.value;
    this.moonLight.visible = G.uMoon.value > 0.01;
    this.aurora.update(dt, this.camera);
    const a = G.uAuroraLight.value;
    this.hemi.color.setRGB(0.035 + a.x * 0.8, 0.05 + a.y * 0.8, 0.11 + a.z * 0.8);
    // Moonlit snow throws a lot of light back up: it fills the undersides of the boughs and the
    // owl's face, which would otherwise be in its own shadow with the moon behind it.
    const m = G.uMoon.value;
    this.hemi.groundColor.setRGB(0.03 + 0.1 * m + a.x * 0.8, 0.035 + 0.115 * m + a.y * 0.8, 0.05 + 0.16 * m + a.z * 0.8);
    this.meteors.update(dt);

    // --- Snow -----------------------------------------------------------------------------------
    const air = (x, y, z, out) => this.airAt(x, y, z, out);
    this.snowfall.update(dt, air, snowing, this.pixelScale);
    this.puffs.update(dt, air, this.height, this.pixelScale);
    this.snowpack.update(dt, snowing);
  }

  dispose() {
    this.sky.dispose(); this.moon.dispose(); this.meteors.dispose(); this.aurora.dispose();
    this.snowpack.dispose(); this.horizon.dispose(); this.forest.dispose();
    for (const v of this.forest.variants) { v.wood.dispose(); v.snow.dispose(); }
    for (const m of Object.values(this.treeMats)) m.dispose();
    this.snowfall.dispose(); this.puffs.dispose();
    for (const o of this.owls) o.dispose();
    this.owlKit.dispose();
    this.moonLight.shadow.map?.dispose();
  }
}
