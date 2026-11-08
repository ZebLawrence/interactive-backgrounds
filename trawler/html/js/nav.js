// Trawler — Where she goes, and how she is steered there. Pure: no three.js, so node can sail her
// about a made-up chart and check she does not run into anything.
//
// The chart is whatever `depthAt(x, z)` returns — in the scene that is the land's own baked height
// field, so the autopilot and the picture cannot disagree about where the rocks are.
//
// Picking a passage is a grid search over a window round the boat, on cells about a hundred and
// twenty metres across. The cost of a cell is not simply its length: water with little under the
// keel costs far more, so the route comes out down the middle of a sound rather than shaving the
// headlands, which is how anyone with a chart would take it. The result is string-pulled (the
// corners cut away wherever the straight line is clear) and then rounded, because a boat cannot
// turn a corner and a route of right angles makes her snake.
//
// Steering is a rudder worked from two errors at once: where she is pointing against where the
// leg runs, and how far she has drifted off it. That is a real autopilot, and it is why she
// settles back onto a line after a sea knocks her off it instead of sawing at the wheel.

import { clamp, clamp01, lerp, TAU, angleDiff, approach, knots } from './mathutil.js';

export const NAV = {
  cell: 120, // m: the search grid
  size: 128, // cells across the window, so about 15 km
  safeDepth: 9, // m: less than this is foul ground as far as the planner is concerned
  wantDepth: 28, // m: water she is happy in; anything shallower costs more
  clearance: 260, // m: how far off the rocks she likes to be
  legMin: 2200, // m: how far away a destination has to be to be worth going to
  legMax: 7000,
  // How she handles.
  headingGain: 1.5, // rudder per radian of heading error
  crossGain: 0.0016, // rudder per metre off the track
  rateGain: 2.6, // rudder per rad/s of swing: the damping that stops her hunting
  arrive: 180, // m: how close counts as there
};

/**
 * A square window of the chart, as costs. Returns { size, cell, x0, z0, depth, clear } where
 * `clear` is the distance in cells to the nearest foul ground, from a two-pass chamfer transform.
 */
export function buildChart(depthAt, cx, cz, { cell = NAV.cell, size = NAV.size, safeDepth = NAV.safeDepth } = {}) {
  const depth = new Float32Array(size * size);
  const clear = new Float32Array(size * size);
  const x0 = cx - (size * cell) / 2;
  const z0 = cz - (size * cell) / 2;
  const BIG = size * 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const d = depthAt(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell);
      depth[j * size + i] = d;
      clear[j * size + i] = d < safeDepth ? 0 : BIG;
    }
  }
  // Chamfer distance transform, forward then backward: cheap, and good to a few per cent.
  const at = (i, j) => (i < 0 || j < 0 || i >= size || j >= size ? 0 : clear[j * size + i]);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      if (clear[k] === 0) continue;
      clear[k] = Math.min(clear[k], at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + 1.414, at(i + 1, j - 1) + 1.414);
    }
  }
  for (let j = size - 1; j >= 0; j--) {
    for (let i = size - 1; i >= 0; i--) {
      const k = j * size + i;
      if (clear[k] === 0) continue;
      clear[k] = Math.min(clear[k], at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + 1.414, at(i - 1, j + 1) + 1.414);
    }
  }
  return { size, cell, x0, z0, depth, clear };
}

export const chartIndex = (chart, x, z) => {
  const i = Math.floor((x - chart.x0) / chart.cell);
  const j = Math.floor((z - chart.z0) / chart.cell);
  if (i < 0 || j < 0 || i >= chart.size || j >= chart.size) return -1;
  return j * chart.size + i;
};

export const chartPoint = (chart, k) => ({
  x: chart.x0 + ((k % chart.size) + 0.5) * chart.cell,
  z: chart.z0 + (Math.floor(k / chart.size) + 0.5) * chart.cell,
});

/** What it costs to pass through a cell: deep water in the middle of a channel is cheapest. */
export function cellCost(chart, k) {
  const d = chart.depth[k];
  if (d < NAV.safeDepth) return Infinity;
  const shoal = 1 + 3.5 * clamp01((NAV.wantDepth - d) / NAV.wantDepth);
  const want = NAV.clearance / chart.cell;
  const tight = 1 + 4.0 * clamp01((want - chart.clear[k]) / want) ** 2;
  return shoal * tight;
}

/**
 * A* from one cell to another over the chart. Returns the cells of the route, or null if there is
 * no way through. Eight-connected, with the diagonal costed properly.
 */
export function findRoute(chart, startK, goalK) {
  if (startK < 0 || goalK < 0) return null;
  if (!Number.isFinite(cellCost(chart, goalK))) return null;
  const n = chart.size;
  const g = new Float32Array(n * n).fill(Infinity);
  const from = new Int32Array(n * n).fill(-1);
  const seen = new Uint8Array(n * n);
  const gx = goalK % n, gz = Math.floor(goalK / n);
  const h = (k) => Math.hypot((k % n) - gx, Math.floor(k / n) - gz);
  // A binary heap, because a 16,000-cell search with a linear scan is milliseconds of jank.
  const heap = [];
  const push = (k, f) => {
    heap.push({ k, f });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  g[startK] = 0;
  push(startK, h(startK));
  let guard = 0;
  while (heap.length && guard++ < n * n * 4) {
    const { k } = pop();
    if (k === goalK) break;
    if (seen[k]) continue;
    seen[k] = 1;
    const i = k % n, j = Math.floor(k / n);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (seen[nk]) continue;
        const c = cellCost(chart, nk);
        if (!Number.isFinite(c)) continue;
        // A diagonal that squeezes between two foul cells is not a way through.
        if (di && dj && (!Number.isFinite(cellCost(chart, j * n + ni)) || !Number.isFinite(cellCost(chart, nj * n + i)))) continue;
        const step = (di && dj ? 1.414 : 1) * c;
        const ng = g[k] + step;
        if (ng < g[nk]) {
          g[nk] = ng;
          from[nk] = k;
          push(nk, ng + h(nk));
        }
      }
    }
  }
  if (!Number.isFinite(g[goalK])) return null;
  const out = [];
  for (let k = goalK; k !== -1; k = from[k]) out.push(k);
  return out.reverse();
}

/** Is the straight line between two points clear of foul ground the whole way? */
export function lineClear(chart, a, b, margin = NAV.clearance * 0.6) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(dist / (chart.cell * 0.5)));
  const want = margin / chart.cell;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k = chartIndex(chart, lerp(a.x, b.x, t), lerp(a.z, b.z, t));
    if (k < 0) return false;
    if (chart.depth[k] < NAV.safeDepth) return false;
    if (chart.clear[k] < want) return false;
  }
  return true;
}

/** Cuts the corners off a cell route wherever the straight line between two points is clear. */
export function stringPull(chart, cells) {
  const pts = cells.map((k) => chartPoint(chart, k));
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineClear(chart, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Rounds the corners: a boat cannot turn one, and a route of right angles makes her snake. */
export function smoothRoute(points, passes = 2) {
  let pts = points;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: lerp(a.x, b.x, 0.25), z: lerp(a.z, b.z, 0.25) });
      out.push({ x: lerp(a.x, b.x, 0.75), z: lerp(a.z, b.z, 0.75) });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/**
 * The autopilot. Give it a chart and a boat and it will find somewhere to be, take her there, and
 * then find somewhere else.
 */
export class Pilot {
  constructor(rng) {
    this.rng = rng;
    this.route = null;
    this.leg = 0;
    this.state = 'thinking';
    this.hold = 0;
    this.chart = null;
    this.target = null;
    this.orderedHeading = 0;
    this.lastReplan = -1e9;
    this.time = 0;
    this.courseOverride = null;
    this.overrideUntil = 0;
  }

  /** The chart the planner works on; the scene hands in a fresh one when the boat has run far. */
  setChart(chart) {
    this.chart = chart;
    if (this.target) this.replan(this.lastFrom ?? this.target);
  }

  /**
   * Picks somewhere worth going: far enough to be a passage, in water she is happy in, and
   * reachable. Tries a few bearings before giving up and taking whatever it can get.
   */
  chooseDestination(from) {
    const chart = this.chart;
    if (!chart) return null;
    let fallback = null;
    for (let tries = 0; tries < 40; tries++) {
      const a = this.rng.range(0, TAU);
      const r = this.rng.range(NAV.legMin, NAV.legMax);
      const p = { x: from.x + Math.cos(a) * r, z: from.z + Math.sin(a) * r };
      const k = chartIndex(chart, p.x, p.z);
      if (k < 0) continue;
      if (chart.depth[k] < NAV.wantDepth) continue;
      if (chart.clear[k] < NAV.clearance / chart.cell) continue;
      fallback ??= p;
      const route = findRoute(chart, chartIndex(chart, from.x, from.z), k);
      if (route && route.length > 3) return { p, route };
    }
    return fallback ? { p: fallback, route: null } : null;
  }

  replan(from) {
    const chart = this.chart;
    if (!chart) return false;
    const chosen = this.chooseDestination(from);
    if (!chosen) { this.route = null; return false; }
    const cells = chosen.route ?? findRoute(chart, chartIndex(chart, from.x, from.z), chartIndex(chart, chosen.p.x, chosen.p.z));
    if (!cells) { this.route = null; return false; }
    this.route = smoothRoute(stringPull(chart, cells));
    this.leg = 1;
    this.target = chosen.p;
    this.state = 'passage';
    this.lastReplan = this.time;
    this.lastFrom = { ...from };
    return true;
  }

  /** Tells her to come round to a bearing and hold it for a while, whatever the route says. */
  steerCourse(heading, seconds = 95) {
    this.courseOverride = heading;
    this.overrideUntil = this.time + seconds;
    this.state = 'altering';
  }

  /**
   * One step. `boat` needs heading, position, rate.z, speedKnots and the order methods; `weather`
   * is the derived weather; `depthAt` is the chart function for the close-in safety check.
   */
  step(dt, boat, weather, depthAt) {
    this.time += dt;
    const from = { x: boat.position.x, z: boat.position.z };

    // The one thing that overrides everything: water shoaling under her.
    const ahead = 180 + boat.speedKnots * 28;
    const look = (bearing, range) => depthAt(
      from.x + Math.sin(bearing) * range,
      from.z - Math.cos(bearing) * range,
    );
    const straight = look(boat.heading, ahead);
    let avoid = 0;
    if (straight < NAV.safeDepth * 2.2) {
      // Feel either side and go the deeper way, hard.
      const port = look(boat.heading - 0.6, ahead * 0.85);
      const stbd = look(boat.heading + 0.6, ahead * 0.85);
      avoid = stbd > port ? 1 : -1;
      this.state = 'avoiding';
    }

    let wantHeading = boat.heading;
    let wantSpeed = 0.62;

    if (this.courseOverride !== null && this.time < this.overrideUntil) {
      wantHeading = this.courseOverride;
    } else {
      if (this.courseOverride !== null) { this.courseOverride = null; this.state = 'passage'; }
      if (!this.route && this.time - this.lastReplan > 4) this.replan(from);
      if (this.route) {
        // Advance along the legs as she passes them.
        while (this.leg < this.route.length - 1) {
          const p = this.route[this.leg];
          if (Math.hypot(p.x - from.x, p.z - from.z) < NAV.arrive) this.leg++;
          else break;
        }
        const target = this.route[Math.min(this.leg, this.route.length - 1)];
        const prev = this.route[Math.max(this.leg - 1, 0)];
        // Where the leg runs, and how far off it she is.
        const legX = target.x - prev.x, legZ = target.z - prev.z;
        const legLen = Math.hypot(legX, legZ) || 1;
        const ux = legX / legLen, uz = legZ / legLen;
        const cross = (from.x - prev.x) * uz - (from.z - prev.z) * ux;
        this.crossTrack = cross;
        const legHeading = Math.atan2(ux, -uz);
        // Steer the leg, corrected by the cross-track error: a real autopilot, not a chase.
        wantHeading = legHeading - clamp(cross * NAV.crossGain, -0.7, 0.7);
        const toGo = Math.hypot(this.target.x - from.x, this.target.z - from.z);
        if (this.leg >= this.route.length - 1 && toGo < NAV.arrive * 2.5) {
          // Arrived. Lie about for a while looking at the place before going on.
          this.state = 'loitering';
          this.hold = this.rng.range(40, 150);
          this.route = null;
        }
      }
    }

    if (this.state === 'loitering') {
      this.hold -= dt;
      wantSpeed = 0.1;
      if (this.hold <= 0) { this.state = 'thinking'; this.replan(from); }
    }

    // Speed: easy through narrows, easy round corners, and easy in a sea.
    const room = clamp01((depthAt(from.x, from.z) - NAV.safeDepth) / 40);
    const turning = clamp01(Math.abs(angleDiff(boat.heading, wantHeading)) / 0.6);
    const rough = clamp01((weather?.sea ?? 0 - 0.35) / 0.65);
    if (this.state !== 'loitering') {
      wantSpeed = lerp(0.3, 0.72, room) * lerp(1, 0.6, turning) * lerp(1, 0.55, rough);
    }
    // In a real blow she heads up into it and eases down: nobody runs a trawler before a gale.
    if ((weather?.sea ?? 0) > 0.78 && this.state !== 'avoiding') {
      const into = (weather.windDir ?? 0);
      const upwind = Math.atan2(Math.cos(into), -Math.sin(into)) + Math.PI;
      wantHeading = lerp(wantHeading, wantHeading + angleDiff(wantHeading, upwind), clamp01((weather.sea - 0.78) / 0.22) * 0.55);
      wantSpeed *= 0.7;
    }
    if (avoid !== 0) {
      wantHeading = boat.heading + avoid * 0.8;
      wantSpeed = Math.min(wantSpeed, 0.35);
    }

    this.orderedHeading = wantHeading;
    // The rudder: heading error, cross-track already folded in, and rate damping.
    const err = angleDiff(boat.heading, wantHeading);
    const rudder = clamp(err * NAV.headingGain - boat.rate.z * NAV.rateGain, -1, 1) * boat.hull.maxRudder;
    boat.orderRudder(rudder);
    boat.orderThrottle(wantSpeed);
    return this.state;
  }

  /** A line for the ?perf overlay. */
  describe() {
    const legs = this.route ? `${this.leg}/${this.route.length}` : '-';
    return `${this.state} · leg ${legs}${this.crossTrack !== undefined ? ` · ${this.crossTrack.toFixed(0)} m off track` : ''}`;
  }
}
