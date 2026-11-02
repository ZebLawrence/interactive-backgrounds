// Hangar — Level loader. Pure: no three.js.
//
// Input (`data/e1m1.json`) is in Doom units on the map plane: x east, y north, plus heights.
// Output is in metres in three.js axes: x east, y up, z south (so north is -z).
//
// Polygons come out counter-clockwise *seen from above* (looking down -y with north at the top
// of the screen), which is the same winding as CCW in the Doom (x, y) plane. `signedArea` is
// positive for that winding. A wall `{ a, b }` keeps the winding of its `front` sector's polygon,
// so `front`'s interior lies to the left of a→b seen from above, and the face looks into `front`.

const EYE = 56; // Doom units: a default look height above the floor (1.7 m at 0.03)

/** Signed area in m² of an [x, z] polygon; positive when CCW seen from above (north = -z). */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    s += x2 * z1 - x1 * z2; // x·(-z) cross product, i.e. the Doom-plane shoelace
  }
  return s / 2;
}

function doomArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function insidePoly(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** The sector whose polygon contains (x, z) in metres, or null. */
export function sectorAt(level, x, z) {
  for (const s of level.sectors) if (insidePoly(s.poly, x, z)) return s;
  return null;
}

/** Turn the Doom-unit JSON into metres, CCW polygons and a wall list. */
export function loadLevel(json) {
  const u = json.unit ?? 0.03;
  const P = ([x, y]) => [x * u, -y * u];

  // Polygons in Doom units, CCW, so edges can be matched on exact integer coordinates.
  const src = json.sectors.map((s) => {
    const poly = doomArea(s.poly) < 0 ? [...s.poly].reverse() : s.poly;
    return { s, poly };
  });

  const sectors = src.map(({ s, poly }) => ({
    id: s.id,
    poly: poly.map(P),
    floor: s.floor * u,
    ceil: s.ceil * u,
    tags: new Set(s.tags),
    light: s.light ?? 160,
  }));
  const byId = new Map(sectors.map((s) => [s.id, s]));

  // Edge a→b of sector i, keyed by its Doom coordinates.
  const key = (a, b) => `${a[0]},${a[1]}>${b[0]},${b[1]}`;
  const owner = new Map();
  src.forEach(({ poly }, i) => {
    poly.forEach((a, k) => owner.set(key(a, poly[(k + 1) % poly.length]), i));
  });

  const walls = [];
  src.forEach(({ poly }, i) => {
    const s = sectors[i];
    poly.forEach((da, k) => {
      const db = poly[(k + 1) % poly.length];
      const a = P(da), b = P(db);
      const j = owner.get(key(db, da));
      if (j === undefined) {
        walls.push({ a, b, front: s.id, back: null, bottom: s.floor, top: s.ceil, kind: 'solid' });
        return;
      }
      if (j < i) return; // each shared edge is handled once, from the lower index
      const t = sectors[j];
      // Orientation helpers: the edge as seen from s (a→b) or from t (b→a).
      const facing = (front, back) => (front === s ? { a, b } : { a: b, b: a });
      if (s.floor !== t.floor) {
        const [lo, hi] = s.floor < t.floor ? [s, t] : [t, s];
        walls.push({ ...facing(lo, hi), front: lo.id, back: hi.id, bottom: lo.floor, top: hi.floor, kind: 'lower' });
      }
      const bothSky = s.tags.has('sky') && t.tags.has('sky');
      if (s.ceil !== t.ceil && !bothSky) {
        const [hi, lo] = s.ceil > t.ceil ? [s, t] : [t, s];
        walls.push({ ...facing(hi, lo), front: hi.id, back: lo.id, bottom: lo.ceil, top: hi.ceil, kind: 'upper' });
      }
      if (s.tags.has('window') || t.tags.has('window')) {
        const bottom = Math.max(s.floor, t.floor), top = Math.min(s.ceil, t.ceil);
        if (top > bottom) {
          // Glass faces the room you look out of: the sector that is not the window sill.
          const [front, back] = s.tags.has('window') && !t.tags.has('window') ? [t, s] : [s, t];
          walls.push({ ...facing(front, back), front: front.id, back: back.id, bottom, top, kind: 'window' });
        }
      }
    });
  });

  const floorAt = (x, z, fallback) => {
    for (const s of sectors) if (insidePoly(s.poly, x, z)) return s.floor;
    return fallback;
  };

  const st = json.start;
  const start = { x: st.x * u, z: -st.y * u, yaw: ((st.angle - 90) * Math.PI) / 180 };

  const pois = (json.pois ?? []).map((p) => {
    const [x, z] = P([p.x, p.y]);
    const [lx, lz] = P([p.look[0], p.look[1]]);
    const ly = p.look[2] !== undefined ? p.look[2] * u : floorAt(lx, lz, floorAt(x, z, 0)) + EYE * u;
    return { id: p.id, kind: p.kind, x, z, look: [lx, ly, lz] };
  });

  const fixtures = (json.fixtures ?? []).map((f) => {
    const out = { kind: f.kind, x: f.x * u, y: f.z * u, z: -f.y * u };
    if (f.dir) {
      const [dx, dy, dz] = [f.dir[0], f.dir[2] ?? 0, -f.dir[1]];
      const n = Math.hypot(dx, dy, dz) || 1;
      out.dir = [dx / n, dy / n, dz / n];
    }
    if (f.len !== undefined) out.len = f.len * u;
    return out;
  });

  return {
    unit: u,
    sectors,
    byId,
    walls,
    doors: (json.doors ?? []).map((d) => ({ sector: d.sector, openCeil: d.openCeil * u })),
    lifts: (json.lifts ?? []).map((l) => ({ sector: l.sector, low: l.low * u, high: l.high * u })),
    start,
    pois,
    fixtures,
  };
}
