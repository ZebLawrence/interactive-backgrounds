import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { buildNavGraph, clearanceAt } from '../html/js/navgraph.js';
import { makeRng } from '../html/js/rng.js';
import { makeTour } from '../html/js/tour.js';
import { Walker, resolveClickTarget } from '../html/js/walker.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const graph = buildNavGraph(level);
const DT = 1 / 60;
const DEG = Math.PI / 180;
const NONE = { gaze: null, restedAt: null, click: null };

function makeWalker(seed = 1, opts) {
  const rng = makeRng(seed);
  return new Walker(level, graph, makeTour(level.pois, rng.fork('tour')), rng.fork('walk'), opts);
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const finite = (p) => ['x', 'y', 'z', 'yaw', 'pitch', 'roll'].every((k) => Number.isFinite(p[k]));
const copy = (p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, roll: p.roll });

test('30 simulated minutes: pace, clearance, no NaN, yaw rate, and at least 6 pois', () => {
  const w = makeWalker(1);
  let prev = copy(w.step(DT, NONE));
  let maxSpeed = 0, minClear = Infinity, maxYawRate = 0, maxDy = 0, prevRate = 0, maxAccel = 0, atCap = 0, steps = 0;
  const reached = new Set();
  const states = new Set();
  for (let i = 0; i < 30 * 60 * 60; i++) {
    const p = w.step(DT, NONE);
    assert.ok(finite(p), `NaN in pose at step ${i}: ${JSON.stringify(p)}`);
    const speed = Math.hypot(p.x - prev.x, p.z - prev.z) / DT;
    const yawRate = Math.abs(wrap(p.yaw - prev.yaw)) / DT;
    const clear = clearanceAt(level, p.x, p.z);
    maxSpeed = Math.max(maxSpeed, speed);
    maxYawRate = Math.max(maxYawRate, yawRate);
    minClear = Math.min(minClear, clear);
    maxDy = Math.max(maxDy, Math.abs(p.y - prev.y));
    // Head turns ease in and out: bounded angular acceleration, and almost never at the rate cap.
    const rate = wrap(p.yaw - prev.yaw) / DT;
    if (i > 0) maxAccel = Math.max(maxAccel, Math.abs(rate - prevRate) / DT);
    prevRate = rate;
    if (yawRate > 80 * DEG) atCap++;
    steps++;
    // Never drifts sideways or backwards: while moving, it goes the way the body faces.
    if (speed > 0.1) {
      const off = Math.abs(wrap(Math.atan2(-(p.x - prev.x), -(p.z - prev.z)) - w.body.x));
      assert.ok(off < 90 * DEG, `moving ${(off / DEG).toFixed(0)} deg off the body's facing at step ${i}`);
    }
    assert.ok(speed <= 1.0, `speed ${speed.toFixed(3)} m/s at step ${i}`);
    assert.ok(clear >= 0.35, `clearance ${clear.toFixed(3)} m at step ${i} (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
    assert.ok(yawRate <= 90 * DEG + 1e-9, `yaw rate ${(yawRate / DEG).toFixed(1)} deg/s at step ${i}`);
    states.add(w.state);
    if (w.state === 'pausing' && w.target) reached.add(w.target.id);
    prev = copy(p);
  }
  assert.ok(maxAccel <= 150 * DEG + 1e-6, `yaw acceleration ${(maxAccel / DEG).toFixed(0)} deg/s²`);
  assert.ok(atCap / steps < 0.001, `${((100 * atCap) / steps).toFixed(2)}% of steps turning faster than 80 deg/s`);
  assert.ok(reached.size >= 6, `reached only ${reached.size} pois`);
  assert.ok(states.has('walking') && states.has('pausing'));
  assert.ok(maxDy < 0.03, `vertical jump of ${maxDy} m in one step (stairs must be smoothed)`);
});

test('2 simulated hours with one restedAt at the start: the tour never stalls', () => {
  const w = makeWalker(1);
  const hit = { x: level.start.x + 4, y: 1.5, z: level.start.z - 2 };
  let prev = copy(w.step(DT, { ...NONE, restedAt: hit }));
  let still = 0, stalled = 0, longest = 0;
  const steps = 2 * 3600 * 60;
  for (let i = 0; i < steps; i++) {
    const p = w.step(DT, NONE);
    const speed = Math.hypot(p.x - prev.x, p.z - prev.z) / DT;
    if (speed < 0.02) still += DT;
    else { if (still > 12) stalled += still; longest = Math.max(longest, still); still = 0; }
    prev = copy(p);
  }
  if (still > 12) stalled += still;
  longest = Math.max(longest, still);
  assert.ok(stalled / (steps * DT) < 0.1, `${(100 * stalled / (steps * DT)).toFixed(1)}% of time in long stops`);
});

test('a single huge step (tab hidden for an hour) moves at most 1/15 s of travel', () => {
  const w = makeWalker(2);
  let n = 0;
  while (!(w.state === 'walking' && w.speed > 0.5) && n++ < 60 * 600) w.step(DT, NONE);
  assert.equal(w.state, 'walking');
  const a = copy(w.step(DT, NONE));
  const b = w.step(3600, {});
  assert.ok(finite(b));
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  assert.ok(moved <= 1.0 / 15 + 1e-6, `moved ${moved} m in one step`);
});

test('restedAt pauses about 4 s looking at the point, then the tour carries on', () => {
  const w = makeWalker(3);
  for (let i = 0; i < 60 * 30; i++) w.step(DT, NONE);
  while (w.state !== 'walking') w.step(DT, NONE);
  for (let i = 0; i < 60; i++) w.step(DT, NONE);
  const p0 = copy(w.step(DT, NONE));
  const look = { x: p0.x + 5 * Math.sin(-p0.yaw + Math.PI / 2), y: p0.y, z: p0.z + 5 * Math.cos(-p0.yaw + Math.PI / 2) };
  w.step(DT, { ...NONE, restedAt: look });
  assert.equal(w.state, 'looking');
  let t = 0;
  while (w.state === 'looking' && t < 20) { w.step(DT, NONE); t += DT; }
  assert.ok(t > 3.5 && t < 8, `looked for ${t.toFixed(2)} s`);
  // Facing the rested point at the end of the look.
  const p = copy(w.step(DT, NONE));
  const want = Math.atan2(-(look.x - p.x), -(look.z - p.z));
  assert.ok(Math.abs(wrap(p.yaw - want)) < 20 * DEG, `yaw off by ${(wrap(p.yaw - want) / DEG).toFixed(1)} deg`);
  let moved = 0;
  for (let i = 0; i < 60 * 30; i++) { const q = w.step(DT, NONE); moved = Math.max(moved, Math.hypot(q.x - p.x, q.z - p.z)); }
  assert.ok(moved > 2, 'carries on touring after the look');
});

test('resolveClickTarget: sky and slime give null, the start-room floor gives a node', () => {
  const yard = level.sectors.find((s) => s.id === 'yard-east');
  const cx = yard.poly.reduce((a, p) => a + p[0], 0) / yard.poly.length;
  const cz = yard.poly.reduce((a, p) => a + p[1], 0) / yard.poly.length;
  assert.equal(sectorAt(level, cx, cz)?.id, 'yard-east');
  assert.equal(resolveClickTarget(level, graph, { x: cx, y: yard.floor + 50, z: cz }), null, 'sky');
  assert.equal(resolveClickTarget(level, graph, null), null);

  // The point of the slime pools farthest from any walkable node.
  let best = null;
  for (const s of level.sectors.filter((q) => q.tags.has('slime') && !q.tags.has('sky'))) {
    const xs = s.poly.map((p) => p[0]), zs = s.poly.map((p) => p[1]);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.25) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) {
      if (sectorAt(level, x, z) !== s) continue;
      const d = Math.min(...graph.nodes.map((n) => Math.hypot(n.x - x, n.z - z)));
      if (!best || d > best.d) best = { x, z, d, y: s.floor };
    }
  }
  assert.ok(best.d > 3, `slime pool point only ${best.d} m from the walkway`);
  assert.equal(resolveClickTarget(level, graph, { x: best.x, y: best.y, z: best.z }), null, 'slime');

  const plat = sectorAt(level, level.start.x, level.start.z);
  const r = resolveClickTarget(level, graph, { x: level.start.x + 0.3, y: plat.floor, z: level.start.z + 0.2 });
  assert.ok(r && Number.isFinite(r.x) && Number.isFinite(r.z));
  assert.ok(Math.hypot(r.x - level.start.x, r.z - level.start.z) <= 3);
  assert.ok(graph.nodes.some((n) => n.x === r.x && n.z === r.z), 'returns a node position');
});

test('a click sends the walker there, then it resumes touring', () => {
  const w = makeWalker(4);
  for (let i = 0; i < 60 * 20; i++) w.step(DT, NONE);
  const target = resolveClickTarget(level, graph, { x: 54, y: 0, z: 96 }) ?? (() => { throw new Error('no node at test spot'); })();
  w.step(DT, { ...NONE, click: { x: target.x, y: 0, z: target.z } });
  let t = 0, arrived = false;
  while (t < 300) {
    const p = w.step(DT, NONE); t += DT;
    if (Math.hypot(p.x - target.x, p.z - target.z) < 0.6 && w.speed < 0.05) { arrived = true; break; }
  }
  assert.ok(arrived, 'reached the clicked spot');
  const at = copy(w.step(DT, NONE));
  let moved = 0;
  for (let i = 0; i < 60 * 40; i++) { const q = w.step(DT, NONE); moved = Math.max(moved, Math.hypot(q.x - at.x, q.z - at.z)); }
  assert.ok(moved > 2, 'resumes touring from there');
});

test('it rides the lift up to the exit room at a gentle pace', () => {
  const w = makeWalker(5);
  const exit = level.pois.find((p) => p.id === 'exit-view');
  w.goTo(exit.x, exit.z);
  let rode = false, maxVy = 0, prev = copy(w.step(DT, NONE)), checked = false;
  for (let i = 0; i < 60 * 600 && !(w.state === 'pausing' && rode); i++) {
    const p = w.step(DT, NONE);
    if (w.state === 'riding') rode = true;
    // Halfway up, it looks out over the room below, not at the riser of the landing ahead.
    if (w.state === 'riding' && w.piece.kind === 'ride' && !checked && w.ride.t > w.ride.dur * 0.45) {
      checked = true;
      const o = w.piece.open, want = Math.atan2(-(o.x - p.x), -(o.z - p.z));
      assert.ok(Math.abs(wrap(p.yaw - want)) < 45 * DEG, `mid-ride yaw ${(wrap(p.yaw - want) / DEG).toFixed(0)} deg off the open side`);
    }
    maxVy = Math.max(maxVy, Math.abs(p.y - prev.y) / DT);
    prev = copy(p);
  }
  assert.ok(rode && checked, 'rode the lift');
  const room = level.sectors.find((s) => s.id === 'exit-room');
  assert.ok(Math.abs(prev.y - (room.floor + 1.7)) < 0.1, `eye at ${prev.y} in the exit room`);
  assert.ok(maxVy < 1.0, `vertical speed ${maxVy} m/s`);
});

test('a closed door makes it stop short and wait, then walk through once open', () => {
  let open = false;
  const w = makeWalker(6, { doors: { isOpen: () => open } });
  const comp = level.pois.find((p) => p.id === 'comp-consoles');
  w.goTo(comp.x, comp.z);
  for (let i = 0; i < 60 * 120; i++) w.step(DT, NONE);
  const p = w.step(DT, NONE);
  const s = sectorAt(level, p.x, p.z);
  assert.ok(!s.tags.has('door') && s.id !== 'comp-main', `walked to ${s.id} through a closed door`);
  assert.ok(w.speed < 0.05, 'waiting at the door');
  open = true;
  let got = false;
  for (let i = 0; i < 60 * 120 && !got; i++) { const q = w.step(DT, NONE); got = sectorAt(level, q.x, q.z)?.id === 'comp-main'; }
  assert.ok(got, 'went through once the door opened');
});

// A doors stub like the real Doors: a door opens only when the walker announces it (onApproach) from within
// 3 m, takes 1.2 s to open, and closes (at once impassable) 4 s after the last announcement.
function doorStub(getWalker) {
  const doors = new Map(level.doors.map((d) => [d.sector, { open: 0, last: -Infinity, opening: null }]));
  const sectors = new Map(level.doors.map((d) => [d.sector, level.byId.get(d.sector)]));
  const distTo = (id, x, z) => {
    const poly = sectors.get(id).poly;
    if (sectorAt(level, x, z)?.id === id) return 0;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    return best;
  };
  let time = 0;
  const stub = {
    calls: 0, farCalls: 0,
    isOpen: (id) => !doors.has(id) || doors.get(id).open >= 1,
    onApproach(id) {
      const d = doors.get(id), w = getWalker();
      if (!d) return;
      stub.calls++;
      if (distTo(id, w.x, w.z) > 3 + 1e-6) { stub.farCalls++; return; }
      d.last = time;
    },
    tick(dt) {
      time += dt;
      for (const d of doors.values()) {
        const want = time - d.last < 4;
        d.open = want ? Math.min(1, d.open + dt / 1.2) : 0;
      }
    },
    distTo,
  };
  return stub;
}

test('doors that open only on approach: never walks through a closed door in 30 minutes, and keeps touring', () => {
  let w = null;
  const doors = doorStub(() => w);
  w = makeWalker(7, { doors });
  const reached = new Set();
  const passed = new Map(); // door sector -> times walked through
  let inDoor = null;
  for (let i = 0; i < 30 * 60 * 60; i++) {
    doors.tick(DT);
    const p = w.step(DT, NONE);
    const s = sectorAt(level, w.x, w.z);
    if (s?.tags.has('door')) {
      assert.ok(doors.isOpen(s.id), `inside closed door ${s.id} at step ${i} (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
      inDoor = s.id;
    } else if (inDoor) { passed.set(inDoor, (passed.get(inDoor) ?? 0) + 1); inDoor = null; }
    if (w.state === 'pausing' && w.target) reached.add(w.target.id);
  }
  const through = [...passed.values()].reduce((a, b) => a + b, 0);
  assert.equal(doors.farCalls, 0, `announced a door from more than 3 m away (${doors.farCalls} of ${doors.calls} calls)`);
  assert.ok(through >= 6, `walked through doors only ${through} times (${JSON.stringify([...passed])})`);
  assert.ok(reached.size >= 6, `reached only ${reached.size} pois`);
});
