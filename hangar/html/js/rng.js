// Hangar — Seeded random streams (mulberry32). Pure: no three.js.

function hashString(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** A deterministic stream. `fork(label)` derives an independent stream from the original seed and the label,
 *  so props, lamps and the tour never shift each other, whatever has been drawn from the parent. */
export function makeRng(seed) {
  const origin = (Number(seed) >>> 0);
  let a = origin;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    fork: (label) => makeRng((origin ^ hashString(String(label))) >>> 0),
  };
}
