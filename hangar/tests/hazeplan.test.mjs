import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { planHaze, tallness, HAZE } from '../html/js/hazeplan.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const map = planHaze(level);
const at = (x, z) => {
  const i = Math.floor((x - map.minX) / HAZE.cell), j = Math.floor((z - map.minZ) / HAZE.cell);
  return [map.data[(j * map.w + i) * 2], map.data[(j * map.w + i) * 2 + 1]];
};
const centre = (id) => {
  const s = level.byId.get(id);
  const n = s.poly.length;
  return [s.poly.reduce((a, p) => a + p[0], 0) / n, s.poly.reduce((a, p) => a + p[1], 0) / n];
};

test('tallness: none under a 4 m ceiling, full from 7 m, none outside (vacuum)', () => {
  const mk = (floor, ceil, tags = []) => ({ floor, ceil, tags: new Set(tags) });
  assert.equal(tallness(mk(0, 2.4)), 0);
  assert.equal(tallness(mk(0, 4)), 0);
  assert.ok(tallness(mk(0, 5.5)) > 0 && tallness(mk(0, 5.5)) < 1);
  assert.equal(tallness(mk(0, 10)), 1);
  assert.equal(tallness(mk(0, 12, ['sky', 'courtyard'])), 0);
  assert.equal(tallness(null), 0);
});

test('planHaze: corridors are clear, the zigzag hall and the computer room hold haze', () => {
  // Each corridor sector's cells (centres inside it, away from its edges' filtering) hold no haze.
  // One pass over the cells (every 2nd row and column keeps it cheap while the suite runs in parallel).
  let checked = 0;
  for (let j = 0; j < map.h; j += 2) for (let i = 0; i < map.w; i += 2) {
    const x = map.minX + (i + 0.5) * HAZE.cell, z = map.minZ + (j + 0.5) * HAZE.cell;
    const s = sectorAt(level, x, z);
    if (!s?.tags.has('corridor')) continue;
    assert.equal(at(x, z)[0], 0, `${s.id} at ${x},${z}`);
    checked++;
  }
  assert.ok(checked > 50, `only ${checked} corridor cells checked`);
  for (const id of ['zz-landing', 'comp-main']) {
    const [x, z] = centre(id);
    assert.equal(sectorAt(level, x, z)?.id, id);
    assert.ok(at(x, z)[0] > 0.9, `${id}: ${at(x, z)[0]}`);
    assert.ok(Math.abs(at(x, z)[1] - level.byId.get(id).floor) < 1e-6);
  }
});

test('planHaze: covers the level with a margin of clear air', () => {
  assert.ok(map.w > 100 && map.h > 100 && map.w * map.h * 2 === map.data.length);
  for (let i = 0; i < map.w; i++) assert.equal(map.data[i * 2], 0); // first row: margin
  for (const v of map.data) assert.ok(Number.isFinite(v));
});
