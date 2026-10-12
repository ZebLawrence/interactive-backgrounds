// Loon Lake — Cattails and reed grass standing in the shallows at the edges of the view, swaying
// in the breeze. A cattail (Typha) is a round stalk topped by the brown velvet spike with a thin
// spire above it, and a fan of long flat strap leaves arching out from the base. Their tops are
// perches for the dragonflies.

import * as THREE from 'three';
import { TAU, rnd, v3, quantize } from './util.js';
import { G, Q, FOG_HEAD, LAYER } from './shaders.js';
import { bedDepth } from './water.js';
import { depthVariant } from './bedlife.js';

function bladeGeometry(rows) {
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

/** The sway shared by stalks, leaves and heads: a slow lean downwind with a flutter, growing up the stem. */
const SWAY_GLSL = `
uniform float uTime; uniform vec3 uWind;
${Q}
vec3 swayAt(vec3 base, float h, float t, float phase, float stiff) {
  vec2 wdir = normalize(uWind.xy + vec2(1e-4, 0.0));
  float along = dot(base.xz, wdir);
  float wv = 0.6 + 0.3 * sin(uTime * q(0.35) - along * 0.4 + phase) + 0.15 * sin(uTime * q(0.9) - along * 0.9 + phase * 1.7);
  float lean = uWind.z * wv * 0.14 * stiff;
  float a = lean * t * t;
  return base + vec3(wdir.x * a * h, h * t, wdir.y * a * h);
}
// A leaf arches out from the base along its own direction, more and more toward the tip.
vec3 archAt(vec3 base, float h, float t, float phase, float stiff, float arch, vec2 outDir) {
  vec3 p = swayAt(base, h, t, phase, stiff);
  float reach = arch * h * t * t;
  p.xz += outDir * reach;
  p.y -= arch * arch * h * t * t * t * 0.45;
  return p;
}
`;

// Kinds of blade, carried in aInst2.w as tone + 10 * kind.
const KIND = { grass: 0, stalk: 1, leaf: 2 };

export class Reeds {
  /** @param {(d: number) => number} halfWidth */
  constructor(halfWidth) {
    this.group = new THREE.Group();
    this.perches = [];
    /** Where stems meet the bed, for the contact-shadow map. */
    this.bases = [];
    // Clumps run along both sides of the view from the shallows out to twenty-five metres, each a
    // mix of plants. The view is narrow close by, so the near ones hug the frame's edge.
    const clumps = [];
    for (const side of [-1, 1]) {
      for (const [z0, z1] of [[3.5, 5.5], [6, 8.5], [9, 12], [12.5, 15.5], [16, 19.5], [20, 26]]) {
        const z = -rnd(z0, z1);
        const hw = halfWidth(-z);
        const near = -z < 9;
        clumps.push({
          x: side * (near ? hw * rnd(0.95, 1.25) + 0.5 : hw * rnd(0.6, 1.0)), z, r: rnd(1.0, near ? 1.8 : 3.0),
          n: Math.round(rnd(near ? 6 : 10, near ? 14 : 24)),
          // Sedges crowd the near shallows, cattails and bulrushes stand farther out.
          mix: near ? { cattail: 0.35, bulrush: 0.1, sedge: 0.3, grass: 0.25 } : { cattail: 0.4, bulrush: 0.3, sedge: 0.1, grass: 0.2 },
        });
      }
    }
    const choose = (mix) => {
      let r = Math.random();
      for (const k in mix) { r -= mix[k]; if (r <= 0) return k; }
      return 'grass';
    };

    const blades = [], heads = [], tufts = [];
    for (const c of clumps) {
      for (let i = 0; i < c.n; i++) {
        const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * c.r;
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d * 0.7;
        const tone = Math.random();
        const phase = rnd(0, TAU);
        // Everything is rooted on the lake bed and grows up through the water.
        const bed = -bedDepth(Math.min(z, -0.01));
        this.bases.push({ x, z, r: 0.12 });
        const kind = choose(c.mix);
        if (kind === 'cattail') {
          // A cattail: the stalk, its head, and four to six leaves fanning out from the base.
          const h = rnd(1.4, 2.1) - bed;
          blades.push({ x, z, y: bed, h, w: 0.011, yaw: rnd(0, TAU), phase, tone, kind: KIND.stalk, arch: 0, out: 0 });
          heads.push({ x, z, y: bed, h, phase, scale: rnd(0.85, 1.25), tone });
          const leaves = Math.floor(rnd(4, 7));
          const yaw0 = rnd(0, TAU);
          for (let k = 0; k < leaves; k++) {
            const out = yaw0 + k / leaves * TAU + rnd(-0.25, 0.25);
            const lh = h * rnd(0.75, 1.15);
            blades.push({ x: x + Math.cos(out) * 0.01, z: z + Math.sin(out) * 0.01, y: bed, h: lh, w: rnd(0.013, 0.019), yaw: out + Math.PI / 2, phase: phase + k, tone, kind: KIND.leaf, arch: rnd(0.12, 0.4), out });
          }
          if (Math.random() < 0.3) this.perches.push({ base: v3(x, bed, z), h, phase, stiff: 0.6 });
        } else if (kind === 'bulrush') {
          // Bulrushes: two or three tall round stems close together, each with a drooping brown
          // tuft of spikelets just below its tip, and no leaves to speak of.
          for (let k = Math.floor(rnd(2, 4)); k > 0; k--) {
            const h = rnd(1.8, 2.7) - bed;
            const bx = x + rnd(-0.06, 0.06), bz = z + rnd(-0.06, 0.06);
            blades.push({ x: bx, z: bz, y: bed, h, w: 0.0075, yaw: rnd(0, TAU), phase: phase + k, tone: 0.5 + tone * 0.5, kind: KIND.stalk, arch: 0, out: 0 });
            tufts.push({ x: bx, z: bz, y: bed, h, phase: phase + k, scale: rnd(0.8, 1.3), tone });
            if (Math.random() < 0.15) this.perches.push({ base: v3(bx, bed, bz), h, phase: phase + k, stiff: 0.6, top: 0.05 });
          }
        } else if (kind === 'sedge') {
          // A sedge tussock: a dense mound of narrow blades arching out in every direction.
          const n = Math.floor(rnd(14, 26));
          for (let k = 0; k < n; k++) {
            const out = rnd(0, TAU);
            const h = rnd(0.9, 1.5) - bed;
            blades.push({ x: x + Math.cos(out) * rnd(0, 0.12), z: z + Math.sin(out) * rnd(0, 0.12), y: bed, h, w: rnd(0.004, 0.007), yaw: out + Math.PI / 2, phase: phase + k * 0.7, tone: tone * 0.6, kind: KIND.leaf, arch: rnd(0.3, 0.65), out });
          }
        } else {
          // Reed grass: a few narrow blades together.
          for (let k = Math.floor(rnd(2, 5)); k > 0; k--) {
            const h = rnd(0.7, 1.5) - bed;
            blades.push({ x: x + rnd(-0.05, 0.05), z: z + rnd(-0.05, 0.05), y: bed, h, w: rnd(0.008, 0.014), yaw: rnd(0, TAU), phase: phase + k, tone, kind: KIND.grass, arch: rnd(0, 0.08), out: rnd(0, TAU) });
          }
        }
      }
    }

    // Blades: instanced quad strips; a stalk is round-ish (dark edges), a leaf is flat with a midrib.
    const stemGeo = bladeGeometry(8);
    const n = blades.length;
    const inst = new Float32Array(n * 4), inst2 = new Float32Array(n * 4), inst3 = new Float32Array(n * 4);
    blades.forEach((s, i) => {
      inst.set([s.x, s.y, s.z, s.h], i * 4);
      inst2.set([s.w, s.yaw, s.phase, s.tone + 10 * s.kind], i * 4);
      inst3.set([s.arch, Math.cos(s.out), Math.sin(s.out), 0], i * 4);
    });
    stemGeo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    stemGeo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    stemGeo.setAttribute('aInst3', new THREE.InstancedBufferAttribute(inst3, 4));
    stemGeo.instanceCount = n;
    this.stemMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uWind: G.uWind, uNight: G.uNight, uRain: G.uRain, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 aInst, aInst2, aInst3;
        varying vec2 vUv; varying float vDist, vTone, vKind, vWY; varying vec3 vN;
        ${SWAY_GLSL}
        void main() {
          vec3 base = aInst.xyz; float h = aInst.w;
          float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z;
          vKind = floor(aInst2.w / 10.0); vTone = aInst2.w - vKind * 10.0;
          float arch = aInst3.x; vec2 outDir = aInst3.yz;
          float t = position.y;
          float stiff = vKind == 1.0 ? 0.6 : 1.0;
          // Leaves taper to a point over the last third; stalks stay even.
          float taper = vKind == 1.0 ? 1.0 : (1.0 - smoothstep(0.55, 1.0, t) * 0.92);
          vec3 p = archAt(base, h, t, phase, stiff, arch, outDir);
          vec3 p2 = archAt(base, h, t + 0.01, phase, stiff, arch, outDir);
          vec3 across = vec3(cos(yaw), 0.0, sin(yaw));
          // A leaf twists a little along its length.
          float tw = (vKind == 2.0) ? sin(phase + t * 2.5) * 0.5 * t : 0.0;
          across = normalize(across * cos(tw) + vec3(0.0, sin(tw) * 0.4, 0.0));
          p += across * position.x * w * taper;
          vec3 up = p2 - p;
          vec3 raw = cross(across, up);
          vN = length(raw) > 1e-6 ? normalize(raw) : vec3(0.0, 0.0, 1.0);
          if (dot(vN, cameraPosition - p) < 0.0) vN = -vN;
          vUv = vec2(position.x + 0.5, t);
          vWY = p.y;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uNight, uRain;
        varying vec2 vUv; varying float vDist, vTone, vKind, vWY; varying vec3 vN;
        ${FOG_HEAD}
        void main() {
          vec3 c;
          if (vKind == 1.0) {
            // The stalk: pale green, rounded by shading the edges.
            c = mix(vec3(0.36, 0.42, 0.2), vec3(0.46, 0.5, 0.26), vTone) * (0.6 + 0.6 * (1.0 - abs(vUv.x - 0.5) * 1.6));
          } else if (vKind == 2.0) {
            // A cattail leaf: blue-green, a pale midrib, drying to straw at the tip.
            vec3 green = mix(vec3(0.2, 0.34, 0.16), vec3(0.3, 0.44, 0.2), vTone);
            c = mix(green, vec3(0.6, 0.52, 0.3), smoothstep(0.7, 1.0, vUv.y) * (0.3 + 0.7 * vTone));
            c *= 0.8 + 0.35 * smoothstep(0.08, 0.0, abs(vUv.x - 0.5)) + 0.15 * sin(vUv.x * 40.0);
          } else {
            // Reed grass: green at the water, straw at the tip, a dark midrib.
            vec3 green = mix(vec3(0.18, 0.28, 0.1), vec3(0.3, 0.38, 0.15), vTone);
            vec3 straw = mix(vec3(0.5, 0.42, 0.2), vec3(0.62, 0.52, 0.3), vTone);
            c = mix(green, straw, smoothstep(0.45, 1.0, vUv.y) * (0.4 + 0.6 * vTone));
            c *= 0.75 + 0.5 * smoothstep(0.0, 0.25, abs(vUv.x - 0.5));
          }
          // Lit by the sky, brighter on top, with a backlit rim from the afterglow.
          vec3 sky = mix(vec3(0.55, 0.45, 0.55), vec3(0.05, 0.06, 0.1), uNight) * (1.0 - uRain * 0.4);
          float side = 0.6 + 0.4 * abs(vN.z);
          c *= sky * side * (0.7 + 0.3 * vUv.y);
          // Under the water the stems are dimmer and greener, and silted toward the bed.
          if (vWY < 0.0) c *= mix(vec3(0.45, 0.5, 0.4), vec3(0.75, 0.8, 0.7), clamp(1.0 + vWY, 0.0, 1.0));
          gl_FragColor = vec4(applyFog(c, vDist), 1.0);
        }`,
    });
    this.stems = new THREE.Mesh(stemGeo, this.stemMaterial);
    this.stems.frustumCulled = false;
    this.stems.castShadow = true;
    this.stems.customDepthMaterial = depthVariant(this.stemMaterial);
    // In every layer: above the water in the main and mirror passes, below it in the refraction.
    this.stems.layers.enable(LAYER.ABOVE);
    this.stems.layers.enable(LAYER.BELOW);

    // Heads: the cattail's velvet spike (a capsule 20 cm long) with the thin spire above it, and
    // the bulrush's tuft of spikelets drooping from just below the tip; each one geometry, scaled
    // a little per plant.
    const spike = new THREE.CapsuleGeometry(0.012, 0.19, 4, 12);
    spike.translate(0, 0.012 + 0.095, 0);
    const spire = new THREE.CylinderGeometry(0.0015, 0.0025, 0.16, 6);
    spire.translate(0, 0.214 + 0.08, 0);
    const tuftParts = [new THREE.CylinderGeometry(0.0025, 0.004, 0.08, 6).translate(0, 0.04, 0)];
    for (let k = 0; k < 7; k++) {
      const a = k / 7 * TAU + 0.4, r = 0.006 + 0.01 * (k % 3) / 2, drop = 0.012 + 0.025 * (k % 2);
      const sp = new THREE.CapsuleGeometry(0.0028, 0.012, 3, 6);
      sp.rotateZ(0.5 + 0.2 * (k % 3));
      sp.rotateY(a);
      const at = new THREE.Vector3(Math.cos(a) * r, -drop, Math.sin(a) * r);
      sp.translate(at.x, at.y, at.z);
      tuftParts.push(sp);
      // The ray that carries the spikelet out from the stem.
      const ray = new THREE.CylinderGeometry(0.0007, 0.0009, at.length(), 5);
      ray.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), at.clone().normalize()));
      ray.translate(at.x / 2, at.y / 2, at.z / 2);
      tuftParts.push(ray);
    }
    const makeHeads = (list, geometry) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', geometry.attributes.position);
      g.setAttribute('normal', geometry.attributes.normal);
      g.setAttribute('uv', geometry.attributes.uv);
      g.setIndex(geometry.index);
      const n = list.length;
      const a1 = new Float32Array(n * 4), a2 = new Float32Array(n * 4);
      list.forEach((h, i) => { a1.set([h.x, h.y, h.z, h.h], i * 4); a2.set([h.scale, h.phase, h.tone, 0], i * 4); });
      g.setAttribute('aInst', new THREE.InstancedBufferAttribute(a1, 4));
      g.setAttribute('aInst2', new THREE.InstancedBufferAttribute(a2, 4));
      g.instanceCount = n;
      return g;
    };
    const headGeo = makeHeads(heads, mergeTwo(spike, spire));
    const tuftGeo = makeHeads(tufts, tuftParts.reduce((acc, g) => mergeTwo(acc, g)));
    this.headMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uWind: G.uWind, uNight: G.uNight, uRain: G.uRain, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar, uTuft: { value: 0 } },
      vertexShader: `
        attribute vec4 aInst, aInst2;
        varying float vDist, vTone, vY; varying vec3 vN; varying vec2 vUv;
        ${SWAY_GLSL}
        void main() {
          vec3 base = aInst.xyz; float h = aInst.w; float s = aInst2.x, phase = aInst2.y; vTone = aInst2.z;
          vec3 top = swayAt(base, h, 1.0, phase, 0.6);
          vec3 up = normalize(swayAt(base, h, 1.01, phase, 0.6) - top);
          vec3 side = normalize(cross(up, vec3(0.0, 0.0, 1.0)));
          vec3 fwd = cross(side, up);
          vec3 p = top + (side * position.x + fwd * position.z + up * position.y) * s;
          vN = normalize(side * normal.x + fwd * normal.z + up * normal.y);
          vUv = uv; vY = position.y;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uNight, uRain, uTuft;
        varying float vDist, vTone, vY; varying vec3 vN; varying vec2 vUv;
        ${FOG_HEAD}
        void main() {
          // The spike is a dense brown velvet; the spire above it is a pale dry stem. A bulrush's
          // tuft is a drier, redder brown, its stalk green.
          vec3 velvet = mix(vec3(0.28, 0.15, 0.08), vec3(0.4, 0.22, 0.11), vTone) * (0.92 + 0.12 * sin(vUv.y * 90.0 + vUv.x * 50.0));
          vec3 c = vY > 0.213 ? vec3(0.5, 0.42, 0.26) : velvet;
          if (uTuft > 0.5) c = vY > 0.0 ? vec3(0.36, 0.42, 0.2) : mix(vec3(0.3, 0.17, 0.09), vec3(0.4, 0.25, 0.13), vTone);
          vec3 sky = mix(vec3(0.55, 0.45, 0.55), vec3(0.05, 0.06, 0.1), uNight) * (1.0 - uRain * 0.4);
          c *= sky * (0.45 + 0.45 * max(vN.y, 0.0) + 0.35 * abs(vN.z) + 0.15 * max(vN.x, 0.0));
          gl_FragColor = vec4(applyFog(c, vDist), 1.0);
        }`,
    });
    this.heads = new THREE.Mesh(headGeo, this.headMaterial);
    this.tuftMaterial = this.headMaterial.clone();
    this.tuftMaterial.uniforms = { ...this.headMaterial.uniforms, uTuft: { value: 1 } };
    this.tufts = new THREE.Mesh(tuftGeo, this.tuftMaterial);
    for (const m of [this.heads, this.tufts]) {
      m.frustumCulled = false;
      m.castShadow = true;
      m.customDepthMaterial = depthVariant(m.material);
      m.layers.enable(LAYER.ABOVE);
      m.layers.enable(LAYER.BELOW);
    }
    this.group.add(this.stems, this.heads, this.tufts);
  }

  /** Where the top of a perch stalk is right now (mirrors the shader's sway). */
  perchTop(perch, time) {
    const w = G.uWind.value;
    const len = Math.hypot(w.x, w.y) || 1;
    const wx = w.x / len, wz = w.y / len;
    const along = perch.base.x * wx + perch.base.z * wz;
    const wv = 0.6 + 0.3 * Math.sin(time * quantize(0.35) - along * 0.4 + perch.phase) + 0.15 * Math.sin(time * quantize(0.9) - along * 0.9 + perch.phase * 1.7);
    const lean = w.z * wv * 0.14 * perch.stiff;
    // The perch is the top of the plant: a cattail's spike (21 cm above the stalk) unless the
    // perch says otherwise (a bulrush tip, a lily pad).
    const h = perch.h;
    return v3(perch.base.x + wx * lean * h, perch.base.y + h + (perch.top ?? 0.21), perch.base.z + wz * lean * h);
  }

  dispose() {
    this.stems.geometry.dispose();
    this.heads.geometry.dispose();
    this.stemMaterial.dispose();
    this.headMaterial.dispose();
    this.stems.customDepthMaterial.dispose();
    this.heads.customDepthMaterial.dispose();
    this.tufts.geometry.dispose();
    this.tuftMaterial.dispose();
    this.tufts.customDepthMaterial.dispose();
  }
}

/** Merge two indexed geometries that share position/normal/uv attributes. */
function mergeTwo(a, b) {
  const attrs = {};
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.attributes[name], B = b.attributes[name];
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array, 0);
    arr.set(B.array, A.array.length);
    attrs[name] = new THREE.BufferAttribute(arr, A.itemSize);
  }
  const offset = a.attributes.position.count;
  const idx = new Uint16Array(a.index.count + b.index.count);
  idx.set(a.index.array, 0);
  for (let i = 0; i < b.index.count; i++) idx[a.index.count + i] = b.index.array[i] + offset;
  const g = new THREE.BufferGeometry();
  for (const k in attrs) g.setAttribute(k, attrs[k]);
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
