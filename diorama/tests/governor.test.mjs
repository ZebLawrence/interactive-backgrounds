import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, TIERS } from '../html/js/governor.js';

const feed = (g, ms, n = 90) => { let r = null; for (let i = 0; i < n; i++) r = g.frame(ms) ?? r; return r; };

test('a machine that holds 60 is left alone', () => {
  const g = new Governor();
  for (let i = 0; i < 20; i++) assert.equal(feed(g, 16.7), null);
  assert.equal(g.scale, 1); assert.equal(g.fps, 60);
});

test('one that cannot gives up resolution a step at a time, then the frame rate, and never climbs back', () => {
  const g = new Governor();
  for (let i = 1; i < TIERS.length; i++) { assert.equal(feed(g, 33.3), 'scale'); assert.equal(g.scale, TIERS[i]); }
  assert.equal(feed(g, 33.3), 'fps'); assert.equal(g.fps, 30);
  assert.equal(feed(g, 33.3), null);  // 30 is being held
  assert.equal(feed(g, 16.7), null);  // and a fast spell does not send it back up
  assert.equal(g.scale, TIERS[TIERS.length - 1]); assert.equal(g.fps, 30);
});

test('with full resolution asked for, only the frame rate steps', () => {
  const g = new Governor({ allowScale: false });
  assert.equal(feed(g, 33.3), 'fps');
  assert.equal(g.scale, 1); assert.equal(g.fps, 30);
});

test('a few late frames are not a verdict, a quarter of them are; hitches and hidden tabs do not count', () => {
  const g = new Governor();
  for (let i = 0; i < 90; i++) assert.equal(g.frame(i % 10 === 0 ? 33.3 : 16.7), null);
  let r = null;
  for (let i = 0; i < 90; i++) r = g.frame(i % 3 === 0 ? 33.3 : 16.7) ?? r;
  assert.equal(r, 'scale');
  const h = new Governor();
  for (let i = 0; i < 500; i++) assert.equal(h.frame(4000), null);
  assert.equal(h.frame(NaN), null); assert.equal(h.frame(-1), null);
  h.settle();
  assert.equal(feed(h, 16.7), null);
});
