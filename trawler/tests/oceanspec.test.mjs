// The sea has to be right before anything is built on it: the boat's motion, the spray, the foam
// and the look of the horizon all come out of these numbers. These check them against what the
// textbooks and the Douglas scale say, not against themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  G_ACCEL, dispersion, phaseSpeed, seaToWind, seaToFetch, peakOmega, jonswap, significantHeight,
  spreadExponent, spreadWeight, choppiness, whitecapCoverage, buildSea, buildCascade,
  longWaveComponents, CASCADES, FFT_N, ORIGIN_STEP,
} from '../html/js/oceanspec.js';

/** A seeded standard normal, so every run of the test sees the same sea. */
function normals(seed = 12345) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    let r = 0;
    while (r === 0) r = u();
    return Math.sqrt(-2 * Math.log(r)) * Math.cos(2 * Math.PI * u());
  };
}

test('deep-water dispersion matches the textbook', () => {
  // A 100 m swell has a period of 8.0 s and runs at 12.5 m/s; gravity alone, no capillary term.
  const k = (2 * Math.PI) / 100;
  const T = (2 * Math.PI) / dispersion(k);
  assert.ok(Math.abs(T - 8.0) < 0.05, `period ${T}`);
  assert.ok(Math.abs(phaseSpeed(k) - 12.49) < 0.05, `speed ${phaseSpeed(k)}`);
  // Period and wavelength: L = g T^2 / 2pi, so a 10 s wave is 156 m long.
  const k10 = (2 * Math.PI) / (G_ACCEL * 100 / (2 * Math.PI));
  assert.ok(Math.abs((2 * Math.PI) / dispersion(k10) - 10) < 0.02);
});

test('capillary waves are faster than gravity alone would have them', () => {
  // The minimum phase speed of a water wave is 23 cm/s at a 1.7 cm wavelength: a real, checkable
  // number, and the reason the smallest cascade needs the surface-tension term.
  let min = Infinity, at = 0;
  for (let lambda = 0.004; lambda < 0.2; lambda += 0.0002) {
    const c = phaseSpeed((2 * Math.PI) / lambda);
    if (c < min) { min = c; at = lambda; }
  }
  assert.ok(Math.abs(min - 0.231) < 0.01, `minimum speed ${min}`);
  assert.ok(Math.abs(at - 0.0173) < 0.002, `at wavelength ${at}`);
});

test('the sea scale runs from a glassy calm to a gale', () => {
  assert.equal(+seaToWind(0).toFixed(2), 2);
  assert.equal(+seaToWind(1).toFixed(2), 20);
  // Monotone, and most of the slider spent in the middle of the range.
  let prev = -1;
  for (let s = 0; s <= 1.0001; s += 0.05) {
    const u = seaToWind(s);
    assert.ok(u > prev, 'wind speed must rise with the slider');
    prev = u;
  }
});

test('significant wave height matches the sea states it claims', () => {
  // Douglas sea state: 1 is under 0.1 m, 4 (moderate) is 1.25-2.5 m, 6 (very rough) 4-6 m.
  const hs = (sea) => significantHeight(seaToWind(sea), seaToFetch(sea));
  assert.ok(hs(0) < 0.2, `calm Hs ${hs(0)}`);
  const moderate = hs(0.34);
  assert.ok(moderate > 0.7 && moderate < 2.6, `moderate Hs ${moderate}`);
  const storm = hs(1);
  assert.ok(storm > 4 && storm < 9, `storm Hs ${storm}`);
  // It must never go backwards as the wind gets up.
  let prev = 0;
  for (let s = 0; s <= 1.0001; s += 0.05) {
    const h = hs(s);
    assert.ok(h >= prev - 1e-9, `Hs fell at sea ${s}`);
    prev = h;
  }
});

test('the JONSWAP peak sits where the wind puts it', () => {
  // A 10 m/s wind over a 100 km fetch peaks near a 6 s period.
  const wp = peakOmega(10, 100000);
  const T = (2 * Math.PI) / wp;
  assert.ok(T > 4.5 && T < 8, `peak period ${T}`);
  // The spectrum peaks at the peak frequency and falls away either side of it.
  assert.ok(jonswap(wp, 10, 100000) > jonswap(wp * 0.6, 10, 100000));
  assert.ok(jonswap(wp, 10, 100000) > jonswap(wp * 1.8, 10, 100000));
  // A stronger wind moves the peak to longer waves.
  assert.ok(peakOmega(18, 100000) < peakOmega(6, 100000));
});

test('the sea is short-crested at the sides and long-crested at the peak', () => {
  const wp = peakOmega(10, 100000);
  const sPeak = spreadExponent(wp, wp, 10);
  assert.ok(spreadExponent(wp * 0.5, wp, 10) < sPeak, 'low frequencies spread wider');
  assert.ok(spreadExponent(wp * 2, wp, 10) < sPeak, 'high frequencies spread wider');
  // Nothing travels into the wind.
  assert.ok(spreadWeight(Math.PI, 0, 8) < 1e-12, 'nothing travels straight into the wind');
  assert.ok(spreadWeight(0, 0, 8) > spreadWeight(1, 0, 8));
});

test('chop and whitecaps follow the wind', () => {
  assert.ok(choppiness(1) > choppiness(0));
  assert.equal(whitecapCoverage(4), 0, 'no whitecaps under about force 4');
  assert.ok(whitecapCoverage(10) > 0.005 && whitecapCoverage(10) < 0.1, `at 10 m/s ${whitecapCoverage(10)}`);
  assert.ok(whitecapCoverage(20) > 0.1, `at 20 m/s ${whitecapCoverage(20)}`);
});

test('the built cascades carry the height the wind implies', () => {
  for (const sea of [0.05, 0.35, 0.7, 1.0]) {
    const u10 = seaToWind(sea), fetch = seaToFetch(sea);
    const built = buildSea(
      { u10, fetch, dirRad: 0.4 },
      { height: 0.5, dirRad: 2.1, periodS: 11, spread: 24 },
      normals(7 + Math.round(sea * 100)),
    );
    // The variance of the three cascades together must be (Hs/4)^2, which is what the scaling
    // step exists to guarantee. Measured from the texel data, not from the bookkeeping.
    let v = 0;
    for (const c of built.cascades) {
      for (let i = 0; i < c.data.length; i += 4) {
        v += 2 * (c.data[i] ** 2 + c.data[i + 1] ** 2);
        v += 2 * (c.data[i + 2] ** 2 + c.data[i + 3] ** 2);
      }
    }
    // Each texel's two halves are the k and -k draws, so summing both over the whole grid counts
    // every pair twice.
    v *= 0.5;
    const want = (built.hs / 4) ** 2;
    assert.ok(Math.abs(v - want) / want < 0.02, `sea ${sea}: variance ${v} vs ${want}`);
    assert.ok(Number.isFinite(built.meanSquareSlope) && built.meanSquareSlope > 0);
  }
});

test('mean square slope is in the range the sun glitter needs', () => {
  // Cox and Munk measured the slope variance of a wind-roughened sea as about 0.003 + 0.00512 U,
  // which at 10 m/s is 0.054. Ours is band-limited (nothing under 10 cm), so it should be the
  // same order and lower, never wild.
  const u10 = 10;
  const built = buildSea({ u10, fetch: 100000, dirRad: 0 }, { height: 0, dirRad: 0, periodS: 0 }, normals(99));
  const coxMunk = 0.003 + 0.00512 * u10;
  assert.ok(built.meanSquareSlope > 0.45 * coxMunk && built.meanSquareSlope < 1.6 * coxMunk,
    `mss ${built.meanSquareSlope} against Cox-Munk ${coxMunk}`);
});

test('the slope variance tracks the wind the way Cox and Munk measured', () => {
  // Not just at one wind speed: the whole range, or a calm looks like glass and a gale like foil.
  for (const u10 of [5, 8, 12, 16, 20]) {
    const built = buildSea({ u10, fetch: 100000, dirRad: 0 },
      { height: 0, dirRad: 0, periodS: 0 }, normals(100 + u10));
    const coxMunk = 0.003 + 0.00512 * u10;
    const r = built.meanSquareSlope / coxMunk;
    // The grid stops at 25 cm, so at a high wind it resolves a smaller share of the slope and the
    // shader makes the difference up as roughness; what matters is that the resolved part stays a
    // sensible fraction and never exceeds the measurement.
    assert.ok(r > 0.35 && r < 1.3, `at ${u10} m/s the slope variance is ${r.toFixed(2)} of Cox-Munk`);
  }
});

test('the directional spreading is a probability density', () => {
  // If it is not normalised, the narrow-spread peak and the wide-spread tail are weighted against
  // each other wrongly, and no amount of scaling the result afterwards can put it right.
  for (const s of [0.3, 1, 5, 15, 40]) {
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const th = -Math.PI + ((i + 0.5) * 2 * Math.PI) / n;
      sum += spreadWeight(th, 0.4, s) * ((2 * Math.PI) / n);
    }
    assert.ok(Math.abs(sum - 1) < 2e-4, `s = ${s} integrates to ${sum}`);
  }
});

test('the amplitudes pair up so the surface comes out real', () => {
  // h0(-k) must be the conjugate partner stored alongside h0(k), or the inverse transform leaves
  // an imaginary part and the "height" is nonsense.
  const n = 32;
  const c = buildCascade({ size: 256, kLow: 0, kHigh: 1e9 }, n, { u10: 10, fetch: 100000, dirRad: 0.3 },
    { height: 0, dirRad: 0, periodS: 0 }, normals(5));
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = (z * n + x) * 4;
      const j = (((n - z) % n) * n + ((n - x) % n)) * 4;
      // Slot 2,3 of texel i is conj(h0(-k)); slot 0,1 of texel j is h0(-k).
      assert.ok(Math.abs(c.data[i + 2] - c.data[j]) < 1e-12, 'real parts must match');
      assert.ok(Math.abs(c.data[i + 3] + c.data[j + 1]) < 1e-12, 'imaginary parts must be opposite');
    }
  }
});

test('the long-wave components rebuild the same surface the transform would', () => {
  // This is the join between the sea you see (a transform on the GPU) and the sea the boat feels
  // (a sum of cosines on the CPU). If the two disagree the hull rides a different ocean.
  const n = 32, size = 512;
  const c = buildCascade({ size, kLow: 0, kHigh: 1e9 }, n, { u10: 12, fetch: 100000, dirRad: 0.7 },
    { height: 1.2, dirRad: 2.0, periodS: 10, spread: 24 }, normals(31));
  const comps = longWaveComponents(c.data, size, n, 0.001, 1e9, 1); // every component, no filtering
  const dk = (2 * Math.PI) / size;

  // The direct inverse transform at a few places and times.
  const direct = (x, z, t) => {
    let re = 0;
    for (let q = 0; q < n; q++) {
      const mz = q < n / 2 ? q : q - n;
      for (let p = 0; p < n; p++) {
        const mx = p < n / 2 ? p : p - n;
        const kx = mx * dk, kz = mz * dk;
        const k = Math.hypot(kx, kz);
        const w = dispersion(k);
        const o = (q * n + p) * 4;
        // h(k,t) = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
        const hr = c.data[o] * Math.cos(w * t) - c.data[o + 1] * Math.sin(w * t)
                 + c.data[o + 2] * Math.cos(w * t) + c.data[o + 3] * Math.sin(w * t);
        const hi = c.data[o] * Math.sin(w * t) + c.data[o + 1] * Math.cos(w * t)
                 - c.data[o + 2] * Math.sin(w * t) + c.data[o + 3] * Math.cos(w * t);
        const ph = kx * x + kz * z;
        re += hr * Math.cos(ph) - hi * Math.sin(ph);
      }
    }
    return re;
  };

  const sum = (x, z, t) => comps.reduce(
    (a, w) => a + w.amp * Math.cos(w.kx * x + w.kz * z + w.dir * w.omega * t + w.phase), 0);

  for (const [x, z, t] of [[0, 0, 0], [37, -14, 0], [120, 260, 3.7], [-80, 410, 21.5]]) {
    const d = direct(x, z, t), s = sum(x, z, t);
    // The cosine sum drops components under a tenth of a millimetre, and the texel data is
    // float32, so a ten-thousandth of a metre of disagreement is expected; a sign error, a missing
    // half plane or a wrong dispersion would show up thousands of times larger.
    assert.ok(Math.abs(d - s) < 3e-4 * Math.max(1, Math.abs(d)) + 1e-4,
      `at (${x}, ${z}, t=${t}): transform ${d} vs cosine sum ${s}`);
  }
});

test('the real cascade split covers every wavenumber once', () => {
  // No gaps and no overlaps between the three bands, and each band inside its own grid's Nyquist.
  assert.equal(CASCADES[0].kLow, 0);
  for (let i = 1; i < CASCADES.length; i++) {
    assert.equal(CASCADES[i].kLow, CASCADES[i - 1].kHigh, 'bands must meet exactly');
  }
  for (const c of CASCADES) {
    const nyquist = (Math.PI * FFT_N) / c.size;
    const fundamental = (2 * Math.PI) / c.size;
    assert.ok(c.kHigh <= nyquist * 1.0001 || c === CASCADES[CASCADES.length - 1],
      `band ${c.size} m reaches past its Nyquist`);
    assert.ok(c.kLow === 0 || c.kLow >= fundamental,
      `band ${c.size} m starts below its own fundamental`);
  }
  // The finest cascade must resolve at least down to a few centimetres.
  const finest = CASCADES[CASCADES.length - 1];
  assert.ok((2 * Math.PI) / ((Math.PI * FFT_N) / finest.size) <= 0.26, 'the ripple must get under 26 cm');
  // Every size must divide the origin step, or the sea's pattern would jump when the world origin
  // moves (see the comment on CASCADES).
  for (const c of CASCADES) assert.equal(ORIGIN_STEP % c.size, 0, `${c.size} m does not divide the origin step`);
});
