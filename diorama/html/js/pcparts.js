// Diorama — the parts of the computer, as geometry.
//
// Everything is built in "design space": metres, at the real size of a desktop computer, with x to the right
// from the case's rear wall, y up from the floor of the main chamber (the top of the power-supply shroud) and
// z out of the motherboard tray toward the glass side panel. The skin (pc.js) scales and places the result.
//
// Static geometry is collected in a Batch and merged into one mesh per material, because the scene is drawn
// many times a frame (the light probes, the reflection cube), and what costs there is the number of draw
// calls. Merged meshes get their texture coordinates from world position (a box projection per triangle,
// in units of the material's tile), so a scanned material has the same scale on every part and no part needs
// unwrapping.
//
// The layout is a real one: a full-size ATX board seen through the left side panel, so the rear of the case is
// on the left. Sizes are the real parts' (120 mm fans, a 133 mm DIMM, a 2.75-slot 300 mm graphics card, a
// 158 mm tower cooler).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOARD } from './pcboard.js';

const HALF_PI = Math.PI / 2;
const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);

/** Moves a geometry: rotate (x, then y, then z), then place. Returns it. */
export function at(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _m.compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'ZYX')), _s);
  return geo.applyMatrix4(_m);
}
export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
/** A box with rounded edges: an edge that catches a highlight is most of what makes a part look made. */
export const rbox = (w, h, d, r = 0.0008) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));
/** A cylinder standing along z (out of the board). */
export const post = (r, h, seg = 20) => new THREE.CylinderGeometry(r, r, h, seg).rotateX(HALF_PI);

/** Texture coordinates from position: each triangle is projected along the axis its face looks down. */
export function worldUV(geo, tile) {
  const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(b, a).cross(c.sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
      const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
      uv[(i + k) * 2] = u / tile; uv[(i + k) * 2 + 1] = v / tile;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Position and normal only, unindexed: the common form everything is merged in. */
function plain(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  return g;
}

export class Batch {
  constructor() { this.items = new Map(); }
  add(key, geo) {
    if (!this.items.has(key)) this.items.set(key, []);
    this.items.get(key).push(plain(geo));
    return this;
  }
  /** One mesh per material. `materials[key]` is { material, tile }. */
  build(materials) {
    const meshes = [];
    for (const [key, list] of this.items) {
      const spec = materials[key];
      if (!spec) { console.warn(`Diorama: no material for "${key}"`); continue; }
      const geo = worldUV(mergeGeometries(list), spec.tile ?? 0.1);
      for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(geo, spec.material);
      mesh.name = key; mesh.castShadow = true; mesh.receiveShadow = true;
      meshes.push(mesh);
    }
    return meshes;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Fans
// ---------------------------------------------------------------------------------------------------------

/**
 * A fan's rotor (hub and blades) about the z axis, facing +z. Blades are swept forward and twisted: steep at
 * the hub, flat at the tip, as a real axial fan's are, because the tip moves faster.
 */
export function rotorGeometry(size, blades = 9, depth = 0.016) {
  const rh = size * 0.17, rt = size * 0.462, NR = 10, NC = 8;
  const parts = [];
  const hub = new THREE.CylinderGeometry(rh, rh, depth, 40).rotateX(HALF_PI);
  parts.push(plain(hub));
  const cap = new THREE.SphereGeometry(rh, 40, 8, 0, Math.PI * 2, 0, HALF_PI).rotateX(HALF_PI).scale(1, 1, 0.18).translate(0, 0, depth / 2);
  parts.push(plain(cap));
  for (let b = 0; b < blades; b++) {
    const pos = [], idx = [];
    const base = b * Math.PI * 2 / blades, span = Math.PI * 2 / blades * 0.86;
    for (let i = 0; i <= NR; i++) {
      const f = i / NR, r = rh * 0.96 + (rt - rh * 0.96) * f;
      const sweep = 0.55 * f * f + 0.1 * f;                  // the leading edge runs ahead toward the tip
      const chord = span * (0.78 + 0.22 * Math.sin(f * Math.PI)); // widest at mid span
      const rise = depth * (0.92 - 0.5 * f);                 // how far the chord climbs along the axis: the twist
      for (let j = 0; j <= NC; j++) {
        const c = j / NC - 0.5;
        const th = base + sweep + c * chord;
        const z = c * rise + (0.25 - c * c) * depth * 0.22; // a little camber
        pos.push(Math.cos(th) * r, Math.sin(th) * r, z);
      }
    }
    for (let i = 0; i < NR; i++) for (let j = 0; j < NC; j++) {
      const a = i * (NC + 1) + j, c = a + NC + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    parts.push(plain(g));
  }
  return worldUV(mergeGeometries(parts), 0.05);
}

/**
 * The fixed parts of a case fan, facing +z: the frame (a square with the duct through it), four struts and
 * the motor's stator behind the hub, and the light ring round the duct. Returns { frame, struts, ring } geometries.
 */
export function fanFrame(size, thick = 0.025) {
  const h = size / 2, corner = size * 0.06, duct = size * 0.478;
  const shape = new THREE.Shape();
  shape.moveTo(-h + corner, -h); shape.lineTo(h - corner, -h); shape.quadraticCurveTo(h, -h, h, -h + corner);
  shape.lineTo(h, h - corner); shape.quadraticCurveTo(h, h, h - corner, h);
  shape.lineTo(-h + corner, h); shape.quadraticCurveTo(-h, h, -h, h - corner);
  shape.lineTo(-h, -h + corner); shape.quadraticCurveTo(-h, -h, -h + corner, -h);
  const hole = new THREE.Path(); hole.absarc(0, 0, duct, 0, Math.PI * 2, true); shape.holes.push(hole);
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { // the four screw holes
    const s = new THREE.Path(); s.absarc(sx * size * 0.4375, sy * size * 0.4375, size * 0.018, 0, Math.PI * 2, true); shape.holes.push(s);
  }
  const frame = new THREE.ExtrudeGeometry(shape, { depth: thick - 0.001, bevelEnabled: true, bevelThickness: 0.0005, bevelSize: 0.0005, bevelSegments: 2, curveSegments: 48 })
    .translate(0, 0, -thick / 2 + 0.0005);
  const struts = [];
  for (let i = 0; i < 4; i++) {
    const a = i * HALF_PI + 0.5;
    struts.push(at(rbox(duct * 0.86, size * 0.035, 0.003, 0.0006), Math.cos(a) * duct * 0.57, Math.sin(a) * duct * 0.57, -thick / 2 + 0.0025, 0, 0, a));
  }
  struts.push(post(size * 0.165, 0.006, 32).translate(0, 0, -thick / 2 + 0.004));
  // The ring sits just inside the duct's mouth, clear of the frame (two surfaces sharing a place flicker).
  const ring = new THREE.TorusGeometry(duct - size * 0.017, size * 0.015, 12, 96).scale(1, 1, 0.7).translate(0, 0, thick / 2 - size * 0.006);
  return { frame, struts: mergeGeometries(struts.map(plain)), ring };
}

// ---------------------------------------------------------------------------------------------------------
// Cables
// ---------------------------------------------------------------------------------------------------------

/**
 * A bundle of individually sleeved wires, `cols` x `rows` of them, following a path. `side` is the direction
 * the columns are spread along (it is kept square to the path all the way, so the ribbon does not twist).
 */
export function wireBundle(points, cols, rows, pitch, radius, side) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  const N = 28, samples = [], t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3(), ref = new THREE.Vector3(...side).normalize();
  for (let i = 0; i <= N; i++) {
    const p = curve.getPointAt(i / N); curve.getTangentAt(i / N, t);
    n.copy(ref).addScaledVector(t, -ref.dot(t));
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1).addScaledVector(t, -t.z);
    n.normalize(); b.crossVectors(t, n).normalize();
    samples.push({ p, n: n.clone(), b: b.clone() });
  }
  const wires = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const u = (c - (cols - 1) / 2) * pitch, v = (r - (rows - 1) / 2) * pitch;
    const path = new THREE.CatmullRomCurve3(samples.map((s) => s.p.clone().addScaledVector(s.n, u).addScaledVector(s.b, v)));
    wires.push(plain(new THREE.TubeGeometry(path, 44, radius, 7, false)));
  }
  return mergeGeometries(wires);
}

// ---------------------------------------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------------------------------------

/**
 * Builds the whole machine into `batch`. `L` is the chamber: { w, h, d } in design metres.
 * Returns what the skin must animate, light or dress:
 *   { board: {x, y, z}, rotors: [{ size, pos, rot, speed, tint }], emitters: [{ group, geo, layer }],
 *     lamps: {...}, labels: [{ key, pos, rot, w, h }], gpu: {...} }
 */
export function buildComputer(batch, L) {
  const out = { rotors: [], emitters: [], labels: [], lamps: {} };
  const b = batch;
  const bx = 0.034, by = 0.022, zb = BOARD.standoff + BOARD.thick; // the board's corner, and its top face
  out.board = { x: bx, y: by, z: zb };
  /** Board coordinates to design space. */
  const B = (x, y, z = 0) => [bx + x, by + y, zb + z];
  const onBoard = (key, geo, x, y, z = 0, rz = 0) => b.add(key, at(geo, bx + x, by + y, zb + z, 0, 0, rz));

  // ----- The case -----
  const t = 0.0015;
  b.add('paint', at(box(L.w + 0.02, L.h + 0.02, t), L.w / 2, L.h / 2, -t / 2));          // the motherboard tray
  b.add('paint', at(box(t, L.h + 0.02, L.d + 0.01), -t / 2, L.h / 2, L.d / 2));           // rear
  b.add('paint', at(box(t, L.h + 0.02, L.d + 0.01), L.w + t / 2, L.h / 2, L.d / 2));      // front
  b.add('paint', at(box(L.w + 0.02, t, L.d + 0.01), L.w / 2, -t / 2, L.d / 2));           // the shroud's top
  b.add('paint', at(box(L.w + 0.02, t, L.d + 0.01), L.w / 2, L.h + t / 2, L.d / 2));      // top
  // Perforated panels: the vent in the shroud under the graphics card, and the top panel over the top fans.
  b.add('mesh', at(box(0.26, 0.0008, 0.11), 0.17, 0.0004, 0.085));
  b.add('mesh', at(box(Math.min(0.3, L.w - 0.08), 0.0008, 0.13), 0.2, L.h - 0.0004, 0.1));
  // The rear wall: a recess for the I/O shield, and the expansion-slot covers.
  b.add('steel', at(rbox(0.0012, 0.158, 0.046, 0.0005), 0.0006, by + BOARD.io.y, 0.03));
  for (let i = 0; i < 2; i++) b.add('mesh', at(rbox(0.001, 0.0185, 0.118, 0.0004), 0.0006, by + BOARD.pcieY[3] - 0.0203 * i, 0.069)); // the card takes the upper three
  // Right of the board: two rubber grommets for the cables, and two SSDs on the tray.
  const rightGap = L.w - (bx + BOARD.w);
  const gromX = bx + BOARD.w + 0.024;
  out.grommets = [[gromX, 0.205], [gromX, 0.075]];
  for (const [x, y] of out.grommets) {
    b.add('rubber', at(rbox(0.024, 0.078, 0.004, 0.0018), x, y, 0.0015));
    b.add('void', at(rbox(0.012, 0.064, 0.0045, 0.002), x, y, 0.0016));
  }
  out.ssds = [];
  if (rightGap > 0.16) {
    const sx = gromX + 0.07;
    for (const y of [0.215, 0.1]) {
      out.ssds.push({ x: sx, y, w: 0.07, h: 0.1, top: 0.008 });
      b.add('aluDark', at(rbox(0.07, 0.1, 0.007, 0.0012), sx, y, 0.0045));
      out.labels.push({ key: 'ssd', pos: [sx, y, 0.00815], rot: [0, 0, 0], w: 0.062, h: 0.09 });
      for (const [dx, dy] of [[-0.029, -0.043], [0.029, -0.043], [-0.029, 0.043], [0.029, 0.043]]) b.add('steel', at(post(0.0022, 0.0012, 12), sx + dx, y + dy, 0.0082));
    }
  }
  // Where the graphics card's power cables come up through the shroud.
  const gpuGrom = [Math.min(L.w - 0.07, bx + BOARD.w + 0.012), 0, 0.15];
  b.add('rubber', at(rbox(0.07, 0.004, 0.026, 0.0018), gpuGrom[0], 0.0015, gpuGrom[2]));
  b.add('void', at(rbox(0.058, 0.0045, 0.013, 0.002), gpuGrom[0], 0.0016, gpuGrom[2]));

  // ----- The motherboard: the board itself is a separate mesh (it has its own painted maps) -----
  b.add('void', at(box(BOARD.w, BOARD.h, BOARD.thick * 0.9), bx + BOARD.w / 2, by + BOARD.h / 2, BOARD.standoff + BOARD.thick * 0.45));
  for (const [hx, hy] of BOARD.holes) {
    b.add('brass', at(post(0.0028, BOARD.standoff, 6), bx + hx, by + hy, BOARD.standoff / 2));
    onBoard('steel', new THREE.SphereGeometry(0.003, 16, 8, 0, Math.PI * 2, 0, HALF_PI).rotateX(HALF_PI).scale(1, 1, 0.45), hx, hy, 0);
  }

  // The socket's retention frame (the processor itself is under the cooler).
  const cpu = BOARD.cpu;
  for (const [dx, dy, w, h] of [[0, 0.027, 0.062, 0.008], [0, -0.027, 0.062, 0.008], [0.027, 0, 0.008, 0.046], [-0.027, 0, 0.008, 0.046]]) {
    onBoard('steel', rbox(w, h, 0.004, 0.0008), cpu.x + dx, cpu.y + dy, 0.002);
  }

  // Heatsinks over the voltage regulators: a block with fins milled across it.
  const heatsink = (o, tall, alongY) => {
    onBoard('aluDark', rbox(o.w, o.h, tall * 0.5, 0.0012), o.x, o.y, tall * 0.25);
    const n = Math.round((alongY ? o.h : o.w) / 0.0042);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const g = alongY ? rbox(o.w, 0.0023, tall * 0.56, 0.0004) : rbox(0.0023, o.h, tall * 0.56, 0.0004);
      onBoard('aluDark', g, o.x + (alongY ? 0 : f * o.w), o.y + (alongY ? f * o.h : 0), tall * 0.72);
    }
  };
  heatsink(BOARD.vrmLeft, 0.03, true);
  heatsink(BOARD.vrmTop, 0.026, false);

  // The shroud over the rear I/O ports, with a light bar let into its edge.
  const io = BOARD.io;
  onBoard('plastic', rbox(io.w, io.h, 0.04, 0.003), io.x, io.y, 0.02);
  out.emitters.push({ group: 'board', layer: 0, geo: at(rbox(0.0028, io.h * 0.86, 0.0016, 0.0006), ...B(io.x + io.w / 2 - 0.004, io.y, 0.0403)) });
  out.labels.push({ key: 'io', pos: B(io.x - 0.003, io.y, 0.0402), rot: [0, 0, HALF_PI], w: 0.12, h: 0.014 });

  // Polymer capacitors and chokes: the regulators' output filter, in rows beside each heatsink.
  const cap = (x, y) => {
    onBoard('capBody', post(0.004, 0.0085, 20), x, y, 0.00425);
    onBoard('steel', post(0.0038, 0.0006, 20), x, y, 0.0088);
  };
  const choke = (x, y) => onBoard('ferrite', rbox(0.0085, 0.0085, 0.0062, 0.0012), x, y, 0.0031);
  for (let i = 0; i < 9; i++) { cap(0.0655, 0.1225 + i * 0.0114); choke(0.0765, 0.1225 + i * 0.0114); }
  for (let i = 0; i < 8; i++) { cap(0.068 + i * 0.0108, 0.2105); if (i > 0) choke(0.068 + i * 0.0108, 0.2); }
  // The audio section's gold capacitors, bottom left.
  for (let i = 0; i < 8; i++) {
    const x = 0.011 + (i % 2) * 0.009, y = 0.014 + Math.floor(i / 2) * 0.0105;
    onBoard('gold', post(0.0032, 0.0075, 16), x, y, 0.00375);
    onBoard('steel', post(0.003, 0.0005, 16), x, y, 0.0078);
  }

  // Memory: four slots, four sticks. Each stick is a board in an aluminium jacket with a light bar on top.
  const ramMid = (BOARD.ramY[0] + BOARD.ramY[1]) / 2, ramLen = BOARD.ramY[1] - BOARD.ramY[0];
  BOARD.ramX.forEach((x, i) => {
    onBoard('slot', rbox(0.0074, ramLen + 0.008, 0.0075, 0.0006), x, ramMid, 0.00375);
    onBoard('slotLight', rbox(0.0086, 0.0075, 0.0105, 0.0008), x, BOARD.ramY[1] + 0.0052, 0.0052); // the latch
    onBoard('void', box(0.0013, 0.1335, 0.03), x, ramMid, 0.0075 + 0.015);
    onBoard('aluDark', rbox(0.0066, 0.1335, 0.033, 0.0009), x, ramMid, 0.012 + 0.0165);
    // Milled grooves along each jacket: two bright rails.
    for (const dz of [0.012, 0.03]) onBoard('aluminium', rbox(0.0069, 0.1335 * 0.94, 0.0014, 0.0004), x, ramMid, 0.0075 + dz);
    out.emitters.push({ group: 'ram', layer: 1, geo: at(rbox(0.0058, 0.1315, 0.0075, 0.0022), ...B(x, ramMid, 0.0452 + 0.00375)) });
    out.labels.push({ key: 'ram', pos: B(x + 0.00335, ramMid, 0.03), rot: [0, HALF_PI, HALF_PI], w: 0.06, h: 0.012, skip: i < 3 });
  });
  // Well above the sticks: a lamp just over them threw the last stick's shadow, hard-edged, right across the board.
  out.lamps.ram = B((BOARD.ramX[0] + BOARD.ramX[3]) / 2, ramMid, 0.1);

  // Expansion slots: the two long ones wear steel armour.
  const slotMid = (BOARD.pcieX[0] + BOARD.pcieX[1]) / 2, slotLen = BOARD.pcieX[1] - BOARD.pcieX[0];
  BOARD.pcieY.forEach((y, i) => {
    const long = i !== 1, len = long ? slotLen : 0.025, x = long ? slotMid : BOARD.pcieX[0] + 0.0125;
    onBoard(long && i !== 3 ? 'steel' : 'slot', rbox(len, 0.0078, 0.011, 0.0007), x, y, 0.0055);
    onBoard('void', box(len - 0.004, 0.0019, 0.0112), x, y, 0.0056);
    if (long) onBoard('slotLight', rbox(0.006, 0.009, 0.0125, 0.0008), BOARD.pcieX[1] + 0.003, y, 0.00625); // the latch
  });

  // M.2 heatsinks and the chipset's.
  for (const m of BOARD.m2) {
    onBoard('aluminium', rbox(m.w, m.h, 0.0048, 0.0012), m.x, m.y, 0.0034);
    out.labels.push({ key: 'm2', pos: B(m.x, m.y, 0.0059), rot: [0, 0, 0], w: m.w * 0.9, h: m.h * 0.7 });
  }
  const ch = BOARD.chipset;
  onBoard('aluDark', rbox(ch.w, ch.h, 0.011, 0.0025), ch.x, ch.y, 0.0055);
  out.labels.push({ key: 'chipset', pos: B(ch.x, ch.y, 0.0111), rot: [0, 0, 0], w: ch.w * 0.86, h: ch.h * 0.86 });
  out.emitters.push({ group: 'board', layer: 0, geo: at(rbox(ch.w * 0.9, 0.0016, 0.0012, 0.0005), ...B(ch.x, ch.y - ch.h / 2 + 0.006, 0.0111)) });

  // Power and data connectors on the board's edges.
  const atx = BOARD.atx24, eps = BOARD.eps, sata = BOARD.sata;
  onBoard('slotLight', rbox(atx.w, atx.h, 0.0135, 0.0007), atx.x, atx.y, 0.00675);
  onBoard('slotLight', rbox(eps.w, eps.h, 0.0135, 0.0007), eps.x, eps.y, 0.00675);
  onBoard('slot', rbox(sata.w, sata.h, 0.017, 0.0008), sata.x, sata.y, 0.0085);
  for (let i = 0; i < 4; i++) b.add('void', at(box(0.0012, 0.0105, 0.0035), ...B(sata.x + sata.w / 2, sata.y - 0.021 + i * 0.014, 0.0045 + (i % 2) * 0.007)));
  // The clock battery in its holder.
  const bat = BOARD.battery;
  onBoard('slot', post(bat.r + 0.0015, 0.004, 28), bat.x, bat.y, 0.002);
  onBoard('steel', post(bat.r, 0.0034, 36), bat.x, bat.y, 0.0036);
  // Pin headers: a plastic shroud and a comb of gold pins.
  const header = (x, y, cols, rows = 2) => {
    onBoard('slot', rbox(cols * 0.00254 + 0.001, rows * 0.00254 + 0.001, 0.0027, 0.0004), x, y, 0.00135);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      onBoard('gold', box(0.00064, 0.00064, 0.0062), x + (c - (cols - 1) / 2) * 0.00254, y + (r - (rows - 1) / 2) * 0.00254, 0.0056);
    }
  };
  header(0.27, 0.0095, 10); header(0.232, 0.0095, 10); header(0.02, 0.0062, 5); header(0.202, 0.0062, 4, 1); header(0.156, 0.0062, 4, 1);
  for (const x of [cpu.x + 0.024, cpu.x + 0.04, cpu.x + 0.056]) header(x, 0.2362, 4, 1);

  // The debug display (two seven-segment digits) by the top edge, and the drive-activity light by the
  // front-panel header. pclife.js decides what they show.
  const dbg = { x: 0.262, y: 0.2235, w: 0.0165, h: 0.0125, tall: 0.0075 };
  onBoard('slot', rbox(dbg.w, dbg.h, dbg.tall, 0.0006), dbg.x, dbg.y, dbg.tall / 2);
  out.display = { pos: B(dbg.x, dbg.y, dbg.tall + 0.00006), w: dbg.w * 0.9, h: dbg.h * 0.86 };
  out.activity = B(0.2895, 0.0125, 0.0005);

  // ----- The processor's tower cooler -----
  const cx = bx + cpu.x, cy = by + cpu.y;
  const fin = { w: 0.048, h: 0.124, z0: zb + 0.038, pitch: 0.002, n: 60 };
  const finTop = fin.z0 + fin.pitch * fin.n;
  b.add('nickel', at(rbox(0.042, 0.042, 0.009, 0.0012), cx, cy, zb + 0.0085));           // the cold plate
  b.add('steel', at(rbox(0.086, 0.011, 0.0035, 0.001), cx, cy, zb + 0.0148));            // the mounting bar
  for (const s of [-1, 1]) {
    b.add('steel', at(post(0.0034, 0.011, 12), cx + s * 0.037, cy, zb + 0.012));
    b.add('nickel', at(post(0.0021, 0.016, 10), cx + s * 0.037, cy, zb + 0.01));
  }
  for (let i = 0; i < fin.n; i++) b.add('aluminium', at(box(fin.w, fin.h, 0.00042), cx, cy, fin.z0 + i * fin.pitch));
  b.add('aluDark', at(rbox(fin.w + 0.001, fin.h + 0.001, 0.0032, 0.0012), cx, cy, finTop + 0.0016));
  out.labels.push({ key: 'cooler', pos: [cx, cy, finTop + 0.00335], rot: [0, 0, HALF_PI], w: 0.1, h: 0.04 });
  // Six heat pipes: up through the fins on both sides, down and through the cold plate.
  for (let i = 0; i < 6; i++) {
    const y = (i - 2.5) * 0.019, yb = (i - 2.5) * 0.0062, xa = 0.0105 + (i % 2) * 0.0085;
    const pts = [];
    for (const s of [-1, 1]) {
      const leg = [[s * xa, y, finTop - zb + 0.002], [s * xa, y, 0.034], [s * xa * 0.92, (y + yb) / 2, 0.021], [s * 0.004, yb, 0.0115]];
      pts.push(...(s < 0 ? leg : leg.reverse()));
    }
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, yy, z]) => new THREE.Vector3(cx + x, cy + yy, zb + z)), false, 'centripetal');
    b.add('nickel', new THREE.TubeGeometry(curve, 72, 0.003, 12, false));
    for (const s of [-1, 1]) b.add('nickel', at(new THREE.SphereGeometry(0.0031, 14, 8).scale(1, 1, 0.9), cx + s * xa, cy + y, finTop + 0.0036));
  }
  // Its fan, clipped to the side that faces the front of the case.
  const fanZ = fin.z0 + (finTop - fin.z0) / 2;
  out.fans = [{ size: 0.12, pos: [cx + fin.w / 2 + 0.0128, cy, fanZ], rot: [0, HALF_PI, 0], ring: false, speed: 1.15 }];

  // ----- Case fans -----
  out.fans.push({ size: 0.12, pos: [0.0128, cy, 0.1], rot: [0, HALF_PI, 0], ring: true, speed: 1 });                    // rear exhaust
  for (const y of [0.086, 0.224]) out.fans.push({ size: 0.12, pos: [L.w - 0.0128, y, 0.1], rot: [0, -HALF_PI, 0], ring: true, speed: 0.9 }); // front intake
  for (const x of [0.115, 0.25]) if (x + 0.07 < L.w) out.fans.push({ size: 0.12, pos: [x, L.h - 0.0128, 0.1], rot: [HALF_PI, 0, 0], ring: true, speed: 0.95 }); // top exhaust

  // ----- The graphics card -----
  const g = { x0: 0.012, len: 0.3, top: by + BOARD.pcieY[0] + 0.006, thick: 0.057, z0: zb + 0.0015, tall: 0.126 };
  g.x1 = g.x0 + g.len; g.bot = g.top - g.thick; g.z1 = g.z0 + g.tall; g.xm = (g.x0 + g.x1) / 2; g.zm = (g.z0 + g.z1) / 2;
  out.gpu = g;
  b.add('aluDark', at(rbox(g.len, 0.0026, g.tall, 0.001), g.xm, g.top - 0.0013, g.zm));                  // the backplate
  out.labels.push({ key: 'backplate', pos: [g.xm, g.top + 0.00015, g.zm], rot: [-HALF_PI, 0, 0], w: g.len * 0.94, h: g.tall * 0.9 });
  b.add('void', at(box(g.len - 0.012, 0.0016, g.tall - 0.01), g.xm, g.top - 0.0036, g.zm - 0.002));      // its board
  b.add('gold', at(box(0.082, 0.0012, 0.0055), bx + slotMid, g.top - 0.0036, g.z0 - 0.0012));            // the edge connector
  // The fin stack: plates across the card, seen edge-on from the side panel between the backplate and the shroud.
  const fins = Math.floor((g.len - 0.03) / 0.0021);
  for (let i = 0; i < fins; i++) b.add('aluminium', at(box(0.0005, 0.034, g.tall - 0.012), g.x0 + 0.015 + i * 0.0021, g.top - 0.0225, g.zm));
  for (const z of [g.z0 + 0.03, g.z0 + 0.062, g.z0 + 0.094]) b.add('nickel', at(new THREE.CylinderGeometry(0.003, 0.003, g.len - 0.03, 10).rotateZ(HALF_PI), g.xm, g.top - 0.023, z));
  // The shroud: the underside with three fan openings, a rail along the side panel's edge, and the end caps.
  const under = new THREE.Shape();
  const hw = g.len / 2, hd = g.tall / 2;
  under.moveTo(-hw, -hd); under.lineTo(hw, -hd); under.lineTo(hw, hd); under.lineTo(-hw, hd); under.closePath();
  const gpuFans = [-0.098, 0, 0.098];
  for (const fx of gpuFans) { const h = new THREE.Path(); h.absarc(fx, 0, 0.0455, 0, Math.PI * 2, true); under.holes.push(h); }
  b.add('plastic', at(new THREE.ExtrudeGeometry(under, { depth: 0.014, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 48 }), g.xm, g.bot + 0.0148, g.zm, HALF_PI, 0, 0));
  b.add('plastic', at(rbox(g.len, 0.018, 0.004, 0.0015), g.xm, g.bot + 0.009, g.z1 - 0.002));
  b.add('plastic', at(rbox(g.len, 0.0075, 0.004, 0.0012), g.xm, g.top - 0.0064, g.z1 - 0.002));
  b.add('plastic', at(rbox(0.007, g.thick, g.tall, 0.002), g.x1 - 0.0035, g.top - g.thick / 2, g.zm));
  b.add('steel', at(rbox(0.0012, 0.041, g.tall - 0.004, 0.0005), 0.0018, g.top - 0.0165, g.zm + 0.002));     // the bracket on the rear wall
  b.add('plastic', at(rbox(0.011, g.thick - 0.006, g.tall - 0.01, 0.0015), g.x0 - 0.0045, g.top - g.thick / 2, g.zm));
  for (const fx of gpuFans) {
    out.fans.push({ size: 0.092, pos: [g.xm + fx, g.bot + 0.0085, g.zm], rot: [HALF_PI, 0, 0], bare: true, speed: 1.3 });
    b.add('plastic', at(new THREE.CylinderGeometry(0.017, 0.017, 0.004, 28), g.xm + fx, g.bot + 0.0165, g.zm));
  }
  // Lights: the name along the side-panel edge, and a strip under the card that lights the shroud below it.
  out.labels.push({ key: 'gpuLogo', group: 'gpu', pos: [g.x0 + 0.105, g.top - 0.0215, g.z1 + 0.0002], rot: [0, 0, 0], w: 0.15, h: 0.021 });
  out.emitters.push({ group: 'gpu', layer: 0, geo: at(rbox(0.094, 0.0018, 0.0012, 0.0005), g.x1 - 0.062, g.top - 0.0215, g.z1 + 0.0002) });
  out.emitters.push({ group: 'gpu', layer: 1, geo: at(rbox(g.len * 0.86, 0.0016, 0.0032, 0.0006), g.xm, g.bot - 0.0004, g.z1 - 0.007) });
  out.lamps.gpu = [g.xm, g.bot - 0.004, g.z1 - 0.012];
  // Power: two 8-pin sockets on the edge that faces the side panel, and their cables.
  const plugs = [g.x1 - 0.058, g.x1 - 0.034];
  plugs.forEach((px, i) => {
    b.add('slot', at(rbox(0.0195, 0.0098, 0.012, 0.0008), px, g.top - 0.0105, g.z1 - 0.003));
    b.add('slot', at(rbox(0.0185, 0.0092, 0.014, 0.0008), px, g.top - 0.0105, g.z1 + 0.008));
    const gx = gpuGrom[0] - 0.014 + i * 0.028;
    b.add('weave', wireBundle([[px, g.top - 0.0105, g.z1 + 0.013], [px, g.top - 0.0105, g.z1 + 0.03], [(px + gx) / 2, g.top - 0.03, g.z1 + 0.046],
      [gx, g.bot * 0.55, gpuGrom[2] + 0.02], [gx, 0.02, gpuGrom[2] + 0.002], [gx, -0.004, gpuGrom[2]]], 4, 2, 0.0043, 0.0018, [1, 0, 0]));
  });

  // ----- The main power cables -----
  // 24-pin: out of its plug toward the glass, over and down into the upper grommet.
  onBoard('slot', rbox(atx.w - 0.0006, atx.h - 0.0006, 0.014, 0.0007), atx.x, atx.y, 0.0135 + 0.0065);
  const a0 = B(atx.x, atx.y, 0.027), gr = out.grommets[0];
  b.add('weave', wireBundle([a0, [a0[0], a0[1], a0[2] + 0.02], [a0[0] + 0.012, a0[1] + 0.006, a0[2] + 0.036], [gr[0] - 0.002, gr[1] - 0.004, 0.05],
    [gr[0], gr[1], 0.02], [gr[0], gr[1], -0.004]], 12, 2, 0.0043, 0.0018, [0, 1, 0]));
  // 8-pin processor power: up from the board's top-left corner and away over the top edge of the tray.
  onBoard('slot', rbox(eps.w - 0.0006, eps.h - 0.0006, 0.014, 0.0007), eps.x, eps.y, 0.0135 + 0.0065);
  const e0 = B(eps.x, eps.y, 0.027), ey = Math.min(L.h - 0.012, by + BOARD.h + 0.024);
  b.add('rubber', at(rbox(0.036, 0.016, 0.004, 0.0018), e0[0], ey, 0.0015));
  b.add('void', at(rbox(0.026, 0.008, 0.0045, 0.002), e0[0], ey, 0.0016));
  b.add('weave', wireBundle([e0, [e0[0], e0[1], e0[2] + 0.012], [e0[0], e0[1] + 0.012, e0[2] + 0.018], [e0[0], ey, 0.02], [e0[0], ey, -0.004]], 4, 2, 0.0043, 0.0018, [1, 0, 0]));

  // ----- The case's own light: a strip along the top edge behind the glass -----
  out.emitters.push({ group: 'white', layer: 1, geo: at(rbox(L.w - 0.07, 0.0022, 0.005, 0.001), L.w / 2, L.h - 0.0018, L.d - 0.012) });
  // A strip is a line of light and a lamp is a point: two lamps along it give each shadow two soft steps (each lamp costs every pixel).
  out.lamps.white = [0.27, 0.73].map((f) => [L.w * f, L.h - 0.012, L.d - 0.02]);
  return out;
}
