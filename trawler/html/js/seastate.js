// Trawler — The weather. One number, `sea` in 0..1, and everything that follows from it. Pure, so
// `node --test` can walk a day of it and check that it behaves.
//
// Left alone the weather is a slow random walk with a memory (an Ornstein-Uhlenbeck process) about
// a background level that itself wanders, plus the occasional front: a front is a shove toward a
// new level over a quarter of an hour or so, with the wind backing or veering as it passes. That
// is roughly how a day at sea actually goes — long stretches of not much, then a change that you
// can see coming — and it means the scene really does run from calm to stormy and back while you
// watch, without ever jumping.
//
// Pinning a sea state from the menu eases to it over half a minute rather than snapping, so a
// change of mode still looks like weather.

import { clamp, clamp01, lerp, smoothstep, approach, TAU, angleDiff } from './mathutil.js';
import { seaToWind, seaToFetch, significantHeight, choppiness, whitecapCoverage, peakOmega } from './oceanspec.js';

export const WEATHER = {
  // Seconds of scene time for the random walk to forget where it was. A quarter of an hour of
  // wall time: long enough that the sea has a mood, short enough that a sitting sees it change.
  memory: 540,
  // How far the walk wanders either side of the background, as a share of the 0..1 scale.
  spread: 0.26,
  // Seconds between fronts, on average, and how long one takes to pass.
  frontEvery: 900,
  frontLength: 420,
  // How fast a pinned sea state is reached.
  pinTau: 26,
  // The wind turns slowly; a front turns it faster.
  windTurn: 0.0022, // rad/s of ordinary wandering
};

/** Everything the rest of the scene reads off the weather. */
export function derive(sea) {
  const s = clamp01(sea);
  const u10 = seaToWind(s);
  const fetch = seaToFetch(s);
  const hs = significantHeight(u10, fetch);
  return {
    sea: s,
    u10,
    fetch,
    hs,
    peakPeriod: (TAU) / peakOmega(u10, fetch),
    choppiness: choppiness(s),
    whitecap: whitecapCoverage(u10),
    // Cloud: a fine day is a few fair-weather cumulus with a high base; a gale is a low, dark,
    // nearly unbroken deck with scud under it.
    cloudCover: lerp(0.14, 0.97, Math.pow(s, 0.72)),
    cloudBase: lerp(1150, 260, smoothstep(0.1, 0.95, s)),
    cloudThick: lerp(520, 2200, Math.pow(s, 0.8)),
    cloudDark: smoothstep(0.25, 0.9, s),
    // Haze: spray and spindrift fill the air as it blows, so the islands close in.
    haze: lerp(1.0, 4.2, Math.pow(s, 1.4)),
    hazeFar: lerp(26000, 5200, Math.pow(s, 0.9)),
    // Spray off the crests starts at about force 6 and is continuous by force 9.
    spray: smoothstep(0.42, 0.95, s),
    // Rain comes with the worst of it, but not always: `rainBias` lets a storm be dry.
    rainChance: smoothstep(0.55, 1.0, s),
  };
}

export class Weather {
  /**
   * @param {import('./util.js').Rng} rng
   * @param {number|null} pinned a sea state to hold, or null to let it drift
   */
  constructor(rng, pinned = null) {
    this.rng = rng;
    this.background = pinned ?? rng.range(0.1, 0.5);
    this.walk = 0;
    this.sea = pinned ?? this.background;
    this.pinned = pinned;
    this.time = 0;
    this.nextFront = rng.range(0.3, 1.2) * WEATHER.frontEvery;
    this.front = null;
    // The wind blows from somewhere and keeps roughly to it; the swell is older and comes from
    // wherever the last blow was, which is usually not the same quarter.
    this.windDir = rng.range(0, TAU);
    this.windTarget = this.windDir;
    this.swell = {
      height: rng.range(0.3, 1.1),
      dirRad: this.windDir + rng.range(-1.4, 1.4) + (rng.coin() ? Math.PI * 0.55 : -Math.PI * 0.55),
      periodS: rng.range(8.5, 13.5),
      spread: rng.range(16, 34),
    };
    this.derived = derive(this.sea);
  }

  /** Pins the sea state (it eases there), or lets the weather drift again with `null`. */
  pin(value) {
    this.pinned = value === null || value === undefined ? null : clamp01(value);
    if (this.pinned !== null) {
      this.front = null;
      this.background = this.pinned;
    }
  }

  /** Jumps straight to a sea state, for a reseed or a test. */
  set(value) {
    this.sea = clamp01(value);
    this.walk = 0;
    this.background = this.sea;
    this.derived = derive(this.sea);
  }

  step(dt) {
    this.time += dt;
    if (this.pinned !== null) {
      this.sea = approach(this.sea, this.pinned, WEATHER.pinTau, dt);
    } else {
      // The background drifts very slowly indeed; the walk hangs off it with a memory.
      this.background = clamp(this.background + this.rng.normal() * dt * 0.0016, 0.05, 0.85);
      const decay = Math.exp(-dt / WEATHER.memory);
      const sigma = WEATHER.spread * Math.sqrt(Math.max(1 - decay * decay, 0));
      this.walk = this.walk * decay + this.rng.normal() * sigma;
      let target = this.background + this.walk;

      // Fronts.
      if (!this.front && this.time > this.nextFront) {
        const to = clamp01(this.rng.coin(0.55)
          ? this.background + this.rng.range(0.2, 0.5)
          : this.background - this.rng.range(0.15, 0.35));
        this.front = { from: this.background, to, t: 0, length: WEATHER.frontLength * this.rng.range(0.7, 1.5), veer: this.rng.range(-1, 1) * 1.1 };
      }
      if (this.front) {
        const f = this.front;
        f.t += dt;
        const p = clamp01(f.t / f.length);
        const ease = p * p * (3 - 2 * p);
        target = lerp(f.from, f.to, ease) + this.walk * (1 - ease * 0.5);
        this.windTarget += f.veer * dt / f.length;
        if (p >= 1) {
          this.background = f.to;
          this.front = null;
          this.nextFront = this.time + WEATHER.frontEvery * this.rng.range(0.6, 1.8);
        }
      }
      this.sea = clamp01(approach(this.sea, clamp01(target), 40, dt));
    }

    // The wind wanders, and a dying sea leaves its swell behind.
    this.windTarget += (this.rng.next() - 0.5) * WEATHER.windTurn * dt * 60;
    this.windDir += angleDiff(this.windDir, this.windTarget) * (1 - Math.exp(-dt / 90));
    this.derived = derive(this.sea);
    // The swell remembers the biggest sea of the last while, and decays slowly after it.
    const seaSwell = this.derived.hs * 0.33;
    this.swell.height = seaSwell > this.swell.height
      ? approach(this.swell.height, seaSwell, 220, dt)
      : approach(this.swell.height, seaSwell, 1800, dt);
    this.swell.periodS = approach(this.swell.periodS, clamp(this.derived.peakPeriod * 1.45, 8, 15), 900, dt);
    return this.derived;
  }

  /** How much the sea has changed since the spectrum was last built, as a fraction. */
  driftSince(sea, swellHeight) {
    return Math.abs(this.sea - sea) + Math.abs(this.swell.height - swellHeight) * 0.3;
  }
}
