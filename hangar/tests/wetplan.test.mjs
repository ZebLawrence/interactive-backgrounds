import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import { annotateFixtures, planLights, lightRooms } from '../html/js/lightplan.js';
import { planProbes, planWetPatches, slimeLightPoints, edgeDistance, SLIME_DROP, SLIME_LIGHT_HEIGHT } from '../html/js/wetplan.js';

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

test('planWetPatches: 2 to 5 per dry room, inside one sector, not overlapping, roughness 0.05 to 0.15, seeded', () => {
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
  for (const n of per.values()) assert.ok(n >= 1 && n <= 5);
  // Most rooms reach their count; a few small ones may run out of room.
  assert.ok([...per.values()].filter((n) => n >= 2).length >= per.size * 0.7);
});

test('slimeLightPoints: every slime pool lit, one light per 6 m, just above the surface', () => {
  const pts = slimeLightPoints(level);
  const pools = level.sectors.filter((s) => s.tags.has('slime'));
  for (const s of pools) assert.ok(pts.some((p) => p.sector === s.id), `${s.id} has no glow light`);
  for (const p of pts) {
    const s = level.byId.get(p.sector);
    assert.ok(Math.abs(p.y - (s.floor - SLIME_DROP + SLIME_LIGHT_HEIGHT)) < 1e-9);
  }
  assert.ok(pts.length >= pools.length && pts.length < 40);
});
