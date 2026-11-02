import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import { annotateFixtures, planLights, lightRooms } from '../html/js/lightplan.js';
import { planProbes, planWetPatches, slimeLightPoints, slimeUnder, edgeDistance, insidePoly, polyArea, SLIME_DROP, SLIME_LIGHT_HEIGHT, SLIME_LIGHT_MIN_CLEAR } from '../html/js/wetplan.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const fixtures = planLights(annotateFixtures(level), makeRng(1).fork('lights'));

test('planProbes: every sector has a probe; probes stand inside their room, between floor and ceiling', () => {
  const { probes, bySector } = planProbes(level);
  assert.ok(probes.length >= 10 && probes.length <= 30, `${probes.length} probes`);
  const rooms = lightRooms(level);
  for (const s of level.sectors) assert.ok(Number.isInteger(bySector.get(s.id)), `${s.id} has no probe`);
  for (const p of probes) {
    const s = sectorAt(level, p.x, p.z);
    assert.ok(s, `probe at ${p.x},${p.z} is outside the level`);
    assert.equal(rooms.get(s.id), p.room);
    assert.ok(p.y > s.floor + 0.5 && p.y < s.ceil, `probe in ${s.id} at y ${p.y}`);
  }
});

test('planWetPatches: 2 to 5 per dry room (every one), inside one sector, not overlapping, roughness 0.05 to 0.15, seeded', () => {
  const a = planWetPatches(level, fixtures, makeRng(7).fork('wet'));
  const b = planWetPatches(level, fixtures, makeRng(7).fork('wet'));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, planWetPatches(level, fixtures, makeRng(8).fork('wet')));
  const rooms = lightRooms(level), per = new Map();
  for (const p of a) {
    const s = level.byId.get(p.sector);
    assert.ok(edgeDistance(s.poly, p.x, p.z) >= p.r * p.stretch);
    assert.equal(sectorAt(level, p.x, p.z).id, p.sector);
    assert.ok(!s.tags.has('slime') && !s.tags.has('walkway') && !s.tags.has('sky'));
    assert.ok(p.roughness >= 0.05 && p.roughness <= 0.15);
    per.set(rooms.get(p.sector), (per.get(rooms.get(p.sector)) ?? 0) + 1);
    for (const q of a) if (q !== p) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r);
  }
  assert.ok(per.size >= 8, `only ${per.size} rooms have wet patches`);
  for (const n of per.values()) assert.ok(n >= 2 && n <= 5, `a room has ${n} wet patches`);
});

test('slimeLightPoints: about one light per 6 m square of pool, under the walkway too, clear of the rim', () => {
  const pts = slimeLightPoints(level);
  const under = slimeUnder(level);
  const pool = level.sectors.filter((s) => s.tags.has('slime') || under.has(s.id));
  const area = pool.reduce((a, s) => a + polyArea(s.poly), 0);
  assert.ok(pts.length >= area / 36 * 0.75 && pts.length <= area / 36 * 1.5, `${pts.length} lights for ${area.toFixed(0)} m²`);
  for (const s of level.sectors.filter((t) => t.tags.has('slime'))) {
    const y = s.floor - SLIME_DROP + SLIME_LIGHT_HEIGHT;
    assert.ok(pts.some((p) => Math.abs(p.y - y) < 1e-6), `the pool at ${s.id} has no glow light`);
  }
  assert.ok(pts.some((p) => under.has(p.sector)), 'no glow light under the walkway');
  for (const p of pts.filter((q) => under.has(q.sector))) assert.ok(level.byId.get(p.sector).floor - p.y >= 0.8, 'a glow light sits too close under the deck');
  for (const p of pts) {
    assert.ok(p.clear >= SLIME_LIGHT_MIN_CLEAR);
    assert.ok(pool.some((s) => s.id === p.sector && insidePoly(s.poly, p.x, p.z)));
  }
});

test('planWetPatches: over 100 seeds every dry room gets at least 2 patches', () => {
  const rooms = lightRooms(level);
  let eligible = null;
  for (let seed = 1; seed <= 100; seed++) {
    const f = planLights(annotateFixtures(level), makeRng(seed).fork('lights'));
    const per = new Map();
    for (const p of planWetPatches(level, f, makeRng(seed).fork('wet'))) per.set(rooms.get(p.sector), (per.get(rooms.get(p.sector)) ?? 0) + 1);
    eligible ??= per.size;
    assert.equal(per.size, eligible, `seed ${seed}: a room has no wet patch`);
    for (const [r, n] of per) assert.ok(n >= 2, `seed ${seed}: room ${r} has ${n}`);
  }
});
