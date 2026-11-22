import test from 'node:test';
import assert from 'node:assert/strict';
import { Play, SCENES, CURTAIN, CHANGE, INTERVAL } from '../html/js/stageplay.js';

function run(play, seconds, dt = 1 / 30) {
  const log = [];
  for (let t = 0; t < seconds; t += dt) for (const e of play.step(dt)) log.push({ at: t, phase: play.phase, ...e });
  return log;
}
const total = SCENES.reduce((s, c) => s + c.seconds, 0) + CURTAIN * 2 + CHANGE * (SCENES.length - 1) + INTERVAL;

test('the curtain rises before scene one, and the scene plays every cue once, in order', () => {
  const p = new Play(0);
  assert.equal(p.phase, 'opening');
  assert.equal(p.curtain, 0);
  const log = run(p, CURTAIN + SCENES[0].seconds + 0.5);
  assert.equal(log[0].type, 'scene');
  assert.ok(Math.abs(log[0].at - CURTAIN) < 0.1);
  assert.deepEqual(log.filter((e) => e.type === 'cue').map((e) => e.what), SCENES[0].cues.map((c) => c[1]));
  assert.equal(p.phase, 'change');
  assert.equal(p.curtain, 1);
});

test('scenery is set in the dark, halfway through a change', () => {
  const p = new Play(1);
  const log = run(p, SCENES[1].seconds + CHANGE + 0.5);
  const set = log.find((e) => e.type === 'set');
  assert.equal(set.index, 2);
  assert.ok(Math.abs(set.at - (SCENES[1].seconds + CHANGE / 2)) < 0.1);
  const q = new Play(1); q.go('change'); q.t = CHANGE / 2;
  assert.ok(q.lights < 0.01, 'the lights are out at that moment');
  assert.equal(p.index, 2);
});

test('a whole performance: five scenes, the curtain, the interval, and round again', () => {
  const p = new Play(0);
  const log = run(p, total + CURTAIN + 2);
  assert.deepEqual(log.filter((e) => e.type === 'scene').map((e) => e.index), [0, 1, 2, 3, 4, 0]);
  assert.deepEqual(log.filter((e) => e.type === 'set').map((e) => e.index), [1, 2, 3, 4, 0]);
  const reset = log.filter((e) => e.type === 'set').at(-1);
  assert.equal(reset.phase, 'interval');
});

test('the curtain is down for the whole interval and the lights with it', () => {
  const p = new Play(4);
  run(p, SCENES[4].seconds + CURTAIN + 0.2);
  assert.equal(p.phase, 'interval');
  assert.equal(p.curtain, 0);
  assert.equal(p.lights, 0);
});

test('skip cuts a scene short and does nothing otherwise', () => {
  const p = new Play(2);
  run(p, 5);
  p.skip();
  assert.equal(p.phase, 'change');
  p.skip();
  assert.equal(p.phase, 'change');
  const last = new Play(4); last.skip();
  assert.equal(last.phase, 'closing');
});

test('every scene has a title, a caption and cues in order inside it', () => {
  for (const s of SCENES) {
    assert.ok(s.title && s.caption.length > 10 && s.seconds > 30);
    let last = 0;
    for (const [at] of s.cues) { assert.ok(at > last && at < 1, `${s.key} cue at ${at}`); last = at; }
  }
});
