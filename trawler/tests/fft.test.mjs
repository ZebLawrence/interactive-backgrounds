// The transform is the one place in this project where a sign error produces something that still
// looks like a sea but is wrong in a way nobody would ever spot by eye: the waves would travel the
// wrong way, or the boat would ride a different surface from the one on screen. So it is checked
// against a direct transform, term by term.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitReverse, butterflyData, ifft2, directIfft2, log2i } from '../html/js/fft.js';

test('bit reversal', () => {
  assert.equal(bitReverse(0b0001, 4), 0b1000);
  assert.equal(bitReverse(0b1011, 4), 0b1101);
  assert.equal(bitReverse(0, 8), 0);
  assert.equal(bitReverse(255, 8), 255);
  for (let b = 1; b <= 10; b++) {
    for (let i = 0; i < (1 << b); i++) assert.equal(bitReverse(bitReverse(i, b), b), i);
  }
});

test('the butterfly table is the right shape', () => {
  const n = 16, stages = log2i(n);
  const t = butterflyData(n);
  assert.equal(t.length, stages * n * 4);
  for (let s = 0; s < stages; s++) {
    for (let i = 0; i < n; i++) {
      const o = (i * stages + s) * 4;
      assert.ok(Math.abs(Math.hypot(t[o], t[o + 1]) - 1) < 1e-6, 'twiddles are on the unit circle');
      for (const k of [2, 3]) {
        assert.ok(Number.isInteger(t[o + k]) && t[o + k] >= 0 && t[o + k] < n, 'indices are in range');
      }
    }
  }
});

test('the butterfly transform equals a direct one', () => {
  for (const n of [4, 8, 16]) {
    // A field with no symmetry at all, so nothing can cancel a mistake.
    const f = new Float32Array(n * n * 2);
    let seed = 1;
    const r = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < f.length; i++) f[i] = r();
    const fast = ifft2(f, n);
    const slow = directIfft2(f, n);
    let worst = 0;
    for (let i = 0; i < fast.length; i++) worst = Math.max(worst, Math.abs(fast[i] - slow[i]));
    assert.ok(worst < 1e-3, `n = ${n}: worst difference ${worst}`);
  }
});

test('the transform uses the plus sign the ocean assumes', () => {
  // One unit of amplitude at wavenumber index (1, 0) must come out as cos(2*pi*m/N) across x, with
  // no shift and no scaling. A minus sign in the exponent would be invisible here (cos is even),
  // so an asymmetric spectrum is used instead: an imaginary amplitude gives -sin, not +sin, if the
  // sign is wrong.
  const n = 8;
  const f = new Float32Array(n * n * 2);
  f[(0 * n + 1) * 2 + 1] = 1; // F[p=1, r=0] = i
  const out = ifft2(f, n);
  for (let m = 0; m < n; m++) {
    const o = (0 * n + m) * 2;
    const want = -Math.sin((2 * Math.PI * m) / n); // real part of i * e^{+i 2 pi m / N}
    assert.ok(Math.abs(out[o] - want) < 1e-5, `x = ${m}: ${out[o]} vs ${want}`);
  }
});

test('a conjugate-symmetric spectrum transforms to a real field', () => {
  // This is the property the whole ocean leans on: build the amplitudes in conjugate pairs and the
  // "height" really is a height, with no imaginary part to throw away.
  const n = 16;
  const f = new Float32Array(n * n * 2);
  let seed = 7;
  const r = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      if (x === n / 2 || z === n / 2) continue; // the self-paired lines, left empty as the sea does
      const i = (z * n + x) * 2;
      const j = (((n - z) % n) * n + ((n - x) % n)) * 2;
      if (f[i] !== 0 || f[i + 1] !== 0) continue;
      const re = r(), im = r();
      // k = 0 is its own partner, so it has to be real on its own account.
      if (j === i) { f[i] = re; f[i + 1] = 0; continue; }
      f[i] = re; f[i + 1] = im;
      f[j] = re; f[j + 1] = -im;
    }
  }
  const out = ifft2(f, n);
  let worst = 0;
  for (let i = 1; i < out.length; i += 2) worst = Math.max(worst, Math.abs(out[i]));
  assert.ok(worst < 1e-4, `largest imaginary part left over: ${worst}`);
});
