// Boreal Night — Spruce: procedural trees built branch by branch, loaded with snow that bends the
// boughs, swaying on springs, and shedding their snow when the wind (or the cursor) shakes them.
//
// Built like the real thing: a tapering trunk; whorls of branches every 20-35 cm, longest at the
// bottom of a narrow crown (snow-country spruce are slender, which helps them shed snow); each
// branch a flat, arched spray of side twigs clothed in 1-2 cm needles, drooping from the trunk
// and turning up at the tip; dead, bare twigs low on the trunk where the crown has been shaded
// out. Snow lies on each spray as a pillow, thickest along the middle, and its weight bends the
// branch down. A shaken tree drops its load in clumps, and the branches spring back up.

import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep, v3 } from './util.js';
import { G, Q, NOISE_GLSL, patchMaterial, patchDepth } from './shaders.js';

// Vertex kinds, in aF.x.
const BARK = 0, NEEDLES = 1, TWIG = 2, SNOW = 3;

/** Accumulates the vertices of one tree. */
class Builder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.f = []; this.c = []; this.t = []; this.idx = [];
    this.snow = { pos: [], nrm: [], uv: [], f: [], c: [], t: [], idx: [] };
  }

  /** A grid of `rows` x `cols` vertices produced by `at(r, c)` → {p, uv, f, c, t}. */
  grid(target, rows, cols, at) {
    const base = target.pos.length / 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = at(r, c);
        target.pos.push(v.p.x, v.p.y, v.p.z);
        target.nrm.push(0, 1, 0);
        target.uv.push(v.uv[0], v.uv[1]);
        target.f.push(...v.f);
        target.c.push(v.c ?? 0);
        target.t.push(v.t ?? 0);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        target.idx.push(a, d, b, b, d, e);
      }
    }
  }

  geometry(target, offsetThickness = false) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(target.pos);
    if (offsetThickness) {
      // Normals for the snow pillows are computed at full thickness, then the thickness is taken
      // out again: the shader puts back as much as the tree's current load allows.
      const full = pos.slice();
      for (let i = 0; i < target.t.length; i++) full[i * 3 + 1] += target.t[i];
      g.setAttribute('position', new THREE.BufferAttribute(full, 3));
      g.setIndex(target.idx);
      g.computeVertexNormals();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    } else {
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(target.idx);
      g.computeVertexNormals();
    }
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(target.uv), 2));
    g.setAttribute('aF', new THREE.BufferAttribute(new Float32Array(target.f), 4));
    g.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(target.c), 1));
    g.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(target.t), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Build one spruce. `rng` is a seeded random; `H` the height in metres; `detail` 1 for the trees
 * near the viewer and lower for the far ones (fewer whorls and no secondary sprays).
 */
export function buildSpruce(rng, H, detail = 1, opts = {}) {
  const R = (lo, hi) => lo + rng() * (hi - lo);
  const b = new Builder();
  const black = opts.black ?? rng() < 0.4;
  const up = v3(0, 1, 0);

  // The trunk: a tapering tube with bark mapped in metres.
  const baseR = 0.045 + H * 0.011;
  const trunkR = (t) => baseR * Math.pow(1 - t, 0.85) + 0.008;
  const lean = v3(R(-1, 1), 0, R(-1, 1)).multiplyScalar(H * 0.006);
  const axis = (y) => v3(lean.x * (y / H) ** 2, y, lean.z * (y / H) ** 2);
  const rows = Math.max(6, Math.round(H * 1.2 * detail)), sides = detail > 0.6 ? 8 : 5;
  b.grid(b, rows + 1, sides + 1, (r, c) => {
    const t = r / rows, a = c / sides * TAU;
    const rad = trunkR(t);
    const o = axis(t * H);
    return {
      p: v3(o.x + Math.cos(a) * rad, o.y - 0.3 * (r === 0 ? 1 : 0), o.z + Math.sin(a) * rad),
      uv: [c / sides * TAU * baseR, t * H], f: [BARK, 0, 1, t], c: 0,
    };
  });

  /** One flat, arched spray from `o` along horizontal `d`. `lp` is the parent branch length. */
  const spray = (o, d, L, w, lp, curve, withSnow, snowScale = 1) => {
    const S = detail > 0.6 ? 7 : 4;
    const side = v3(-d.z, 0, d.x);
    const width = (s) => w * Math.pow(Math.sin(Math.PI * clamp((s + 0.1) / 1.1, 0, 1)), 0.7) * (1 - 0.3 * s);
    const centre = (s) => o.clone().addScaledVector(d, s * L).addScaledVector(up, (curve[0] * s + curve[1] * s * s) * L);
    const surface = (s, c) => centre(s).addScaledVector(side, c * width(s)).addScaledVector(up, -0.16 * width(s) * c * c);
    const droopS = (p) => clamp(Math.hypot(p.x - axis(p.y).x, p.z - axis(p.y).z) / lp, 0, 1.3);
    b.grid(b, S + 1, 3, (r, ci) => {
      const s = r / S, c = ci - 1;
      const p = surface(s, c);
      return { p, uv: [s * L, c * width(s)], f: [NEEDLES, droopS(p), lp, p.y / H], c };
    });
    if (!withSnow) return;
    // The snow pillow: five across, thickest along the middle, thin near the trunk and the tip.
    const tmax = clamp(0.3 * w, 0.015, 0.11) * snowScale;
    b.grid(b.snow, S + 1, 5, (r, ci) => {
      const s = r / S, c = (ci - 2) / 2;
      const p = surface(s, c * 0.92);
      const th = tmax * Math.pow(Math.sin(Math.PI * clamp(s * 1.05, 0, 1)), 0.6) * (1 - c * c) * smoothstep(0.02, 0.2, s);
      return { p: p.addScaledVector(up, 0.006), uv: [s * L, c * width(s)], f: [SNOW, droopS(p), lp, p.y / H], c, t: th };
    });
  };

  // The crown.
  const crownBase = H * (black ? R(0.03, 0.14) : R(0.08, 0.26));
  const maxR = H * (black ? R(0.09, 0.12) : R(0.13, 0.17));
  const club = black && rng() < 0.45;   // black spruce often carry a dense club of cones at the top
  const spacing = R(0.22, 0.32) / Math.sqrt(detail);
  let az = R(0, TAU);
  for (let y = crownBase; y < H - 0.22; y += spacing * R(0.8, 1.2)) {
    const t = (y - crownBase) / (H - crownBase);
    let rad = maxR * Math.pow(1 - t, 0.9) + 0.12;
    if (club && t > 0.82 && t < 0.95) rad *= 1.7;
    // Old lower branches droop more; young upper ones reach up.
    const curve = [lerp(-0.42, -0.08, t) + R(-0.08, 0.08), lerp(0.32, 0.12, t) + R(-0.05, 0.05)];
    const n = Math.round(lerp(5, 4, t) + R(-0.4, 0.6));
    for (let k = 0; k < n; k++) {
      if (rng() < 0.08) continue;
      az += TAU / n + R(-0.35, 0.35);
      const d = v3(Math.cos(az), 0, Math.sin(az));
      const L = rad * R(0.75, 1.15);
      if (L < 0.08) continue;
      const o = axis(y).addScaledVector(d, trunkR(y / H) * 0.8);
      // Simpler far trees make up for their missing sprays with broader ones.
      spray(o, d, L, L * R(0.36, 0.46) / Math.pow(detail, 0.45), L, curve, true);
      if (detail > 0.6 && L > 0.45) {
        // Secondary sprays off the main branch fill the bough out.
        for (const s0 of [R(0.25, 0.4), R(0.5, 0.7)]) {
          for (const sgn of [-1, 1]) {
            if (rng() < 0.25) continue;
            const ang = sgn * R(0.5, 0.85);
            const d2 = v3(d.x * Math.cos(ang) - d.z * Math.sin(ang), 0, d.x * Math.sin(ang) + d.z * Math.cos(ang));
            const o2 = o.clone().addScaledVector(d, s0 * L).addScaledVector(up, (curve[0] * s0 + curve[1] * s0 * s0) * L - 0.02);
            const L2 = L * R(0.35, 0.5) * (1 - s0 * 0.4);
            spray(o2, d2, L2, L2 * 0.42, L, [curve[0] * 0.6, curve[1] * 0.6], true, 0.6);
          }
        }
      }
    }
  }
  // The leader: a short, upright sprig at the very top, crossed so it reads from any side.
  for (const a of [0, Math.PI / 2]) {
    const top = axis(H - 0.3);
    const d = v3(Math.cos(a), 0, Math.sin(a));
    b.grid(b, 4, 3, (r, ci) => {
      const s = r / 3, c = ci - 1;
      const w = 0.07 * (1 - s * 0.8);
      const p = top.clone().addScaledVector(up, s * 0.42).addScaledVector(d, c * w);
      return { p, uv: [s * 0.42, c * w], f: [NEEDLES, 0, 0.3, p.y / H], c };
    });
  }
  // Dead twigs on the bare lower trunk.
  if (detail > 0.6) {
    for (let y = 0.4; y < crownBase; y += R(0.15, 0.3)) {
      for (let k = 0; k < 3; k++) {
        if (rng() < 0.35) continue;
        const a = R(0, TAU), L = R(0.15, 0.55);
        const d = v3(Math.cos(a), R(-0.5, 0.1), Math.sin(a)).normalize();
        const o = axis(y);
        for (const cross of [0, 1]) {
          const side = cross ? v3(0, 1, 0) : v3(-d.z, 0, d.x);
          b.grid(b, 2, 2, (r, ci) => {
            const w = 0.012 * (1 - r * 0.7);
            const p = o.clone().addScaledVector(d, r * L).addScaledVector(side, (ci - 0.5) * w);
            return { p, uv: [r * L, 0], f: [TWIG, 0, 1, p.y / H], c: 0 };
          });
        }
      }
    }
  }
  return {
    wood: b.geometry(b),
    snow: b.geometry(b.snow, true),
    height: H,
    crownBase,
    maxR,
    black,
  };
}

/** A dead spruce: silver-grey and bare, broken off at the top, with stubs of branches. */
export function buildSnag(rng, H) {
  const R = (lo, hi) => lo + rng() * (hi - lo);
  const b = new Builder();
  const baseR = 0.15 + H * 0.02;
  const rows = 16, sides = 12;
  const lean = v3(R(-1, 1), 0, R(-1, 1)).multiplyScalar(0.012 * H);
  const axis = (y) => v3(lean.x * y / H, y, lean.z * y / H);
  b.grid(b, rows + 1, sides + 1, (r, c) => {
    const t = r / rows, a = c / sides * TAU;
    // The broken top is jagged: the last ring is torn to different heights.
    const tear = r === rows ? R(-0.35, 0.05) : 0;
    // A flared base, then a steady taper; weathered wood bulges and knots here and there.
    const rad = baseR * (1 - t * 0.7) * (1 + 0.35 * Math.exp(-t * 18)) * (1 + 0.05 * Math.sin(a * 3 + t * 20)) * (r === rows ? R(0.4, 0.9) : 1);
    const o = axis(t * H + tear);
    return { p: v3(o.x + Math.cos(a) * rad, o.y - (r === 0 ? 0.3 : 0), o.z + Math.sin(a) * rad), uv: [c / sides * TAU * baseR, t * H], f: [BARK, 1, 1, t], c: 0 };
  });
  // Stubs of the old whorls, and a few longer dead limbs.
  // Dead spruce keep the stubs of every whorl, a bottle-brush of grey twigs up the trunk.
  for (let y = 0.5; y < H - 0.3; y += R(0.14, 0.3)) {
    for (let k = 0; k < 4; k++) {
      if (rng() < 0.3) continue;
      const a = R(0, TAU), L = rng() < 0.22 ? R(0.6, 1.5) * (1 - y / H * 0.5) : R(0.12, 0.4);
      const d = v3(Math.cos(a), R(-0.4, 0.15), Math.sin(a)).normalize();
      const o = axis(y);
      for (const cross of [0, 1]) {
        const side = cross ? v3(0, 1, 0) : v3(-d.z, 0, d.x);
        b.grid(b, 2, 2, (r, ci) => {
          const w = (L > 0.4 ? 0.05 : 0.03) * (1 - r * 0.75);
          const p = o.clone().addScaledVector(d, r * L).addScaledVector(side, (ci - 0.5) * w);
          return { p, uv: [r * L, 0], f: [TWIG, 1, 1, p.y / H], c: 0 };
        });
      }
    }
  }
  // A cap of snow on the broken top.
  const top = axis(H - 0.1);
  const capR = baseR * 0.4;
  b.grid(b.snow, 5, 13, (r, c) => {
    const rr = r / 4 * capR * 1.15, a = c / 12 * TAU;
    const th = 0.09 * (1 - (r / 4) ** 2);
    return { p: v3(top.x + Math.cos(a) * rr, top.y, top.z + Math.sin(a) * rr), uv: [rr, a * rr], f: [SNOW, 0, 1, 1], c: r / 4, t: th };
  });
  return { wood: b.geometry(b), snow: b.geometry(b.snow, true), height: H, crownBase: H, maxR: 0.3, top: top.clone().setY(H - 0.05) };
}

// ---------------------------------------------------------------------------------------------
// Materials. Every tree shares two: the wood and needles, and the snow. Per tree, an instanced
// attribute aSway carries the top's sway (x, z, in the tree's own frame), the snow load, and how
// hard the boughs are fluttering.
// ---------------------------------------------------------------------------------------------

const DEFORM_HEAD = `
attribute vec4 aF;
attribute float aC;
attribute float aT;
attribute vec4 aSway;
varying vec4 vF;
varying float vC;
varying vec2 vMUv;
varying float vLoad;
uniform float uTime;
${Q}
`;
const DEFORM_MAIN = `
  vF = aF; vC = aC; vMUv = uv; vLoad = aSway.z;
  float tH = clamp(aF.w, 0.0, 1.0);
  bool bough = aF.x > 0.5 && aF.x != 2.0;
  if (bough) {
    // The snow's weight bends the bough down, most at the tip; it flutters in the wind.
    float s = aF.y, lp = aF.z;
    gPos.y -= aSway.z * 0.16 * lp * s * s;
    float ph = dot(gPos, vec3(1.7, 0.9, 1.3));
    gPos.y += sin(uTime * q(2.3) + ph) * aSway.w * 0.025 * s * lp;
    gPos.xz += vec2(sin(uTime * q(1.7) + ph * 1.3), cos(uTime * q(1.9) + ph)) * aSway.w * 0.012 * s * lp;
  }
  if (aF.x == 3.0) gPos.y += aT * clamp(aSway.z * 1.25, 0.0, 1.0);
  // The whole tree sways from the base.
  gPos.xz += aSway.xy * (tH * tH * (1.4 - 0.4 * tH));
`;

const NEEDLE_GLSL = `
float needleCover(vec2 m, float c, float lp, out float twigShade) {
  float across = abs(m.y);
  float sp = 0.05;
  // Side twigs leave the midrib at about 50 degrees, pointing toward the tip.
  float a = m.x - across * 0.85;
  float k = floor(a / sp);
  float j = hash21(vec2(k, sign(m.y) + lp * 37.0));
  float da = abs(fract(a / sp) - 0.5) * sp * 0.76;
  float r = 0.0155 * (0.8 + 0.4 * j);
  // Needles stand out along each twig, so its edge is serrated.
  float serr = 0.62 + 0.38 * abs(sin(across / 0.0042 + j * 6.2831));
  float fw = max(fwidth(a) * 0.7, 1e-4);
  float twig = 1.0 - smoothstep(r * serr - fw, r * serr + fw, da);
  // Short twigs near the tip of the spray.
  twig *= step(across, 0.02 + 0.6 * max(m.x, 0.0) + 0.02 * j);
  float rib = 1.0 - smoothstep(0.012, 0.012 + fw * 2.0, across);
  twigShade = 1.0 - smoothstep(0.0, r * 0.4, da);
  // A ragged edge to the spray as a whole.
  float edge = 1.0 - smoothstep(0.7, 1.0, abs(c) + (vnoise(m * 31.0) - 0.5) * 0.45);
  float cover = max(twig, rib) * edge;
  // Far away the needles merge into a mass.
  float far = smoothstep(0.006, 0.03, fwidth(m.x));
  return mix(cover, edge, far);
}
`;

const SNOW_GLSL = `
float snowCover(vec2 m, float c, float load, float seed) {
  float n = vnoise(m * 9.0 + seed * 13.0) * 0.65 + vnoise(m * 27.0 + seed) * 0.35;
  float mid = 1.0 - c * c;
  float thr = 1.15 - load * 1.05;
  return smoothstep(thr, thr + 0.12, n * 0.55 + mid * 0.6);
}
`;

export function makeTreeMaterials() {
  const shared = { uTime: G.uTime, uAuroraLight: G.uAuroraLight };
  const wood = patchMaterial(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true, transparent: false,
  }), {
    key: 'spruce-wood',
    uniforms: shared,
    vHead: DEFORM_HEAD,
    vMain: DEFORM_MAIN,
    fHead: `
      varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad;
      uniform vec3 uAuroraLight;
      ${NOISE_GLSL}${NEEDLE_GLSL}`,
    fColor: `
      float twigShade = 0.0;
      float kind = vF.x;
      vec3 base;
      if (kind < 0.5 || kind > 1.5) {
        // Bark: grey-brown scales; the dead wood of snags and twigs weathered to silver-grey.
        float scales = vnoise(vec2(vMUv.x * 38.0, vMUv.y * 16.0)) * 0.6 + vnoise(vMUv * vec2(90.0, 50.0)) * 0.4;
        vec3 live = mix(vec3(0.13, 0.09, 0.07), vec3(0.24, 0.19, 0.15), scales);
        vec3 dead = mix(vec3(0.28, 0.27, 0.26), vec3(0.46, 0.45, 0.42), scales);
        base = mix(live, dead, clamp(step(0.5, vF.y) * 0.9 + (kind > 1.5 ? 0.35 : 0.0), 0.0, 1.0));
        diffuseColor.a = 1.0;
      } else {
        float cover = needleCover(vMUv, vC, vF.z, twigShade);
        if (cover < 0.02) discard;
        diffuseColor.a = cover;
        // Dark blue-green needles, a little lighter toward the tips; brown twigs inside.
        float tip = smoothstep(0.0, 0.6, vMUv.x / max(vF.z, 0.2));
        float vary = hash21(floor(vMUv * 23.0));
        base = mix(vec3(0.028, 0.055, 0.045), vec3(0.06, 0.1, 0.075), tip * 0.6 + vary * 0.4);
        base = mix(base, vec3(0.09, 0.06, 0.04), twigShade * 0.35);
      }
      diffuseColor.rgb = base;`,
    fEmissive: `
      // A breath of the aurora's green on the needles.
      totalEmissiveRadiance += diffuseColor.rgb * uAuroraLight * 0.2;`,
  });
  const snow = patchMaterial(new THREE.MeshStandardMaterial({
    color: 0xf4f7ff, roughness: 0.78, metalness: 0, alphaToCoverage: true,
  }), {
    key: 'spruce-snow',
    uniforms: shared,
    vHead: DEFORM_HEAD,
    vMain: DEFORM_MAIN,
    fHead: `
      varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad;
      uniform vec3 uAuroraLight;
      ${NOISE_GLSL}${SNOW_GLSL}`,
    fColor: `
      float cover = snowCover(vMUv, vC, vLoad, vF.z);
      if (cover < 0.03) discard;
      diffuseColor.a = cover;
      // Shaded snow under the pillow's edge looks blue.
      diffuseColor.rgb *= mix(vec3(0.78, 0.84, 1.0), vec3(1.0), smoothstep(0.0, 0.6, 1.0 - abs(vC)));`,
  });
  // Shadow passes, with the same bending and a coarse version of the cut-outs.
  const woodDepth = patchDepth({
    key: 'spruce-wood', uniforms: shared, vHead: DEFORM_HEAD, vMain: DEFORM_MAIN,
    fHead: `varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad;\n${NOISE_GLSL}`,
    fDiscard: `
      if (vF.x == 1.0) {
        float edge = 1.0 - smoothstep(0.6, 1.0, abs(vC) + (vnoise(vMUv * 31.0) - 0.5) * 0.45);
        if (edge * (0.55 + 0.45 * vnoise(vMUv * 70.0)) < 0.5) discard;
      }`,
  });
  const snowDepth = patchDepth({
    key: 'spruce-snow', uniforms: shared, vHead: DEFORM_HEAD, vMain: DEFORM_MAIN,
    fHead: `varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad;\n${NOISE_GLSL}${SNOW_GLSL}`,
    fDiscard: `if (snowCover(vMUv, vC, vLoad, vF.z) < 0.5) discard;`,
  });
  return { wood, snow, woodDepth, snowDepth };
}

// ---------------------------------------------------------------------------------------------
// The forest: instances of a handful of tree variants, each on its own spring.
// ---------------------------------------------------------------------------------------------

export class Forest {
  /**
   * `variants`: built trees; `trees`: [{x, y, z, rot, scale, variant, load}] in world space.
   */
  constructor(variants, trees, mats) {
    this.group = new THREE.Group();
    this.variants = variants;
    this.trees = trees;
    this.mats = mats;
    this.meshes = [];
    const byVariant = variants.map(() => []);
    trees.forEach((t, i) => byVariant[t.variant].push(i));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    variants.forEach((v, vi) => {
      const list = byVariant[vi];
      if (!list.length) return;
      const sway = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
      sway.setUsage(THREE.DynamicDrawUsage);
      const wood = v.wood.clone(), snow = v.snow.clone();
      wood.setAttribute('aSway', sway);
      snow.setAttribute('aSway', sway);
      const wm = new THREE.InstancedMesh(wood, mats.wood, list.length);
      const sm = new THREE.InstancedMesh(snow, mats.snow, list.length);
      wm.customDepthMaterial = mats.woodDepth;
      sm.customDepthMaterial = mats.snowDepth;
      for (const mesh of [wm, sm]) {
        mesh.castShadow = v.castShadow !== false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      }
      list.forEach((ti, k) => {
        const t = trees[ti];
        q.setFromAxisAngle(v3(0, 1, 0), t.rot);
        m.compose(v3(t.x, t.y, t.z), q, v3(t.scale, t.scale, t.scale));
        wm.setMatrixAt(k, m);
        sm.setMatrixAt(k, m);
        t.slot = { sway, k };
        t.height = v.height * t.scale;
        t.crownBase = v.crownBase * t.scale;
        t.maxR = v.maxR * t.scale;
        // A spring for the top: real conifers sway at 0.2-0.6 Hz, slower when taller.
        t.omega = TAU * clamp(3.2 / Math.sqrt(t.height), 0.25, 1.2);
        t.sx = 0; t.sz = 0; t.vx = 0; t.vz = 0;
        t.flutter = 0;
        t.maxLoad = t.load;
        t.phase = Math.random() * 100;
      });
      this.group.add(wm, sm);
      this.meshes.push(wm, sm);
    });
  }

  /** Push a tree's top with a velocity impulse (m/s, world x/z). */
  shake(t, ix, iz) {
    t.vx += ix;
    t.vz += iz;
    t.flutter = Math.min(1.5, t.flutter + Math.hypot(ix, iz) * 0.8);
  }

  /** The world position of a point `f` of the way up the tree, swayed. */
  pointUp(t, f) {
    const b = f * f * (1.4 - 0.4 * f);
    return v3(t.x + t.sx * b, t.y + t.height * f, t.z + t.sz * b);
  }

  /**
   * Step the springs. `wind(x, z)` gives the ambient wind at a tree (m/s). Calls `shed(t, amount)`
   * whenever a tree swings hard enough to drop some of its snow.
   */
  update(dt, wind, snowing, shed) {
    const s = Math.sin, now = G.uTime.value;
    for (const t of this.trees) {
      const w = wind(t.x, t.z);
      // Wind leans the top over a little (drag grows with the square of the speed) and its
      // turbulence keeps it moving.
      const gustiness = 0.5 + 0.5 * s(now * 0.37 + t.phase) * s(now * 0.23 + t.phase * 1.7);
      const lean = 0.012 * t.height / 10;
      const ex = w.x * Math.abs(w.x) * lean * (0.6 + 0.6 * gustiness);
      const ez = w.y * Math.abs(w.y) * lean * (0.6 + 0.6 * gustiness);
      const zeta = 0.07;
      const ax = -t.omega * t.omega * (t.sx - ex) - 2 * zeta * t.omega * t.vx;
      const az = -t.omega * t.omega * (t.sz - ez) - 2 * zeta * t.omega * t.vz;
      t.vx += ax * dt; t.vz += az * dt;
      t.sx += t.vx * dt; t.sz += t.vz * dt;
      const speed = Math.hypot(t.vx, t.vz);
      t.flutter = Math.max(t.flutter * Math.exp(-dt / 2.5), 0.12 + Math.hypot(w.x, w.y) * 0.08);
      // A hard swing shakes snow loose; the load builds again slowly while it snows.
      if (speed > 0.35 && t.load > 0.05) {
        const lost = Math.min(t.load, (speed - 0.35) * dt * 0.45);
        t.load -= lost;
        // Snow comes off in a few clumps at a time, not a steady stream.
        t.shedAcc = (t.shedAcc || 0) + lost;
        if (t.shedAcc > 0.04) { shed(t, t.shedAcc); t.shedAcc = 0; }
      } else if (snowing && t.load < t.maxLoad) {
        t.load = Math.min(t.maxLoad, t.load + dt / 600);
      }
      // Into the tree's own frame for the shader.
      const c = Math.cos(t.rot), sn = Math.sin(t.rot), k = 1 / t.scale;
      const a = t.slot.sway.array, i = t.slot.k * 4;
      a[i] = (t.sx * c - t.sz * sn) * k;
      a[i + 1] = (t.sx * sn + t.sz * c) * k;
      a[i + 2] = t.load;
      a[i + 3] = t.flutter;
    }
    for (const mesh of this.meshes) mesh.geometry.attributes.aSway.needsUpdate = true;
  }

  dispose() {
    for (const mesh of this.meshes) mesh.geometry.dispose();
  }
}
