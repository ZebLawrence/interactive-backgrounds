// A boat that steers herself ashore is the one failure nobody would forgive, and it would happen
// ten minutes after anybody stopped watching. So the autopilot is sailed round a made-up
// archipelago here for an hour of scene time, and checked for running aground, going in circles,
// and sawing at the wheel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV, buildChart, chartIndex, chartPoint, cellCost, findRoute, lineClear, stringPull,
  smoothRoute, Pilot,
} from '../html/js/nav.js';
import { Boat } from '../html/js/boat.js';
import { Rng, TAU, angleDiff } from '../html/js/mathutil.js';

/**
 * A made-up chart: a few round islands in otherwise deep water, plus a long bar across the middle
 * with one gap in it, so a straight line from one side to the other is never the answer.
 */
function makeWorld(seed = 4) {
  const rng = new Rng(seed);
  const islands = [];
  for (let i = 0; i < 14; i++) {
    islands.push({
      x: rng.range(-7000, 7000), z: rng.range(-7000, 7000),
      r: rng.range(300, 1100), h: rng.range(40, 400),
    });
  }
  return (x, z) => {
    let land = -140;
    for (const is of islands) {
      const d = Math.hypot(x - is.x, z - is.z);
      if (d < is.r) land = Math.max(land, is.h * (1 - d / is.r));
    }
    // A bar across z = 0 with a gap at x = 1500.
    const bar = Math.abs(z) < 260 && Math.abs(x - 1500) > 700;
    if (bar) land = Math.max(land, 6);
    return -land; // depth
  };
}

test('the chart marks foul ground and knows how far it is away', () => {
  const depthAt = makeWorld();
  const chart = buildChart(depthAt, 0, 0);
  assert.equal(chart.size, NAV.size);
  let foul = 0, deep = 0;
  for (let k = 0; k < chart.size * chart.size; k++) {
    if (chart.depth[k] < NAV.safeDepth) { foul++; assert.equal(chart.clear[k], 0); }
    else { deep++; assert.ok(chart.clear[k] > 0); }
  }
  assert.ok(foul > 50 && deep > foul, `${foul} foul cells, ${deep} clear`);
  // A cell in mid-channel must be cheaper than one hard against the rocks.
  const mid = chartIndex(chart, 1500, 0);
  const edge = chartIndex(chart, 2150, 0);
  assert.ok(cellCost(chart, mid) < cellCost(chart, edge), 'mid-channel should be the cheap way');
});

test('it finds the gap in the bar instead of trying to go through it', () => {
  const depthAt = makeWorld();
  const chart = buildChart(depthAt, 0, 0);
  // Pick points that really are in open water on either side of the bar, so the test is about
  // the planner rather than about where the random islands landed.
  const open = (z, sign) => {
    for (let r = 1000; r < 6000; r += 200) {
      for (let a = 0; a < 12; a++) {
        const x = -3000 + Math.cos((a / 12) * Math.PI * 2) * r * 0.3;
        const zz = z + sign * r * 0.3;
        if (depthAt(x, zz) > 60) return { x, z: zz };
      }
    }
    return null;
  };
  const a0 = open(-2500, -1), b0 = open(2500, 1);
  assert.ok(a0 && b0, 'the made-up world should have open water either side');
  const cells = findRoute(chart, chartIndex(chart, a0.x, a0.z), chartIndex(chart, b0.x, b0.z));
  assert.ok(cells, 'there must be a way round');
  const pts = smoothRoute(stringPull(chart, cells));
  // Every point on the route has water under it.
  for (const p of pts) assert.ok(depthAt(p.x, p.z) > NAV.safeDepth, `route crosses foul ground at ${p.x}, ${p.z}`);
  // And it goes through the gap, not over the bar.
  const crossings = pts.filter((p) => Math.abs(p.z) < 300);
  assert.ok(crossings.length > 0, 'it has to cross the bar somewhere');
  for (const p of crossings) assert.ok(Math.abs(p.x - 1500) < 900, `crossed the bar at x = ${p.x}`);
});

test('a route to somewhere unreachable comes back as nothing, not as a route through rock', () => {
  // An island in the middle of nowhere with a goal on top of it.
  const depthAt = (x, z) => (Math.hypot(x, z) < 900 ? -50 : 200);
  const chart = buildChart(depthAt, 0, 0);
  assert.equal(findRoute(chart, chartIndex(chart, 3000, 3000), chartIndex(chart, 0, 0)), null);
});

test('string pulling shortens the route and never cuts a corner it should not', () => {
  const depthAt = makeWorld(11);
  const chart = buildChart(depthAt, 0, 0);
  const cells = findRoute(chart, chartIndex(chart, -5000, -5000), chartIndex(chart, 5000, 4000));
  assert.ok(cells);
  const pulled = stringPull(chart, cells);
  assert.ok(pulled.length < cells.length, `${pulled.length} points from ${cells.length} cells`);
  // Every leg must stay in water. (It is allowed to pass closer to the rocks than the planner's
  // preferred clearance: that preference is a cost, not a rule, and in a narrow place it has to
  // give way.)
  for (let i = 0; i < pulled.length - 1; i++) {
    const a = pulled[i], b = pulled[i + 1];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 40);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      assert.ok(depthAt(x, z) > 0, `leg ${i} crosses land at ${x.toFixed(0)}, ${z.toFixed(0)}`);
    }
  }
});

test('she sails herself about for an hour without going aground', () => {
  const depthAt = makeWorld(7);
  const rng = new Rng(21);
  const ocean = {
    time: 0,
    sample: () => ({ h: 0, sx: 0, sz: 0 }),
    weather: { derived: { sea: 0.3 }, windDir: 0.7 },
  };
  const boat = new Boat(ocean, rng.fork('hull'));
  boat.position.set(-4000, 0, -4000);
  boat.heading = 0;
  const pilot = new Pilot(rng.fork('pilot'));
  pilot.setChart(buildChart(depthAt, boat.position.x, boat.position.z));
  const weather = { sea: 0.3, windDir: 0.7 };

  let worstDepth = 1e9, rudderWork = 0, lastRudder = 0, chartMoves = 0;
  const visited = [];
  const dt = 1 / 20; // the pilot runs every frame; twenty a second is plenty for an hour of it
  for (let i = 0; i < 3600 / dt; i++) {
    ocean.time = i * dt;
    pilot.step(dt, boat, weather, depthAt);
    // The physics wants its own small steps.
    for (let k = 0; k < 6; k++) boat.integrate(dt / 6, false);
    const d = depthAt(boat.position.x, boat.position.z);
    worstDepth = Math.min(worstDepth, d);
    rudderWork += Math.abs(boat.rudder - lastRudder);
    lastRudder = boat.rudder;
    if (i % 200 === 0) visited.push({ x: boat.position.x, z: boat.position.z });
    // The chart follows her, as the scene's does.
    if (Math.hypot(boat.position.x - pilot.chart.x0 - (pilot.chart.size * pilot.chart.cell) / 2,
      boat.position.z - pilot.chart.z0 - (pilot.chart.size * pilot.chart.cell) / 2) > 2200) {
      pilot.setChart(buildChart(depthAt, boat.position.x, boat.position.z));
      chartMoves++;
    }
  }

  assert.ok(worstDepth > 3, `she got into ${worstDepth.toFixed(1)} m of water`);
  // She has to actually go somewhere: an hour at six knots is eleven kilometres of ground.
  let run = 0;
  for (let i = 1; i < visited.length; i++) run += Math.hypot(visited[i].x - visited[i - 1].x, visited[i].z - visited[i - 1].z);
  assert.ok(run > 6000, `she only covered ${(run / 1000).toFixed(1)} km in an hour`);
  // And she has to explore rather than circle one spot.
  const spread = Math.max(...visited.map((p) => Math.hypot(p.x + 4000, p.z + 4000)));
  assert.ok(spread > 2500, `she never got more than ${spread.toFixed(0)} m from where she started`);
  // The wheel should not be sawing: a few hundred radians of total travel in an hour is a busy
  // passage; thousands means she is hunting.
  assert.ok(rudderWork < 400, `the rudder moved ${rudderWork.toFixed(0)} radians in an hour`);
  assert.ok(chartMoves > 0, 'the chart should have had to follow her');
});

test('told to come round, she comes round and then carries on', () => {
  const depthAt = () => 200;
  const rng = new Rng(3);
  const ocean = { time: 0, sample: () => ({ h: 0, sx: 0, sz: 0 }), weather: { derived: { sea: 0.2 }, windDir: 0 } };
  const boat = new Boat(ocean, rng.fork('hull'));
  boat.heading = 0;
  const pilot = new Pilot(rng.fork('pilot'));
  pilot.setChart(buildChart(depthAt, 0, 0));
  const weather = { sea: 0.2, windDir: 0 };
  for (let i = 0; i < 20 * 60; i++) { pilot.step(1 / 20, boat, weather, depthAt); for (let k = 0; k < 6; k++) boat.integrate(1 / 120, false); }
  pilot.steerCourse(Math.PI / 2, 120);
  for (let i = 0; i < 20 * 90; i++) { pilot.step(1 / 20, boat, weather, depthAt); for (let k = 0; k < 6; k++) boat.integrate(1 / 120, false); }
  assert.ok(Math.abs(angleDiff(boat.heading, Math.PI / 2)) < 0.25,
    `she is heading ${(boat.heading * 57.3).toFixed(0)} rather than 90`);
  // After the order runs out she goes back to her own business.
  for (let i = 0; i < 20 * 90; i++) { pilot.step(1 / 20, boat, weather, depthAt); for (let k = 0; k < 6; k++) boat.integrate(1 / 120, false); }
  assert.notEqual(pilot.state, 'altering');
});
