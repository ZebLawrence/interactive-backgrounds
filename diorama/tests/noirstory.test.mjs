import test from 'node:test';
import assert from 'node:assert/strict';
import { Story, CHAPTERS, NIGHT, LAPSE, SWAP, daylight } from '../html/js/noirstory.js';

/** Runs a story for `seconds` at 60 steps a second; returns every event with the time it happened. */
function run(story, seconds, dt = 1 / 60) {
  const log = [];
  for (let t = 0; t < seconds; t += dt) for (const e of story.step(dt)) log.push({ at: t, ...e });
  return log;
}

test('a night announces itself, plays every beat once and in order, then ends', () => {
  const s = new Story(0);
  const log = run(s, NIGHT + 1);
  assert.equal(log[0].type, 'night');
  const beats = log.filter((e) => e.type === 'beat');
  assert.deepEqual(beats.map((b) => b.what), CHAPTERS[0].beats.map((b) => b[1]));
  for (let i = 0; i < beats.length; i++) assert.ok(Math.abs(beats[i].at - CHAPTERS[0].beats[i][0]) < 0.05, `beat ${i} at ${beats[i].at}`);
  assert.equal(log.at(-1).type, 'lapse');
  assert.equal(s.phase, 'lapse');
});

test('the room is rearranged once, in the dark, and the next night follows', () => {
  const s = new Story(0);
  const log = run(s, NIGHT + LAPSE + 1);
  const swaps = log.filter((e) => e.type === 'chapter');
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].index, 1);
  assert.ok(Math.abs(swaps[0].at - (NIGHT + LAPSE * SWAP)) < 0.05);
  const d = daylight(SWAP);
  assert.ok(d.night < 0.01 && d.sun < 0.01, 'nothing is lit at the moment of the swap');
  assert.equal(log.filter((e) => e.type === 'night').length, 2);
  assert.equal(s.index, 1);
});

test('four nights come round to Monday again', () => {
  const s = new Story(0);
  const log = run(s, (NIGHT + LAPSE) * CHAPTERS.length + 1, 1 / 30);
  assert.deepEqual(log.filter((e) => e.type === 'night').map((e) => e.index), [0, 1, 2, 3, 0]);
});

test('skip ends the night at once and does nothing during the day', () => {
  const s = new Story(2);
  run(s, 10);
  assert.deepEqual(s.skip(), [{ type: 'lapse' }]);
  assert.deepEqual(s.skip(), []);
  const log = run(s, LAPSE + 0.5);
  assert.equal(log.find((e) => e.type === 'chapter').index, 3);
  assert.equal(log.at(-1).type, 'night');
});

test('the clock runs from ten to one at night and round to ten again by day', () => {
  const s = new Story(0);
  assert.equal(s.clock, 22);
  run(s, NIGHT - 0.01);
  assert.ok(Math.abs(s.clock - 25) < 0.01);
  run(s, LAPSE - 0.05);
  assert.ok(Math.abs(s.clock - 46) < 0.1, `clock ${s.clock}`);
});

test('daylight: night at both ends, sun in the middle, and the sun crosses from one side to the other', () => {
  assert.deepEqual(daylight(0), { night: 1, sun: 0, arc: -1 });
  assert.equal(daylight(1).night, 1);
  assert.equal(daylight(1).sun, 0);
  assert.ok(daylight(0.5).sun > 0.99 && daylight(0.5).night === 0);
  assert.ok(daylight(0.3).arc < daylight(0.7).arc);
  for (let u = 0; u <= 1; u += 0.01) { const d = daylight(u); assert.ok(d.night >= 0 && d.night <= 1 && d.sun >= 0 && d.sun <= 1); }
});

test('every chapter has a caption and beats in time order within the night', () => {
  for (const c of CHAPTERS) {
    assert.ok(c.caption.length > 10);
    let last = 0;
    for (const [at] of c.beats) { assert.ok(at > last && at < NIGHT - 10, `${c.key} beat at ${at}`); last = at; }
  }
});
