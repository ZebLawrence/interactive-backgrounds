// Firefly Meadow — The grass: tens of thousands of instanced blades that sway in the wind, part
// around the cursor and spring back along its trail, plus wildflowers scattered among them.
// Everything moves on the GPU; the CPU only places the instances once.

import * as THREE from 'three';
import { TAU, rnd, pick, lerp, clamp, Art } from './util.js';
import { G, FOG_HEAD, PUSH_HEAD, WIND_HEAD, LIGHTS_HEAD, SHADE_HEAD, FIREFLY_LIGHT_COLOR } from './shaders.js';

const SHARED_UNIFORMS = () => ({
  uTime: G.uTime, uWindDir: G.uWindDir, uWind: G.uWind,
  uCursor: G.uCursor, uTrail: G.uTrail, uRings: G.uRings, uLights: G.uLights,
  uMoon: G.uMoon, uMoonDir: G.uMoonDir, uMoonColor: G.uMoonColor, uSkyLight: G.uSkyLight, uFlash: G.uFlash, uStorm: G.uStorm,
  uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
});

/**
 * Bend a stalk rooted at `base` by the wind and whatever is pushing on the ground there. The
 * stalk is an arc of constant curvature: `t` runs 0 at the root to 1 at the tip, `h` is its
 * length. Returns the bent point and the tangent there.
 */
const BEND_HEAD = `
${PUSH_HEAD}${WIND_HEAD}
void bendStalk(vec3 base, float h, float t, float phase, float stiffness, out vec3 p, out vec3 tangent) {
  vec2 push = pushAt(base.xz) * 1.6 + windAt(base.xz, phase) * 0.55;
  // A natural lean of its own, so blades don't all stand to attention.
  push += vec2(cos(phase * 3.7), sin(phase * 2.9)) * 0.12;
  float mag = length(push);
  float ang = min(mag * stiffness, 1.5);
  vec2 dir = mag > 1e-4 ? push / mag : vec2(1.0, 0.0);
  float a = ang * t;
  float along, up;
  if (ang < 1e-3) { along = 0.0; up = h * t; }
  else { along = h * (1.0 - cos(a)) / ang; up = h * sin(a) / ang; }
  p = base + vec3(dir.x * along, up, dir.y * along);
  tangent = vec3(dir.x * sin(a), cos(a), dir.y * sin(a));
}
`;

/** A blade: a strip of `rows` quads, narrowing to a point. x runs -0.5..0.5, y is t in 0..1. */
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

/** Two crossed blades for a flower: stem and head in one texture cell. */
function flowerGeometry() {
  const pos = [], uv = [], idx = [];
  let n = 0;
  for (const yaw of [0, Math.PI / 2]) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const t of [0, 0.55, 0.8, 1]) {
      for (const x of [-0.5, 0.5]) {
        pos.push(x * c, t, x * s);
        uv.push(x + 0.5, t);
      }
    }
    for (let r = 0; r < 3; r++) {
      const a = n + r * 2, b = a + 1, c2 = a + 2, d = a + 3;
      idx.push(a, b, c2, b, d, c2);
    }
    n += 8;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** An atlas of four wildflowers on stems: daisy, buttercup, clover and cow parsley. */
function flowerAtlas() {
  const cell = 128, h = 256;
  return Art.image(cell * 4, h, (ctx) => {
    const stem = (cx, top) => {
      ctx.strokeStyle = '#3a5a2a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, h);
      ctx.quadraticCurveTo(cx + 6, h * 0.6, cx, top);
      ctx.stroke();
      // A leaf or two.
      ctx.fillStyle = '#3f6a2e';
      ctx.beginPath();
      ctx.ellipse(cx + 12, h * 0.72, 14, 5, -0.6, 0, TAU);
      ctx.fill();
    };
    const petals = (cx, cy, n, r, len, color, centre) => {
      ctx.fillStyle = color;
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * r, cy + Math.sin(a) * r, len, len * 0.42, a, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = centre;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, TAU);
      ctx.fill();
    };
    // Daisy
    stem(cell * 0.5, 50);
    petals(cell * 0.5, 44, 13, 18, 16, '#f2f0e4', '#e8c23a');
    // Buttercup
    stem(cell * 1.5, 56);
    petals(cell * 1.5, 50, 5, 11, 15, '#f4d23c', '#d7a81f');
    // Clover: a ball of tiny florets
    stem(cell * 2.5, 58);
    for (let i = 0; i < 40; i++) {
      const a = rnd(0, TAU), rr = Math.sqrt(Math.random()) * 20;
      ctx.fillStyle = pick(['#c58ad6', '#b476c8', '#d9a6e6', '#e6c2ee']);
      ctx.beginPath();
      ctx.ellipse(cell * 2.5 + Math.cos(a) * rr, 48 + Math.sin(a) * rr * 0.8, 6, 3, a, 0, TAU);
      ctx.fill();
    }
    // Cow parsley: an umbel of small white clusters
    stem(cell * 3.5, 48);
    ctx.strokeStyle = '#4a6a34';
    ctx.lineWidth = 2;
    for (let i = -3; i <= 3; i++) {
      const x = cell * 3.5 + i * 13, y = 30 + Math.abs(i) * 5;
      ctx.beginPath();
      ctx.moveTo(cell * 3.5, 48);
      ctx.lineTo(x, y);
      ctx.stroke();
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = pick(['#f4f2ea', '#e8e6dc', '#fbfaf5']);
        ctx.beginPath();
        ctx.arc(x + rnd(-8, 8), y + rnd(-5, 5), 3.2, 0, TAU);
        ctx.fill();
      }
    }
  });
}

export class GrassField {
  /**
   * @param {object} layout  { halfWidth(d), groundHeight(x, z), area }: the visible half-width of
   *   the meadow `d` metres out, the terrain, and the screen area relative to a laptop display.
   */
  constructor(layout) {
    this.layout = layout;
    this.group = new THREE.Group();
    this.buildBlades();
    this.buildFlowers();
  }

  /** Blades thin out with distance, where they're too small to see anyway. */
  distanceTable() {
    const near = 0.5, far = 48, bins = 600;
    const cdf = [0];
    for (let i = 1; i <= bins; i++) {
      const d = near + (far - near) * i / bins;
      const density = 300 / (1 + Math.pow(d / 4.5, 2));
      cdf.push(cdf[i - 1] + density * 2 * this.layout.halfWidth(d) * (far - near) / bins);
    }
    return { near, far, bins, cdf };
  }

  sampleDistance(tbl) {
    const u = Math.random() * tbl.cdf[tbl.bins];
    let lo = 0, hi = tbl.bins;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tbl.cdf[mid] < u) lo = mid; else hi = mid;
    }
    const f = (u - tbl.cdf[lo]) / Math.max(tbl.cdf[hi] - tbl.cdf[lo], 1e-9);
    return tbl.near + (tbl.far - tbl.near) * (lo + f) / tbl.bins;
  }

  buildBlades() {
    const tbl = this.distanceTable();
    const count = Math.round(Math.min(tbl.cdf[tbl.bins], 90000));
    const inst = new Float32Array(count * 4), inst2 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const d = this.sampleDistance(tbl);
      const hw = this.layout.halfWidth(d);
      const x = rnd(-hw, hw), z = -d;
      // Clumpy: height follows a slow noise so the meadow has tussocks and hollows.
      const clump = 0.5 + 0.5 * Math.sin(x * 0.9 + z * 0.4) * Math.cos(x * 0.3 - z * 0.8 + 1.0);
      const h = rnd(0.35, 0.75) * (0.75 + 0.5 * clump) * (1 + d / 30);
      inst.set([x, this.layout.groundHeight(x, z) - 0.02, z, h], i * 4);
      inst2.set([rnd(0.018, 0.034) * (1 + d / 20), rnd(0, TAU), rnd(0, TAU), Math.random()], i * 4);
    }
    const geo = bladeGeometry(4);
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    geo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    geo.instanceCount = count;
    this.bladeCount = count;

    this.bladeMaterial = new THREE.ShaderMaterial({
      uniforms: SHARED_UNIFORMS(),
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 aInst; attribute vec4 aInst2;
        varying vec3 vWorld; varying vec3 vNormal; varying float vT; varying float vVar;
        ${BEND_HEAD}
        void main() {
          float t = position.y;
          vec3 base = aInst.xyz; float h = aInst.w;
          float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z;
          vT = t; vVar = aInst2.w;
          vec3 p, tangent;
          bendStalk(base, h, t, phase, 1.0 + 0.8 * aInst2.w, p, tangent);
          vec3 across = vec3(cos(yaw), 0.0, sin(yaw));
          p += across * position.x * w * (1.0 - t * t * 0.9);
          vec3 n = normalize(cross(across, tangent));
          if (dot(n, cameraPosition - p) < 0.0) n = -n;
          vNormal = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.35));
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vWorld; varying vec3 vNormal; varying float vT; varying float vVar;
        ${FOG_HEAD}${LIGHTS_HEAD}${SHADE_HEAD}
        void main() {
          vec3 root = vec3(0.018, 0.045, 0.022);
          vec3 tip = mix(vec3(0.10, 0.21, 0.08), vec3(0.17, 0.25, 0.10), vVar);
          // Some blades have gone to seed and turned straw-coloured.
          tip = mix(tip, vec3(0.26, 0.22, 0.10), step(0.86, vVar) * 0.7);
          vec3 albedo = mix(root, tip, vT * vT);
          float ao = 0.3 + 0.7 * vT;
          vec3 c = shade(albedo, vNormal, ao);
          c += (albedo * 2.6 + 0.012) * fireflyLight(vWorld) * ${FIREFLY_LIGHT_COLOR} * ao;
          c = applyFog(c, length(vWorld - cameraPosition));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.blades = new THREE.Mesh(geo, this.bladeMaterial);
    this.blades.frustumCulled = false;
    this.group.add(this.blades);
  }

  buildFlowers() {
    const count = Math.round(150 * clamp(this.layout.area, 0.6, 2.2));
    const inst = new Float32Array(count * 4), inst2 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Flowers only where they can be seen: in the nearer meadow, in loose drifts.
      const d = 0.8 + 16 * Math.pow(Math.random(), 1.5);
      const hw = this.layout.halfWidth(d);
      const drift = Math.floor(Math.random() * 7);
      const cx = Math.sin(drift * 2.1) * hw * 0.8;
      const x = clamp(cx + rnd(-3, 3), -hw, hw), z = -d;
      const kind = (drift + i) % 4;
      const h = [0.42, 0.33, 0.3, 0.6][kind] * rnd(0.85, 1.2) * (1 + d / 40);
      inst.set([x, this.layout.groundHeight(x, z) - 0.02, z, h], i * 4);
      inst2.set([h * 0.5, rnd(0, TAU), rnd(0, TAU), kind], i * 4);
    }
    const geo = flowerGeometry();
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    geo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    geo.instanceCount = count;

    this.flowerTexture = Art.texture(flowerAtlas());
    this.flowerMaterial = new THREE.ShaderMaterial({
      uniforms: { ...SHARED_UNIFORMS(), uMap: { value: this.flowerTexture } },
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 aInst; attribute vec4 aInst2;
        varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying float vT;
        ${BEND_HEAD}
        void main() {
          float t = position.y;
          vec3 base = aInst.xyz; float h = aInst.w;
          float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z, kind = aInst2.w;
          vec3 p, tangent;
          bendStalk(base, h, t, phase, 0.6, p, tangent);
          float c = cos(yaw), s = sin(yaw);
          vec3 across = vec3(position.x * c - position.z * s, 0.0, position.x * s + position.z * c);
          p += across * w;
          vNormal = vec3(0.0, 1.0, 0.0);
          vWorld = p; vT = t;
          vUv = vec2((kind + uv.x) / 4.0, uv.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying float vT;
        ${FOG_HEAD}${LIGHTS_HEAD}${SHADE_HEAD}
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.5) discard;
          vec3 albedo = tex.rgb * 0.42;
          vec3 c = shade(albedo, vNormal, 0.5 + 0.5 * vT);
          c += (albedo * 2.2 + 0.01) * fireflyLight(vWorld) * ${FIREFLY_LIGHT_COLOR};
          c = applyFog(c, length(vWorld - cameraPosition));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.flowers = new THREE.Mesh(geo, this.flowerMaterial);
    this.flowers.frustumCulled = false;
    this.group.add(this.flowers);
  }

  dispose() {
    this.blades.geometry.dispose();
    this.bladeMaterial.dispose();
    this.flowers.geometry.dispose();
    this.flowerMaterial.dispose();
    this.flowerTexture.dispose();
  }
}
