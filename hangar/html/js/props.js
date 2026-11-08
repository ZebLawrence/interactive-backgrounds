// Hangar — Props: the seeded dressing (scatter.js plans it) as meshes.
//
// Dressing(level, plan, materials, opts) builds, for one seed:
//   - the scanned models (Poly Haven, CC0) as they arrive (setModel): each model's meshes merged per material
//     once for the page (normalised: footprint centred on the origin, base at y = 0, front +z), then one
//     InstancedMesh per material and sector, so every prop of a kind in a room is one draw and wears its
//     room's probe. The glTF geometry and materials are the page's (userData.shared), never disposed here.
//   - the props built here from primitives and the scanned materials (Ruling R14): a cable reel (rubber cable
//     wound on rusty flanges), scrap (diamond-plate and hazard offcuts and a rusty pipe end), wall junction boxes
//     with conduit up to the ceiling; instanced the same way.
//   - pipe runs along the walls (Ruling R15: real geometry with flanges, brackets, clamps and elbows into the
//     wall), merged per sector and material.
//   - a contact shade under every prop (a soft rounded ellipse at 1.3 x its footprint, darkest at the prop) and
//     behind every wall-mounted box, multiplied into what is behind it; and lit wall decals: grime at the foot of
//     the walls, shade in the room corners and leak streaks (rust, or water with a wet sheen) down the walls.
//     All are drawn analytically per pixel (outlines antialiased with fwidth), so they are sharp at any distance
//     and no texel density applies.
// `materials` is the scene's PropMaterials (greybox until the scanned sets arrive). dispose() frees what this
// seed made; the page keeps the prepared models for the next seed.

import * as THREE from 'three';
import { boxGeo } from './doors.js';
import { edit } from './materials.js';

const SHADE_SCALE = 1.3;
const SHADE_STRENGTH = 0.72;
// Mounted boxes: their height, for the shade behind them on the wall.
const MOUNT_H = { 'junction-box': 0.26, 'power-box': 0.5 };

// Parts of a model file to keep (by triangle centroid in the model's own space): the power box scan has an open
// door that would stick out 35 cm from the wall.
const KEEP = {
  'power-box': (x, y, z) => z < 0.06,
};

// Small props cast no shadow from the lamps (their contact shade seats them); each shadow-casting lamp draws its
// casters six times.
const NO_CAST = new Set(['power-box', 'junction-box', 'scrap']);

// Page-owned prepared models: name -> { parts: [{ geometry, material }], size: Vector3 } (kept across reseeds).
const prepared = new Map();

/** The model's meshes in its own space, filtered by KEEP, merged per material, footprint-centred, base at 0. */
function prepare(name, root) {
  if (prepared.has(name)) return prepared.get(name);
  root.updateMatrixWorld(true);
  const byMat = new Map();
  const keep = KEEP[name];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    // Dequantise (meshopt stores normalised integers) into plain float position / normal / uv, triangle soup.
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) {
      const a = src.attributes[k];
      if (!a) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
      g.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
    }
    if (src !== o.geometry) src.dispose();
    g.applyMatrix4(o.matrixWorld);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    let geo = g;
    if (keep) {
      const p = g.attributes.position.array, tris = [];
      for (let t = 0; t < p.length; t += 9) {
        if (keep((p[t] + p[t + 3] + p[t + 6]) / 3, (p[t + 1] + p[t + 4] + p[t + 7]) / 3, (p[t + 2] + p[t + 5] + p[t + 8]) / 3)) tris.push(t / 9);
      }
      geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) {
        const a = g.attributes[k], n = a.itemSize * 3, out = new Float32Array(tris.length * n);
        tris.forEach((t, i) => out.set(a.array.subarray(t * n, t * n + n), i * n));
        geo.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
      }
      g.dispose();
    }
    if (!geo.attributes.position.count) { geo.dispose(); return; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const mat = mats[0];
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  });
  const box = new THREE.Box3();
  for (const list of byMat.values()) for (const g of list) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const c = box.getCenter(new THREE.Vector3());
  const parts = [];
  for (const [material, list] of byMat) {
    const geometry = list.length === 1 ? list[0] : mergeSoup(list);
    geometry.translate(-c.x, -box.min.y, -c.z);
    geometry.computeBoundingSphere();
    geometry.userData.shared = true; // the page's: Scene.dispose leaves it
    material.userData.shared = true;
    // The little gauge and lamp glasses come as KHR_materials_transmission: three renders a whole transmission
    // pass for that, every frame, into a target per camera that is never freed (each reseed's and each probe's
    // camera leaked one). A few square centimetres of glass do not need it.
    // Closed solids: glTF marks them double-sided, which doubles their shadow and fragment cost for nothing.
    material.side = THREE.FrontSide;
    if (material.transmission > 0) { material.transmission = 0; material.transparent = true; material.opacity = 0.35; material.depthWrite = false; }
    parts.push({ geometry, material });
  }
  const out = { parts, size: box.getSize(new THREE.Vector3()) };
  prepared.set(name, out);
  return out;
}

/** Concatenates non-indexed geometries with position / normal / uv. */
function mergeSoup(list) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv']) {
    const size = list[0].attributes[k].itemSize;
    const out = new Float32Array(list.reduce((a, q) => a + q.attributes[k].count * size, 0));
    let o = 0;
    for (const q of list) { out.set(q.attributes[k].array, o); o += q.attributes[k].array.length; }
    g.setAttribute(k, new THREE.BufferAttribute(out, size));
  }
  for (const q of list) q.dispose();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers. Scanned materials expect UVs in metres / 2 (Ruling R3).

/** Scale a geometry's uv by (su, sv). */
function uvScale(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** A cylinder of radius r from a to b (Vector3s), metric UVs, open or capped. */
function tube(r, a, b, open = true, seg = 16) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const g = uvScale(new THREE.CylinderGeometry(r, r, L, seg, 1, open), (2 * Math.PI * r) / 2, L / 2);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Non-indexed position / normal / uv only, so geometries of every kind merge. */
function soup(g) {
  const s = g.index ? g.toNonIndexed() : g;
  if (s !== g) g.dispose();
  for (const k of Object.keys(s.attributes)) if (!['position', 'normal', 'uv'].includes(k)) s.deleteAttribute(k);
  return s;
}

const merge = (list) => mergeSoup(list.map(soup));

// ---------------------------------------------------------------------------------------------
// The props built here, each as { tag -> geometry } in its own space (front +z, base y = 0, footprint-centred).

function cableReel() {
  const R = 0.36, T = 0.03, HALF = 0.23; // flange radius and thickness; half the depth
  const flanges = [];
  for (const s of [-1, 1]) {
    const g = uvScale(new THREE.CylinderGeometry(R, R, T, 40, 1, false), Math.PI * R, T / 2);
    g.rotateX(Math.PI / 2);
    g.translate(0, R, s * (HALF - T / 2));
    flanges.push(g);
    // Bolt heads round the hub.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const b = boxGeo(0.025, 0.025, 0.012);
      b.translate(Math.cos(a) * 0.17, R + Math.sin(a) * 0.17, s * (HALF + 0.006));
      flanges.push(b);
    }
  }
  const hub = uvScale(new THREE.CylinderGeometry(0.05, 0.05, 2 * HALF + 0.04, 16, 1, false), 0.16, HALF);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, R, 0);
  flanges.push(hub);
  // The cable: rows of turns across the drum, three layers deep, the top layer part-wound.
  const cable = [];
  const tr = 0.02, rows = Math.floor((2 * (HALF - T)) / (2 * tr));
  for (let layer = 0; layer < 4; layer++) {
    const rr = 0.2 + layer * 2 * tr * 0.92;
    const n = layer === 3 ? Math.floor(rows * 0.55) : rows;
    for (let k = 0; k < n; k++) {
      const g = uvScale(new THREE.TorusGeometry(rr, tr, 6, 28), (2 * Math.PI * rr) / 2, (2 * Math.PI * tr) / 2);
      g.translate(0, R, -(HALF - T) + tr + k * 2 * tr + (layer % 2) * tr * 0.5);
      cable.push(g);
    }
  }
  return { 'mat:rust': merge(flanges), 'mat:rubber': merge(cable) };
}

function scrap() {
  // Within 0.62 x 0.5, back at z = -0.25.
  // A plate leaning back against the wall: its bottom edge on the floor, its top edge on the footprint's back
  // line (the item stands FLUSH_GAP off the wall, so the plate touches it).
  const plate = boxGeo(0.5, 0.38, 0.006);
  plate.rotateX(-0.32);
  plate.computeBoundingBox();
  plate.translate(-0.02, -plate.boundingBox.min.y, -0.25 - plate.boundingBox.min.z);
  const flat = boxGeo(0.34, 0.006, 0.22);
  flat.rotateY(0.35);
  flat.translate(0.1, 0.003, 0.08);
  const hazard = boxGeo(0.26, 0.005, 0.12);
  hazard.rotateY(-0.5);
  hazard.translate(-0.16, 0.0085, 0.12);
  const pipe = tube(0.04, new THREE.Vector3(-0.22, 0.04, 0.0), new THREE.Vector3(0.24, 0.04, -0.1), false);
  const stub = tube(0.025, new THREE.Vector3(0.18, 0.025, 0.2), new THREE.Vector3(0.28, 0.025, 0.05), false);
  return { 'mat:diamond-plate': merge([plate, flat]), 'mat:hazard': merge([hazard]), 'mat:rust': merge([pipe, stub]) };
}

function junctionBox() {
  // 0.34 x 0.26, 0.12 deep on its plate (0.14 in all), back at z = -0.07, base at y = 0.
  const plate = boxGeo(0.34, 0.26, 0.02);
  plate.translate(0, 0.13, -0.06);
  const box = boxGeo(0.3, 0.22, 0.1);
  box.translate(0, 0.13, 0.0);
  const band = boxGeo(0.3, 0.035, 0.004);
  band.translate(0, 0.2, 0.052);
  const gland = tube(0.022, new THREE.Vector3(0.09, 0.24, -0.01), new THREE.Vector3(0.09, 0.27, -0.01), false);
  return { 'mat:steel-brushed': merge([plate, gland]), 'mat:steel': merge([box]), 'mat:hazard': merge([band]) };
}

const BUILT = { 'cable-reel': cableReel, scrap, 'junction-box': junctionBox };

// ---------------------------------------------------------------------------------------------
// Decals: contact shade under props (instanced quads) and grime / corner / leak decals on walls (one merged mesh).

const MULTIPLY = {
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendEquation: THREE.AddEquation,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false,
};

const SHADE_VERT = /* glsl */ `
varying vec2 vQ;
void main() {
  vQ = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;
// A rounded ellipse (superellipse, exponent 4) so a box's corners are inside it: the footprint's edge sits at
// 1 / SHADE_SCALE; darkest there and in, fading to nothing at the quad's edge.
const SHADE_FRAG = /* glsl */ `
varying vec2 vQ;
uniform float strength;
void main() {
  vec2 q = abs( vQ );
  float r = pow( pow( q.x, 4.0 ) + pow( q.y, 4.0 ), 0.25 );
  float a = 1.0 - smoothstep( 0.68, 1.0, r );
  a *= 2.0 - a; // full strength up to the footprint, then an eased fall to nothing at the quad's edge
  gl_FragColor = vec4( vec3( 1.0 - strength * a ), 1.0 );
}
`;

// Wall decals are lit: a physical surface of their own (colour, roughness) blended over the wall by an analytic
// coverage, so a rust streak shows its colour and a water streak its sheen even on the dark panels, where a
// darkening alone would vanish. kind 0 grime at a wall's foot (ragged top edge), 1 corner shade (dark toward
// the corner edge), 2 leak (a stain at the top and drips running down; rust, or water with a wet sheen).
// Every outline is antialiased with fwidth.
const DECAL_PARS_V = /* glsl */ `
attribute vec2 duv;
attribute vec4 dmeta;
attribute vec2 dsize;
varying vec2 vDecalM;
varying vec4 vDecalMeta;
varying vec2 vDecalSize;
`;
const DECAL_PARS_F = /* glsl */ `
varying vec2 vDecalM;
varying vec4 vDecalMeta;
varying vec2 vDecalSize;
float decalRough;
float dH( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }
float dN( float x ) { float i = floor( x ), f = fract( x ); return mix( dH( i ), dH( i + 1.0 ), f * f * ( 3.0 - 2.0 * f ) ); }
float dFbm( float x ) { return 0.5 * dN( x ) + 0.3 * dN( x * 2.13 + 7.1 ) + 0.2 * dN( x * 4.71 + 3.3 ); }
float dCover( float d ) { float aa = max( fwidth( d ), 1e-5 ); return smoothstep( - 0.5 * aa, 0.5 * aa, d ); }
`;
const DECAL_MAIN = /* glsl */ `
  {
    float kind = vDecalMeta.x, s = vDecalMeta.z;
    vec2 m = vDecalM, S = vDecalSize;
    float a = 0.0;
    vec3 tint = vec3( 0.03, 0.025, 0.02 );
    decalRough = 0.95;
    if ( kind < 0.5 ) {
      float top = S.y * ( 0.4 + 0.55 * dFbm( m.x * 1.9 + s ) );
      float body = dCover( top - m.y ) * ( 0.35 + 0.65 * ( 1.0 - m.y / max( top, 1e-3 ) ) );
      float tide = dCover( top - m.y ) * ( 1.0 - dCover( top - 0.012 - m.y ) ) * 0.3; // a thin tide line at the edge
      float ends = smoothstep( 0.0, 0.35, m.x ) * smoothstep( 0.0, 0.35, S.x - m.x );
      a = min( 1.0, body + tide ) * ends;
    } else if ( kind < 1.5 ) {
      float dx = vDecalMeta.w > 0.0 ? S.x - m.x : m.x;
      float reach = S.x * ( 0.7 + 0.3 * dFbm( m.y * 2.3 + s ) );
      float fall = 1.0 - smoothstep( 0.0, reach, dx );
      float up = 1.0 - smoothstep( S.y * 0.45, S.y, m.y );
      a = fall * fall * ( 0.55 + 0.45 * up );
      tint = vec3( 0.012, 0.011, 0.01 );
    } else {
      float H = S.y, down = H - m.y; // metres below the top
      float stain = dCover( 0.06 + 0.12 * dFbm( m.x * 6.0 + s ) - down ) * smoothstep( 0.0, 0.08, m.x ) * smoothstep( 0.0, 0.08, S.x - m.x );
      float drips = 0.0;
      for ( int i = 0; i < 4; i ++ ) {
        float fi = float( i ) + s;
        float cx = S.x * ( 0.15 + 0.7 * dH( fi * 1.7 ) );
        float L = H * ( 0.35 + 0.65 * dH( fi * 3.1 ) );
        float w = 0.008 + 0.022 * dH( fi * 5.3 );
        float t = clamp( down / L, 0.0, 1.0 );
        float wob = 0.012 * sin( m.y * 9.0 + fi ) + 0.006 * sin( m.y * 23.0 + 2.0 * fi );
        float edge = w * ( 1.0 - 0.6 * t ) - abs( m.x - cx - wob );
        drips = max( drips, dCover( edge ) * dCover( L - down ) * ( 1.0 - 0.6 * t ) );
      }
      float wash = 0.35 * ( 1.0 - smoothstep( 0.0, S.x * 0.5, abs( m.x - S.x * 0.5 ) ) ) * ( 1.0 - smoothstep( 0.0, H, down ) );
      a = max( max( stain * 0.85, drips ), wash );
      bool rust = dH( s * 0.37 ) < 0.6;
      tint = rust ? vec3( 0.2, 0.075, 0.025 ) : vec3( 0.02, 0.02, 0.02 );
      decalRough = rust ? 0.85 : 0.18;
    }
    diffuseColor = vec4( tint, clamp( a * vDecalMeta.y, 0.0, 1.0 ) );
  }
`;

const KIND = { grime: 0, corner: 1, leak: 2 };
const PAINTS = [0x8a7a2a, 0x3f5a46, 0x6d7276]; // ochre, pipe green, grey

// ---------------------------------------------------------------------------------------------

export class Dressing {
  /**
   * plan: { placements (scatter.scatterProps), pipes (planPipes), decals (planDecals) }; `materials` a
   * PropMaterials; opts.sunlit: Set of sectors the sun reaches (the scene refreshes the sun's shadow map when
   * `sunChanged` is set).
   */
  constructor(level, plan, materials, opts = {}) {
    this.level = level;
    this.plan = plan;
    this.mats = materials;
    this.group = new THREE.Group();
    this.group.name = 'dressing';
    this.owned = []; // geometries and materials this seed made
    this.models = new Map(); // name -> group of its instanced meshes
    const sunlit = opts.sunlit ?? new Set();
    this.sunlit = sunlit;
    this.sunChanged = plan.placements.some((p) => sunlit.has(p.sector)) || plan.pipes.some((r) => sunlit.has(r.sector));
    this.buildBuilt();
    this.buildPipes();
    this.buildShades();
    this.buildDecals();
  }

  own(x) { this.owned.push(x); return x; }

  /**
   * Instance matrices for placements: base at y, turned by yaw (+ spin for round ones), scaled. `depth` is the
   * model's own depth (front to back): an item backed onto a wall (it has a `gap`) slides back by however much
   * shallower than its footprint the model is, so its back, not its centre, keeps the planned gap.
   */
  matrices(list, depth = null) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    return list.map((pl) => {
      e.set(0, pl.yaw + (pl.spin ?? 0), 0);
      q.setFromEuler(e);
      s.setScalar(pl.scale);
      const back = depth !== null && pl.gap !== undefined ? (pl.d - depth * pl.scale) / 2 : 0;
      p.set(pl.x - Math.sin(pl.yaw) * back, pl.y, pl.z - Math.cos(pl.yaw) * back);
      return m.compose(p, q, s).clone();
    });
  }

  /** One InstancedMesh per sector for `parts` ([{ geometry, material | tag }]) over `list` placements. */
  instance(name, parts, list, group, depth = null) {
    const bySector = new Map();
    for (const p of list) (bySector.get(p.sector) ?? bySector.set(p.sector, []).get(p.sector)).push(p);
    for (const [sector, ps] of bySector) {
      const ms = this.matrices(ps, depth);
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, null, ps.length);
        im.material = part.tag ? this.mats.get(part.tag, im) : part.material;
        ms.forEach((mx, i) => im.setMatrixAt(i, mx));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = !NO_CAST.has(name);
        im.receiveShadow = true;
        im.userData.sector = sector;
        im.name = name;
        group.add(im);
      }
    }
  }

  buildBuilt() {
    for (const [name, make] of Object.entries(BUILT)) {
      const list = this.plan.placements.filter((p) => p.name === name);
      if (!list.length) continue;
      const parts = Object.entries(make()).map(([tag, geometry]) => ({ tag, geometry: this.own(geometry) }));
      for (const p of parts) p.geometry.computeBoundingSphere();
      const g = new THREE.Group();
      g.name = name;
      this.instance(name, parts, list, g);
      this.group.add(g);
    }
    // Conduit from each junction box up to the ceiling, clipped to the wall every 0.8 m. Where a pipe run passes
    // above the box on the same wall, the conduit stops under the lowest pipe and turns into the wall.
    const boxes = this.plan.placements.filter((p) => p.name === 'junction-box');
    const bySector = new Map();
    const CR = 0.016, COFF = 0.035; // conduit radius; its centre this far out from the wall
    for (const p of boxes) {
      const s = this.level.byId.get(p.sector);
      const bx = Math.sin(p.yaw), bz = Math.cos(p.yaw), ax = Math.cos(p.yaw), az = -Math.sin(p.yaw);
      const wall = -p.d / 2 - (p.gap ?? 0); // the wall plane, in the box's depth axis
      const at = (u, v, y) => new THREE.Vector3(p.x + ax * u + bx * v, y, p.z + az * u + bz * v);
      const y0 = p.y + 0.26;
      const c0 = at(0.09, wall, 0);
      let y1 = s.ceil, elbow = false;
      for (const r of this.plan.pipes) {
        if (r.sector !== p.sector) continue;
        // Same wall: the run's wall line passes through the conduit's foot, and the conduit lies within its span.
        const wx = r.a[0] - r.n[0] * r.off, wz = r.a[1] - r.n[1] * r.off;
        const L = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), ux = (r.b[0] - r.a[0]) / L, uz = (r.b[1] - r.a[1]) / L;
        const dx = c0.x - wx, dz = c0.z - wz, t = dx * ux + dz * uz;
        if (Math.abs(dx * r.n[0] + dz * r.n[1]) > 0.02 || t < -0.25 || t > L + 0.25) continue;
        const under = r.y - (r.count - 1) * r.pitch - r.r - 0.06;
        if (under > y0 + 0.1 && under < y1) { y1 = under; elbow = true; }
      }
      const list = bySector.get(p.sector) ?? bySector.set(p.sector, { conduit: [], clips: [] }).get(p.sector);
      const off = wall + COFF;
      list.conduit.push(tube(CR, at(0.09, off, y0), at(0.09, off, y1), false, 10));
      if (elbow) {
        list.conduit.push(uvScale(new THREE.SphereGeometry(CR * 1.05, 10, 6), 0.05, 0.05).translate(...at(0.09, off, y1).toArray()));
        list.conduit.push(tube(CR, at(0.09, off, y1), at(0.09, wall - 0.01, y1), false, 10));
      }
      // Clips: a saddle from the wall face out over the conduit.
      for (let y = y0 + 0.3; y < y1 - 0.1; y += 0.8) {
        const depth = COFF + CR + 0.006;
        const c = boxGeo(0.05, 0.03, depth);
        c.rotateY(p.yaw);
        const q = at(0.09, wall + depth / 2, y);
        c.translate(q.x, q.y, q.z);
        list.clips.push(c);
      }
    }
    for (const [sector, { conduit, clips }] of bySector) {
      const add = (geos, tag) => {
        if (!geos.length) return;
        const m = new THREE.Mesh(this.own(merge(geos)), null);
        m.material = this.mats.get(tag, m);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.sector = sector;
        m.name = 'conduit';
        this.group.add(m);
      };
      add(conduit, 'mat:steel-brushed');
      add(clips, 'mat:steel');
    }
  }

  buildPipes() {
    const groups = new Map(); // `${sector}|${mat}` -> geometries
    const push = (sector, mat, g) => (groups.get(`${sector}|${mat}`) ?? groups.set(`${sector}|${mat}`, []).get(`${sector}|${mat}`)).push(g);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (const r of this.plan.pipes) {
      const mat = r.mat === 'paint' ? `paint${Math.abs(Math.round(r.y * 100 + r.a[0] * 10)) % PAINTS.length}` : r.mat;
      const [ax, az] = r.a, [bx, bz] = r.b, [nx, nz] = r.n;
      const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let k = 0; k < r.count; k++) {
        const y = r.y - k * r.pitch;
        push(r.sector, mat, tube(r.r, V(ax, y, az), V(bx, y, bz)));
        // Elbows into the wall at both ends: a ball joint and a stub through the stand-off.
        for (const [ex, ez] of [[ax, az], [bx, bz]]) {
          push(r.sector, mat, uvScale(new THREE.SphereGeometry(r.r * 1.04, 16, 8).translate(ex, y, ez), r.r * 3, r.r * 3));
          push(r.sector, mat, tube(r.r, V(ex, y, ez), V(ex - nx * (r.off + 0.02), y, ez - nz * (r.off + 0.02))));
          push(r.sector, mat, tube(r.r * 1.5, V(ex - nx * (r.off - 0.012), y, ez - nz * (r.off - 0.012)), V(ex - nx * r.off, y, ez - nz * r.off), false)); // wall flange
        }
        // Flanged joints every 3 m or so.
        const joints = Math.floor(L / 3);
        for (let j = 1; j <= joints; j++) {
          const t = (L * j) / (joints + 1), cx = ax + ux * t, cz = az + uz * t;
          push(r.sector, mat, tube(r.r * 1.35, V(cx - ux * 0.015, y, cz - uz * 0.015), V(cx + ux * 0.015, y, cz + uz * 0.015), false));
        }
      }
      // Brackets: a wall plate behind the stack, an arm and a clamp ring per pipe.
      const yaw = Math.atan2(nx, nz); // local +z into the room, local x along the run
      const span = (r.count - 1) * r.pitch;
      for (const [px, pz] of r.brackets) {
        const wx = px - nx * r.off, wz = pz - nz * r.off; // on the wall
        const plate = boxGeo(0.06, span + 0.08, 0.008);
        plate.rotateY(yaw);
        plate.translate(wx + nx * 0.004, r.y - span / 2, wz + nz * 0.004);
        push(r.sector, 'mat:steel-brushed', plate);
        for (let k = 0; k < r.count; k++) {
          const y = r.y - k * r.pitch;
          const armL = r.off - r.r;
          const arm = boxGeo(0.02, 0.012, armL);
          arm.rotateY(yaw);
          arm.translate(wx + nx * armL / 2, y - r.r * 0.6, wz + nz * armL / 2);
          push(r.sector, 'mat:steel-brushed', arm);
          const ring = uvScale(new THREE.TorusGeometry(r.r + 0.004, 0.005, 6, 20), 0.1, 0.02);
          ring.rotateY(Math.PI / 2); // axis along local x
          ring.rotateY(yaw);
          ring.translate(px, y, pz);
          push(r.sector, 'mat:steel-brushed', ring);
        }
      }
    }
    this.paints = PAINTS.map((c) => this.own(new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.35, name: 'pipe paint' })));
    for (const [key, geos] of groups) {
      const [sector, mat] = key.split('|');
      const m = new THREE.Mesh(this.own(merge(geos)), null);
      m.material = mat.startsWith('paint') ? this.paints[Number(mat.slice(5))] : this.mats.get(mat, m);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.sector = sector;
      m.name = 'pipes';
      this.group.add(m);
    }
  }

  buildShades() {
    this.shadeMat = this.own(new THREE.ShaderMaterial({ name: 'contact shade', vertexShader: SHADE_VERT, fragmentShader: SHADE_FRAG, uniforms: { strength: { value: SHADE_STRENGTH } }, ...MULTIPLY }));
    const floor = this.plan.placements.filter((p) => p.mount === undefined);
    const wall = this.plan.placements.filter((p) => p.mount !== undefined);
    const e = new THREE.Euler(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), m = new THREE.Matrix4();
    if (floor.length) {
      const geo = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
      const im = new THREE.InstancedMesh(geo, this.shadeMat, floor.length);
      floor.forEach((p, i) => {
        e.set(0, p.yaw, 0); q.setFromEuler(e);
        s.set(p.w * SHADE_SCALE, 1, p.d * SHADE_SCALE);
        v.set(p.x, p.y + 0.003, p.z);
        im.setMatrixAt(i, m.compose(v, q, s));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.renderOrder = 2;
      im.name = 'contact shade';
      this.group.add(im);
    }
    if (wall.length) {
      // Behind a wall box: a quad on the wall, a little below centre (light comes from above).
      const geo = this.own(new THREE.PlaneGeometry(1, 1));
      const im = new THREE.InstancedMesh(geo, this.shadeMat, wall.length);
      wall.forEach((p, i) => {
        const h = MOUNT_H[p.name] ?? 0.3;
        e.set(0, p.yaw, 0); q.setFromEuler(e);
        s.set(p.w * SHADE_SCALE + 0.05, h * SHADE_SCALE + 0.05, 1);
        const back = p.d / 2 + (p.gap ?? 0); // on the wall plane itself (the shade's polygon offset lifts it)
        v.set(p.x - Math.sin(p.yaw) * back, p.y + h / 2 - 0.02, p.z - Math.cos(p.yaw) * back);
        im.setMatrixAt(i, m.compose(v, q, s));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.renderOrder = 2;
      im.name = 'wall shade';
      this.group.add(im);
    }
  }

  buildDecals() {
    const bySector = new Map();
    for (const d of this.plan.decals) (bySector.get(d.sector) ?? bySector.set(d.sector, []).get(d.sector)).push(d);
    if (!bySector.size) return;
    const mat = this.own(new THREE.MeshStandardMaterial({
      name: 'wall decals', color: 0xffffff, roughness: 1, metalness: 0, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    mat.onBeforeCompile = (shader) => {
      let vs = shader.vertexShader, fs = shader.fragmentShader;
      vs = edit(vs, 'void main() {', `${DECAL_PARS_V}\nvoid main() {\n\tvDecalM = duv * dsize;\n\tvDecalMeta = dmeta;\n\tvDecalSize = dsize;`, 'the decal vertex shader');
      fs = edit(fs, 'void main() {', `${DECAL_PARS_F}\nvoid main() {`, 'the decal fragment shader');
      fs = edit(fs, '#include <map_fragment>', `#include <map_fragment>\n${DECAL_MAIN}`, 'the decal fragment shader');
      fs = edit(fs, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = decalRough;', 'the decal fragment shader');
      shader.vertexShader = vs;
      shader.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => 'hangar-decals-1';
    for (const [sector, ds] of bySector) {
      const n = ds.length * 6;
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), duv = new Float32Array(n * 2), meta = new Float32Array(n * 4), size = new Float32Array(n * 2);
      let o = 0;
      for (const d of ds) {
        const ux = -d.nz, uz = d.nx; // along the wall (a -> b), since n = (u.z, -u.x)
        const off = 0.004 + (d.kind === 'leak' ? 0.001 : d.kind === 'corner' ? 0.0005 : 0);
        const cx = d.x + d.nx * off, cz = d.z + d.nz * off;
        const P = (u, v) => [cx + ux * (u - 0.5) * d.w, d.y0 + v * d.h, cz + uz * (u - 0.5) * d.w];
        // Wound to face into the room (u x up = -n would face the wall, so go the other way round).
        for (const [u, v] of [[0, 0], [1, 1], [1, 0], [0, 0], [0, 1], [1, 1]]) {
          pos.set(P(u, v), o * 3);
          nrm.set([d.nx, 0, d.nz], o * 3);
          duv.set([u, v], o * 2);
          meta.set([KIND[d.kind], d.strength, (d.seed % 997) * 0.37, d.side ?? 0], o * 4);
          size.set([d.w, d.h], o * 2);
          o++;
        }
      }
      const g = this.own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('duv', new THREE.BufferAttribute(duv, 2));
      g.setAttribute('dmeta', new THREE.BufferAttribute(meta, 4));
      g.setAttribute('dsize', new THREE.BufferAttribute(size, 2));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      mesh.userData.sector = sector;
      mesh.name = 'wall decals';
      this.group.add(mesh);
    }
  }

  /** A scanned model arrived: build its instances (true if this seed uses it). */
  setModel(name, root) {
    if (!root || root.userData?.fallback || this.models.has(name)) return false;
    const list = this.plan.placements.filter((p) => p.name === name);
    if (!list.length) return false;
    const model = prepare(name, root);
    const p0 = list[0];
    const w = model.size.x * p0.scale, d = model.size.z * p0.scale;
    if (Math.abs(w - p0.w) > 0.06 || Math.abs(d - p0.d) > 0.06) console.warn(`Hangar: ${name} measures ${w.toFixed(2)} x ${d.toFixed(2)} m, its footprint is ${p0.w.toFixed(2)} x ${p0.d.toFixed(2)}`);
    const g = new THREE.Group();
    g.name = name;
    this.instance(name, model.parts, list, g, model.size.z);
    this.group.add(g);
    this.models.set(name, g);
    return true;
  }

  /** True if any of `name`'s instances stand where the sun reaches. */
  sunlitModel(name) { return this.plan.placements.some((p) => p.name === name && this.sunlit.has(p.sector)); }

  dispose() {
    for (const x of this.owned) x.dispose();
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
}
