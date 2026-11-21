import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyMeter, focalFromFov, SHOULDER_SPAN_DEFAULT } from '../html/js/headpose.js';

const W = 1280, H = 720, F = focalFromFov(W, 62);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (within ${eps})`);
const SHOULDERS = 0.41; // this viewer's, wider than the default

/**
 * The pose landmarks a pinhole camera would see of a viewer whose mid-eye point is at `p` (camera frame).
 * `hide` lists landmark numbers the model cannot see; `skew` moves the model's eyes off the true eye point
 * (in metres), as the pose model's idea of the eyes differs from the face tracker's.
 */
function fakePose(p, { hide = [], skew = { x: 0, y: 0 }, shoulders = SHOULDERS } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  const put = (i, dx, dy, dz = 0) => {
    const q = [p.x + dx, p.y + dy, p.z + dz];
    lm[i] = { x: (W / 2 + F * q[0] / q[2]) / W, y: (H / 2 + F * q[1] / q[2]) / H, z: dz * (F / p.z) / W, visibility: hide.includes(i) ? 0.1 : 0.95 };
  };
  put(0, skew.x, 0.035 + skew.y, -0.03);                             // nose tip
  put(2, -0.032 + skew.x, skew.y); put(5, 0.032 + skew.x, skew.y);    // eyes
  put(7, -0.075, 0.01, 0.09); put(8, 0.075, 0.01, 0.09);              // ears
  put(11, -shoulders / 2, 0.24, 0.08); put(12, shoulders / 2, 0.24, 0.08);
  return lm;
}

/** A backup that has watched the face tracker follow this viewer for a few seconds. */
function taught(skew) {
  const b = new BodyMeter();
  for (let i = 0; i < 40; i++) {
    const p = { x: 0.05 * Math.sin(i), y: 0, z: 0.6 + 0.03 * Math.cos(i) };
    b.learn(fakePose(p, { skew }), W, H, F, p);
  }
  return b;
}

test('the backup learns the viewer\'s shoulders from the face tracker, then finds the head without it', () => {
  const b = taught();
  // The shoulders are behind the eyes and below the lens's axis, so the effective span it learns is under the real one.
  assert.ok(b.shoulders > 0.3 && b.shoulders < SHOULDERS, `learned ${b.shoulders}`);
  assert.notEqual(b.shoulders, SHOULDER_SPAN_DEFAULT);
  for (const p of [{ x: 0, y: 0, z: 0.6 }, { x: 0.3, y: 0.02, z: 0.55 }, { x: -0.25, y: -0.05, z: 0.8 }]) {
    const h = b.measure(fakePose(p), W, H, F);
    // It is the backup: a few centimetres off, well away from where it was taught, is what it is good for.
    near(h.x, p.x, 0.03); near(h.y, p.y, 0.03); near(h.z, p.z, 0.05);
  }
});

test('handing over from the face tracker does not jump, even where the two disagree about the eyes', () => {
  const skew = { x: 0.012, y: -0.02 };
  const b = taught(skew);
  const p = { x: 0.05, y: 0, z: 0.6 };
  const h = b.measure(fakePose(p, { skew }), W, H, F);
  near(h.x, p.x, 0.004); near(h.y, p.y, 0.004); near(h.z, p.z, 0.02);
});

test('with the shoulders out of the picture the last distance is held and the head still followed', () => {
  const b = taught();
  const from = { x: 0.1, y: 0, z: 0.6 };
  b.learn(fakePose(from), W, H, F, from); // the face tracker's last word
  for (const x of [0.2, 0.3, 0.38]) {
    const p = { x, y: 0, z: 0.6 };
    const h = b.measure(fakePose(p, { hide: [11, 12] }), W, H, F);
    near(h.x, x, 0.02);
    near(h.z, from.z, 0.01); // as far from the screen as when last measured
  }
});

test('in profile, with the eyes hidden, the head is still found', () => {
  const b = taught();
  const p = { x: -0.2, y: 0, z: 0.6 };
  const viaEars = b.measure(fakePose(p, { hide: [2, 5] }), W, H, F);
  near(viaEars.x, p.x, 0.04); near(viaEars.z, p.z, 0.06);
  const noseOnly = b.measure(fakePose(p, { hide: [2, 5, 7, 8] }), W, H, F);
  near(noseOnly.x, p.x, 0.03);
});

test('a backup that was never taught still works from typical proportions; nothing to see gives null', () => {
  const b = new BodyMeter();
  const h = b.measure(fakePose({ x: 0.1, y: 0, z: 0.6 }, { shoulders: 0.37 }), W, H, F); // a typical adult
  near(h.x, 0.1, 0.02); near(h.z, 0.6, 0.06);
  const blind = new BodyMeter();
  assert.equal(blind.measure(fakePose({ x: 0, y: 0, z: 0.6 }, { hide: [0, 2, 5, 7, 8] }), W, H, F), null); // no head
  assert.equal(blind.measure(fakePose({ x: 0, y: 0, z: 0.6 }, { hide: [11, 12] }), W, H, F), null);         // no ruler, no memory
  assert.equal(blind.measure(null, W, H, F), null);
  assert.equal(blind.measure([], W, H, F), null);
});
