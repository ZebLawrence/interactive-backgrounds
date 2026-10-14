// Boreal Night — The great grey owl (Strix nebulosa): its body, face, wings and feet, and how it
// hunts.
//
// The largest owl of the boreal forest by length (around 70 cm, a 1.4 m wingspan) but mostly
// feathers: a big round head with no ear tufts, nearly as wide as the body, on a heavy bell of a
// body that tapers into a long tail. Its huge facial disc is ringed with fine concentric grey
// lines, centred on each of its small yellow eyes; white "eyebrows" curve between the eyes and a
// white bow tie sits under a black chin. It hunts voles by ear from a low perch at the forest
// edge: it turns its head to the sound, bobs to fix it, glides down, hovers, and plunges into the
// snow with its wings flung up and its legs and talons thrust out ahead, breaking through crust
// that would hold a person, then sits mantling with its wings spread before it flies off. The
// prints it leaves, a pit flanked by long wing marks, are a winter classic.
//
// The wings are skinned on a real bird's skeleton: shoulder, elbow, wrist and the outer hand.
// Folding is the bird's Z-fold (the upper arm swings back, the forearm folds forward along it and
// the hand folds back again), so a folded wing lies along the flank with the primaries crossing
// over the tail, and the same joints flex on every upstroke and lag on every downstroke.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, v3, approach, angleDiff } from './util.js';
import { G, NOISE_GLSL, patchMaterial } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const PLUMAGE_GLSL = `
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
const LOOK_GLSL = `
uniform vec3 uTint; uniform float uContrast, uStreak;
vec3 applyLook(vec3 c) { return max(mix(vec3(0.45), c, uContrast) * uTint, 0.0); }
`;

const AURORA_FILL = 'totalEmissiveRadiance += diffuseColor.rgb * uAuroraLight * 0.15;';

function bodyMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 }), {
    key: 'owl-body',
    uniforms: { uAuroraLight: G.uAuroraLight, ...look },
    vHead: 'varying vec3 vLocal;',
    vMain: 'vLocal = position;',
    fHead: `varying vec3 vLocal; uniform vec3 uAuroraLight;\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: `
      {
        vec3 p = vLocal;
        float ang = atan(p.x, p.z);              // 0 straight ahead, +-PI behind
        float front = cos(ang);
        float fe;
        float r = feathers(vec2(ang * 9.0, p.y * 46.0), fe);
        // Pale ash grey below, a browner grey on the mantle.
        vec3 c = mix(vec3(0.56, 0.55, 0.53), vec3(0.42, 0.4, 0.37), smoothstep(0.3, -0.7, front));
        c = mix(c, vec3(0.6, 0.59, 0.57), smoothstep(0.2, 0.0, p.y) * 0.5);
        c *= 1.0 - 0.2 * vermic(vec2(ang * 0.18 + vnoise(p.xy * 40.0) * 0.02, p.y + vnoise(vec2(ang * 30.0, p.y * 20.0)) * 0.006));
        // Bold, blurred dark streaks down the breast.
        float streak = smoothstep(0.6, 0.82, vnoise(vec2(ang * 16.0, p.y * 5.0 + 3.0))) * smoothstep(0.0, 0.6, front) * smoothstep(0.42, 0.22, p.y) * smoothstep(0.05, 0.15, p.y);
        c = mix(c, vec3(0.16, 0.14, 0.13), clamp(streak * 0.7 * uStreak, 0.0, 1.0));
        // A pale band across the shoulders (the scapulars' white edges).
        c = mix(c, vec3(0.7, 0.69, 0.66), smoothstep(0.7, 0.85, vnoise(vec2(ang * 14.0, p.y * 30.0))) * smoothstep(-0.2, -0.6, front) * smoothstep(0.3, 0.38, p.y) * 0.5);
        // Feather tips catch a little shadow.
        c *= 1.0 - fe * 0.14;
        c *= 0.94 + 0.12 * r;
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: AURORA_FILL,
  });
}

function headMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 }), {
    key: 'owl-head',
    uniforms: { uAuroraLight: G.uAuroraLight, ...look },
    vHead: 'attribute vec3 aDir; varying vec3 vLocal; varying vec3 vDir;',
    vMain: 'vLocal = position; vDir = aDir;',
    fHead: `varying vec3 vLocal; varying vec3 vDir; uniform vec3 uAuroraLight;\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: `
      {
        vec3 d = normalize(vDir);
        vec2 p = vLocal.xy;
        // The crown and nape: grey, finely barred.
        float ang = atan(d.x, d.z);
        float fe;
        float fr = feathers(vec2(ang * 7.0, d.y * 9.0), fe);
        vec3 crown = vec3(0.46, 0.45, 0.43) * (1.0 - 0.3 * vermic(vec2(ang * 0.15, vLocal.y)));
        crown *= 1.0 - fe * 0.12;
        crown *= 0.94 + 0.12 * fr;
        // The facial disc: rings centred on each eye.
        vec2 e = vec2(p.x < 0.0 ? -0.036 : 0.036, 0.014);
        float r = length(p - e);
        float ra = atan(p.y - e.y, p.x - e.x);
        float rings = 0.5 + 0.5 * cos(r / 0.0102 * 6.2831853 + vnoise(vec2(ra * 6.0, r * 40.0)) * 1.2);
        vec3 face = vec3(0.6, 0.59, 0.57);
        face = mix(face, vec3(0.22, 0.21, 0.2), smoothstep(0.7, 0.96, rings) * smoothstep(0.012, 0.022, r) * 0.8);
        face *= 0.9 + 0.1 * vnoise(vec2(ra * 26.0, r * 30.0));
        // White brows from above the beak, curving up between the eyes.
        float bx = abs(p.x);
        float brow = smoothstep(0.006, 0.0015, abs(bx - (0.005 + (p.y + 0.012) * 0.55))) * step(-0.014, p.y) * step(p.y, 0.05);
        face = mix(face, vec3(0.9, 0.89, 0.86), brow);
        // Dark skin round each eye.
        face = mix(face, vec3(0.07, 0.06, 0.06), smoothstep(0.019, 0.015, r));
        // The black chin and the white bow tie either side of it.
        float chin = smoothstep(0.013, 0.007, length((p - vec2(0.0, -0.056)) * vec2(1.0, 1.4)));
        float tie = smoothstep(0.02, 0.013, length((vec2(bx, p.y) - vec2(0.027, -0.066)) * vec2(0.75, 1.7)));
        face = mix(face, vec3(0.93, 0.92, 0.89), tie);
        face = mix(face, vec3(0.04, 0.035, 0.03), chin);
        // The disc's rim: a dark ring, then the crown feathers.
        float disc = smoothstep(0.38, 0.47, d.z);
        float rim = smoothstep(0.36, 0.43, d.z) * (1.0 - smoothstep(0.47, 0.55, d.z));
        vec3 c = mix(crown, face, disc);
        c = mix(c, vec3(0.13, 0.11, 0.1), rim * 0.85);
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: AURORA_FILL,
  });
}

function eyeMaterial(iris) {
  const lid = { value: 0 };
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0 }), {
    key: 'owl-eye',
    uniforms: { uLid: lid, uIris: { value: iris } },
    vHead: 'varying vec3 vLocal;',
    vMain: 'vLocal = normalize(position);',
    fHead: 'varying vec3 vLocal; uniform float uLid; uniform vec3 uIris;',
    fColor: `
      {
        vec3 n = vLocal;
        vec3 c = uIris;
        c *= 0.75 + 0.25 * smoothstep(0.75, 0.95, n.z);
        c = mix(c, vec3(0.004), smoothstep(0.955, 0.965, n.z));
        // The upper lid, feathered grey, comes down over the eye.
        float lidLine = 1.0 - 2.0 * uLid;
        c = mix(c, vec3(0.4, 0.39, 0.37), step(lidLine, n.y));
        diffuseColor.rgb = c;
      }`,
  });
  mat.userData.lid = lid;
  return mat;
}

// Flight feathers: barred dark on grey above, pale and barred below, the primaries' fingers cut out.
const FLIGHT_FEATHERS = `
  {
    float s = vWing.x, v = vWing.y;
    float tip = smoothstep(0.42, 0.6, s);
    float slot = abs(fract((s - 0.42) * 34.0) - 0.5);
    if (tip > 0.0 && v > 1.0 - tip * 0.4 && slot < 0.13 * tip) discard;
    // Rounded, separate feather tips along the trailing edge.
    float scallop = abs(fract(s * 38.0) - 0.5) * 2.0;
    if (v > 0.965 - scallop * scallop * 0.05 && tip < 0.5) discard;
    float bars = smoothstep(0.3, 0.7, sin(v * 24.0 + s * 5.0 + vnoise(vec2(s, v) * 30.0)) * 0.5 + 0.5) * smoothstep(0.4, 0.6, v);
    float shafts = smoothstep(0.42, 0.5, abs(fract(s * 38.0) - 0.5)) * smoothstep(0.45, 0.65, v);
    vec3 up = mix(vec3(0.44, 0.42, 0.39), vec3(0.2, 0.18, 0.17), bars * 0.85);
    // Coverts toward the leading edge: mottled, each feather with a pale tip.
    float fe;
    float fr = feathers(vec2(s * 30.0, v * 9.0), fe);
    vec3 cov = vec3(0.47, 0.45, 0.42) * (1.0 - 0.3 * vermic(vec2(s * 0.3, v * 0.25)));
    cov = mix(cov, vec3(0.66, 0.64, 0.6), (1.0 - fe) * step(0.75, fr) * 0.4);
    up = mix(cov, up, smoothstep(0.35, 0.5, v));
    // The buff patch at the base of the primaries.
    up = mix(up, vec3(0.6, 0.55, 0.46), smoothstep(0.07, 0.0, abs(s - 0.36)) * smoothstep(0.3, 0.45, v) * smoothstep(0.75, 0.55, v) * 0.6);
    vec3 under = mix(vec3(0.68, 0.67, 0.64), vec3(0.34, 0.33, 0.31), bars * 0.7);
    vec3 c = gl_FrontFacing ? up : under;
    c *= 1.0 - shafts * 0.12;
    diffuseColor.rgb = applyLook(c);
  }`;

function wingMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }), {
    key: 'owl-wing',
    uniforms: { uAuroraLight: G.uAuroraLight, ...look },
    vHead: 'attribute vec2 aWing; varying vec2 vWing;',
    vMain: 'vWing = aWing;',
    fHead: `varying vec2 vWing; uniform vec3 uAuroraLight;\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: FLIGHT_FEATHERS,
    fEmissive: AURORA_FILL,
  });
}

function tailMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }), {
    key: 'owl-tail',
    uniforms: { uAuroraLight: G.uAuroraLight, ...look },
    vHead: 'varying vec2 vT;',
    vMain: 'vT = uv;',
    fHead: `varying vec2 vT; uniform vec3 uAuroraLight;\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: `
      {
        // uv: x across the fan (0..1), y from the tip (0) to the root (1).
        float f = vT.x * 12.0;
        float edge = abs(fract(f) - 0.5) * 2.0;
        // Each tail feather's rounded tip.
        if (vT.y < 0.06 * edge * edge) discard;
        float bars = smoothstep(0.35, 0.7, sin(vT.y * 30.0 + vnoise(vT * 20.0)) * 0.5 + 0.5);
        vec3 c = mix(vec3(0.45, 0.43, 0.4), vec3(0.26, 0.25, 0.23), bars * 0.6);
        c *= 1.0 - smoothstep(0.85, 1.0, edge) * 0.25;
        c *= 1.0 - 0.25 * vermic(vT * vec2(0.3, 0.4));
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: AURORA_FILL,
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

// The wing's bones along the span (m from the shoulder): upper arm, forearm, hand, outer hand.
const ELBOW = 0.15, WRIST = 0.31, FLEX = 0.46, SPAN = 0.62;
// A broad, round-tipped owl wing: the chord stays wide almost to the tip, swept a little back.
const WING_SWEEP = (s) => -0.1 - 0.06 * (s / SPAN) ** 2;
const WING_CHORD = (s) => 0.31 * Math.sqrt(Math.max(0.03, 1 - (s / (SPAN + 0.02)) ** 4)) * (1 - 0.15 * Math.exp(-s / 0.03));
const WING_LEAD = (s) => WING_SWEEP(s) + WING_CHORD(s) * 0.42;
const WING_TRAIL = (s) => WING_SWEEP(s) - WING_CHORD(s) * 0.58;

/** The two bones a point `s` along the span follows, and how much: joints blend over +-2.5 cm. */
function skinAt(s) {
  const J = [ELBOW, WRIST, FLEX], h = 0.025;
  for (let j = 0; j < 3; j++) {
    if (s < J[j] + h) {
      const k = smoothstep(J[j] - h, J[j] + h, s);
      return [[j, j + 1], [1 - k, k]];
    }
  }
  return [[3, 0], [1, 0]];
}

/** One wing (sx = 1 right, -1 left) as a skinned, cambered grid on four bones. */
function wingGeometry(sx) {
  const nu = 30, nv = 9;
  const pos = [], wing = [], si = [], sw = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const s = SPAN * (i / nu);
    const l = WING_LEAD(s), t = WING_TRAIL(s);
    const [bi, bw] = skinAt(s);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const z = lerp(l, t, v);
      const chord = l - t;
      // Camber, and a thicker, rounded leading edge near the body.
      const y = Math.sin(Math.PI * Math.min(1, v * 1.4)) * chord * 0.07 * (1 - s / SPAN * 0.5);
      pos.push(sx * s, y, z);
      wing.push(s, v);
      // Toward the trailing edge the feathers follow the fan bones instead, which close the
      // feathers up along the bones as the wing folds.
      const k = smoothstep(0.2, 0.9, v);
      const fan = (b) => (b === 0 ? 4 : b === 2 ? 5 : b === 3 ? 6 : b);
      si.push(bi[0], fan(bi[0]), bi[1], fan(bi[1]));
      sw.push(bw[0] * (1 - k), bw[0] * k, bw[1] * (1 - k), bw[1] * k);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
      // Front faces are the upper (dorsal) side.
      if (sx > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Fluff: a feathered surface is never smooth, least of all its silhouette. */
function fluff(g, amount, scale) {
  const p = g.attributes.position, n = g.attributes.normal;
  const h = (x, y, z) => {
    const s = Math.sin(x * 127.1 * scale + y * 311.7 * scale + z * 74.7 * scale) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = (h(Math.round(x * 60), Math.round(y * 60), Math.round(z * 60)) - 0.5) * amount;
    p.setXYZ(i, x + n.getX(i) * k, y + n.getY(i) * k, z + n.getZ(i) * k);
  }
  g.computeVertexNormals();
}

function bodyGeometry() {
  // A heavy bell from the belly feathers (which hide the feet) up to the shoulders, where the big
  // head sits right down on it.
  const pts = [[0.0, 0.0], [0.05, 0.005], [0.1, 0.035], [0.135, 0.08], [0.155, 0.14], [0.163, 0.2], [0.16, 0.26],
    [0.152, 0.31], [0.138, 0.36], [0.115, 0.4], [0.08, 0.43], [0.0, 0.45]];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 48);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Narrower across than deep (the folded wings make the flanks), the breast full and rounded,
    // the back flatter and leaning back toward the tail.
    const back = z < 0 ? 1 : 0;
    p.setXYZ(i, x * 0.84, y, z * (back ? 0.82 : 1.0) - back * smoothstep(0.25, 0.0, y) * 0.03);
  }
  g.computeVertexNormals();
  fluff(g, 0.006, 1);
  return g;
}

function headGeometry() {
  const g = new THREE.SphereGeometry(0.135, 56, 40);
  const p = g.attributes.position;
  const dir = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const l = Math.hypot(x, y, z);
    const dx = x / l, dy = y / l, dz = z / l;
    dir.set([dx, dy, dz], i * 3);
    // A big round head, a little wider than tall; the front flattened into the facial disc,
    // dished slightly in the middle, its rim of stiff feathers standing proud.
    let nz = z * (z > 0 ? 0.5 : 0.85);
    if (dz > 0.4) {
      const rr = Math.hypot(x, y) / 0.122;
      nz -= 0.008 * Math.max(0, 1 - rr * rr);
    }
    nz += 0.012 * Math.exp(-(((dz - 0.43) / 0.06) ** 2));
    p.setXYZ(i, x, y * 0.9, nz);
  }
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.computeVertexNormals();
  return g;
}

function tailGeometry() {
  // A long, rounded tail of 12 feathers hanging from the rump.
  const g = new THREE.PlaneGeometry(0.13, 0.3, 6, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const v = (y + 0.15) / 0.3;     // 0 tip .. 1 root
    p.setXYZ(i, x * (0.6 + 0.5 * (1 - v)), y - 0.15, -Math.abs(x) * 0.12 - 0.01);
  }
  g.computeVertexNormals();
  return g;
}

/** A toe: a short, feathered digit along +z with a black, hooked talon at its tip. */
function toeGeometries() {
  const toe = new THREE.CylinderGeometry(0.0075, 0.009, 0.036, 8);
  toe.rotateX(Math.PI / 2);
  toe.translate(0, 0, 0.018);
  const talon = new THREE.ConeGeometry(0.005, 0.022, 8);
  // Curve it: bend the cone's tip downward.
  const p = talon.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + 0.011;   // 0 base .. 0.022 tip
    p.setZ(i, p.getZ(i) - (y / 0.022) ** 2 * 0.008);
  }
  talon.rotateX(Math.PI / 2 + 0.45);
  talon.translate(0, -0.002, 0.036);
  talon.computeVertexNormals();
  return { toe, talon };
}

// ---------------------------------------------------------------------------------------------
// The owl
// ---------------------------------------------------------------------------------------------

const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
const qAxis = (axis, a) => new THREE.Quaternion().setFromAxisAngle(axis, a);
const mirror = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const easeInOut = (t) => t * t * (3 - 2 * t);

// The folded wing's shoulder: the upper arm swept back and down along the flank, its upper
// surface facing out (and a little up).
const FOLDED_SHOULDER = (() => {
  const span = v3(0, -Math.sin(1.0), -Math.cos(1.0));
  const dorsal = v3(1, 0.22, 0).sub(span.clone().multiplyScalar(span.dot(v3(1, 0.22, 0)))).normalize();
  const lead = span.clone().cross(dorsal);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(span, dorsal, lead));
})();

export class Owl {
  constructor(kit, traits = makeTraits(Math.random)[0]) {
    this.kit = kit;
    this.traits = traits;
    const T = traits;
    const look = { uTint: { value: T.tint }, uContrast: { value: T.contrast }, uStreak: { value: T.streak } };
    this.mats = { body: bodyMaterial(look), head: headMaterial(look), wing: wingMaterial(look), tail: tailMaterial(look) };
    const M = this.mats;
    this.root = new THREE.Group();
    this.bank = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.bank);
    this.bank.add(this.body);
    this.body.position.y = 0.24;
    const off = new THREE.Group();
    off.position.y = -0.24;
    this.body.add(off);
    this.off = off;
    this.eyeMat = eyeMaterial(T.iris);

    // Proportions: some owls stockier, some taller and slimmer.
    const torso = new THREE.Mesh(kit.bodyGeo, M.body);
    torso.scale.set(T.girth, T.height, T.girth);
    off.add(torso);
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.1, -0.1);
    this.tail.add(new THREE.Mesh(kit.tailGeo, M.tail));
    this.tail.scale.y = T.tail;
    off.add(this.tail);

    // The head sits right down on the shoulders.
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.405 * T.height, 0.03);
    off.add(this.neck);
    this.head = new THREE.Group();
    this.head.position.y = 0.095;
    this.neck.add(this.head);
    this.head.add(new THREE.Mesh(kit.headGeo, M.head));
    this.head.scale.setScalar(T.head);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(kit.eyeGeo, this.eyeMat);
      eye.position.set(sx * 0.036, 0.013, 0.052);
      eye.rotation.y = sx * 0.12;
      this.head.add(eye);
    }
    const beak = new THREE.Mesh(kit.beakGeo, kit.beak);
    beak.position.set(0, -0.012, 0.062);
    beak.rotation.x = Math.PI / 2 + 0.55;
    this.head.add(beak);

    // Wings: skinned on shoulder, elbow, wrist and outer-hand bones.
    this.wings = [];
    for (const sx of [-1, 1]) {
      // Shoulder, elbow, wrist, outer hand; and feather fans on the upper arm (tertials), the
      // hand (inner primaries) and the outer hand (outer primaries).
      const bones = Array.from({ length: 7 }, () => new THREE.Bone());
      bones[1].position.x = sx * ELBOW;
      bones[2].position.x = sx * (WRIST - ELBOW);
      bones[3].position.x = sx * (FLEX - WRIST);
      bones[0].add(bones[1]); bones[1].add(bones[2]); bones[2].add(bones[3]);
      bones[0].add(bones[4]); bones[2].add(bones[5]); bones[3].add(bones[6]);
      const mesh = new THREE.SkinnedMesh(kit.wingGeo[sx > 0 ? 1 : 0], M.wing);
      mesh.add(bones[0]);
      mesh.updateMatrixWorld(true);
      mesh.bind(new THREE.Skeleton(bones));
      mesh.frustumCulled = false;
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * 0.11 * T.girth, 0.37 * T.height, -0.005);
      shoulder.add(mesh);
      off.add(shoulder);
      this.wings.push({ sx, bones, mesh });
    }

    // Legs: feathered to the toes, with two toes forward and two back when gripping, all four
    // spread wide when striking.
    this.legs = [];
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.048, 0.12, 0.05);
      const shank = new THREE.Mesh(kit.legGeo, M.body);
      shank.position.y = -0.09;
      const ankle = new THREE.Group();
      ankle.position.y = -0.18;
      const toes = [];
      // Inner front, outer front, the reversible outer toe, and the hind toe.
      for (const a of [0.3, -0.3, -1.7, Math.PI]) {
        const toe = new THREE.Group();
        toe.rotation.y = sx * a;
        const curl = new THREE.Group();
        curl.add(new THREE.Mesh(kit.toeGeo, M.body), new THREE.Mesh(kit.talonGeo, kit.talon));
        toe.add(curl);
        ankle.add(toe);
        toes.push({ toe, curl, a });
      }
      hip.add(shank, ankle);
      off.add(hip);
      this.legs.push({ sx, hip, shank, ankle, toes });
    }
    // The vole, when the strike succeeds, carried off in the talons.
    this.vole = new THREE.Mesh(kit.voleGeo, kit.vole);
    this.vole.position.set(0, -0.02, 0.03);
    this.vole.visible = false;
    this.legs[1].ankle.add(this.vole);
    this.root.scale.setScalar(T.size);
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // Pose.
    this.yaw = 0;
    this.headYaw = 0; this.headPitch = 0; this.headRoll = 0;
    this.headTarget = { yaw: 0, pitch: 0, roll: 0 };
    this.pitch = 0;          // body pitch: 0 upright, about PI/2 flat out in flight
    this.bankAngle = 0;
    this.fold = 1;           // wings: 0 spread .. 1 folded
    this.flapPhase = 0;
    this.flapAmp = 0;
    this.flapRate = 2.4;
    this.sweep = 0;          // wings swept forward (-) or back (+)
    this.raise = 0;          // wings held up in a V (+) or drooped over the snow (-)
    this.tailSpread = 0;
    this.tailLift = 0;
    this.legAngle = 0;       // the legs' angle from straight down, in the world: + reaching forward
    this.legTuck = 1;        // 1: tucked back along the belly in flight
    this.legReach = 0.55;    // 0 drawn up .. 1 fully extended
    this.grip = 1;           // toes: 0 spread wide .. 1 closed round a perch
    this.sleek = 0;          // -1 fluffed .. 1 sleeked in alarm
    this.lid = 0.45;
    this.blinkT = rnd(2, 6);
    this.blink = 0;
    this.settle = 0;

    // Behaviour.
    this.state = 'perch';
    this.timer = rnd(4, 10);
    this.perch = null;
    this.target = null;
    this.path = null;
    this.alarm = 0;
    this.bob = 0;
    this.idle = null;
    this.carry = false;
    this.cooldown = 0;
  }

  get busy() { return this.state !== 'perch'; }

  headWorld(out = v3()) { return this.head.getWorldPosition(out); }

  // --- Pose -------------------------------------------------------------------------------

  applyPose(dt) {
    this.root.rotation.set(0, this.yaw, 0);
    this.bank.rotation.set(0, 0, this.bankAngle);
    this.body.rotation.set(this.pitch, 0, 0);
    const sl = this.sleek;
    this.body.scale.set(1 - sl * 0.09, 1 + sl * 0.07, 1 - sl * 0.09);
    // The head keeps itself level while the body pitches (owls are superb at this).
    this.neck.rotation.set(-this.pitch * 0.9, 0, 0);
    this.head.rotation.set(-this.headPitch, this.headYaw, this.headRoll, 'YXZ');
    this.head.position.y = 0.095 * this.traits.head + this.bob * 0.025;
    this.head.position.z = this.bob * 0.02;
    this.poseWings();
    // Tail: hangs along the line of the body, fans and drops to brake.
    this.tail.rotation.x = 0.28 - this.tailLift * 0.7;
    this.tail.scale.x = 1 + this.tailSpread * 0.8;
    this.poseLegs();
    this.vole.visible = this.carry && (this.state === 'fly' || this.state === 'land' || this.state === 'takeoff');
    // Blinking.
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blink = 1; this.blinkT = rnd(3, 9); }
    this.blink = Math.max(0, this.blink - dt * 5);
    const shut = Math.sin(this.blink * Math.PI);
    this.eyeMat.userData.lid.value = clamp(Math.max(this.lid, shut), 0, 1);
  }

  poseWings() {
    const ph = this.flapPhase, amp = this.flapAmp;
    // Downstroke with the wing straight; on the upstroke the elbow and wrist flex to draw it in.
    const stroke = Math.sin(ph) * amp;
    const upFlex = Math.max(0, Math.cos(ph)) * amp * 0.38;
    const lag = Math.cos(ph) * amp * 0.45;
    const fold = clamp(Math.max(this.fold, upFlex), 0, 1);
    const f = easeInOut(fold);
    // Keep the spread wing's chord in the airflow whatever the body's pitch.
    const twist = -this.pitch * 0.92 + 0.08;
    const fwd = v3(0, Math.sin(this.pitch), Math.cos(this.pitch));
    const spreadShoulder = qAxis(fwd, stroke * 0.95 + this.raise * 1.15 + 0.06)
      .multiply(qAxis(X, twist))
      .multiply(qAxis(Y, this.sweep));
    const shoulder = spreadShoulder.clone().slerp(FOLDED_SHOULDER, f);
    // Elbow and wrist fold in the plane of the wing: the forearm forward along the upper arm, the
    // hand back along the forearm.
    const elbow = qAxis(Y, -0.1).multiply(qAxis(Z, -lag * 0.3)).slerp(qAxis(Y, -2.75), f);
    const wrist = qAxis(Y, 0.16 - this.sweep * 0.4).multiply(qAxis(Z, -lag * 0.6 + this.raise * 0.25)).slerp(qAxis(Y, 2.85), f);
    // The outer primaries bend up under load on the downstroke and trail on the upstroke.
    const flex = qAxis(Z, -lag * 0.7 + stroke * 0.25).slerp(qAxis(Y, 0.15), f);
    // Folding, the feathers slide in under one another and the fans close up toward the bones.
    const fans = [[0.3, -0.25], [0.32, -0.2], [0.42, -0.15]];
    for (const w of this.wings) {
      const qs = [shoulder, elbow, wrist, flex];
      qs.forEach((q, i) => w.bones[i].quaternion.copy(w.sx > 0 ? q : mirror(q)));
      fans.forEach(([sz, rot], i) => {
        const b = w.bones[4 + i];
        b.scale.set(1, 1, lerp(1, sz, f));
        const q = qAxis(Y, rot * f);
        b.quaternion.copy(w.sx > 0 ? q : mirror(q));
      });
    }
  }

  poseLegs() {
    // Hip angle in the body frame for the wanted world angle; tucked, they lie back along the body.
    const down = -this.legAngle - this.pitch;
    const hipX = lerp(down, 0.15, this.legTuck);
    const reach = this.legReach;
    for (const L of this.legs) {
      L.hip.rotation.set(hipX, 0, L.sx * (0.06 + 0.12 * (1 - this.grip)));
      L.shank.scale.y = 0.4 + 0.8 * reach;
      L.shank.position.y = -0.09 * L.shank.scale.y;
      L.ankle.position.y = -0.18 * L.shank.scale.y;
      // Keep the foot level with the ground when perched; flex it toward the target otherwise.
      L.ankle.rotation.x = -hipX * (1 - this.legTuck) * 0.8 - this.pitch * (1 - this.legTuck) * 0.2;
      for (const t of L.toes) {
        // Spread: the toes fan out wide, the talons open; grip: they curl round the perch.
        const spreadA = t.a + Math.sign(t.a || 1) * (1 - this.grip) * 0.35;
        t.toe.rotation.y = L.sx * spreadA;
        t.curl.rotation.x = lerp(-0.35, 0.9, this.grip) + this.legTuck * 0.6;
      }
    }
  }

  /** Turn the head toward a world point, owl fashion: quick turns, then stillness. */
  aimHead(world, dt, tilt = 0) {
    const local = this.root.worldToLocal(world.clone());
    const d = local.sub(v3(0, 0.55, 0));
    const yaw = Math.atan2(d.x, d.z);
    const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const t = this.headTarget;
    if (Math.abs(angleDiff(t.yaw, yaw)) > 0.12 || Math.abs(pitch - t.pitch) > 0.1) { t.yaw = yaw; t.pitch = pitch; }
    t.roll = tilt;
    // An owl can turn its head 270 degrees; beyond about 120 either way it turns its body too.
    const lim = 2.1;
    if (Math.abs(t.yaw) > lim && this.state === 'perch' && this.settle <= 0) this.yaw += Math.sign(t.yaw) * Math.min(Math.abs(t.yaw) - lim + 0.4, 1.6 * dt);
    this.headYaw = approach(this.headYaw, clamp(t.yaw, -2.35, 2.35), 0.09, dt);
    this.headPitch = approach(this.headPitch, clamp(t.pitch, -1.1, 0.8), 0.09, dt);
    this.headRoll = approach(this.headRoll, t.roll, 0.25, dt);
  }

  // --- Paths ------------------------------------------------------------------------------

  makePath(pts, speed, kind) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const len = curve.getLength();
    return { curve, len, s: 0, speed, kind };
  }

  /** Leave the perch (or the snow) and follow `path`; a crouch and spring first from a perch. */
  launch(path, heavy = false) {
    this.path = path;
    this.state = 'takeoff';
    this.timer = heavy ? 0.35 : 0.55;
    this.takeoffDur = this.timer;
    this.heavy = heavy;
  }

  /** Fly to another perch, ending in a landing. */
  goTo(perch, scene, heavy = false) {
    if (this.perch && this.perch.owl === this) this.perch.owl = null;
    perch.owl = this;
    this.perch = perch;
    const from = this.root.position.clone();
    const to = scene.perchPoint(perch);
    const flat = to.clone().sub(from).setY(0);
    const dist = Math.max(flat.length(), 0.5);
    const dir = flat.divideScalar(dist);
    // The landing starts a little short of the perch and below it, so the owl swoops up onto it.
    const approachPt = to.clone().addScaledVector(dir, -1.3).add(v3(0, -0.55, 0));
    const mid = from.clone().lerp(approachPt, 0.5);
    mid.y = Math.min(from.y, approachPt.y) - Math.min(1.8, dist * 0.12);
    mid.y = Math.max(mid.y, scene.heightAt(mid.x, mid.z) + 0.9);
    const drop = from.clone().addScaledVector(dir, Math.min(0.9, dist * 0.2)).add(v3(0, heavy ? 0.3 : -0.5, 0));
    const pts = dist > 3 ? [from, drop, mid, approachPt] : [from, drop, approachPt];
    this.landFrom = approachPt;
    this.landTo = to;
    this.launch(this.makePath(pts, 4.2, 'perch'), heavy);
  }

  // --- Behaviour --------------------------------------------------------------------------

  hunt(p) {
    this.target = p.clone();
    this.state = 'listen';
    this.timer = rnd(1.4, 2.6);
    this.lid = 0;
  }

  update(dt, scene, look) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.alarm = Math.max(0, this.alarm - dt * 0.4);
    switch (this.state) {
      case 'perch': this.updatePerch(dt, scene, look); break;
      case 'listen': this.updateListen(dt, scene); break;
      case 'takeoff': this.updateTakeoff(dt, scene); break;
      case 'fly': this.updateFly(dt, scene); break;
      case 'land': this.updateLand(dt, scene); break;
      case 'hover': this.updateHover(dt, scene); break;
      case 'plunge': this.updatePlunge(dt, scene); break;
      case 'insnow': this.updateInSnow(dt, scene); break;
    }
    this.applyPose(dt);
  }

  /** The common perched pose: upright, wings folded, feet gripping. */
  perchedPose(dt) {
    this.bankAngle = approach(this.bankAngle, 0, 0.3, dt);
    this.legAngle = 0;
    this.legTuck = approach(this.legTuck, 0, 0.15, dt);
    this.legReach = approach(this.legReach, 0.4, 0.25, dt);
    this.grip = approach(this.grip, 1, 0.1, dt);
    this.tailSpread = approach(this.tailSpread, 0, 0.4, dt);
    this.tailLift = approach(this.tailLift, 0, 0.4, dt);
    this.sweep = approach(this.sweep, 0, 0.3, dt);
  }

  updatePerch(dt, scene, look) {
    const p = scene.perchPoint(this.perch);
    this.root.position.copy(p);
    this.perchedPose(dt);
    // Just landed: the wings stay half raised a moment, then fold away in stages; the body
    // rocks forward and back as it finds its balance.
    if (this.settle > 0) {
      this.settle = Math.max(0, this.settle - dt);
      const k = 1 - this.settle / 1.8;
      const wob = Math.sin(k * 9) * Math.exp(-k * 3.5) * 0.18;
      this.pitch = 0.06 + wob;
      this.fold = approach(this.fold, k < 0.12 ? 0.25 : 1, k < 0.12 ? 0.15 : 0.22, dt);
      this.raise = approach(this.raise, 0, 0.15, dt);
      this.flapAmp = approach(this.flapAmp, 0, 0.15, dt);
      this.flapPhase += dt * TAU * 1.2;
      this.tailLift = approach(this.tailLift, Math.max(0, wob * 2), 0.1, dt);
    } else {
      this.pitch = approach(this.pitch, 0.06 + this.traits.lean + this.alarm * 0.04, 0.4, dt);
      this.fold = approach(this.fold, 1, 0.25, dt);
      this.raise = approach(this.raise, 0, 0.3, dt);
      this.flapAmp = approach(this.flapAmp, 0, 0.2, dt);
    }
    this.bob = approach(this.bob, 0, 0.2, dt);
    this.sleek = approach(this.sleek, this.alarm > 0.3 ? 1 : this.traits.fluff, 0.6, dt);
    this.lid = approach(this.lid, look.attention > 0.5 || this.alarm > 0.2 ? 0 : 0.5, 1.2, dt);
    if (look.point) {
      this.aimHead(look.point, dt, (look.stare ? 0.25 * Math.sin(G.uTime.value * 0.4) : 0) + this.traits.tilt);
      this.idle = null;
    } else {
      if (!this.idle || this.idle.t <= 0) {
        const r = Math.random();
        const a = this.yaw + rnd(-1.6, 1.6);
        this.idle = r < 0.12
          ? { kind: 'preen', t: rnd(2.5, 4.5), side: Math.random() < 0.5 ? -1 : 1 }
          : r < 0.18 ? { kind: 'ruffle', t: 1.2 }
          : r < 0.24 ? { kind: 'stretch', t: 2.2, side: Math.random() < 0.5 ? -1 : 1 }
          : { kind: 'scan', t: rnd(1.5, 5), point: p.clone().add(v3(Math.sin(a) * 10, rnd(-4, -1), Math.cos(a) * 10)) };
      }
      this.idle.t -= dt;
      const kind = this.idle.kind;
      if (kind === 'scan') this.aimHead(this.idle.point, dt, this.traits.tilt);
      else if (kind === 'preen') {
        const s = this.idle.side;
        this.headYaw = approach(this.headYaw, s * 1.5, 0.25, dt);
        this.headPitch = approach(this.headPitch, -0.85 + 0.08 * Math.sin(G.uTime.value * 7), 0.15, dt);
        this.headRoll = approach(this.headRoll, s * 0.3, 0.3, dt);
        this.fold = 0.92;
      } else if (kind === 'stretch') {
        // A slow stretch: one wing eased half open and down, then folded again.
        const k = 1 - this.idle.t / 2.2;
        const open = Math.sin(clamp(k, 0, 1) * Math.PI);
        this.fold = 1 - open * 0.6;
        this.raise = -open * 0.3;
      } else {
        const k = 1 - this.idle.t / 1.2;
        this.sleek = -1.2 * Math.sin(k * Math.PI);
        this.bankAngle = Math.sin(k * 40) * 0.04 * Math.sin(k * Math.PI);
      }
    }
    this.timer -= dt;
    if (this.timer <= 0 && this.settle <= 0) {
      this.timer = rnd(60, 150);
      if (Math.random() < 0.75) scene.selfHunt(this);
      else scene.relocate(this);
    }
  }

  updateListen(dt, scene) {
    const p = scene.perchPoint(this.perch);
    this.root.position.copy(p);
    this.perchedPose(dt);
    this.fold = approach(this.fold, 1, 0.2, dt);
    this.raise = approach(this.raise, 0, 0.2, dt);
    this.timer -= dt;
    const t = G.uTime.value;
    // Head bobbing and tilting to fix the sound: owls triangulate by moving their head.
    this.bob = Math.sin(t * 5.2) * 0.6 * smoothstep(0, 0.4, this.timer);
    this.aimHead(this.target, dt, Math.sin(t * 2.1) * 0.35);
    this.pitch = approach(this.pitch, 0.35, 0.5, dt);
    this.lid = approach(this.lid, 0, 0.2, dt);
    this.sleek = approach(this.sleek, 0.5, 0.5, dt);
    const want = Math.atan2(this.target.x - p.x, this.target.z - p.z);
    this.yaw += clamp(angleDiff(this.yaw, want), -1.2 * dt, 1.2 * dt);
    if (this.timer <= 0) {
      if (this.perch) this.perch.owl = null;
      const from = p.clone();
      const hover = this.target.clone();
      hover.y = scene.heightAt(hover.x, hover.z) + 1.7;
      const dir = hover.clone().sub(from).setY(0);
      const dist = dir.length();
      dir.normalize();
      const low = from.clone().addScaledVector(dir, dist * 0.45);
      low.y = Math.max(scene.heightAt(low.x, low.z) + 1.0, Math.min(from.y, hover.y) - 1.2);
      const drop = from.clone().addScaledVector(dir, 0.7).add(v3(0, -0.5, 0));
      const before = hover.clone().addScaledVector(dir, -1.2).add(v3(0, -0.3, 0));
      this.launch(this.makePath([from, drop, low, before, hover], 4.4, 'hunt'));
    }
  }

  updateTakeoff(dt, scene) {
    // Crouch, lean out, open the wings and push off with the first deep downstroke.
    this.timer -= dt;
    const k = 1 - this.timer / this.takeoffDur;
    const P = this.path;
    const tan = P.curve.getTangentAt(0.02);
    const want = Math.atan2(tan.x, tan.z);
    this.yaw += clamp(angleDiff(this.yaw, want), -4 * dt, 4 * dt);
    this.pitch = approach(this.pitch, this.heavy ? 0.7 : lerp(0.35, 0.8, k), 0.12, dt);
    this.fold = approach(this.fold, 0, 0.1, dt);
    this.raise = approach(this.raise, this.heavy ? 0.2 : 0.45 * (1 - k), 0.1, dt);
    this.sweep = approach(this.sweep, 0, 0.2, dt);
    this.legReach = approach(this.legReach, k < 0.5 ? 0.3 : 1, 0.06, dt);
    this.grip = approach(this.grip, k > 0.7 ? 0.4 : 1, 0.1, dt);
    this.flapAmp = approach(this.flapAmp, k > 0.4 ? 1 : 0, 0.12, dt);
    this.flapRate = 2.3;
    if (k > 0.4) this.flapPhase += dt * TAU * this.flapRate / this.traits.size;
    this.lid = 0;
    if (this.timer <= 0) { this.state = 'fly'; this.flapAmp = Math.max(this.flapAmp, 0.8); }
  }

  updateFly(dt, scene) {
    const P = this.path;
    const u = P.s / P.len;
    const speed = P.speed * (0.45 + 0.55 * smoothstep(0, 0.15, u)) * (1 - 0.35 * smoothstep(0.85, 1, u));
    P.s = Math.min(P.len, P.s + speed * dt);
    const k = P.s / P.len;
    const pos = P.curve.getPointAt(k);
    const tan = P.curve.getTangentAt(Math.min(k, 0.999));
    this.root.position.copy(pos);
    const heading = Math.atan2(tan.x, tan.z);
    const turn = angleDiff(this.yaw, heading);
    this.yaw += clamp(turn, -3 * dt, 3 * dt);
    this.bankAngle = approach(this.bankAngle, clamp(-turn * 2.2, -0.6, 0.6), 0.3, dt);
    const climb = Math.asin(clamp(tan.y, -1, 1));
    this.pitch = approach(this.pitch, 1.3 - climb * 0.5, 0.18, dt);
    this.fold = approach(this.fold, 0, 0.12, dt);
    this.raise = approach(this.raise, 0, 0.3, dt);
    this.sweep = approach(this.sweep, 0.05, 0.3, dt);
    // Slow, deep beats on take-off and climbing, long glides in between.
    const beat = k < 0.25 || tan.y > 0.12 || (k > 0.8 && P.kind === 'hunt') || this.carry;
    this.flapAmp = approach(this.flapAmp, beat ? 0.85 : 0.06, 0.4, dt);
    this.flapRate = 2.2;
    this.flapPhase += dt * TAU * this.flapRate / this.traits.size;
    this.tailSpread = approach(this.tailSpread, 0.1, 0.3, dt);
    this.tailLift = approach(this.tailLift, 0, 0.3, dt);
    // Legs tucked back under the tail, or dangling with the vole.
    this.legTuck = approach(this.legTuck, this.carry ? 0.3 : 1, 0.25, dt);
    this.legAngle = -0.3;
    this.legReach = approach(this.legReach, this.carry ? 0.9 : 0.6, 0.3, dt);
    this.grip = approach(this.grip, 1, 0.2, dt);
    this.sleek = approach(this.sleek, 0.3, 0.5, dt);
    this.lid = 0;
    this.aimHead(P.kind === 'hunt' ? this.target : pos.clone().addScaledVector(tan, 6), dt);
    if (P.s >= P.len - 1e-3) {
      if (P.kind === 'hunt') { this.state = 'hover'; this.timer = rnd(0.9, 1.7); }
      else { this.state = 'land'; this.timer = 0; this.landPitch = this.pitch; }
    }
  }

  updateLand(dt, scene) {
    // The swoop up onto the perch: the body rears upright, the wings spread wide and forward and
    // beat slowly to brake, the tail fans and drops, the legs reach out with the toes open, and
    // they close on the perch as it touches.
    const D = 1.15;
    this.timer += dt;
    const k = clamp(this.timer / D, 0, 1);
    const to = this.perch ? scene.perchPoint(this.perch) : this.landTo;
    const e = 1 - (1 - k) ** 2.4;     // decelerating
    const p = this.landFrom.clone().lerp(to, e);
    p.y += Math.sin(k * Math.PI) * 0.25 * (1 - k);
    this.root.position.copy(p);
    const want = Math.atan2(to.x - this.landFrom.x, to.z - this.landFrom.z);
    this.yaw += clamp(angleDiff(this.yaw, want), -2 * dt, 2 * dt);
    this.bankAngle = approach(this.bankAngle, 0, 0.15, dt);
    this.pitch = approach(this.pitch, k < 0.75 ? -0.2 : 0.05, k < 0.75 ? 0.18 : 0.12, dt);
    this.fold = approach(this.fold, 0, 0.08, dt);
    this.sweep = approach(this.sweep, -0.45, 0.15, dt);
    this.raise = approach(this.raise, 0.25, 0.2, dt);
    this.flapAmp = approach(this.flapAmp, k < 0.85 ? 0.75 : 0.2, 0.15, dt);
    this.flapRate = 1.9;
    this.flapPhase += dt * TAU * this.flapRate / this.traits.size;
    this.tailSpread = approach(this.tailSpread, 1, 0.12, dt);
    this.tailLift = approach(this.tailLift, 0.7, 0.15, dt);
    this.legTuck = approach(this.legTuck, 0, 0.08, dt);
    this.legAngle = k < 0.85 ? 0.75 : 0.1;
    this.legReach = approach(this.legReach, 1, 0.1, dt);
    this.grip = approach(this.grip, k < 0.88 ? 0 : 1, k < 0.88 ? 0.1 : 0.05, dt);
    this.aimHead(to.clone().add(v3(Math.sin(this.yaw) * 3, -0.5, Math.cos(this.yaw) * 3)), dt);
    if (k >= 1) {
      this.state = 'perch';
      this.settle = 1.8;
      this.timer = rnd(40, 110);
      this.carry = false;
      this.root.position.copy(to);
    }
  }

  updateHover(dt, scene) {
    this.timer -= dt;
    const want = this.target.clone();
    want.y = scene.heightAt(want.x, want.z) + 1.6;
    this.root.position.lerp(want, 1 - Math.exp(-dt * 3));
    this.pitch = approach(this.pitch, 0.5, 0.2, dt);
    this.bankAngle = approach(this.bankAngle, 0, 0.2, dt);
    this.fold = approach(this.fold, 0, 0.1, dt);
    this.sweep = approach(this.sweep, -0.15, 0.2, dt);
    this.flapAmp = approach(this.flapAmp, 0.8, 0.15, dt);
    this.flapRate = 3.0;
    this.flapPhase += dt * TAU * this.flapRate / this.traits.size;
    this.tailSpread = approach(this.tailSpread, 1, 0.2, dt);
    this.tailLift = approach(this.tailLift, 0.6, 0.2, dt);
    // The feet come down and open, ready.
    this.legTuck = approach(this.legTuck, 0, 0.2, dt);
    this.legAngle = 0.15;
    this.legReach = approach(this.legReach, 0.9, 0.2, dt);
    this.grip = approach(this.grip, 0.3, 0.2, dt);
    this.aimHead(this.target, dt);
    if (this.timer <= 0) { this.state = 'plunge'; this.vy = 0; }
  }

  updatePlunge(dt, scene) {
    // Wings flung up in a V, face down onto the sound; at the last moment the legs swing forward,
    // fully extended, the toes spread wide and the talons open.
    this.vy = (this.vy ?? 0) - 9.8 * 0.7 * dt;
    this.root.position.y += this.vy * dt;
    this.root.position.x += (this.target.x - this.root.position.x) * Math.min(1, dt * 4);
    this.root.position.z += (this.target.z - this.root.position.z) * Math.min(1, dt * 4);
    const gy = scene.heightAt(this.root.position.x, this.root.position.z);
    const late = smoothstep(0.9, 0.35, this.root.position.y - gy);
    this.pitch = approach(this.pitch, lerp(0.95, 0.35, late), 0.1, dt);
    this.flapAmp = approach(this.flapAmp, 0, 0.08, dt);
    this.fold = approach(this.fold, 0.12, 0.1, dt);
    this.raise = approach(this.raise, 1, 0.1, dt);
    this.sweep = approach(this.sweep, 0.1, 0.1, dt);
    this.tailSpread = approach(this.tailSpread, 0.8, 0.15, dt);
    this.legTuck = approach(this.legTuck, 0, 0.06, dt);
    this.legAngle = lerp(0.1, 0.55, late);
    this.legReach = approach(this.legReach, 1, 0.06, dt);
    this.grip = approach(this.grip, 0, 0.06, dt);
    this.aimHead(this.target, dt);
    if (this.root.position.y <= gy - 0.08) {
      this.root.position.y = gy - 0.12;
      this.state = 'insnow';
      this.timer = rnd(1.8, 3.2);
      scene.strike(this, this.root.position.x, this.root.position.z, this.yaw);
      this.carry = Math.random() < 0.55;
    }
  }

  updateInSnow(dt, scene) {
    // Mantling: half buried, wings spread and drooped over the snow, head down.
    this.timer -= dt;
    const gy = scene.heightAt(this.root.position.x, this.root.position.z);
    this.root.position.y = approach(this.root.position.y, gy - 0.3, 0.3, dt);
    this.pitch = approach(this.pitch, 0.6, 0.2, dt);
    this.fold = approach(this.fold, 0.05, 0.15, dt);
    this.flapAmp = approach(this.flapAmp, 0, 0.1, dt);
    this.raise = approach(this.raise, -0.55, 0.2, dt);
    this.sweep = approach(this.sweep, 0.2, 0.3, dt);
    this.grip = approach(this.grip, 1, 0.1, dt);
    this.headPitch = approach(this.headPitch, -0.9, 0.2, dt);
    this.headYaw = approach(this.headYaw, Math.sin(G.uTime.value * 1.3) * 0.4, 0.4, dt);
    this.headTarget.pitch = -0.9;
    if (this.timer <= 0) {
      this.state = 'perch';
      this.root.position.y = gy + 0.05;
      this.goTo(scene.choosePerch(this), scene, true);
      this.path.speed = 3.6;
      scene.burstAt(this.root.position.x, gy, this.root.position.z, 0.5);
    }
  }

  dispose() {
    this.eyeMat.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Individuals. Great greys vary a lot: females are noticeably bigger than males (by a tenth or
// more in length, far more in weight), and plumage runs from a cool, pale ash grey through
// silvery birds with crisp markings to darker, browner ones; eyes from lemon to deep yellow.
// ---------------------------------------------------------------------------------------------

const PLUMAGES = [
  { name: 'ash', tint: [1.15, 1.15, 1.2], contrast: 1.0, streak: 1.0 },
  { name: 'dusky', tint: [0.72, 0.68, 0.64], contrast: 1.2, streak: 1.5 },
  { name: 'silver', tint: [1.35, 1.36, 1.42], contrast: 1.35, streak: 0.7 },
  { name: 'brown', tint: [1.12, 0.9, 0.68], contrast: 1.1, streak: 1.25 },
  { name: 'pale', tint: [1.55, 1.5, 1.42], contrast: 0.72, streak: 0.5 },
];
const IRISES = [[0.98, 0.76, 0.1], [1.0, 0.86, 0.22], [0.95, 0.6, 0.06], [0.98, 0.92, 0.35]];

/** `n` owls that differ from one another: sizes spread out, no two plumages alike. */
export function makeTraits(rng, n = 1) {
  const R = (lo, hi) => lo + rng() * (hi - lo);
  const shuffle = (a) => {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  };
  const plumage = shuffle(PLUMAGES), irises = shuffle(IRISES);
  // A big female, a small male, and one in between.
  const sizes = shuffle([R(1.1, 1.17), R(0.84, 0.9), R(0.95, 1.03)]);
  return Array.from({ length: n }, (_, i) => {
    const p = plumage[i % plumage.length];
    const v = R(0.95, 1.05);
    return {
      size: sizes[i % 3] * R(0.98, 1.02),
      girth: R(0.86, 1.16),
      height: R(0.9, 1.12),
      head: R(0.88, 1.12),
      tail: R(0.85, 1.15),
      // At rest some sit fluffed out round, others sleek and upright.
      fluff: R(-0.8, 0.3),
      // And a habit of carriage: a slight lean, a head held a little tilted.
      lean: R(-0.04, 0.1),
      tilt: R(-0.12, 0.12),
      tint: v3(p.tint[0] * v, p.tint[1] * v, p.tint[2] * v),
      contrast: p.contrast * R(0.92, 1.08),
      streak: p.streak * R(0.85, 1.15),
      iris: v3(...irises[i % irises.length]),
      plumage: p.name,
    };
  });
}

/** Geometry and materials shared by every owl. */
export function makeOwlKit() {
  const toes = toeGeometries();
  // Thigh and tarsus together, feathered right down to the toes.
  const leg = new THREE.CylinderGeometry(0.032, 0.019, 0.18, 12);
  fluff(leg, 0.004, 2);
  const kit = {
    bodyGeo: bodyGeometry(),
    headGeo: headGeometry(),
    tailGeo: tailGeometry(),
    wingGeo: [wingGeometry(-1), wingGeometry(1)],
    eyeGeo: new THREE.SphereGeometry(0.0125, 20, 14),
    beakGeo: new THREE.ConeGeometry(0.008, 0.026, 10),
    legGeo: leg,
    toeGeo: toes.toe,
    talonGeo: toes.talon,
    voleGeo: new THREE.SphereGeometry(0.03, 12, 8).scale(0.8, 0.75, 1.6),
    beak: new THREE.MeshStandardMaterial({ color: 0xd2c27e, roughness: 0.35 }),
    talon: new THREE.MeshStandardMaterial({ color: 0x0c0a09, roughness: 0.3 }),
    vole: new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.9 }),
  };
  kit.dispose = () => {
    for (const v of Object.values(kit)) {
      if (Array.isArray(v)) v.forEach((g) => g.dispose());
      else if (v && v.dispose && v !== kit.dispose) v.dispose();
    }
  };
  return kit;
}
