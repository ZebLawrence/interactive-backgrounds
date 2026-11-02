// Hangar — Walker: a camera that tours the base on foot. Pure: no three.js.
//
// A leg runs from where the walker stands to a node: the A* node path is string-pulled (kept
// clear of walls and ledges), lightly meandered, smoothed with a centripetal Catmull-Rom spline,
// pushed off the walls and sampled every ~0.1 m. Speed follows a profile built backwards from
// the end (≤ 0.4 m/s² either way), slowing through sharp turns and on stairs. The body yaw follows
// the path tangent through a critically damped spring; the head (Pose.yaw) looks ahead along the
// path, glances aside now and then and leans toward the cursor. Units: metres, x east, z south;
// yaw 0 looks north (-z) and grows to the left, like a three.js camera's rotation.y.
//
// A lift edge splits a leg into pieces: walk to the boarding point, call the lift, step on, ride,
// walk off. Doors: a closed door (opts.doors.isOpen(sectorId) false) makes the walker stop short
// of it and wait; by default every door is open and the lift is simulated here.

import { sectorAt } from './level.js';
import { nearestNode, findPath, clearanceAt } from './navgraph.js';

const EYE = 1.7;
const CRUISE = 0.85, VARY = 0.15;
const ACCEL = 0.4, DECEL = 0.35; // the speed profile brakes a little gentler than the limit
const TURN_SPEED = 0.4, TURN_LO = 20, TURN_HI = 45; // degrees of heading change over TURN_WIN
const TURN_WIN = 0.8; // metres either side of a sample
const STAIR_SPEED = 0.5, STAIR_WIN = 0.6;
const CLEAR_MIN = 0.35, CLEAR_PUSH = 0.5, CLEAR_LOS = 0.45;
const MAX_STEP = 0.72;
const SAMPLE = 0.1;
const BOB = 0.025, SWAY = 0.012, STRIDE = 0.65;
const BODY_TAU = 0.6, HEAD_TAU = 0.32, PITCH_TAU = 0.5, BIAS_TAU = 1.2, Y_TAU = 0.12;
const LOOK_AHEAD = 1.2; // seconds
const HEAD_RATE = (88 * Math.PI) / 180; // just under the 90°/s limit
const PITCH_RATE = (60 * Math.PI) / 180;
const GAZE_YAW = (15 * Math.PI) / 180, GAZE_PITCH = (10 * Math.PI) / 180;
const LIFT_SPEED = 0.45;
const DOOR_STOP = 0.9; // metres short of a closed door
const MAX_DT = 1 / 15;
const DEG = Math.PI / 180;

const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const headingOf = (dx, dz) => Math.atan2(-dx, -dz);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Critically damped spring step for value `s.x` with velocity `s.v` toward `target`. */
function spring(s, target, tau, dt, maxRate = Infinity) {
  const w = 1 / tau;
  const err = s.x - target;
  // Exact solution of x'' = -w²(x - t) - 2w x' over dt.
  const e = Math.exp(-w * dt);
  const c = s.v + w * err;
  const nx = target + (err + c * dt) * e;
  let nv = (s.v - w * c * dt) * e;
  let dx = nx - s.x;
  if (Math.abs(dx) > maxRate * dt) { dx = Math.sign(dx) * maxRate * dt; nv = clamp(nv, -maxRate, maxRate); }
  s.x += dx;
  s.v = nv;
}

// ---------------------------------------------------------------------------------------------
// Per-level caches: main connected component and the node each poi is reached at.

const cache = new WeakMap();
function infoFor(level, graph) {
  let per = cache.get(graph);
  if (per) return per;
  // Largest connected component (the outdoor ring and the ledge have nodes but no route in).
  const comp = new Int32Array(graph.nodes.length).fill(-1);
  const sizes = [];
  for (const n of graph.nodes) {
    if (comp[n.id] >= 0) continue;
    const c = sizes.length, stack = [n.id];
    comp[n.id] = c;
    let size = 0;
    while (stack.length) {
      const id = stack.pop();
      size++;
      for (const e of graph.edges.get(id)) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const inMain = (id) => comp[id] === main;
  const poiNode = new Map();
  for (const p of level.pois) {
    const own = sectorAt(level, p.x, p.z);
    let best = null, bd = Infinity;
    for (const n of graph.nodes) {
      if (!inMain(n.id) || !own || n.sector !== own.id) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < bd) { bd = d; best = n.id; }
    }
    if (best === null) best = nearestNode(graph, p.x, p.z);
    if (best !== null && inMain(best)) poiNode.set(p, best);
  }
  const lifts = new Map(level.lifts.map((l) => [l.sector, l]));
  per = { inMain, poiNode, lifts };
  cache.set(graph, per);
  return per;
}

/**
 * Where a click on the world sends the walker: the nearest reachable node within 3 m
 * horizontally of the hit and at a plausible height (a hit high in the sky, or on a pool floor
 * far from any walkway, gives null).
 */
export function resolveClickTarget(level, graph, hit) {
  if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.z)) return null;
  const { inMain } = infoFor(level, graph);
  const y = Number.isFinite(hit.y) ? hit.y : null;
  const H = 4, R = 3;
  let best = null, bs = Infinity;
  const cx = Math.floor(hit.x / H), cz = Math.floor(hit.z / H);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = graph.hash.get((cx + i) * 100003 + (cz + j));
    if (!list) continue;
    for (const n of list) {
      const h = Math.hypot(n.x - hit.x, n.z - hit.z);
      if (h > R || !inMain(n.id)) continue;
      let score = h;
      if (y !== null) {
        const dy = y - n.floor;
        if (dy < -1.0 || dy > 3.0) continue; // far below the floor, or up in the sky / on a ceiling
        score += 0.5 * Math.max(0, Math.abs(dy) - 0.1);
      }
      if (score < bs) { bs = score; best = n; }
    }
  }
  return best ? { x: best.x, z: best.z } : null;
}

// ---------------------------------------------------------------------------------------------
// Path building

function centripetal(p0, p1, p2, p3, out) {
  const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / SAMPLE));
  for (let k = 1; k <= n; k++) {
    const t = t1 + ((t2 - t1) * k) / n;
    const pt = [0, 0];
    for (let c = 0; c < 2; c++) {
      const a1 = ((t1 - t) * p0[c] + (t - t0) * p1[c]) / (t1 - t0);
      const a2 = ((t2 - t) * p1[c] + (t - t1) * p2[c]) / (t2 - t1);
      const a3 = ((t3 - t) * p2[c] + (t - t2) * p3[c]) / (t3 - t2);
      const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
      const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
      pt[c] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
    }
    out.push(pt);
  }
}

class PathBuilder {
  constructor(level, rng, liftSector, liftFloor) {
    this.level = level;
    this.rng = rng;
    this.liftSector = liftSector;
    this.liftFloor = liftFloor;
  }

  sector(x, z) { return sectorAt(this.level, x, z); }

  floorOf(s) { return s.id === this.liftSector ? this.liftFloor : s.floor; }

  walkable(s) {
    return s && !s.tags.has('slime') && !s.tags.has('window') && s.ceil - s.floor >= 2.0 - 1e-6;
  }

  /** Straight walk from a to b stays clear of walls and never steps over a ledge. */
  los(a, b, need = CLEAR_LOS) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 0.2));
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[1] + ((b[1] - a[1]) * i) / n;
      if (i > 0 && i < n && clearanceAt(this.level, x, z) < need) return false;
      const s = this.sector(x, z);
      if (!s) continue; // exactly on a boundary
      if (!this.walkable(s)) return false;
      const f = this.floorOf(s);
      if (prev !== null && Math.abs(f - prev) > MAX_STEP + 1e-6) return false;
      prev = f;
    }
    return true;
  }

  /** Control points: string-pulled, with gentle sideways meander on long straights. */
  controls(pts) {
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      for (let k = pts.length - 1; k > i + 1; k--) if (this.los(pts[i], pts[k])) { j = k; break; }
      const a = pts[i], b = pts[j];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 5) {
        const m = Math.floor(len / 3.5);
        const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
        let last = a;
        for (let q = 1; q < m; q++) {
          const f = q / m, off = this.rng.range(-0.35, 0.35);
          const c = [a[0] + (b[0] - a[0]) * f + nx * off, a[1] + (b[1] - a[1]) * f + nz * off];
          if (clearanceAt(this.level, c[0], c[1]) >= 0.7 && this.los(last, c) && this.los(c, b)) { out.push(c); last = c; }
        }
      }
      out.push(b);
      i = j;
    }
    return out;
  }

  push(p, ref) {
    let [x, z] = p;
    for (let it = 0; it < 6; it++) {
      const c = clearanceAt(this.level, x, z);
      if (c >= CLEAR_PUSH) break;
      const h = 0.02;
      const gx = (clearanceAt(this.level, x + h, z) - clearanceAt(this.level, x - h, z)) / (2 * h);
      const gz = (clearanceAt(this.level, x, z + h) - clearanceAt(this.level, x, z - h)) / (2 * h);
      const g = Math.hypot(gx, gz);
      if (!(g > 1e-6)) break;
      const nx = x + (gx / g) * (CLEAR_PUSH - c + 0.01), nz = z + (gz / g) * (CLEAR_PUSH - c + 0.01);
      const s = this.sector(nx, nz);
      if (!this.walkable(s) || (ref && Math.abs(this.floorOf(s) - this.floorOf(ref)) > MAX_STEP)) break;
      x = nx; z = nz;
    }
    p[0] = x; p[1] = z;
  }

  /** Dense, smoothed, wall-clear samples through `pts` ([x, z] pairs, first = start). */
  build(pts, cruise) {
    // Drop near-duplicate points.
    const clean = [pts[0]];
    for (const p of pts.slice(1)) {
      const q = clean[clean.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) clean.push(p);
    }
    if (clean.length === 1) clean.push([clean[0][0], clean[0][1]]);
    const cp = this.controls(clean);
    let samples = [[cp[0][0], cp[0][1]]];
    for (let i = 0; i < cp.length - 1; i++) {
      const p1 = cp[i], p2 = cp[i + 1];
      const p0 = cp[i - 1] ?? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
      const p3 = cp[i + 2] ?? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
      centripetal(p0, p1, p2, p3, samples);
    }
    // Push off the walls, smooth the kinks the push made, push again.
    const refs = samples.map(([x, z]) => this.sector(x, z));
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < samples.length - 1; i++) this.push(samples[i], refs[i]);
      if (round === 2) break;
      for (let pass = 0; pass < 2; pass++) {
        const prev = samples.map((p) => [p[0], p[1]]);
        for (let i = 1; i < samples.length - 1; i++) {
          samples[i][0] = 0.25 * prev[i - 1][0] + 0.5 * prev[i][0] + 0.25 * prev[i + 1][0];
          samples[i][1] = 0.25 * prev[i - 1][1] + 0.5 * prev[i][1] + 0.25 * prev[i + 1][1];
        }
      }
    }
    samples = samples.filter((p, i) => i === 0 || Math.hypot(p[0] - samples[i - 1][0], p[1] - samples[i - 1][1]) > 1e-4 || i === samples.length - 1);
    return this.profile(samples, cruise);
  }

  profile(samples, cruise) {
    const n = samples.length;
    const xs = new Float64Array(n), zs = new Float64Array(n), ss = new Float64Array(n);
    const floors = new Float64Array(n), vmax = new Float64Array(n), hd = new Float64Array(n);
    const sectors = new Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = samples[i][0]; zs[i] = samples[i][1];
      if (i > 0) ss[i] = ss[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    }
    let lastS = null;
    for (let i = 0; i < n; i++) {
      const s = this.sector(xs[i], zs[i]) ?? lastS ?? this.sector(xs[i] + 0.01, zs[i] + 0.01);
      sectors[i] = s; lastS = s;
    }
    for (let i = 0; i < n; i++) if (!sectors[i]) sectors[i] = sectors.find(Boolean);
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = sectors[i] ? this.floorOf(sectors[i]) : 0;
    // Floor smoothed along the path (a triangle filter about 1.2 m wide), ends pinned.
    const box = (src, half) => {
      const out = new Float64Array(n);
      let lo = 0, hi = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        while (hi < n && ss[hi] <= ss[i] + half) sum += src[hi++];
        while (ss[lo] < ss[i] - half) sum -= src[lo++];
        out[i] = sum / (hi - lo);
      }
      return out;
    };
    const sm = box(box(raw, 0.3), 0.3);
    const pin = 0.6;
    for (let i = 0; i < n; i++) {
      const fromEnd = Math.min(ss[i], ss[n - 1] - ss[i]);
      const k = clamp(fromEnd / pin, 0, 1);
      floors[i] = raw[i] + (sm[i] - raw[i]) * k;
    }
    for (let i = 0; i < n - 1; i++) hd[i] = headingOf(xs[i + 1] - xs[i], zs[i + 1] - zs[i]);
    hd[n - 1] = n > 1 ? hd[n - 2] : 0;
    // Speed limits: cruise, turns, stairs; then brake backwards from a stop at the end.
    let a = 0, b = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      while (ss[a] < ss[i] - TURN_WIN) a++;
      while (b < n - 1 && ss[b + 1] <= ss[i] + TURN_WIN) b++;
      // Total absolute turning inside the window.
      let turn = 0;
      for (let k = Math.max(a, 1); k <= Math.min(b, n - 2); k++) turn += Math.abs(wrap(hd[k] - hd[k - 1]));
      const t = clamp((turn / DEG - TURN_LO) / (TURN_HI - TURN_LO), 0, 1);
      let v = cruise + (Math.min(cruise, TURN_SPEED) - cruise) * t;
      while (ss[sa] < ss[i] - STAIR_WIN) sa++;
      while (sb < n - 1 && ss[sb + 1] <= ss[i] + STAIR_WIN) sb++;
      if (Math.abs(raw[sa] - raw[sb]) > 0.01 || Math.abs(raw[i] - raw[sa]) > 0.01) v = Math.min(v, STAIR_SPEED);
      vmax[i] = v;
    }
    vmax[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] ** 2 + 2 * DECEL * (ss[i + 1] - ss[i])));
    // Door runs: index of the first sample of each stretch inside a door sector.
    const doors = [];
    for (let i = 0; i < n; i++) {
      const s = sectors[i];
      if (s?.tags.has('door') && (i === 0 || sectors[i - 1] !== s)) doors.push({ i, s: ss[i], sector: s.id });
    }
    return { kind: 'walk', n, xs, zs, ss, floors, vmax, hd, sectors, doors, len: ss[n - 1] };
  }
}

// ---------------------------------------------------------------------------------------------

export class Walker {
  constructor(level, graph, tour, rng, opts = {}) {
    this.level = level;
    this.graph = graph;
    this.tour = tour;
    this.rng = rng;
    this.doors = opts.doors ?? { isOpen: () => true };
    this.lift = opts.lift ?? null;
    this.info = infoFor(level, graph);
    this.liftY = new Map(level.lifts.map((l) => [l.sector, l.low]));

    const st = level.start;
    const s0 = sectorAt(level, st.x, st.z);
    this.x = st.x; this.z = st.z;
    this.floor = s0 ? s0.floor : 0;
    this.speed = 0;
    this.body = { x: st.yaw, v: 0 };
    this.head = { x: st.yaw, v: 0 };
    this.pitchS = { x: 0, v: 0 };
    this.biasYaw = { x: 0, v: 0 };
    this.biasPitch = { x: 0, v: 0 };
    this.yS = { x: this.floor + EYE, v: 0 };
    this.bobAmp = { x: 0, v: 0 };
    this.phase = 0;
    this.time = 0;
    this.wob = [rng.range(0, 6.28), rng.range(0, 6.28)];

    this.baseState = 'pausing';
    this.target = null; // the poi of the current leg (null for a click)
    this.pieces = [];
    this.piece = null;
    this.s = 0;
    this.idx = 0;
    this.cruise = CRUISE;
    this.leg = null;
    this.pauseT = rng.range(1.5, 3);
    this.pauseLen = this.pauseT;
    this.lookPoint = null;
    this.attn = null; // { point, t } while looking at a rested-cursor point
    this.pendingGoal = null;
    this.glance = 0;
    this.glanceT = rng.range(6, 15);
    this.glanceHold = 0;
    this.ride = null;
    this.lastPoi = null;
    this.pose = { x: this.x, y: this.yS.x, z: this.z, yaw: st.yaw, pitch: 0, roll: 0 };
  }

  get state() { return this.attn ? 'looking' : this.baseState; }

  /** Walk to the node nearest (x, z), then resume touring from there. */
  goTo(x, z) {
    const id = nearestNode(this.graph, x, z);
    if (id === null || !this.info.inMain(id)) return false;
    this.pendingGoal = { id, poi: null };
    this.attn = null;
    if (this.baseState === 'pausing') this.pauseT = 0;
    return true;
  }

  // MARK: planning

  startNode() {
    const g = this.graph, H = 4;
    const cx = Math.floor(this.x / H), cz = Math.floor(this.z / H);
    const cand = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const n of g.hash.get((cx + i) * 100003 + (cz + j)) ?? []) {
        if (!this.info.inMain(n.id) || Math.abs(n.floor - this.floor) > MAX_STEP) continue;
        cand.push([Math.hypot(n.x - this.x, n.z - this.z), n]);
      }
    }
    cand.sort((a, b) => a[0] - b[0]);
    const pb = new PathBuilder(this.level, this.rng, null, 0);
    for (const [d, n] of cand.slice(0, 8)) if (d < 0.05 || pb.los([this.x, this.z], [n.x, n.z], CLEAR_MIN)) return n.id;
    return cand.length ? cand[0][1].id : nearestNode(g, this.x, this.z, this.floor);
  }

  /** Plan pieces from here to node `goal`. Returns false when there is no route. */
  plan(goal, poi) {
    const from = this.startNode();
    if (from === null) return false;
    const ids = findPath(this.graph, from, goal);
    if (!ids) return false;
    const nodes = this.graph.nodes;
    const kindOf = (a, b) => this.graph.edges.get(a).find((e) => e.to === b)?.kind;
    this.cruise = Math.min(CRUISE * (1 + this.rng.range(-VARY, VARY)), 0.98);
    const pieces = [];
    let pts = [[this.x, this.z]];
    let liftCtx = { sector: null, floor: 0 }; // lift height the current walk piece sees
    const flush = () => {
      const pb = new PathBuilder(this.level, this.rng, liftCtx.sector, liftCtx.floor);
      pieces.push(pb.build(pts, this.cruise));
    };
    let segStart = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const next = ids[k + 1];
      if (next !== undefined && kindOf(id, next) === 'lift') {
        // id and next are the two ends; the low end lies inside the lift sector.
        const a = nodes[id], b = nodes[next];
        const liftSec = this.info.lifts.has(a.sector) ? a.sector : b.sector;
        const lift = this.info.lifts.get(liftSec);
        const low = a.sector === liftSec ? a : b;
        const up = a === low;
        const from = up ? lift.low : lift.high, to = up ? lift.high : lift.low;
        // Board from the last node before the walker would set foot in the lift sector.
        const onLift = (n) => n.sector === liftSec || sectorAt(this.level, n.x, n.z)?.id === liftSec;
        let board = k;
        while (board > segStart && onLift(nodes[ids[board]])) board--;
        const before = ids.slice(segStart, board + 1).map((q) => [nodes[q].x, nodes[q].z]);
        const onto = ids.slice(board, up ? k + 1 : k + 2).map((q) => [nodes[q].x, nodes[q].z]);
        pts.push(...before);
        liftCtx = { sector: liftSec, floor: from };
        flush();
        // Face the lift while it comes, and the way off it while riding.
        const off = nodes[ids[up ? k + 1 : k + 2] ?? next];
        pieces.push({ kind: 'call', lift: liftSec, h: from, face: { x: low.x, z: low.z } });
        pts = onto;
        if (pts.length > 1) flush();
        pieces.push({ kind: 'ride', lift: liftSec, from, to, x: low.x, z: low.z, face: { x: off.x, z: off.z } });
        liftCtx = { sector: liftSec, floor: to };
        pts = [[low.x, low.z]];
        segStart = up ? k + 1 : k + 2;
        if (!up) k++; // the low node is already in pts
        continue;
      }
    }
    pts.push(...ids.slice(segStart).map((q) => [nodes[q].x, nodes[q].z]));
    flush();
    this.pieces = pieces.filter((p) => p.kind !== 'walk' || p.len > 0.02);
    this.target = poi;
    this.leg = { poi, goal: { x: nodes[goal].x, z: nodes[goal].z } };
    this.nextPiece();
    return true;
  }

  nextPiece() {
    this.piece = this.pieces.shift() ?? null;
    this.s = 0;
    this.idx = 0;
    if (!this.piece) { this.arrive(); return; }
    if (this.piece.kind === 'walk') this.baseState = 'walking';
    else this.startRide(this.piece);
  }

  startRide(p) {
    this.baseState = 'riding';
    const cur = this.liftY.get(p.lift);
    const target = p.kind === 'call' ? p.h : p.to;
    const start = p.kind === 'call' ? cur : p.from;
    const dur = Math.abs(target - start) / LIFT_SPEED * 1.3 + (p.kind === 'ride' ? 0.8 : 0);
    this.ride = { t: 0, dur, start, target, done: !this.lift, promise: null, wait: p.kind === 'ride' ? 0.8 : 0.3 };
    if (this.lift) {
      const fn = p.kind === 'call' ? this.lift.call ?? (() => Promise.resolve()) : this.lift.ride;
      const r = this.ride;
      Promise.resolve(fn.call(this.lift, start, target)).then(() => { r.done = true; }, () => { r.done = true; });
    }
  }

  arrive() {
    this.baseState = 'pausing';
    const poi = this.leg?.poi ?? null;
    if (poi) {
      this.lastPoi = poi;
      this.lookPoint = { x: poi.look[0], y: poi.look[1], z: poi.look[2] };
      this.pauseT = this.rng.range(4, 12);
    } else {
      const f = this.body.x;
      this.lookPoint = { x: this.x - Math.sin(f) * 6, y: this.floor + EYE, z: this.z - Math.cos(f) * 6 };
      this.pauseT = this.rng.range(3, 6);
    }
    this.pauseLen = this.pauseT;
    const s = sectorAt(this.level, this.x, this.z);
    this.tall = !!s && (s.tags.has('sky') || s.ceil - s.floor > 3 * EYE);
  }

  nextLeg() {
    if (this.pendingGoal) {
      const g = this.pendingGoal;
      this.pendingGoal = null;
      if (this.plan(g.id, g.poi)) return;
    }
    const from = this.leg?.poi ?? this.lastPoi ?? null;
    const here = { x: this.x, z: this.z };
    const at = this.leg && !this.leg.poi ? here : from ?? here;
    for (let tries = 0; tries < 8; tries++) {
      const poi = this.tour.next(tries === 0 ? at : here);
      const goal = this.info.poiNode.get(poi);
      if (goal === undefined) continue;
      const g = this.graph.nodes[goal];
      if (Math.hypot(g.x - this.x, g.z - this.z) < 1.0) continue;
      if (this.plan(goal, poi)) return;
    }
    this.baseState = 'pausing';
    this.pauseT = 2;
    this.pauseLen = 2;
  }

  // MARK: stepping

  step(dt, input) {
    dt = clamp(finite(dt, 0), 0, MAX_DT);
    const inp = input ?? {};
    this.time += dt;
    if (inp.click && Number.isFinite(inp.click.x) && Number.isFinite(inp.click.z)) this.goTo(inp.click.x, inp.click.z);
    const r = inp.restedAt;
    if (r && Number.isFinite(r.x) && Number.isFinite(r.z) && this.baseState !== 'riding') {
      this.attn = { point: { x: r.x, y: finite(r.y, this.floor + EYE), z: r.z }, t: 4 };
    }

    let targetSpeed = 0;
    let tangent = this.body.x;
    let headTarget = this.head.x;
    let pitchTarget = 0;
    const eye = this.yS.x;

    if (this.baseState === 'walking') {
      const p = this.piece;
      tangent = this.tangentAt(this.idx);
      // Speed: profile at s, waiting for closed doors, slower while the body is still turning.
      let v = this.profileAt(p, this.s);
      const wobble = 0.965 + 0.035 * Math.sin(this.time * 0.37 + this.wob[0]) * Math.sin(this.time * 0.23 + this.wob[1]);
      v *= wobble;
      for (const d of p.doors) {
        if (d.s + 0.05 < this.s) continue;
        if (d.s - this.s > 4) break;
        if (!this.doors.isOpen(d.sector)) v = Math.min(v, Math.sqrt(2 * DECEL * Math.max(0, d.s - this.s - DOOR_STOP)));
        break;
      }
      const misalign = Math.abs(wrap(tangent - this.body.x)) / DEG;
      v *= clamp(1 - (misalign - 25) / 70, 0.15, 1);
      if (this.attn || this.pendingGoal) v = 0;
      targetSpeed = v;
      // Head: a point LOOK_AHEAD seconds ahead along the path.
      const ahead = Math.max(1.0, LOOK_AHEAD * Math.max(this.speed, this.cruise * 0.8));
      const [ax, az, af] = this.pointAt(p, Math.min(p.len, this.s + ahead));
      const dx = ax - this.x, dz = az - this.z, dist = Math.hypot(dx, dz);
      headTarget = dist > 0.3 ? this.head.x + wrap(headingOf(dx, dz) - this.head.x) : this.head.x + wrap(tangent - this.head.x);
      pitchTarget = Math.atan2(af + EYE - eye, Math.max(dist, 0.5)) * 0.7 - 2 * DEG;
      // Approaching the poi: turn the head toward what it came to see.
      const rem = p.len - this.s;
      if (this.leg?.poi && !this.pieces.length && rem < 2) {
        const L = this.leg.poi.look;
        const want = headingOf(L[0] - this.x, L[2] - this.z);
        const k = 1 - rem / 2;
        headTarget += k * wrap(want - headTarget);
      }
      // Glances.
      this.glanceT -= dt;
      if (this.glanceHold > 0) { this.glanceHold -= dt; if (this.glanceHold <= 0) this.glance = 0; }
      else if (this.glanceT <= 0) {
        this.glance = (this.rng.next() < 0.5 ? -1 : 1) * this.rng.range(12, 35) * DEG;
        this.glanceHold = this.rng.range(1, 3);
        this.glanceT = this.rng.range(6, 15);
      }
      headTarget += this.glance;
    } else {
      this.glance = 0;
      this.glanceHold = 0;
    }

    if (this.baseState === 'pausing') {
      if (!this.attn) this.pauseT -= dt;
      const L = this.lookPoint;
      if (L) {
        const dx = L.x - this.x, dz = L.z - this.z;
        const h = Math.hypot(dx, dz);
        if (h > 0.3) headTarget = this.head.x + wrap(headingOf(dx, dz) - this.head.x);
        pitchTarget = Math.atan2(L.y - eye, Math.max(h, 0.5));
      }
      // Idle drift: slow and peaceful, never still.
      headTarget += 4 * DEG * Math.sin(this.time * 0.31 + this.wob[0]);
      const f = 1 - this.pauseT / Math.max(this.pauseLen, 1e-3);
      if (this.tall && f > 0.3 && f < 0.75) pitchTarget = Math.max(pitchTarget, 0) + 24 * DEG;
      if (this.pauseT <= 0 && !this.attn) this.nextLeg();
    } else if (this.baseState === 'riding') {
      const rd = this.ride, p = this.piece;
      rd.t += dt;
      const k = clamp(rd.t / Math.max(rd.dur, 1e-3), 0, 1);
      const e = k * k * (3 - 2 * k);
      const h = rd.start + (rd.target - rd.start) * e;
      const hh = this.lift?.height ? finite(this.lift.height(p.lift), h) : h;
      this.liftY.set(p.lift, hh);
      if (p.kind === 'ride') this.floor = hh;
      const fx = p.face.x - this.x, fz = p.face.z - this.z;
      const face = Math.hypot(fx, fz) > 0.2 ? headingOf(fx, fz) : this.body.x;
      headTarget = this.head.x + wrap(face - this.head.x) + 6 * DEG * Math.sin(this.time * 0.4 + this.wob[1]);
      pitchTarget = p.kind === 'ride' ? Math.sign(p.to - p.from) * 8 * DEG : 0;
      if (k >= 1 && (rd.done || !this.lift)) {
        rd.wait -= dt;
        if (rd.wait <= 0) { this.liftY.set(p.lift, rd.target); this.nextPiece(); }
      }
    }

    if (this.attn) {
      this.attn.t -= dt;
      const L = this.attn.point;
      const dx = L.x - this.x, dz = L.z - this.z, h = Math.hypot(dx, dz);
      if (h > 0.3) headTarget = this.head.x + wrap(headingOf(dx, dz) - this.head.x);
      pitchTarget = Math.atan2(L.y - eye, Math.max(h, 0.5));
      if (this.attn.t <= 0) this.attn = null;
    }

    // Gaze bias toward the cursor.
    const gz = inp.gaze;
    const gy = gz && Number.isFinite(gz.yaw) ? clamp(gz.yaw * 0.4, -GAZE_YAW, GAZE_YAW) : 0;
    const gp = gz && Number.isFinite(gz.pitch) ? clamp(gz.pitch * 0.4, -GAZE_PITCH, GAZE_PITCH) : 0;
    spring(this.biasYaw, gy, BIAS_TAU, dt);
    spring(this.biasPitch, gp, BIAS_TAU, dt);
    headTarget += this.biasYaw.x;
    pitchTarget += this.biasPitch.x;

    // Speed and position along the path.
    if (this.baseState === 'walking') {
      const dv = clamp(targetSpeed - this.speed, -ACCEL * dt, ACCEL * dt);
      this.speed = Math.max(0, this.speed + dv);
      const p = this.piece;
      const rem = p.len - this.s;
      let ds = this.speed * dt;
      // Never stall a hair short of the end.
      if (!this.attn && !this.pendingGoal && rem < 0.05) ds = Math.min(rem, Math.max(ds, 0.03 * dt));
      this.s = Math.min(p.len, this.s + ds);
      while (this.idx < p.n - 2 && p.ss[this.idx + 1] <= this.s) this.idx++;
      const [x, z, f] = this.pointAt(p, this.s);
      this.x = x; this.z = z; this.floor = f;
      if (this.pendingGoal && this.speed < 0.03) { this.speed = 0; this.nextLeg(); }
      else if (this.s >= p.len - 1e-6) { this.speed = 0; this.nextPiece(); }
    } else {
      this.speed = Math.max(0, this.speed - ACCEL * dt);
      if (this.pendingGoal && this.baseState !== 'riding') this.nextLeg();
    }

    // Body follows the path tangent; when standing it turns to where the head looks.
    const standing = this.speed < 0.08 && (this.baseState !== 'walking' || this.attn);
    const bodyTarget = standing ? this.head.x + wrap(headTarget - this.head.x) * 0.7 : this.body.x + wrap(tangent - this.body.x);
    spring(this.body, bodyTarget, BODY_TAU, dt);
    // Keep the head within 100° of the body, then spring it with the 90°/s limit.
    const rel = wrap(headTarget - this.body.x);
    headTarget = this.body.x + clamp(rel, -100 * DEG, 100 * DEG) + (headTarget - this.body.x - rel);
    spring(this.head, headTarget, HEAD_TAU, dt, HEAD_RATE);
    spring(this.pitchS, clamp(pitchTarget, -45 * DEG, 50 * DEG), PITCH_TAU, dt, PITCH_RATE);

    // Step bob and sway, fading with speed.
    spring(this.bobAmp, clamp(this.speed / 0.45, 0, 1), 0.4, dt);
    this.phase = (this.phase + 2 * Math.PI * (this.speed / STRIDE) * dt) % (4 * Math.PI);
    spring(this.yS, this.floor + EYE, Y_TAU, dt);
    const amp = this.bobAmp.x;
    const bob = BOB * amp * Math.sin(this.phase);
    const sway = SWAY * amp * Math.sin(this.phase / 2);
    const by = this.body.x;
    const rx = Math.cos(by), rz = -Math.sin(by); // body's right

    const P = this.pose;
    P.x = finite(this.x + rx * sway, P.x);
    P.z = finite(this.z + rz * sway, P.z);
    P.y = finite(this.yS.x + bob, P.y);
    P.yaw = finite(this.head.x, P.yaw);
    P.pitch = finite(this.pitchS.x, P.pitch);
    P.roll = finite(0.25 * DEG * amp * Math.sin(this.phase / 2) - clamp(this.body.v * 0.012, -DEG, DEG), 0);
    // Keep the internal state sane if anything ever went non-finite.
    if (!Number.isFinite(this.head.x)) this.head = { x: P.yaw, v: 0 };
    if (!Number.isFinite(this.body.x)) this.body = { x: P.yaw, v: 0 };
    if (!Number.isFinite(this.pitchS.x)) this.pitchS = { x: 0, v: 0 };
    return P;
  }

  tangentAt(i) { return this.piece.hd[i]; }

  profileAt(p, s) {
    let i = this.idx;
    while (i < p.n - 2 && p.ss[i + 1] <= s) i++;
    const t = clamp((s - p.ss[i]) / Math.max(p.ss[i + 1] - p.ss[i], 1e-9), 0, 1);
    return p.vmax[i] + (p.vmax[i + 1] - p.vmax[i]) * t;
  }

  /** Position and floor at arc length s, written into a scratch array (no per-step allocation). */
  pointAt(p, s) {
    const out = (this.scratch ??= [0, 0, 0]);
    let i = this.idx;
    while (i < p.n - 2 && p.ss[i + 1] <= s) i++;
    if (p.n === 1) { out[0] = p.xs[0]; out[1] = p.zs[0]; out[2] = p.floors[0]; return out; }
    const t = clamp((s - p.ss[i]) / Math.max(p.ss[i + 1] - p.ss[i], 1e-9), 0, 1);
    out[0] = p.xs[i] + (p.xs[i + 1] - p.xs[i]) * t;
    out[1] = p.zs[i] + (p.zs[i + 1] - p.zs[i]) * t;
    out[2] = p.floors[i] + (p.floors[i + 1] - p.floors[i]) * t;
    return out;
  }
}
