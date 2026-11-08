// Hangar — Navigation graph. Pure: no three.js.
//
// Nodes: a 1 m world-aligned grid inside every walkable sector (inset by `radius` from blocking
// walls) plus portal points every ~1 m along each passable shared edge between two sectors.
// Walkable = not `slime`, not `window` (a window sector is a sill between glass panes) and at
// least `minHeadroom` tall (door sectors use `ceil` as their OPEN height, Ruling R1).
// Edge kinds: 'walk' (flat), 'stairs' (floors differ, within maxStep), 'door' (touches a door
// sector), 'lift' (low <-> high ends of a lift). Coordinates are metres, x east / z south.

import { insidePoly } from './level.js';

const GRID = 1.0;
const CELL = 2.0; // spatial hash cell for wall segments
const LIFT_WAIT = 6; // extra path cost (metres) for waiting on a lift
const EPS = 1e-6;


function distToSeg(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

const ekey = (a, b) => `${a[0]},${a[1]}>${b[0]},${b[1]}`;
const isSlime = (s) => s.tags.has('slime');
const isWindow = (s) => s.tags.has('window');

// Wall segments that stop a walker: solid edges and edges to slime/window/too-low sectors.
// Cached per level and headroom; wall lookup is bucketed in CELL-metre cells.
const blockCache = new WeakMap();
function blockers(level, minHeadroom = 2.0) {
  let per = blockCache.get(level);
  if (!per) blockCache.set(level, (per = new Map()));
  if (per.has(minHeadroom)) return per.get(minHeadroom);
  const ok = (s) => !isSlime(s) && !isWindow(s) && s.ceil - s.floor >= minHeadroom - EPS;
  const owner = new Map();
  for (const s of level.sectors) s.poly.forEach((a, k) => owner.set(ekey(a, s.poly[(k + 1) % s.poly.length]), s));
  const segs = [];
  for (const s of level.sectors) {
    if (!ok(s)) continue;
    s.poly.forEach((a, k) => {
      const b = s.poly[(k + 1) % s.poly.length];
      const t = owner.get(ekey(b, a));
      if (!t || !ok(t)) segs.push([a, b]);
    });
  }
  const cells = new Map();
  const add = (cx, cz, seg) => {
    const k = cx * 100003 + cz;
    (cells.get(k) ?? cells.set(k, []).get(k)).push(seg);
  };
  for (const seg of segs) {
    const [a, b] = seg;
    const x0 = Math.floor((Math.min(a[0], b[0]) - CELL) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + CELL) / CELL);
    const z0 = Math.floor((Math.min(a[1], b[1]) - CELL) / CELL), z1 = Math.floor((Math.max(a[1], b[1]) + CELL) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) add(cx, cz, seg);
  }
  const res = { segs, cells };
  per.set(minHeadroom, res);
  return res;
}

/**
 * Distance in metres from (x, z) to the nearest solid wall or slime/window edge.
 * Exact up to CELL metres; beyond that it falls back to a full scan.
 */
export function clearanceAt(level, x, z, minHeadroom = 2.0) {
  const { segs, cells } = blockers(level, minHeadroom);
  let best = Infinity;
  const near = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
  if (near) for (const [a, b] of near) best = Math.min(best, distToSeg(x, z, a, b));
  if (best <= CELL) return best;
  for (const [a, b] of segs) best = Math.min(best, distToSeg(x, z, a, b));
  return best;
}

export function buildNavGraph(level, { radius = 0.4, maxStep = 0.72, minHeadroom = 2.0 } = {}) {
  const walkable = (s) => !isSlime(s) && !isWindow(s) && s.ceil - s.floor >= minHeadroom - EPS;
  const clear = (x, z) => clearanceAt(level, x, z, minHeadroom);
  const nodes = [];
  const edges = new Map();
  const bySector = new Map(); // sector id -> { grid: [], portals: [] }
  const entry = (id) => bySector.get(id) ?? bySector.set(id, { grid: [], portals: [] }).get(id);

  const addNode = (x, z, floor, sector) => {
    const n = { id: nodes.length, x, z, floor, sector };
    nodes.push(n);
    edges.set(n.id, []);
    return n;
  };
  const seen = new Set();
  const link = (a, b, kind, cost) => {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.get(a.id).push({ to: b.id, cost, kind });
    edges.get(b.id).push({ to: a.id, cost, kind });
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const kindOf = (a, b, sa, sb) => {
    if (sa.tags.has('door') || sb.tags.has('door')) return 'door';
    return Math.abs(a.floor - b.floor) > 0.01 ? 'stairs' : 'walk';
  };
  // Straight run inside one sector, sampled every 0.25 m.
  // skipA/skipB drop the end samples: portal points sit on the polygon boundary, where the
  // inside test is unreliable.
  const runInside = (s, a, b, needClear, skipA = false, skipB = false) => {
    const n = Math.max(2, Math.ceil(dist(a, b) / 0.25));
    for (let i = skipA ? 1 : 0; i <= (skipB ? n - 1 : n); i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (!insidePoly(s.poly, x, z)) return false;
      if (needClear && clear(x, z) < radius - 0.05) return false;
    }
    return true;
  };

  // 1. Grid nodes.
  const walk = level.sectors.filter(walkable);
  for (const s of walk) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of s.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const e = entry(s.id);
    for (let gx = Math.ceil(x0 / GRID); gx * GRID <= x1; gx++) {
      for (let gz = Math.ceil(z0 / GRID); gz * GRID <= z1; gz++) {
        const x = gx * GRID, z = gz * GRID;
        if (insidePoly(s.poly, x, z) && clear(x, z) >= radius) e.grid.push(addNode(x, z, s.floor, s.id));
      }
    }
  }

  // 2. Walk edges between neighbouring grid nodes of the same sector.
  for (const s of walk) {
    const { grid } = entry(s.id);
    const at = new Map(grid.map((n) => [`${Math.round(n.x / GRID)},${Math.round(n.z / GRID)}`, n]));
    for (const n of grid) {
      const gx = Math.round(n.x / GRID), gz = Math.round(n.z / GRID);
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const m = at.get(`${gx + dx},${gz + dz}`);
        if (m && runInside(s, n, m, true)) link(n, m, kindOf(n, m, s, s), dist(n, m));
      }
    }
  }

  // 3. Portal points along passable shared edges.
  const owner = new Map();
  level.sectors.forEach((s, i) => s.poly.forEach((a, k) => owner.set(ekey(a, s.poly[(k + 1) % s.poly.length]), i)));
  const liftOf = new Map(level.lifts.map((l) => [l.sector, l]));
  const liftTops = []; // { lift sector, portal node }
  level.sectors.forEach((s, i) => {
    if (!walkable(s)) return;
    s.poly.forEach((a, k) => {
      const b = s.poly[(k + 1) % s.poly.length];
      const j = owner.get(ekey(b, a));
      if (j === undefined || j < i) return;
      const t = level.sectors[j];
      if (!walkable(t)) return;
      // Physical opening (Ruling R8): a lintel under 2 m would graze the 1.7 m eye.
      const headroom = Math.min(s.ceil, t.ceil) - Math.max(s.floor, t.floor);
      const step = Math.abs(s.floor - t.floor);
      const passable = step <= maxStep + EPS && headroom >= minHeadroom - EPS;
      // A lift sector meets its high landing with a step too tall to walk: the lift covers it.
      const lift = liftOf.get(s.id) ?? liftOf.get(t.id);
      const liftEdge = lift && !passable && headroom >= minHeadroom - EPS &&
        Math.abs((liftOf.has(s.id) ? t : s).floor - lift.high) < 0.05;
      if (!passable && !liftEdge) return;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cnt = Math.max(1, Math.round(len / GRID));
      const made = [];
      for (let q = 0; q < cnt; q++) {
        const f = (q + 0.5) / cnt, x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        if (clear(x, z) < radius - EPS) continue;
        const hi = s.floor >= t.floor ? s : t;
        const p = addNode(x, z, hi.floor, hi.id);
        made.push(p);
        if (passable) { entry(s.id).portals.push(p); entry(t.id).portals.push(p); }
      }
      if (liftEdge && made.length) {
        // One lift connection per landing: use the point with the most clearance.
        const top = made.reduce((m, p) => (clear(p.x, p.z) > clear(m.x, m.z) ? p : m));
        const landing = liftOf.has(s.id) ? t : s;
        top.sector = landing.id;
        entry(landing.id).portals.push(top);
        liftTops.push({ lift: liftOf.has(s.id) ? s : t, top });
        for (const p of made) if (p !== top) { edges.delete(p.id); p.dead = true; }
      }
    });
  });

  // 4. Link portal points to the grid nodes of each sector they touch (or to each other in thin
  //    sectors such as doors that have no grid node of their own).
  for (const s of walk) {
    const { grid, portals } = entry(s.id);
    const ps = portals.filter((p) => !p.dead);
    for (const p of ps) {
      const mine = grid.filter((n) => runInside(s, p, n, false, true)).sort((u, v) => dist(p, u) - dist(p, v));
      const near = mine.filter((n) => dist(p, n) <= 1.6);
      for (const n of near.length ? near : mine.slice(0, 1)) {
        // The portal's floor is its higher side, so the kind follows the real floor difference.
        link(p, n, kindOf(p, n, s, s), dist(p, n));
      }
    }
    if (!grid.length) {
      for (let u = 0; u < ps.length; u++) for (let v = u + 1; v < ps.length; v++) {
        const d = dist(ps[u], ps[v]);
        if (d > 0.01 && d <= 8 && runInside(s, ps[u], ps[v], false, true, true)) link(ps[u], ps[v], kindOf(ps[u], ps[v], s, s), d);
      }
    }
  }

  // 5. Lifts: the low end is the nearest grid node of the lift sector (or its centroid).
  for (const { lift: ls, top } of liftTops) {
    const { grid } = entry(ls.id);
    let low = grid.slice().sort((u, v) => dist(top, u) - dist(top, v))[0];
    if (!low) {
      const cx = ls.poly.reduce((a, p) => a + p[0], 0) / ls.poly.length;
      const cz = ls.poly.reduce((a, p) => a + p[1], 0) / ls.poly.length;
      low = addNode(cx, cz, ls.floor, ls.id);
    }
    link(low, top, 'lift', dist(low, top) + LIFT_WAIT);
  }

  // Drop dead (unused lift-landing) points from the arrays, keeping ids dense.
  const keep = nodes.filter((n) => !n.dead);
  if (keep.length !== nodes.length) {
    const remap = new Map(keep.map((n, i) => [n.id, i]));
    const e2 = new Map();
    for (const n of keep) e2.set(remap.get(n.id), edges.get(n.id).map((e) => ({ ...e, to: remap.get(e.to) })));
    keep.forEach((n, i) => { n.id = i; });
    return finish({ nodes: keep, edges: e2 });
  }
  return finish({ nodes, edges });
}

// Spatial hash for nearestNode (not enumerable, so the graph stays plain data). Exported for graphs derived
// from this one (scatter.blockNav).
const HASH = 4;
export function finish(graph) {
  const cells = new Map();
  for (const n of graph.nodes) {
    const k = Math.floor(n.x / HASH) * 100003 + Math.floor(n.z / HASH);
    (cells.get(k) ?? cells.set(k, []).get(k)).push(n);
  }
  Object.defineProperty(graph, 'hash', { value: cells, enumerable: false });
  return graph;
}

/** Nearest node to (x, z); with floorY, height difference counts as distance. */
export function nearestNode(graph, x, z, floorY) {
  if (!graph.nodes.length) return null;
  const cells = graph.hash;
  const cx = Math.floor(x / HASH), cz = Math.floor(z / HASH);
  let best = null, bd = Infinity;
  for (let r = 0; r < 4000; r++) {
    // Anything in ring r is at least (r - 1) * HASH away.
    if (best && (r - 1) * HASH > bd) break;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const list = cells.get((cx + i) * 100003 + (cz + j));
      if (!list) continue;
      for (const n of list) {
        const dy = floorY === undefined ? 0 : n.floor - floorY;
        const d = Math.hypot(n.x - x, n.z - z, dy);
        if (d < bd) { bd = d; best = n; }
      }
    }
    if (!best && r > 3900) break;
  }
  return best ? best.id : null;
}

/** A* over the graph; returns node ids from `fromId` to `toId`, or null if not connected. */
export function findPath(graph, fromId, toId) {
  const { nodes, edges } = graph;
  if (!nodes[fromId] || !nodes[toId]) return null;
  if (fromId === toId) return [fromId];
  const T = nodes[toId];
  const h = (n) => Math.hypot(n.x - T.x, n.z - T.z);
  const g = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  // Binary min-heap of [f, id].
  const heap = [[h(nodes[fromId]), fromId]];
  const push = (it) => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [, id] = pop();
    if (done.has(id)) continue;
    if (id === toId) {
      const path = [id];
      while (prev.has(path[0])) path.unshift(prev.get(path[0]));
      return path;
    }
    done.add(id);
    for (const e of edges.get(id)) {
      const ng = g.get(id) + e.cost;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        prev.set(e.to, id);
        push([ng + h(nodes[e.to]), e.to]);
      }
    }
  }
  return null;
}
