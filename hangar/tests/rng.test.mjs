import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../html/js/rng.js';

test('same seed gives the same first 100 values', () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('next() stays in [0,1)', () => {
  const r = makeRng(7);
  for (let i = 0; i < 10000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); }
});

test('int(1,6) is inclusive on both ends', () => {
  const r = makeRng(3), seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(r.int(1, 6));
  assert.ok(seen.has(1) && seen.has(6));
  assert.ok([...seen].every((v) => v >= 1 && v <= 6));
});

test('range and pick stay in bounds', () => {
  const r = makeRng(9), arr = ['a', 'b', 'c'];
  for (let i = 0; i < 1000; i++) {
    const v = r.range(2, 5); assert.ok(v >= 2 && v < 5);
    assert.ok(arr.includes(r.pick(arr)));
  }
});

test('forks are independent, distinct and reproducible', () => {
  const seq = (r) => Array.from({ length: 20 }, () => r.next());
  const p = seq(makeRng(5).fork('props')), t = seq(makeRng(5).fork('tour'));
  assert.notDeepEqual(p, t);
  assert.deepEqual(p, seq(makeRng(5).fork('props')));
  // drawing from the parent does not shift a fork
  const parent = makeRng(5); parent.next(); parent.next();
  assert.deepEqual(p, seq(parent.fork('props')));
});
