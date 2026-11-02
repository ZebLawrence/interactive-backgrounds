// Hangar — Light rig: the level's fixtures as meshes and live lights, shadows, flicker and Emergency Power.
//
// Every fixture has a mesh: strips a housing and a glowing diffuser, lamps a shade with a glowing bulb on a
// cable to the ceiling, emergency fixtures a red lens. Live lights are fixed pools that follow the camera
// (lightplan.updateSlots), so the shader's light count never changes and nothing pops:
//   - RECT_SLOTS RectAreaLights for the nearest live strips (no shadows: three's area lights cannot cast them);
//   - LAMP_SLOTS SpotLights for the nearest live lamps, the first 4 (2 in Low Power) casting 2048 px shadows;
//   - RED_SLOTS red SpotLights for the nearest emergency points, at 0 unless Emergency Power is on.
// Far fixtures are their glowing mesh alone. Intensities are three r155+ physical units: SpotLight in candela,
// RectAreaLight in nits (cd/m²). Colours are kept in the lights, surfaces stay neutral (guidelines section 1):
// strips a cold fluorescent white, lamps warm sodium amber, emergency a deep red.

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { pickNearest, pickShadowCasters, updateSlots, flickerAt, emergencyPoints } from './lightplan.js';

export const RECT_SLOTS = 6;
export const LAMP_SLOTS = 6;
export const RED_SLOTS = 4;
export const SHADOW_CASTERS = 4;
export const SHADOW_CASTERS_LOW = 2;
const SLOT_FADE = 0.8; // s for a pooled light to fade in or out as the camera moves

const STRIP_COLOR = new THREE.Color().setRGB(0.82, 0.92, 1.0); // ~6500 K tube
const LAMP_COLOR = new THREE.Color().setRGB(1.0, 0.66, 0.34); // high-pressure sodium
const RED_COLOR = new THREE.Color().setRGB(1.0, 0.04, 0.02);
const STRIP_NITS = 140; // RectAreaLight luminance
const STRIP_WIDTH = 0.14; // m, the diffuser
const LAMP_CD = 150;
const LAMP_RANGE = 14; // m
const RED_CD = 140;
const RED_RANGE = 13;
const PULSE_HZ = 0.4;
// Glow of the meshes themselves (linear multipliers on an unlit colour; above 1 is "brighter than white").
const STRIP_GLOW = 6, LAMP_GLOW = 9, RED_GLOW = 1.6, RED_IDLE = 0.05;
// Fill: a low ambient keeps the darks dark (albedo x ~0.05) and the stand-in room reflection is kept dim so
// metal reflects something between highlights until the room probes (Task 9) replace it.
const AMBIENT = { normal: new THREE.Color().setRGB(0.55, 0.62, 0.75), emergency: new THREE.Color().setRGB(0.5, 0.08, 0.06) };
const AMBIENT_I = { normal: 0.16, emergency: 0.45 };
const ENV_I = { normal: 0.06, emergency: 0.012 };

let uniformsReady = false;
const smooth = (w) => w * w * (3 - 2 * w);

export class LightRig {
  /**
   * `scene` is the THREE.Scene, `plan` the output of planLights over annotateFixtures. `opts.level` (for
   * ceiling heights, so cables reach the ceiling) is optional.
   */
  constructor(scene, plan, opts = {}) {
    if (!uniformsReady) { RectAreaLightUniformsLib.init(); uniformsReady = true; }
    this.scene = scene;
    this.plan = plan;
    this.level = opts.level ?? null;
    this.time = 0;
    this.points = emergencyPoints(plan);
    this.group = new THREE.Group();
    this.group.name = 'lights';
    scene.add(this.group);

    this.housing = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.55, metalness: 0.6 });
    this.shadeMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.55, metalness: 0.6, side: THREE.DoubleSide });
    this.cableMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
    this.glows = plan.map((f) => this.buildFixture(f));
    this.beaconGlows = this.points.map((p) => (p.source === 'beacon' ? this.buildBeacon(p) : null));

    this.ambient = new THREE.AmbientLight(AMBIENT.normal, AMBIENT_I.normal);
    scene.add(this.ambient);

    const target = (l) => { scene.add(l.target); return l; };
    this.rects = Array.from({ length: RECT_SLOTS }, () => {
      const l = new THREE.RectAreaLight(STRIP_COLOR, 0, 1, STRIP_WIDTH);
      scene.add(l);
      return { light: l, id: null, w: 0, placed: null };
    });
    this.lamps = Array.from({ length: LAMP_SLOTS }, (_, k) => {
      const l = target(new THREE.SpotLight(LAMP_COLOR, 0, LAMP_RANGE, 1.0, 0.6, 2));
      l.castShadow = k < SHADOW_CASTERS;
      l.shadow.mapSize.set(2048, 2048);
      l.shadow.camera.near = 0.1;
      l.shadow.camera.far = LAMP_RANGE;
      // POM moves no depth, so the receiver is the flat polygon: a small bias and a normal offset keep acne off
      // the relief-mapped floors and walls without detaching the shadow of a step edge.
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.025;
      scene.add(l);
      return { light: l, id: null, w: 0, placed: null };
    });
    this.reds = Array.from({ length: RED_SLOTS }, () => {
      const l = target(new THREE.SpotLight(RED_COLOR, 0, RED_RANGE, 1.45, 0.9, 2));
      scene.add(l);
      return { light: l, id: null, w: 0, placed: null };
    });
    this.lowPower = null;
    this.setLowPower(false);
  }

  ceilAt(f) {
    const s = this.level?.byId?.get(f.sector);
    return s && !s.tags.has('sky') ? s.ceil : null;
  }

  glowMat(color) {
    const m = new THREE.MeshBasicMaterial({ color: color.clone() });
    m.userData.base = color.clone();
    return m;
  }

  /** A vertical cable (or hanger rod) from y0 up to the ceiling, if there is one above. */
  cable(x, y0, z, ceil, r = 0.006) {
    if (ceil === null || ceil - y0 < 0.02) return;
    const h = ceil - y0;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), this.cableMat);
    m.position.set(x, y0 + h / 2, z);
    this.group.add(m);
  }

  buildFixture(f) {
    const ceil = this.ceilAt(f);
    if (f.kind === 'strip') {
      const len = f.len ?? 1.2;
      const g = new THREE.Group();
      g.position.set(f.x, f.y, f.z);
      const d = f.dir ?? [1, 0, 0];
      g.rotation.y = Math.atan2(-d[2], d[0]);
      const box = new THREE.Mesh(new THREE.BoxGeometry(len + 0.08, 0.09, 0.2), this.housing);
      box.position.y = 0.05;
      const mat = this.glowMat(STRIP_COLOR);
      const diff = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, STRIP_WIDTH), mat);
      diff.position.y = 0.0;
      g.add(box, diff);
      this.group.add(g);
      g.updateMatrixWorld(true);
      // Hangers where the strip hangs below the ceiling.
      if (ceil !== null && ceil - (f.y + 0.095) > 0.03) {
        for (const s of [-0.4, 0.4]) {
          const p = new THREE.Vector3(s * len, 0.095, 0).applyMatrix4(g.matrixWorld);
          this.cable(p.x, p.y, p.z, ceil, 0.008);
        }
      }
      return { mat, glow: STRIP_GLOW };
    }
    if (f.kind === 'lamp') {
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.22, 0.2, 24, 1, true), this.shadeMat);
      shade.position.set(f.x, f.y + 0.1, f.z);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 16), this.housing);
      cap.position.set(f.x, f.y + 0.21, f.z);
      const mat = this.glowMat(LAMP_COLOR);
      const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), mat);
      bulb.rotation.x = Math.PI / 2; // faces down
      bulb.position.set(f.x, f.y + 0.02, f.z);
      this.group.add(shade, cap, bulb);
      this.cable(f.x, f.y + 0.23, f.z, ceil);
      return { mat, glow: LAMP_GLOW };
    }
    // Emergency fixture: a small housing with a red lens underneath.
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.14), this.housing);
    box.position.set(f.x, f.y + 0.06, f.z);
    const mat = this.glowMat(RED_COLOR);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.1), mat);
    lens.position.set(f.x, f.y, f.z);
    this.group.add(box, lens);
    this.cable(f.x, f.y + 0.11, f.z, ceil, 0.01);
    return { mat, glow: RED_GLOW, red: true };
  }

  buildBeacon(p) {
    const mat = this.glowMat(RED_COLOR);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.07), mat);
    lens.position.set(p.x, p.y, p.z);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.09), this.housing);
    back.position.set(p.x, p.y + 0.04, p.z);
    this.group.add(lens, back);
    return mat;
  }

  /** Low Power: 2 shadow casters instead of 4 (the other slots light without shadows). */
  setLowPower(on) {
    if (this.lowPower === on) return;
    this.lowPower = on;
    const n = on ? SHADOW_CASTERS_LOW : SHADOW_CASTERS;
    this.lamps.forEach((s, k) => {
      s.light.castShadow = k < n;
      if (!s.light.castShadow && s.light.shadow.map) { s.light.shadow.map.dispose(); s.light.shadow.map = null; }
    });
    this.nShadow = n;
  }

  /** Brightness of fixture i right now, before Emergency Power: 0 dead, flicker for failing tubes. */
  liveness(i) {
    const f = this.plan[i];
    return f.dead ? 0 : flickerAt(f.flicker, this.time);
  }

  /**
   * dt in s, camPos {x, y, z}, emergency 0..1 (already eased by the caller), lowPower boolean, camDir an
   * optional view direction (lamps in front are preferred as shadow casters).
   */
  update(dt, camPos, emergency, lowPower, camDir = null) {
    this.time += dt;
    this.setLowPower(!!lowPower);
    const e = Math.min(1, Math.max(0, emergency || 0));
    const main = 1 - e;
    const pulse = 0.8 + 0.2 * Math.sin(2 * Math.PI * PULSE_HZ * this.time);
    const plan = this.plan;

    // Glowing meshes.
    plan.forEach((f, i) => {
      const g = this.glows[i];
      const k = g.red ? RED_IDLE + (RED_GLOW * pulse - RED_IDLE) * e : g.glow * this.liveness(i) * main;
      // A dead or switched-off tube is dull glass, not black.
      g.mat.color.copy(g.mat.userData.base).multiplyScalar(Math.max(k, g.red ? 0 : 0.035));
    });
    this.beaconGlows.forEach((m) => { if (m) m.color.copy(m.userData.base).multiplyScalar(RED_IDLE + (RED_GLOW * 0.6 * pulse - RED_IDLE) * e); });

    // Strips: nearest live strips get the area lights.
    updateSlots(this.rects, pickNearest(plan, camPos, RECT_SLOTS, (f) => f.kind === 'strip' && !f.dead), dt, SLOT_FADE);
    for (const s of this.rects) {
      const l = s.light;
      if (s.id === null) { l.intensity = 0; continue; }
      const f = plan[s.id];
      if (s.placed !== s.id) {
        l.width = f.len ?? 1.2;
        l.height = STRIP_WIDTH;
        l.position.set(f.x, f.y - 0.012, f.z);
        const d = f.dir ?? [1, 0, 0];
        const h = Math.hypot(d[0], d[2]) || 1;
        const xa = new THREE.Vector3(d[0] / h, 0, d[2] / h), za = new THREE.Vector3(0, 1, 0);
        const ya = new THREE.Vector3().crossVectors(za, xa);
        l.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xa, ya, za)); // -z (emitting) points down
        s.placed = s.id;
      }
      l.intensity = STRIP_NITS * smooth(s.w) * this.liveness(s.id) * main;
    }

    // Lamps: the first nShadow slots cast shadows and take the best-placed lamps; the rest take the next ones.
    const ranked = pickShadowCasters(plan, camPos, LAMP_SLOTS, camDir);
    updateSlots(this.lamps.slice(0, this.nShadow), ranked.slice(0, this.nShadow), dt, SLOT_FADE);
    updateSlots(this.lamps.slice(this.nShadow), ranked.slice(this.nShadow), dt, SLOT_FADE);
    for (const s of this.lamps) {
      const l = s.light;
      if (s.id === null) { l.intensity = 0; continue; }
      const f = plan[s.id];
      if (s.placed !== s.id) {
        l.position.set(f.x, f.y - 0.03, f.z);
        l.target.position.set(f.x, f.y - 5, f.z);
        l.target.updateMatrixWorld();
        s.placed = s.id;
      }
      l.intensity = LAMP_CD * smooth(s.w) * this.liveness(s.id) * main;
    }

    // Emergency: the nearest red points, only while Emergency Power is on (the pool still tracks the camera
    // when off, so turning it on fades in the right lights).
    updateSlots(this.reds, pickNearest(this.points, camPos, RED_SLOTS), dt, SLOT_FADE);
    for (const s of this.reds) {
      const l = s.light;
      if (s.id === null) { l.intensity = 0; continue; }
      const p = this.points[s.id];
      if (s.placed !== s.id) {
        l.position.set(p.x, p.y - 0.05, p.z);
        l.target.position.set(p.x, p.y - 5, p.z);
        l.target.updateMatrixWorld();
        s.placed = s.id;
      }
      l.intensity = RED_CD * smooth(s.w) * e * pulse * (p.source === 'beacon' ? 0.8 : 1);
    }

    this.ambient.color.lerpColors(AMBIENT.normal, AMBIENT.emergency, e);
    this.ambient.intensity = AMBIENT_I.normal + (AMBIENT_I.emergency - AMBIENT_I.normal) * e;
    this.scene.environmentIntensity = ENV_I.normal + (ENV_I.emergency - ENV_I.normal) * e;
  }

  dispose() {
    for (const s of [...this.lamps, ...this.reds]) s.light.shadow?.dispose?.();
  }
}
