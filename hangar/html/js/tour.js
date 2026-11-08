// Hangar — Tour: picks the next point of interest. Pure: no three.js.
//
// Weighted random pick: never one of the last `memory` pois visited, nearer pois weighted higher
// (weight ∝ 1 / (1 + distance / 25 m)) and window / view pois weighted ×2, so the camera keeps
// returning to the big views without walking a visible loop.

const NEAR = 25; // metres: distance at which a poi's weight halves
const KIND = { window: 2, view: 2 };

/**
 * `next(from?)` returns the next poi. `from` is the poi the walker stands at (it then counts as
 * visited) or any `{ x, z }` point to measure distances from; by default the last pick.
 */
export function makeTour(pois, rng, { memory = 4 } = {}) {
  if (!pois.length) throw new Error('makeTour: no pois');
  const recent = []; // most recent last
  const keep = Math.min(memory, pois.length - 1);
  const visit = (p) => {
    if (recent[recent.length - 1] === p) return;
    const i = recent.indexOf(p);
    if (i >= 0) recent.splice(i, 1);
    recent.push(p);
    while (recent.length > keep) recent.shift();
  };
  const weights = new Float64Array(pois.length);

  return {
    next(from) {
      if (from && pois.includes(from)) visit(from);
      const at = from ?? recent[recent.length - 1] ?? null;
      let total = 0;
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        if (recent.includes(p)) { weights[i] = 0; continue; }
        const d = at ? Math.hypot(p.x - at.x, p.z - at.z) : 0;
        weights[i] = (KIND[p.kind] ?? 1) / (1 + d / NEAR);
        total += weights[i];
      }
      let r = rng.next() * total, pick = null;
      for (let i = 0; i < pois.length; i++) {
        if (weights[i] <= 0) continue;
        pick = pois[i];
        if ((r -= weights[i]) < 0) break;
      }
      visit(pick);
      return pick;
    },
    get recent() { return recent.slice(); },
  };
}
