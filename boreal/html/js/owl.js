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
import {
  PLUMAGE_GLSL, LOOK_GLSL, BODY_GLSL, RIM_HEAD, RIM_UNIFORMS, rimEmissive, bodyGeometry, headShape,
  bodyCardsGeometry, headCardsGeometry, cardMaterial, tailFeathersGeometry, tailMaterial,
} from './plumage.js';

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const AURORA_FILL = 'totalEmissiveRadiance += diffuseColor.rgb * uAuroraLight * 0.15;';

function bodyMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 }), {
    key: 'owl-body',
    uniforms: { uAuroraLight: G.uAuroraLight, ...RIM_UNIFORMS, ...look },
    vHead: 'varying vec3 vLocal;',
    vMain: 'vLocal = position;',
    fHead: `varying vec3 vLocal; uniform vec3 uAuroraLight;\n${RIM_HEAD}\n${PLUMAGE_GLSL}${LOOK_GLSL}${BODY_GLSL}`,
    fColor: `
      {
        vec3 p = vLocal;
        float ang = atan(p.x, p.z);              // 0 straight ahead, +-PI behind
        float fe;
        float r = feathers(vec2(ang * 9.0, p.y * 46.0), fe);
        // Under the contour feathers: the same colours, a little darker (shadowed down).
        vec3 c = bodyBase(p) * 0.85;
        c *= 1.0 - fe * 0.14;
        c *= 0.94 + 0.12 * r;
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: AURORA_FILL + rimEmissive(1.0, 0.04),
  });
}

function headMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 }), {
    key: 'owl-head',
    uniforms: { uAuroraLight: G.uAuroraLight, ...RIM_UNIFORMS, ...look },
    vHead: 'attribute vec3 aDir; varying vec3 vLocal; varying vec3 vDir;',
    vMain: 'vLocal = position; vDir = aDir;',
    fHead: `varying vec3 vLocal; varying vec3 vDir; uniform vec3 uAuroraLight;\n${RIM_HEAD}\n${PLUMAGE_GLSL}${LOOK_GLSL}${BODY_GLSL}`,
    fColor: `
      {
        vec3 d = normalize(vDir);
        vec2 p = vLocal.xy;
        // The crown and nape: grey, finely barred.
        float ang = atan(d.x, d.z);
        float fe;
        float fr = feathers(vec2(ang * 7.0, d.y * 9.0), fe);
        vec3 crown = crownBase(d, vLocal.y) * 0.85;
        crown *= 1.0 - fe * 0.12;
        crown *= 0.94 + 0.12 * fr;
        // The facial disc: rings centred on each eye.
        vec2 e = vec2(p.x < 0.0 ? -0.036 : 0.036, 0.014);
        float r = length(p - e);
        float ra = atan(p.y - e.y, p.x - e.x);
        // The rings are made of feathers, so they waver and break; fine streaks radiate from the eye.
        float rings = 0.5 + 0.5 * cos(r / 0.0102 * 6.2831853 + vnoise(vec2(ra * 6.0, r * 40.0)) * 2.2 + vnoise(vec2(ra * 30.0, r * 90.0)) * 0.8);
        vec3 face = vec3(0.64, 0.63, 0.6);
        face = mix(face, vec3(0.3, 0.29, 0.27), smoothstep(0.62, 0.95, rings) * smoothstep(0.012, 0.024, r) * 0.42);
        float rays = vnoise(vec2(ra * 70.0, r * 18.0));
        face *= 0.82 + 0.26 * rays;
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
        // The white bow tie breaks the rim under the chin.
        float tieRim = smoothstep(0.05, 0.02, abs(p.x)) * step(p.y, -0.06);
        c = mix(c, vec3(0.13, 0.11, 0.1), rim * 0.85 * (1.0 - tieRim));
        c = mix(c, vec3(0.86, 0.85, 0.82), tieRim * smoothstep(0.36, 0.45, d.z) * (1.0 - smoothstep(0.5, 0.6, d.z)) * 0.8);
        diffuseColor.rgb = applyLook(c);
      }`,
    fEmissive: AURORA_FILL + rimEmissive(1.2, 0.1),
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
    float kind = vFeather.z;
    if (kind > 0.5) {
      // A flight feather: a long vane with a rounded tip; the outer primaries narrow toward the
      // tip (emarginated), which is what makes the "fingers" of an owl's wingtip.
      float u = vFeather.x, t = vFeather.y;
      float hw = t < 0.82 ? 1.0 : sqrt(max(0.0, 1.0 - pow((t - 0.82) / 0.18, 2.0)));
      hw *= mix(1.0, 0.6, step(1.5, kind) * step(4.5, vFeather.w) * smoothstep(0.5, 0.62, t));
      hw *= smoothstep(0.0, 0.06, t) * 0.4 + 0.6;
      float fw = fwidth(u) * 1.5 + 0.02;
      float a = 1.0 - smoothstep(hw - fw, hw + fw, abs(u));
      if (a < 0.1) discard;
      diffuseColor.a = a;
    }
    float bars = smoothstep(0.3, 0.7, sin(v * 24.0 + s * 5.0 + vnoise(vec2(s, v) * 30.0)) * 0.5 + 0.5) * smoothstep(0.4, 0.6, v);
    vec3 up = mix(vec3(0.44, 0.42, 0.39), vec3(0.2, 0.18, 0.17), bars * 0.85);
    // Coverts toward the leading edge: mottled, each feather with a pale tip.
    float fe;
    float fr = feathers(vec2(s * 30.0, v * 9.0), fe);
    vec3 cov = vec3(0.47, 0.45, 0.42) * (1.0 - 0.3 * vermic(vec2(s * 0.3, v * 0.25)));
    cov = mix(cov, vec3(0.66, 0.64, 0.6), (1.0 - fe) * step(0.75, fr) * 0.4);
    up = mix(cov, up, kind > 0.5 ? 1.0 : smoothstep(0.35, 0.5, v));
    // The buff patch at the base of the primaries.
    up = mix(up, vec3(0.6, 0.55, 0.46), smoothstep(0.07, 0.0, abs(s - 0.36)) * smoothstep(0.3, 0.45, v) * smoothstep(0.75, 0.55, v) * 0.6);
    vec3 under = mix(vec3(0.68, 0.67, 0.64), vec3(0.34, 0.33, 0.31), bars * 0.7);
    vec3 c = gl_FrontFacing ? up : under;
    if (kind > 0.5) {
      // Its shaft, and a darker outer vane edge so neighbouring feathers read apart.
      c = mix(c, c * 0.6, smoothstep(0.08, 0.0, abs(vFeather.x)) * smoothstep(0.1, 0.3, vFeather.y));
      c *= 1.0 - smoothstep(0.7, 1.0, abs(vFeather.x)) * 0.2;
      c *= 0.94 + 0.12 * fract(vFeather.w * 0.618);
    }
    diffuseColor.rgb = applyLook(c);
  }`;

function wingMaterial(look) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true }), {
    key: 'owl-wing',
    uniforms: { uAuroraLight: G.uAuroraLight, ...RIM_UNIFORMS, ...look },
    vHead: 'attribute vec2 aWing; attribute vec4 aFeather; varying vec2 vWing; varying vec4 vFeather;',
    vMain: 'vWing = aWing; vFeather = aFeather;',
    fHead: `varying vec2 vWing; varying vec4 vFeather; uniform vec3 uAuroraLight;\n${RIM_HEAD}\n${PLUMAGE_GLSL}${LOOK_GLSL}`,
    fColor: FLIGHT_FEATHERS,
    fEmissive: AURORA_FILL + rimEmissive(1.0, 0.1),
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

// Each bone's feather fan: upper arm, forearm (the secondaries), hand and outer hand.
const FAN = (b) => [4, 7, 5, 6][b];
const camber = (s, v) => Math.sin(Math.PI * Math.min(1, v * 1.4)) * (WING_LEAD(s) - WING_TRAIL(s)) * 0.07 * (1 - s / SPAN * 0.5);

/**
 * One wing (sx = 1 right, -1 left), skinned on the shoulder, elbow, wrist and outer-hand bones:
 * a cambered sheet of coverts over the front of the wing, and the flight feathers as separate
 * vanes, 14 secondaries along the forearm and 10 primaries fanning from the hand round the
 * rounded tip. Each feather's base follows the bone it grows from and its tip that bone's
 * feather fan, so the fans close the feathers up as the wing folds.
 */
function wingGeometry(sx) {
  const pos = [], wing = [], feather = [], si = [], sw = [], idx = [];
  const COV = 0.62;   // the coverts reach this far back across the chord
  const push = (x, y, z, s, v, f, bones, weights) => {
    pos.push(sx * x, y, z);
    wing.push(s, v);
    feather.push(...f);
    si.push(...bones);
    sw.push(...weights);
    return pos.length / 3 - 1;
  };
  const quad = (a, b, c, d) => {
    // Front faces are the upper (dorsal) side.
    if (sx > 0) idx.push(a, c, b, b, c, d);
    else idx.push(a, b, c, b, d, c);
  };
  // The covert sheet.
  const nu = 30, nv = 6;
  const grid = [];
  for (let i = 0; i <= nu; i++) {
    const s = SPAN * 0.97 * (i / nu);
    const [bi, bw] = skinAt(s);
    grid.push([]);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv * COV;
      const z = lerp(WING_LEAD(s), WING_TRAIL(s), v);
      const k = smoothstep(0.2, 0.9, v);
      grid[i].push(push(s, camber(s, v) + 0.002, z, s, v, [0, 0, 0, 0],
        [bi[0], FAN(bi[0]), bi[1], FAN(bi[1])], [bw[0] * (1 - k), bw[0] * k, bw[1] * (1 - k), bw[1] * k]));
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) quad(grid[i][j], grid[i][j + 1], grid[i + 1][j], grid[i + 1][j + 1]);

  /** One feather strip from root (s0, z0) to tip (s1, z1), `w` wide, along +s/-z in wing space. */
  const featherInfo = [];
  const strip = (s0, z0, s1, z1, w, kind, id, lift) => {
    // The feather's own bone, child of the bone it grows from; the feather is rigid on it but
    // for its quill, which blends into the attachment bone.
    const fb = 8 + featherInfo.length;
    const attach = s0 < ELBOW ? 0 : s0 < WRIST ? 1 : s0 < FLEX ? 2 : 3;
    featherInfo.push({ attach, root: [s0, camber(s0, 0.38) + lift, z0], dir: [s1 - s0, z1 - z0] });
    const rows = 7;
    const dx = s1 - s0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    // Across the feather, in the wing plane: (dz, -dx) rotated so +across is toward the tip of
    // the wing for a backward-pointing feather.
    const ax = -dz / len, az = dx / len;
    const ids = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const row = [];
      for (const u of [-1, 0, 1]) {
        const x = s0 + dx * t + ax * u * w * 0.5;
        const z = z0 + dz * t + az * u * w * 0.5;
        const sv = clamp(x, 0, SPAN);
        const vv = clamp((WING_LEAD(sv) - z) / Math.max(0.02, WING_LEAD(sv) - WING_TRAIL(sv)), 0, 1);
        const y = camber(sv, vv) + lift + (1 - u * u) * 0.0025 - t * 0.002;
        const k = smoothstep(0.0, 0.12, t);
        row.push(push(x, y, z, sv, Math.max(vv, 0.45 + 0.55 * t), [u, t, kind, id],
          [attach, fb, 0, 0], [1 - k, k, 0, 0]));
      }
      ids.push(row);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < 2; c++) {
      // Rows run toward the tip, columns across: orient so the upper side faces up.
      quad(ids[r][c + 1], ids[r][c], ids[r + 1][c + 1], ids[r + 1][c]);
    }
  };
  // Secondaries (and tertials near the body), straight back from the arm and forearm.
  for (let k = 0; k < 14; k++) {
    const s0 = 0.015 + k * (WRIST - 0.03) / 13;
    const z0 = lerp(WING_LEAD(s0), WING_TRAIL(s0), 0.38);
    const s1 = s0 + 0.012;
    const z1 = WING_TRAIL(s1) - 0.004;
    strip(s0, z0, s1, z1, 0.042, 1, k, -0.0015 - (k % 2) * 0.0012);
  }
  // Primaries, fanning from the hand: their tips run round the wing's rounded outline from the
  // trailing edge out to the wingtip.
  for (let k = 0; k < 10; k++) {
    const q = k / 9;
    const sr = WRIST - 0.01 + (FLEX + 0.04 - WRIST) * q;
    const zr = lerp(WING_LEAD(sr), WING_TRAIL(sr), 0.3);
    const st = WRIST + 0.05 + (SPAN - WRIST - 0.04) * Math.pow(q, 0.75);
    const zt = WING_TRAIL(st) + (WING_LEAD(st) - WING_TRAIL(st)) * 0.5 * q * q * q - 0.004;
    strip(sr, zr, st, zt, 0.044 - 0.012 * q, 2, k, 0.0005 + k * 0.0011);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 2));
  g.setAttribute('aFeather', new THREE.Float32BufferAttribute(feather, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.feathers = featherInfo;
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

function headGeometry() {
  const g = new THREE.SphereGeometry(1, 56, 40);
  const p = g.attributes.position;
  const dir = new Float32Array(p.count * 3);
  const d = v3();
  for (let i = 0; i < p.count; i++) {
    d.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    dir.set([d.x, d.y, d.z], i * 3);
    const q = headShape(d);
    p.setXYZ(i, q.x, q.y, q.z);
  }
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
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
  const span = v3(0, -Math.sin(1.12), -Math.cos(1.12));
  // Upper surface facing out and back: the folded wings wrap round and cover most of the back.
  const out = v3(0.8, 0.2, -0.75);
  const dorsal = out.clone().sub(span.clone().multiplyScalar(span.dot(out))).normalize();
  const lead = span.clone().cross(dorsal);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(span, dorsal, lead));
})();

// The folded forearm and hand, placed from where the joints lie on a real folded wing (in the
// shoulder's frame): the wrist at the front of the flank just under the shoulder, the wingtip
// down over the tail; each bone's upper surface kept facing out.
const basis = (x, hint) => {
  const X1 = x.clone().normalize();
  const Y1 = hint.clone().sub(X1.clone().multiplyScalar(X1.dot(hint))).normalize();
  const Z1 = X1.clone().cross(Y1);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X1, Y1, Z1));
};
const [FOLDED_ELBOW, FOLDED_WRIST] = (() => {
  const armQ = FOLDED_SHOULDER;
  const elbow = v3(ELBOW, 0, 0).applyQuaternion(armQ);
  const wristTarget = v3(-0.03, -0.035, 0.06);
  // The forearm lies along the flank, its upper surface straight out; the hand over the back.
  const foreQ = basis(wristTarget.clone().sub(elbow), v3(1, 0.1, 0));
  const wrist = elbow.clone().add(v3(WRIST - ELBOW, 0, 0).applyQuaternion(foreQ));
  const tipTarget = v3(-0.06, -0.33, -0.1);
  const handQ = basis(tipTarget.clone().sub(wrist), v3(0.75, 0.2, -0.6));
  return [armQ.clone().invert().multiply(foreQ), foreQ.clone().invert().multiply(handQ)];
})();

export class Owl {
  constructor(kit, traits = makeTraits(Math.random)[0]) {
    this.kit = kit;
    this.traits = traits;
    const T = traits;
    const look = { uTint: { value: T.tint }, uContrast: { value: T.contrast }, uStreak: { value: T.streak } };
    this.ruffle = { value: 0 };
    this.mats = {
      body: bodyMaterial(look), head: headMaterial(look), wing: wingMaterial(look), tail: tailMaterial(look),
      cards: cardMaterial(look, this.ruffle),
    };
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
    // The coat of contour feathers over it.
    const coat = new THREE.Mesh(kit.bodyCards, M.cards);
    coat.castShadow = false;
    torso.add(coat);
    off.add(torso);
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.12, -0.095);
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
    const crown = new THREE.Mesh(kit.headCards, M.cards);
    this.head.add(crown);
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
      const feathers = kit.wingGeo[1].userData.feathers;
      const bones = Array.from({ length: 8 + feathers.length }, () => new THREE.Bone());
      // Bind-pose positions of the arm bones along the span.
      const boneS = [0, ELBOW, WRIST, FLEX];
      const fold = [];
      feathers.forEach((fi, k) => {
        const b = bones[8 + k];
        b.position.set(sx * (fi.root[0] - boneS[fi.attach]), fi.root[1], fi.root[2]);
        // Folded, it turns in the plane of the wing to point back toward the tail: along the
        // bone on the upper arm and hand (which point back), toward its base on the forearm.
        const heading = Math.atan2(-fi.dir[1], fi.dir[0]);
        // (On the forearm also a little down the flank, so they lie in a panel, not a bundle.)
        const want = fi.attach === 1 ? Math.PI - 0.55 - k * 0.025 : 0;
        let a = want - heading;
        while (a > Math.PI) a -= TAU;
        while (a < -Math.PI) a += TAU;
        fold.push({ q: qAxis(Y, a), lift: 0.002 + k * 0.0011, y: fi.root[1] });
      });
      bones[1].position.x = sx * ELBOW;
      bones[2].position.x = sx * (WRIST - ELBOW);
      bones[3].position.x = sx * (FLEX - WRIST);
      bones[0].add(bones[1]); bones[1].add(bones[2]); bones[2].add(bones[3]);
      bones[0].add(bones[4]); bones[2].add(bones[5]); bones[3].add(bones[6]); bones[1].add(bones[7]);
      feathers.forEach((fi, k) => bones[fi.attach].add(bones[8 + k]));
      const mesh = new THREE.SkinnedMesh(kit.wingGeo[sx > 0 ? 1 : 0], M.wing);
      mesh.add(bones[0]);
      mesh.updateMatrixWorld(true);
      mesh.bind(new THREE.Skeleton(bones));
      mesh.frustumCulled = false;
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * 0.13 * T.girth, 0.37 * T.height, -0.03);
      shoulder.add(mesh);
      off.add(shoulder);
      this.wings.push({ sx, bones, mesh, fold });
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
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = o.material !== M.cards; o.receiveShadow = true; } });

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
    this.mats.tail.userData.spread.value = 0.06 + this.tailSpread * 0.55;
    this.ruffle.value = clamp(-this.sleek, 0, 1.5);
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
    const elbow = qAxis(Y, -0.1).multiply(qAxis(Z, -lag * 0.3)).slerp(FOLDED_ELBOW, f);
    const wrist = qAxis(Y, 0.16 - this.sweep * 0.4).multiply(qAxis(Z, -lag * 0.6 + this.raise * 0.25)).slerp(FOLDED_WRIST, f);
    // The outer primaries bend up under load on the downstroke and trail on the upstroke.
    // Folded, the hand tucks its tip in against the body.
    const flex = qAxis(Z, -lag * 0.7 + stroke * 0.25).slerp(qAxis(Y, 0.08), f);
    // Folding, the coverts close up toward the bones (fans 4-7: arm, hand, outer hand, forearm),
    // and every flight feather swings round on its own root to point back toward the tail,
    // sliding in over its neighbour.
    const fans = [[0.45, 0], [0.5, 0], [0.55, 0], [0.45, 0]];
    const ident = new THREE.Quaternion();
    for (const w of this.wings) {
      const qs = [shoulder, elbow, wrist, flex];
      qs.forEach((q, i) => w.bones[i].quaternion.copy(w.sx > 0 ? q : mirror(q)));
      fans.forEach(([sz, rot], i) => {
        const b = w.bones[4 + i];
        b.scale.set(1, 1, lerp(1, sz, f));
        const q = qAxis(Y, rot * f);
        b.quaternion.copy(w.sx > 0 ? q : mirror(q));
      });
      w.fold.forEach((fd, k) => {
        const b = w.bones[8 + k];
        const q = ident.clone().slerp(fd.q, f);
        b.quaternion.copy(w.sx > 0 ? q : mirror(q));
        b.position.y = fd.y + fd.lift * f;
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
  { name: 'silver', tint: [1.1, 1.11, 1.16], contrast: 1.35, streak: 0.75 },
  { name: 'brown', tint: [1.12, 0.9, 0.68], contrast: 1.1, streak: 1.25 },
  { name: 'pale', tint: [1.18, 1.16, 1.11], contrast: 0.8, streak: 0.6 },
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
    bodyCards: bodyCardsGeometry(),
    headCards: headCardsGeometry(),
    headGeo: headGeometry(),
    tailGeo: tailFeathersGeometry(),
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
