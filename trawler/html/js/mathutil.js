// Trawler — The pure half of the toolbox: maths, seeded randomness, noise and the shader clock.
//
// Nothing here imports three.js, which is the point: boat.js, oceanspec.js, seastate.js and nav.js
// all lean on it, and `node --test` can then float the boat and sail her about without a browser.
// util.js re-exports all of it alongside the parts that do need three.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = lerp;
export const sat = clamp01;

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Maps x from [a0, a1] onto [b0, b1], clamped. */
export const remap = (x, a0, a1, b0, b1) => b0 + (b1 - b0) * clamp((x - a0) / (a1 - a0 || 1e-9), 0, 1);

/** Critically damped approach of `x` toward `target` with time constant `tau` seconds. */
export const approach = (x, target, tau, dt) => target + (x - target) * Math.exp(-dt / Math.max(tau, 1e-4));

/** Shortest signed difference from angle `a` to angle `b`, in (-pi, pi]. */
export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Angle `a` eased toward `b` the short way round. */
export const approachAngle = (a, b, tau, dt) => a + angleDiff(a, b) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));


/** Knots to metres a second, and back. */
export const knots = (kn) => kn * 0.514444;
export const toKnots = (ms) => ms / 0.514444;

// ---------------------------------------------------------------------------------------------
// Seeded randomness. Every scene is rebuilt from one seed, and a reseed must change everything,
// so each part of the build takes a named fork rather than sharing one stream.
// ---------------------------------------------------------------------------------------------

/** mulberry32: small, fast, and good enough for scattering things. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, mixed with a seed: names a deterministic sub-stream. */
export function hashName(name, seed = 0) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this._n = mulberry32(this.seed);
  }
  /** A named child stream: the same name and seed always give the same numbers. */
  fork(name) { return new Rng(hashName(name, this.seed)); }
  next() { return this._n(); }
  range(lo, hi) { return lo + this._n() * (hi - lo); }
  int(lo, hi) { return lo + Math.floor(this._n() * (hi - lo + 1)); }
  coin(p = 0.5) { return this._n() < p; }
  pick(a) { return a[Math.floor(this._n() * a.length)]; }
  /** Roughly bell-shaped, in (-1, 1). */
  gauss() { return (this._n() + this._n() + this._n() - 1.5) / 1.5; }
  /** A proper normal deviate (Box–Muller), for noise processes. */
  normal() {
    let u = 0;
    while (u === 0) u = this._n();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * this._n());
  }
  /** Shuffles in place and returns the array. */
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this._n() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ---------------------------------------------------------------------------------------------
// Noise. The JS copies here are for scattering and for the CPU side of things the shader also
// does; anything the camera looks at closely is baked or drawn, not sampled per pixel.
// ---------------------------------------------------------------------------------------------

export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

export function fbm2(x, y, octaves = 4, gain = 0.5, lacunarity = 2.03) {
  let v = 0, amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    v += noise2(x * f + i * 17.3, y * f + i * 9.1) * amp;
    sum += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return v / sum;
}

/** 1D value noise in [0, 1], for slow drifting quantities (wind, weather, a gull's mind). */
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash2(i, 0), hash2(i + 1, 0), u);
}

export function fbm1(x, octaves = 4) {
  let v = 0, amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    v += noise1(x * f + i * 31.7) * amp;
    sum += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return v / sum;
}

// ---------------------------------------------------------------------------------------------
// The shader clock wraps hourly so float precision holds however long the page runs; every
// animation frequency is quantised to a whole number of cycles per wrap, so the wrap is invisible.
// ---------------------------------------------------------------------------------------------

export const TIME_WRAP = 3600;
export const QK = TIME_WRAP / TAU;
export const quantize = (w) => Math.round(w * QK) / QK;
export const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const quantizer = (name = 'q') => `float ${name}(float w) { return floor(w * ${glslFloat(QK)} + 0.5) / ${glslFloat(QK)}; }\n`;


// ---------------------------------------------------------------------------------------------
// A three-component vector with no dependencies. three.js reads x, y and z off anything, so one of
// these can be handed straight to Vector3.copy or Matrix4.compose.
// ---------------------------------------------------------------------------------------------

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  get length() { return Math.hypot(this.x, this.y, this.z); }
  get lengthXZ() { return Math.hypot(this.x, this.z); }
}

export const vec3 = (x = 0, y = 0, z = 0) => new Vec3(x, y, z);
