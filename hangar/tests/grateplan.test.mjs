import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { buildNavGraph } from '../html/js/navgraph.js';
import { makeRng } from '../html/js/rng.js';
import { makeTour } from '../html/js/tour.js';
import { Walker } from '../html/js/walker.js';
import { walkwayPlan, barSegments, postPoints, offsetPolyline, GRATE, RAIL } from '../html/js/grateplan.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const plan = walkwayPlan(level);
const segDist = (px, pz, [ax, az], [bx, bz]) => {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2));
  return Math.hypot(ax + ex * t - px, az + ez * t - pz);
};
const railDist = (x, z) => Math.min(...plan.rails.flatMap((r) => r.points.slice(1).map((p, i) => segDist(x, z, r.points[i], p))));

test('walkwayPlan: every walkway sector, with drops to the slime on both sides and openings at the landings', () => {
  assert.equal(plan.sectors.length, level.sectors.filter((s) => s.tags.has('walkway')).length);
  for (const s of plan.sectors) {
    assert.ok(Math.abs(Math.hypot(...s.dir) - 1) < 1e-9);
    assert.ok(s.edges.some((e) => e.kind === 'drop'), `${s.id} has no drop edge`);
    for (const e of s.edges.filter((e) => e.kind === 'drop')) assert.ok(level.byId.get(e.below).tags.has('slime'));
  }
  // The landing opens onto hall-c, the last leg onto the south corridor: no railing across either.
  const landing = plan.sectors.find((s) => s.id === 'zz-landing');
  assert.ok(landing.edges.some((e) => e.kind === 'open'));
});

test('walkwayPlan: two railings, one each side, inside the walkway, posts at most 1.5 m apart', () => {
  assert.equal(plan.rails.length, 2);
  for (const r of plan.rails) {
    assert.ok(r.points.length >= 5);
    for (const [x, z] of r.points) assert.ok(sectorAt(level, x, z)?.tags.has('walkway'), `rail point ${x},${z} is off the walkway`);
    const posts = postPoints(r.points);
    for (let i = 1; i < posts.length; i++) assert.ok(Math.hypot(posts[i][0] - posts[i - 1][0], posts[i][1] - posts[i - 1][1]) <= RAIL.spacing + 1e-9);
  }
});

test('walkwayPlan: columns reach below the slime surface and sit under the walkway', () => {
  assert.ok(plan.supports.length >= 8);
  for (const p of plan.supports) {
    assert.ok(p.bottom < -1.44 - 0.15 - 0.2, `column at ${p.x},${p.z} stops above the slime`);
    assert.ok(p.top < -0.48);
  }
});

test('barSegments: bars stay inside the outline at the stated pitch', () => {
  const sq = [[0, 0], [2, 0], [2, 1], [0, 1]];
  const bars = barSegments(sq, [1, 0], 0.035, 0.003);
  assert.equal(bars.length, Math.round(1 / 0.035)); // centres at 0.5, 1.5, ... 28.5 pitches
  for (const [x0, z0, x1, z1] of bars) {
    assert.ok(x0 > 0 && x1 < 2 && z0 > 0 && z0 < 1 && Math.abs(z1 - z0) < 1e-9);
    assert.ok(Math.abs(x1 - x0 - (2 - 0.006)) < 1e-9);
  }
  for (const s of plan.sectors) {
    const b = barSegments(s.poly, s.dir, GRATE.pitch, 0.003);
    assert.ok(b.length > 50, `${s.id} has only ${b.length} bars`);
    for (const [x0, z0, x1, z1] of b) assert.equal(sectorAt(level, (x0 + x1) / 2, (z0 + z1) / 2)?.id, s.id);
  }
});

test('offsetPolyline: a straight run moves by d, a sharp corner is capped', () => {
  const o = offsetPolyline([[0, 0], [1, 0], [2, 0]], [[0, 1], [0, 1]], 0.05);
  for (const [, z] of o) assert.ok(Math.abs(z - 0.05) < 1e-9);
  const c = offsetPolyline([[0, 0], [1, 0], [0, 0.05]], [[0, 1], [-0.05, -1]], 0.05);
  assert.ok(Math.hypot(c[1][0] - 1, c[1][1]) <= 0.15 + 1e-9);
});

test('the walking camera keeps its body clear of the railings', () => {
  const graph = buildNavGraph(level);
  let worst = Infinity, onWalkway = 0;
  for (const seed of [1, 2, 3]) {
    const rng = makeRng(seed);
    const w = new Walker(level, graph, makeTour(level.pois, rng.fork('tour')), rng.fork('walker'));
    const inp = { gaze: null, restedAt: null, click: null };
    for (let i = 0; i < 60 * 600; i++) {
      const p = w.step(1 / 30, inp);
      if (sectorAt(level, p.x, p.z)?.tags.has('walkway')) { onWalkway++; worst = Math.min(worst, railDist(p.x, p.z)); }
    }
  }
  assert.ok(onWalkway > 100, 'the tour never crossed the walkway');
  assert.ok(worst > 0.25, `camera came within ${worst.toFixed(2)} m of a railing`);
});
