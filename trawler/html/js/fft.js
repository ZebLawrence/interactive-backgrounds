// Trawler — The inverse Fourier transform the sea is drawn with, as a lookup table plus a butterfly
// step, written here in JavaScript so that `node --test` can prove it against a direct transform.
// ocean.js runs exactly these passes on the GPU; the GLSL is a line-for-line copy of `butterflyPass`
// below, and `oceanIfftReference` is what the test compares the whole thing against.
//
// The convention matters and is easy to get wrong, so it is written down here:
//
//   f[m, q] = sum over (p, r) of F[p, r] * exp( +2i*pi*(p*m + r*q) / N )
//
// No 1/N anywhere, a plus sign in the exponent, and the spectrum stored in the usual wrapped order
// (k = 0 at texel 0, negative wavenumbers in the upper half). That makes texel (m, q) the surface
// at world (m*L/N, q*L/N) with no shifting and no (-1)^(m+q) dance, and it is the same convention
// oceanspec.longWaveComponents assumes, which is why the boat and the picture agree.
//
// The transform is decimation in time: the input is read in bit-reversed order at the first stage
// (the table carries the reversed indices), and the output comes out in natural order.

export const log2i = (n) => Math.round(Math.log2(n));

/** Reverses the low `bits` bits of `i`. */
export function bitReverse(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  return r >>> 0;
}

/**
 * The butterfly table as RGBA rows: `stages` wide, `n` tall, texel (stage, i) holding
 * (twiddle.re, twiddle.im, topIndex, bottomIndex). The GPU reads it with texelFetch, so the values
 * are exact; nothing here is ever filtered.
 */
export function butterflyData(n) {
  const stages = log2i(n);
  const out = new Float32Array(stages * n * 4);
  for (let s = 0; s < stages; s++) {
    const span = 1 << s;
    for (let i = 0; i < n; i++) {
      // The twiddle for this index at this stage. Both wings of a butterfly use the same one:
      // the lower wing's "u - w*t" is "u + (-w)*t", and -W^a is W^(a + N/2), which for the lower
      // wing works out to exactly the same W^(j*N/m) as the upper wing's. Conjugating it for the
      // lower wing (an easy mistake, and one a symmetric test field hides) breaks the transform.
      const m = 1 << (s + 1);
      const j = i % m;
      const k = (j * n) / m;
      const angle = (2 * Math.PI * k) / n; // plus: this is the inverse transform
      const topWing = j < span;
      let top, bottom;
      if (s === 0) {
        // The first stage reads the input in bit-reversed order.
        const bits = stages;
        top = topWing ? bitReverse(i, bits) : bitReverse(i - 1, bits);
        bottom = topWing ? bitReverse(i + 1, bits) : bitReverse(i, bits);
      } else {
        top = topWing ? i : i - span;
        bottom = topWing ? i + span : i;
      }
      const o = (i * stages + s) * 4;
      out[o] = Math.cos(angle);
      out[o + 1] = Math.sin(angle);
      out[o + 2] = top;
      out[o + 3] = bottom;
    }
  }
  return out;
}

const cmulRe = (ar, ai, br, bi) => ar * br - ai * bi;
const cmulIm = (ar, ai, br, bi) => ar * bi + ai * br;

/**
 * One butterfly pass over a complex field, exactly as the fragment shader does it. `dir` 0 works
 * along x (within a row), 1 along y (within a column). `src`/`dst` are interleaved re, im arrays of
 * n*n complex values, row-major with x fastest.
 */
export function butterflyPass(src, dst, n, table, stage, dir) {
  const stages = log2i(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const idx = dir === 0 ? x : y;
      const t = (idx * stages + stage) * 4;
      const wr = table[t], wi = table[t + 1];
      const top = table[t + 2] | 0, bot = table[t + 3] | 0;
      const ti = dir === 0 ? (y * n + top) * 2 : (top * n + x) * 2;
      const bi = dir === 0 ? (y * n + bot) * 2 : (bot * n + x) * 2;
      const o = (y * n + x) * 2;
      dst[o] = src[ti] + cmulRe(wr, wi, src[bi], src[bi + 1]);
      dst[o + 1] = src[ti + 1] + cmulIm(wr, wi, src[bi], src[bi + 1]);
    }
  }
}

/**
 * The whole two-dimensional inverse transform: every stage along x, then every stage along y.
 * `field` is interleaved re, im; the result is returned as a new array in the same layout.
 */
export function ifft2(field, n, table = butterflyData(n)) {
  const stages = log2i(n);
  let a = Float32Array.from(field);
  let b = new Float32Array(field.length);
  for (let s = 0; s < stages; s++) { butterflyPass(a, b, n, table, s, 0); [a, b] = [b, a]; }
  for (let s = 0; s < stages; s++) { butterflyPass(a, b, n, table, s, 1); [a, b] = [b, a]; }
  return a;
}

/** A direct (slow) inverse transform, for the test to check the butterfly against. */
export function directIfft2(field, n) {
  const out = new Float64Array(n * n * 2);
  for (let q = 0; q < n; q++) {
    for (let m = 0; m < n; m++) {
      let re = 0, im = 0;
      for (let r = 0; r < n; r++) {
        for (let p = 0; p < n; p++) {
          const i = (r * n + p) * 2;
          const ang = (2 * Math.PI * (p * m + r * q)) / n;
          const c = Math.cos(ang), s = Math.sin(ang);
          re += field[i] * c - field[i + 1] * s;
          im += field[i] * s + field[i + 1] * c;
        }
      }
      const o = (q * n + m) * 2;
      out[o] = re;
      out[o + 1] = im;
    }
  }
  return out;
}
