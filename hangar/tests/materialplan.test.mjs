import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import { planMaterials, sectorRooms, familyOf, VARIANTS } from '../html/js/materialplan.js';

const json = JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../html/assets/manifest.json', import.meta.url), 'utf8'));
const level = loadLevel(json);

test('every planned variant has a manifest material', () => {
  for (let seed = 0; seed < 50; seed++) {
    for (const [id, p] of planMaterials(level, makeRng(seed).fork('materials'))) {
      for (const v of [p.floor, p.wall, p.ceil]) assert.ok(manifest.materials[`mat:${v}`], `${id}: mat:${v} not in manifest`);
    }
  }
  for (const fam of Object.values(VARIANTS)) for (const list of Object.values(fam)) for (const [v] of list) assert.ok(manifest.materials[`mat:${v}`], v);
});

test('the plan is deterministic per seed and differs across seeds', () => {
  const a = planMaterials(level, makeRng(7).fork('materials'));
  const b = planMaterials(level, makeRng(7).fork('materials'));
  assert.deepEqual([...a], [...b]);
  const sig = (s) => JSON.stringify([...planMaterials(level, makeRng(s).fork('materials'))]);
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(sig)).size > 1, 'six seeds all gave the same plan');
});

test('a room (connected same-family run) is uniform: the tunnel steps share one floor', () => {
  const rooms = sectorRooms(level);
  const tunnel = ['tun-step-1', 'tun-step-2', 'tun-step-3', 'tun-step-4', 'tunnel-diag', 'tunnel-bend', 'tunnel-sq'];
  assert.equal(new Set(tunnel.map((id) => rooms.get(id))).size, 1);
  for (let seed = 0; seed < 20; seed++) {
    const plan = planMaterials(level, makeRng(seed).fork('materials'));
    assert.equal(new Set(tunnel.map((id) => plan.get(id).floor)).size, 1, `seed ${seed}`);
    for (const s of level.sectors) {
      if (s.tags.has('door')) continue;
      for (const t of level.sectors) {
        if (rooms.get(s.id) === rooms.get(t.id) && !t.tags.has('door')) assert.deepEqual(plan.get(s.id), plan.get(t.id));
      }
    }
  }
});

test('rooms never join across families; single-variant families keep their own tag', () => {
  const rooms = sectorRooms(level);
  const famOfRoom = new Map();
  for (const s of level.sectors) {
    const r = rooms.get(s.id);
    if (famOfRoom.has(r)) assert.equal(famOfRoom.get(r), familyOf(s));
    else famOfRoom.set(r, familyOf(s));
  }
  const plan = planMaterials(level, makeRng(3).fork('materials'));
  for (const s of level.sectors) {
    if (familyOf(s) === 'regolith') assert.deepEqual(plan.get(s.id), { floor: 'regolith', wall: 'regolith', ceil: 'regolith' });
    if (familyOf(s) === 'grate') assert.equal(plan.get(s.id).floor, 'grate');
  }
});

test('over many seeds the concrete and steel variants all appear', () => {
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) for (const p of planMaterials(level, makeRng(seed).fork('materials')).values()) [p.floor, p.wall, p.ceil].forEach((v) => seen.add(v));
  for (const v of ['concrete', 'concrete-cracked', 'concrete-stained', 'concrete-painted', 'steel', 'steel-brushed']) assert.ok(seen.has(v), v);
});
