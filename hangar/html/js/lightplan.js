// Hangar — Light plan: which fixtures flicker or are dead this seed, which lights are live near the camera,
// and where the red emergency light comes from. Pure: no three.js (lights.js turns the plan into lights).
//
// Fixtures come from Level.fixtures (metres, kinds strip | lamp | emergency). The plan keeps every field of a
// fixture and adds { flicker: null | { rate, depth, phase }, dead }. A "room" here is a connected run of
// sectors that are not corridors, doors or window sills (each of those is its own room), so the start
// platform and its pit are one room and the armour room through the corridor is another.

import { sectorAt } from './level.js';

export const FLICKER_SHARE = 1 / 12; // about 1 lamp in 12 flickers
export const DEAD_SHARE = 1 / 20; // about 1 in 20 is dead
export const DEAD_SPACING = 8; // metres: never two dead lights this close (no dark run along a corridor)
const BEACON_ROOM_SPACING = 6; // metres between battery beacons in one room
const BEACON_SPACING = 4; // metres between any two beacons

const SPLIT = new Set(['corridor', 'door', 'window']);

/** Map<sectorId, roomIndex>: sectors joined across shared edges, except through corridors, doors and sills. */
export function lightRooms(level) {
  const sectors = level.sectors;
  const parent = sectors.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const pt = ([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`;
  const split = (s) => [...s.tags].some((t) => SPLIT.has(t));
  const owner = new Map();
  sectors.forEach((s, i) => s.poly.forEach((a, k) => owner.set(`${pt(a)}>${pt(s.poly[(k + 1) % s.poly.length])}`, i)));
  sectors.forEach((s, i) => s.poly.forEach((a, k) => {
    const j = owner.get(`${pt(s.poly[(k + 1) % s.poly.length])}>${pt(a)}`);
    if (j === undefined || split(s) || split(sectors[j])) return;
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  }));
  return new Map(sectors.map((s, i) => [s.id, find(i)]));
}

/**
 * Level.fixtures with { sector, room, start, keepLit }: `start` for the start room, `keepLit` for the start
 * room and every room a window or view poi stands in (those must always be lit).
 */
export function annotateFixtures(level) {
  const rooms = lightRooms(level);
  const roomAt = (x, z) => { const s = sectorAt(level, x, z); return s ? rooms.get(s.id) : null; };
  const startRoom = roomAt(level.start.x, level.start.z);
  const kept = new Set([startRoom]);
  for (const p of level.pois) if (p.kind === 'window' || p.kind === 'view') kept.add(roomAt(p.x, p.z));
  return level.fixtures.map((f) => {
    const s = sectorAt(level, f.x, f.z);
    const room = s ? rooms.get(s.id) : -1;
    return { ...f, sector: s?.id ?? null, room, start: room === startRoom, keepLit: kept.has(room) };
  });
}

function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * The seed's lighting state: a fixed share of the main fixtures (strips and lamps) flicker, a smaller share
 * are dead. Dead lights avoid kept-lit rooms and keep DEAD_SPACING apart; the start room never flickers;
 * emergency fixtures are always sound. Counts are the shares rounded, so every seed reads the same.
 */
export function planLights(fixtures, rng) {
  const mains = fixtures.map((f, i) => i).filter((i) => fixtures[i].kind !== 'emergency');
  const nDead = Math.round(mains.length * DEAD_SHARE);
  const nFlicker = Math.round(mains.length * FLICKER_SHARE);
  const dead = new Set();
  for (const i of shuffled(mains.filter((i) => !fixtures[i].keepLit), rng.fork('dead'))) {
    if (dead.size >= nDead) break;
    const f = fixtures[i];
    if ([...dead].some((j) => Math.hypot(fixtures[j].x - f.x, fixtures[j].z - f.z) < DEAD_SPACING)) continue;
    dead.add(i);
  }
  const fr = rng.fork('flicker');
  const flicker = new Map();
  for (const i of shuffled(mains.filter((i) => !dead.has(i) && !fixtures[i].start), fr)) {
    if (flicker.size >= nFlicker) break;
    flicker.set(i, { rate: fr.range(0.2, 0.45), depth: fr.range(0.6, 0.95), phase: fr.range(0, 1000) });
  }
  return fixtures.map((f, i) => ({ ...f, flicker: flicker.get(i) ?? null, dead: dead.has(i) }));
}

const dist = (a, b) => Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);

/** Indices of the `n` points nearest `cam` that pass `keep`, nearest first (by `score`, distance by default). */
export function pickNearest(points, cam, n, keep = () => true, score = (p) => dist(p, cam)) {
  const out = [];
  points.forEach((p, i) => { if (keep(p, i)) out.push([score(p), i]); });
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, Math.max(0, n)).map(([, i]) => i);
}

/**
 * The `n` live lamps whose shadows matter most: nearest first, and with a view direction `camDir` a lamp in
 * front counts as up to 30% nearer and one behind as up to 30% farther (a lamp overhead or just behind still
 * throws shadows forward into view, so behind is a penalty, not a cut).
 */
export function pickShadowCasters(lights, camPos, n, camDir = null) {
  let fx = 0, fz = 0;
  if (camDir) { const l = Math.hypot(camDir.x, camDir.z); if (l > 1e-6) { fx = camDir.x / l; fz = camDir.z / l; } }
  return pickNearest(lights, camPos, n, (f) => f.kind === 'lamp' && !f.dead, (f) => {
    const d = dist(f, camPos);
    const hx = f.x - camPos.x, hz = f.z - camPos.z, h = Math.hypot(hx, hz);
    const c = h > 1e-6 ? (hx * fx + hz * fz) / h : 0;
    return d * (1 - 0.3 * c);
  });
}

/**
 * A fixed pool of live lights following a changing wish list (nearest first). Each slot { id, w } eases its
 * weight w up while its id is wanted and down when it is not; only a slot that has faded to 0 is freed and
 * given the next wanted id that no slot holds. So lights never pop, and the pool size (and so the shader's
 * light count) never changes.
 */
export function updateSlots(slots, desired, dt, fade) {
  const want = [...new Set(desired)];
  const set = new Set(want);
  const step = fade > 0 ? dt / fade : 1;
  for (const s of slots) {
    if (s.id === null) continue;
    s.w = set.has(s.id) ? Math.min(1, s.w + step) : Math.max(0, s.w - step);
    if (s.w >= 1 - 1e-6) s.w = 1;
    if (s.w <= 1e-6) { s.w = 0; if (!set.has(s.id)) s.id = null; }
  }
  const held = new Set(slots.map((s) => s.id));
  for (const id of want) {
    if (held.has(id)) continue;
    const free = slots.find((s) => s.id === null);
    if (!free) break;
    free.id = id; free.w = Math.min(1, step); held.add(id);
  }
  return slots;
}

function hash01(n) {
  let t = (Math.imul(n | 0, 0x9E3779B1) + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Brightness multiplier of a flickering tube at time t (s). A failing fluorescent is lit most of the time and
 * now and then stutters: in about 70% of the 1/rate-second cells a burst of 0.25 to 0.7 s drops it by up to
 * `depth` in a ragged on/off pattern at ~14 Hz (a starter retrying), then it holds steady again.
 */
export function flickerAt(fl, t) {
  if (!fl) return 1;
  const x = t * fl.rate + fl.phase;
  const cell = Math.floor(x);
  if (hash01(cell * 3) > 0.7) return 1;
  const start = hash01(cell * 3 + 1) * 0.6; // cell units
  const len = (0.25 + 0.45 * hash01(cell * 3 + 2)) * fl.rate; // seconds -> cell units
  const u = x - cell - start;
  if (u < 0 || u > len) return 1;
  const s = hash01(Math.floor(t * 14) + cell * 7919);
  const drop = s < 0.45 ? 1 : s < 0.7 ? 0.5 : 0;
  return 1 - fl.depth * drop;
}

/**
 * Where red light comes from under Emergency Power: every emergency fixture, plus a battery beacon (a small
 * red lamp in the housing) at main fixtures so every room with lights has red light too, spaced so a room
 * gets one every BEACON_ROOM_SPACING m. A strip's beacon sits just past its end, a lamp's on its cable.
 */
export function emergencyPoints(plan) {
  const pts = plan.filter((f) => f.kind === 'emergency').map((f) => ({ x: f.x, y: f.y, z: f.z, room: f.room, sector: f.sector, source: 'fixture' }));
  const at = (f) => {
    if (f.kind === 'strip' && f.dir) {
      const h = Math.hypot(f.dir[0], f.dir[2]) || 1, off = (f.len ?? 0) / 2 + 0.25;
      return { x: f.x + (f.dir[0] / h) * off, y: f.y + 0.04, z: f.z + (f.dir[2] / h) * off };
    }
    return { x: f.x, y: f.y + 0.3, z: f.z };
  };
  for (const f of plan) {
    if (f.kind === 'emergency') continue;
    const p = at(f);
    if (pts.some((q) => q.room === f.room && Math.hypot(q.x - p.x, q.z - p.z) < BEACON_ROOM_SPACING)) continue;
    if (pts.some((q) => q.source === 'beacon' && Math.hypot(q.x - p.x, q.z - p.z) < BEACON_SPACING)) continue;
    pts.push({ ...p, room: f.room, sector: f.sector, source: 'beacon' });
  }
  return pts;
}
