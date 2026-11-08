// Hangar — Reflection plan: where the room probes sit, where the floors are wet, and where the slime's glow
// lights come from. Pure: no three.js (probes.js and slime.js build the GPU side).
//
// Rooms are lightplan's rooms (sectors joined across shared edges, split at corridors, doors and sills).

import { lightRooms } from './lightplan.js';
import { insidePoly } from './level.js';

export const EYE = 1.7;
export const MIN_PROBE_ROOM = 8; // m²: smaller rooms (sills, doors, single steps) share the nearest probe
export const SLIME_DROP = 0.15; // m: the slime surface sits this far below its sector's floor
export const SLIME_LIGHT_SPACING = 6; // m: one glow light per 6 m of pool
export const SLIME_LIGHT_HEIGHT = 0.8;
export const SLIME_LIGHT_LOW = 0.25;
const WET_TRIES = 200;
const NO_WET = ['slime', 'walkway', 'window', 'door', 'lift', 'sky'];

export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length]; s += x2 * z1 - x1 * z2; }
  return Math.abs(s / 2);
}

export { insidePoly }; // the one even-odd test (level.js), re-exported for the planners' users

/** Distance from (x, z) to the nearest edge of `poly`. */
export function edgeDistance(poly, x, z) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return d;
}

function bbox(polys) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of polys) for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0, z0, x1, z1 };
}

function groups(level) {
  const rooms = lightRooms(level);
  const by = new Map();
  for (const s of level.sectors) {
    const r = rooms.get(s.id);
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(s);
  }
  return by;
}

/**
 * Probe placement: { probes: [{ x, y, z, room }], bySector: Map<sectorId, probeIndex> }. A room of at least
 * MIN_PROBE_ROOM m² gets one probe at eye height, at the walkable point (0.5 m grid, not over slime, at least
 * 0.4 m from a sector edge where possible) nearest the room's area-weighted centre. Smaller rooms use the
 * nearest probe.
 */
export function planProbes(level) {
  const probes = [], bySector = new Map(), small = [];
  for (const [room, ss] of groups(level)) {
    let A = 0, cx = 0, cz = 0;
    for (const s of ss) {
      const a = polyArea(s.poly);
      let mx = 0, mz = 0;
      for (const [x, z] of s.poly) { mx += x; mz += z; }
      A += a; cx += (a * mx) / s.poly.length; cz += (a * mz) / s.poly.length;
    }
    if (A < MIN_PROBE_ROOM) { small.push({ ss, x: cx / (A || 1), z: cz / (A || 1) }); continue; }
    cx /= A; cz /= A;
    const stand = ss.filter((s) => !s.tags.has('slime') && !s.tags.has('window'));
    const box = bbox(stand.map((s) => s.poly));
    let best = null;
    for (const clear of [0.4, 0]) {
      for (let x = box.x0 + 0.25; x < box.x1; x += 0.5) for (let z = box.z0 + 0.25; z < box.z1; z += 0.5) {
        const s = stand.find((t) => insidePoly(t.poly, x, z));
        if (!s || edgeDistance(s.poly, x, z) < clear) continue;
        const d = Math.hypot(x - cx, z - cz);
        if (!best || d < best.d) best = { d, x, z, s };
      }
      if (best) break;
    }
    if (!best) { small.push({ ss, x: cx, z: cz }); continue; }
    const y = Math.min(best.s.floor + EYE, best.s.ceil - 0.25);
    const i = probes.push({ x: best.x, y, z: best.z, room }) - 1;
    for (const s of ss) bySector.set(s.id, i);
  }
  for (const g of small) {
    let bi = 0, bd = Infinity;
    probes.forEach((p, i) => { const d = Math.hypot(p.x - g.x, p.z - g.z); if (d < bd) { bd = d; bi = i; } });
    for (const s of g.ss) bySector.set(s.id, bi);
  }
  return { probes, bySector };
}

/**
 * Wet patches: 2 to 5 per room with dry floor to spare (at least MIN_PROBE_ROOM m² of floor that is not
 * slime, walkway, sill, door, lift or open sky), each wholly inside one sector. About two in three are
 * dropped near a ceiling fixture (0.6 to 2.5 m off its foot), where a puddle catches the lamp; the rest
 * anywhere on the room's floor. Returns [{ x, y, z, sector, r, stretch, rot, roughness, mask }]: radius r
 * in metres, stretched along its rotated x by `stretch`; `shape` seeds its outline (wet.js).
 */
export function planWetPatches(level, fixtures, rng) {
  const out = [];
  for (const [room, ss] of groups(level)) {
    const dry = ss.filter((s) => !NO_WET.some((t) => s.tags.has(t)));
    const area = dry.reduce((a, s) => a + polyArea(s.poly), 0);
    if (area < MIN_PROBE_ROOM) continue;
    const box = bbox(dry.map((s) => s.poly));
    const lamps = fixtures.filter((f) => f.room === room && f.kind !== 'emergency' && !f.dead);
    const n = rng.int(2, 5);
    let placed = 0;
    for (let tries = 0; tries < WET_TRIES && placed < n; tries++) {
      // A small or crowded room still gets its patches: after every 40 failed tries the patches shrink.
      const shrink = [1, 0.7, 0.45, 0.3, 0.2][Math.floor(tries / 40)];
      // No patch longer than a quarter of the room's size across, so a small room has space for two.
      const stretch = rng.range(1, 1.7), r = Math.min(rng.range(0.35, 1.0), Math.sqrt(area) / 4 / stretch) * shrink;
      let x, z;
      if (lamps.length && tries < 80 && rng.next() < 0.65) {
        const f = lamps[Math.floor(rng.next() * lamps.length)];
        const a = rng.range(0, Math.PI * 2), d = rng.range(0.6, 2.5);
        x = f.x + Math.cos(a) * d; z = f.z + Math.sin(a) * d;
      } else {
        x = rng.range(box.x0, box.x1); z = rng.range(box.z0, box.z1);
      }
      const s = dry.find((t) => insidePoly(t.poly, x, z));
      const reach = r * stretch;
      if (!s || edgeDistance(s.poly, x, z) < reach + 0.1) continue;
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < p.r * p.stretch + reach + 0.3)) continue;
      out.push({ x, y: s.floor, z, sector: s.id, r, stretch, rot: rng.range(0, Math.PI), roughness: rng.range(0.05, 0.15), shape: rng.int(1, 0x7fffffff) });
      placed++;
    }
  }
  return out;
}

/**
 * The slime's glow lights, the full plan: one point per SLIME_LIGHT_SPACING m square of pool. A pool here is
 * every slime sector at one surface height together with the walkway sectors over it (the slime runs on
 * under the grating, slimeUnder). Each grid cell holding at least MIN_CELL_POOL m² of pool gets the point
 * (on a 0.5 m sub-grid) farthest from the pool's outer edge, so narrow pools still get theirs; points closer
 * than SLIME_LIGHT_MIN_CLEAR to the edge are dropped (a point light hard by a wall burns a hot spot into it).
 * SLIME_LIGHT_HEIGHT above the surface (SLIME_LIGHT_LOW under the walkway). [{ x, y, z, sector, clear, power }]. Only the nearest few are live (slime.js).
 */
const MIN_CELL_POOL = 12; // m²: a third of a cell; a sliver of pool in a cell is lit from the next
export const SLIME_LIGHT_MIN_CLEAR = 0.35;
export function slimeLightPoints(level, spacing = SLIME_LIGHT_SPACING) {
  const under = slimeUnder(level);
  const pools = new Map(); // surface y -> sectors
  for (const s of level.sectors) {
    if (!s.tags.has('slime') && !under.has(s.id)) continue;
    const y = +(s.tags.has('slime') ? s.floor - SLIME_DROP : under.get(s.id)).toFixed(4);
    if (!pools.has(y)) pools.set(y, []);
    pools.get(y).push(s);
  }
  const k = ([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`;
  const out = [];
  for (const [y, ss] of pools) {
    // Outer edges of the pool: edges no other sector of the pool shares.
    const edges = new Set();
    for (const s of ss) s.poly.forEach((a, i) => edges.add(`${k(a)}>${k(s.poly[(i + 1) % s.poly.length])}`));
    const rim = [];
    for (const s of ss) s.poly.forEach((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      if (!edges.has(`${k(b)}>${k(a)}`)) rim.push([a, b]);
    });
    const clearAt = (x, z) => Math.min(...rim.map((e) => edgeDistance(e, x, z)));
    const box = bbox(ss.map((s) => s.poly));
    for (let cx = box.x0; cx < box.x1; cx += spacing) for (let cz = box.z0; cz < box.z1; cz += spacing) {
      let best = null, n = 0;
      for (let x = cx + 0.25; x < Math.min(cx + spacing, box.x1); x += 0.5) for (let z = cz + 0.25; z < Math.min(cz + spacing, box.z1); z += 0.5) {
        const s = ss.find((t) => insidePoly(t.poly, x, z));
        if (!s) continue;
        n++;
        const c = clearAt(x, z);
        if (!best || c > best.clear) best = { x, z, sector: s.id, clear: c };
      }
      if (best && n * 0.25 >= MIN_CELL_POOL && best.clear >= SLIME_LIGHT_MIN_CLEAR) {
        // Under the walkway's deck a light 0.8 m up would sit 0.3 m below the bars and burn them white: there it
        // floats just over the surface (SLIME_LIGHT_LOW), 0.85 m below the deck.
        const low = under.has(best.sector);
        // It is also dimmer (power): the deck's underside is what it lights most, and a bright underside would
        // reflect as bright as the glow, losing the walkway's dark band in the pool.
        out.push({ x: best.x, y: y + (low ? SLIME_LIGHT_LOW : SLIME_LIGHT_HEIGHT), z: best.z, sector: best.sector, clear: best.clear, power: low ? 0.15 : 1 });
      }
    }
  }
  return out;
}

/**
 * Skirts below every slime pool's rim, in wallQuads' format: from `depth` below the sector's floor up to the
 * floor, facing into the pool, along every edge that does not border another pool or the walkway (under the
 * walkway the slime runs on). The pool's own floor is hidden, so without these the gap between the rim and
 * the slime surface (SLIME_DROP lower) would show the void.
 */
export function slimeSkirts(level, depth = 0.6, tile = 2) {
  const k = ([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`;
  const owner = new Map();
  for (const s of level.sectors) s.poly.forEach((a, i) => owner.set(`${k(a)}>${k(s.poly[(i + 1) % s.poly.length])}`, s));
  const pools = slimeUnder(level);
  const out = [];
  for (const s of level.sectors.filter((t) => t.tags.has('slime') || pools.has(t.id))) {
    const mat = [...s.tags].find((t) => t.startsWith('mat:')).slice(4);
    // A walkway's skirt reaches from its deck down past the slime under it.
    const y0 = s.tags.has('slime') ? s.floor - depth : pools.get(s.id) - depth + SLIME_DROP;
    s.poly.forEach((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      const nb = owner.get(`${k(b)}>${k(a)}`);
      if (nb && (nb.tags.has('slime') || nb.tags.has('walkway'))) return;
      const [ax, az] = a, [bx, bz] = b;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const y1 = s.floor;
      out.push({
        corners: [[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]],
        uv: [[0, y0 / tile], [len / tile, y0 / tile], [len / tile, y1 / tile], [0, y1 / tile]],
        normal: [(bz - az) / len, 0, -(bx - ax) / len], mat, sector: s.id, kind: 'skirt', back: nb?.id ?? null,
      });
    });
  }
  return out;
}

/**
 * Map<walkwaySectorId, slime surface y> for every walkway sector over a pool: the slime runs on under the
 * open grating at the height of the pools it drops to (the lowest, if several).
 */
export function slimeUnder(level) {
  const out = new Map();
  for (const w of level.walls) {
    if (w.kind !== 'lower' || !w.back) continue;
    const top = level.byId.get(w.back), bottom = level.byId.get(w.front);
    if (!top.tags.has('walkway') || !bottom.tags.has('slime')) continue;
    const y = bottom.floor - SLIME_DROP;
    out.set(top.id, Math.min(out.get(top.id) ?? Infinity, y));
  }
  return out;
}
