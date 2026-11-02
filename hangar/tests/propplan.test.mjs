import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { doorFrames, planSwitches, planConsoles, JAMB, LINTEL, CONSOLE_DEPTH } from '../html/js/propplan.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));

test('every door gets a frame that leaves at least 2 m x 2.4 m clear and opens onto a room each side', () => {
  const frames = doorFrames(level);
  assert.equal(frames.length, level.doors.length);
  for (const f of frames) {
    assert.ok(f.height - LINTEL >= 2.0, `${f.sector}: ${(f.height - LINTEL).toFixed(2)} m headroom under the lintel`);
    assert.ok(f.width - 2 * JAMB >= 2.4, `${f.sector}: ${(f.width - 2 * JAMB).toFixed(2)} m between the jambs`);
    assert.equal(sectorAt(level, f.c[0], f.c[1])?.id, f.sector);
    for (const s of f.sides) assert.ok(s.room, `${f.sector}: nothing on side ${s.s}`);
    assert.ok([f.c, f.u, f.n].flat().every(Number.isFinite));
  }
});

test('switches sit on a wall of the room they switch, facing into it', () => {
  const sw = planSwitches(level);
  assert.ok(sw.length >= 3, `only ${sw.length} switches`);
  assert.ok(sw.some((s) => s.room === 'comp-main'), 'the computer room has a switch');
  for (const s of sw) {
    assert.equal(sectorAt(level, s.x + s.nx * 0.05, s.z + s.nz * 0.05)?.id, s.room, `${s.id} faces its room`);
    assert.notEqual(sectorAt(level, s.x - s.nx * 0.05, s.z - s.nz * 0.05)?.id, s.room, `${s.id} is on a wall`);
  }
});

test('consoles stand in the computer rooms, shallower than the walker keeps from walls', () => {
  const sw = planConsoles(level, planSwitches(level));
  assert.ok(sw.length >= 8, `only ${sw.length} consoles`);
  assert.ok(CONSOLE_DEPTH < 0.35 - 0.05);
  for (const c of sw) {
    assert.ok(level.byId.get(c.sector).tags.has('computer'));
    assert.equal(sectorAt(level, c.x + c.nx * 0.12, c.z + c.nz * 0.12)?.id, c.sector);
  }
  for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) assert.ok(Math.hypot(sw[i].x - sw[j].x, sw[i].z - sw[j].z) > 0.9, 'consoles overlap');
});
