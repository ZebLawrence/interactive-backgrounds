// Aspen Snow — Quaking aspen: procedural trees built branch by branch, their bark drawn in the
// shader in metres, a ridge of snow along every branch, swaying on springs, shedding snow when
// the wind (or the cursor) shakes them and cascading it when a trunk is struck.
//
// Built like the real thing (Populus tremuloides in a dense clonal stand): a straight, slender,
// slightly leaning trunk, self-pruned bare to well over half its height where the grove shades
// it, then an open crown of ascending branches that fork and end in fans of fine twigs. The bark
// is smooth and chalky greenish-white, marked with black "eyes" (the scars of shed branches,
// often with a dark tear below), short horizontal lenticels, the odd canker, and on older trunks
// rough black furrowed bark on the lowest metre or two. In winter there are no leaves; snow lies
// in a ridge along the top of each branch and twig.

import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep, noise2, v3, unit } from './util.js';
import { G, Q, NOISE_GLSL, patchMaterial, patchDepth } from './shaders.js';

// Vertex kinds, in aF.x.
export const BARK = 0, TWIG = 1, SNOW = 2, BRANCH = 3;

/** Accumulates the vertices of one tree. aF = (kind, flex, tH, y metres); aC across; aT thickness. */
class Builder {
  constructor() {
    this.wood = { pos: [], uv: [], f: [], c: [], t: [], idx: [] };
    this.snow = { pos: [], uv: [], f: [], c: [], t: [], idx: [] };
  }

  /** A grid of `rows` x `cols` vertices produced by `at(r, c)` → {p, uv, f, c, t}. */
  grid(target, rows, cols, at, wrap = false) {
    const base = target.pos.length / 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = at(r, c);
        target.pos.push(v.p.x, v.p.y, v.p.z);
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

  /**
   * A tapered tube along `path(s)` (s in 0..1) with radius `radius(s)`, `sides` round, `rows`
   * along. uv in metres (around, along). `fAt(s)` gives the aF for a row.
   */
  tube(target, path, radius, sides, rows, fAt, uvOffset = 0) {
    // Frames along the path from finite differences.
    const frames = [];
    let prevN = null;
    for (let r = 0; r <= rows; r++) {
      const s = r / rows;
      const p = path(s);
      const d = unit(path(Math.min(1, s + 0.01)).sub(path(Math.max(0, s - 0.01))));
      let n = prevN ? unit(prevN.clone().sub(d.clone().multiplyScalar(prevN.dot(d)))) : unit(Math.abs(d.y) < 0.9 ? v3(0, 1, 0).cross(d) : v3(1, 0, 0).cross(d));
      if (n.lengthSq() < 1e-6) n = unit(v3(1, 0, 0).cross(d));
      const bn = d.clone().cross(n);
      frames.push({ p, n, bn, s });
      prevN = n;
    }
    let along = 0;
    for (let r = 1; r < frames.length; r++) { along += frames[r].p.distanceTo(frames[r - 1].p); frames[r].along = along; }
    frames[0].along = 0;
    this.grid(target, rows + 1, sides + 1, (r, c) => {
      const fr = frames[r], a = c / sides * TAU, rad = radius(fr.s);
      const p = fr.p.clone().addScaledVector(fr.n, Math.cos(a) * rad).addScaledVector(fr.bn, Math.sin(a) * rad);
      return { p, uv: [a * rad + uvOffset, fr.along + uvOffset * 3], f: fAt(fr.s, p), c: 0 };
    });
    return frames;
  }

  /**
   * A ridge of snow along the top of a tube: three vertices across, the middle lifted by the
   * thickness (`t`), the sides sitting at the surface either side of the top.
   */
  ridge(target, frames, radius, thick, fAt) {
    const up = v3(0, 1, 0);
    this.grid(target, frames.length, 3, (r, ci) => {
      const fr = frames[r], c = ci - 1, rad = radius(fr.s);
      const d = unit(fr.bn.clone().cross(fr.n));                 // along
      let side = unit(d.clone().cross(up));
      if (side.lengthSq() < 1e-6) side = fr.n.clone();
      const top = unit(side.clone().cross(d));
      if (top.y < 0) top.negate();
      const p = fr.p.clone().addScaledVector(top, rad * (1 - 0.25 * c * c)).addScaledVector(side, c * rad * 0.95);
      const th = thick(fr.s) * (1 - 0.7 * c * c);
      return { p, uv: [fr.s * 10, c * rad], f: fAt(fr.s, p), c, t: th };
    });
  }

  geometry(target, offsetThickness = false) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(target.pos);
    if (offsetThickness) {
      // Normals for the snow ridges are computed at full thickness, then the thickness is taken
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
 * Build one aspen. `rng` is a seeded random; `H` the height in metres; `detail` 1 for trees near
 * the viewer and lower for far ones (fewer sides, no sub-branches, bigger fans). `sapling` builds
 * a knee-high sucker instead: thin, with a few twigs from low down.
 */
export function buildAspen(rng, H, detail = 1, opts = {}) {
  const R = (lo, hi) => lo + rng() * (hi - lo);
  const b = new Builder();
  const up = v3(0, 1, 0);
  const sapling = !!opts.sapling;
  const young = !!opts.young;

  // The trunk: slender, with a slight lean and a gentle bend, bark mapped in metres.
  const baseR = sapling ? 0.006 + H * 0.004 : young ? 0.012 + H * 0.0045 : 0.03 + H * 0.0085;
  const lean = v3(R(-1, 1), 0, R(-1, 1)).multiplyScalar(H * (sapling ? 0.05 : R(0.008, 0.03)));
  const bendPh = R(0, TAU), bendA = H * R(0.004, 0.014);
  const axis = (y) => {
    const t = y / H;
    return v3(lean.x * t * t + Math.sin(t * 2.1 + bendPh) * bendA * t, y, lean.z * t * t + Math.cos(t * 1.7 + bendPh) * bendA * t);
  };
  const trunkR = (t) => baseR * Math.pow(1 - t, 0.75) * (1 + 0.25 * Math.exp(-t * H / 0.4)) + 0.006;
  // No trunk is a true cylinder: the section wanders in and out round the trunk and up it, and
  // old branch stubs and wounds leave swellings; the mean diameter stays what it was.
  const bumps = [];
  if (!sapling) for (let i = 0, n = 3 + Math.floor(R(0, 5)); i < n; i++) bumps.push({ y: R(0.3, H * 0.7), a: R(0, TAU), s: R(0.1, 0.3), w: R(0.15, 0.6) });
  const irregular = (a, y, t) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    let k = 1 + 0.13 * (noise2(ca * 1.3 + 10 + seedK, sa * 1.3 + y * 0.45) - 0.5) * 2 + 0.06 * (noise2(ca * 3 + 20, sa * 3 + y * 1.6 + seedK) - 0.5) * 2;
    for (const bp of bumps) {
      let da = a - bp.a; da = Math.atan2(Math.sin(da), Math.cos(da));
      k += bp.s * Math.exp(-((y - bp.y) * (y - bp.y)) / (bp.w * bp.w) - da * da / 0.45);
    }
    return k;
  };
  const seedK = R(0, 100);
  const sides = detail > 0.8 ? 16 : detail > 0.5 ? 9 : 5;
  const rows = Math.max(6, Math.round(H * (detail > 0.8 ? 3.2 : detail > 0.5 ? 1.6 : 0.8)));
  b.grid(b.wood, rows + 1, sides + 1, (r, c) => {
    const t = Math.pow(r / rows, 1.3), a = c / sides * TAU;     // denser rows near the base
    const o = axis(t * H);
    const rad = trunkR(t) * (detail > 0.5 ? irregular(a, t * H, t) : 1);
    // The bottom ring sinks into the snow so the trunk never floats.
    const y = r === 0 ? -0.35 : o.y;
    return { p: v3(o.x + Math.cos(a) * rad, y, o.z + Math.sin(a) * rad), uv: [a * baseR, t * H], f: [BARK, baseR, t, t * H], c: 0 };
  });

  /** A branch from `o` in horizontal direction `dir`, rising, length L, base radius r0. */
  const branch = (o, dir, L, r0, theta0, tBase, flexBase, deep) => {
    // Ascending and curving upward: the angle from vertical shrinks along the branch.
    const path = (s) => {
      const th = theta0 * (1 - 0.45 * s);
      const horiz = Math.sin(th), vert = Math.cos(th);
      return o.clone().addScaledVector(dir, horiz * s * L).addScaledVector(up, vert * s * L - 0.06 * L * s * s * (1 - s));
    };
    const radius = (s) => r0 * (1 - s * 0.8) + 0.004;
    const bs = detail > 0.8 ? 6 : 4, br = detail > 0.8 ? 7 : 4;
    const fAt = (s, p) => [BRANCH, flexBase + s * 0.8, tBase + (p.y - o.y) / H, p.y];
    const frames = b.tube(b.wood, path, radius, bs, br, fAt, o.y);
    if (!sapling) b.ridge(b.snow, frames, radius, (s) => clamp(r0 * 0.9, 0.012, 0.05) * (0.6 + 0.4 * Math.sin(s * Math.PI)), (s, p) => [SNOW, flexBase + s * 0.8, tBase + (p.y - o.y) / H, p.y]);
    const tip = path(1), tipDir = unit(path(1).sub(path(0.92)));
    if (deep > 0 && detail > 0.5 && L > 0.5) {
      // Forks: two or three sub-branches, off to either side and rising.
      const n = 2 + (rng() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const s0 = R(0.3, 0.8);
        const ang = (k % 2 ? 1 : -1) * R(0.45, 0.9);
        const d2 = v3(dir.x * Math.cos(ang) - dir.z * Math.sin(ang), 0, dir.x * Math.sin(ang) + dir.z * Math.cos(ang));
        const o2 = path(s0);
        branch(o2, d2, L * R(0.4, 0.6) * (1 - s0 * 0.3), radius(s0) * 0.7, theta0 * R(0.8, 1.1), tBase + (o2.y - o.y) / H, flexBase + s0 * 0.8, deep - 1);
      }
    }
    fan(tip, tipDir, L * (sapling ? R(0.35, 0.5) : detail > 0.5 ? R(0.3, 0.45) : R(0.5, 0.7)), flexBase + 0.8, tBase + (tip.y - o.y) / H);
  };

  /** A fan of twigs: a vertical card from `tip` along `dir`, its twig pattern drawn in the shader. */
  const fan = (tip, dir, L, flex, tBase) => {
    const seed = rng();
    const d = unit(dir.clone().setY(dir.y * 0.6));
    let side = unit(d.clone().cross(up));
    if (side.lengthSq() < 1e-6) side = v3(1, 0, 0);
    const n = unit(side.clone().cross(d));           // in the card's plane, roughly up
    if (n.y < 0) n.negate();
    const W = L * 0.9;
    const cards = detail > 0.5 ? [n] : [n, side];
    for (const across of cards) {
      b.grid(b.wood, 2, 3, (r, ci) => {
        const c = ci - 1;
        const p = tip.clone().addScaledVector(d, r * L).addScaledVector(across, c * W * 0.5 * (r ? 1 : 0.12));
        return { p, uv: [r * L, c * W * 0.5 * (r ? 1 : 0.12)], f: [TWIG, flex + r * 0.5, tBase + (p.y - tip.y) / H, seed], c, t: L };
      });
    }
  };

  // The crown.
  const crownBase = H * (sapling ? R(0.2, 0.35) : young ? R(0.3, 0.45) : R(0.46, 0.62));
  let az = R(0, TAU);
  const spacing = sapling ? H * 0.12 : R(0.45, 0.75) / Math.sqrt(detail);
  for (let y = crownBase; y < H - (sapling ? 0.08 : 0.6); y += spacing * R(0.7, 1.3)) {
    const t = y / H, tc = (y - crownBase) / (H - crownBase);
    const n = rng() < 0.35 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      az += TAU * R(0.3, 0.45);
      const dir = v3(Math.cos(az), 0, Math.sin(az));
      const L = sapling ? H * R(0.25, 0.45) : H * lerp(R(0.11, 0.17), R(0.05, 0.09), tc) / Math.pow(detail, 0.3) * (young ? 0.8 : 1);
      const r0 = Math.max(0.006, trunkR(t) * R(0.22, 0.35));
      const theta0 = sapling ? R(0.5, 0.9) : lerp(R(0.75, 1.05), R(0.4, 0.65), tc);   // from vertical
      const o = axis(y).addScaledVector(dir, trunkR(t) * 0.7);
      branch(o, dir, L, r0, theta0, t, 0, sapling ? 0 : detail > 0.8 ? 3 : 2);
    }
  }
  // The leader: the trunk's last stretch as a branch going straight up, ending in a fan.
  {
    const top = axis(H - (sapling ? 0.05 : 0.5));
    const dir = v3(Math.cos(az + 1), 0, Math.sin(az + 1));
    fan(top, v3(dir.x * 0.3, 1, dir.z * 0.3).normalize(), sapling ? H * 0.18 : R(0.5, 0.8), 0.8, 1);
  }
  const maxR = sapling ? H * 0.4 : H * 0.14;
  return { wood: b.geometry(b.wood), snow: b.geometry(b.snow, true), height: H, crownBase, maxR, baseR };
}

/** A fallen branch or log lying along +x: dead grey wood, half sunk in the snow, snow on top. */
export function buildStick(rng, L, r) {
  const R = (lo, hi) => lo + rng() * (hi - lo);
  const b = new Builder();
  const bend = R(-0.08, 0.08) * L, ph = R(0, TAU);
  const path = (s) => v3(s * L, Math.sin(s * Math.PI) * bend * 0.3 + Math.sin(s * 3 + ph) * r * 0.3, Math.sin(s * Math.PI) * bend);
  const radius = (s) => r * (1 - 0.45 * s) * (1 + 0.06 * Math.sin(s * 23 + ph));
  const fAt = (s, p) => [BARK, -1, 0, p.y];
  const sides = r > 0.08 ? 12 : 6;
  const frames = b.tube(b.wood, path, radius, sides, Math.max(4, Math.round(L * 2)), fAt);
  // A few stubs of broken branches.
  for (let i = 0; i < Math.round(L * 1.5); i++) {
    const s = R(0.1, 0.9), a = R(-1.2, 1.2) + (rng() < 0.5 ? 0 : Math.PI);
    const o = path(s), d = v3(R(-0.3, 0.3), Math.cos(a), Math.sin(a)).normalize();
    const sl = R(0.1, 0.4) * (0.5 + r * 3);
    b.tube(b.wood, (q) => o.clone().addScaledVector(d, q * sl), (q) => radius(s) * 0.25 * (1 - q * 0.7) + 0.003, 4, 2, fAt);
  }
  b.ridge(b.snow, frames, radius, (s) => clamp(r * 0.6, 0.03, 0.14) * (0.7 + 0.3 * Math.sin(s * Math.PI)), (s, p) => [SNOW, 0, 0, p.y]);
  return { wood: b.geometry(b.wood), snow: b.geometry(b.snow, true), length: L, radius: r };
}

// ---------------------------------------------------------------------------------------------
// Materials. Every tree shares two: the wood (bark, branches, twig fans), and the snow ridges.
// Per instance, aSway carries the top's sway (x, z, in the tree's own frame), the snow load and
// the shiver; aInst the bark seed and the cascade front (snow remains only below it).
// ---------------------------------------------------------------------------------------------

const DEFORM_HEAD = `
attribute vec4 aF;
attribute float aC;
attribute float aT;
attribute vec4 aSway;
attribute vec2 aInst;
varying vec4 vF;
varying float vC;
varying vec2 vMUv;
varying float vLoad;
varying float vSeed;
varying float vT;
uniform float uTime;
uniform vec2 uWind;
${Q}
`;
const DEFORM_MAIN = `
  vF = aF; vC = aC; vMUv = uv; vSeed = aInst.x; vT = aT;
  float tH = clamp(aF.z, 0.0, 1.0);
  // Snow stays only below the cascade front (1 when the tree is undisturbed).
  float snowOn = clamp(aSway.z, 0.0, 1.0) * (1.0 - smoothstep(aInst.y - 0.02, aInst.y + 0.02, tH));
  vLoad = snowOn;
  if (aF.x == 2.0) gPos.y += aT * snowOn;
  float flex = aF.y;
  if (aF.x == 1.0 || aF.x == 3.0 || aF.x == 2.0) {
    // Branches bend a little under their snow and flutter in the wind, most at the tips.
    float ph = dot(gPos, vec3(1.7, 0.9, 1.3)) + aInst.x * 20.0;
    float w = length(uWind) * 0.2 + 0.4;
    gPos.y -= snowOn * 0.03 * flex * flex;
    gPos.y += sin(uTime * q(1.9) + ph) * 0.012 * flex * w;
    gPos.xz += vec2(sin(uTime * q(1.3) + ph * 1.3), cos(uTime * q(1.6) + ph)) * 0.008 * flex * w;
  }
  // The whole tree sways from the base, and shivers when struck.
  gPos.xz += aSway.xy * (tH * tH * (1.4 - 0.4 * tH));
  gPos.xz += vec2(sin(uTime * q(23.0) + gPos.y * 2.3), cos(uTime * q(27.0) + gPos.y * 1.9)) * aSway.w * 0.03 * tH;
`;

const BARK_GLSL = `
uniform sampler2D uFeature, uDetail, uRough;
// The bark, from the painted maps (see bark.js): p is the position on the trunk in metres
// (around, up), seed the tree's own offset, circ its circumference (0 for branches), dead 1 for
// bare fallen wood. Returns the colour; rough and bump come out through the out parameters.
vec3 aspenBark(vec2 p, float seed, float dead, float circ, out float rough, out float bump) {
  // Round a trunk the feature map is squeezed to a whole number of repeats, so it meets itself
  // at the seam (thin trunks get smaller eyes, as they do).
  float ax = circ > 0.0 ? p.x / circ * max(1.0, floor(circ + 0.5)) : p.x;
  vec2 fuv = vec2(ax + seed * 0.37, p.y / 4.0 + seed * 1.7);
  vec4 F = texture2D(uFeature, fuv);
  vec4 D = texture2D(uDetail, p / 0.2);
  vec4 Rg = texture2D(uRough, vec2(ax + seed * 0.61, p.y / 2.0 + seed * 0.9));
  // The rough bark of the foot: a sharp, ragged edge a metre or two up.
  // Only the older trunks have much of it; on the rest it is a dark collar at the snow.
  float hOld = hash11(seed * 5.0 + 1.0);
  float top = hOld < 0.4 ? 0.1 + 0.3 * hOld : 0.3 + 1.6 * hOld;
  // The edge wanders round the trunk in rounded tongues, following the ridges a little.
  float edge = p.y + 0.1 * sin(ax * 12.57 + seed * 9.0) + 0.06 * sin(ax * 31.4 + seed * 3.0) + 0.03 * sin(ax * 69.1 + seed * 2.0) + (Rg.a - 0.5) * 0.03;
  float furrow = (circ > 0.0 && dead < 0.5) ? 1.0 - smoothstep(top - 0.035, top + 0.035, edge) : 0.0;
  vec3 smoothCol = F.rgb * (0.92 + 0.16 * D.r) * (0.96 + 0.08 * D.b);
  vec3 roughCol = Rg.rgb * (0.8 + 0.4 * D.g);
  vec3 col = mix(smoothCol, roughCol, furrow);
  rough = mix(0.62 + 0.1 * D.r, 0.98, furrow);
  bump = mix((F.a - 0.5) * 0.045 + (D.a - 0.5) * 0.003, (Rg.a - 0.5) * 0.012, furrow);
  // Dead wood (fallen branches, logs): weathered silver-grey, the bark gone, the grain showing.
  vec3 g2 = mix(vec3(0.16, 0.15, 0.13), vec3(0.34, 0.33, 0.30), D.b) * (0.85 + 0.3 * D.g);
  col = mix(col, g2, dead);
  rough = mix(rough, 0.9, dead);
  bump = mix(bump, (D.a - 0.5) * 0.004, dead);
  return col;
}
`;

const TWIG_GLSL = `
// Distance across from a straight twig segment from p0 along unit dir, of length len; also how
// far along (0..1) in t.
float segDist(vec2 m, vec2 p0, vec2 dir, float len, out float t) {
  vec2 d = m - p0;
  float along = dot(d, dir);
  t = along / len;
  along = clamp(along, 0.0, len);
  return length(d - dir * along);
}
// The twigs on a card: coverage, and how much of what's covered is snow on the twigs' upper
// sides. m is the position on the card in metres (along, across: + is up), L the card's length.
// Six twigs leave the branch end, spread a little either side and curving upward as they go,
// each with two side twigs.
float twigCover(vec2 m, float L, float seed, float load, out float snowK, out float shade) {
  float cover = 0.0; snowK = 0.0; shade = 0.0;
  float fw = max(fwidth(m.x), 1e-4);
  float r = length(m), a = atan(m.y, m.x);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float h = hash11(seed * 13.1 + fi * 1.7), h2 = hash11(seed * 7.7 + fi * 2.3);
    float a0 = (fi - 3.0) * 0.14 + (h - 0.5) * 0.1;
    float len = L * (0.5 + 0.5 * h2);
    // Curving upward, more the longer it goes.
    float curve = 0.25 + 0.4 * h;
    float ai = a0 + curve * r / L;
    float da = abs(a - ai) * r;
    float t = r / len;
    float w = 0.004 * (1.0 - 0.65 * clamp(t, 0.0, 1.0)) + 0.0008;
    float on = step(0.0, m.x) * (1.0 - smoothstep(0.97, 1.03, t));
    float twig = (1.0 - smoothstep(w - fw, w + fw, da)) * on;
    float dy = (a - ai) * r;
    float snow = (1.0 - smoothstep(w + 0.005 * load - fw, w + 0.005 * load + fw, da)) * on * step(0.0, dy) * step(0.25, load) * step(0.12, t);
    snowK = max(snowK, snow * (1.0 - twig));
    shade = max(shade, twig * (1.0 - smoothstep(0.0, w, da)));
    cover = max(cover, max(twig, snow));
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      float s0 = 0.3 + 0.3 * fk + 0.15 * hash11(seed + fi * 3.1 + fk);
      float sgn = fk < 0.5 ? 1.0 : -1.0;
      float a1 = a0 + curve * s0 * len / L;
      float ab = a1 + sgn * (0.3 + 0.25 * hash11(seed * 2.0 + fi + fk)) + 0.15;
      vec2 p0 = vec2(cos(a1), sin(a1)) * s0 * len;
      float tt;
      float ds = segDist(m, p0, vec2(cos(ab), sin(ab)), len * (0.22 + 0.15 * h2), tt);
      float ws = 0.0025 * (1.0 - 0.5 * tt) + 0.0007;
      float side = (1.0 - smoothstep(ws - fw, ws + fw, ds)) * step(0.0, tt) * step(tt, 1.0);
      vec2 rel = m - p0; float dys = rel.x * -sin(ab) + rel.y * cos(ab);
      float ssnow = (1.0 - smoothstep(ws + 0.004 * load - fw, ws + 0.004 * load + fw, ds)) * step(0.0, tt) * step(tt, 1.0) * step(0.0, dys) * step(0.25, load);
      snowK = max(snowK, ssnow * (1.0 - side));
      cover = max(cover, max(side, ssnow));
    }
  }
  // Far away the twigs merge into a faint, broken grey mass so the crowns don't vanish.
  float far = smoothstep(0.025, 0.07, fw);
  float mass = 0.2 * step(0.0, m.x) * (1.0 - smoothstep(0.35, 1.0, r / L)) * (1.0 - smoothstep(0.2, 0.5, abs(a - 0.25 * r / L)));
  mass *= 0.5 + 0.5 * vnoise(m * 30.0 + seed * 40.0);
  return mix(cover, max(cover, mass), far);
}
`;

const SNOW_GLSL = `
// The ridge's coverage: full along the middle, breaking up at the sides and when the load is low.
float ridgeCover(vec2 m, float c, float load, float seed) {
  float n = vnoise(m * vec2(12.0, 60.0) + seed * 13.0) * 0.6 + vnoise(m * vec2(40.0, 200.0) + seed) * 0.4;
  float mid = 1.0 - c * c;
  float thr = 1.1 - load * 1.0;
  return smoothstep(thr, thr + 0.15, n * 0.5 + mid * 0.65);
}
`;

const PERTURB_GLSL = `
// Tilt a normal by a bump height's screen-space gradient (the method of three's bump map).
vec3 perturbByHeight(vec3 n, vec3 pos, float h, float scale) {
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  float hx = dFdx(h) * scale, hy = dFdy(h) * scale;
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec3 g = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * n - g);
}
`;

export function makeTreeMaterials(bark) {
  const shared = { uTime: G.uTime, uWind: G.uWind, uSun: G.uSun, uNight: G.uNight };
  const barkU = { ...shared, uFeature: { value: bark.feature }, uDetail: { value: bark.detail }, uRough: { value: bark.rough } };
  const wood = patchMaterial(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true, transparent: false,
  }), {
    key: 'aspen-wood',
    uniforms: barkU,
    vHead: DEFORM_HEAD,
    vMain: DEFORM_MAIN,
    fHead: `
      varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad; varying float vSeed; varying float vT;
      uniform float uSun, uNight;
      ${NOISE_GLSL}${BARK_GLSL}${TWIG_GLSL}${PERTURB_GLSL}`,
    fColor: `
      float barkBump = 0.0;
      float barkRough = 0.6;
      float kind = vF.x;
      vec3 base;
      if (kind < 0.5 || kind > 2.5) {
        float dead = kind < 0.5 && vF.y < -0.5 ? 1.0 : 0.0;
        float circ = kind < 0.5 && vF.y > 0.0 ? 6.2831853 * vF.y : 0.0;
        base = aspenBark(vMUv, vSeed + (kind > 2.5 ? vF.w * 0.37 : 0.0), dead, circ, barkRough, barkBump);
        if (kind < 0.5 && dead < 0.5) {
          // The foot of the trunk, where the snow banks against it, is in the shade of both.
          base *= 1.0 - 0.4 * (1.0 - smoothstep(-0.1, 0.5, vF.w));
        }
        if (kind > 2.5) {
          // Branches: the same bark, smoother and greyer toward the thin ends.
          base = mix(base, vec3(0.30, 0.28, 0.22), smoothstep(0.3, 1.0, vF.y) * 0.5);
        }
        diffuseColor.a = 1.0;
      } else {
        float snowK, shade;
        float cover = twigCover(vMUv, vT, vF.w, vLoad, snowK, shade);
        if (cover < 0.02) discard;
        diffuseColor.a = cover;
        // Twigs: grey-brown, a touch reddish at the buds; snow where it lies on them.
        vec3 twig = mix(vec3(0.12, 0.10, 0.08), vec3(0.26, 0.21, 0.16), hash21(floor(vMUv * 40.0) + vSeed));
        twig *= 1.0 - shade * 0.35;
        base = mix(twig, vec3(0.9, 0.92, 0.96), snowK);
        barkRough = mix(0.8, 0.6, snowK);
      }
      diffuseColor.rgb = base;`,
    fNormal: `
      if (vF.x < 0.5 || vF.x > 2.5) normal = perturbByHeight(normal, -vViewPosition, barkBump, 1.0);`,
    fRough: `
      roughnessFactor = barkRough;`,
  });
  const snow = patchMaterial(new THREE.MeshStandardMaterial({
    color: 0xf6f8ff, roughness: 0.75, metalness: 0, alphaToCoverage: true,
  }), {
    key: 'aspen-snow',
    uniforms: shared,
    vHead: DEFORM_HEAD,
    vMain: DEFORM_MAIN,
    fHead: `
      varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad; varying float vSeed;
      ${NOISE_GLSL}${SNOW_GLSL}`,
    fColor: `
      float cover = ridgeCover(vMUv, vC, vLoad, vSeed);
      if (cover < 0.03) discard;
      diffuseColor.a = cover;
      // Shaded snow at the ridge's edges looks blue.
      diffuseColor.rgb *= mix(vec3(0.8, 0.86, 1.0), vec3(1.0), smoothstep(0.0, 0.6, 1.0 - abs(vC)));`,
  });
  // Shadow passes, with the same bending and a coarse version of the cut-outs.
  const woodDepth = patchDepth({
    key: 'aspen-wood', uniforms: shared, vHead: DEFORM_HEAD, vMain: DEFORM_MAIN,
    fHead: `varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad; varying float vSeed; varying float vT;\n${NOISE_GLSL}${TWIG_GLSL}`,
    fDiscard: `
      if (vF.x == 1.0) {
        float snowK, shade;
        if (twigCover(vMUv, vT, vF.w, vLoad, snowK, shade) < 0.5) discard;
      }`,
  });
  const snowDepth = patchDepth({
    key: 'aspen-snow', uniforms: shared, vHead: DEFORM_HEAD, vMain: DEFORM_MAIN,
    fHead: `varying vec4 vF; varying float vC; varying vec2 vMUv; varying float vLoad; varying float vSeed;\n${NOISE_GLSL}${SNOW_GLSL}`,
    fDiscard: `if (ridgeCover(vMUv, vC, vLoad, vSeed) < 0.5) discard;`,
  });
  return { wood, snow, woodDepth, snowDepth };
}

// ---------------------------------------------------------------------------------------------
// The grove: instances of a handful of tree variants, each on its own spring, with a snow load
// that the wind and the cursor can shake off, or a struck trunk can send down in a cascade.
// ---------------------------------------------------------------------------------------------

export class Grove {
  /**
   * `variants`: built trees; `trees`: [{x, y, z, rot, scale, variant, load}] in world space.
   */
  constructor(variants, trees, mats, opts = {}) {
    this.group = new THREE.Group();
    this.variants = variants;
    this.trees = trees;
    this.mats = mats;
    this.meshes = [];
    this.swayAttrs = [];
    const byVariant = variants.map(() => []);
    trees.forEach((t, i) => byVariant[t.variant].push(i));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    variants.forEach((v, vi) => {
      const list = byVariant[vi];
      if (!list.length) return;
      const sway = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
      sway.setUsage(THREE.DynamicDrawUsage);
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 2), 2);
      inst.setUsage(THREE.DynamicDrawUsage);
      const wood = v.wood.clone(), snow = v.snow.clone();
      wood.setAttribute('aSway', sway); wood.setAttribute('aInst', inst);
      snow.setAttribute('aSway', sway); snow.setAttribute('aInst', inst);
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
        t.slot = { sway, inst, k };
        t.height = v.height * t.scale;
        t.crownBase = v.crownBase * t.scale;
        t.maxR = v.maxR * t.scale;
        t.baseR = v.baseR * t.scale;
        // A spring for the top: slender hardwoods sway at 0.2-0.5 Hz, slower when taller.
        t.omega = TAU * clamp(1.6 / Math.sqrt(t.height), 0.2, 1.5);
        // The top of a tall tree moves faster for the same bend: snow comes off at a higher speed.
        t.shedSpeed = 0.9 * Math.sqrt(Math.max(t.height, 1) / 8);
        t.sx = 0; t.sz = 0; t.vx = 0; t.vz = 0;
        t.shiver = 0;
        t.maxLoad = t.load;
        t.front = 1;
        t.cascade = null;
        t.phase = Math.random() * 100;
        t.seed = Math.random();
        inst.array[k * 2] = t.seed;
        inst.array[k * 2 + 1] = 1;
      });
      inst.needsUpdate = true;
      this.group.add(wm, sm);
      this.meshes.push(wm, sm);
      this.swayAttrs.push(sway, inst);
    });
  }

  /** Push a tree's top with a velocity impulse (m/s, world x/z). */
  shake(t, ix, iz) {
    t.vx += ix;
    t.vz += iz;
  }

  /** Strike a trunk: it shivers and its snow comes down from the top, branch by branch. */
  strike(t) {
    t.shiver = Math.min(1.5, t.shiver + 1);
    if (!t.cascade && t.load > 0.05) t.cascade = { front: 1, speed: 0.1 + 0.08 / Math.max(0.5, t.height / 15) };
  }

  /** The world position of a point `f` of the way up the tree, swayed. */
  pointUp(t, f) {
    const b = f * f * (1.4 - 0.4 * f);
    return v3(t.x + t.sx * b, t.y + t.height * f, t.z + t.sz * b);
  }

  /**
   * Step the springs. `wind(x, z)` gives the ambient wind at a tree (m/s). Calls `shed(t, amount,
   * f)` whenever a tree drops snow, with `f` the fraction of its height it falls from.
   */
  update(dt, wind, snowing, shed) {
    const s = Math.sin, now = G.uTime.value;
    for (const t of this.trees) {
      const w = wind(t.x, t.z);
      // Wind leans the top over a little (drag grows with the square of the speed) and its
      // turbulence keeps it moving.
      const gustiness = 0.5 + 0.5 * s(now * 0.37 + t.phase) * s(now * 0.23 + t.phase * 1.7);
      const lean = 0.02 * t.height / 15;
      const ex = w.x * Math.abs(w.x) * lean * (0.6 + 0.6 * gustiness);
      const ez = w.y * Math.abs(w.y) * lean * (0.6 + 0.6 * gustiness);
      const zeta = 0.06;
      const ax = -t.omega * t.omega * (t.sx - ex) - 2 * zeta * t.omega * t.vx;
      const az = -t.omega * t.omega * (t.sz - ez) - 2 * zeta * t.omega * t.vz;
      t.vx += ax * dt; t.vz += az * dt;
      t.sx += t.vx * dt; t.sz += t.vz * dt;
      t.shiver *= Math.exp(-dt / 0.6);
      const speed = Math.hypot(t.vx, t.vz);
      if (t.cascade) {
        // The front runs down the crown; snow above it is gone, shed as it passes.
        const c = t.cascade;
        const prev = c.front;
        c.front -= c.speed * dt;
        const crownF = t.crownBase / t.height;
        if (c.front <= crownF) {
          t.cascade = null; t.front = 1; t.load = 0;
          shed(t, 0.06, crownF + 0.05);
        } else {
          t.front = c.front;
          if (Math.floor(prev * 14) !== Math.floor(c.front * 14)) shed(t, 0.16 * t.load, c.front);
        }
      } else if (speed > t.shedSpeed && t.load > 0.05) {
        // A hard swing shakes snow loose; the load builds again slowly while it snows.
        const lost = Math.min(t.load, (speed - t.shedSpeed) * dt * 0.18);
        t.load -= lost;
        // Snow comes off in a few clumps at a time, not a steady stream.
        t.shedAcc = (t.shedAcc || 0) + lost;
        if (t.shedAcc > 0.04) { shed(t, t.shedAcc, t.crownBase / t.height + Math.random() * (1 - t.crownBase / t.height)); t.shedAcc = 0; }
      } else if (snowing && t.load < t.maxLoad) {
        t.load = Math.min(t.maxLoad, t.load + dt / 900);
      }
      // Into the tree's own frame for the shader.
      const c = Math.cos(t.rot), sn = Math.sin(t.rot), k = 1 / t.scale;
      const a = t.slot.sway.array, i = t.slot.k * 4;
      a[i] = (t.sx * c - t.sz * sn) * k;
      a[i + 1] = (t.sx * sn + t.sz * c) * k;
      a[i + 2] = t.load;
      a[i + 3] = t.shiver;
      t.slot.inst.array[t.slot.k * 2 + 1] = t.front;
    }
    for (const attr of this.swayAttrs) attr.needsUpdate = true;
  }

  dispose() {
    for (const mesh of this.meshes) mesh.geometry.dispose();
  }
}
