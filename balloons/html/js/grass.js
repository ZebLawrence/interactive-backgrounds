// Balloon Dawn — Long grass on the knoll in the foreground: instanced blades that bend in the
// prevailing wind and in the cursor's gusts, lit low and warm by the rising sun.

import * as THREE from 'three';
import { TAU, rnd, Art } from './util.js';
import { G, Q, FOG_HEAD } from './shaders.js';

function bladeGeometry(rows = 4) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    pos.push(-0.5, t, 0, 0.5, t, 0);
    uv.push(0, t, 1, t);
  }
  for (let r = 0; r < rows; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Grass {
  /** @param {object} layout  { halfWidth(d), groundHeight(x, z) } */
  constructor(layout) {
    this.uGust = { value: new THREE.Vector4(0, 0, 0, 0) }; // (dir.x, dir.z, strength, unused)
    const near = 0.8, far = 75;
    // Density falls with distance; the blades grow a little to compensate.
    const samples = [];
    for (let d = near; d < far; d += 0.25) {
      const density = 70 / (1 + (d / 9) ** 2);
      samples.push({ d, n: density * 2 * layout.halfWidth(d) * 0.25 });
    }
    const total = Math.min(40000, Math.round(samples.reduce((a, s) => a + s.n, 0)));
    const inst = new Float32Array(total * 4), inst2 = new Float32Array(total * 4);
    let i = 0;
    for (const s of samples) {
      for (let k = Math.round(s.n * total / samples.reduce((a, x) => a + x.n, 0)); k > 0 && i < total; k--, i++) {
        const d = s.d + rnd(0, 0.25);
        const hw = layout.halfWidth(d) * 1.3 + 2;
        const x = rnd(-hw, hw), z = -d;
        const clump = 0.5 + 0.5 * Math.sin(x * 0.7 + z * 0.5) * Math.cos(x * 0.3 - z * 0.6);
        const h = rnd(0.35, 0.8) * (0.75 + 0.5 * clump) * (1 + d / 40);
        inst.set([x, layout.groundHeight(x, z) - 0.03, z, h], i * 4);
        inst2.set([rnd(0.02, 0.04) * (1 + d / 30), rnd(0, TAU), rnd(0, TAU), Math.random()], i * 4);
      }
    }
    const geo = bladeGeometry(4);
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    geo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    geo.instanceCount = i;
    this.count = i;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: G.uTime, uNight: G.uNight, uSunDir: G.uSunDir, uGust: this.uGust,
        uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
      },
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 aInst; attribute vec4 aInst2;
        uniform float uTime; uniform vec4 uGust;
        varying vec3 vWorld; varying vec3 vNormal; varying float vT; varying float vVar;
        ${Q}
        void main() {
          float t = position.y;
          vec3 base = aInst.xyz; float h = aInst.w;
          float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z;
          vT = t; vVar = aInst2.w;
          // Wind: slow waves rolling over the knoll, plus the cursor's gust, plus a lean of its own.
          vec2 wdir = normalize(vec2(0.8, 0.4));
          float along = dot(base.xz, wdir);
          float wv = 0.5 + 0.4 * sin(uTime * q(0.45) - along * 0.3 + phase) + 0.25 * sin(uTime * q(1.1) - along * 0.8 + phase * 1.7);
          vec2 push = wdir * wv * 0.5 + uGust.xy * uGust.z * 0.6;
          push += vec2(cos(phase * 3.7), sin(phase * 2.9)) * 0.12;
          float mag = length(push);
          float ang = min(mag * (1.0 + 0.8 * aInst2.w), 1.5);
          vec2 dir = mag > 1e-4 ? push / mag : vec2(1.0, 0.0);
          float a = ang * t;
          float along2, up;
          if (ang < 1e-3) { along2 = 0.0; up = h * t; } else { along2 = h * (1.0 - cos(a)) / ang; up = h * sin(a) / ang; }
          vec3 p = base + vec3(dir.x * along2, up, dir.y * along2);
          vec3 tangent = vec3(dir.x * sin(a), cos(a), dir.y * sin(a));
          vec3 across = vec3(cos(yaw), 0.0, sin(yaw));
          p += across * position.x * w * (1.0 - t * t * 0.9);
          vec3 n = normalize(cross(across, tangent));
          if (dot(n, cameraPosition - p) < 0.0) n = -n;
          vNormal = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.35));
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uNight; uniform vec3 uSunDir;
        varying vec3 vWorld; varying vec3 vNormal; varying float vT; varying float vVar;
        ${FOG_HEAD}
        void main() {
          vec3 root = vec3(0.03, 0.06, 0.025);
          vec3 tip = mix(vec3(0.16, 0.3, 0.1), vec3(0.3, 0.34, 0.12), vVar);
          tip = mix(tip, vec3(0.42, 0.34, 0.14), step(0.85, vVar) * 0.7);
          vec3 albedo = mix(root, tip, vT * vT);
          float ndl = max(dot(vNormal, uSunDir), 0.0);
          // Low sun: a warm key light, backlight glowing through the thin tips, cool sky fill.
          vec3 sun = vec3(1.0, 0.72, 0.45) * (ndl * 1.5 + pow(max(-dot(vNormal, uSunDir), 0.0), 2.0) * vT * 1.2);
          vec3 sky = vec3(0.4, 0.45, 0.65) * 0.5;
          vec3 c = albedo * 0.8 * mix(sun + sky, vec3(0.05, 0.06, 0.12), uNight) * (0.35 + 0.65 * vT);
          c = applyFog(c, length(vWorld - cameraPosition));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  /** Feed the cursor's gust in: direction on the ground and strength. */
  setGust(dir, strength) { this.uGust.value.set(dir.x, dir.z, strength, 0); }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
