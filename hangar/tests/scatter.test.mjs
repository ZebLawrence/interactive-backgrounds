import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { buildNavGraph } from '../html/js/navgraph.js';
import { makeRng } from '../html/js/rng.js';
import { makeTour } from '../html/js/tour.js';
import { Walker } from '../html/js/walker.js';
import { doorFrames, planSwitches, planConsoles } from '../html/js/propplan.js';
import {
  scatterProps, CATALOGUE, usedEdges, footprint, rectGap, segRectDistance, pointRectDistance, wallDistance,
  propObstacles, blockNav, planPipes, planDecals, NAV_CLEAR, WALL_GAP,
} from '../html/js/scatter.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const graph = buildNavGraph(level);
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const runs = new Map(SEEDS.map((s) => [s, scatterProps(level, graph, makeRng(s).fork('props'), CATALOGUE)]));
const NO_PROPS = ['slime', 'walkway', 'door', 'lift', 'window', 'corridor'];

test('the geometry helpers measure rectangles and segments right', () => {
  const r = footprint({ x: 0, z: 0, yaw: 0, w: 2, d: 1 });
  assert.ok(Math.abs(pointRectDistance(r, 2, 0) - 1) < 1e-9);
  assert.ok(Math.abs(pointRectDistance(r, 0, 0) + 0.5) < 1e-9, 'negative inside');
  assert.ok(Math.abs(segRectDistance(r, [-5, 1.5], [5, 1.5]) - 1) < 1e-9);
  assert.equal(segRectDistance(r, [-5, 0], [5, 0]), 0, 'a segment through it');
  const q = footprint({ x: 0, z: 0, yaw: Math.PI / 2, w: 2, d: 1 }); // turned: 1 along x, 2 along z
  assert.ok(Math.abs(pointRectDistance(q, 1.5, 0) - 1) < 1e-9);
  assert.ok(Math.abs(rectGap(footprint({ x: 0, z: 0, yaw: 0, w: 1, d: 1 }), footprint({ x: 1.5, z: 0, yaw: 0, w: 1, d: 1 })) - 0.5) < 1e-9);
  assert.ok(rectGap(footprint({ x: 0, z: 0, yaw: 0, w: 1, d: 1 }), footprint({ x: 0.5, z: 0.2, yaw: 0.3, w: 1, d: 1 })) < 0);
});

test('seeds 1-20 place a good number of props, all the rules used', () => {
  for (const [seed, ps] of runs) {
    assert.ok(ps.length >= 40, `seed ${seed}: only ${ps.length} props`);
    const rules = new Set(ps.map((p) => p.rule));
    for (const r of ['wall', 'corner', 'cluster', 'free']) assert.ok(rules.has(r), `seed ${seed}: no ${r} props`);
    for (const p of ps) assert.ok(['x', 'y', 'z', 'yaw', 'scale'].every((k) => Number.isFinite(p[k])), JSON.stringify(p));
  }
});

test('no two footprints overlap', () => {
  for (const [seed, ps] of runs) {
    const fs = ps.map(footprint);
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
      assert.ok(rectGap(fs[i], fs[j]) >= -1e-6, `seed ${seed}: ${ps[i].name} and ${ps[j].name} overlap by ${(-rectGap(fs[i], fs[j])).toFixed(3)} m`);
    }
  }
});

test('every prop stands on its sector floor (mounted ones at their height), never in slime, on the walkway, in a door, corridor or the lift', () => {
  for (const [seed, ps] of runs) {
    for (const p of ps) {
      const s = level.byId.get(p.sector);
      assert.equal(sectorAt(level, p.x, p.z)?.id, s.id, `seed ${seed}: ${p.name} not in its sector`);
      assert.equal(p.floor, s.floor);
      assert.ok(Math.abs(p.y - (s.floor + (p.mount ?? 0))) < 1e-9, `seed ${seed}: ${p.name} at y ${p.y} on floor ${s.floor}`);
      assert.ok(!NO_PROPS.some((t) => s.tags.has(t)), `seed ${seed}: ${p.name} in ${s.id}`);
      // The whole footprint is on that floor.
      const f = footprint(p);
      for (const [cx, cz] of f.corners) assert.equal(sectorAt(level, cx, cz)?.id, s.id, `seed ${seed}: ${p.name} hangs over the edge of ${s.id}`);
    }
  }
});

test('wall items back onto a solid wall within 0.05 m, facing out; corner items onto two', () => {
  for (const [seed, ps] of runs) {
    for (const p of ps) {
      if (p.rule !== 'wall' && p.rule !== 'corner') continue;
      const f = footprint(p);
      // The back edge's two ends (local -z) are both within WALL_GAP of a solid wall of the sector.
      for (const k of [0, 1]) {
        const [bx, bz] = f.back[k];
        assert.ok(wallDistance(level, p.sector, bx, bz) <= WALL_GAP + 1e-9, `seed ${seed}: ${p.name} (${p.rule}) back corner ${wallDistance(level, p.sector, bx, bz).toFixed(3)} m off the wall`);
      }
      // Facing out: a step forward from the front centre is farther from the wall.
      const [fx, fz] = [p.x + Math.sin(p.yaw) * (f.hd + 0.2), p.z + Math.cos(p.yaw) * (f.hd + 0.2)];
      const [bx, bz] = f.at(0, -f.hd);
      assert.ok(wallDistance(level, p.sector, fx, fz) > wallDistance(level, p.sector, bx, bz) + 0.1, `seed ${seed}: ${p.name} faces the wall`);
      if (p.rule === 'corner') {
        const [sx, sz] = f.side;
        assert.ok(wallDistance(level, p.sector, sx, sz) <= WALL_GAP + 1e-9, `seed ${seed}: corner ${p.name} side ${wallDistance(level, p.sector, sx, sz).toFixed(3)} m off the second wall`);
      }
    }
  }
});

test('clusters are groups of 2 to 5 that touch', () => {
  for (const [seed, ps] of runs) {
    const groups = new Map();
    for (const p of ps) if (p.rule === 'cluster') (groups.get(p.group) ?? groups.set(p.group, []).get(p.group)).push(p);
    assert.ok(groups.size >= 2, `seed ${seed}: ${groups.size} clusters`);
    for (const [g, list] of groups) {
      assert.ok(list.length >= 2 && list.length <= 5, `seed ${seed}: cluster ${g} has ${list.length}`);
      for (const p of list) {
        const near = Math.min(...list.filter((q) => q !== p).map((q) => rectGap(footprint(p), footprint(q))));
        assert.ok(near <= 0.03, `seed ${seed}: ${p.name} in cluster ${g} is ${near.toFixed(3)} m from the rest`);
      }
    }
  }
});

test('no placement within 0.6 m of a nav edge the walker uses', () => {
  const used = usedEdges(level, graph);
  assert.ok(used.length > 100, `${used.length} used edges`);
  for (const [seed, ps] of runs) {
    for (const p of ps) {
      const f = footprint(p);
      let d = Infinity;
      for (const [a, b] of used) d = Math.min(d, segRectDistance(f, a, b));
      assert.ok(d >= NAV_CLEAR - 1e-9, `seed ${seed}: ${p.name} in ${p.sector} ${d.toFixed(3)} m from a used edge`);
    }
  }
});

test('props keep off the door frames, switches and consoles', () => {
  const frames = doorFrames(level);
  const switches = planSwitches(level, frames);
  const consoles = planConsoles(level, switches);
  for (const [seed, ps] of runs) {
    for (const p of ps) {
      const f = footprint(p);
      for (const fr of frames) assert.ok(pointRectDistance(f, fr.c[0], fr.c[1]) >= fr.width / 2 + 0.4, `seed ${seed}: ${p.name} at door ${fr.sector}`);
      for (const s of switches) assert.ok(pointRectDistance(f, s.x, s.z) >= 0.4, `seed ${seed}: ${p.name} at ${s.id}`);
      for (const c of consoles) {
        const cf = footprint({ x: c.x + c.nx * 0.12, z: c.z + c.nz * 0.12, yaw: c.yaw, w: 1.0, d: 0.24 });
        assert.ok(rectGap(f, cf) >= 0.3, `seed ${seed}: ${p.name} against ${c.id}`);
      }
    }
  }
});

test('the same seed gives the same props; seeds 1 and 2 differ', () => {
  const again = scatterProps(level, graph, makeRng(1).fork('props'), CATALOGUE);
  assert.deepEqual(again, runs.get(1));
  assert.notDeepEqual(runs.get(1), runs.get(2));
});

test('the walker never brushes a prop: 20 simulated minutes, three seeds, camera >= 0.35 m from every footprint', () => {
  const report = [];
  for (const seed of [1, 2, 3]) {
    const ps = runs.get(seed);
    const obstacles = propObstacles(ps);
    const g = blockNav(graph, obstacles);
    const rng = makeRng(seed);
    const w = new Walker(level, g, makeTour(level.pois, rng.fork('tour')), rng.fork('walker'), { obstacles });
    let min = Infinity, at = null;
    const reached = new Set();
    for (let i = 0; i < 20 * 60 * 60; i++) {
      const p = w.step(1 / 60, null);
      const d = obstacles.distance(p.x, p.z);
      if (d < min) { min = d; at = [p.x.toFixed(2), p.z.toFixed(2)]; }
      if (w.state === 'pausing' && w.target) reached.add(w.target.id);
    }
    report.push(`seed ${seed}: ${min.toFixed(2)} m at ${at}, ${reached.size} pois`);
    assert.ok(min >= 0.35, `seed ${seed}: camera ${min.toFixed(3)} m from a prop at (${at})`);
    assert.ok(reached.size >= 6, `seed ${seed}: reached only ${reached.size} pois`);
  }
  console.log(`  closest camera pass: ${report.join('; ')}`);
});

test('pipes run along walls above head height, with brackets, clear of doors', () => {
  for (const seed of [1, 2, 3]) {
    const pipes = planPipes(level, makeRng(seed).fork('pipes'));
    assert.ok(pipes.length >= 8, `seed ${seed}: ${pipes.length} pipe runs`);
    const frames = doorFrames(level);
    for (const r of pipes) {
      const s = level.byId.get(r.sector);
      assert.ok(r.y - r.r >= s.floor + 2.05, `${r.sector}: pipe underside ${(r.y - r.r - s.floor).toFixed(2)} m above the floor`);
      assert.ok(r.y + r.r <= s.ceil - 0.02, `${r.sector}: pipe through the ceiling`);
      assert.ok(r.brackets.length >= 2, 'brackets');
      for (const [x, z] of [r.a, r.b]) {
        for (const f of frames) assert.ok(Math.hypot(x - f.c[0], z - f.c[1]) >= f.width / 2 + 0.3, `${r.sector}: pipe end at door ${f.sector}`);
        assert.ok(wallDistance(level, r.sector, x, z) <= r.off + r.r + 0.01, 'pipes hug their wall');
      }
    }
    assert.ok(pipes.some((r) => level.byId.get(r.sector).tags.has('corridor')), 'corridors carry pipes');
  }
});

test('grime and leak decals sit on solid walls and floors-edges, differ by seed', () => {
  const a = planDecals(level, makeRng(1).fork('decals'));
  const b = planDecals(level, makeRng(2).fork('decals'));
  assert.ok(a.length >= 30, `${a.length} decals`);
  assert.notDeepEqual(a, b);
  for (const d of a) {
    assert.ok(['grime', 'leak', 'corner'].includes(d.kind));
    assert.ok(d.w > 0 && d.h > 0 && Number.isFinite(d.x) && Number.isFinite(d.z));
    const s = level.byId.get(d.sector);
    assert.ok(d.y0 >= s.floor - 1e-9 && d.y0 + d.h <= s.ceil + 1e-9, `${d.kind} decal outside its wall's height`);
    assert.ok(wallDistance(level, d.sector, d.x, d.z) < 0.01, `${d.kind} decal off its wall`);
  }
});
