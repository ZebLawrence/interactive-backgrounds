// Boreal Night — The great grey owl's plumage: its sculpted body, the thousands of overlapping
// contour feathers that give it a soft, ragged outline, the 12-feather tail, the plumage
// patterns and the moonlit rim.
//
// A great grey is mostly feathers (a bird of about a kilogram inside a coat that makes it look
// three times that), so its outline is never a clean curve: the contour feathers lie in
// overlapping rows like shingles, flowing down the body and back over the head from the face,
// each a vane with a dark shaft, fine barring and a slightly frayed edge, downy at its base.
// With the moon behind the owl that fringe catches the light and glows silver, the way backlit
// owls do in photographs.

import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep, v3, seeded } from './util.js';
import { G, Q, NOISE_GLSL, patchMaterial } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Patterns shared by every part of the owl
// ---------------------------------------------------------------------------------------------

export const PLUMAGE_GLSL = `
${NOISE_GLSL}
// Rows of overlapping feathers: in each cell a rounded tip, shaded darker at its edge.
float feathers(vec2 p, out float edge) {
  vec2 g = p;
  g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
  vec2 c = floor(g), f = fract(g) - vec2(0.5, 0.25);
  float d = length(f * vec2(1.0, 1.4));
  edge = smoothstep(0.32, 0.55, d);
  return hash21(c);
}
// The great grey's all-over vermiculation: fine, wavy, broken grey-brown bars.
float vermic(vec2 p) {
  float w = vnoise(p * vec2(9.0, 3.0)) * 5.0;
  float bars = sin(p.y * 260.0 + w + vnoise(p * 60.0) * 2.0);
  return smoothstep(0.2, 0.9, bars) * (0.6 + 0.4 * vnoise(p * 80.0));
}
`;

// Each owl's own plumage: an overall tint (cool ash grey to warm brownish), how strongly its
// markings stand out, and how heavily its breast is streaked.
export const LOOK_GLSL = `
uniform vec3 uTint; uniform float uContrast, uStreak;
vec3 applyLook(vec3 c) { return max(mix(vec3(0.45), c, uContrast) * uTint, 0.0); }
`;

/** The body's colour at a point of the body (local metres): needs PLUMAGE and LOOK. */
export const BODY_GLSL = `
vec3 bodyBase(vec3 p) {
  float ang = atan(p.x, p.z);
  float front = cos(ang);
  // Pale ash grey below, a browner grey on the mantle.
  vec3 c = mix(vec3(0.44, 0.43, 0.41), vec3(0.34, 0.32, 0.3), smoothstep(0.3, -0.7, front));
  c = mix(c, vec3(0.5, 0.49, 0.47), smoothstep(0.2, 0.0, p.y) * 0.5);
  c *= 1.0 - 0.2 * vermic(vec2(ang * 0.18 + vnoise(p.xy * 40.0) * 0.02, p.y + vnoise(vec2(ang * 30.0, p.y * 20.0)) * 0.006));
  // Bold, blurred dark streaks down the breast.
  float streak = smoothstep(0.6, 0.82, vnoise(vec2(ang * 16.0, p.y * 5.0 + 3.0))) * smoothstep(0.0, 0.6, front) * smoothstep(0.42, 0.22, p.y) * smoothstep(0.05, 0.15, p.y);
  c = mix(c, vec3(0.16, 0.14, 0.13), clamp(streak * 0.7 * uStreak, 0.0, 1.0));
  // A pale band across the shoulders (the scapulars' white edges).
  c = mix(c, vec3(0.7, 0.69, 0.66), smoothstep(0.7, 0.85, vnoise(vec2(ang * 14.0, p.y * 30.0))) * smoothstep(-0.2, -0.6, front) * smoothstep(0.3, 0.38, p.y) * 0.5);
  return c;
}
vec3 crownBase(vec3 d, float y) {
  float ang = atan(d.x, d.z);
  return vec3(0.4, 0.39, 0.37) * (1.0 - 0.3 * vermic(vec2(ang * 0.15, y)));
}
`;

/**
 * Moonlight seen through and round the edge of feathers. With the moon behind the owl (as it is
 * from where the viewer stands), its outline glows: `rim` scales the glow at grazing angles,
 * `trans` the light that comes through thin vanes. Appended to `fEmissive`.
 */
export const RIM_HEAD = 'uniform vec3 uMoonDir; uniform float uMoon;';
export function rimEmissive(rim, trans) {
  return `
  {
    vec3 Vv = normalize(cameraPosition - vWPos);
    vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    float back = max(dot(-Vv, uMoonDir), 0.0);
    float edge = pow(1.0 - clamp(abs(dot(Nw, Vv)), 0.0, 1.0), 2.5);
    totalEmissiveRadiance += diffuseColor.rgb * vec3(0.72, 0.8, 1.0) * uMoon * back * (edge * ${rim.toFixed(3)} + ${trans.toFixed(3)});
  }`;
}
export const RIM_UNIFORMS = { uMoonDir: G.uMoonDir, uMoon: G.uMoon };

// ---------------------------------------------------------------------------------------------
// The body, lofted from cross-sections measured off side and front views: a broad, rounded
// breast, a flatter back that slopes back toward the tail, the flanks narrower (the folded wings
// make them), and the big head sitting right down on the shoulders with no neck to see.
// ---------------------------------------------------------------------------------------------

// y (m above the feet): half-width, breast depth, back depth, and the spine's lean back.
const SECTIONS = [
  [0.0, 0.02, 0.02, 0.02, -0.02],
  [0.02, 0.07, 0.065, 0.055, -0.022],
  [0.06, 0.115, 0.11, 0.095, -0.022],
  [0.11, 0.14, 0.14, 0.105, -0.02],
  // The back is shallower than the breast: the folded wings lie over it and make its outline.
  [0.18, 0.152, 0.158, 0.092, -0.014],
  [0.25, 0.156, 0.166, 0.088, -0.008],
  [0.31, 0.15, 0.163, 0.088, -0.003],
  [0.36, 0.137, 0.148, 0.09, 0.0],
  [0.4, 0.118, 0.124, 0.09, 0.004],
  [0.435, 0.088, 0.09, 0.07, 0.006],
  [0.46, 0.045, 0.045, 0.04, 0.006],
  [0.47, 0.0, 0.0, 0.0, 0.006],
];
const TOP = 0.47;

function section(y) {
  const S = SECTIONS;
  let i = 0;
  while (i < S.length - 2 && S[i + 1][0] < y) i++;
  const a = S[Math.max(0, i - 1)], b = S[i], c = S[i + 1], d = S[Math.min(S.length - 1, i + 2)];
  const t = clamp((y - b[0]) / (c[0] - b[0]), 0, 1);
  // Catmull-Rom through the table, column by column.
  const cr = (k) => {
    const p0 = a[k], p1 = b[k], p2 = c[k], p3 = d[k];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  return { w: Math.max(0, cr(1)), f: Math.max(0, cr(2)), b: Math.max(0, cr(3)), zc: cr(4) };
}

/** A point on the body at height y and angle a (0 straight ahead, +x to the owl's left... right). */
export function bodyPoint(y, a) {
  const s = section(y);
  const n = 2.3;
  const sa = Math.sin(a), ca = Math.cos(a);
  const e = (v) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);
  return v3(s.w * e(sa), y, s.zc + (ca > 0 ? s.f : s.b) * e(ca));
}

export function bodyNormal(y, a) {
  const h = 0.002;
  const dy = bodyPoint(Math.min(TOP, y + h), a).sub(bodyPoint(Math.max(0, y - h), a));
  const da = bodyPoint(y, a + 0.01).sub(bodyPoint(y, a - 0.01));
  const n = da.cross(dy).normalize();
  // Make sure it points out.
  const p = bodyPoint(y, a);
  if (n.dot(v3(p.x, 0, p.z - section(y).zc)) < 0) n.negate();
  return n;
}

export function bodyGeometry() {
  const rows = 46, segs = 64;
  const pos = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    // Denser at the bottom and top, where the shape turns fastest.
    const u = r / rows;
    const y = TOP * (0.5 - 0.5 * Math.cos(u * Math.PI));
    for (let s = 0; s <= segs; s++) {
      const p = bodyPoint(y, s / segs * TAU);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// The head's shape (shared by its mesh and its feathers): a big round head, a little wider than
// tall, the front flattened into the facial disc, dished in the middle, its rim standing proud.
// ---------------------------------------------------------------------------------------------

export const HEAD_R = 0.135;

export function headShape(d) {
  const x = d.x * HEAD_R, y = d.y * HEAD_R, z = d.z * HEAD_R;
  let nz = z * (z > 0 ? 0.5 : 0.85);
  if (d.z > 0.4) {
    const rr = Math.hypot(x, y) / 0.122;
    nz -= 0.008 * Math.max(0, 1 - rr * rr);
  }
  nz += 0.012 * Math.exp(-(((d.z - 0.43) / 0.06) ** 2));
  return v3(x, y * 0.9, nz);
}

function headNormal(d) {
  const t1 = v3(0, 1, 0).cross(d);
  if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
  t1.normalize();
  const t2 = d.clone().cross(t1).normalize();
  const h = 0.01;
  const pa = headShape(d.clone().addScaledVector(t1, h).normalize()).sub(headShape(d.clone().addScaledVector(t1, -h).normalize()));
  const pb = headShape(d.clone().addScaledVector(t2, h).normalize()).sub(headShape(d.clone().addScaledVector(t2, -h).normalize()));
  const n = pa.cross(pb).normalize();
  if (n.dot(headShape(d)) < 0) n.negate();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Contour feathers: each a small card rooted just under the surface, flowing along it and lifted
// a little off it, curling back toward it at the tip. Attributes:
//   aCard = (across -1..1, along 0..1, random, part: 0 body, 1 crown, 2 disc rim)
//   aRoot = where it grows, for its colour; aN = the surface normal there, for ruffling.
// ---------------------------------------------------------------------------------------------

class Cards {
  constructor() { this.pos = []; this.nrm = []; this.card = []; this.root = []; this.sn = []; this.idx = []; }

  /** root, surface normal n, flow direction t (tangent), length, width, lift (rad), part, colour root. */
  add(root, n, t, len, wid, lift, part, colourAt, rnd) {
    const b = n.clone().cross(t).normalize();
    const base = this.pos.length / 3;
    const dir = (k) => t.clone().multiplyScalar(Math.cos(lift * (1 - 0.55 * k))).addScaledVector(n, Math.sin(lift * (1 - 0.55 * k))).normalize();
    const start = root.clone().addScaledVector(n, -0.003);
    const mid = start.clone().addScaledVector(dir(0.25), len * 0.5);
    const tip = mid.clone().addScaledVector(dir(0.75), len * 0.5);
    const rows = [[start, 0], [mid, 0.5], [tip, 1]];
    for (const [p, along] of rows) {
      const d = dir(along);
      const cn = b.clone().cross(d).normalize();
      if (cn.dot(n) < 0) cn.negate();
      // Shade it half as the card and half as the surface, so the coat reads as one soft mass.
      const sn = cn.lerp(n, 0.5).normalize();
      for (const across of [-1, 1]) {
        const q = p.clone().addScaledVector(b, across * wid * 0.5 * (along === 0 ? 0.6 : 1));
        this.pos.push(q.x, q.y, q.z);
        this.nrm.push(sn.x, sn.y, sn.z);
        this.card.push(across, along, rnd, part);
        this.root.push(colourAt.x, colourAt.y, colourAt.z);
        this.sn.push(n.x, n.y, n.z);
      }
    }
    for (let r = 0; r < 2; r++) {
      const a = base + r * 2, c = a + 2;
      // Wound so the outer side is the front face.
      this.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.card, 4));
    g.setAttribute('aRoot', new THREE.Float32BufferAttribute(this.root, 3));
    g.setAttribute('aN', new THREE.Float32BufferAttribute(this.sn, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const project = (v, n) => v.clone().addScaledVector(n, -v.dot(n));

/** The body's coat, about 1,800 feathers in overlapping rows. */
export function bodyCardsGeometry(seed = 7) {
  const rng = seeded(seed);
  const C = new Cards();
  const dy = 0.0125;
  let row = 0;
  for (let y = 0.012; y < 0.425; y += dy, row++) {
    // How many fit round this row.
    let per = 0;
    let prev = bodyPoint(y, 0);
    for (let k = 1; k <= 48; k++) { const p = bodyPoint(y, k / 48 * TAU); per += p.distanceTo(prev); prev = p; }
    const count = Math.max(6, Math.round(per / 0.0165));
    for (let k = 0; k < count; k++) {
      const a = (k + (row % 2) * 0.5 + (rng() - 0.5) * 0.4) / count * TAU;
      const yy = y + (rng() - 0.5) * dy * 0.5;
      const p = bodyPoint(yy, a);
      const n = bodyNormal(yy, a);
      // Feathers flow down the body; near the top, back toward the tail.
      let t = project(v3(0, -1, -0.25), n);
      if (t.lengthSq() < 1e-4) t = project(v3(0, 0, -1), n);
      t.normalize();
      const side = Math.abs(Math.sin(a));
      const underWing = side > 0.72 && yy > 0.12 && yy < 0.38;
      // The folded wing covers the flank there; feathers under it would only poke through.
      if (side > 0.8 && yy > 0.15 && yy < 0.35) continue;
      // The belly and vent are the fluffiest: long, loose feathers that hide the feet.
      const belly = smoothstep(0.15, 0.02, yy);
      // Up under the chin they lie flat and long, flowing down over the breast.
      const chin = smoothstep(0.34, 0.41, yy);
      const lift = underWing ? 0.08 : lerp(0.26 + 0.35 * belly + rng() * 0.1, 0.06, chin);
      const len = (0.036 + 0.022 * belly + 0.012 * chin) * (0.85 + rng() * 0.3);
      C.add(p, n, t, len, len * 0.72, lift, 0, p, rng());
    }
  }
  return C.geometry();
}

/** The crown and nape (flowing back from the face) and the ruff that frames the facial disc. */
export function headCardsGeometry(seed = 11) {
  const rng = seeded(seed);
  const C = new Cards();
  const N = 1200;
  const from = v3(0, -0.03, 0.25);
  for (let i = 0; i < N; i++) {
    // Fibonacci points spread evenly over the sphere.
    const yv = 1 - (i + 0.5) / N * 2;
    const r = Math.sqrt(1 - yv * yv);
    const phi = i * 2.399963 + rng() * 0.2;
    const d = v3(Math.cos(phi) * r, yv, Math.sin(phi) * r);
    if (d.z > 0.4 || d.y < -0.9) continue;
    const p = headShape(d);
    const n = headNormal(d);
    let t = project(p.clone().sub(from), n);
    if (t.lengthSq() < 1e-6) continue;
    t.normalize();
    const len = (0.026 + 0.006 * smoothstep(0.0, -0.6, d.z)) * (0.85 + rng() * 0.3);
    C.add(p, n, t, len, len * 0.78, 0.2 + rng() * 0.12, 1, p, rng());
  }
  // The ruff: a ring of stiff, dark-tipped feathers standing up round the disc.
  const ring = 200;
  for (let k = 0; k < ring; k++) {
    const a = (k + rng() * 0.5) / ring * TAU;
    const dz = 0.43 + (rng() - 0.5) * 0.03;
    const rr = Math.sqrt(1 - dz * dz);
    const d = v3(Math.cos(a) * rr, Math.sin(a) * rr, dz);
    const p = headShape(d);
    const n = headNormal(d);
    // Pointing outward round the face and forward.
    const out = v3(Math.cos(a), Math.sin(a) * 0.9, 0);
    const t = project(out.multiplyScalar(0.8).add(v3(0, 0, 0.35)), n).normalize();
    const len = 0.016 * (0.8 + rng() * 0.4);
    C.add(p, n, t, len, len * 0.7, 0.6, 2, p, rng());
  }
  return C.geometry();
}

export function cardMaterial(look, ruffle) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true }), {
    key: 'owl-cards',
    uniforms: { uAuroraLight: G.uAuroraLight, uTime: G.uTime, uRuffle: ruffle, ...RIM_UNIFORMS, ...look },
    vHead: `attribute vec4 aCard; attribute vec3 aRoot; attribute vec3 aN; varying vec4 vCard; varying vec3 vRoot;
      uniform float uTime, uRuffle;\n${Q}`,
    vMain: `
      vCard = aCard; vRoot = aRoot;
      // Ruffled or fluffed out, the feathers lift off the body; the cold breeze stirs them.
      float lift = aCard.y * aCard.y * (uRuffle * 0.012 + 0.0016 * (0.5 + 0.5 * sin(uTime * q(1.3) + aCard.z * 40.0)));
      gPos += aN * lift;`,
    fHead: `varying vec4 vCard; varying vec3 vRoot; uniform vec3 uAuroraLight;\n${RIM_HEAD}\n${PLUMAGE_GLSL}${LOOK_GLSL}${BODY_GLSL}`,
    fColor: `
      {
        float u = vCard.x, t = vCard.y, rnd = vCard.z, part = vCard.w;
        // The vane: widest past the middle, a rounded tip, its edge a little frayed.
        float hw = sqrt(max(0.0, 1.0 - pow((t - 0.52) / 0.54, 2.0)));
        hw *= 0.8 + 0.2 * vnoise(vec2(t * 26.0 + rnd * 50.0, u > 0.0 ? 1.0 : 7.0));
        // Barbs part near the tip.
        float split = step(0.7, t) * step(fract((t + abs(u) * 0.7) * 16.0 + rnd * 9.0), 0.25 * smoothstep(0.7, 1.0, t));
        float fw = fwidth(u) * 1.5 + 0.02;
        float a = (1.0 - smoothstep(hw - fw, hw + fw, abs(u))) * (1.0 - split);
        // The base is down: thin and wispy.
        a *= mix(0.5 + 0.5 * vnoise(vec2(u * 9.0, t * 30.0)), 1.0, smoothstep(0.1, 0.35, t));
        if (a < 0.1) discard;
        diffuseColor.a = a;
        vec3 c = part < 0.5 ? bodyBase(vRoot) : part < 1.5 ? crownBase(normalize(vRoot), vRoot.y) : vec3(0.2, 0.18, 0.17);
        // The ruff is dark-tipped, except where the white bow tie crosses it under the chin.
        float tie = part > 1.5 ? smoothstep(0.05, 0.02, abs(vRoot.x)) * step(vRoot.y, -0.06) : 0.0;
        if (part > 1.5) c = mix(mix(c, vec3(0.16, 0.14, 0.13), smoothstep(0.3, 0.9, t) * 0.7), vec3(0.8, 0.79, 0.76), tie);
        c *= 0.88 + 0.24 * rnd;
        // Each feather's own fine bars, its dark shaft, a pale fringe at the tip, grey down below.
        float bars = smoothstep(0.3, 0.8, sin(t * 21.0 + abs(u) * 4.0 + rnd * 6.0) * 0.5 + 0.5);
        c *= 1.0 - 0.16 * bars;
        c = mix(c, c * 0.8, smoothstep(0.05, 0.0, abs(u)) * smoothstep(0.2, 0.5, t));
        c = mix(c, c * 1.2 + 0.03, smoothstep(0.8, 1.0, t) * 0.5);
        c = mix(c * 1.12, c, smoothstep(0.1, 0.4, t));
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: 'totalEmissiveRadiance += diffuseColor.rgb * uAuroraLight * 0.15;' + rimEmissive(0.9, 0.05),
  });
}

// ---------------------------------------------------------------------------------------------
// The tail: 12 long feathers, the central pair on top, fanned by the owl to brake and steer.
// aTail = (across -1..1, along 0..1 root to tip, feather index 0..11).
// ---------------------------------------------------------------------------------------------

export function tailFeathersGeometry() {
  const pos = [], tail = [], idx = [];
  const rows = 8;
  for (let i = 0; i < 12; i++) {
    const off = Math.abs(i - 5.5) / 5.5;
    const len = 0.28 - 0.03 * off * off;
    const w = 0.046;
    const x0 = (i - 5.5) * 0.0055;
    // The central feathers lie on top (the tail's upper side faces back).
    const z0 = -0.0022 * (5.5 - Math.abs(i - 5.5)) - 0.01;
    const base = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      for (const u of [-1, 0, 1]) {
        // A slight arch across the feather, the shaft standing up.
        pos.push(x0 + u * w * 0.5, -t * len, z0 - (1 - u * u) * 0.002 + t * t * 0.02);
        tail.push(u, t, i);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        const a = base + r * 3 + c, b = a + 1, d = a + 3, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTail', new THREE.Float32BufferAttribute(tail, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function tailMaterial(look) {
  const spread = { value: 0.1 };
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true }), {
    key: 'owl-tail',
    uniforms: { uAuroraLight: G.uAuroraLight, uSpread: spread, ...RIM_UNIFORMS, ...look },
    vHead: 'attribute vec3 aTail; varying vec3 vTail; uniform float uSpread;',
    vMain: `
      vTail = aTail;
      // Fan out about the root.
      float th = (aTail.z - 5.5) / 5.5 * uSpread;
      float cs = cos(th), sn = sin(th);
      gPos.xy = vec2(gPos.x * cs - gPos.y * sn, gPos.x * sn + gPos.y * cs);
      gNormal.xy = vec2(gNormal.x * cs - gNormal.y * sn, gNormal.x * sn + gNormal.y * cs);`,
    fHead: `varying vec3 vTail; uniform vec3 uAuroraLight;\n${RIM_HEAD}\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: `
      {
        float u = vTail.x, t = vTail.y, id = vTail.z;
        float hw = t < 0.86 ? 1.0 : sqrt(max(0.0, 1.0 - pow((t - 0.86) / 0.14, 2.0)));
        hw *= 0.92 + 0.08 * vnoise(vec2(t * 30.0, id * 7.0 + (u > 0.0 ? 3.0 : 0.0)));
        float fw = fwidth(u) * 1.5 + 0.02;
        float a = 1.0 - smoothstep(hw - fw, hw + fw, abs(u));
        if (a < 0.1) discard;
        diffuseColor.a = a;
        // Broad dark bands across the tail, mottled grey between, a dark shaft.
        float bands = smoothstep(0.35, 0.75, sin(t * 34.0 + vnoise(vec2(u * 3.0, t * 12.0 + id)) * 1.5) * 0.5 + 0.5);
        vec3 c = mix(vec3(0.47, 0.45, 0.42), vec3(0.24, 0.23, 0.21), bands * 0.7);
        c *= 1.0 - 0.22 * vermic(vec2(u * 0.02 + id * 0.1, t * 0.3));
        c = mix(c, c * 0.6, smoothstep(0.08, 0.0, abs(u)));
        c *= 1.0 - smoothstep(0.75, 1.0, abs(u)) * 0.15;
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: 'totalEmissiveRadiance += diffuseColor.rgb * uAuroraLight * 0.15;' + rimEmissive(1.6, 0.3),
  });
  mat.userData.spread = spread;
  return mat;
}
