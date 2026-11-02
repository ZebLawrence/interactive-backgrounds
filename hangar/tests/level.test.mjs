import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt, signedArea } from '../html/js/level.js';

const json = JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8'));
const level = loadLevel(json);
const has = (s, t) => s.tags.has(t);
const walkable = (s) => !has(s, 'slime');
const height = (s) => s.ceil - s.floor;
const EPS = 1e-9;

test('every polygon is closed with at least 3 distinct points and CCW seen from above', () => {
  for (const s of level.sectors) {
    assert.ok(s.poly.length >= 3, `${s.id}: fewer than 3 points`);
    const keys = new Set(s.poly.map((p) => p.join(',')));
    assert.equal(keys.size, s.poly.length, `${s.id}: repeated point (polygons are implicitly closed)`);
    assert.ok(s.poly.every((p) => p.length === 2 && p.every(Number.isFinite)), `${s.id}: bad point`);
    assert.ok(signedArea(s.poly) > 0, `${s.id}: not CCW`);
  }
});

test('sector ids are unique and each sector carries exactly one material tag', () => {
  const ids = new Set(level.sectors.map((s) => s.id));
  assert.equal(ids.size, level.sectors.length);
  for (const s of level.sectors) {
    assert.equal([...s.tags].filter((t) => t.startsWith('mat:')).length, 1, `${s.id}: material tags`);
    assert.ok(s.light >= 0 && s.light <= 255, `${s.id}: light`);
  }
});

test('every non-sky sector a camera can enter has at least 2 m of headroom', () => {
  for (const s of level.sectors) {
    if (has(s, 'sky') || !walkable(s)) continue;
    assert.ok(height(s) >= 2.0 - EPS, `${s.id}: ${height(s).toFixed(2)} m`);
  }
});

test('every wall references real sectors and has a sane span and kind', () => {
  assert.ok(level.walls.length > 0);
  for (const w of level.walls) {
    assert.ok(level.byId.has(w.front), `front ${w.front}`);
    assert.ok(w.back === null || level.byId.has(w.back), `back ${w.back}`);
    assert.ok(['solid', 'upper', 'lower', 'window'].includes(w.kind), w.kind);
    assert.equal(w.kind === 'solid', w.back === null);
    assert.ok(w.top > w.bottom, `${w.front}/${w.back} ${w.kind}: top <= bottom`);
  }
});

test('adjacent sectors share exact vertices (no edge overlaps another without matching it end to end)', () => {
  const edges = [];
  for (const s of level.sectors) {
    s.poly.forEach((a, i) => edges.push({ id: s.id, a, b: s.poly[(i + 1) % s.poly.length] }));
  }
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    const dir = [(e.b[0] - e.a[0]) / len, (e.b[1] - e.a[1]) / len];
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (f.id === e.id) continue;
      // Collinear within 1 cm?
      if (Math.abs(cross(e.a, e.b, f.a)) / len > 0.01 || Math.abs(cross(e.a, e.b, f.b)) / len > 0.01) continue;
      const ta = (f.a[0] - e.a[0]) * dir[0] + (f.a[1] - e.a[1]) * dir[1];
      const tb = (f.b[0] - e.a[0]) * dir[0] + (f.b[1] - e.a[1]) * dir[1];
      const overlap = Math.min(len, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
      if (overlap <= 0.01) continue;
      const exact = f.a.join() === e.b.join() && f.b.join() === e.a.join();
      assert.ok(exact, `${e.id} [${e.a}]-[${e.b}] partly overlaps ${f.id} [${f.a}]-[${f.b}]`);
    }
  }
});

test('sectors do not overlap', () => {
  const xs = level.sectors.flatMap((s) => s.poly.map((p) => p[0]));
  const zs = level.sectors.flatMap((s) => s.poly.map((p) => p[1]));
  const inside = (poly, x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  for (let x = Math.min(...xs) + 0.0137; x < Math.max(...xs); x += 0.37) {
    for (let z = Math.min(...zs) + 0.0291; z < Math.max(...zs); z += 0.37) {
      const hits = level.sectors.filter((s) => inside(s.poly, x, z)).map((s) => s.id);
      assert.ok(hits.length <= 1, `(${x.toFixed(2)}, ${z.toFixed(2)}) in ${hits.join(' and ')}`);
    }
  }
});

test('exactly one exit, and every required kind of place exists', () => {
  assert.equal(level.sectors.filter((s) => has(s, 'exit')).length, 1);
  for (const t of ['slime', 'sky', 'walkway', 'door', 'lift', 'computer', 'dark', 'corridor', 'courtyard', 'window']) {
    assert.ok(level.sectors.some((s) => has(s, t)), `no sector tagged ${t}`);
  }
});

test('doors and lifts point at door and lift sectors; doors store their open height (R1)', () => {
  assert.ok(level.doors.length > 0 && level.lifts.length > 0);
  for (const d of level.doors) {
    const s = level.byId.get(d.sector);
    assert.ok(s && has(s, 'door'), d.sector);
    assert.ok(Math.abs(s.ceil - d.openCeil) < EPS, `${d.sector}: ceil is not the open height`);
  }
  for (const l of level.lifts) {
    const s = level.byId.get(l.sector);
    assert.ok(s && has(s, 'lift'), l.sector);
    assert.ok(l.high > l.low);
    assert.ok(Math.abs(s.floor - l.low) < EPS, `${l.sector}: floor should be the low stop`);
    assert.ok(s.ceil - l.high >= 2.0 - EPS, `${l.sector}: no headroom at the top stop`);
  }
  for (const s of level.sectors) {
    if (has(s, 'door')) assert.ok(level.doors.some((d) => d.sector === s.id), `${s.id} missing from doors`);
    if (has(s, 'lift')) assert.ok(level.lifts.some((l) => l.sector === s.id), `${s.id} missing from lifts`);
  }
});

test('the start lies inside a walkable sector, and sectorAt finds it', () => {
  const s = sectorAt(level, level.start.x, level.start.z);
  assert.ok(s, 'start is outside every sector');
  assert.ok(walkable(s) && !has(s, 'sky'), `start sector ${s.id}`);
  assert.ok(Number.isFinite(level.start.yaw));
  assert.equal(sectorAt(level, 1e5, 1e5), null);
  assert.equal(sectorAt(level, -1e5, 3), null);
});

test('12-20 points of interest, at least 4 windows or views, each standing in a non-slime sector', () => {
  assert.ok(level.pois.length >= 12 && level.pois.length <= 20, `${level.pois.length} pois`);
  assert.ok(level.pois.filter((p) => p.kind === 'window' || p.kind === 'view').length >= 4);
  const ids = new Set();
  for (const p of level.pois) {
    assert.ok(!ids.has(p.id), `duplicate poi ${p.id}`); ids.add(p.id);
    assert.ok(['window', 'view', 'slime', 'room', 'console'].includes(p.kind), p.kind);
    const s = sectorAt(level, p.x, p.z);
    assert.ok(s && walkable(s), `poi ${p.id} is not in a walkable sector`);
    assert.ok(p.look.length === 3 && p.look.every(Number.isFinite), `poi ${p.id} look`);
  }
});

test('fixtures are well formed and stand inside the map', () => {
  assert.ok(level.fixtures.length >= 12);
  for (const f of level.fixtures) {
    assert.ok(['strip', 'lamp', 'emergency'].includes(f.kind), f.kind);
    assert.ok([f.x, f.y, f.z].every(Number.isFinite));
    const s = sectorAt(level, f.x, f.z);
    assert.ok(s, `fixture at (${f.x.toFixed(2)}, ${f.z.toFixed(2)}) is outside the map`);
    assert.ok(f.y > s.floor && (has(s, 'sky') || f.y <= s.ceil + EPS), `fixture height ${f.y} in ${s.id}`);
    if (f.dir) assert.ok(f.dir.length === 3 && f.dir.every(Number.isFinite));
    if (f.len !== undefined) assert.ok(f.len > 0);
  }
});

test('squeeze then release: the tallest hall is at least 3x the lowest corridor', () => {
  const indoor = level.sectors.filter((s) => !has(s, 'sky'));
  const tallest = Math.max(...indoor.map(height));
  const corridors = level.sectors.filter((s) => has(s, 'corridor'));
  assert.ok(corridors.length > 0);
  const lowest = Math.min(...corridors.map(height));
  assert.ok(tallest >= 3 * lowest, `tallest ${tallest.toFixed(2)} m vs lowest corridor ${lowest.toFixed(2)} m`);
});

test('angles everywhere: every walkable sector over 20 m2 has a wall more than 5 degrees off the axes', () => {
  for (const s of level.sectors) {
    if (!walkable(s) || signedArea(s.poly) <= 20) continue;
    const angled = s.poly.some((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      const deg = (Math.atan2(Math.abs(b[1] - a[1]), Math.abs(b[0] - a[0])) * 180) / Math.PI;
      return Math.min(deg, 90 - deg) > 5;
    });
    assert.ok(angled, `${s.id} (${signedArea(s.poly).toFixed(0)} m2) is a plain box`);
  }
});

test('loadLevel converts Doom units to metres with y up and north as -z', () => {
  const tiny = loadLevel({
    unit: 0.03,
    sectors: [
      { id: 'a', poly: [[0, 0], [0, 100], [100, 100], [100, 0]], floor: 0, ceil: 100, tags: ['mat:steel'], light: 200 },
      { id: 'b', poly: [[100, 0], [100, 100], [200, 100], [200, 0]], floor: 20, ceil: 80, tags: ['mat:steel', 'window'], light: 200 },
    ],
    doors: [], lifts: [], start: { x: 50, y: 50, angle: 90 },
    pois: [{ id: 'p', x: 50, y: 50, look: [150, 50, 40], kind: 'window' }],
    fixtures: [{ kind: 'lamp', x: 50, y: 60, z: 90 }],
  });
  const a = tiny.byId.get('a');
  assert.ok(signedArea(a.poly) > 0, 'reversed to CCW');
  assert.ok(Math.abs(signedArea(a.poly) - 9) < 1e-9, '100 units square = 3 m square');
  assert.ok(a.poly.some(([x, z]) => Math.abs(x - 3) < EPS && Math.abs(z + 3) < EPS), 'y=100 north maps to z=-3');
  assert.ok(Math.abs(a.ceil - 3) < EPS && a.tags instanceof Set);
  assert.ok(Math.abs(tiny.start.x - 1.5) < EPS && Math.abs(tiny.start.z + 1.5) < EPS);
  assert.ok(Math.abs(tiny.start.yaw) < EPS, 'Doom angle 90 (north) is yaw 0 (looking down -z)');
  assert.deepEqual(tiny.pois[0].look.map((v) => +v.toFixed(6)), [4.5, 1.2, -1.5]);
  assert.ok(Math.abs(tiny.fixtures[0].y - 2.7) < EPS && Math.abs(tiny.fixtures[0].z + 1.8) < EPS);
  const kinds = tiny.walls.map((w) => w.kind).sort();
  // 6 outer edges are solid; the shared edge gives a lower step, an upper lip and a window.
  assert.deepEqual(kinds, ['lower', 'solid', 'solid', 'solid', 'solid', 'solid', 'solid', 'upper', 'window']);
  const lower = tiny.walls.find((w) => w.kind === 'lower');
  assert.equal(lower.front, 'a'); assert.equal(lower.back, 'b');
  assert.ok(Math.abs(lower.bottom - 0) < EPS && Math.abs(lower.top - 0.6) < EPS);
  const upper = tiny.walls.find((w) => w.kind === 'upper');
  assert.equal(upper.front, 'a');
  assert.ok(Math.abs(upper.bottom - 2.4) < EPS && Math.abs(upper.top - 3) < EPS);
  const win = tiny.walls.find((w) => w.kind === 'window');
  assert.ok(Math.abs(win.bottom - 0.6) < EPS && Math.abs(win.top - 2.4) < EPS);
});
