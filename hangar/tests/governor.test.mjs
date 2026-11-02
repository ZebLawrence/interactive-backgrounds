import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameGovernor, GOVERNOR } from '../html/js/governor.js';

// Feed n intervals of `ms` starting at time t (s); returns the time after.
const run = (g, n, ms, t = 0) => { for (let i = 0; i < n; i++) { t += ms / 1000; g.interval(ms, t); } return t; };
const probes = (g, n, ms, t) => { for (let i = 0; i < n; i++) { t += 1; g.probe(ms, t); } return t; };

test('governor: holds 60 when frames arrive on time, with the odd late one', () => {
  const g = new FrameGovernor();
  let t = 0;
  for (let k = 0; k < 20; k++) { t = run(g, 9, 16.7, t); t = run(g, 1, 33.4, t); } // 10% late
  t = probes(g, 10, 13, t); // within budget
  assert.equal(g.fps, 60);
});

test('governor: drops to 30 when a quarter of frames miss vsync', () => {
  const g = new FrameGovernor();
  let t = 0;
  for (let k = 0; k < 30 && g.fps === 60; k++) { t = run(g, 2, 16.7, t); t = run(g, 2, 33.4, t); }
  assert.equal(g.fps, 30);
});

test('governor: drops to 30 when probed frames cost more than 15 ms, not on one spike', () => {
  const g = new FrameGovernor();
  let t = probes(g, 4, 9, 0);
  t = probes(g, 1, 40, t); // one spike: median still 9
  assert.equal(g.fps, 60);
  t = probes(g, 5, 18, t);
  assert.equal(g.fps, 30);
});

test('governor: gaps (hidden tab, pauses) are not counted as late frames', () => {
  const g = new FrameGovernor();
  let t = 0;
  for (let k = 0; k < 100; k++) { t = run(g, 1, 16.7, t); t = run(g, 1, 5000, t); }
  assert.equal(g.fps, 60);
});

test('governor: hysteresis: climbs back only with clear headroom and after the cooldown', () => {
  const g = new FrameGovernor();
  let t = probes(g, 5, 20, 0);
  assert.equal(g.fps, 30);
  // 13 ms: fits 60 on paper, but not clear headroom (needs < 11): stays at 30.
  t = probes(g, 30, 13, t);
  assert.equal(g.fps, 30);
  // Fast frames right after the drop wait out the cooldown.
  const g2 = new FrameGovernor();
  let t2 = probes(g2, 5, 20, 0);
  const d2 = t2;
  while (g2.fps === 30) t2 = probes(g2, 1, 8, t2);
  assert.ok(t2 - d2 >= GOVERNOR.cooldown, `climbed after ${t2 - d2} s`);
});

test('governor: a climb that fails soon after doubles the cooldown, so it does not flap', () => {
  const g = new FrameGovernor();
  let t = probes(g, 5, 20, 0);
  const waits = [];
  for (let k = 0; k < 4; k++) {
    const d = t;
    while (g.fps === 30) t = probes(g, 1, 8, t); // headroom at 30 ...
    waits.push(t - d);
    t = probes(g, 5, 20, t); // ... but 60 can't hold
    assert.equal(g.fps, 30);
  }
  for (let k = 1; k < waits.length; k++) assert.ok(waits[k] >= 2 * waits[k - 1] - 1, `waits ${waits}`);
  // A long stable stretch at 60 resets the cooldown to the base.
  while (g.fps === 30) t = probes(g, 1, 8, t);
  t = run(g, 10, 16.7, t + GOVERNOR.flapWindow + 1);
  t = probes(g, 5, 20, t);
  assert.equal(g.cooldown, GOVERNOR.cooldown);
});

test('governor: describe names the state', () => {
  const g = new FrameGovernor();
  assert.match(g.describe(0), /^60/);
  probes(g, 5, 20, 0);
  assert.match(g.describe(5), /^30 \(frame 20\.0 ms; retry in \d+ s\)/);
});
