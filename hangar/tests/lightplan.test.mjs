import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import {
  lightRooms, annotateFixtures, planLights, pickShadowCasters, pickNearest, updateSlots, flickerAt, emergencyPoints, DEAD_SPACING,
} from '../html/js/lightplan.js';

const json = JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8'));
const level = loadLevel(json);
const fixtures = annotateFixtures(level);
const mains = (plan) => plan.filter((f) => f.kind !== 'emergency');
const plan1 = planLights(fixtures, makeRng(1).fork('lights'));

test('annotateFixtures: every fixture gets a sector and a room; the start room and window/view rooms keep their lights', () => {
  assert.equal(fixtures.length, level.fixtures.length);
  for (const f of fixtures) { assert.ok(f.sector, `fixture at ${f.x},${f.z} has no sector`); assert.ok(Number.isInteger(f.room)); }
  // Fixtures 0..6 hang over the start platform and pit: one room, the start room.
  for (let i = 0; i <= 6; i++) { assert.ok(fixtures[i].start, `fixture ${i} not in the start room`); assert.ok(fixtures[i].keepLit); }
  // The computer room has a window poi, so it is kept lit; the dim corridors are not.
  assert.ok(fixtures[12].keepLit && fixtures[15].keepLit);
  assert.ok(!fixtures[10].keepLit && !fixtures[23].keepLit);
  // Rooms are not merged through corridors, doors or window sills: the start room is not the armour room.
  const rooms = lightRooms(level);
  assert.notEqual(rooms.get('start-pit'), rooms.get('armor-room'));
  assert.equal(rooms.get('start-pit'), rooms.get('start-plat'));
});

test('planLights seed 1: ~8% of lamps flicker and ~5% are dead (within ±50%), emergency fixtures never', () => {
  const m = mains(plan1);
  const flick = m.filter((f) => f.flicker).length / m.length;
  const dead = m.filter((f) => f.dead).length / m.length;
  assert.ok(flick >= 0.04 && flick <= 0.12, `flicker fraction ${flick}`);
  assert.ok(dead >= 0.025 && dead <= 0.075, `dead fraction ${dead}`);
  for (const f of plan1.filter((g) => g.kind === 'emergency')) { assert.equal(f.dead, false); assert.equal(f.flicker, null); }
  for (const f of plan1) if (f.flicker) {
    assert.ok(f.flicker.rate > 0 && f.flicker.depth > 0 && f.flicker.depth <= 1);
    assert.equal(f.dead, false, 'a dead light does not also flicker');
  }
});

test('planLights over 60 seeds: fractions hold, never dead in a kept-lit room, never two dead close together', () => {
  for (let seed = 0; seed < 60; seed++) {
    const p = planLights(fixtures, makeRng(seed).fork('lights'));
    const m = mains(p);
    const flick = m.filter((f) => f.flicker).length / m.length, dead = m.filter((f) => f.dead).length / m.length;
    assert.ok(flick >= 0.04 && flick <= 0.12, `seed ${seed} flicker ${flick}`);
    assert.ok(dead >= 0.025 && dead <= 0.075, `seed ${seed} dead ${dead}`);
    const deads = p.filter((f) => f.dead);
    for (const f of deads) { assert.ok(!f.keepLit, `seed ${seed}: dead light in a kept-lit room (${f.sector})`); assert.ok(!f.start); }
    for (const f of p) if (f.start) assert.equal(f.flicker, null, `seed ${seed}: the start room flickers`);
    for (let i = 0; i < deads.length; i++) for (let j = i + 1; j < deads.length; j++) {
      const d = Math.hypot(deads[i].x - deads[j].x, deads[i].z - deads[j].z);
      assert.ok(d >= DEAD_SPACING, `seed ${seed}: two dead lights ${d.toFixed(1)} m apart`);
    }
  }
});

test('planLights is reproducible per seed, differs across seeds, and keeps each fixture\'s fields', () => {
  const a = planLights(fixtures, makeRng(5).fork('lights')), b = planLights(fixtures, makeRng(5).fork('lights'));
  assert.deepEqual(a, b);
  const sig = (s) => JSON.stringify(planLights(fixtures, makeRng(s).fork('lights')).map((f) => [!!f.flicker, f.dead]));
  assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(sig)).size > 2, 'eight seeds gave too few distinct plans');
  assert.equal(a.length, fixtures.length);
  a.forEach((f, i) => { assert.equal(f.kind, fixtures[i].kind); assert.equal(f.x, fixtures[i].x); assert.equal(f.y, fixtures[i].y); });
  // The planner does not mutate its input.
  assert.ok(fixtures.every((f) => f.dead === undefined && f.flicker === undefined));
});

test('pickShadowCasters: at most n indices, only live lamps, nearest first', () => {
  const cam = { x: 31.7, y: 1.7, z: 106 };
  for (const n of [0, 1, 2, 4, 40]) {
    const idx = pickShadowCasters(plan1, cam, n);
    assert.ok(idx.length <= n);
    const d = idx.map((i) => Math.hypot(plan1[i].x - cam.x, plan1[i].y - cam.y, plan1[i].z - cam.z));
    for (let k = 1; k < d.length; k++) assert.ok(d[k] >= d[k - 1], 'not nearest first');
    for (const i of idx) { assert.equal(plan1[i].kind, 'lamp'); assert.equal(plan1[i].dead, false); }
  }
  assert.equal(pickShadowCasters(plan1, cam, 40).length, plan1.filter((f) => f.kind === 'lamp' && !f.dead).length);
  // The four start-room lamps are the nearest four at the start.
  assert.deepEqual(pickShadowCasters(plan1, cam, 4).sort((a, b) => a - b), [3, 4, 5, 6]);
  // A dead lamp is skipped even when it is the nearest.
  const withDead = plan1.map((f, i) => (i === 5 ? { ...f, dead: true } : f));
  assert.ok(!pickShadowCasters(withDead, { x: 28.1, y: 3, z: 102.4 }, 4).includes(5));
});

test('pickShadowCasters: with a view direction, lamps in front win over equally near lamps behind', () => {
  const lights = [
    { kind: 'lamp', x: 0, y: 3, z: 4, dead: false }, // behind (camera looks -z)
    { kind: 'lamp', x: 0, y: 3, z: -4, dead: false }, // in front
    { kind: 'strip', x: 0, y: 3, z: -1, dead: false },
  ];
  assert.deepEqual(pickShadowCasters(lights, { x: 0, y: 1.7, z: 0 }, 1, { x: 0, y: 0, z: -1 }), [1]);
  // A lamp right overhead or just behind is still "near": it beats a far one in front.
  lights.push({ kind: 'lamp', x: 0, y: 3, z: -30, dead: false });
  assert.deepEqual(pickShadowCasters(lights, { x: 0, y: 1.7, z: 0 }, 3, { x: 0, y: 0, z: -1 }), [1, 0, 3]);
});

test('pickNearest: n nearest by a filter, nearest first', () => {
  const pts = [{ x: 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 2, y: 0, z: 0, skip: true }];
  assert.deepEqual(pickNearest(pts, { x: 0, y: 0, z: 0 }, 2, (p) => !p.skip), [1, 2]);
});

test('updateSlots: a slot fades in its light, fades a dropped one out before reuse, never holds one id twice', () => {
  const slots = [{ id: null, w: 0 }, { id: null, w: 0 }];
  updateSlots(slots, [7, 9], 0.1, 0.5);
  assert.deepEqual(slots.map((s) => s.id).sort(), [7, 9]);
  assert.ok(slots.every((s) => s.w > 0 && s.w < 1), 'fades, does not pop');
  for (let i = 0; i < 10; i++) updateSlots(slots, [7, 9], 0.1, 0.5);
  assert.ok(slots.every((s) => s.w === 1));
  // 9 leaves, 4 arrives: 9's slot fades out first and only then takes 4.
  updateSlots(slots, [7, 4], 0.1, 0.5);
  const s9 = slots.find((s) => s.id === 9);
  assert.ok(s9 && s9.w < 1 && s9.w > 0);
  assert.ok(!slots.some((s) => s.id === 4));
  for (let i = 0; i < 10; i++) updateSlots(slots, [7, 4], 0.1, 0.5);
  assert.deepEqual(slots.map((s) => s.id).sort(), [4, 7]);
  // More desired than slots: the earlier (nearer) ids win; no duplicates.
  const few = [{ id: null, w: 0 }];
  updateSlots(few, [3, 2, 1], 0.1, 0.5);
  assert.equal(few[0].id, 3);
  updateSlots(slots, [7, 7, 4], 0.1, 0.5);
  assert.equal(new Set(slots.map((s) => s.id)).size, slots.length);
  // dt = 0 changes nothing but still assigns free slots at weight 0.
  const z = [{ id: null, w: 0 }];
  updateSlots(z, [1], 0, 0.5);
  assert.equal(z[0].id, 1);
  assert.equal(z[0].w, 0);
});

test('flickerAt: steady without flicker, deterministic, in [1 - depth, 1], dips now and then', () => {
  assert.equal(flickerAt(null, 3.2), 1);
  const fl = { rate: 0.4, depth: 0.8, phase: 0.37 };
  let lo = 1, dips = 0, prev = 1;
  for (let t = 0; t < 120; t += 1 / 60) {
    const v = flickerAt(fl, t);
    assert.equal(v, flickerAt(fl, t));
    assert.ok(Number.isFinite(v) && v >= 1 - fl.depth - 1e-9 && v <= 1 + 1e-9, `flicker ${v} at ${t}`);
    lo = Math.min(lo, v);
    if (prev >= 0.99 && v < 0.99) dips++;
    prev = v;
  }
  assert.ok(lo < 0.5, 'never dipped');
  // Mostly on: a flickering tube is lit most of the time, and the dips come in bursts, not continuously.
  let on = 0;
  for (let t = 0; t < 120; t += 1 / 60) if (flickerAt(fl, t) > 0.99) on++;
  assert.ok(on / (120 * 60) > 0.6, `on only ${on / 7200}`);
  assert.ok(dips >= 5, `only ${dips} dips in two minutes`);
});

test('emergencyPoints: every emergency fixture, plus battery beacons so every lit room has red light', () => {
  const pts = emergencyPoints(plan1);
  for (const f of plan1.filter((g) => g.kind === 'emergency')) assert.ok(pts.some((p) => p.x === f.x && p.z === f.z && p.source === 'fixture'));
  const rooms = new Set(plan1.filter((f) => f.kind !== 'emergency').map((f) => f.room));
  for (const r of rooms) assert.ok(pts.some((p) => p.room === r), `room ${r} has no emergency light`);
  for (const p of pts) assert.ok(Number.isFinite(p.x + p.y + p.z));
  const beacons = pts.filter((p) => p.source === 'beacon');
  for (let i = 0; i < beacons.length; i++) for (let j = i + 1; j < beacons.length; j++) {
    assert.ok(Math.hypot(beacons[i].x - beacons[j].x, beacons[i].z - beacons[j].z) >= 4, 'beacons crowd each other');
  }
  assert.deepEqual(emergencyPoints(plan1), pts);
});
