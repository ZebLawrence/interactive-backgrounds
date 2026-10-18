// Sandstone Arch — The land: a heightfield of Navajo sandstone round a lake (the cliff mass on
// the left, the abutment on the right, the wall beyond, the mesas in the distance, the beach and
// the rocky bank under the viewer), the natural bridge spanning the lake, and the rock material
// that wraps them in the owner's own Lake Powell photographs when they are present, or a plain
// procedural sandstone when they are not.
//
// Units are metres. The water is y = 0, the viewer stands at the origin on the near bank, the
// bridge spans the lake 150 m away toward -z.

import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep, fbm2, noise2, v3, unit, seeded } from './util.js';
import { G, NOISE_GLSL, patchMaterial, patchDepth, LAYER, setLayers } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// The shape of the land
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The reference picture and its camera
// ---------------------------------------------------------------------------------------------

// The land is shaped to the owner's reference picture. Its edges, traced in picture pixels
// (2000 x 1116, [column, row] polylines), are cast back through the camera the picture is taken
// to have been made with: the viewer's own, at the origin REF.eyeY above the water, looking down
// -z, pitched up REF.pitch, with a 50 degree vertical field. Each mass is then the visual hull of
// its traced skyline at the depth we give it, so from the viewer's eye its outline is the
// picture's. The picture fixes outlines, not distances; the depths are ours.
export const REF = { w: 2000, h: 1116, fov: 50, eyeY: 2.7, pitch: 2.0 * Math.PI / 180 };
const REF_T = Math.tan(REF.fov / 2 * Math.PI / 180);
const REF_A = REF.w / REF.h;

/** The world direction of the ray through picture pixel (px, py). */
export function refRay(px, py) {
  const nx = px / REF.w * 2 - 1, ny = 1 - py / REF.h * 2;
  const x = nx * REF_T * REF_A, y0 = ny * REF_T, z0 = -1;
  const c = Math.cos(REF.pitch), sn = Math.sin(REF.pitch);
  return { x, y: y0 * c - z0 * sn, z: y0 * sn + z0 * c };
}
/** Where that ray is at depth z. */
export function refPoint(px, py, z) {
  const d = refRay(px, py), t = z / d.z;
  return { x: d.x * t, y: REF.eyeY + d.y * t, z };
}
/** The picture pixel a world point falls on. */
export function refPixel(x, y, z) {
  const c = Math.cos(REF.pitch), sn = Math.sin(REF.pitch);
  const yy = y - REF.eyeY;
  const y0 = yy * c + z * sn, z0 = -yy * sn + z * c;
  const nx = x / -z0 / (REF_T * REF_A), ny = y0 / -z0 / REF_T;
  return { px: (nx + 1) / 2 * REF.w, py: (1 - ny) / 2 * REF.h };
}
/** The x where the ray down picture column px passes depth z. */
function colX(px, z) { return refPoint(px, REF.h / 2, z).x; }
/** A traced edge's row at column px, interpolated along the polyline and held past its ends. */
function edgeRow(curve, px) {
  if (px <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (px <= curve[i][0]) { const [x0, y0] = curve[i - 1], [x1, y1] = curve[i]; return lerp(y0, y1, (px - x0) / (x1 - x0)); }
  }
  return curve[curve.length - 1][1];
}

// The traced edges, measured off the picture column by column (every 25 px): the skyline is
// the first row from the top where eight rows running are not sky; through the opening, the
// underside is where sky begins again below the span and the far wall where it ends.
const SKY_ROWS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 77, 123, 177, 192, 171, 145, 131, 123, 120, 118, 116, 114, 111, 111, 109, 105, 101, 105, 112, 115, 120, 125, 131, 140, 148, 157, 172, 184, 194, 194, 199, 203, 208, 213, 220, 226, 236, 247, 252, 258, 266, 268, 271, 276, 282, 286, 292, 299, 271, 268, 277, 279, 274, 278, 298, 299, 284, 271, 259, 245, 229, 214, 200, 195, 194, 202, 223, 223, 201];
const TRACE = {
  // The skyline across the whole picture: the tower (above the frame), the span, the dome.
  sky: [
    ...SKY_ROWS.map((r, i) => [-i * 25, r]).reverse().slice(0, -1),   // mirrored, left of the frame
    ...SKY_ROWS.map((r, i) => [i * 25, r]),
    ...SKY_ROWS.map((r, i) => [4000 - i * 25, r]).reverse().slice(1),  // mirrored, right of the frame
  ],
  // The underside of the span: the opening's upper edge, running down the buttress faces at
  // each end and on below the water, where the legs stand.
  archBottom: [[480, 700], [497, 583], [504, 565], [560, 496], [659, 422], [783, 360], [850, 352], [900, 342], [925, 338], [950, 336], [975, 333], [1000, 333], [1025, 336], [1050, 338], [1075, 340], [1100, 343], [1125, 347], [1150, 354], [1175, 362], [1200, 370], [1250, 372], [1300, 375], [1350, 380], [1400, 385], [1450, 390], [1500, 398], [1550, 408], [1600, 440], [1640, 520], [1660, 620], [1680, 700]],
  // The far wall seen through the opening.
  far: [[0, 352], [850, 352], [900, 348], [925, 352], [950, 354], [975, 358], [1000, 364], [1025, 369], [1050, 392], [1075, 396], [1100, 403], [1125, 410], [1150, 406], [1175, 399], [1200, 395], [2200, 395]],
  // The nearer wall on the canyon's right, behind the craft.
  right: [[1180, 430], [1230, 358], [1300, 360], [1400, 365], [1550, 375], [1700, 385], [2200, 385]],
  // Where the gap of sky under the span runs, in columns.
  gap: [890, 1215],
};

/**
 * The picture's sky, as a mask drawn from the traces (1 = sky): everything above the skyline,
 * and the gap under the span; each grown four pixels into the rock, so a surface point that
 * lands within a few pixels of an edge counts as sky and the shader steps off it.
 */
let refMaskTexture = null;
export function refMask() {
  if (refMaskTexture) return refMaskTexture;
  const c = document.createElement('canvas'); c.width = REF.w; c.height = REF.h;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, REF.w, REF.h);
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(0, -10);
  for (let x = 0; x <= REF.w; x += 4) g.lineTo(x, edgeRow(TRACE.sky, x) + 4);
  g.lineTo(REF.w, -10); g.closePath(); g.fill();
  g.beginPath();
  for (let x = TRACE.gap[0]; x <= TRACE.gap[1]; x += 4) g.lineTo(x, edgeRow(TRACE.archBottom, x) - 4);
  for (let x = TRACE.gap[1]; x >= TRACE.gap[0]; x -= 4) g.lineTo(x, edgeRow(TRACE.far, x) + 4);
  g.closePath(); g.fill();
  refMaskTexture = new THREE.CanvasTexture(c);
  refMaskTexture.wrapS = refMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
  return refMaskTexture;
}

/**
 * A mass of rock under a traced skyline: full height between picture columns c0..c1 and
 * depths zBack..zFront, eased over `edge` metres at the sides and the back, sheer at the
 * front. Its top is flat behind the front, at the height where the front edge meets the
 * skyline's ray, so from the eye its outline is the trace.
 */
function hullMass(x, z, curve, c0, c1, zBack, zFront, edge) {
  if (z > zFront) return 0;
  const x0 = colX(c0, z), x1 = colX(c1, z);
  const w = smoothstep(0, edge, Math.min(x - x0, x1 - x, z - zBack));
  if (w <= 0) return 0;
  let y = 0;
  for (let i = 0; i < 2; i++) { const { px } = refPixel(x, y, zFront); y = refPoint(px, edgeRow(curve, px), zFront).y; }
  return w * y;
}

/** The lake's left shoreline: x of the water's edge at z, traced from the picture. */
// The near bank the viewer stands on, then a bay out of frame to the left, then the beach.
const SHORE = [[10, -1], [0, -2], [-6.4, -3.1], [-8.2, -4.7], [-10.9, -6.8], [-13, -8.2], [-16.3, -10.5], [-21.6, -15.3], [-32.4, -25.9], [-36, -29.9], [-38, -70], [-56, -70], [-58.7, -48.9], [-64.5, -48.4], [-67.2, -44.8], [-71.6, -41.8], [-76.7, -38.4], [-84.7, -35.4], [-107.2, -35.8], [-128.4, -38.6], [-160, -32], [-400, -32]];
export function shoreX(z) {
  let x;
  if (z >= SHORE[0][0]) x = SHORE[0][1];
  else { x = SHORE[SHORE.length - 1][1]; for (let i = 1; i < SHORE.length; i++) if (z >= SHORE[i][0]) { const [z0, x0] = SHORE[i - 1], [z1, x1] = SHORE[i]; x = lerp(x0, x1, (z - z0) / (z1 - z0)); break; } }
  // A wobble that stays a few picture pixels wide at any distance.
  return x + (fbm2(z * 0.02 + 3, 1.7, 3) - 0.5) * 0.02 * Math.max(-z, 0);
}

/** Height of the ground at (x, z), in metres above the water (negative under it). */
export function groundHeight(x, z) {
  // The lake floor: a trough 9 m deep along the middle, shallowing toward every shore.
  let h = -9;
  const n2 = fbm2(x * 0.02 + 1, z * 0.02 + 9, 3) - 0.5;
  // The left beach: sand rising gently from the water's edge toward the cliff foot; the near
  // bank the viewer stands on is its first few metres.
  const sx = shoreX(z);
  // Past the water's edge the floor drops steeply: the water is dark right up to the shore,
  // as the picture has it, with no pale shelf of sand seen through the shallows.
  // The bank meets the water nearly flat: a lip would hide the water's edge from the low eye
  // and the shore would seem to stand inland of where the picture has it.
  const beach = (x < sx ? (sx - x) * 0.11 : (sx - x) * 1.6) + 0.1;
  if (z < 10) h = Math.max(h, Math.min(beach, 4.5 + n2 * 1.5));
  // Rock masses, each the hull of its traced skyline.
  let rock = 0;
  rock = Math.max(rock, hullMass(x, z, TRACE.sky, -1500, 375, -220, -120, 10));    // the tower on the left
  rock = Math.max(rock, hullMass(x, z, TRACE.sky, 1540, 3600, -260, -165, 10));    // the dome on the right
  rock = Math.max(rock, hullMass(x, z, TRACE.right, 1180, 3600, -420, -300, 14));   // the canyon's right wall
  rock = Math.max(rock, hullMass(x, z, TRACE.far, -1500, 760, -520, -350, 14));      // the canyon's left wall
  rock = Math.max(rock, hullMass(x, z, TRACE.far, 560, 1320, -620, -450, 14));      // the far wall across the opening
  rock = Math.max(rock, hullMass(x, z, TRACE.far, -2000, 4000, -1100, -900, 30));    // the skyline beyond
  if (rock > 0.02) h = Math.max(h, rock);
  // Under the water the floor is sand; above it the beach and the rock carry small roughness.
  if (h > 0.3) h += (fbm2(x * 0.3 + 5, z * 0.3 + 11, 2) - 0.5) * 0.25;
  return h;
}

/** Is a world point inside rock (below the ground surface or in the bridge)? */
export function insideRock(p) {
  return p.y < groundHeight(p.x, p.z) || bridgeInside(p);
}

// ---------------------------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------------------------

// The span lies in the plane z = BRIDGE.z, a slim rib at the crown swelling into broad
// buttresses toward each end; its top and underside follow the traced edges exactly: at each
// station the elliptical section is sized and placed so the rays to the two edges are tangent
// to it.
export const BRIDGE = { z: -150, x0: colX(340, -150), x1: colX(1690, -150), crownT: 0.33, crownHalfT: 9, legHalfT: 42 };

export function bridgePath(t) {
  const B = BRIDGE;
  const x = lerp(B.x0, B.x1, t), z = B.z;
  // Thickness: slim at the crown, flaring fast toward the feet.
  const u = Math.abs(t - B.crownT) / Math.max(B.crownT, 1 - B.crownT);
  const halfT = lerp(B.crownHalfT, B.legHalfT, Math.pow(Math.min(u, 1), 1.6));
  // The picture column this station is seen in, and the rays to the traced top and underside.
  let px = refPixel(x, 30, z).px;
  const top = refRay(px, edgeRow(TRACE.sky, px)), bot = refRay(px, edgeRow(TRACE.archBottom, px));
  const yt = REF.eyeY + top.y * (z / top.z), yb = REF.eyeY + bot.y * (z / bot.z);
  const tt = top.y / -top.z, tb = bot.y / -bot.z;
  // An ellipse (a tall, b deep) centred at yc is tangent to a ray of slope s passing yc + D at
  // its centre's depth when D^2 = a^2 + b^2 s^2; two rays fix a and yc.
  const H = Math.max(yt - yb, 2);
  const Dt = (H + halfT * halfT * (tt * tt - tb * tb) / H) / 2;
  const halfH = Math.sqrt(Math.max(Dt * Dt - halfT * halfT * tt * tt, 1));
  const y = yt - Dt;
  return { x, y, z, halfH, halfT };
}

export function bridgeInside(p) {
  const B = BRIDGE;
  const t = clamp((p.x - B.x0) / (B.x1 - B.x0), 0, 1);
  const q = bridgePath(t);
  const dy = (p.y - q.y) / q.halfH, dz = (p.z - q.z) / q.halfT;
  return dy * dy + dz * dz < 1;
}

/** The bridge's surface nearest a point, with the outward normal (for the craft and the blocks). */
export function bridgeContact(p) {
  const B = BRIDGE;
  const t = clamp((p.x - B.x0) / (B.x1 - B.x0), 0, 1);
  const q = bridgePath(t);
  const dy = p.y - q.y, dz = p.z - q.z;
  const k = Math.hypot(dy / q.halfH, dz / q.halfT) || 1e-3;
  const normal = unit(v3(0, dy / (q.halfH * q.halfH), dz / (q.halfT * q.halfT)));
  return { point: v3(p.x, q.y + dy / k, q.z + dz / k), normal, inside: k < 1 };
}

export class Bridge {
  constructor(material, rng) {
    const segs = 260, around = 64;
    const seed = rng() * 100;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = bridgePath(t);
      // Sections stand vertical (in y-z planes), swept along x, so the span's height at each
      // station is exactly the traced one however steeply it climbs.
      const N = v3(0, 1, 0), Bv = v3(0, 0, 1);
      for (let k = 0; k <= around; k++) {
        const phi = k / around * TAU;
        const c = Math.cos(phi), s = Math.sin(phi);
        // Squarer on top (a flat-topped rib) and flatter underneath.
        const hh = p.halfH, ht = p.halfT;
        const dir = N.clone().multiplyScalar(c * hh).add(Bv.clone().multiplyScalar(s * ht));
        const base = v3(p.x, p.y, p.z).add(dir);
        const n = unit(N.clone().multiplyScalar(c / hh).add(Bv.clone().multiplyScalar(s / ht)));
        const cx = Math.cos(phi) * 1.3 + seed, cz = Math.sin(phi) * 1.3 + seed * 0.7;
        let off = (fbm2(t * 30 + cx, cz, 3) - 0.5) * 1.2;
        off += (fbm2(t * 120 + cx * 3 + 3, cz * 3 + 9, 2) - 0.5) * 0.4;
        base.addScaledVector(n, off);
        pos.push(base.x, base.y, base.z);
        uv.push(t, phi / TAU);
      }
    }
    for (let i = 0; i < segs; i++) for (let k = 0; k < around; k++) {
      const a = i * (around + 1) + k, b = a + around + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    assertOutward(geo, 'bridge', (n) => n.y > 0, Math.round(BRIDGE.crownT * segs) * (around + 1));
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    setLayers(this.mesh, LAYER.ABOVE, LAYER.BELOW);
  }

  dispose() { this.geometry.dispose(); }
}

/**
 * A winding check: the vertex normal at `index` (default: the middle vertex) must satisfy
 * `expect`; if it does not, the triangles are wound the wrong way and their front faces would
 * be culled, leaving a hollow shell. Flip the index order and recompute.
 */
function assertOutward(geo, name, expect, index = null) {
  const n = geo.attributes.normal, count = n.count;
  const i = index ?? Math.floor(count / 2);
  const nv = v3(n.getX(i), n.getY(i), n.getZ(i));
  if (expect(nv)) return;
  console.warn(name + ': normals pointed inward; flipping the winding');
  const idx = geo.index.array;
  for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  geo.index.needsUpdate = true;
  geo.computeVertexNormals();
}

// ---------------------------------------------------------------------------------------------
// The heightfield mesh: fine near the viewer, coarse toward the skyline.
// ---------------------------------------------------------------------------------------------

export class Terrain {
  constructor(material) {
    const xs = [], zs = [];
    // One-metre cells over the bridge, its abutments and the near shore (x within 260 m, z from
    // 40 to -300), growing to 14 m at the skyline: the relief is metres deep and needs them.
    for (let x = -900; x <= 900;) { xs.push(x); x += Math.abs(x) < 260 ? 1.0 : clamp((Math.abs(x) - 260) * 0.03 + 1.0, 1.0, 14); }
    for (let z = 60; z >= -1100;) { zs.push(z); z -= z > -300 ? 1.0 : clamp((-300 - z) * 0.03 + 1.0, 1.0, 14); }
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j];
      const k = j * nx + i;
      pos[k * 3] = x; pos[k * 3 + 1] = groundHeight(x, z); pos[k * 3 + 2] = z;
      uv[k * 2] = x; uv[k * 2 + 1] = z;
    }
    // Rows run from +z toward -z, so the winding that faces up is (a, a+1, b).
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + nx;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    assertOutward(geo, 'terrain', (n) => n.y > 0);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // Above the water only: under it the sand floor stands in for the land.
    setLayers(this.mesh, LAYER.ABOVE);
    this.counts = { nx, nz };
  }

  dispose() { this.geometry.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The rock material: a blank canvas for now. Flat grey under the scene's lights, with the only
// extra being the hooks the rest of the scene expects (a tint for loose blocks, a place to hang
// the photographs when they come). Relief and texture are added from here, step by step.
// ---------------------------------------------------------------------------------------------

// The owner's reference photographs, each drawn at the size in metres it seems to cover.
const PHOTOS = [
// Sizes are the width each photo covers in the world, in metres (its height follows its aspect).
  { key: 'wall', file: 'wall.jpg', size: 50 },        // orange bedded sandstone with lichen: 50 m across
  { key: 'wall2', file: 'wall2.jpg', size: 45 },     // a tall cliff with joints and talus (portrait): 45 m wide, 100 m tall
  { key: 'wall3', file: 'wall3.jpg', size: 70 },     // a dark red wall with vertical seams: 70 m wide, 90 m tall
  { key: 'streaks', file: 'streaks.jpg', size: 55 }, // desert-varnish drips: 55 m wide, 60 m tall
  { key: 'reference', file: 'reference.jpg', size: 0 }, // the reference image, projected from the viewpoint
];

/** Load whatever photographs are present in html/assets (each optional). */
export function loadPhotos(onLoaded) {
  const loader = new THREE.TextureLoader();
  const base = new URL('../assets/', import.meta.url).href;
  const out = {};
  for (const p of PHOTOS) {
    const tryExt = (exts) => {
      if (!exts.length) return;
      const file = p.file.replace(/.jpg$/, exts[0]);
      loader.load(base + file, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        out[p.key] = tex;
        onLoaded(p.key, tex);
      }, undefined, () => tryExt(exts.slice(1)));
    };
    tryExt(['.webp', '.png', '.jpg', '.jpeg']);
  }
  return out;
}

// The relief, read off the owner's photograph of the wall ("trial 2"): a height function of
// world position, differentiated on screen into a bumped normal, with each scale fading before
// it would alias. Three layers, each with a live switch (window.RELIEF) so one can be judged alone:
//   plates: broad slabs of rock, taller than wide, each a little proud of or recessed from its
//     neighbours, edges eased over a few metres, with a shallow groove along some of the
//     near-vertical joints between them;
//   bedding: horizontal bands a few metres thick with a small step at some bands' bases, each
//     band's face leaning back a touch, dipping gently along the wall, with fine laminae in sets;
//   swell: undulation so no plate is a true plane.
export const RELIEF = { plates: { value: 1 }, bedding: { value: 1 }, swell: { value: 1 }, fine: { value: 1 }, grain: { value: 1 }, photo: { value: 1 }, drips: { value: 1 } };
if (typeof window !== 'undefined') window.RELIEF = RELIEF;

const RELIEF_GLSL = `
  uniform float uPlates, uBedding, uSwell, uFine, uGrain;
  // The wall frame: along-wall coordinate u and how much of a face (as against a top) this is.
  void wallFrame(vec3 P, vec3 n, out float u, out float face) {
    vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
    u = P.z * w.x + P.x * w.z + (P.x + P.z) * 0.7 * w.y;
    face = 1.0 - w.y * 0.85;
  }
  // Which plate a point is on (cell id and the distance to the plate's edge, metres).
  void plateAt(float u, float y, out vec2 cell, out float edgeDist) {
    float ju = u + (fbm3(vec2(u, y) * 0.02 + 5.0) - 0.5) * 5.0;
    float jy = y + (fbm3(vec2(u, y) * 0.015 + 17.0) - 0.5) * 7.0;
    float cw = 26.0, ch = 44.0;
    cell = vec2(floor(ju / cw), floor(jy / ch));
    vec2 f = vec2(fract(ju / cw), fract(jy / ch));
    edgeDist = min(min(f.x, 1.0 - f.x) * cw, min(f.y, 1.0 - f.y) * ch);
  }
  float rockHeight(vec3 P, vec3 n, float px) {
    // Along-wall coordinate: faces toward x use z, faces toward z use x; tops use a diagonal.
    vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
    float u = P.z * w.x + P.x * w.z + (P.x + P.z) * 0.7 * w.y;
    float y = P.y;
    // Bedding and joints belong to the faces; on the tops they would draw contour lines.
    float face = 1.0 - w.y * 0.85;
    float h = 0.0;
    if (uPlates > 0.5) {
      float ju = u + (fbm3(vec2(u, y) * 0.02 + 5.0) - 0.5) * 5.0;
      float jy = y + (fbm3(vec2(u, y) * 0.015 + 17.0) - 0.5) * 7.0;
      float cw = 26.0, ch = 44.0;
      vec2 cell = vec2(floor(ju / cw), floor(jy / ch));
      vec2 f = vec2(fract(ju / cw), fract(jy / ch));
      float depth = (hash21(cell) - 0.5) * 1.4;
      float eu = min(f.x, 1.0 - f.x) * cw, ey = min(f.y, 1.0 - f.y) * ch;
      float edge = smoothstep(0.0, 3.0, min(eu, ey));
      h += depth * edge * face * smoothstep(80.0, 10.0, px);
      float seam = step(0.55, hash21(vec2(floor(ju / cw + 0.5), cell.y) + 3.0));
      h -= 0.3 * seam * (1.0 - smoothstep(0.0, 1.4, eu)) * face * smoothstep(20.0, 3.0, px);
    }
    if (uBedding > 0.5) {
      float sy = y + 0.03 * u + (fbm3(vec2(u * 0.01, 3.0)) - 0.5) * 3.0;
      float bandH = 4.5;
      float band = floor(sy / bandH);
      float fb = fract(sy / bandH);
      float r = hash11(band);
      float step1 = r < 0.4 ? 0.0 : (r - 0.7) * 0.5;
      h += step1 * smoothstep(0.0, 0.1, fb) * face * smoothstep(10.0, 1.5, px);
      h -= fb * 0.05 * face * smoothstep(10.0, 1.5, px);
      if (uFine > 0.5) {
        float lamSet = smoothstep(0.45, 0.6, fbm3(vec2(u * 0.08, sy * 0.3) + 9.0));
        h += sin(sy * 6.2831853 / 0.12) * 0.005 * lamSet * face * smoothstep(0.12, 0.02, px);
      }
    }
    if (uSwell > 0.5) {
      h += (fbm3(vec2(u, y) * 0.05 + 2.0) - 0.5) * 0.9 * smoothstep(60.0, 8.0, px);
      h += (fbm3(vec2(u, y) * 0.2) - 0.5) * 0.2 * smoothstep(12.0, 2.0, px);
    }
    // Sand grain: pits and grains at a few centimetres, and the grain of the sand itself below
    // that, on every surface (tops too), each fading out before it could alias.
    if (uGrain > 0.5) {
      vec2 q = vec2(u, y);
      h += (vnoise(q * 2.5 + 3.0) - 0.5) * 0.014 * smoothstep(0.7, 0.12, px);
      h += (vnoise(q * 12.0) - 0.5) * 0.005 * smoothstep(0.14, 0.02, px);
      h += (vnoise(q * 60.0 + 7.0) - 0.5) * 0.0009 * smoothstep(0.03, 0.004, px);
    }
    return h;
  }
`;

const PHOTO_GLSL = `
  uniform sampler2D uWall, uWall2, uWall3, uStreaks, uRef, uRefMask;
  uniform vec4 uBeam; uniform vec3 uBeamDir; uniform float uBeamReach; uniform vec4 uLamp; uniform mat4 uCraftMat; uniform vec2 uLampRing; uniform float uLampEye;
  uniform float uHasRef; uniform mat4 uRefMatrix;
  uniform float uHasWall, uHasWall2, uHasWall3, uHasStreaks, uWallSize, uWall2Size, uWall3Size, uStreaksSize, uPhoto, uDrips, uTint;
  // One photo, tiled in metres, offset per plate so no two slabs show the same patch.
  vec3 wallPhoto(sampler2D t, float size, float aspect, vec2 uv, vec2 cell, float anchored) {
    vec2 o = hash22(cell + 11.0) * 4.0;
    o.y *= 1.0 - anchored;
    vec3 a = texture2D(t, vec2(uv.x / size + o.x, uv.y / (size * aspect) + o.y)).rgb;
    vec3 b = texture2D(t, vec2(uv.x / (size * 1.6) + o.y + 2.3, uv.y / (size * 1.6 * aspect) + o.x * (1.0 - anchored))).rgb;
    float m = smoothstep(0.3, 0.7, fbm3(uv * 0.02 + 31.0));
    return mix(a, b, m);
  }
  // The plate's photo at one projection (uv in metres along the face and up it).
  vec3 platePhoto(vec2 uv, vec2 cell, float edgeDist) {
    float pick = hash21(cell + 5.0);
    vec3 c1 = uHasWall > 0.5 ? wallPhoto(uWall, uWallSize, 0.7, uv, cell, 0.0) : vec3(0.55);
    vec3 c2 = uHasWall2 > 0.5 ? wallPhoto(uWall2, uWall2Size, 2.2, uv, cell, 1.0) : c1;
    vec3 c3 = uHasWall3 > 0.5 ? wallPhoto(uWall3, uWall3Size, 1.28, uv, cell, 1.0) : c1;
    vec3 col = pick < 0.45 ? c1 : (pick < 0.75 ? c2 : c3);
    // Blend back to the base photo along the plate edges so the joints are not hard colour seams.
    return mix(c1, col, smoothstep(0.0, 5.0, edgeDist));
  }
  // How much a picture pixel is sky rather than rock: bright and cool (aurora, starlit haze).
  float skyOf(vec3 c) { return smoothstep(0.02, 0.08, max(c.g, c.b) - c.r) * smoothstep(0.12, 0.2, max(c.g, c.b)); }
  vec3 rockColor(vec3 P, vec3 n, float px) {
    float u, face; wallFrame(P, n, u, face);
    vec2 cell; float edgeDist; plateAt(u, P.y, cell, edgeDist);
    // The fill: one photo, the bedded wall, projected triplanar at one large scale.
    vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
    vec2 cellNone = vec2(0.0);
    vec3 fx = uHasWall > 0.5 ? wallPhoto(uWall, uWallSize, 0.7, vec2(P.z, P.y), cellNone, 0.0) : vec3(0.55);
    vec3 fz = uHasWall > 0.5 ? wallPhoto(uWall, uWallSize, 0.7, vec2(P.x, P.y), cellNone, 0.0) : vec3(0.55);
    vec3 fy = uHasWall > 0.5 ? wallPhoto(uWall, uWallSize, 0.7, vec2(P.x + P.z * 0.3, P.z - P.x * 0.3), cellNone, 0.0) : vec3(0.55);
    vec3 col = fx * w.x + fz * w.z + fy * w.y;
    // The reference, projected from where the viewer stands: wherever its pixel is rock (warm,
    // not sky or water) it paints the rock as the photograph has it.
    if (uHasRef > 0.5) {
      vec4 rp = uRefMatrix * vec4(P, 1.0);
      if (rp.w > 0.0) {
        vec2 ruv = rp.xy / rp.w * 0.5 + 0.5;
        if (ruv.y > 0.0) {
          // Past the picture's edges it goes on mirrored, frame after frame, so land beyond the
          // frame wears the same rock rather than the fill.
          ruv.x = abs(mod(ruv.x + 1.0, 2.0) - 1.0);
          ruv.y = abs(mod(ruv.y + 1.0, 2.0) - 1.0);
          // The picture's own craft (body and lamp beams) is painted over with the shaded wall
          // to its left, so the scene's craft is the only one.
          // The body takes the far wall to its left; the lamp beam, a thin strip reaching out
          // both sides, takes the wall just below it on the left and the abutment on the right.
          vec2 cd = ruv - vec2(0.675, 0.545);
          float body = smoothstep(0.0, 0.08, 1.0 - length(cd / vec2(0.095, 0.11)));
          float beam = smoothstep(0.035, 0.015, abs(ruv.y - 0.543)) * smoothstep(0.50, 0.53, ruv.x) * smoothstep(0.90, 0.87, ruv.x);
          vec2 beamSrc = ruv.x < 0.675 ? ruv + vec2(0.0, -0.06) : ruv + vec2(0.12, 0.0);
          vec3 rc = texture2D(uRef, ruv).rgb;
          float sky = texture2D(uRefMask, ruv).r;
          // A silhouette a few pixels off would wear a rim of sky: step off it into the rock,
          // down from a skyline, up from the underside.
          if (sky > 0.05) {
            vec2 rd = ruv - vec2(0.0, 0.011), ru = ruv + vec2(0.0, 0.011);
            float sd = texture2D(uRefMask, rd).r, su = texture2D(uRefMask, ru).r;
            if (sd < sky) { rc = texture2D(uRef, rd).rgb; sky = sd; }
            else if (su < sky) { rc = texture2D(uRef, ru).rgb; sky = su; }
          }
          rc = mix(rc, texture2D(uRef, beamSrc).rgb, beam);
          rc = mix(rc, texture2D(uRef, ruv - vec2(0.23, 0.0)).rgb, body);
          // With the land shaped to the picture, whatever the picture shows on rock is rock;
          // only sky is kept away, and the craft's red eye.
          float isRock = 1.0 - sky;
          // The picture shows water, not rock, below the waterline.
          isRock *= smoothstep(-1.5, 0.0, P.y);
          isRock *= smoothstep(0.12, 0.2, rc.g / max(rc.r, 1e-3));
          // Fade at the picture's bottom edge so nothing is cut off hard.
          isRock *= smoothstep(0.0, 0.03, ruv.y);
          // The photograph is already lit: where it paints the rock it shows as it is, unlit.
          gRefColor = rc;
          gRefMix = isRock;
          col = mix(col, rc, isRock);
        }
      }
    }
    // Desert varnish drips down the faces, in patches, darkening the rock.
    if (uHasStreaks > 0.5 && uDrips > 0.5) {
      float pale = texture2D(uStreaks, vec2(u / uStreaksSize, P.y / (uStreaksSize * 1.1))).r;
      float dripArea = smoothstep(0.45, 0.7, fbm3(vec2(u * 0.03, P.y * 0.01) + 23.0)) * face;
      col *= mix(1.0, 0.3 + 0.7 * pale, dripArea);
    }
    return col * uTint * 1.15;
  }
`;

export function makeRockMaterial(tint = 1) {
  const g = 0.55 * tint;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(1, 1, 1), roughness: 0.9, metalness: 0 });
  const empty = new THREE.DataTexture(new Uint8Array([140, 140, 140, 255]), 1, 1);
  empty.needsUpdate = true;
  const uniforms = {
    uPlates: RELIEF.plates, uBedding: RELIEF.bedding, uSwell: RELIEF.swell, uFine: RELIEF.fine, uGrain: RELIEF.grain, uPhoto: RELIEF.photo, uDrips: RELIEF.drips,
    uWall: { value: empty }, uWall2: { value: empty }, uWall3: { value: empty }, uStreaks: { value: empty },
    uHasWall: { value: 0 }, uHasWall2: { value: 0 }, uHasWall3: { value: 0 }, uHasStreaks: { value: 0 },
    uWallSize: { value: 50 }, uWall2Size: { value: 45 }, uWall3Size: { value: 70 }, uStreaksSize: { value: 55 }, uTint: { value: tint },
    uRef: { value: empty }, uHasRef: { value: 0 }, uRefMatrix: { value: new THREE.Matrix4() }, uRefMask: { value: refMask() },
    uBeam: { value: new THREE.Vector4(0, 0, 0, 0) }, uBeamDir: { value: new THREE.Vector3(0, 0, -1) }, uBeamReach: { value: 900 },
    uLamp: { value: new THREE.Vector4(0, 0, 0, 0) }, uCraftMat: { value: new THREE.Matrix4() }, uLampRing: { value: new THREE.Vector2(17, 14) }, uLampEye: { value: 0 },
  };
  patchMaterial(mat, {
    key: 'rock-relief-' + tint,
    uniforms,
    vHead: `varying vec3 vWN;`,
    vEnd: `vWN = normalize(mat3(modelMatrix) * gNormal);`,
    fHead: `varying vec3 vWN;\n${NOISE_GLSL}${RELIEF_GLSL}${PHOTO_GLSL}`,
    fColor: `
      {
        vec3 nW = normalize(vWN);
        float px = length(fwidth(vWPos));
        diffuseColor.rgb = uPhoto > 0.5 ? rockColor(vWPos, nW, px) : vec3(${g.toFixed(3)});
        diffuseColor.rgb *= 1.0 - gRefMix * 0.85;
      }`,
    fEmissive: `
      totalEmissiveRadiance += gRefColor * gRefMix * 1.15;
      // The craft's eye beam: the picture fixes how bright the rock is, so a scene light cannot
      // brighten it; the beam is drawn here instead, a red cone from the eye on whatever faces it.
      if (uBeam.w > 0.001) {
        vec3 toP = vWPos - uBeam.xyz;
        float dist = length(toP);
        vec3 dir = toP / dist;
        float cone = smoothstep(0.955, 0.988, dot(dir, uBeamDir));
        float facing = max(dot(normalize(vWN), -dir), 0.0);
        float fall = 1.0 / (1.0 + dist * dist * 0.0003);
        // It stops at the first rock it strikes: nothing beyond that distance is lit, so it
        // cannot seem to shine out of the inside of a mass.
        float reach = 1.0 - smoothstep(uBeamReach * 1.08 + 4.0, uBeamReach * 1.2 + 12.0, dist);
        totalEmissiveRadiance += vec3(1.0, 0.16, 0.08) * cone * (0.25 + 0.75 * facing) * fall * reach * uBeam.w * 0.35;
      }
      // The craft's running lights: sixteen small spots round its waist, each at its place on
      // the ring and shining outward in a tight cone that dies within a few dozen metres, so the
      // underside of the span picks up a row of small discs as it passes beneath; brighter when roused.
      if (uLamp.w > 0.001) {
        mat3 rot = mat3(uCraftMat);
        vec3 nrm = normalize(vWN);
        float glow = 0.0;
        for (int i = 0; i < 16; i++) {
          float a = (float(i) + 0.5) / 16.0 * 6.2831853;
          if (abs(atan(sin(a - uLampEye), cos(a - uLampEye))) < 0.3) continue;
          vec3 lp = (uCraftMat * vec4(cos(a) * uLampRing.x, 0.0, sin(a) * uLampRing.y, 1.0)).xyz;
          vec3 ld = normalize(rot * vec3(cos(a) / uLampRing.x, 0.0, sin(a) / uLampRing.y));
          vec3 toP = vWPos - lp;
          float dist = length(toP);
          vec3 dir = toP / dist;
          // A tight cone: a small disc that never meets its neighbours'.
          float cone = smoothstep(0.985, 0.997, dot(dir, ld));
          float facing = max(dot(nrm, -dir), 0.0);
          glow += cone * (0.2 + 0.8 * facing) / (1.0 + dist * dist * 0.008);
        }
        totalEmissiveRadiance += vec3(1.0, 0.6, 0.22) * glow * uLamp.w * 0.3;
      }`,
    fNormal: `
      {
        vec3 P = vWPos;
        vec3 nW = normalize(vWN);
        float px = length(fwidth(P));
        // The slope of the height along two tangents, by finite differences in world space with
        // a step no smaller than a pixel's footprint: smooth, and free of the 2x2-pixel-quad
        // quantisation that screen-space derivatives carry.
        vec3 t1 = normalize(cross(nW, abs(nW.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 t2 = cross(nW, t1);
        float e = max(0.06, px * 1.5);
        float h0 = rockHeight(P, nW, px);
        float h1 = rockHeight(P + t1 * e, nW, px);
        float h2 = rockHeight(P + t2 * e, nW, px);
        vec3 nB = normalize(nW - t1 * (h1 - h0) / e - t2 * (h2 - h0) / e);
        normal = normalize((viewMatrix * vec4(nB, 0.0)).xyz);
        if (!gl_FrontFacing) normal = -normal;
      }`,
  });
  // Globals carried from the colour stage to the emissive stage.
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => { prevCompile(sh); sh.fragmentShader = sh.fragmentShader.replace('varying vec3 vONormal;', 'varying vec3 vONormal;\nvec3 gRefColor = vec3(0.0);\nfloat gRefMix = 0.0;'); };
  mat.userData.uniforms = uniforms;
  mat.userData.setPhoto = (key, tex) => {
    const map = { wall: ['uWall', 'uHasWall', 'uWallSize'], wall2: ['uWall2', 'uHasWall2', 'uWall2Size'], wall3: ['uWall3', 'uHasWall3', 'uWall3Size'], streaks: ['uStreaks', 'uHasStreaks', 'uStreaksSize'], reference: ['uRef', 'uHasRef', 'uWallSize'] }[key];
    if (key === 'reference') { tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; }
    if (!map) return;
    uniforms[map[0]].value = tex;
    uniforms[map[1]].value = 1;
  };
  return mat;
}
