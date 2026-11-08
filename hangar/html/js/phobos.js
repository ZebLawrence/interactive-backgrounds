// Hangar — Phobos plan: where Mars and the sun hang, how the base meets the ground outside, and the shape of
// that ground. Pure: no three.js (sky.js builds the GPU side).
//
// Sectors fall in three classes. Exterior: open to the sky and not a courtyard (the ring round the west pit,
// the pit, the ground below the exit window); courtyard: open to the sky, walled; interior: the rest.
// Where a wall of an open sector has nothing of the base behind it, it is the edge of the world in the traced
// map: an exterior one goes (the terrain runs on), a courtyard one becomes a parapet you can see over.
//
// Terrain: a heightfield on a sphere of Phobos's radius (11 km), so ground drops away from the base as
// R - sqrt(R² - r²): 183 m at 2 km, and seen from eye height (1.7 m) the horizon is about 190 m out. On it:
// fBm relief that grows with distance, craters on a power law, a family of parallel grooves (Phobos's
// signature) and, between 0.5 and 1.9 km, broad ridges big enough to break the horizon, held low towards Mars
// so the near horizon under it curves away clean. Every far feature tapers to nothing before the mesh ends.
// Near the base the ground is a flat pad just below the courtyard; inside an exterior sector it is that
// sector's floor exactly, and it ramps out of that basin over 25 m.
//
// With the real ground (decodeGround), its measured heights replace the made-up craters and fBm: a 4 km
// square of the Moon's Descartes highlands centred on the base and turned to a seeded angle, plus the
// grooves, the far ridges and the sphere's drop. reliefWeight(x, z) says how much of the scan a point wears
// (0 on the pad and in the exterior basins, 1 out on the open ground), so sky.js can light the scan's own
// normals over the coarser far mesh; baseHeight is the ground without it.

import { insidePoly } from './level.js';
import { edgeDistance } from './wetplan.js';
import { lightRooms } from './lightplan.js';

export const PHOBOS_RADIUS = 11000; // m
export const MARS_RADIUS = 3390e3; // m
export const MARS_DISTANCE = 9376e3; // m, Phobos's orbit from Mars's centre
export const MARS_ELEVATION = 25; // degrees above the horizontal
export const SUN_ELEVATION = 30; // degrees
export const SUN_INTENSITY = 6;
export const SUN_FROM_MARS = 100; // degrees of azimuth between Mars and the sun: a lit limb and a terminator
export const PARAPET = 1.1; // m above the courtyard floor
export const PARAPET_THICK = 0.3;
export const PAD = -0.9; // m: the ground just outside the base
export const SHELL_BOTTOM = -8; // m: façades reach down into the ground
export const ROOF_THICK = 0.5;
export const LOW_BUILDING = 4; // m above the courtyard floor: lower blocks keep their own roofline
export const TERRAIN_REACH = 2000; // m from the base centre
// The real ground (data/ground.bin, tools/prepare-sky-ground.py): an LROC NAC terrain model of the Apollo 16
// site, GROUND_N x GROUND_N int16 heights in cm on GROUND_STEP m posts, its regional tilt removed.
export const GROUND_N = 2048;
export const GROUND_STEP = 2; // m

const DEG = Math.PI / 180;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Mars's apparent diameter in degrees (42.3 from Phobos). */
export function marsAngularDiameter() { return 2 * Math.asin(MARS_RADIUS / MARS_DISTANCE) / DEG; }
/** Distance in m to the horizon for an eye `h` m above a sphere of Phobos's radius. */
export function horizonDistance(h) { return Math.sqrt(2 * PHOBOS_RADIUS * h + h * h); }
/** How far the surface has dropped below the tangent plane `r` m out. */
export function curvatureDrop(r) { const R = PHOBOS_RADIUS; return R - Math.sqrt(Math.max(R * R - r * r, 0)); }

export function sectorClass(s) {
  if (!s.tags.has('sky')) return 'interior';
  return s.tags.has('courtyard') ? 'courtyard' : 'exterior';
}

/** Unit [x, z] normal of wall a→b pointing away from its front sector. */
function outward(w) {
  const [ax, az] = w.a, [bx, bz] = w.b;
  const len = Math.hypot(bx - ax, bz - az) || 1;
  return [-(bz - az) / len, (bx - ax) / len];
}

/** The sector of the base lying within 3 m behind one-sided wall `w`, or null. */
export function backedWall(level, w) {
  const [nx, nz] = outward(w);
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const x = w.a[0] + (w.b[0] - w.a[0]) * t, z = w.a[1] + (w.b[1] - w.a[1]) * t;
    for (const d of [0.3, 1, 2, 3]) {
      for (const s of level.sectors) if (s.id !== w.front && insidePoly(s.poly, x + nx * d, z + nz * d)) return s;
    }
  }
  return null;
}

/**
 * Which one-sided walls open up: `dropped` (exterior edges of the world, removed) and `parapets` (courtyard
 * edges, cut to PARAPET). Both are Sets of walls from level.walls.
 */
export function openEdges(level) {
  const dropped = new Set(), parapets = new Set(), backed = new Map(), lowered = new Map();
  for (const w of level.walls) {
    if (w.back !== null || w.kind !== 'solid') continue;
    const front = level.byId.get(w.front);
    const cls = sectorClass(front);
    if (cls === 'interior') continue;
    const b = backedWall(level, w);
    // A courtyard wall in front of a low building (the tunnels) comes down to that building's roof: a
    // full-height wall there would be a free-standing fin, or turn the tunnel into a tower.
    if (b && cls === 'courtyard' && sectorClass(b) === 'interior' && b.ceil + ROOF_THICK - front.floor < LOW_BUILDING) {
      lowered.set(w, Math.max(front.floor + PARAPET, b.ceil + ROOF_THICK));
    } else if (b) backed.set(w, b);
    else (cls === 'exterior' ? dropped : parapets).add(w);
  }
  // Likewise the wall over a low opening from the courtyard (the tunnel mouth): it stops at the tunnel's roof.
  for (const w of level.walls) {
    if (w.kind !== 'upper' || sectorClass(level.byId.get(w.front)) !== 'courtyard') continue;
    const b = level.byId.get(w.back), front = level.byId.get(w.front);
    if (sectorClass(b) === 'interior' && b.ceil + ROOF_THICK - front.floor < LOW_BUILDING) lowered.set(w, b.ceil + ROOF_THICK);
  }
  return { dropped, parapets, backed, lowered };
}

/**
 * Where Mars hangs: the way the windows look (every `window` poi's look direction, as unit vectors) and the
 * way the courtyard opens (its parapets' outward normals, length-weighted to one unit), summed. Returns the
 * unit direction [x, y, z] at MARS_ELEVATION and its horizontal part [x, z].
 */
export function marsDirection(level, edges = openEdges(level)) {
  let sx = 0, sz = 0;
  for (const p of level.pois) {
    if (p.kind !== 'window') continue;
    const dx = p.look[0] - p.x, dz = p.look[2] - p.z, l = Math.hypot(dx, dz);
    if (l > 1e-6) { sx += dx / l; sz += dz / l; }
  }
  let px = 0, pz = 0, total = 0;
  for (const w of edges.parapets) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const [nx, nz] = outward(w);
    px += nx * len; pz += nz * len; total += len;
  }
  if (total > 0) { sx += px / total; sz += pz / total; }
  let l = Math.hypot(sx, sz);
  if (l < 1e-6) { sx = 0; sz = 1; l = 1; }
  const h = [sx / l, sz / l];
  const e = MARS_ELEVATION * DEG;
  return { dir: [h[0] * Math.cos(e), Math.sin(e), h[1] * Math.cos(e)], flat: h };
}

/** The sun: SUN_FROM_MARS degrees of azimuth to one side of Mars (`side` ±1), SUN_ELEVATION up. */
export function sunDirection(marsFlat, side = 1) {
  const a = Math.atan2(marsFlat[1], marsFlat[0]) + side * SUN_FROM_MARS * DEG;
  const e = SUN_ELEVATION * DEG;
  return [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
}

/**
 * Sectors the sun can reach: the open sectors, the window sills, and every sector of a room (lightplan's
 * rooms) that shares an edge with one of those, since sun through a window or an open side lands on that
 * room's floor and walls. Everywhere else is behind a ceiling and walls, and its surfaces skip the sun's
 * light and shadow lookup entirely (scene.assignProbes, Ruling R22).
 */
export function sunlitSectors(level) {
  const open = (s) => s.tags.has('sky') || s.tags.has('window');
  const lit = new Set(level.sectors.filter(open).map((s) => s.id));
  const rooms = lightRooms(level);
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const owner = new Map();
  for (const s of level.sectors) s.poly.forEach((a, i) => owner.set(`${key(a)}>${key(s.poly[(i + 1) % s.poly.length])}`, s));
  const litRooms = new Set();
  for (const s of level.sectors) {
    if (!open(s)) continue;
    s.poly.forEach((a, i) => {
      const t = owner.get(`${key(s.poly[(i + 1) % s.poly.length])}>${key(a)}`);
      if (t && !open(t)) { lit.add(t.id); litRooms.add(rooms.get(t.id)); }
    });
  }
  for (const s of level.sectors) if (litRooms.has(rooms.get(s.id))) lit.add(s.id);
  return lit;
}

// ---- the base seen from outside ---------------------------------------------------------------------------

const quad = (a, b, y0, y1, sector, tile = 2) => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = [(b[1] - a[1]) / (len || 1), 0, -(b[0] - a[0]) / (len || 1)]; // into the left of a→b (wallQuads' rule)
  return {
    corners: [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]],
    uv: [[0, y0 / tile], [len / tile, y0 / tile], [len / tile, y1 / tile], [0, y1 / tile]],
    normal: n, sector, kind: 'shell', back: null,
  };
};

/**
 * The outside of the base as wall quads (wallQuads' format: corners a-bottom, b-bottom, b-top, a-top, normal
 * into the side it faces) and roof polygons:
 *   inner   the parapets' and lowered walls' courtyard faces (they replace the cut walls in the level mesh);
 *   quads   parapet outer faces and tops, interior façades (outward, from SHELL_BOTTOM to the roof) and the
 *           steps between roofs of different height;
 *   roofs   [{ poly, y, sector }]: each interior sector capped at its ceiling plus ROOF_THICK, or at the top of
 *           the tallest open-sky wall it stands behind, so the blocks round the courtyard read as solid.
 */
export function planShell(level, edges = openEdges(level)) {
  const roof = new Map();
  for (const s of level.sectors) if (sectorClass(s) === 'interior') roof.set(s.id, s.ceil + ROOF_THICK);
  for (const w of level.walls) {
    if (w.kind !== 'upper' || !roof.has(w.back) || edges.lowered?.has(w)) continue;
    if (sectorClass(level.byId.get(w.front)) !== 'interior') roof.set(w.back, Math.max(roof.get(w.back), w.top));
  }
  // An open sector's wall that stays (a building stands just behind it) is that building's face: the
  // building is as tall as the wall, so the wall is never a free-standing fin seen from outside.
  for (const [w, b] of edges.backed ?? []) if (roof.has(b.id)) roof.set(b.id, Math.max(roof.get(b.id), w.top));
  const inner = [], quads = [];
  for (const w of edges.parapets) {
    const s = level.byId.get(w.front);
    const top = s.floor + PARAPET;
    inner.push(quad(w.a, w.b, s.floor, top, w.front));
    const [nx, nz] = outward(w);
    const ex = (w.b[0] - w.a[0]), ez = (w.b[1] - w.a[1]), el = Math.hypot(ex, ez) || 1;
    // Outer face offset by the wall's thickness, run on past both ends by as much so corners close.
    const k = PARAPET_THICK / el;
    const oa = [w.a[0] + nx * PARAPET_THICK - ex * k, w.a[1] + nz * PARAPET_THICK - ez * k];
    const ob = [w.b[0] + nx * PARAPET_THICK + ex * k, w.b[1] + nz * PARAPET_THICK + ez * k];
    quads.push(quad(ob, oa, SHELL_BOTTOM, top, w.front));
    // Top: a horizontal strip from the inner edge to the outer one, facing up.
    const ia = [w.a[0] - ex * k, w.a[1] - ez * k], ib = [w.b[0] + ex * k, w.b[1] + ez * k];
    quads.push({
      corners: [[ia[0], top, ia[1]], [ib[0], top, ib[1]], [ob[0], top, ob[1]], [oa[0], top, oa[1]]],
      uv: [[ia[0] / 2, ia[1] / 2], [ib[0] / 2, ib[1] / 2], [ob[0] / 2, ob[1] / 2], [oa[0] / 2, oa[1] / 2]],
      normal: [0, 1, 0], sector: w.front, kind: 'shell', back: null,
    });
  }
  for (const [w, top] of edges.lowered ?? []) inner.push(quad(w.a, w.b, w.kind === 'upper' ? w.bottom : level.byId.get(w.front).floor, top, w.front));
  for (const w of level.walls) {
    if (w.back !== null || !roof.has(w.front)) continue;
    quads.push(quad(w.b, w.a, SHELL_BOTTOM, roof.get(w.front), w.front)); // reversed: faces out
  }
  // Steps between neighbouring roofs: every shared edge (the level's wall list only has edges whose heights differ).
  const key = (p, q) => `${p[0].toFixed(3)},${p[1].toFixed(3)}>${q[0].toFixed(3)},${q[1].toFixed(3)}`;
  const owner = new Map();
  for (const s of level.sectors) s.poly.forEach((p, i) => owner.set(key(p, s.poly[(i + 1) % s.poly.length]), s));
  for (const s of level.sectors) {
    if (!roof.has(s.id)) continue;
    s.poly.forEach((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      const t = owner.get(key(b, a));
      if (!t || !roof.has(t.id)) return;
      const lo = roof.get(s.id), hi = roof.get(t.id);
      if (hi - lo > 1e-6) quads.push(quad(a, b, lo, hi, s.id)); // faces into s, the lower roof
    });
  }
  const roofs = [...roof].map(([id, y]) => ({ poly: level.byId.get(id).poly, y, sector: id }));
  return { inner, quads, roofs, roofHeight: roof };
}

// ---- terrain ----------------------------------------------------------------------------------------------

function bounds(polys) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of polys) for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0, z0, x1, z1 };
}

/** Seeded 2D value noise with smooth interpolation, in [-1, 1]. */
function valueNoise(seed) {
  const h = (i, j) => {
    let t = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed) | 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    return (((t ^ (t >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  return (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Bowl, raised rim and ejecta falloff: height at s = distance / radius. */
function craterProfile(s, depth, rim) {
  if (s < 1) return rim - depth * (1 - s * s) * (1 - 0.35 * s * s);
  return rim * Math.pow(s, -3) * (1 - smooth(2.2, 3, s));
}

/** data/ground.bin (an ArrayBuffer) as { n, step, size, h: Float32Array of metres, row-major }. */
export function decodeGround(buffer, n = GROUND_N, step = GROUND_STEP) {
  const cm = new Int16Array(buffer);
  if (cm.length !== n * n) throw new Error(`ground.bin holds ${cm.length} heights, expected ${n * n}`);
  const h = new Float32Array(cm.length);
  for (let i = 0; i < cm.length; i++) h[i] = cm[i] / 100;
  return { n, step, size: n * step, h };
}

/**
 * The real ground placed on the world: centred on `center`, turned by `angle`. uv(x, z) gives the scan's
 * coordinates (u along a row, v down the rows, 0..1; the same frame as ground-albedo and ground-normal),
 * height(x, z) the scan's height there (bilinear; clamped at the square's edge).
 */
function placeGround(g, center, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const uv = (x, z) => {
    const dx = x - center[0], dz = z - center[1];
    return { u: (c * dx + s * dz) / g.size + 0.5, v: (-s * dx + c * dz) / g.size + 0.5 };
  };
  const height = (x, z) => {
    const { u, v } = uv(x, z);
    const fx = Math.min(g.n - 1, Math.max(0, u * g.n - 0.5)), fz = Math.min(g.n - 1, Math.max(0, v * g.n - 0.5));
    const i = Math.min(g.n - 2, Math.floor(fx)), j = Math.min(g.n - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j, k = j * g.n + i;
    const a = g.h[k] + (g.h[k + 1] - g.h[k]) * tx;
    const b = g.h[k + g.n] + (g.h[k + g.n + 1] - g.h[k + g.n]) * tx;
    return a + (b - a) * tz;
  };
  return { angle, cos: c, sin: s, center, size: g.size, uv, height };
}

/**
 * The ground outside, for this seed. Returns { height(x, z), shade(x, z), center, footprint, exteriors,
 * craters, grooves, inFootprint(x, z), footprintDistance(x, z), ground, baseHeight(x, z), reliefWeight(x, z) }.
 * `footprint` is the polygons where the terrain must not show (interior and courtyard sectors, and any open
 * sector whose floor is a slime pool); `exteriors` are the open sectors whose floor the terrain itself
 * becomes. sample(x, z) is { base, scan, weight } in one go (height = base + scan x weight). `realGround`
 * (decodeGround) replaces the made-up craters and fBm with measured heights; `ground` is
 * then its placement (placeGround), else null.
 */
export function makeTerrain(level, rng, marsFlat = [0, 1], realGround = null) {
  const footprint = [], exteriors = [];
  for (const s of level.sectors) {
    if (sectorClass(s) === 'exterior' && !s.tags.has('slime')) exteriors.push(s);
    else footprint.push(s);
  }
  const all = bounds(level.sectors.map((s) => s.poly));
  const center = [(all.x0 + all.x1) / 2, (all.z0 + all.z1) / 2];
  const halfDiag = Math.hypot(all.x1 - all.x0, all.z1 - all.z0) / 2;
  const fpBounds = footprint.map((s) => bounds([s.poly]));
  const exBounds = exteriors.map((s) => bounds([s.poly]));

  const polyDist = (s, b, x, z) => {
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && insidePoly(s.poly, x, z)) return 0;
    // Cheap lower bound first: the box distance.
    return edgeDistance(s.poly, x, z);
  };
  const footprintDistance = (x, z) => {
    const r = Math.hypot(x - center[0], z - center[1]);
    if (r > halfDiag + 60) return r - halfDiag; // far out: a bound is all anyone needs
    let d = Infinity;
    for (let i = 0; i < footprint.length; i++) {
      const b = fpBounds[i];
      const bx = Math.max(b.x0 - x, 0, x - b.x1), bz = Math.max(b.z0 - z, 0, z - b.z1);
      if (Math.hypot(bx, bz) >= d) continue;
      d = Math.min(d, polyDist(footprint[i], b, x, z));
      if (d === 0) return 0;
    }
    return d;
  };
  const inFootprint = (x, z) => footprint.some((s, i) => {
    const b = fpBounds[i];
    return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && insidePoly(s.poly, x, z);
  });

  // Craters: a few big ones far out to the sides, a power law of smaller ones everywhere, none on the base.
  const craters = [];
  const marsAz = Math.atan2(marsFlat[1], marsFlat[0]);
  const place = (rMin, rMax, distMin, distMax, n, side) => {
    for (let k = 0, tries = 0; k < n && tries < n * 30; tries++) {
      const u = rng.next();
      const R = rMin * Math.pow(rMax / rMin, u * u); // more small than big
      const az = side ? marsAz + (rng.next() < 0.5 ? 1 : -1) * rng.range(55, 150) * DEG : rng.range(0, 2 * Math.PI);
      const d = Math.sqrt(rng.range(distMin * distMin, distMax * distMax));
      const x = center[0] + Math.cos(az) * d, z = center[1] + Math.sin(az) * d;
      if (footprintDistance(x, z) < R * 2.4 + 6) continue;
      if (exteriors.some((s, i) => polyDist(s, exBounds[i], x, z) < R * 2.4 + 4)) continue;
      const fresh = rng.next();
      craters.push({ x, z, R, depth: R * rng.range(0.14, 0.22), rim: R * rng.range(0.03, 0.05), fresh });
      k++;
    }
  };
  // The real ground brings its own craters.
  if (!realGround) {
    place(250, 650, 900, 1600, 4, true);
    place(30, 140, 200, 1500, 40, false);
    place(14, 40, 50, 300, 10, false);
    place(6, 40, 30, 600, 70, false);
    place(1.2, 8, 6, 300, 160, false);
  }

  // Grooves: one family of near-parallel troughs with pit chains along them, kept off the base.
  const grooves = [];
  const gAz = rng.range(0, Math.PI);
  for (let k = 0; k < 4; k++) {
    const az = gAz + rng.range(-6, 6) * DEG;
    const off = (rng.next() < 0.5 ? -1 : 1) * rng.range(140, 900);
    grooves.push({ dx: Math.cos(az), dz: Math.sin(az), off, w: rng.range(10, 26), depth: rng.range(3, 8), phase: rng.range(0, 100), pit: rng.range(35, 70) });
  }

  const n1 = valueNoise((rng.next() * 2 ** 31) | 0);
  const n2 = valueNoise((rng.next() * 2 ** 31) | 0);
  const fbm = (x, z, octaves) => {
    let s = 0;
    for (const [wl, amp, n] of octaves) s += amp * n(x / wl + 17.3, z / wl - 9.1);
    return s;
  };
  const ground = realGround ? placeGround(realGround, center, rng.range(0, Math.PI * 2)) : null;
  // Relief that grows with distance (rough, but never a cliff), and broad ridges far out. The real ground
  // replaces the made-up near and mid relief (it is added in `natural`, so it can be weighed apart).
  const relief = (x, z, r) => {
    const near = ground ? 0 : fbm(x, z, [[3, 0.05, n1], [9, 0.18, n2], [23, 0.55, n1], [60, 1.6, n2]]);
    const mid = ground ? 0 : fbm(x, z, [[160, 3, n1], [420, 7, n2]]) * (0.6 + smooth(80, 700, r));
    const ridgeN = 1 - Math.abs(n2(x / 700 + 3.1, z / 700 + 7.7));
    const ang = Math.atan2(z - center[1], x - center[0]) - marsAz;
    const towardMars = Math.max(0, Math.cos(ang));
    const ridge = ridgeN * ridgeN * 170 * smooth(450, 1250, r) * (1 - smooth(1650, 1930, r)) * (1 - 0.8 * towardMars ** 2);
    return near + mid + ridge;
  };
  const craterHeight = (x, z) => {
    let h = 0;
    for (const c of craters) {
      const dx = x - c.x, dz = z - c.z;
      const s2 = (dx * dx + dz * dz) / (c.R * c.R);
      if (s2 >= 9) continue;
      h += craterProfile(Math.sqrt(s2), c.depth, c.rim);
    }
    return h;
  };
  const grooveHeight = (x, z) => {
    let h = 0;
    for (const g of grooves) {
      const across = (x - center[0]) * -g.dz + (z - center[1]) * g.dx - g.off;
      const along = (x - center[0]) * g.dx + (z - center[1]) * g.dz;
      const q = across / g.w;
      if (Math.abs(q) > 3.5) continue;
      const pits = 0.65 + 0.35 * Math.cos((along / g.pit + g.phase) * 2 * Math.PI);
      h += -g.depth * pits * Math.exp(-q * q) + 0.12 * g.depth * Math.exp(-((Math.abs(q) - 1.6) ** 2) * 2);
    }
    return h;
  };

  // One evaluation of everything at a point: the ground without the scan (base), the scan's height there and
  // the weight it carries (the pad's keep times the exterior basin's ramp, tapered before the mesh ends).
  const evaluate = (x, z) => {
    let ramp = 1, floor = 0;
    for (let i = 0; i < exteriors.length; i++) {
      const s = exteriors[i];
      const d = polyDist(s, exBounds[i], x, z);
      if (d === 0) return { base: s.floor, scan: 0, weight: 0 };
      const t = smooth(0, 25, d);
      if (t < ramp) { ramp = t; floor = s.floor; }
    }
    const r = Math.hypot(x - center[0], z - center[1]);
    const keep = smooth(1, 22, footprintDistance(x, z)); // flat pad by the walls, full relief 22 m out
    // The sphere's drop is measured from the base centre (under 0.2 m anywhere on the base).
    const nat = PAD + (relief(x, z, r) + craterHeight(x, z) + grooveHeight(x, z)) * keep - curvatureDrop(r);
    const base = ramp < 1 ? floor + (nat - floor) * ramp : nat;
    if (!ground) return { base, scan: 0, weight: 0 };
    return { base, scan: ground.height(x, z), weight: keep * ramp * (1 - smooth(1650, 1930, r)) };
  };
  const height = (x, z) => { const e = evaluate(x, z); return e.base + e.scan * e.weight; };
  const baseHeight = (x, z) => evaluate(x, z).base;
  const reliefWeight = (x, z) => evaluate(x, z).weight;

  // Albedo multiplier: fresh craters and their ejecta are bright, groove floors and old crater bowls darker,
  // and broad patches of lighter and darker dust.
  const shade = (x, z) => {
    if (ground) return 1; // the real ground's albedo is its photograph (sky.js)
    let k = 1 + 0.12 * n1(x / 90 - 4.2, z / 90 + 1.3) + 0.06 * n2(x / 23, z / 23);
    for (const c of craters) {
      const dx = x - c.x, dz = z - c.z;
      const s = Math.sqrt(dx * dx + dz * dz) / c.R;
      if (s >= 3) continue;
      const fresh = c.fresh > 0.7 ? 0.35 : 0.08;
      k += s < 1 ? -0.08 * (1 - s * s) : fresh * Math.exp(-(s - 1) * 1.6);
    }
    for (const g of grooves) {
      const across = ((x - center[0]) * -g.dz + (z - center[1]) * g.dx - g.off) / g.w;
      if (Math.abs(across) < 3) k -= 0.1 * Math.exp(-across * across);
    }
    return Math.min(1.6, Math.max(0.55, k));
  };

  return {
    height, shade, center, halfDiag, footprint, exteriors, craters, grooves, inFootprint, footprintDistance, bounds: all,
    ground, baseHeight, reliefWeight, sample: evaluate,
  };
}

/**
 * Boulders for this seed: [{ x, y, z, size, yaw, tiltX, tiltZ, model, near }]: model 'a' (the finer of the two
 * code-built shapes, some big near rocks), 'b' (the other near rocks) or 'lo' (a stand-in lump, far rocks). Sizes on a power
 * law (most knee-high, a few the height of a person, the odd house-sized one far out); every one is sunk by
 * a fifth of its size so it sits in the ground. `near` ones lie inside the sun's shadow box `box`
 * ({ x0, z0, x1, z1 }); the rest get projected shadows.
 */
export function scatterBoulders(terrain, rng, box, counts = { near: 130, far: 260 }) {
  const out = [];
  const add = (x, z, size) => {
    const y = terrain.height(x, z) - size * 0.2;
    const near = x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
    out.push({
      x, y, z, size, yaw: rng.range(0, Math.PI * 2), tiltX: rng.range(-0.25, 0.25), tiltZ: rng.range(-0.25, 0.25),
      near, model: near ? (size > 1.6 && rng.next() < 0.5 ? 'a' : 'b') : 'lo',
    });
  };
  const [cx, cz] = terrain.center;
  // Near: inside the shadow box, off the base and clear of the walls (a boulder against a wall is a clipping risk).
  for (let k = 0, tries = 0; k < counts.near && tries < counts.near * 50; tries++) {
    const x = rng.range(box.x0, box.x1), z = rng.range(box.z0, box.z1);
    const size = 0.25 * Math.pow(10, rng.next() ** 2 * 1.0); // 0.25 .. 2.5 m
    if (terrain.footprintDistance(x, z) < 1.5 + size) continue;
    add(x, z, size);
    k++;
  }
  // Far: out to 600 m, thinning with distance; bigger ones further out where only they would show.
  for (let k = 0, tries = 0; k < counts.far && tries < counts.far * 50; tries++) {
    const az = rng.range(0, Math.PI * 2), d = terrain.halfDiag + 30 + Math.pow(rng.next(), 1.6) * 560;
    const x = cx + Math.cos(az) * d, z = cz + Math.sin(az) * d;
    if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) continue;
    const size = Math.min(9, (0.5 + d / 250) * Math.pow(10, rng.next() ** 3 * 0.8));
    add(x, z, size);
    k++;
  }
  return out;
}

// ---- the real sky ----
// Stars and the Milky Way come in the ICRS frame (x toward RA 0, z toward the north celestial pole).
// skyOrientation turns that frame onto the world so the galactic centre, the brightest stretch of the band,
// hangs MILKY_WAY.fromMars degrees of azimuth to the side of Mars away from the sun, MILKY_WAY.elevation up,
// with the band climbing steeply (MILKY_WAY.tilt from the horizontal) away from Mars: in the courtyard and
// computer-room views Mars and the galaxy share the frame, and the sun's glare stays on the other side.
const radec = (ra, dec) => [Math.cos(dec * DEG) * Math.cos(ra * DEG), Math.cos(dec * DEG) * Math.sin(ra * DEG), Math.sin(dec * DEG)];
export const GALACTIC_CENTER = radec(266.405, -28.936); // Sgr A*
export const GALACTIC_POLE = radec(192.8595, 27.1283); // north galactic pole
export const MILKY_WAY = { fromMars: 50, elevation: 22, tilt: 62 }; // degrees

const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  axpy: (k, a, b) => [b[0] + k * a[0], b[1] + k * a[1], b[2] + k * a[2]],
};

/** The rotation (row-major 3x3) taking ICRS directions to world directions (see above). */
export function skyOrientation(marsDir, sunDir, mw = MILKY_WAY) {
  const az = (v) => Math.atan2(v[2], v[0]);
  const mAz = az(marsDir);
  const side = Math.sign(Math.sin(az(sunDir) - mAz)) || 1;
  const a = mAz - side * mw.fromMars * DEG, e = mw.elevation * DEG;
  const wc = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
  const up = [0, 1, 0];
  const upPerp = v3.norm(v3.axpy(-v3.dot(up, wc), wc, up));
  let h = v3.norm(v3.cross(up, wc));
  if (h[0] * marsDir[0] + h[2] * marsDir[2] > 0) h = h.map((x) => -x); // away from Mars
  const t = v3.axpy(Math.sin(mw.tilt * DEG), upPerp, h.map((x) => x * Math.cos(mw.tilt * DEG)));
  const wn = v3.norm(v3.cross(wc, t));
  const gc = GALACTIC_CENTER;
  const gn = v3.norm(v3.axpy(-v3.dot(GALACTIC_POLE, gc), gc, GALACTIC_POLE));
  const W = [wc, wn, v3.cross(wc, wn)], G = [gc, gn, v3.cross(gc, gn)];
  const Q = new Array(9).fill(0);
  for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Q[i * 3 + j] += W[k][i] * G[k][j];
  return Q;
}

/** Q (row-major 3x3) applied to a direction. */
export function applySky(Q, d) {
  return [Q[0] * d[0] + Q[1] * d[1] + Q[2] * d[2], Q[3] * d[0] + Q[4] * d[1] + Q[5] * d[2], Q[6] * d[0] + Q[7] * d[1] + Q[8] * d[2]];
}

/**
 * data/stars.bin (tools/prepare-sky-ground.py: the Hipparcos catalogue, brightest first, 10 bytes a star) as
 * { count, dir: Float32Array (ICRS unit vectors), mag: Float32Array (V), color: Float32Array (rgb 0..1) }.
 */
export function decodeStars(buffer) {
  const count = Math.floor(buffer.byteLength / 10);
  const dv = new DataView(buffer);
  const dir = new Float32Array(count * 3), mag = new Float32Array(count), color = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * 10;
    const x = dv.getInt16(o, true), y = dv.getInt16(o + 2, true), z = dv.getInt16(o + 4, true);
    const l = Math.hypot(x, y, z) || 1;
    dir[i * 3] = x / l; dir[i * 3 + 1] = y / l; dir[i * 3 + 2] = z / l;
    mag[i] = dv.getUint8(o + 6) / 16 - 2;
    for (let c = 0; c < 3; c++) color[i * 3 + c] = dv.getUint8(o + 7 + c) / 255;
  }
  return { count, dir, mag, color };
}
