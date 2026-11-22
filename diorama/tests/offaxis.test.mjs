import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFrustum, projectToNdc, MIN_EYE_Z } from '../html/js/offaxis.js';

const HW = 0.30, HH = 0.17; // a 27-inch display's half size, metres
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const EYES = [{ x: 0, y: 0, z: 0.6 }, { x: 0.25, y: 0.1, z: 0.5 }, { x: -0.4, y: -0.2, z: 0.9 }, { x: 0.5, y: 0.3, z: 0.2 }];

test('a centred eye gets a symmetric frustum', () => {
  const f = windowFrustum({ x: 0, y: 0, z: 0.6 }, HW, HH, 0.01);
  near(f.left, -f.right); near(f.bottom, -f.top);
  near(f.right, HW * 0.01 / 0.6);
});

test('the four corners of the window land on the four corners of the screen, wherever the eye is', () => {
  for (const eye of EYES) {
    const f = windowFrustum(eye, HW, HH, 0.01);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = projectToNdc({ x: sx * HW, y: sy * HH, z: 0 }, eye, f);
      near(p.x, sx, 1e-9); near(p.y, sy, 1e-9);
    }
  }
});

test('a point in the plane of the glass does not move on screen as the head moves', () => {
  const pt = { x: 0.1, y: -0.05, z: 0 };
  for (const eye of EYES) {
    const p = projectToNdc(pt, eye, windowFrustum(eye, HW, HH, 0.01));
    near(p.x, pt.x / HW, 1e-9); near(p.y, pt.y / HH, 1e-9);
  }
});

test('moving the head right slides the back of the box right on screen and shows more of the left wall', () => {
  const back = { x: 0, y: 0, z: -0.5 };
  const at = (x) => { const e = { x, y: 0, z: 0.6 }; return projectToNdc(back, e, windowFrustum(e, HW, HH, 0.01)); };
  assert.ok(at(0.2).x > at(0).x, 'things behind the glass follow the head');
  near(at(0).x, 0);
  // The left wall's far edge (x = -HW at the back) is further from the left screen edge when the head is right.
  const leftEdge = (x) => { const e = { x, y: 0, z: 0.6 }; return projectToNdc({ x: -HW, y: 0, z: -0.5 }, e, windowFrustum(e, HW, HH, 0.01)).x; };
  assert.ok(leftEdge(0.2) > leftEdge(0) && leftEdge(0) > leftEdge(-0.2));
  // ... and with the head far enough right, the right wall is edge-on or hidden: its far edge is at or past the screen edge.
  const rightEdge = (x) => { const e = { x, y: 0, z: 0.6 }; return projectToNdc({ x: HW, y: 0, z: -0.5 }, e, windowFrustum(e, HW, HH, 0.01)).x; };
  assert.ok(rightEdge(HW) >= 1 - 1e-9);
});

test('a point in front of the glass moves against the head', () => {
  const tip = { x: 0, y: 0, z: 0.07 };
  const at = (x) => { const e = { x, y: 0, z: 0.6 }; return projectToNdc(tip, e, windowFrustum(e, HW, HH, 0.01)); };
  assert.ok(at(0.2).x < 0);
});

test('an eye at or behind the glass is held off it and never gives NaN', () => {
  for (const z of [0, -1, MIN_EYE_Z / 2]) {
    const f = windowFrustum({ x: 0.1, y: 0, z }, HW, HH, 0.01);
    for (const v of Object.values(f)) assert.ok(Number.isFinite(v));
    assert.ok(f.right > f.left && f.top > f.bottom);
  }
});
