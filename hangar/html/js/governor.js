// Hangar — Frame-rate governor (Ruling R17): a steady 60, or a steady 30 when 60 can't hold. Pure: no three.
//
// The owner chose sharpness over frame rate, so resolution never moves; only the frame rate does. Two signals:
// - intervals: the delivered time between rendered frames while trying for 60. A share of them well past the
//   frame budget means vsyncs are being missed (the real symptom, whatever the cause).
// - probes: about once a second while at 30 the app times one frame end to end (the GPU drained before and
//   after), which is the frame's full cost and the only way to see headroom for a climb. Never at 60: draining
//   the GPU there makes a near-budget frame miss its vsync, a periodic stutter on a machine that holds 60, and
//   late frames already show in the intervals (wantsProbe).
// It drops to 30 on either signal and climbs back only when the probes show clear headroom (under fastMs, well
// below slowMs) for a while, and after a cooldown that doubles each time a climb fails soon after, so it never
// flaps between the two.

export const GOVERNOR = {
  window: 60, // intervals looked at (one second at 60)
  missFactor: 1.35, // an interval past 1.35x the 60 fps budget (22.5 ms) is a missed frame
  missShare: 0.25, // a quarter of the window missed -> drop
  gapMs: 250, // longer gaps are a hidden tab or a debugger pause, not slowness
  probes: 5, // probes looked at (their median)
  slowMs: 15, // probe median over this at 60 -> drop
  fastMs: 11, // probe median under this at 30 -> may climb
  cooldown: 8, // s at 30 before the first climb
  maxCooldown: 240, // s
  flapWindow: 30, // s: a drop this soon after a climb doubles the cooldown
  probeEvery: 1, // s between probes at 30 (none at 60)
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
};

export class FrameGovernor {
  constructor(opts = {}) {
    this.o = { ...GOVERNOR, ...opts };
    this.fps = 60;
    this.cooldown = this.o.cooldown;
    this.upAt = -Infinity; // time of the last climb to 60
    this.nextUp = 0; // earliest time a climb is allowed
    this.reason = 'start';
    this.intervals = [];
    this.probeMs = [];
    this.probeAt = 0; // earliest time (s) of the next probe
  }

  /**
   * Whether the frame at time t (s) should be timed end to end (and then fed to probe). Only at 30: at 60 the
   * GPU drain itself could make the frame miss vsync, and the intervals are the signal there. `synced` (the
   * ?perf overlay drains the GPU every frame anyway, so it feeds no intervals) probes at either rate.
   */
  wantsProbe(t, synced = false) {
    if ((this.fps !== 30 && !synced) || t < this.probeAt) return false;
    this.probeAt = t + this.o.probeEvery;
    return true;
  }

  /** Forget the recent samples (after a hidden tab, a mode change or a pause); the current rate stays. */
  reset() { this.intervals.length = 0; this.probeMs.length = 0; }

  /** The delivered time (ms) between two rendered frames, at time t (s). Only counts while trying for 60. */
  interval(ms, t) {
    if (this.fps !== 60 || !Number.isFinite(ms) || ms <= 0 || ms > this.o.gapMs) return this.fps;
    const w = this.intervals;
    w.push(ms);
    if (w.length > this.o.window) w.shift();
    if (w.length === this.o.window) {
      const limit = this.o.missFactor * (1000 / 60);
      const missed = w.reduce((n, x) => n + (x > limit ? 1 : 0), 0);
      if (missed >= this.o.missShare * w.length) this.drop(t, `${missed}/${w.length} frames late`);
    }
    return this.fps;
  }

  /** One frame's full measured cost (ms) at time t (s). */
  probe(ms, t) {
    if (!Number.isFinite(ms) || ms < 0) return this.fps;
    const p = this.probeMs;
    p.push(ms);
    if (p.length > this.o.probes) p.shift();
    if (p.length < this.o.probes) return this.fps;
    const m = median(p);
    if (this.fps === 60 && m > this.o.slowMs) this.drop(t, `frame ${m.toFixed(1)} ms`);
    else if (this.fps === 30 && m < this.o.fastMs && t >= this.nextUp) this.climb(t, `frame ${m.toFixed(1)} ms`);
    return this.fps;
  }

  drop(t, why) {
    // A climb that failed soon after: wait twice as long before the next try.
    this.cooldown = t - this.upAt < this.o.flapWindow ? Math.min(this.o.maxCooldown, this.cooldown * 2) : this.o.cooldown;
    this.fps = 30;
    this.nextUp = t + this.cooldown;
    this.reason = why;
    this.reset();
  }

  climb(t, why) {
    this.fps = 60;
    this.upAt = t;
    this.reason = why;
    this.reset();
  }

  /** A one-line state for the ?perf overlay. */
  describe(t) {
    if (this.fps === 60) return `60 (${this.reason})`;
    const wait = Math.max(0, this.nextUp - t);
    return `30 (${this.reason}${wait > 0 ? `; retry in ${wait.toFixed(0)} s` : ''})`;
  }
}
