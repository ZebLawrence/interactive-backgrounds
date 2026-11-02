// Hangar — Grate plan: where the walkway's bar grating, frame, railings and supports go. Pure: no three.js
// (grate.js turns the plan into meshes).
//
// The walkway sectors (tag `walkway`) float over the slime: every edge of theirs is a drop (a lower wall
// down to a slime sector), an opening (to another walkway sector or a room at the same floor) or a solid
// wall. Drop edges get a stringer and a railing; openings get a cross beam and stay open (that is where
// the walkway meets the landings); bearing bars in each sector run parallel to its longest opening, so
// they cross the walking direction as on a real bridge. Proportions are real industrial bar grating
// (welded, 30 x 5 mm bearing bars at 35 mm pitch, i.e. 30 mm clear, cross bars 6 mm at 100 mm) and an
// OSHA-style guardrail (top rail 1.07 m, mid rail 0.53 m, 100 mm toe plate, posts at most 1.5 m apart).

import { sectorAt } from './level.js';

export const GRATE = {
  pitch: 0.035, // bearing bar centres
  barT: 0.005, // bearing bar thickness
  barD: 0.03, // bearing bar depth
  crossPitch: 0.1,
  crossW: 0.006, // cross bars: 6 mm square, flush with the top
  band: 0.006, // banding bar thickness round every panel (same depth as the bearing bars)
  stringerD: 0.2, // C200 channel under drop edges
  beamD: 0.15, // cross beam under openings
};
export const RAIL = { top: 1.07, mid: 0.53, toe: 0.1, spacing: 1.5, inset: 0.045, pipeR: 0.0215 };
const SUPPORT_SPAN = 5; // m: a column under a stringer at least this often

const key = ([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`;
const sameEdge = (a, b, c, d) => (key(a) === key(c) && key(b) === key(d)) || (key(a) === key(d) && key(b) === key(c));

/**
 * The walkway as { sectors, rails, supports, beams }.
 *  sectors:  [{ id, poly, y, dir: [x, z] unit bar direction, edges: [{ a, b, kind: 'drop'|'open'|'wall' }] }]
 *  rails:    [{ y, points: [[x, z], ...] }] polylines inset RAIL.inset into the walkway along chained drop edges
 *  beams:    [{ a, b, y, depth, inward: [x, z] }] one under every distinct walkway edge (drops: stringers)
 *  supports: [{ x, z, top, bottom }] square columns from under a stringer down into the slime
 */
export function walkwayPlan(level) {
  const ws = level.sectors.filter((s) => s.tags.has('walkway'));
  const sectors = ws.map((s) => {
    const edges = s.poly.map((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      let kind = 'open', below = null;
      for (const w of level.walls) {
        if (!sameEdge(a, b, w.a, w.b)) continue;
        if (w.kind === 'lower' && w.back === s.id) { kind = 'drop'; below = level.byId.get(w.front); }
        else if (w.kind === 'solid' && w.front === s.id) kind = 'wall';
      }
      return { a, b, kind, below: below?.id ?? null, belowFloor: below?.floor ?? null };
    });
    let best = null, len = -1;
    for (const e of edges) {
      const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      if (e.kind === 'open' && l > len) { len = l; best = e; }
    }
    if (!best) for (const e of edges) { const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]); if (l > len) { len = l; best = e; } }
    const dir = [(best.b[0] - best.a[0]) / len, (best.b[1] - best.a[1]) / len];
    return { id: s.id, poly: s.poly, y: s.floor, dir, edges };
  });

  // Inward normal of an edge of sector s: the side of the edge where the sector is.
  const inward = (s, a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const n = [-dz / l, dx / l];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    return sectorAt(level, mx + n[0] * 0.05, mz + n[1] * 0.05)?.id === s.id ? n : [-n[0], -n[1]];
  };

  // Beams: one per distinct edge (shared openings between two walkway sectors once).
  const beams = [], seen = new Set();
  for (const s of sectors) for (const e of s.edges) {
    const k = [key(e.a), key(e.b)].sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    beams.push({ a: e.a, b: e.b, y: s.y, depth: e.kind === 'drop' ? GRATE.stringerD : GRATE.beamD, inward: inward(s, e.a, e.b), kind: e.kind });
  }

  // Rails: chain the drop edges end to end.
  const drops = [];
  for (const s of sectors) for (const e of s.edges) if (e.kind === 'drop') drops.push({ a: e.a, b: e.b, n: inward(s, e.a, e.b), y: s.y, belowFloor: e.belowFloor });
  const ends = new Map();
  drops.forEach((d, i) => { for (const p of [d.a, d.b]) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Set();
  const rails = [], supports = [];
  const chainFrom = (start) => {
    // Walk from an edge, extending at both ends.
    used.add(start);
    let list = [drops[start]];
    let pts = [drops[start].a, drops[start].b];
    for (const forward of [true, false]) {
      for (;;) {
        const endPt = forward ? pts[pts.length - 1] : pts[0];
        const next = (ends.get(key(endPt)) ?? []).find((j) => !used.has(j));
        if (next === undefined) break;
        used.add(next);
        const d = drops[next];
        const other = key(d.a) === key(endPt) ? d.b : d.a;
        if (forward) { pts.push(other); list.push(d); } else { pts.unshift(other); list.unshift(d); }
      }
    }
    return { pts, list };
  };
  // Start chains at open ends (degree 1) first so a chain is never split in its middle.
  const order = drops.map((_, i) => i).sort((i, j) => {
    const deg = (k) => Math.min(ends.get(key(drops[k].a)).length, ends.get(key(drops[k].b)).length);
    return deg(i) - deg(j);
  });
  for (const i of order) {
    if (used.has(i)) continue;
    const { pts, list } = chainFrom(i);
    // Ends stop short of whatever the chain runs into (a wall corner, a landing's edge).
    rails.push({ y: list[0].y, points: trimEnds(offsetPolyline(pts, list.map((d) => d.n), RAIL.inset), 0.12) });
    // Columns at every chain vertex and along long spans, just inside the stringer.
    const bottom = Math.min(...list.map((d) => d.belowFloor ?? d.y - 1)) - 0.6;
    const col = offsetPolyline(pts, list.map((d) => d.n), 0.1);
    for (let k = 0; k < col.length; k++) {
      supports.push({ x: col[k][0], z: col[k][1], top: list[0].y - GRATE.stringerD, bottom });
      if (k + 1 < col.length) {
        const l = Math.hypot(col[k + 1][0] - col[k][0], col[k + 1][1] - col[k][1]);
        const n = Math.ceil(l / SUPPORT_SPAN);
        for (let m = 1; m < n; m++) {
          const t = m / n;
          supports.push({ x: col[k][0] + (col[k + 1][0] - col[k][0]) * t, z: col[k][1] + (col[k + 1][1] - col[k][1]) * t, top: list[0].y - GRATE.stringerD, bottom });
        }
      }
    }
  }
  return { sectors, rails, beams, supports };
}

/** Polyline `pts` moved by `d` along per-segment normals `ns` (mitred, the mitre capped at 3d). */
export function offsetPolyline(pts, ns, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const n0 = ns[Math.max(0, i - 1)], n1 = ns[Math.min(ns.length - 1, i)];
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1[0]; mz = n1[1]; } else { mx /= ml; mz /= ml; }
    const cos = mx * n1[0] + mz * n1[1];
    const len = Math.min(d / Math.max(cos, 1e-3), 3 * d);
    out.push([pts[i][0] + mx * len, pts[i][1] + mz * len]);
  }
  return out;
}

/** `pts` with both ends pulled `d` back along the line. */
export function trimEnds(pts, d) {
  const out = pts.map((p) => [...p]);
  const pull = (i, j) => {
    const dx = pts[j][0] - pts[i][0], dz = pts[j][1] - pts[i][1], l = Math.hypot(dx, dz);
    if (l > 3 * d) { out[i][0] += (dx / l) * d; out[i][1] += (dz / l) * d; }
  };
  pull(0, 1);
  pull(pts.length - 1, pts.length - 2);
  return out;
}

/** Posts along a polyline: at every vertex and evenly between, at most `spacing` apart. */
export function postPoints(points, spacing = RAIL.spacing) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1], [x1, z1] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / spacing));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }
  return out;
}

/**
 * Bars parallel to `dir` at `pitch` across polygon `poly` ([x, z] points), anchored at the polygon's first
 * vertex. Each is clipped to the polygon (even-odd, so concave outlines work) and shortened by `trim` at
 * both ends. Returns [[x0, z0, x1, z1], ...].
 */
export function barSegments(poly, dir, pitch, trim = 0) {
  const [dx, dz] = dir;
  const px = -dz, pz = dx; // across the bars
  const o = poly[0];
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of poly) { const s = (x - o[0]) * px + (z - o[1]) * pz; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const out = [];
  for (let k = Math.ceil(lo / pitch + 0.5); (k - 0.5) * pitch < hi; k++) {
    const s = (k - 0.5) * pitch; // offset across: bars sit half a pitch in from the anchor
    if (s <= lo || s >= hi) continue;
    const ts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = (a[0] - o[0]) * px + (a[1] - o[1]) * pz - s, sb = (b[0] - o[0]) * px + (b[1] - o[1]) * pz - s;
      if ((sa > 0) === (sb > 0)) continue;
      const t = sa / (sa - sb);
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      ts.push((x - o[0]) * dx + (z - o[1]) * dz);
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const t0 = ts[i] + trim, t1 = ts[i + 1] - trim;
      if (t1 - t0 < 0.01) continue;
      const bx = o[0] + px * s, bz = o[1] + pz * s;
      out.push([bx + dx * t0, bz + dz * t0, bx + dx * t1, bz + dz * t1]);
    }
  }
  return out;
}
