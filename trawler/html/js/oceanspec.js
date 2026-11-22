// Trawler — The wave spectrum: the oceanography the sea is built from. Pure maths, no three.js and
// no WebGL, so `node --test` can check it.
//
// One number drives the whole sea: the wind at ten metres, U10. From it come the peak frequency,
// the significant wave height, how short-crested the sea is, how steep the crests get and how much
// of it is breaking. The shape is JONSWAP (Hasselmann et al. 1973), the North Sea fit that is still
// the standard for a fetch-limited wind sea, with a Mitsuyasu-style directional spread that is
// narrow at the peak and wide either side of it — which is why a real sea looks like a confusion of
// crests rather than a corduroy of parallel rollers.
//
// A swell train from another quarter is always added. At sea there is nearly always one: it is what
// makes a flat calm still heave, and what makes a beam sea uncomfortable.
//
// The surface is built as the inverse Fourier transform of a field of complex amplitudes h0(k). For
// a grid cell of area dkx*dkz carrying a directional variance density Psi(k):
//
//     h0(k) = 0.5 * (xi_r + i*xi_i) * sqrt( Psi(k) * dkx * dkz ),   xi ~ N(0, 1)
//
// which makes the surface variance come out as the integral of Psi, i.e. (Hs/4)^2. The amplitudes
// are then scaled once so the three cascades together hit exactly that, which is the one number a
// reader can check against a weather forecast.

export const G_ACCEL = 9.81;
/** The wavenumber where surface tension starts to matter: 2*pi/1.7 cm. */
export const K_CAPILLARY = 370;

/**
 * Deep-water dispersion with the capillary term. Below about 2 cm, waves are ruled by surface
 * tension rather than gravity and travel faster than gravity alone would have them; the smallest
 * cascade is right in that range.
 */
export const dispersion = (k) => Math.sqrt(G_ACCEL * k * (1 + (k / K_CAPILLARY) ** 2));

/** Phase speed and group speed, for the wake and for how fast the foam drifts. */
export const phaseSpeed = (k) => dispersion(k) / Math.max(k, 1e-6);

// ---------------------------------------------------------------------------------------------
// The sea state scale
// ---------------------------------------------------------------------------------------------

/**
 * The scene's single 0..1 sea knob, as a wind speed at 10 m. 2 m/s is a glassy morning (Douglas 1)
 * and 20 m/s is a strong gale (Douglas 7, Beaufort 8-9): the range a working boat would be out in.
 * The curve is quadratic-ish so most of the slider is spent in the interesting middle.
 */
export function seaToWind(sea) {
  const s = Math.min(Math.max(sea, 0), 1);
  return 2 + 18 * (0.35 * s + 0.65 * s * s);
}

/** Fetch in metres: in among islands the wind never has far to work, which keeps the sea short. */
export function seaToFetch(sea) {
  const s = Math.min(Math.max(sea, 0), 1);
  return 12000 + 160000 * s;
}

/** JONSWAP peak angular frequency for a wind speed and fetch. */
export function peakOmega(u10, fetch) {
  return 22 * Math.pow(G_ACCEL * G_ACCEL / (Math.max(u10, 0.5) * Math.max(fetch, 100)), 1 / 3);
}

/** JONSWAP's Phillips constant for a wind speed and fetch. */
export function jonswapAlpha(u10, fetch) {
  return 0.076 * Math.pow((u10 * u10) / (Math.max(fetch, 100) * G_ACCEL), 0.22);
}

/**
 * The JONSWAP one-dimensional variance density S(omega), in m^2 s. gamma 3.3 is the North Sea mean:
 * it sharpens the peak against a plain Pierson-Moskowitz sea, which is what a fetch-limited wind
 * sea really does.
 */
export function jonswap(omega, u10, fetch, gamma = 3.3) {
  if (!(omega > 0)) return 0;
  const wp = peakOmega(u10, fetch);
  const alpha = jonswapAlpha(u10, fetch);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return (alpha * G_ACCEL * G_ACCEL / omega ** 5) * Math.exp(-1.25 * (wp / omega) ** 4) * Math.pow(gamma, r);
}

/**
 * Significant wave height from the spectrum: Hs = 4 * sqrt(m0). Integrated numerically over the
 * frequencies that matter, which is the honest way to get the number a forecast would quote.
 */
export function significantHeight(u10, fetch) {
  const wp = peakOmega(u10, fetch);
  let m0 = 0;
  const lo = wp * 0.25, hi = wp * 8, n = 400;
  for (let i = 0; i < n; i++) {
    const w = lo + (hi - lo) * ((i + 0.5) / n);
    m0 += jonswap(w, u10, fetch) * ((hi - lo) / n);
  }
  return 4 * Math.sqrt(Math.max(m0, 0));
}

/**
 * Mitsuyasu's directional spreading exponent: narrow at the peak, broad away from it. A big `s`
 * means long parallel crests; a small one means a short, confused sea.
 */
export function spreadExponent(omega, wp, u10) {
  const sp = 11.5 * Math.pow(G_ACCEL / (Math.max(u10, 0.5) * wp), 2.5);
  return omega <= wp ? sp * Math.pow(omega / wp, 5) : sp * Math.pow(omega / wp, -2.5);
}

/** The natural logarithm of the gamma function (Lanczos, g = 7): good to about twelve digits. */
export function lgamma(x) {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = g[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * The normalising constant of the cos^2s spreading: the integral of cos^2s(theta/2) over a full
 * turn, which is 2 sqrt(pi) Gamma(s+1/2) / Gamma(s+1).
 *
 * This matters more than it looks. The exponent `s` runs from about 15 at the spectral peak down
 * to under 1 in the tail, and the unnormalised integral runs from 0.9 to 3.1 over that range: the
 * short waves come out three times too energetic, the whole spectrum is then scaled down to make
 * the wave height right, and what is left is a sea with five times the slope variance Cox and Munk
 * measured — which on screen is crumpled chrome foil rather than water.
 */
export function spreadNorm(s) {
  const ss = Math.min(Math.max(s, 0.05), 40);
  return 2 * Math.sqrt(Math.PI) * Math.exp(lgamma(ss + 0.5) - lgamma(ss + 1));
}

/** cos^2s spreading about `theta0`, normalised so it integrates to one over all directions. */
export function spreadWeight(theta, theta0, s) {
  // The difference has to be wrapped into (-pi, pi] first. Without that, a wind blowing at 170
  // degrees gives no energy at all to waves running at -175, which are ten degrees away from it.
  let dt = (theta - theta0) % (2 * Math.PI);
  if (dt > Math.PI) dt -= 2 * Math.PI;
  if (dt <= -Math.PI) dt += 2 * Math.PI;
  const d = Math.cos(0.5 * dt);
  // A negative cosine means more than 180 degrees away: no energy travels backwards into the wind.
  if (d <= 0) return 0;
  return Math.pow(d, 2 * Math.min(s, 40)) / spreadNorm(s);
}

/**
 * How steep the crests are allowed to get. Choppiness displaces water horizontally toward the
 * crests; at zero the surface is a sum of sines, and at one the crests are drawn into the sharp
 * ridges of a gale. Pushed too far the surface folds through itself, so it is capped.
 */
export function choppiness(sea) {
  const s = Math.min(Math.max(sea, 0), 1);
  // Past about one the horizontal displacement folds the surface through itself everywhere rather
  // than only at breaking crests, which reads as white ribbons painted along every wave.
  return 0.45 + 0.52 * s;
}

/**
 * The slope variance of a wind-roughened sea, as Cox and Munk measured it from sun glitter
 * photographs in 1954: 0.003 + 0.00512 U, for a clean sea. The cascades resolve most of this; the
 * water shader adds whatever is left as roughness, which is what keeps a distant sea a soft sheen
 * instead of a field of crawling white dots.
 */
export const coxMunkSlopeVariance = (u10) => 0.003 + 0.00512 * Math.max(u10, 0);

/** How much of the sea is whitecapping, from the wind: nothing under about 6 m/s, a lot by 18. */
export function whitecapCoverage(u10) {
  if (u10 <= 5.5) return 0;
  // Monahan's power law, tamed: coverage goes as roughly the cube of the friction velocity.
  return Math.min(0.0003 * Math.pow(u10 - 5.5, 2.6), 0.42);
}

// ---------------------------------------------------------------------------------------------
// The cascades
// ---------------------------------------------------------------------------------------------

/**
 * The three patches the sea is built from. Each carries only the band of wavenumbers it can
 * resolve without aliasing, so they never beat against each other:
 *
 * 2048 m: the swell and the big wind waves, 16 m and longer.
 * 256 m: the chop, 2 m to 16 m.
 * 32 m: the ripple and the cat's paws, 25 cm to 2 m. Anything finer is roughness, not geometry.
 *
 * The sizes are powers of two on purpose. The scene runs for days and the boat covers hundreds of
 * kilometres, which would eventually eat the precision of a 32-bit world position; the render
 * origin therefore jumps in 2048 m steps, and because every patch size divides that, the sea's
 * pattern is bit-for-bit unchanged across the jump. Picking sizes with no common factor (the usual
 * advice, to stop the three patterns repeating together) would buy nothing here anyway: what
 * repeats visibly is the largest patch on its own, and 2048 m is four repeats to the horizon.
 */
export const CASCADES = [
  { size: 2048, kLow: 0, kHigh: 0.39 },
  { size: 256, kLow: 0.39, kHigh: 3.14 },
  { size: 32, kLow: 3.14, kHigh: 1e9 },
];
/** The step the render origin moves in. Every cascade size divides it. */
export const ORIGIN_STEP = 2048;
export const FFT_N = 256;

/**
 * Builds the complex amplitudes h0(k) for one cascade as a flat RGBA array for a texture:
 * (h0.re, h0.im, conj(h0(-k)).re, conj(h0(-k)).im) per texel.
 *
 * @param {object} cascade one of CASCADES
 * @param {number} n       grid size (FFT_N)
 * @param {object} wind    { u10, fetch, dirRad }
 * @param {object} swell   { height, dirRad, periodS, spread } a long train from elsewhere
 * @param {() => number} normal a standard normal generator (seeded)
 * @returns {{ data: Float32Array, variance: number, meanSquareSlope: number }}
 */
export function buildCascade(cascade, n, wind, swell, normal) {
  const data = new Float32Array(n * n * 4);
  const L = cascade.size;
  const dk = (2 * Math.PI) / L;
  const wp = peakOmega(wind.u10, wind.fetch);
  const swellOmega = swell.periodS > 0 ? (2 * Math.PI) / swell.periodS : 0;
  // The swell's variance, spread over a narrow band of wavenumbers round its own peak.
  const swellVar = (swell.height / 4) ** 2;
  let variance = 0;
  let mss = 0;

  // Every k must be decided before any texel is written, so that k and -k agree: the surface is
  // real only if h0(-k) is the conjugate partner of h0(k). Drawing both from one pass over the grid
  // and pairing them by index is what guarantees it.
  const re = new Float32Array(n * n), im = new Float32Array(n * n);
  const amp = new Float32Array(n * n);

  for (let z = 0; z < n; z++) {
    // Indices run -n/2 .. n/2-1 so that k = 0 sits at texel (0, 0) after the usual wrap.
    const mz = z < n / 2 ? z : z - n;
    for (let x = 0; x < n; x++) {
      const mx = x < n / 2 ? x : x - n;
      const i = z * n + x;
      const kx = mx * dk, kz = mz * dk;
      const k = Math.hypot(kx, kz);
      re[i] = normal();
      im[i] = normal();
      // The Nyquist row and column are their own conjugate partners, which makes them a special
      // case in every sum over the grid. They carry the least energy of anything here, so they are
      // simply left empty and every k then has a distinct partner.
      if (x === n / 2 || z === n / 2) { amp[i] = 0; continue; }
      if (k < 1e-6 || k < cascade.kLow || k >= cascade.kHigh) { amp[i] = 0; continue; }
      const omega = dispersion(k);
      const theta = Math.atan2(kz, kx);
      // The wind sea.
      const s = spreadExponent(omega, wp, wind.u10);
      const dirW = spreadWeight(theta, wind.dirRad, s);
      const dOmegaDk = (G_ACCEL * (1 + 3 * (k / K_CAPILLARY) ** 2)) / (2 * omega);
      let psi = (jonswap(omega, wind.u10, wind.fetch) * dirW * dOmegaDk) / k;
      // The swell: a narrow Gaussian in frequency about its own period, from its own quarter.
      if (swellOmega > 0 && swell.height > 0) {
        const bw = swellOmega * 0.085;
        const gauss = Math.exp(-((omega - swellOmega) ** 2) / (2 * bw * bw));
        const dirS = spreadWeight(theta, swell.dirRad, swell.spread ?? 24);
        psi += (swellVar * gauss * dirS * dOmegaDk) / (k * bw * Math.sqrt(2 * Math.PI)) * 0.5;
      }
      if (!(psi > 0) || !Number.isFinite(psi)) { amp[i] = 0; continue; }
      amp[i] = 0.5 * Math.sqrt(psi * dk * dk);
    }
  }

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      // The partner texel is -k, i.e. the index negated modulo n.
      const j = ((n - z) % n) * n + ((n - x) % n);
      const o = i * 4;
      data[o] = amp[i] * re[i];
      data[o + 1] = amp[i] * im[i];
      // conj(h0(-k)): the same draw as the partner, with the imaginary part negated.
      data[o + 2] = amp[j] * re[j];
      data[o + 3] = -amp[j] * im[j];
      // The surface variance is the sum over every k of 2|h0(k)|^2, measured from what was really
      // drawn rather than from what the spectrum expected: with a narrow spectrum in a light wind
      // only a few cells carry anything, and the sampling error between the two is several per
      // cent. Scaling by the realised number is what makes the stated wave height true.
      const p2 = data[o] * data[o] + data[o + 1] * data[o + 1];
      const mx2 = x < n / 2 ? x : x - n;
      const mz2 = z < n / 2 ? z : z - n;
      const k2 = (mx2 * mx2 + mz2 * mz2) * dk * dk;
      variance += 2 * p2;
      mss += 2 * p2 * k2;
    }
  }
  return { data, variance, meanSquareSlope: mss };
}

/**
 * Builds all three cascades and scales them together so the surface really has the significant
 * height the wind implies. Returns the per-cascade texture data and the numbers the rest of the
 * scene needs: the variance (for the boat) and the mean square slope (for the sun's glitter).
 */
export function buildSea(wind, swell, normal, n = FFT_N, cascades = CASCADES) {
  const built = cascades.map((c) => buildCascade(c, n, wind, swell, normal));
  const totalVariance = built.reduce((s, b) => s + b.variance, 0);
  const wantHs = Math.hypot(significantHeight(wind.u10, wind.fetch), swell.height);
  const wantVariance = (wantHs / 4) ** 2;
  const scale = totalVariance > 1e-12 ? Math.sqrt(wantVariance / totalVariance) : 0;
  for (const b of built) {
    for (let i = 0; i < b.data.length; i++) b.data[i] *= scale;
    b.variance *= scale * scale;
    b.meanSquareSlope *= scale * scale;
  }
  return {
    cascades: built,
    hs: wantHs,
    variance: wantVariance,
    meanSquareSlope: built.reduce((s, b) => s + b.meanSquareSlope, 0),
  };
}

/**
 * The long waves that actually move a 22 m boat, pulled out of the same realisation the GPU draws,
 * so the hull rides the waves you can *see* rather than a second sea of its own.
 *
 * The surface is the sum over every k of [ h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t} ] e^{i k.r}.
 * Pairing k with -k turns that into two real travelling waves per pair, one running each way along
 * the k axis:
 *
 *     2 |h0(k)|      cos( k.r + w t + arg h0(k) )          going against k
 *     2 |h0(-k)|     cos( k.r - w t + arg conj(h0(-k)) )   going with k
 *
 * Both are returned, with `dir` the sign of w in the phase, so a caller only has to evaluate
 * amp * cos(kx*x + kz*z + dir*w*t + phase). Taking only the half plane counts each pair once.
 *
 * @param {Float32Array} cascadeData the (h0.re, h0.im, conj(h0(-k)).re, .im) texels
 * @param {number} size   the cascade's patch size in metres
 * @param {number} n      the grid size
 * @param {number} minWavelength  shorter waves than this cannot move a 22 m hull
 * @param {number} maxCount       the strongest this many are kept
 */
export function longWaveComponents(cascadeData, size, n, minWavelength = 14, maxCount = 220, keepVariance = 0.92) {
  const dk = (2 * Math.PI) / size;
  const kMax = (2 * Math.PI) / minWavelength;
  const out = [];
  for (let z = 0; z < n; z++) {
    const mz = z < n / 2 ? z : z - n;
    for (let x = 0; x < n; x++) {
      const mx = x < n / 2 ? x : x - n;
      // Only the half plane: the other half is the same waves counted a second time.
      if (mx < 0 || (mx === 0 && mz <= 0)) continue;
      const kx = mx * dk, kz = mz * dk;
      const k = Math.hypot(kx, kz);
      if (k < 1e-6 || k > kMax) continue;
      const o = (z * n + x) * 4;
      const omega = dispersion(k);
      const ar = cascadeData[o], ai = cascadeData[o + 1];
      const br = cascadeData[o + 2], bi = cascadeData[o + 3];
      const ampA = 2 * Math.hypot(ar, ai);
      if (ampA > 1e-5) out.push({ kx, kz, k, omega, amp: ampA, phase: Math.atan2(ai, ar), dir: 1 });
      const ampB = 2 * Math.hypot(br, bi);
      if (ampB > 1e-5) out.push({ kx, kz, k, omega, amp: ampB, phase: Math.atan2(bi, br), dir: -1 });
    }
  }
  out.sort((a, b) => b.amp - a.amp);
  // Keep the strongest until they carry `keepVariance` of the band's energy. A flat cap would
  // throw away most of a storm (a gale's energy is spread over hundreds of components) and leave
  // the hull riding a smaller sea than the one on the screen.
  const total = out.reduce((s2, w) => s2 + w.amp * w.amp, 0);
  let kept = 0;
  for (let i = 0; i < out.length; i++) {
    kept += out[i].amp * out[i].amp;
    if (kept >= total * keepVariance || i + 1 >= maxCount) return out.slice(0, i + 1);
  }
  return out;
}
