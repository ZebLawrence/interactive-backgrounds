// Hangar — Haze plan: a top-down map of where the air may hold haze. Pure: no three.
//
// Height fog only belongs in the tall spaces (the zigzag hall, the computer room, the courtyard-facing halls);
// corridors and low rooms stay clear. The post pass marches the view ray through this map, so a corridor that
// looks into a tall hall sees the hall's haze and none of its own. Each cell holds the interior sector's
// "tallness" (0 below a 4 m ceiling, rising to 1 at 7 m) and its floor height (the haze thickens with height
// above it). Outside is vacuum: sky sectors (Phobos, the courtyards) are 0.

import { sectorAt } from './level.js';

export const HAZE = { cell: 0.5, lowCeil: 4, fullCeil: 7, margin: 2 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much haze a sector's air holds, 0..1. */
export function tallness(s) {
  if (!s || s.tags.has('sky')) return 0;
  return smoothstep(HAZE.lowCeil, HAZE.fullCeil, s.ceil - s.floor);
}

/**
 * The map: { w, h, minX, minZ, sizeX, sizeZ, data } with data a Float32Array of w*h (tallness, floor) pairs,
 * row z, column x, cell centres at minX + (i + 0.5) * cell.
 */
export function planHaze(level, cell = HAZE.cell) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const s of level.sectors) for (const [x, z] of s.poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  minX -= HAZE.margin; minZ -= HAZE.margin; maxX += HAZE.margin; maxZ += HAZE.margin;
  const w = Math.ceil((maxX - minX) / cell), h = Math.ceil((maxZ - minZ) / cell);
  const data = new Float32Array(w * h * 2);
  for (let j = 0; j < h; j++) {
    const z = minZ + (j + 0.5) * cell;
    for (let i = 0; i < w; i++) {
      const s = sectorAt(level, minX + (i + 0.5) * cell, z);
      const k = (j * w + i) * 2;
      data[k] = tallness(s);
      data[k + 1] = s ? s.floor : 0;
    }
  }
  return { w, h, minX, minZ, sizeX: w * cell, sizeZ: h * cell, data };
}
