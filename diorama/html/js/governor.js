// Diorama — the frame governor. Pure: imports nothing, so node can test it.
//
// Hangar's rule was that the frame rate gives way before the resolution does, because its camera strolls. Here
// the picture is steered by the viewer's own head, and a head-tracked picture that lags or stutters stops
// reading as a window at all. So the order is the other way round: hold 60 frames a second by drawing fewer
// pixels (the canvas still fills the window, scaled up, and keeps its anti-aliasing), in steps down to half
// the native size each way; only if that is not enough, settle for a steady 30. With "Full Resolution" on,
// the resolution is left alone and the only step is from 60 to 30.
//
// It only ever steps down. A scene's cost does not change while it runs, so a step up would be a guess that
// costs a stutter to test; a resize or a new scene starts again from the top.

/** Fractions of the native pixel ratio, best first. */
export const TIERS = [1, 0.8, 0.65, 0.5];
const WINDOW = 90; // frames judged at a time: a second and a half at 60

export class Governor {
  constructor({ allowScale = true, fps = 60 } = {}) {
    this.allowScale = allowScale;
    this.fps = fps;
    this.tier = 0;
    this.samples = [];
  }
  get scale() { return TIERS[this.tier]; }
  /** Forget what has been measured: something changed (a rebuild, a resize) and the next frames do not count yet. */
  settle() { this.samples.length = 0; }
  /**
   * Feed the time between two delivered frames, in milliseconds. Returns 'scale' or 'fps' when it has just
   * stepped down (the caller applies it and should let things settle), otherwise null.
   */
  frame(ms) {
    if (!(ms > 0) || ms > 250) return null; // a hidden tab or a hitch, not a frame rate
    this.samples.push(ms);
    if (this.samples.length < WINDOW) return null;
    const sorted = this.samples.slice().sort((a, b) => a - b), target = 1000 / this.fps;
    const median = sorted[WINDOW >> 1], late = this.samples.filter((s) => s > target * 1.5).length / WINDOW;
    this.samples.length = 0;
    if (median <= target * 1.15 && late <= 0.25) return null; // holding
    if (this.allowScale && this.tier < TIERS.length - 1) { this.tier++; return 'scale'; }
    if (this.fps > 30) { this.fps = 30; return 'fps'; }
    return null;
  }
}
