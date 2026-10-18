// Aspen Snow — Snowshoe hare: a procedural body on a small rig, clothed in fur strands, with
// the habits of the real animal and the tracks it leaves.
//
// Lepus americanus in winter: about 45 cm nose to rump and 1.3-1.5 kg, pure white but for black
// ear tips and dark eyes, with ears a third shorter than a jackrabbit's and huge furred hind
// feet, the "snowshoes", that carry it over soft snow. It spends the day in a form (a hollow it
// sits in), feeds at dusk and dawn on the bark and twigs of aspen suckers and other shoots,
// moves in short hops, sits up tall to look and listen when something stirs, and when it must
// flee runs at up to 45 km/h in three-metre zigzag bounds. Its track is the classic set of four:
// the long hind feet land side by side ahead of the two small fore feet.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, v3, unit, approach, angleDiff, Art } from './util.js';
import { G, NOISE_GLSL, patchMaterial, patchDepth } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** A closed surface of `rows` x `sides` from `at(t, a)` → Vector3 (t 0..1 along, a 0..TAU round). */
function lofted(rows, sides, at) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= sides; c++) {
      const t = r / rows, a = c / sides * TAU;
      const p = at(t, a);
      pos.push(p.x, p.y, p.z);
      uv.push(c / sides, t);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < sides; c++) {
      const a = r * (sides + 1) + c, b = a + 1, d = a + sides + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A sausage along +x from x0 to x1: centre line y = yc(t), half-heights ry(t), half-widths rz(t),
 * with the ends rounded off by the radius functions going to zero.
 */
const sausage = (x0, x1, yc, ry, rz) => (t, a) => v3(x0 + (x1 - x0) * t, yc(t) + Math.sin(a) * ry(t), Math.cos(a) * rz(t));
const bulb = (k = 0.5) => (t) => Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), k);

/**
 * Fur: small cards rooted just under a surface, lying along the fur's flow and lifted a little
 * off it, each drawn in the shader as a few hairs. `surface(t, a)` and `n` samples the part's
 * surface and normal; `flow(t, a)` the direction the hair lies in (world of the part).
 */
function furCards(count, surface, flow, rng, opts = {}) {
  const len = opts.len ?? 0.016, wid = opts.wid ?? 0.007, lift = opts.lift ?? 0.3;
  const pos = [], uv = [], idx = [], seed = [];
  const tmpN = v3();
  for (let i = 0; i < count; i++) {
    const t = opts.tRange ? lerp(opts.tRange[0], opts.tRange[1], rng()) : rng(), a = rng() * TAU;
    const p = surface(t, a);
    // Normal from finite differences.
    const dt = unit(surface(Math.min(1, t + 0.01), a).sub(surface(Math.max(0, t - 0.01), a)));
    const da = unit(surface(t, a + 0.05).sub(surface(t, a - 0.05)));
    const n = tmpN.copy(da).cross(dt);
    if (n.lengthSq() < 1e-9) continue;
    n.normalize();
    // Outward: the normal should point away from the part's axis (its centre line is near y = 0, z = 0).
    const outward = v3(0, p.y, p.z);
    if (outward.lengthSq() > 1e-9 && n.dot(outward) < 0) n.negate();
    let f = flow(t, a, p);
    f = unit(f.sub(n.clone().multiplyScalar(f.dot(n))));
    if (f.lengthSq() < 1e-6) f = dt.clone();
    const side = unit(f.clone().cross(n));
    const dir = unit(f.clone().multiplyScalar(Math.cos(lift)).addScaledVector(n, Math.sin(lift)));
    const root = p.clone().addScaledVector(n, -0.002);
    const L = len * (0.7 + 0.6 * rng()), W = wid * (0.7 + 0.6 * rng());
    const base = pos.length / 3;
    for (let r = 0; r < 3; r++) {
      const s = r / 2;
      // The card curves back toward the surface at the tip.
      const q = root.clone().addScaledVector(dir, s * L).addScaledVector(n, -s * s * L * 0.3);
      for (const c of [-1, 1]) {
        const w = W * 0.5 * (1 - s * 0.5);
        const v = q.clone().addScaledVector(side, c * w);
        pos.push(v.x, v.y, v.z);
        uv.push(c * 0.5 + 0.5, s);
        seed.push(i * 0.37 % 1);
      }
    }
    for (let r = 0; r < 2; r++) {
      const k = base + r * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seed), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const FUR_HEAD = `
varying vec2 vFUv;
varying vec3 vFN;
`;

/** The pelt: white with the faint grey of the underfur in the shade, soft at the edges. */
function peltMaterial(kind) {
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 }), {
    key: 'hare-pelt-' + kind,
    uniforms: { uTime: G.uTime, uSkyLight: G.uSkyLight, uTint: { value: new THREE.Vector3(1, 1, 1) } },
    vHead: `varying vec2 vPUv; varying vec3 vPN; varying float vUp;`,
    vMain: `vPUv = uv; vPN = normalize(normalMatrix * gNormal); vUp = normalize(mat3(modelMatrix) * gNormal).y;`,
    fHead: `varying vec2 vPUv; varying vec3 vPN; varying float vUp; uniform vec3 uSkyLight, uTint;\n${NOISE_GLSL}`,
    fColor: `
      {
        // The coat lies in strands along the body: fine streaks, fading out before they alias.
        vec2 sp = vec2(vPUv.x * 120.0, vPUv.y * 6.0);
        float streak = vnoise(sp) * 0.5 + vnoise(sp * vec2(2.1, 1.3) + 7.0) * 0.3 + vnoise(sp * vec2(4.3, 1.7) + 3.0) * 0.2;
        float px = fwidth(sp.x);
        streak = mix(0.5, streak, 1.0 - smoothstep(0.25, 0.6, px));
        float g = vnoise(vPUv * vec2(30.0, 60.0));
        vec3 fur = mix(vec3(0.86, 0.88, 0.91), vec3(0.97, 0.97, 0.98), smoothstep(0.2, 0.8, g * 0.5 + streak * 0.5));
        // The sky lights the back and leaves the belly and the undersides in a cool shade, which
        // is what gives a white animal its shape on a white day.
        float form = smoothstep(-0.9, 0.9, vUp);
        fur *= mix(vec3(0.66, 0.70, 0.78), vec3(1.0), 0.35 + 0.65 * form);
        ${kind === 'ear' ? `
        // Ears: black tips, and the inside greyish-pink where the fur is thin.
        float tip = smoothstep(0.84, 0.9, vPUv.y + (vnoise(vPUv * 40.0) - 0.5) * 0.06);
        fur = mix(fur, vec3(0.03, 0.028, 0.026), tip);
        float inner = smoothstep(0.2, 0.5, sin(vPUv.x * 6.2831) * -1.0);
        fur = mix(fur, vec3(0.5, 0.42, 0.42), inner * 0.5 * (1.0 - tip));` : ''}
        ${kind === 'head' ? `
        // The muzzle a touch greyer toward the nose.
        fur = mix(fur, vec3(0.7, 0.7, 0.72), smoothstep(0.85, 1.0, vPUv.y) * 0.4);` : ''}
        ${kind === 'tail' ? `
        fur = mix(fur, vec3(0.45, 0.45, 0.47), smoothstep(0.5, 0.9, sin(vPUv.x * 6.2831)) * 0.45);` : ''}
        diffuseColor.rgb = fur * uTint;
      }`,
    fBeforeOpaque: `
      {
        // The soft halo of fur at the silhouette: light from the sky scatters through the tips.
        vec3 V = normalize(vViewPosition);
        float rim = pow(1.0 - max(dot(normalize(vPN), V), 0.0), 3.0);
        outgoingLight += uSkyLight * rim * 0.35 * diffuseColor.rgb;
      }`,
  });
  return mat;
}

/** The hair cards: three strands per card, alpha-tested. */
function strandMaterial() {
  const mat = patchMaterial(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true,
  }), {
    key: 'hare-strands',
    uniforms: { uTime: G.uTime, uSkyLight: G.uSkyLight, uTint: { value: new THREE.Vector3(1, 1, 1) } },
    vHead: `attribute float aSeed; varying vec2 vSUv; varying float vSeed; uniform float uTime;`,
    vMain: `
      vSUv = uv; vSeed = aSeed;
      // The tips stir a little in the air.
      gPos += vec3(sin(uTime * 2.1 + aSeed * 20.0), 0.0, cos(uTime * 1.7 + aSeed * 30.0)) * 0.0008 * uv.y * uv.y;`,
    fHead: `varying vec2 vSUv; varying float vSeed; uniform vec3 uSkyLight, uTint;\n${NOISE_GLSL}`,
    fColor: `
      {
        float x = vSUv.x * 3.0 + vSeed * 0.5;
        float d = abs(fract(x) - 0.5);
        float fw = max(fwidth(x), 0.02);
        float w = 0.16 * (1.0 - vSUv.y * 0.7);
        float a = 1.0 - smoothstep(w - fw, w + fw, d);
        a *= 1.0 - smoothstep(0.8, 1.0, vSUv.y);
        if (a < 0.03) discard;
        diffuseColor.a = a;
        diffuseColor.rgb = mix(vec3(0.82, 0.83, 0.86), vec3(0.97, 0.97, 0.98), vSUv.y) * uTint;
      }`,
  });
  return mat;
}

// ---------------------------------------------------------------------------------------------
// The kit: geometry and materials shared by every hare.
// ---------------------------------------------------------------------------------------------

export function makeHareKit() {
  const rng = (() => { let s = 12345; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  const geo = {};
  const fur = {};
  const flowBack = () => v3(-1, 0, 0);

  // Bodies are lofted from side-view profiles: the line of the back, the line of the belly and
  // the half-width, each given as control points along the body and interpolated smoothly.
  const curve = (pts) => (t) => {
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const u = clamp((t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]), 0, 1);
        const k = u * u * (3 - 2 * u);
        return lerp(pts[i - 1][1], pts[i][1], k);
      }
    }
    return pts[pts.length - 1][1];
  };
  const profiled = (x0, x1, top, bottom, width) => (t, a) => {
    const yt = top(t), yb = bottom(t), w = width(t);
    const sa = Math.sin(a), ca = Math.cos(a);
    // A little squarer than an ellipse, as a furred body is.
    const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 0.85), cz = Math.sign(ca) * Math.pow(Math.abs(ca), 0.85);
    const y = sy > 0 ? sy * yt : -sy * yb;
    return v3(x0 + (x1 - x0) * t, y, cz * w);
  };

  // Torso: the rump high and round over the haunches, the back sloping down to low shoulders,
  // a deep belly, narrowing into the neck at the front and the tail at the back.
  const torsoS = profiled(-0.19, 0.12,
    curve([[0, 0.01], [0.12, 0.068], [0.3, 0.092], [0.55, 0.082], [0.8, 0.066], [0.95, 0.042], [1, 0.004]]),
    curve([[0, -0.005], [0.1, -0.042], [0.3, -0.062], [0.6, -0.06], [0.85, -0.052], [0.95, -0.032], [1, -0.004]]),
    curve([[0, 0.005], [0.1, 0.044], [0.3, 0.066], [0.55, 0.06], [0.8, 0.052], [0.95, 0.032], [1, 0.004]]));
  geo.torso = lofted(30, 26, torsoS);
  fur.torso = furCards(820, torsoS, (t, a) => v3(-1, -0.35 * Math.abs(Math.cos(a)), 0.45 * Math.cos(a)), rng, { len: 0.023, wid: 0.008 });
  // Head: a domed skull, the brow high, the nose line convex and curving down to a blunt
  // muzzle; wide at the cheeks, narrow at the nose; the back open into the neck.
  const headS = profiled(-0.035, 0.095,
    curve([[0, 0.012], [0.12, 0.038], [0.4, 0.041], [0.7, 0.03], [0.9, 0.014], [1, 0.002]]),
    curve([[0, -0.006], [0.15, -0.03], [0.4, -0.037], [0.7, -0.031], [0.9, -0.019], [1, -0.006]]),
    curve([[0, 0.005], [0.15, 0.038], [0.4, 0.046], [0.7, 0.035], [0.9, 0.023], [1, 0.005]]));
  geo.head = lofted(22, 22, headS);
  fur.head = furCards(300, headS, (t, a) => v3(-1, -0.2, 0.5 * Math.cos(a)), rng, { len: 0.011, wid: 0.005, tRange: [0.05, 0.9] });
  // Ears: long, slightly cupped blades, along +y, the tip curving back.
  const earS = (t, a) => {
    const w = 0.024 * Math.pow(Math.sin(Math.PI * clamp(t * 0.95 + 0.05, 0, 1)), 0.55) * (1 - 0.2 * t);
    const th = 0.0045 * bulb(0.5)(t);
    return v3(Math.sin(a) * th - 0.016 * t * t + 0.005 * Math.cos(a) * Math.cos(a) * w / 0.024, t * 0.092, Math.cos(a) * w);
  };
  geo.ear = lofted(14, 12, earS);
  fur.ear = furCards(50, earS, (t, a) => v3(0, 1, 0), rng, { len: 0.006, wid: 0.003, lift: 0.15, tRange: [0, 0.7] });
  // Limbs, along +x of their own groups. The thigh is a big rounded haunch.
  const seg = (L, r0, r1, flat = 1) => sausage(-0.004, L + 0.004, () => 0, (t) => lerp(r0, r1, t) * bulb(0.12)(t), (t) => lerp(r0, r1, t) * bulb(0.12)(t) * flat);
  const thighS = sausage(-0.01, 0.105, (t) => 0.008 * Math.sin(Math.PI * t), (t) => lerp(0.058, 0.028, t) * bulb(0.3)(t), (t) => lerp(0.046, 0.024, t) * bulb(0.3)(t));
  geo.thigh = lofted(12, 16, thighS);
  fur.thigh = furCards(160, thighS, () => v3(1, -0.3, 0), rng, { len: 0.016, wid: 0.006 });
  geo.shank = lofted(8, 10, seg(0.11, 0.024, 0.016));
  geo.foot = lofted(8, 12, sausage(-0.02, 0.13, () => 0, (t) => 0.013 * bulb(0.3)(t), (t) => 0.03 * bulb(0.3)(t)));
  geo.toe = lofted(4, 8, seg(0.03, 0.007, 0.004));
  const upperS = seg(0.075, 0.02, 0.014), lowerS = seg(0.07, 0.014, 0.011);
  geo.upper = lofted(8, 10, upperS);
  geo.lower = lofted(8, 10, lowerS);
  fur.upper = furCards(50, upperS, () => v3(1, -0.4, 0), rng, { len: 0.012, wid: 0.005 });
  fur.lower = furCards(40, lowerS, () => v3(1, -0.4, 0), rng, { len: 0.01, wid: 0.004 });
  geo.paw = lofted(6, 10, sausage(-0.01, 0.045, () => 0, (t) => 0.009 * bulb(0.3)(t), (t) => 0.016 * bulb(0.3)(t)));
  geo.tail = lofted(8, 10, sausage(-0.005, 0.032, (t) => 0.012 * t, (t) => 0.017 * bulb(0.6)(t), (t) => 0.016 * bulb(0.6)(t)));
  geo.eyeRing = new THREE.TorusGeometry(0.0135, 0.0022, 8, 24);
  geo.cleft = new THREE.BoxGeometry(0.003, 0.012, 0.0012);
  geo.eye = new THREE.SphereGeometry(0.0135, 20, 14);
  geo.joint = new THREE.SphereGeometry(1, 10, 8);
  geo.nose = new THREE.SphereGeometry(0.007, 12, 8);
  geo.glint = new THREE.SphereGeometry(0.0022, 8, 6);

  const mats = {
    pelt: peltMaterial('body'), head: peltMaterial('head'), ear: peltMaterial('ear'), tail: peltMaterial('tail'), strands: strandMaterial(),
    eye: new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.12, metalness: 0 }),
    nose: new THREE.MeshStandardMaterial({ color: 0x3a2a2a, roughness: 0.5 }),
    ring: new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
    shadow: new THREE.MeshBasicMaterial({ map: Art.texture(Art.blob(128, 0.2)), color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, fog: false }),
  };
  const dispose = () => {
    for (const g of Object.values(geo)) g.dispose();
    for (const g of Object.values(fur)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
  };
  return { geo, fur, mats, dispose };
}

/** A few individuals: size, the grey in their coat, and temperament. */
export function makeHareTraits(rng, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      size: 0.92 + rng() * 0.2,
      tint: 0.95 + rng() * 0.05,
      bold: rng(),                 // shy ones bolt sooner and watch longer
      earTilt: (rng() - 0.5) * 0.3,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Poses: joint angles (radians) and the body's height; blended between states.
// ---------------------------------------------------------------------------------------------

// Leg segments are given as angles in the ground frame, from straight forward (+x), positive
// upward: thigh/shank/foot for the hind leg, upper/lower/paw for the fore leg. Ear pitch is
// positive laid back; head pitch positive nose up; body pitch positive nose up.
const POSES = {
  // Hunched in its form, legs tucked beneath, ears laid back along the shoulders.
  loaf: { bodyY: 0.09, pitch: 0.05, head: { pitch: -0.15, y: 0.0 }, ear: { pitch: 1.3, spread: 0.25 }, thigh: -2.7, shank: -0.05, foot: 0.0, upper: -2.4, lower: -0.25, paw: 0.0, tail: 0.3 },
  // Sitting on its haunches, fore legs straight, head up, ears up.
  sit: { bodyY: 0.14, pitch: 0.28, head: { pitch: -0.1, y: 0.0 }, ear: { pitch: 0.25, spread: 0.3 }, thigh: -2.3, shank: -0.35, foot: 0.0, upper: -1.6, lower: -1.55, paw: 0.0, tail: 0.4 },
  // Up on its hind legs to look and listen, fore paws held to the chest.
  tall: { bodyY: 0.19, pitch: 0.85, head: { pitch: -0.55, y: 0.0 }, ear: { pitch: 0.05, spread: 0.25 }, thigh: -2.5, shank: -0.5, foot: 0.0, upper: -1.8, lower: -1.35, paw: -1.1, tail: 0.6 },
  // Crouched, ready: the frame of the hop.
  crouch: { bodyY: 0.11, pitch: 0.1, head: { pitch: -0.05, y: 0.0 }, ear: { pitch: 0.4, spread: 0.3 }, thigh: -2.5, shank: -0.3, foot: 0.0, upper: -1.7, lower: -1.2, paw: 0.0, tail: 0.2 },
  // Stretched in the air: hind legs trailing, fore legs reaching.
  stretch: { bodyY: 0.2, pitch: 0.2, head: { pitch: 0.0, y: 0.0 }, ear: { pitch: 0.9, spread: 0.2 }, thigh: -3.0, shank: -2.9, foot: -2.8, upper: -0.6, lower: -0.4, paw: -0.3, tail: 0.1 },
  // Landing on the fore paws, hind legs swinging forward past them.
  land: { bodyY: 0.14, pitch: -0.2, head: { pitch: 0.15, y: 0.0 }, ear: { pitch: 0.6, spread: 0.3 }, thigh: -1.2, shank: 0.3, foot: 0.2, upper: -1.5, lower: -1.4, paw: 0.0, tail: 0.2 },
  // Nose down to the snow or a sucker.
  nibble: { bodyY: 0.1, pitch: -0.05, head: { pitch: -0.7, y: -0.01 }, ear: { pitch: 0.9, spread: 0.3 }, thigh: -2.6, shank: -0.1, foot: 0.0, upper: -1.9, lower: -0.9, paw: 0.0, tail: 0.3 },
  // Sitting, head turned down to a raised fore paw.
  groom: { bodyY: 0.13, pitch: 0.35, head: { pitch: -0.5, y: 0.0 }, ear: { pitch: 0.7, spread: 0.3 }, thigh: -2.4, shank: -0.3, foot: 0.0, upper: -1.6, lower: -1.5, paw: 0.0, tail: 0.4 },
};

function blendPose(a, b, t, out) {
  for (const k of ['bodyY', 'pitch', 'thigh', 'shank', 'foot', 'upper', 'lower', 'paw', 'tail']) out[k] = lerp(a[k], b[k], t);
  out.head.pitch = lerp(a.head.pitch, b.head.pitch, t);
  out.head.y = lerp(a.head.y, b.head.y, t);
  out.ear.pitch = lerp(a.ear.pitch, b.ear.pitch, t);
  out.ear.spread = lerp(a.ear.spread, b.ear.spread, t);
  return out;
}
const clonePose = (p) => ({ ...p, head: { ...p.head }, ear: { ...p.ear } });

// ---------------------------------------------------------------------------------------------
// The hare
// ---------------------------------------------------------------------------------------------

export class Hare {
  constructor(kit, traits, scene) {
    this.kit = kit;
    this.traits = traits;
    this.size = traits.size;
    this.root = new THREE.Group();
    this.pos = v3();
    this.yaw = 0;
    this.build();
    this.pose = clonePose(POSES.sit);
    this.poseFrom = clonePose(POSES.sit);
    this.poseTo = POSES.sit;
    this.blend = 1;
    this.blendTime = 0.4;
    this.state = 'loaf';
    this.timer = 5;
    this.target = null;
    this.hop = null;             // { phase, T, len, height, yawTo, bolt }
    this.look = null;            // a world point it is watching, or null
    this.lookK = 0;              // how much the head is on it
    this.headYaw = 0; this.headPitchExtra = 0;
    this.earL = { yaw: 0, pitch: 0 }; this.earR = { yaw: 0, pitch: 0 };
    this.earFlick = { side: 0, t: 1 };
    this.blinkT = rnd(2, 6); this.blink = 0;
    this.breath = 0;
    this.nose = 0;
    this.alert = 0;              // 0..1, how wound up it is
    this.cooldown = 0;
    this.groomT = 0;
    this.lastHit = null;
    this.restSeen = 0;
    this.stare = 0;
    this.scene = scene;
  }

  build() {
    const { geo, fur, mats } = this.kit;
    const s = this.size;
    const tint = this.traits.tint;
    this.materials = [];
    const pelt = (kind) => {
      const m = kind === 'ear' ? mats.ear : kind === 'head' ? mats.head : kind === 'tail' ? mats.tail : mats.pelt;
      return m;
    };
    const mesh = (g, m, cast = true) => {
      const me = new THREE.Mesh(g, m);
      me.castShadow = cast;
      me.receiveShadow = false;
      return me;
    };
    const joint = (r) => { const j = mesh(geo.joint, pelt('body')); j.scale.setScalar(r); return j; };
    this.body = new THREE.Group();          // the torso frame
    this.body.scale.setScalar(s);
    this.root.add(this.body);
    this.torso = mesh(geo.torso, pelt('body'));
    this.torsoFur = mesh(fur.torso, mats.strands, false);
    this.body.add(this.torso, this.torsoFur);
    // Head on the neck.
    this.neck = new THREE.Group();
    this.neck.position.set(0.095, 0.028, 0);
    this.body.add(this.neck);
    this.headG = new THREE.Group();
    this.neck.add(this.headG);
    this.head = mesh(geo.head, pelt('head'));
    this.headFur = mesh(fur.head, mats.strands, false);
    this.headG.add(this.head, this.headFur);
    this.headG.scale.setScalar(1.1);
    this.eyes = [];
    for (const side of [-1, 1]) {
      const e = mesh(geo.eye, mats.eye, false);
      e.position.set(0.018, 0.012, side * 0.039);
      e.scale.set(0.9, 1, 1);
      const glint = mesh(geo.glint, mats.glint, false);
      glint.position.set(0.004, 0.005, side * 0.009);
      e.add(glint);
      // The dark rim of fur round the eye.
      const ring = mesh(geo.eyeRing, mats.ring, false);
      ring.position.set(0.018, 0.012, side * 0.040);
      this.headG.add(e, ring);
      this.eyes.push(e);
    }
    this.noseMesh = mesh(geo.nose, mats.nose, false);
    this.noseMesh.position.set(0.094, -0.004, 0);
    this.noseMesh.scale.set(0.7, 0.6, 1);
    this.headG.add(this.noseMesh);
    // The cleft of the upper lip below the nose.
    const cleft = mesh(geo.cleft, mats.nose, false);
    cleft.position.set(0.093, -0.013, 0);
    cleft.rotation.y = 0.2;
    this.headG.add(cleft);
    // Ears: a pivot each at the back of the skull.
    this.ears = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(-0.018, 0.034, side * 0.017);
      this.headG.add(pivot);
      const ear = mesh(geo.ear, pelt('ear'));
      ear.material.side = THREE.DoubleSide;
      const earFur = mesh(fur.ear, mats.strands, false);
      pivot.add(ear, earFur);
      this.ears.push({ pivot, side });
    }
    // Hind legs.
    this.hind = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(-0.09, -0.012, side * 0.045);
      this.body.add(hip);
      const thigh = mesh(geo.thigh, pelt('body'));
      const thighFur = mesh(fur.thigh, mats.strands, false);
      hip.add(thigh, thighFur);
      const knee = new THREE.Group();
      knee.position.set(0.1, 0, 0);
      hip.add(knee);
      knee.add(mesh(geo.shank, pelt('body')), joint(0.024));
      const ankle = new THREE.Group();
      ankle.position.set(0.11, 0, 0);
      knee.add(ankle);
      ankle.add(mesh(geo.foot, pelt('body')), joint(0.016));
      for (let k = 0; k < 4; k++) {
        const toe = mesh(geo.toe, pelt('body'), false);
        toe.position.set(0.12, -0.002, (k - 1.5) * 0.013);
        toe.rotation.y = (k - 1.5) * -0.2;
        ankle.add(toe);
      }
      this.hind.push({ hip, knee, ankle, side });
    }
    // Fore legs.
    this.fore = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.078, -0.028, side * 0.034);
      this.body.add(shoulder);
      shoulder.add(mesh(geo.upper, pelt('body')), mesh(fur.upper, mats.strands, false));
      const elbow = new THREE.Group();
      elbow.position.set(0.075, 0, 0);
      shoulder.add(elbow);
      elbow.add(mesh(geo.lower, pelt('body')), joint(0.014), mesh(fur.lower, mats.strands, false));
      const wrist = new THREE.Group();
      wrist.position.set(0.07, 0, 0);
      elbow.add(wrist);
      wrist.add(mesh(geo.paw, pelt('body')), joint(0.011));
      this.fore.push({ shoulder, elbow, wrist, side });
    }
    // Tail.
    this.tail = new THREE.Group();
    this.tail.position.set(-0.178, 0.028, 0);
    this.body.add(this.tail);
    const tail = mesh(geo.tail, pelt('tail'));
    tail.rotation.y = Math.PI;
    this.tail.add(tail);
    // Contact shadow on the snow.
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mats.shadow);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;
    this.root.add(this.shadow);
  }

  // MARK: - Placement and poses

  place(x, z, yaw) {
    this.pos.set(x, this.scene.height(x, z), z);
    this.yaw = yaw;
    this.root.position.copy(this.pos);
    this.root.rotation.y = yaw;
  }

  /** The hare's forward direction (world). */
  forward() { return v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  headWorld() { return this.headG.getWorldPosition(v3()); }

  setPose(name, time = 0.4) {
    if (this.poseTo === POSES[name]) return;
    this.poseFrom = clonePose(this.pose);
    this.poseTo = POSES[name];
    this.blend = 0;
    this.blendTime = time;
  }

  /** Apply a pose to the rig, plus the live extras (head, ears, breathing, blink). */
  apply(p, dt) {
    const s = this.size;
    this.body.position.y = p.bodyY * s + this.breath * 0.004;
    this.body.rotation.z = p.pitch;
    this.body.scale.set(s, s * (1 + this.breath * 0.012), s * (1 + this.breath * 0.012));
    this.headG.rotation.z = p.head.pitch + this.headPitchExtra;
    this.headG.rotation.y = this.headYaw;
    this.headG.position.y = p.head.y;
    for (const e of this.ears) {
      const extra = e.side < 0 ? this.earL : this.earR;
      const flick = this.earFlick.side === e.side ? Math.sin(Math.min(this.earFlick.t, 1) * Math.PI) * 0.5 : 0;
      e.pivot.rotation.set(e.side * (p.ear.spread + this.traits.earTilt) + flick, extra.yaw, p.ear.pitch + extra.pitch);
      e.pivot.rotation.order = 'YZX';
    }
    // Segment angles are in the ground frame: the first joint takes out the body's pitch.
    for (const h of this.hind) { h.hip.rotation.z = p.thigh - p.pitch; h.knee.rotation.z = p.shank - p.thigh; h.ankle.rotation.z = p.foot - p.shank; }
    for (const f of this.fore) {
      const g = this.groomPaw && f.side < 0 ? this.groomPaw : null;
      const up = g ? g.upper : p.upper, lo = g ? g.lower : p.lower, pw = g ? g.paw : p.paw;
      f.shoulder.rotation.z = up - p.pitch; f.elbow.rotation.z = lo - up; f.wrist.rotation.z = pw - lo;
    }
    this.tail.rotation.z = p.tail;
    // Blink: the eyes close to a slit.
    const closed = this.blink > 0 ? Math.sin(Math.min(this.blink / 0.14, 1) * Math.PI) : 0;
    for (const e of this.eyes) e.scale.y = 1 - 0.92 * closed;
    // The nose works when it is alert.
    this.noseMesh.position.y = -0.012 + Math.sin(this.nose) * 0.0015;
    this.noseMesh.scale.x = 0.7 + Math.sin(this.nose) * 0.08;
    this.shadow.scale.set(0.75 * s, 0.55 * s, 1);
    this.shadow.position.set(0.0, 0.01, 0);
  }

  // MARK: - Behaviour

  /** Something sudden at `p`: bolt if it's close and strong, else sit up. */
  startle(p, strength) {
    const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    if (this.state === 'bolt') return;
    if (d < 5 * strength && strength > 0.9) this.bolt(p);
    else if (d < 12 * strength) { this.alert = 1; if (this.state !== 'hop') this.enter('sit'); this.look = p.clone(); }
  }

  enter(state) {
    this.state = state;
    switch (state) {
      case 'loaf': this.setPose('loaf', 1.2); this.timer = rnd(25, 70); break;
      case 'sit': this.setPose('sit', 0.35); this.timer = rnd(4, 12); break;
      case 'tall': this.setPose('tall', 0.45); this.timer = rnd(5, 14); break;
      case 'nibble': this.setPose('nibble', 0.5); this.timer = rnd(15, 40); break;
      case 'groom': this.setPose('groom', 0.5); this.timer = rnd(4, 9); this.groomT = 0; break;
      case 'freeze': this.timer = rnd(3, 6); break;
    }
  }

  /** Hop toward `target` (a world point); `bolt` for flight bounds. */
  goTo(target, bolt = false) {
    this.finalTarget = target.via ? target.clone() : null;
    this.target = (target.via ?? target).clone();
    this.bounds = 0;
    this.state = bolt ? 'bolt' : 'hop';
    this.zig = 1;
    this.beginBound();
  }

  bolt(from) {
    this.alert = 1;
    // Away from `from`, bent toward the middle of the home ground so it stays in view.
    const away = unit(v3(this.pos.x - from.x, 0, this.pos.z - from.z));
    if (away.lengthSq() < 0.5) away.set(rnd(-1, 1), 0, -1).normalize();
    const home = unit(v3(-this.pos.x * 0.6, 0, -16 - this.pos.z));
    const dir = unit(away.multiplyScalar(1).add(home.multiplyScalar(0.7)));
    const dist = rnd(7, 12);
    let t = null;
    for (let tries = 0; tries < 12; tries++) {
      const a = (tries - 6) * 0.25;
      const d = v3(dir.x * Math.cos(a) - dir.z * Math.sin(a), 0, dir.x * Math.sin(a) + dir.z * Math.cos(a));
      const p = this.pos.clone().addScaledVector(d, dist);
      if (this.scene.openSnow(p.x, p.z, 0.6) && this.inHome(p)) { const way = this.route(p); if (way) { t = p; t.via = way.length > 1 ? way[0] : null; break; } }
    }
    if (!t) t = this.pos.clone().addScaledVector(dir, 4);
    t.y = this.scene.height(t.x, t.z);
    this.goTo(t, true);
    this.cooldown = 6;
  }

  /** The ground the hares keep to: in front of the viewer, within the view, not too close. */
  inHome(p) {
    return p.z < -3.5 && p.z > -34 && Math.abs(p.x) < 2 + -p.z * 0.48;
  }

  pathClear(p, from = this.pos) {
    const n = Math.max(4, Math.ceil(Math.hypot(p.x - from.x, p.z - from.z) / 0.5));
    for (let i = 1; i <= n; i++) {
      const x = lerp(from.x, p.x, i / n), z = lerp(from.z, p.z, i / n);
      if (!this.scene.openSnow(x, z, 0.35)) return false;
    }
    return true;
  }

  /** A way to `p`: straight if it is clear, else round a trunk through one waypoint; null if neither. */
  route(p) {
    if (this.pathClear(p)) return [p];
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.5) return null;
    const sx = -dz / d, sz = dx / d;
    for (const f of [0.5, 0.35, 0.65]) {
      for (const off of [1.2, -1.2, 2.2, -2.2]) {
        const via = v3(this.pos.x + dx * f + sx * off, 0, this.pos.z + dz * f + sz * off);
        if (!this.inHome(via) || !this.scene.openSnow(via.x, via.z, 0.5)) continue;
        if (this.pathClear(via) && this.pathClear(p, via)) { via.y = this.scene.height(via.x, via.z); return [via, p]; }
      }
    }
    return null;
  }

  /** Somewhere nearby in the open snow to hop to, or null. */
  pickSpot(maxDist, near = null) {
    for (let tries = 0; tries < 16; tries++) {
      const a = rnd(0, TAU), d = rnd(1.5, maxDist);
      const c = near ?? this.pos;
      const p = v3(c.x + Math.cos(a) * d, 0, c.z + Math.sin(a) * d);
      if (!this.inHome(p) || !this.scene.openSnow(p.x, p.z, 0.7)) continue;
      // Not on top of another hare.
      if (this.scene.hares.some((o) => o !== this && Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < 1.2)) continue;
      const way = this.route(p);
      if (!way) continue;
      p.y = this.scene.height(p.x, p.z);
      p.via = way.length > 1 ? way[0] : null;
      return p;
    }
    return null;
  }

  beginBound() {
    const bolt = this.state === 'bolt';
    const to = this.target;
    const dx = to.x - this.pos.x, dz = to.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    let yawTo = Math.atan2(-dz, dx);
    if (bolt) {
      // Zigzag: each bound veers to alternate sides of the line.
      this.zig = -this.zig;
      yawTo += this.zig * rnd(0.25, 0.5) * smoothstep(1, 4, dist);
    }
    const len = bolt ? Math.min(dist, rnd(2.2, 3.2)) : Math.min(dist, rnd(0.5, 0.9) * (0.6 + this.alert * 0.6));
    const T = bolt ? 0.3 + len * 0.02 : 0.4 + len * 0.2;
    this.bounds = (this.bounds || 0) + 1;
    this.hop = { phase: 0, T, len, height: bolt ? 0.35 : 0.1 + len * 0.1, yawFrom: this.yaw, yawTo, bolt, start: this.pos.clone(), landed: false };
  }

  stepBound(dt) {
    const h = this.hop;
    const ph0 = h.phase;
    h.phase = Math.min(1, h.phase + dt / h.T);
    const ph = h.phase;
    // Turn during the crouch, travel through the air, settle on landing.
    const turn = smoothstep(0, 0.25, ph);
    this.yaw = h.yawFrom + angleDiff(h.yawFrom, h.yawTo) * turn;
    const along = smoothstep(0.15, 0.85, ph);
    const fwd = v3(Math.cos(h.yawTo), 0, -Math.sin(h.yawTo));
    this.pos.copy(h.start).addScaledVector(fwd, h.len * along);
    this.pos.y = this.scene.height(this.pos.x, this.pos.z);
    const air = Math.sin(Math.PI * clamp((ph - 0.15) / 0.7, 0, 1));
    this.airY = h.height * air;
    // The pose through the bound: crouch, stretch, land, gather.
    let p;
    if (ph < 0.15) p = blendPose(POSES.crouch, POSES.stretch, smoothstep(0.05, 0.15, ph), this.pose);
    else if (ph < 0.6) p = blendPose(POSES.stretch, POSES.stretch, 0, this.pose);
    else if (ph < 0.85) p = blendPose(POSES.stretch, POSES.land, smoothstep(0.6, 0.8, ph), this.pose);
    else p = blendPose(POSES.land, POSES.crouch, smoothstep(0.85, 1, ph), this.pose);
    // Landing: the prints and a puff of snow.
    if (ph0 < 0.78 && ph >= 0.78 && !h.landed) {
      h.landed = true;
      const strength = h.bolt ? 0.35 : 0.08;
      this.scene.puffs.burst(this.pos.x, this.pos.y, this.pos.z, strength, 0.2);
      if (this.scene.snowpack.inMap(this.pos.x, this.pos.z)) this.scene.snowpack.stampHare(this.pos.x, this.pos.z, -this.yaw, this.size);
    }
    if (ph >= 1) {
      const dist = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z);
      if ((dist < 0.4 || (h.bolt && dist < 1.2)) && this.finalTarget) {
        // Round the trunk: on to the real target.
        this.target = this.finalTarget;
        this.finalTarget = null;
        this.beginBound();
      } else if (dist < 0.4 || (h.bolt && dist < 1.2) || this.bounds > 30) {
        this.hop = null;
        this.target = null;
        this.pose = clonePose(POSES.crouch);
        if (h.bolt) { this.enter('tall'); this.timer = rnd(6, 12); }
        else this.enter(this.next ?? 'sit');
        this.next = null;
      } else this.beginBound();
    }
    return p;
  }

  update(dt, scene, info) {
    const c = info;
    this.timer -= dt;
    this.cooldown -= dt;
    this.alert = Math.max(0, this.alert - dt / 12);

    // --- What the cursor is doing, in screen space ---------------------------------------------
    const headS = scene.project(this.headWorld(), { x: 0, y: 0 });
    const near = headS && c.pointer.inside ? Math.hypot(headS.x - c.x, headS.y - c.y) : Infinity;
    const onMe = near < 55;
    const hit = c.hit;
    const hitDist = hit ? Math.hypot(hit.x - this.pos.x, hit.z - this.pos.z) : Infinity;

    // A fast cursor sweeping close: bolt.
    if (c.pointer.inside && c.speed > 900 && near < 260 && this.state !== 'bolt' && this.cooldown <= 0) {
      this.bolt(hit ?? scene.camera.position);
    }
    // The cursor resting: notice it, then come closer to look.
    if (c.pointer.inside && c.rest > 1.5 && hit && this.state !== 'bolt' && this.state !== 'hop') {
      if (onMe) {
        // Stared at, it freezes, then stares back.
        if (this.state !== 'freeze') { this.enter('freeze'); this.look = null; }
        this.stare = Math.min(1, this.stare + dt / 2.5);
        if (this.stare > 0.99) this.look = scene.camera.position.clone();
      } else if (this.alert < 0.9 || this.state === 'loaf') {
        if (this.state === 'loaf' && near < 700) { this.enter('sit'); this.alert = 0.6; }
        this.look = hit.clone();
      }
      if (c.rest > 5 && hitDist > 3 && hitDist < 20 && this.cooldown <= 0 && c.nearestHare === this && (this.state === 'sit' || this.state === 'tall' || this.state === 'nibble')) {
        // Hop over to a spot a couple of metres short of it.
        const spot = this.pickSpot(2.6, v3(hit.x, 0, hit.z));
        if (spot && Math.hypot(spot.x - hit.x, spot.z - hit.z) > 1.2) {
          this.next = 'tall';
          this.goTo(spot);
          this.cooldown = 25;
        } else this.cooldown = 2;
      }
    } else if (this.state === 'freeze') {
      this.enter('sit');
      this.stare = 0;
    }
    if (!(c.pointer.inside && c.rest > 0.5)) this.stare = 0;
    if (c.pointer.inside && c.attention && hit && !this.look && this.state !== 'loaf') this.look = hit.clone();

    // --- The state machine -----------------------------------------------------------------------
    let p;
    if (this.hop) {
      p = this.stepBound(dt);
    } else {
      this.airY = 0;
      if (this.timer <= 0) {
        switch (this.state) {
          case 'loaf': this.enter(Math.random() < 0.6 ? 'sit' : 'groom'); break;
          case 'sit': {
            const r = Math.random();
            if (r < 0.35) { const s = this.pickSpot(6); if (s) { this.next = Math.random() < 0.5 ? 'nibble' : 'sit'; this.goTo(s); } else this.enter('loaf'); }
            else if (r < 0.5) this.enter('tall');
            else if (r < 0.65) this.enter('groom');
            else if (r < 0.8) this.enter('nibble');
            else this.enter('loaf');
            break;
          }
          case 'tall': this.enter(Math.random() < 0.5 ? 'sit' : 'loaf'); break;
          case 'nibble': { const s = this.pickSpot(4); if (s && Math.random() < 0.5) { this.next = 'nibble'; this.goTo(s); } else this.enter('sit'); break; }
          case 'groom': this.enter(Math.random() < 0.5 ? 'sit' : 'loaf'); break;
          case 'freeze': this.enter('tall'); break;
        }
      }
      // Blend toward the state's pose.
      this.blend = Math.min(1, this.blend + dt / this.blendTime);
      const k = smoothstep(0, 1, this.blend);
      p = blendPose(this.poseFrom, this.poseTo, k, this.pose);
      // Grooming: the near fore paw up to the face, moving in little circles.
      if (this.state === 'groom') {
        this.groomT += dt;
        const g = Math.sin(this.groomT * 9) * 0.5 + 0.5;
        this.groomPaw = { upper: 0.1 + g * 0.2, lower: 1.9 + g * 0.25, paw: 2.6 };
        p.head.pitch += Math.sin(this.groomT * 9) * 0.05;
        this.headYaw = approach(this.headYaw, 0.45, 0.3, dt);
      } else this.groomPaw = null;
      // Nibbling: small chewing nods and shifts.
      if (this.state === 'nibble') {
        p.head.pitch += Math.sin(this.scene.time * 6 + this.pos.x) * 0.03 * (0.5 + 0.5 * Math.sin(this.scene.time * 0.7));
      }
    }

    // --- Head and ears -----------------------------------------------------------------------------
    const relaxed = this.state === 'loaf' || this.state === 'nibble' || this.state === 'groom';
    if (this.look && !relaxed && !this.hop) {
      // Turn the head (and a little of the body's intent) toward the point of interest.
      const dx = this.look.x - this.pos.x, dz = this.look.z - this.pos.z;
      const want = angleDiff(this.yaw, Math.atan2(-dz, dx));
      this.headYaw = approach(this.headYaw, clamp(want, -1.1, 1.1), 0.25, dt);
      const dy = this.look.y - (this.pos.y + 0.2);
      this.headPitchExtra = approach(this.headPitchExtra, clamp(Math.atan2(dy, Math.hypot(dx, dz)) * 0.5, -0.4, 0.4), 0.3, dt);
      // Ears swivel to it, the near one more.
      const earWant = clamp(want, -1.0, 1.0);
      this.earL.yaw = approach(this.earL.yaw, earWant * 0.9, 0.2, dt);
      this.earR.yaw = approach(this.earR.yaw, earWant * 0.9, 0.2, dt);
      // Shuffle round if it is far behind.
      if (Math.abs(want) > 1.4 && !this.hop && this.state !== 'freeze' && this.cooldown <= 0) {
        const spot = this.pos.clone().add(v3(Math.cos(this.yaw + Math.sign(want) * 0.5), 0, -Math.sin(this.yaw + Math.sign(want) * 0.5)).multiplyScalar(0.3));
        spot.y = this.pos.y;
        this.next = this.state === 'tall' ? 'tall' : 'sit';
        this.goTo(spot);
        this.cooldown = 2;
      }
    } else {
      this.headYaw = approach(this.headYaw, this.state === 'groom' ? this.headYaw : 0, 0.6, dt);
      this.headPitchExtra = approach(this.headPitchExtra, 0, 0.6, dt);
      this.earL.yaw = approach(this.earL.yaw, 0, 0.5, dt);
      this.earR.yaw = approach(this.earR.yaw, 0, 0.5, dt);
    }
    // Ear flicks, blinks, breathing, the nose.
    this.earFlick.t += dt * 4;
    if (this.earFlick.t > 1 && Math.random() < dt * 0.15) { this.earFlick.t = 0; this.earFlick.side = Math.random() < 0.5 ? -1 : 1; }
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 0.14; this.blinkT = rnd(3, 8); }
    if (this.blink > 0) this.blink -= dt;
    const breathRate = relaxed ? 0.9 : 1.6 + this.alert * 1.2;
    this.breath = Math.sin(this.scene.time * TAU * breathRate + this.pos.x * 3) * 0.5 + 0.5;
    const sniffing = !relaxed || this.state === 'nibble';
    this.nose += dt * (sniffing ? 17 : 4);
    if (this.look && this.state !== 'freeze') this.alert = Math.max(this.alert, 0.3);

    // --- Place it ------------------------------------------------------------------------------------
    this.root.position.set(this.pos.x, this.pos.y + (this.airY || 0), this.pos.z);
    this.root.rotation.y = this.yaw;
    this.shadow.visible = true;
    this.shadow.material.opacity = 0.45 * (1 - 0.6 * G.uNight.value) * (1 - smoothstep(0, 0.3, this.airY || 0) * 0.6);
    this.shadow.position.y = -(this.airY || 0) + 0.012;
    this.apply(p, dt);
    if (this.look && !(c.pointer.inside && (c.attention || c.rest > 0.5))) {
      // Interest fades when nothing moves.
      if (Math.random() < dt * 0.15) this.look = null;
    }
  }

  dispose() {
    this.shadow.geometry.dispose();
  }
}
