// Diorama — from a face in a webcam picture to an eye position in front of the screen, in metres.
// Pure maths: imports nothing, so node can test it.
//
// Frames of reference, all right-handed, all in metres:
//
//   camera frame   origin at the webcam's lens; +x to the picture's right, +y down the picture, +z out of the
//                  lens toward the viewer. This is the frame a pinhole camera measures in.
//   window frame   origin at the centre of the page's window; +x to the viewer's right as they face the screen,
//                  +y up, +z out of the screen toward the viewer. This is the world the box is built in.
//
// A webcam faces the viewer, so its picture is not a mirror: someone who steps to THEIR right moves to the
// picture's LEFT. Both x and y flip between the two frames; z does not.

/**
 * The diameter of a human iris (the horizontal visible iris diameter). It is close to 11.7 mm in every adult,
 * +/- 0.5 mm, whatever the size of the face, which makes it the best ruler a single camera has for distance.
 */
export const IRIS_DIAMETER = 0.0117;

/** Where the viewer is assumed to be until a face is seen, and where the view returns when they leave. */
export const REST_HEAD = Object.freeze({ x: 0, y: 0, z: 0.6 });

// MediaPipe Face Landmarker indices (the 478-point mesh with refined irises). Each iris is a centre and four
// points round its edge, in the order right, top, left, bottom of the picture. Each eye is its two corners and
// the middle of its upper and lower lids.
const IRISES = [[469, 470, 471, 472], [474, 475, 476, 477]];
const EYES = [{ outer: 33, inner: 133, upper: 159, lower: 145 }, { outer: 263, inner: 362, upper: 386, lower: 374 }];
const LAST_LANDMARK = 477;

/**
 * The distance between the outer corners of a typical adult's eyes, in metres, used until this viewer's own
 * has been measured against their irises (a second or so). It varies by about 5% between people.
 */
export const EYE_SPAN_DEFAULT = 0.09;
/**
 * An eye counts as open when its lids are at least this fraction of its width apart. Wide open is about 0.3,
 * a smiling face measured 0.24, shut is under 0.1.
 */
const OPEN_EYE = 0.16;

/** The focal length in pixels of a camera whose picture is `width` pixels across a `fovDeg` horizontal field. */
export function focalFromFov(width, fovDeg) {
  return (width / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
}

/** The unit ray from the lens through a landmark, in the camera frame. */
function ray(p, w, h, f) {
  const x = (p.x * w - w / 2) / f, y = (p.y * h - h / 2) / f, l = Math.hypot(x, y, 1);
  return [x / l, y / l, 1 / l];
}
/** The angle between two unit rays; the chord form keeps its precision for the small angles an iris subtends. */
function angle(a, b) {
  return 2 * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2));
}

/**
 * Measures where the viewer's eyes are from one face's landmarks.
 *
 * Distance needs a ruler of known length on the face, and there are two candidates, each with a flaw:
 *
 *   the iris           11.7 mm in everyone, so it needs no calibration to the person. But it is 20 pixels
 *                      across, so the distance read from it is noisy, and when the viewer BLINKS the lids
 *                      cover it, the landmarks collapse, and the distance jumps: the scene lurches in and out.
 *   the eye corners    the span between the outer corners of the eyes is 150 pixels across, rigid, and does
 *                      not care about blinking. But it differs from person to person.
 *
 * So the corners are the ruler, and the irises calibrate it: while the eyes are open, the span's length for
 * this viewer is learned slowly as (11.7 mm x the span's angular size / the iris's angular size). A blink
 * teaches nothing and changes nothing.
 *
 * Sizes are compared as ANGLES between rays from the lens, not as pixel lengths. A flat picture stretches
 * things toward its edges (by 1 / cos of the angle off the axis, along the radius), so a face near the side
 * of the frame looks bigger in pixels than it is, reads as nearer, and its sideways position comes out short.
 * Angles do not have that error.
 *
 * A turned head foreshortens the span. The landmarks carry a relative depth, so the span's true length in
 * the picture's own scale is known in 3D, and the part of it that lies across the line of sight follows.
 */
export class HeadMeter {
  constructor() { this.reset(); }
  /** Forget the viewer: someone else may have sat down. */
  reset() { this.span = EYE_SPAN_DEFAULT; this.samples = 0; }

  /**
   * The point midway between the eyes in the camera frame, in metres, or null when the landmarks cannot give
   * one. `learn: false` measures without updating the viewer's span (for calibration, which measures twice).
   * Landmarks are in normalised picture coordinates (x, y in 0..1; z in the same scale as x).
   */
  measure(lm, width, height, focalPx, { learn = true } = {}) {
    if (!lm || lm.length <= LAST_LANDMARK || !(focalPx > 0)) return null;
    const a = lm[EYES[0].outer], b = lm[EYES[1].outer];
    const across = Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
    const deep = Math.hypot(across, ((b.z ?? 0) - (a.z ?? 0)) * width);
    if (!(across > 1e-3)) return null;
    // How much of the span lies across the line of sight (1 face-on, cos of the yaw when turned).
    const facing = Math.max(0.5, across / deep);
    // The angle the span would subtend if it were face-on.
    const spanAngle = angle(ray(a, width, height, focalPx), ray(b, width, height, focalPx)) / facing;
    if (!(spanAngle > 1e-5)) return null;

    if (learn && EYES.every((e) => this.openness(lm, e, width, height) > OPEN_EYE)) {
      let irisAngle = 0;
      for (const ring of IRISES) {
        const [r, t, l, d] = ring.map((i) => ray(lm[i], width, height, focalPx));
        irisAngle += Math.max(angle(r, l), angle(t, d)) / IRISES.length; // a glance aside squeezes one of the two
      }
      const span = IRIS_DIAMETER * spanAngle / irisAngle;
      // A span no adult has, or one that disagrees with what has been learned, is a bad frame (a half blink,
      // a hand across the face), not news.
      const plausible = span > 0.07 && span < 0.115 && (this.samples < 30 || Math.abs(span / this.span - 1) < 0.15);
      if (plausible) {
        this.samples++;
        this.span += (span - this.span) * Math.max(0.02, 1 / this.samples); // an average at first, then a slow follow
      }
    }

    const range = this.span / (2 * Math.tan(spanAngle / 2)); // along the line of sight
    const m = ray({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, width, height, focalPx);
    const p = { x: m[0] * range, y: m[1] * range, z: m[2] * range };
    return Number.isFinite(p.x + p.y + p.z) ? p : null;
  }

  /** How far apart an eye's lids are, as a fraction of its width. */
  openness(lm, eye, width, height) {
    const d = (i, j) => Math.hypot((lm[i].x - lm[j].x) * width, (lm[i].y - lm[j].y) * height);
    return d(eye.upper, eye.lower) / Math.max(1e-6, d(eye.outer, eye.inner));
  }
}

// MediaPipe Pose Landmarker indices (33 points on the body; the ones on the head and the shoulders).
const POSE = { nose: 0, eyeA: 2, eyeB: 5, earA: 7, earB: 8, shoulderA: 11, shoulderB: 12 };
/**
 * The shoulder ruler before it has been taught, in metres. It is an EFFECTIVE width: the shoulders are measured
 * as if they were at the eyes' distance, and they are really some 8 cm further from the lens and well below
 * its axis, so a typical adult's 37 cm (joint to joint, as the pose model marks them) counts as about 31.
 */
export const SHOULDER_SPAN_DEFAULT = 0.31;
/** A pose landmark the model is at least this sure it can see counts as seen. */
const SEEN = 0.5;

/**
 * The backup: where the viewer's eyes are when the face tracker cannot say.
 *
 * The face tracker needs the face: both eyes, more or less front-on, inside the picture. It lets go when the
 * viewer turns their head aside or leans toward the edge of the camera's view, which is exactly when they are
 * looking round the side of the box. A body-pose model does not need the face. It finds the nose, the eyes,
 * the ears and the shoulders from the whole outline of the head and upper body, in profile, from behind a
 * hand, and with half of the viewer out of the frame.
 *
 * It is cruder (a dozen points on the head against the face tracker's four hundred), so it is the backup and
 * not the source, and the face tracker teaches it while both can see the viewer:
 *
 *   the ruler      the shoulders, which do not turn with the head. Their width for this viewer is learned
 *                  from the distance the face tracker reads. When the shoulders are out of the picture the
 *                  last known distance from the screen is held: a head that turns aside, or slides along
 *                  the desk toward the edge of the view, stays as far from the screen as it was.
 *   the eye point  the pose model's idea of where the eyes are differs a little from the face tracker's;
 *                  the difference is learned, so the view does not jump when one hands over to the other.
 */
export class BodyMeter {
  constructor() { this.reset(); }
  reset() {
    this.shoulders = SHOULDER_SPAN_DEFAULT; this.taught = 0;
    this.bias = { x: 0, y: 0, z: 0 };
    this.depth = null; // the last known distance of the eyes from the lens's plane (camera z), metres
  }

  /** The point to take as "between the eyes", in normalised picture coordinates, or null if the head is not seen. */
  static headPoint(pose) {
    const seen = (i) => pose[i] && (pose[i].visibility ?? 1) >= SEEN;
    const mid = (i, j) => ({ x: (pose[i].x + pose[j].x) / 2, y: (pose[i].y + pose[j].y) / 2 });
    if (seen(POSE.eyeA) && seen(POSE.eyeB)) return mid(POSE.eyeA, POSE.eyeB);
    if (seen(POSE.nose) && seen(POSE.earA) && seen(POSE.earB)) {
      // Eyes hidden: the bridge of the nose is level with the ears and above the nose's tip.
      const ears = mid(POSE.earA, POSE.earB), n = pose[POSE.nose];
      return { x: (ears.x + n.x) / 2, y: ears.y };
    }
    if (seen(POSE.nose)) return { x: pose[POSE.nose].x, y: pose[POSE.nose].y };
    if (seen(POSE.earA) && seen(POSE.earB)) return mid(POSE.earA, POSE.earB);
    return null;
  }

  /** The angle the shoulders would subtend seen square-on, or null if both are not in view. */
  static shoulderAngle(pose, width, height, focalPx) {
    const a = pose[POSE.shoulderA], b = pose[POSE.shoulderB];
    if (!a || !b || (a.visibility ?? 1) < SEEN || (b.visibility ?? 1) < SEEN) return null;
    const across = Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
    if (!(across > 1e-3)) return null;
    const facing = Math.max(0.5, across / Math.hypot(across, ((b.z ?? 0) - (a.z ?? 0)) * width));
    const ang = angle(ray(a, width, height, focalPx), ray(b, width, height, focalPx)) / facing;
    return ang > 1e-4 ? ang : null;
  }

  /** The raw estimate, before the learned correction: { p, fromShoulders } or null. */
  estimate(pose, width, height, focalPx) {
    if (!pose || pose.length < 13 || !(focalPx > 0)) return null;
    const at = BodyMeter.headPoint(pose);
    if (!at) return null;
    const ang = BodyMeter.shoulderAngle(pose, width, height, focalPx);
    const m = ray(at, width, height, focalPx);
    const range = ang ? this.shoulders / (2 * Math.tan(ang / 2)) : this.depth / m[2];
    if (!(range > 0)) return null; // no shoulders and no memory of a distance: nothing to go on
    const p = { x: m[0] * range, y: m[1] * range, z: m[2] * range };
    return Number.isFinite(p.x + p.y + p.z) ? { p, ang } : null;
  }

  /** Both trackers can see the viewer: `head` is the face tracker's answer for the same camera frame. Learn from it. */
  learn(pose, width, height, focalPx, head) {
    const range = Math.hypot(head.x, head.y, head.z);
    this.depth = head.z;
    const ang = pose && pose.length >= 13 ? BodyMeter.shoulderAngle(pose, width, height, focalPx) : null;
    if (ang) {
      const span = 2 * Math.tan(ang / 2) * range;
      if (span > 0.2 && span < 0.6) {
        this.taught++;
        this.shoulders += (span - this.shoulders) * Math.max(0.05, 1 / this.taught);
      }
    }
    const e = this.estimate(pose, width, height, focalPx);
    if (e) {
      const k = this.taught <= 1 ? 1 : 0.2;
      this.bias.x += (head.x - e.p.x - this.bias.x) * k;
      this.bias.y += (head.y - e.p.y - this.bias.y) * k;
      this.bias.z += (head.z - e.p.z - this.bias.z) * k;
    }
  }

  /** The face tracker has lost the viewer: the point between the eyes in the camera frame from the pose alone, or null. */
  measure(pose, width, height, focalPx) {
    const e = this.estimate(pose, width, height, focalPx);
    if (!e) return null;
    const p = { x: e.p.x + this.bias.x, y: e.p.y + this.bias.y, z: Math.max(0.1, e.p.z + this.bias.z) };
    this.depth = p.z;
    return p;
  }
}

/**
 * Camera frame to window frame. `cam` is where the lens is in the window frame (see `windowMetrics`); the
 * lens is taken to look straight out of the screen. A lens that is tilted (a laptop lid) puts a constant
 * error on the result at any one distance, which calibration takes out.
 */
export function cameraToWindow(p, cam) {
  return { x: cam.x - p.x, y: cam.y - p.y, z: cam.z + p.z };
}

/**
 * The physical size of the page's window and where the webcam is relative to its centre.
 * `diagonalInches` is the size of the whole display the window is on; the rest are the browser's own numbers
 * in CSS pixels (screen.width/height, innerWidth/innerHeight, outerWidth/outerHeight, and the window's
 * top-left corner on its display). The webcam is assumed to sit on top of that display, in the middle.
 * Returns { width, height, cam: { x, y, z } } in metres.
 */
export function windowMetrics({ diagonalInches, screenW, screenH, innerW, innerH, outerW = innerW, outerH = innerH, winX = 0, winY = 0 }) {
  const metresPerPx = diagonalInches * 0.0254 / Math.hypot(screenW, screenH);
  // The page is the bottom of the browser window: toolbars and tabs are above it, and side borders are equal.
  const centreX = winX + (outerW - innerW) / 2 + innerW / 2;
  const centreY = winY + (outerH - innerH) + innerH / 2;
  return {
    width: innerW * metresPerPx,
    height: innerH * metresPerPx,
    metresPerPx,
    cam: { x: (screenW / 2 - centreX) * metresPerPx, y: (centreY + 0) * metresPerPx + 0.008, z: 0 },
  };
}

/**
 * The One Euro filter (Casiez, Roussel and Vogel, CHI 2012): a low-pass whose cutoff rises with speed. A
 * still head is smoothed hard, so the picture does not shiver with the tracker's noise; a moving head is
 * hardly smoothed at all, so the picture does not lag behind it. Those are the two ways head tracking fails.
 */
export class OneEuro {
  constructor(minCutoff = 1, beta = 0, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  /** Feed one sample taken `dt` seconds after the last; returns the filtered value. */
  filter(value, dt) {
    if (this.x === null || !(dt > 0)) { this.x = value; this.dx = 0; return value; }
    const dx = (value - this.x) / dt;
    this.dx += (dx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (value - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

/** Three One Euro filters for a position. Depth is the noisiest axis (it hangs on a 20-pixel iris), so it gets more. */
export class HeadFilter {
  constructor() {
    this.fx = new OneEuro(1.0, 9); this.fy = new OneEuro(1.0, 9); this.fz = new OneEuro(0.5, 2.5);
  }
  reset() { this.fx.reset(); this.fy.reset(); this.fz.reset(); }
  filter(p, dt) { return { x: this.fx.filter(p.x, dt), y: this.fy.filter(p.y, dt), z: this.fz.filter(p.z, dt) }; }
}
