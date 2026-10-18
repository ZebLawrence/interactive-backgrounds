// Aspen Snow — Falling snow, and the clumps and powder that fall from shaken trees, fly up where
// a hare bounds or a grouse bursts out of its roost.
//
// Real snowflakes fall at 0.5-1.5 m/s (dendrites are slowest), rocking and spiralling a few
// centimetres as they go, and follow the wind almost at once because they are so light. Snow
// dropped from a branch falls as clumps that break up into a drifting cloud of powder.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, v3, approach } from './util.js';
import { G } from './shaders.js';

const VERT = `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying float vAlpha;
varying float vBlur;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.05);
  // Projected size in pixels; tiny flakes keep their light by growing fainter, not vanishing.
  float px = aSize * uScale / dist;
  float shown = max(px, 2.0);
  vAlpha = aAlpha * min(1.0, (px * px) / (shown * shown));
  // Flakes right in front of the eye are out of focus: bigger, softer, fainter.
  float defocus = smoothstep(2.5, 0.4, dist);
  shown *= 1.0 + defocus * 2.5;
  vAlpha *= 1.0 - defocus * 0.75;
  vBlur = defocus;
  gl_PointSize = min(shown, 160.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform vec3 uColor;
varying float vAlpha;
varying float vBlur;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float a = mix(smoothstep(1.0, 0.35, r), smoothstep(1.0, 0.0, r) * 0.8, vBlur);
  if (a * vAlpha < 0.003) discard;
  gl_FragColor = vec4(uColor, a * vAlpha);
}`;

function pointsMaterial(blending = THREE.NormalBlending) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 }, uColor: { value: v3(0.7, 0.72, 0.76) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending,
  });
}

/** The colour of snow in the air: lit by the whole sky, a little brighter than the snow on the ground reads. */
function litSnow(out, gain) {
  const s = G.uSkyLight.value;
  return out.set(s.x, s.y, s.z).multiplyScalar(gain * 1.35);
}

// ---------------------------------------------------------------------------------------------

export class Snowfall {
  constructor(count, ground) {
    this.count = count;
    this.ground = ground;
    // Flakes live in a box in front of the viewer, from the eye out to 40 m.
    this.box = { x: 20, z0: 1.5, z1: -32, y: 11 };
    const pos = new Float32Array(count * 3), size = new Float32Array(count), alpha = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.fall = new Float32Array(count);
    this.wob = new Float32Array(count * 3);   // rocking rate, radius, phase
    this.base = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.respawn(pos, i, true);
      // Mostly aggregates of 3-8 mm; a fair few big, clumped flakes in a calm snowfall.
      const big = Math.random() < 0.3;
      size[i] = big ? rnd(0.013, 0.028) : rnd(0.005, 0.013);
      this.fall[i] = big ? rnd(0.7, 1.0) : rnd(0.45, 0.85);
      this.wob[i * 3] = rnd(0.6, 1.6) * TAU;
      this.wob[i * 3 + 1] = rnd(0.01, 0.05);
      this.wob[i * 3 + 2] = rnd(0, TAU);
      this.base[i] = rnd(0.55, 1);
      alpha[i] = 0;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = pointsMaterial();
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.amount = 0;           // 0..1, eased toward the setting
    this.t = 0;
  }

  respawn(pos, i, anywhere) {
    const b = this.box;
    const z = rnd(b.z1, b.z0);
    // Wider further out, so the box roughly fills the view.
    const half = 3 + (b.x - 3) * clamp(-z / 28, 0, 1);
    pos[i * 3] = rnd(-half, half);
    pos[i * 3 + 2] = z;
    pos[i * 3 + 1] = anywhere ? rnd(0, b.y) : b.y + rnd(0, 2);
  }

  /** `wind(x, y, z, out)` gives the air velocity at a point. */
  update(dt, wind, snowing, scale) {
    this.t += dt;
    // Snow comes and goes in heavier and lighter spells.
    const spell = 0.78 + 0.22 * Math.sin(this.t * 0.011) * Math.sin(this.t * 0.0071 + 1.3);
    this.amount = approach(this.amount, snowing ? spell : 0, 8, dt);
    const pos = this.geometry.attributes.position.array, alpha = this.geometry.attributes.aAlpha.array;
    const air = v3();
    const b = this.box;
    const active = this.amount;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      // Flakes past the active fraction fade out where they are rather than popping.
      const on = (i / this.count) < active ? 1 : 0;
      alpha[i] = approach(alpha[i], on * this.base[i], 1.5, dt);
      wind(pos[k], pos[k + 1], pos[k + 2], air);
      // Light flakes follow the air within a fraction of a second.
      const relax = 1 - Math.exp(-dt / 0.35);
      this.vel[k] += (air.x - this.vel[k]) * relax;
      this.vel[k + 2] += (air.z - this.vel[k + 2]) * relax;
      this.vel[k + 1] += (air.y - this.fall[i] - this.vel[k + 1]) * relax;
      const w = this.wob[k], r = this.wob[k + 1], ph = this.wob[k + 2] + this.t * w;
      pos[k] += (this.vel[k] + Math.cos(ph) * r * w) * dt;
      pos[k + 1] += this.vel[k + 1] * dt;
      pos[k + 2] += (this.vel[k + 2] + Math.sin(ph) * r * w) * dt;
      const z = pos[k + 2];
      const half = 3 + (b.x - 3) * clamp(-z / 28, 0, 1) + 2;
      const groundY = this.ground(pos[k], z);
      if (pos[k + 1] < groundY || z > b.z0 + 1 || z < b.z1 - 1 || Math.abs(pos[k]) > half + 2 || pos[k + 1] > b.y + 4) {
        this.respawn(pos, i, false);
        // Re-enter on the upwind side if the wind blew it out sideways.
        if (Math.abs(pos[k]) > half) pos[k] = -Math.sign(pos[k]) * half * 0.98;
        alpha[i] = 0;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.material.uniforms.uScale.value = scale;
    litSnow(this.material.uniforms.uColor.value, 1.0);
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------

export class Puffs {
  constructor(max = 3000) {
    this.max = max;
    const pos = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max);
    this.p = [];
    for (let i = 0; i < max; i++) this.p.push({ live: false, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 0, grow: 0, a: 0, clump: false, drag: 1 });
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = pointsMaterial();
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.next = 0;
    this.liveCount = 0;
  }

  spawn(o) {
    for (let n = 0; n < this.max; n++) {
      const i = (this.next + n) % this.max;
      const p = this.p[i];
      if (p.live) continue;
      Object.assign(p, { live: true, age: 0, drag: 1, grow: 0, clump: false }, o);
      this.next = (i + 1) % this.max;
      return p;
    }
    return null;
  }

  /** Snow falling from a tree: clumps that drop and break, and a veil of powder. */
  treeShed(x, y, z, r, amount, push) {
    const clumps = Math.round(clamp(amount * 60, 1, 10));
    for (let i = 0; i < clumps; i++) {
      const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * r;
      this.spawn({
        x: x + Math.cos(a) * d, y: y + rnd(-0.5, 0.5), z: z + Math.sin(a) * d,
        vx: push.x * 0.4 + rnd(-0.2, 0.2), vy: rnd(-0.6, 0), vz: push.z * 0.4 + rnd(-0.2, 0.2),
        life: rnd(2, 4), size: rnd(0.04, 0.09), a: 0.95, clump: true, drag: 0.15,
      });
    }
    const powder = Math.round(clamp(amount * 70, 2, 14));
    for (let i = 0; i < powder; i++) {
      const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * r;
      this.spawn({
        x: x + Math.cos(a) * d, y: y + rnd(-0.8, 0.8), z: z + Math.sin(a) * d,
        vx: push.x * 0.7 + rnd(-0.3, 0.3), vy: rnd(-0.4, 0.1), vz: push.z * 0.7 + rnd(-0.3, 0.3),
        life: rnd(3, 6.5), size: rnd(0.25, 0.6), grow: rnd(0.15, 0.35), a: rnd(0.05, 0.1), drag: 1.2,
      });
    }
  }

  /** Powder thrown up: by a bounding hare (small), a landing clump, or the grouse bursting out (big). */
  burst(x, y, z, strength, spread = 0.35, dir = null) {
    const n = Math.round(10 + strength * 70);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, TAU), up = rnd(0.6, 2.2) * strength;
      const out = rnd(0.2, 1.4) * strength;
      this.spawn({
        x: x + Math.cos(a) * spread * Math.random(), y: y + 0.02, z: z + Math.sin(a) * spread * Math.random(),
        vx: Math.cos(a) * out + (dir ? dir.x * strength : 0), vy: up, vz: Math.sin(a) * out + (dir ? dir.z * strength : 0),
        life: rnd(1.5, 4) * (0.5 + strength), size: rnd(0.05, 0.25) * (0.4 + strength), grow: rnd(0.08, 0.25) * strength,
        a: rnd(0.08, 0.2), drag: 1.6,
      });
    }
  }

  update(dt, wind, ground, scale) {
    const pos = this.geometry.attributes.position.array, size = this.geometry.attributes.aSize.array, alpha = this.geometry.attributes.aAlpha.array;
    const air = v3();
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (!p.live) { alpha[i] = 0; continue; }
      live++;
      p.age += dt;
      if (p.age > p.life) { p.live = false; alpha[i] = 0; continue; }
      wind(p.x, p.y, p.z, air);
      const k = 1 - Math.exp(-dt * p.drag);
      p.vx += (air.x - p.vx) * k;
      p.vz += (air.z - p.vz) * k;
      // Clumps fall like small stones; powder settles slowly.
      p.vy += (p.clump ? -9.8 * dt : (-0.35 - p.vy) * k);
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const gy = ground(p.x, p.z);
      if (p.y < gy) {
        if (p.clump) {
          // A clump bursts into a little powder where it lands.
          p.live = false;
          alpha[i] = 0;
          if (Math.random() < 0.5) this.spawn({ x: p.x, y: gy + 0.02, z: p.z, vx: rnd(-0.2, 0.2), vy: rnd(0.1, 0.4), vz: rnd(-0.2, 0.2), life: rnd(1, 2), size: 0.08, grow: 0.12, a: 0.2, drag: 2 });
          continue;
        }
        p.y = gy; p.vy = 0;
      }
      p.size += p.grow * dt;
      const f = p.age / p.life;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      size[i] = p.size;
      alpha[i] = p.a * smoothstep(0, 0.08, f) * (1 - smoothstep(0.55, 1, f));
    }
    this.liveCount = live;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.material.uniforms.uScale.value = scale;
    litSnow(this.material.uniforms.uColor.value, 0.6);
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
