import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadMeter, cameraToWindow, focalFromFov, windowMetrics, OneEuro, IRIS_DIAMETER, EYE_SPAN_DEFAULT } from '../html/js/headpose.js';

const W = 1280, H = 720, FOV = 62;
const F = focalFromFov(W, FOV);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (within ${eps})`);
const SPAN = 0.094; // this viewer's eye corners: wider than the default, so the meter has something to learn

/**
 * The landmarks a pinhole camera would see of a face whose mid-eye point is at `p` in the camera frame.
 * `yaw` turns the face about the vertical, measured from facing straight down the line of sight to the lens
 * (so 0 is "looking at the camera"); `flat: true` instead holds it parallel to the picture (looking straight
 * ahead at the screen, wherever the viewer stands). `lids` is the gap between the lids as a fraction of the
 * open gap; `iris` scales the iris the tracker reports (a blink collapses it).
 */
function fakeFace(p, { yaw = 0, flat = false, lids = 1, iris = 1, span = SPAN } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const range = Math.hypot(p.x, p.y, p.z), sight = [p.x / range, p.y / range, p.z / range];
  // The face's own axes in the camera frame: `right` across the eyes, `down`, both across the line of sight.
  const offAxis = Math.atan2(p.x, p.z);
  const turn = (flat ? 0 : offAxis) + yaw; // about the vertical
  const right = [Math.cos(turn), 0, -Math.sin(turn)], down = [0, 1, 0];
  const put = (i, u, v) => {
    const q = [p.x + right[0] * u + down[0] * v, p.y + right[1] * u + down[1] * v, p.z + right[2] * u + down[2] * v];
    // The mesh's z: depth along the line of sight relative to the face, in the picture's own scale.
    const depth = (q[0] - p.x) * sight[0] + (q[1] - p.y) * sight[1] + (q[2] - p.z) * sight[2];
    lm[i] = { x: (W / 2 + F * q[0] / q[2]) / W, y: (H / 2 + F * q[1] / q[2]) / H, z: depth * (F / p.z) / W };
  };
  const eyeX = 0.032, eyeW = 0.03, gap = 0.0105 * lids, r = IRIS_DIAMETER / 2 * iris;
  put(33, -span / 2, 0); put(263, span / 2, 0);
  put(133, -span / 2 + eyeW, 0); put(362, span / 2 - eyeW, 0);
  put(159, -eyeX, -gap / 2); put(145, -eyeX, gap / 2); put(386, eyeX, -gap / 2); put(374, eyeX, gap / 2);
  [[468, -eyeX], [473, eyeX]].forEach(([c, x]) => {
    put(c, x, 0); put(c + 1, x + r, 0); put(c + 2, x, -r); put(c + 3, x - r, 0); put(c + 4, x, r);
  });
  return lm;
}

/** A meter that has watched this viewer with their eyes open for a couple of seconds. */
function taught(p = { x: 0, y: 0, z: 0.6 }) {
  const m = new HeadMeter();
  for (let i = 0; i < 60; i++) m.measure(fakeFace(p), W, H, F);
  return m;
}
const relErr = (h, p) => Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z) / Math.hypot(p.x, p.y, p.z);

test('the viewer\'s own eye span is learned from their irises, and a head is then recovered where it was put', () => {
  const m = new HeadMeter();
  near(m.span, EYE_SPAN_DEFAULT, 0);
  const first = m.measure(fakeFace({ x: 0, y: 0, z: 0.6 }), W, H, F);
  near(first.z, 0.6, 0.003); // the very first frame already uses the iris
  const meter = taught();
  near(meter.span, SPAN, 0.0005);
  for (const p of [{ x: 0, y: 0, z: 0.6 }, { x: 0.1, y: -0.08, z: 0.45 }, { x: -0.15, y: 0.1, z: 1.1 }]) {
    assert.ok(relErr(meter.measure(fakeFace(p), W, H, F), p) < 0.01, JSON.stringify(p));
  }
});

test('near the side of the picture the sideways position is not short', () => {
  const meter = taught();
  // 30 degrees off the lens's axis, which is most of the way to the edge of a 62-degree picture.
  for (const p of [{ x: 0.35, y: 0, z: 0.6 }, { x: -0.35, y: 0.05, z: 0.6 }]) {
    // Looking at the camera: within 1%. Looking straight ahead at the screen, so the face is seen at an angle: 4%.
    for (const opts of [{}, { flat: true }]) {
      const h = meter.measure(fakeFace(p, opts), W, H, F, { learn: false });
      assert.ok(relErr(h, p) < (opts.flat ? 0.04 : 0.01), `${JSON.stringify(p)} ${JSON.stringify(opts)}: ${JSON.stringify(h)}`);
    }
  }
  // Measuring in pixels instead (distance = focal x span / pixels) reads a face at the edge as nearer and
  // its sideways position as shorter, which is what "it should move more near the sides" was.
  const p = { x: 0.35, y: 0, z: 0.6 }, lm = fakeFace(p);
  const px = Math.hypot((lm[263].x - lm[33].x) * W, (lm[263].y - lm[33].y) * H);
  const naiveZ = F * SPAN / px, naiveX = ((lm[33].x + lm[263].x) / 2 * W - W / 2) / F * naiveZ;
  assert.ok(naiveX < p.x * 0.9, `the pixel method gives x = ${naiveX}`);
});

test('a turned head still measures the right distance', () => {
  const meter = taught();
  for (const yaw of [-0.45, 0.3]) {
    const p = { x: 0.05, y: 0, z: 0.6 };
    assert.ok(relErr(meter.measure(fakeFace(p, { yaw }), W, H, F, { learn: false }), p) < 0.02, `yaw ${yaw}`);
  }
});

test('a blink changes nothing: not the distance, not the position, not what was learned', () => {
  const meter = taught();
  const p = { x: 0.12, y: -0.04, z: 0.6 };
  const open = meter.measure(fakeFace(p), W, H, F);
  const span = meter.span, samples = meter.samples;
  // Lids closing over three frames, the reported iris collapsing with them, then shut.
  for (const [lids, iris] of [[0.6, 0.8], [0.3, 0.5], [0.05, 0.3], [0, 0.2], [0.05, 0.3], [0.5, 0.7]]) {
    const h = meter.measure(fakeFace(p, { lids, iris }), W, H, F);
    near(h.z, open.z, 0.002); near(h.x, open.x, 0.0005); near(h.y, open.y, 0.0005);
  }
  near(meter.span, span, 0.0002);
  assert.ok(meter.samples - samples <= 1, 'the half-shut frames taught it nothing');
});

test('a webcam picture is not a mirror: a viewer who moves to their right is on the picture\'s left', () => {
  const lens = { x: 0, y: 0.18, z: 0 }; // on top of the display
  const lm = fakeFace({ x: -0.2, y: -0.05, z: 0.6 }); // in the picture: left of centre, above centre
  assert.ok(lm[33].x < 0.5 && lm[263].x < 0.5);
  const head = cameraToWindow(taught().measure(lm, W, H, F, { learn: false }), lens);
  assert.ok(head.x > 0, 'the viewer is to the right of the window centre');
  near(head.x, 0.2, 0.004);
  near(head.y, 0.18 + 0.05, 0.004); // above the lens, which is above the centre
  near(head.z, 0.6, 0.006);
});

test('sideways position hardly depends on the focal length, distance does: calibration must not scale one with the other', () => {
  const meter = taught();
  const p = { x: 0.25, y: 0, z: 0.6 }, lm = fakeFace(p);
  const wrong = meter.measure(lm, W, H, F * 0.75, { learn: false }); // the camera is wider than we think... or we think it is
  near(wrong.z / p.z, 0.75, 0.05);
  assert.ok(Math.abs(wrong.x / p.x - 1) < 0.06, `x came out ${wrong.x}`);
});

test('bad landmarks give null, never NaN', () => {
  const m = new HeadMeter();
  assert.equal(m.measure(null, W, H, F), null);
  assert.equal(m.measure([], W, H, F), null);
  assert.equal(m.measure(Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 })), W, H, F), null); // a face of no size
  assert.equal(m.measure(fakeFace({ x: 0, y: 0, z: 0.6 }), W, H, 0), null);
  near(m.span, EYE_SPAN_DEFAULT, 0);
  const noDepth = fakeFace({ x: 0, y: 0, z: 0.6 }).map(({ x, y }) => ({ x, y })); // no z on the landmarks
  assert.ok(Number.isFinite(m.measure(noDepth, W, H, F).z));
});

test('the window is measured in metres and the lens placed on top of the display', () => {
  // A 27-inch 16:9 display, 3840 x 2160 CSS pixels, with the page filling it.
  const full = windowMetrics({ diagonalInches: 27, screenW: 3840, screenH: 2160, innerW: 3840, innerH: 2160 });
  near(full.width, 0.5977, 5e-4); near(full.height, 0.3362, 5e-4);
  near(full.cam.x, 0, 1e-9); near(full.cam.y, full.height / 2 + 0.008, 1e-9);
  // A window on the left half of it, under an 80-pixel toolbar.
  const half = windowMetrics({ diagonalInches: 27, screenW: 3840, screenH: 2160, innerW: 1920, innerH: 2080, outerW: 1920, outerH: 2160, winX: 0, winY: 0 });
  near(half.width, full.width / 2, 1e-9);
  near(half.cam.x, full.width / 4, 1e-9); // the lens is to the right of this window's centre
  assert.ok(half.cam.y > full.cam.y);    // and further above it
});

test('One Euro: a still head is steadied, a moving one is followed', () => {
  // Still, with 2 mm of peak-to-peak noise at 30 Hz (ten times the tracker's): the wobble comes out at about half of it.
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const f = new OneEuro(1.0, 9);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 300; i++) { const y = f.filter(0.1 + rnd() * 0.002, 1 / 30); if (i > 60) { lo = Math.min(lo, y); hi = Math.max(hi, y); } }
  assert.ok(hi - lo < 0.0012, `wobble ${hi - lo}`);
  // Moving at 0.4 m/s: the lag settles to under 2 cm.
  const g = new OneEuro(1.0, 9);
  let lag = 0;
  for (let i = 0; i < 90; i++) { const x = 0.4 * i / 30; lag = x - g.filter(x, 1 / 30); }
  assert.ok(lag >= 0 && lag < 0.02, `lag ${lag}`);
  // And no NaN from a zero or missing dt.
  assert.ok(Number.isFinite(new OneEuro().filter(1, 0)));
});
