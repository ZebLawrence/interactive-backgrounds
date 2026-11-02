import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import { makeTour } from '../html/js/tour.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const pois = level.pois;

test('no poi repeats within 4 picks over 1 000 picks', () => {
  const tour = makeTour(pois, makeRng(1));
  const picks = [];
  for (let i = 0; i < 1000; i++) {
    const p = tour.next();
    assert.ok(pois.includes(p), 'picks come from the poi list');
    for (let k = 1; k <= 4 && i - k >= 0; k++) assert.notEqual(p.id, picks[i - k].id, `pick ${i} repeats pick ${i - k}`);
    picks.push(p);
  }
});

test('window and view pois are picked more often than room pois', () => {
  const tour = makeTour(pois, makeRng(7));
  const count = new Map(pois.map((p) => [p.id, 0]));
  for (let i = 0; i < 5000; i++) { const p = tour.next(); count.set(p.id, count.get(p.id) + 1); }
  const mean = (kinds) => {
    const ps = pois.filter((p) => kinds.includes(p.kind));
    return ps.reduce((a, p) => a + count.get(p.id), 0) / ps.length;
  };
  assert.ok(mean(['window', 'view']) > mean(['room']), `window/view ${mean(['window', 'view'])} vs room ${mean(['room'])}`);
});

test('nearer pois are weighted higher, and the poi you stand at is never picked', () => {
  const from = pois.find((p) => p.id === 'start');
  const near = pois.find((p) => p.id === 'start-window');
  const far = pois.find((p) => p.id === 'exit-view'); // same kind, on the other side of the base
  let n = 0, f = 0;
  const rng = makeRng(3);
  for (let i = 0; i < 3000; i++) {
    const p = makeTour(pois, rng.fork(i)).next(from);
    assert.notEqual(p.id, from.id);
    if (p === near) n++;
    if (p === far) f++;
  }
  assert.ok(n > f * 1.5, `near ${n} vs far ${f}`);
});

test('next() accepts a plain point to measure from, and is deterministic per seed', () => {
  const a = makeTour(pois, makeRng(5)), b = makeTour(pois, makeRng(5));
  for (let i = 0; i < 50; i++) {
    const at = { x: 60 + i, z: 100 };
    assert.equal(a.next(at).id, b.next(at).id);
  }
});
