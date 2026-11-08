// Hangar — Scatter: where the seeded dressing goes. Pure: no three.js (props.js builds the meshes).
//
// scatterProps(level, graph, rng, catalogue, opts) puts the floor props of `catalogue` in every walkable room
// (not slime, the walkway, a door, the lift, a sill or a corridor) by four rules:
//   wall     backed onto a solid wall (WALL_GAP at most between them) and turned to face away from it
//   corner   in a concave right-angle corner, backed onto one wall with a side onto the other
//   cluster  groups of 2 to 5 touching (gaps under 2 cm), never overlapping, anchored on a wall, a corner or free
//   free     anywhere on the room's floor at any heading
// `perRoom: [min, max]` is how many of an entry a room of 100 m² gets (clusters: how many groups), scaled with
// the room's area (half for a small room, up to 2.5 times for the computer rooms). An entry with `mount`
// hangs on its wall that high above the floor (wall boxes). Nothing comes within NAV_CLEAR of a nav-graph edge
// the walker uses (every edge on a shortest route between two pois or the start), nothing overlaps anything
// else, and nothing crowds the door frames, wall switches, consoles or the pois (propplan.js); `opts.avoid`
// adds circles to keep off ({ x, z, r }: the wet patches). Output: [{ name, rule, sector, floor, x, y, z, yaw,
// scale, w, d, spin, mount?, side?, gap?, group? }]: (x, z) is the footprint's centre, yaw turns the model's
// +z (its front) to face the room, w × d is the scaled footprint (w along the model's x), `spin` turns a round
// model about its own axis without changing the footprint, `gap` (wall and corner items) is how far the back
// stands off its wall: FLUSH_GAP for mounted boxes and `flush` entries (the scrap's plate leans on the wall),
// 1 to 3.5 cm for the rest.
//
// The walker treats the props as walls: propObstacles(placements).distance(x, z) is the distance to the
// nearest footprint (negative inside one) and blockNav(graph, obstacles) drops the nav nodes and edges they
// stand on, so a click can never send the camera through a drum.
//
// planPipes(level, rng): pipe runs along walls above head height with brackets (Ruling R15).
// planDecals(level, rng): grime along wall bases, darkened room corners and leak streaks down the walls.
// Units: metres, x east, z south; yaw as three.js rotation.y.

import { insidePoly } from './level.js';
import { findPath, finish } from './navgraph.js';
import { polyArea, edgeDistance } from './wetplan.js';
import { doorFrames, planSwitches, planConsoles, CONSOLE_W, CONSOLE_DEPTH } from './propplan.js';
import { openEdges } from './phobos.js';

export const NAV_CLEAR = 0.6; // m from any used nav edge
export const WALL_GAP = 0.05; // m at most between a wall item's back and its wall
export const FLUSH_GAP = 0.001; // m: wall-mounted items and those that lean on the wall (`flush`) sit this close
const ITEM_GAP = 0.2; // m between props that are not in one cluster
const TOUCH = [0.003, 0.015]; // m between neighbours in a cluster
const DOOR_KEEP = 0.5; // m beyond a door's half width
const SWITCH_KEEP = 0.45;
const CONSOLE_KEEP = 0.35;
const POI_KEEP = 0.9;
const MIN_ROOM = 8; // m²
const TRIES = 40;
const NO_PROPS = ['slime', 'walkway', 'door', 'lift', 'window', 'corridor', 'sky'];
const ORDER = { corner: 0, wall: 1, cluster: 2, free: 3 };

// Props from the manifest (Poly Haven, CC0: the power box and the two drums) and built in props.js (reel,
// scrap, junction box). Footprints are the models' measured bounding boxes (w along the model's x, d along its
// z, its front).
export const CATALOGUE = [
  { name: 'scrap', footprint: [0.62, 0.5], rule: 'corner', perRoom: [0, 1], flush: true }, // a plate leans on the wall
  { name: 'power-box', footprint: [0.35, 0.1], rule: 'wall', perRoom: [0, 1], mount: 1.15 }, // the panel without its door
  { name: 'junction-box', footprint: [0.34, 0.14], rule: 'wall', perRoom: [1, 2], mount: 1.45 },
  { name: 'drum-red', footprint: [0.57, 0.57], rule: 'cluster', perRoom: [0, 1], round: true, vary: true },
  { name: 'drum-blue', footprint: [0.49, 0.49], rule: 'cluster', perRoom: [0, 1], round: true, vary: true },
  { name: 'cable-reel', footprint: [0.72, 0.46], rule: 'free', perRoom: [0, 1] },
];

// ---------------------------------------------------------------------------------------------
// Geometry: oriented footprints. Local x = (cos yaw, -sin yaw), local z (the front) = (sin yaw, cos yaw).

/** { x, z, ax, az, bx, bz, hw, hd, corners, back: [l, r], side, box } for a placement-like { x, z, yaw, w, d }. */
export function footprint(p) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const f = { x: p.x, z: p.z, ax: c, az: -s, bx: s, bz: c, hw: p.w / 2, hd: p.d / 2 };
  const at = (u, v) => [f.x + f.ax * u + f.bx * v, f.z + f.az * u + f.bz * v];
  f.at = at;
  f.corners = [at(-f.hw, -f.hd), at(f.hw, -f.hd), at(f.hw, f.hd), at(-f.hw, f.hd)];
  f.back = [f.corners[0], f.corners[1]];
  f.side = p.side ? at(p.side * f.hw, 0) : null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of f.corners) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  f.box = { x0, x1, z0, z1 };
  return f;
}

const local = (f, x, z) => { const dx = x - f.x, dz = z - f.z; return [dx * f.ax + dz * f.az, dx * f.bx + dz * f.bz]; };

/** Distance from (x, z) to footprint f; negative inside (minus the depth to its nearest side). */
export function pointRectDistance(f, x, z) {
  const [u, v] = local(f, x, z);
  const du = Math.abs(u) - f.hw, dv = Math.abs(v) - f.hd;
  if (du <= 0 && dv <= 0) return Math.max(du, dv);
  return Math.hypot(Math.max(du, 0), Math.max(dv, 0));
}

function segPoint(ax, az, bx, bz, x, z) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
}

/** Distance from segment a-b to footprint f (0 if it touches or crosses it). */
export function segRectDistance(f, a, b) {
  const [ua, va] = local(f, a[0], a[1]), [ub, vb] = local(f, b[0], b[1]);
  // Liang-Barsky clip against the box: any part inside means 0.
  let t0 = 0, t1 = 1;
  const du = ub - ua, dv = vb - va;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (clip(-du, ua + f.hw) && clip(du, f.hw - ua) && clip(-dv, va + f.hd) && clip(dv, f.hd - va) && t0 <= t1) return 0;
  let d = Math.min(pointRectDistance(f, a[0], a[1]), pointRectDistance(f, b[0], b[1]));
  for (const [x, z] of f.corners) d = Math.min(d, segPoint(a[0], a[1], b[0], b[1], x, z));
  return d;
}

/** Signed gap between two footprints along the best separating axis (negative: they overlap by that much). */
export function rectGap(f, g) {
  let best = -Infinity;
  for (const [nx, nz] of [[f.ax, f.az], [f.bx, f.bz], [g.ax, g.az], [g.bx, g.bz]]) {
    let fa = Infinity, fb = -Infinity, ga = Infinity, gb = -Infinity;
    for (const [x, z] of f.corners) { const p = x * nx + z * nz; fa = Math.min(fa, p); fb = Math.max(fb, p); }
    for (const [x, z] of g.corners) { const p = x * nx + z * nz; ga = Math.min(ga, p); gb = Math.max(gb, p); }
    best = Math.max(best, ga - fb, fa - gb);
  }
  if (best <= 0) return best;
  // Separated: the true distance (corners to edges), which is at least the axis gap.
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = f.corners[i], b = f.corners[(i + 1) % 4];
    for (const [x, z] of g.corners) d = Math.min(d, segPoint(a[0], a[1], b[0], b[1], x, z));
    const c = g.corners[i], e = g.corners[(i + 1) % 4];
    for (const [x, z] of f.corners) d = Math.min(d, segPoint(c[0], c[1], e[0], e[1], x, z));
  }
  return d;
}

/** Distance from (x, z) to the nearest solid wall of sector `sectorId`. */
export function wallDistance(level, sectorId, x, z) {
  let d = Infinity;
  for (const w of level.walls) if (w.kind === 'solid' && w.front === sectorId) d = Math.min(d, segPoint(w.a[0], w.a[1], w.b[0], w.b[1], x, z));
  return d;
}

// ---------------------------------------------------------------------------------------------
// The routes the walker takes.

const usedCache = new WeakMap();

/** Segments [[ax, az], [bx, bz]] of every nav edge on a shortest route between two pois (or the start). */
export function usedEdges(level, graph) {
  if (usedCache.has(graph)) return usedCache.get(graph);
  // Largest connected component.
  const comp = new Int32Array(graph.nodes.length).fill(-1);
  let main = -1, mainSize = 0;
  for (const n of graph.nodes) {
    if (comp[n.id] >= 0) continue;
    const c = n.id, stack = [n.id];
    comp[n.id] = c;
    let size = 0;
    while (stack.length) {
      const id = stack.pop();
      size++;
      for (const e of graph.edges.get(id)) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); }
    }
    if (size > mainSize) { mainSize = size; main = c; }
  }
  const nearestIn = (x, z, sector) => {
    let best = null, bd = Infinity;
    for (const n of graph.nodes) {
      if (comp[n.id] !== main || (sector && n.sector !== sector)) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  };
  const ends = new Set();
  for (const p of level.pois) {
    const own = level.sectors.find((s) => insidePoly(s.poly, p.x, p.z));
    const id = nearestIn(p.x, p.z, own?.id) ?? nearestIn(p.x, p.z, null);
    if (id !== null) ends.add(id);
  }
  const st = nearestIn(level.start.x, level.start.z, null);
  if (st !== null) ends.add(st);
  const list = [...ends];
  const seen = new Set(), out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const path = findPath(graph, list[i], list[j]);
    if (!path) continue;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = Math.min(path[k], path[k + 1]), b = Math.max(path[k], path[k + 1]);
      const key = a * 1e6 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const A = graph.nodes[a], B = graph.nodes[b];
      out.push([[A.x, A.z], [B.x, B.z]]);
    }
  }
  usedCache.set(graph, out);
  return out;
}

/** A bucketed segment index: min distance from a footprint to any segment, looked at within `reach`. */
function segIndex(segs, reach, cell = 2) {
  const cells = new Map();
  for (const seg of segs) {
    const [a, b] = seg;
    const cx0 = Math.floor((Math.min(a[0], b[0]) - reach) / cell), cx1 = Math.floor((Math.max(a[0], b[0]) + reach) / cell);
    const cz0 = Math.floor((Math.min(a[1], b[1]) - reach) / cell), cz1 = Math.floor((Math.max(a[1], b[1]) + reach) / cell);
    for (let i = cx0; i <= cx1; i++) for (let j = cz0; j <= cz1; j++) {
      const k = i * 100003 + j;
      (cells.get(k) ?? cells.set(k, []).get(k)).push(seg);
    }
  }
  return (f) => {
    let d = Infinity;
    const { x0, x1, z0, z1 } = f.box, seen = new Set();
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
      for (const seg of cells.get(i * 100003 + j) ?? []) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        d = Math.min(d, segRectDistance(f, seg[0], seg[1]));
      }
    }
    return d;
  };
}

// ---------------------------------------------------------------------------------------------
// Rooms, their walls and corners.

const ctxCache = new WeakMap();
function context(level, graph) {
  let c = ctxCache.get(graph);
  if (c) return c;
  const edges = openEdges(level);
  const gone = new Set([...edges.dropped, ...edges.parapets, ...edges.lowered.keys()]);
  const live = new Set(graph.nodes.map((n) => n.sector));
  const rooms = level.sectors.filter((s) => !NO_PROPS.some((t) => s.tags.has(t)) && s.ceil - s.floor >= 2 && polyArea(s.poly) >= MIN_ROOM && live.has(s.id));
  const walls = new Map(), corners = new Map();
  for (const s of rooms) {
    const ws = level.walls.filter((w) => w.kind === 'solid' && w.front === s.id && !gone.has(w)).map((w) => {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const u = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
      return { a: w.a, b: w.b, len, u, n: [u[1], -u[0]] };
    }).filter((w) => w.len >= 0.6);
    walls.set(s.id, ws);
    const k = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const cs = [];
    for (const w1 of ws) for (const w2 of ws) {
      if (w1 === w2 || k(w1.b) !== k(w2.a)) continue; // w1 ends where w2 starts: the corner at w1.b
      const v = w1.b, u1 = [-w1.u[0], -w1.u[1]], u2 = w2.u; // along each wall, away from the corner
      if (Math.abs(u1[0] * u2[0] + u1[1] * u2[1]) > 0.05) continue; // right angles only
      if (!insidePoly(s.poly, v[0] + (u1[0] + u2[0]) * 0.1, v[1] + (u1[1] + u2[1]) * 0.1)) continue; // concave from inside
      cs.push({ v, walls: [{ w: w1, u: u1 }, { w: w2, u: u2 }] });
    }
    corners.set(s.id, cs);
  }
  const frames = doorFrames(level);
  const switches = planSwitches(level, frames);
  const consoles = planConsoles(level, switches).map((q) => footprint({ x: q.x + q.nx * CONSOLE_DEPTH / 2, z: q.z + q.nz * CONSOLE_DEPTH / 2, yaw: q.yaw, w: CONSOLE_W, d: CONSOLE_DEPTH }));
  c = { rooms, walls, corners, frames, switches, consoles, nav: segIndex(usedEdges(level, graph), NAV_CLEAR) };
  ctxCache.set(graph, c);
  return c;
}

// ---------------------------------------------------------------------------------------------

/** See the header. Deterministic for a given rng state; never throws on a crowded room (it places fewer). */
export function scatterProps(level, graph, rng, catalogue = CATALOGUE, opts = {}) {
  const ctx = context(level, graph);
  const avoid = opts.avoid ?? [];
  const out = [], fps = [];
  let groupId = 0;
  const entries = [...catalogue].sort((a, b) => ORDER[a.rule] - ORDER[b.rule]);

  const fits = (p, s, group = null, pending = []) => {
    const f = footprint(p);
    // Wholly on this sector's floor: its outline sampled every 10 cm, and no corner of the room inside it.
    for (let i = 0; i < 4; i++) {
      const [ax, az] = f.corners[i], [bx, bz] = f.corners[(i + 1) % 4];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
      for (let k = 0; k < n; k++) if (!insidePoly(s.poly, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)) return null;
    }
    for (const [x, z] of s.poly) if (pointRectDistance(f, x, z) < 0) return null;
    if (ctx.nav(f) < NAV_CLEAR) return null;
    for (const fr of ctx.frames) if (pointRectDistance(f, fr.c[0], fr.c[1]) < fr.width / 2 + DOOR_KEEP) return null;
    for (const q of ctx.switches) if (pointRectDistance(f, q.x, q.z) < SWITCH_KEEP) return null;
    for (const g of ctx.consoles) if (rectGap(f, g) < CONSOLE_KEEP) return null;
    for (const q of level.pois) if (pointRectDistance(f, q.x, q.z) < POI_KEEP) return null;
    for (const a of avoid) if (pointRectDistance(f, a.x, a.z) < a.r) return null;
    for (let i = 0; i < fps.length; i++) {
      const g = rectGap(f, fps[i]);
      if (g < (group !== null && out[i].group === group ? 0 : ITEM_GAP)) return null;
    }
    for (const [, q] of pending) if (rectGap(f, q) < 0) return null; // the cluster's members so far
    return f;
  };
  const make = (e, s, x, z, yaw, scale, extra = {}) => ({
    name: e.name, rule: e.rule, sector: s.id, floor: s.floor, x, y: s.floor + (e.mount ?? 0), z, yaw, scale,
    w: e.footprint[0] * scale, d: e.footprint[1] * scale, spin: e.round ? rng.range(0, Math.PI * 2) : 0,
    ...(e.mount !== undefined ? { mount: e.mount } : {}), ...extra,
  });
  const add = (p, f) => { out.push(p); fps.push(f); };

  // Mounted and leaning items touch their wall; the rest stand a hand's breadth off it at random.
  const flushGap = (e) => (e.mount !== undefined || e.flush ? FLUSH_GAP : null);
  // Candidate spots by rule; each returns a placement or null.
  const onWall = (e, s, scale, extra) => {
    const ws = ctx.walls.get(s.id);
    if (!ws.length) return null;
    const w = e.footprint[0] * scale, d = e.footprint[1] * scale;
    let r = rng.next() * ws.reduce((a, q) => a + q.len, 0), wall = ws[0];
    for (const q of ws) { wall = q; if ((r -= q.len) < 0) break; }
    if (wall.len < w + 0.1) return null;
    const t = rng.range(w / 2 + 0.05, wall.len - w / 2 - 0.05), gap = flushGap(e) ?? rng.range(0.01, 0.035);
    const x = wall.a[0] + wall.u[0] * t + wall.n[0] * (gap + d / 2), z = wall.a[1] + wall.u[1] * t + wall.n[1] * (gap + d / 2);
    return make(e, s, x, z, Math.atan2(wall.n[0], wall.n[1]), scale, { gap, ...extra });
  };
  const inCorner = (e, s, scale, extra) => {
    const cs = ctx.corners.get(s.id);
    if (!cs.length) return null;
    const c = rng.pick(cs);
    const k = rng.int(0, 1), back = c.walls[k], side = c.walls[1 - k];
    const w = e.footprint[0] * scale, d = e.footprint[1] * scale;
    const gb = flushGap(e) ?? rng.range(0.01, 0.035), gs = rng.range(0.01, 0.035);
    // Back onto `back` (the item's x runs along it), a side onto `side`.
    const x = c.v[0] + back.u[0] * (gs + w / 2) + side.u[0] * (gb + d / 2);
    const z = c.v[1] + back.u[1] * (gs + w / 2) + side.u[1] * (gb + d / 2);
    const yaw = Math.atan2(side.u[0], side.u[1]);
    const ax = Math.cos(yaw), az = -Math.sin(yaw);
    const sd = -(back.u[0] * ax + back.u[1] * az) > 0 ? 1 : -1; // which local x side faces the side wall
    return make(e, s, x, z, yaw, scale, { side: sd, gap: gb, ...extra });
  };
  const loose = (e, s, scale, extra) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of s.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const x = rng.range(x0, x1), z = rng.range(z0, z1);
    if (!insidePoly(s.poly, x, z) || edgeDistance(s.poly, x, z) < 0.3) return null;
    return make(e, s, x, z, rng.range(-Math.PI, Math.PI), scale, extra);
  };

  for (const s of ctx.rooms) {
    const k = Math.min(2.5, Math.max(0.5, polyArea(s.poly) / 100));
    for (const e of entries) {
      const n = Math.round(rng.int(e.perRoom[0], e.perRoom[1]) * k);
      for (let i = 0; i < n; i++) {
        const scale = e.vary ? rng.range(0.94, 1.06) : 1;
        if (e.rule !== 'cluster') {
          const spot = e.rule === 'wall' ? onWall : e.rule === 'corner' ? inCorner : loose;
          for (let t = 0; t < TRIES; t++) {
            const p = spot(e, s, scale);
            const f = p && fits(p, s);
            if (f) { add(p, f); break; }
          }
          continue;
        }
        // A cluster: an anchor on a wall, in a corner or loose, then neighbours touching it.
        const g = groupId++;
        const anchor = rng.next();
        const first = anchor < 0.5 ? onWall : anchor < 0.7 ? inCorner : loose;
        const walled = first !== loose;
        let seed = null;
        for (let t = 0; t < TRIES && !seed; t++) {
          const p = first(e, s, scale, { rule: 'cluster', group: g });
          const f = p && fits(p, s, g);
          if (f) seed = [p, f];
        }
        if (!seed) continue;
        delete seed[0].side; // a cluster's anchor is only a cluster member (the corner test is for corner items)
        delete seed[0].gap;
        const members = [seed];
        const want = rng.int(2, 5);
        for (let t = 0; t < TRIES && members.length < want; t++) {
          const [m] = rng.pick(members);
          // A walled group runs along its wall (backs on the wall line); a loose one grows any of the four ways.
          const [du, dv] = rng.pick(walled ? [[1, 0], [-1, 0]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]);
          const sc = e.vary ? rng.range(0.94, 1.06) : 1;
          const w = e.footprint[0] * sc, d = e.footprint[1] * sc;
          const gap = rng.range(TOUCH[0], TOUCH[1]);
          const along = du * (m.w / 2 + w / 2 + gap);
          const across = dv !== 0 ? dv * (m.d / 2 + d / 2 + gap) : (d - m.d) / 2; // same back line
          const ax = Math.cos(m.yaw), az = -Math.sin(m.yaw), bx = Math.sin(m.yaw), bz = Math.cos(m.yaw);
          const p = make(e, s, m.x + ax * along + bx * across, m.z + az * along + bz * across, m.yaw, sc, { rule: 'cluster', group: g });
          const f = fits(p, s, g, members);
          if (f) members.push([p, f]);
        }
        if (members.length < 2) continue;
        for (const [p, f] of members) add(p, f);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The walker's view of the props.

/**
 * { list: footprints, distance(x, z) }: distance in metres to the nearest prop footprint (negative inside),
 * Infinity beyond REACH of every prop (bucketed, cheap enough for the walker's path building).
 */
export function propObstacles(placements, REACH = 3) {
  const list = placements.map(footprint);
  const cell = 2, cells = new Map();
  for (const f of list) {
    for (let i = Math.floor((f.box.x0 - REACH) / cell); i <= Math.floor((f.box.x1 + REACH) / cell); i++) {
      for (let j = Math.floor((f.box.z0 - REACH) / cell); j <= Math.floor((f.box.z1 + REACH) / cell); j++) {
        const k = i * 100003 + j;
        (cells.get(k) ?? cells.set(k, []).get(k)).push(f);
      }
    }
  }
  return {
    list,
    distance(x, z) {
      let d = Infinity;
      for (const f of cells.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) ?? []) d = Math.min(d, pointRectDistance(f, x, z));
      return d;
    },
  };
}

/**
 * A copy of `graph` without the nodes within `node` m of a prop or the edges passing within `edge` m of one
 * (node ids renumbered, dense). The walker plans on it, so no route runs through a prop.
 */
export function blockNav(graph, obstacles, { node = 0.45, edge = 0.3 } = {}) {
  if (!obstacles.list.length) return graph;
  const near = (x, z) => obstacles.distance(x, z);
  const keep = graph.nodes.filter((n) => near(n.x, n.z) >= node);
  const remap = new Map(keep.map((n, i) => [n.id, i]));
  const nodes = keep.map((n, i) => ({ ...n, id: i }));
  const edges = new Map();
  for (const n of keep) {
    const out = [];
    for (const e of graph.edges.get(n.id)) {
      if (!remap.has(e.to)) continue;
      const m = graph.nodes[e.to];
      const L = Math.hypot(m.x - n.x, m.z - n.z), steps = Math.max(1, Math.ceil(L / 0.1));
      let ok = true;
      for (let k = 1; k < steps && ok; k++) if (near(n.x + ((m.x - n.x) * k) / steps, n.z + ((m.z - n.z) * k) / steps) < edge) ok = false;
      if (ok) out.push({ ...e, to: remap.get(e.to) });
    }
    edges.set(remap.get(n.id), out);
  }
  return finish({ nodes, edges });
}

// ---------------------------------------------------------------------------------------------
// Pipes (Ruling R15) and wall decals.

const PIPE_MATS = ['mat:rust', 'mat:steel-brushed', 'paint'];
const PIPE_KEEP = 0.45; // m beyond a door's half width

/**
 * Pipe runs along solid walls of interior rooms and corridors, high enough that nothing passes under them
 * at less than 2.05 m: [{ sector, a, b (centreline ends [x, z]), y, r, off (wall to centreline), n (into the
 * room), brackets: [[x, z]], mat, count, pitch }]. `count` parallel pipes stacked `pitch` apart, downwards
 * from y. Runs stop short of door openings and wall ends, and end in an elbow into the wall (props.js).
 */
export function planPipes(level, rng) {
  const edges = openEdges(level);
  const gone = new Set([...edges.dropped, ...edges.parapets, ...edges.lowered.keys()]);
  const frames = doorFrames(level);
  const out = [];
  for (const w of level.walls) {
    if (w.kind !== 'solid' || gone.has(w)) continue;
    const s = level.byId.get(w.front);
    if (!s || ['slime', 'window', 'door', 'lift', 'sky'].some((t) => s.tags.has(t))) continue;
    const corridor = s.tags.has('corridor');
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 2.2 || rng.next() > (corridor ? 0.7 : 0.4)) continue; // not the short walls of single steps
    const count = rng.next() < 0.5 ? 1 : rng.int(2, 3);
    const r = rng.pick(count > 1 ? [0.025, 0.035] : [0.03, 0.045, 0.06]);
    const pitch = 2 * r + rng.range(0.03, 0.06);
    const height = s.ceil - s.floor;
    // Top pipe just under the ceiling in low rooms; higher rooms put it somewhere between 2.6 m and the ceiling.
    const top = height < 3.2 ? s.ceil - 0.06 - r : s.floor + Math.min(height - 0.3, rng.range(2.6, 4.2));
    const bottom = top - (count - 1) * pitch - r;
    if (bottom < s.floor + 2.05 || top + r > s.ceil - 0.02) continue;
    const u = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len], n = [u[1], -u[0]];
    const off = r + rng.range(0.05, 0.08);
    // Intervals along the wall kept clear of doors (frame centre projected onto the wall line, if close).
    const blocked = [];
    for (const f of frames) {
      const dx = f.c[0] - w.a[0], dz = f.c[1] - w.a[1];
      const t = dx * u[0] + dz * u[1], dist = Math.abs(dx * n[0] + dz * n[1]);
      if (dist < f.width / 2 + 1.5) blocked.push([t - f.width / 2 - PIPE_KEEP - 0.2, t + f.width / 2 + PIPE_KEEP + 0.2]);
    }
    let spans = [[0.15, len - 0.15]];
    for (const [b0, b1] of blocked) spans = spans.flatMap(([a0, a1]) => (b1 <= a0 || b0 >= a1 ? [[a0, a1]] : [[a0, b0], [b1, a1]].filter(([p, q]) => q - p > 0)));
    const mat = rng.pick(PIPE_MATS);
    for (const [t0, t1] of spans) {
      if (t1 - t0 < 1.8) continue;
      const P = (t) => [w.a[0] + u[0] * t + n[0] * off, w.a[1] + u[1] * t + n[1] * off];
      const brackets = [];
      const nb = Math.max(2, Math.ceil((t1 - t0 - 0.3) / 1.5) + 1);
      for (let k = 0; k < nb; k++) brackets.push(P(t0 + 0.15 + ((t1 - t0 - 0.3) * k) / (nb - 1)));
      out.push({ sector: s.id, a: P(t0), b: P(t1), y: top, r, off, n, brackets, mat, count, pitch });
    }
  }
  return out;
}

/**
 * Decals on solid walls: [{ kind: 'grime' | 'corner' | 'leak', sector, x, z (centre at the wall face), nx, nz
 * (into the room), y0 (bottom), w, h, strength, seed, side? }] (a corner decal's `side` is the edge the corner
 * is at: 1 the far end of the wall's direction, -1 the near end). Grime darkens the foot of a wall where the floor meets
 * it, corner shade the meeting of two walls, leaks run down from high up (rust or water).
 */
export function planDecals(level, rng) {
  const edges = openEdges(level);
  const gone = new Set([...edges.dropped, ...edges.parapets, ...edges.lowered.keys()]);
  const out = [];
  const ok = (s) => s && !['slime', 'window', 'door', 'lift', 'sky'].some((t) => s.tags.has(t));
  const put = (kind, s, w0, t, w, y0, h, strength, extra = {}) => {
    const len = Math.hypot(w0.b[0] - w0.a[0], w0.b[1] - w0.a[1]);
    const u = [(w0.b[0] - w0.a[0]) / len, (w0.b[1] - w0.a[1]) / len];
    out.push({ kind, sector: s.id, x: w0.a[0] + u[0] * t, z: w0.a[1] + u[1] * t, nx: u[1], nz: -u[0], y0, w, h, strength, seed: rng.int(1, 0x7fffffff), ...extra });
  };
  const k = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const solids = level.walls.filter((w) => w.kind === 'solid' && !gone.has(w) && ok(level.byId.get(w.front)));
  const startsAt = new Map();
  for (const w of solids) startsAt.set(`${w.front}|${k(w.a)}`, w);
  for (const w of solids) {
    const s = level.byId.get(w.front);
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const height = s.ceil - s.floor;
    if (len < 0.5) continue;
    // Grime along the foot: one to three stretches.
    if (rng.next() < 0.75) {
      for (let i = rng.int(1, 3); i > 0; i--) {
        const gw = Math.min(len - 0.1, rng.range(1, 4));
        if (gw < 0.4) break;
        put('grime', s, w, rng.range(gw / 2 + 0.05, len - gw / 2 - 0.05), gw, s.floor, Math.min(height, rng.range(0.25, 0.7)), rng.range(0.35, 0.7));
      }
    }
    // A corner where this wall ends and the next solid wall of the room begins (an inside corner).
    const next = startsAt.get(`${w.front}|${k(w.b)}`);
    if (next) {
      const u1 = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
      const l2 = Math.hypot(next.b[0] - next.a[0], next.b[1] - next.a[1]);
      const u2 = [(next.b[0] - next.a[0]) / l2, (next.b[1] - next.a[1]) / l2];
      const cross = u1[0] * u2[1] - u1[1] * u2[0];
      const mid = [w.b[0] + (u2[0] - u1[0]) * 0.1, w.b[1] + (u2[1] - u1[1]) * 0.1];
      if (Math.abs(cross) > 0.3 && insidePoly(s.poly, mid[0], mid[1]) && rng.next() < 0.85) {
        const cw = Math.min(rng.range(0.3, 0.6), len / 2, l2 / 2), ch = Math.min(height, rng.range(1.5, height));
        const st = rng.range(0.3, 0.55);
        put('corner', s, w, len - cw / 2, cw, s.floor, ch, st, { side: 1 }); // the corner at its right (u = 1) edge
        put('corner', s, next, cw / 2, cw, s.floor, ch, st, { side: -1 });
      }
    }
    // Leaks: streaks from high on the wall.
    if (len > 1.2 && rng.next() < 0.45) {
      for (let i = rng.int(1, 2); i > 0; i--) {
        const lw = rng.range(0.12, 0.45);
        const topY = s.floor + Math.min(height - 0.05, rng.range(2.0, 4.5));
        const h = Math.min(topY - s.floor, rng.range(0.8, 2.6));
        put('leak', s, w, rng.range(lw / 2 + 0.1, len - lw / 2 - 0.1), lw, topY - h, h, rng.range(0.4, 0.8));
      }
    }
  }
  return out;
}
