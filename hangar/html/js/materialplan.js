// Hangar — Material plan: which scanned material each sector's floor, walls and ceiling wear. Pure: no three.js.
//
// The level tags each sector with a material family (mat:concrete, mat:steel, ...). A family has several
// scanned variants (cracked, stained or painted concrete; plate or brushed steel), so per seed each *room*
// picks one variant for its floor, one for its walls and one for its ceiling. A room here is a connected run
// of sectors of the same family (a flight of tunnel steps is one room), so a room is never a patchwork,
// while the next room along may differ. Variant names are manifest tags without the `mat:` prefix.

// [variant, weight] lists per family and surface. Families not listed wear their own tag everywhere.
// Grate risers and ceilings are steel (a grating texture standing on edge reads as a mistake).
export const VARIANTS = {
  concrete: {
    floor: [['concrete', 0.35], ['concrete-cracked', 0.35], ['concrete-stained', 0.3]],
    wall: [['concrete-painted', 0.4], ['concrete-stained', 0.35], ['concrete', 0.25]],
    ceil: [['concrete-stained', 0.5], ['concrete-painted', 0.5]],
  },
  steel: {
    floor: [['steel', 1]],
    wall: [['steel', 0.7], ['steel-brushed', 0.3]],
    ceil: [['steel', 1]],
  },
  'panel-brown': {
    floor: [['panel-brown', 0.5], ['concrete-stained', 0.25], ['concrete', 0.25]],
    wall: [['panel-brown', 1]],
    ceil: [['panel-brown', 0.5], ['concrete-painted', 0.5]],
  },
  grate: { floor: [['grate', 1]], wall: [['steel', 1]], ceil: [['steel', 1]] },
  computer: { floor: [['computer', 1]], wall: [['computer', 1]], ceil: [['steel', 1]] },
};
// Door frames lean to brushed steel: jambs are the polished, handled metal of a base.
const DOOR_WALL = [['steel-brushed', 0.6], ['steel', 0.4]];

export const familyOf = (sector) => {
  const t = [...sector.tags].find((x) => x.startsWith('mat:'));
  if (!t) throw new Error(`materialplan: sector "${sector.id}" has no mat: tag`);
  return t.slice(4);
};

/** Connected runs of same-family sectors that share an edge. Returns Map<sectorId, roomIndex>. */
export function sectorRooms(level) {
  const sectors = level.sectors;
  const parent = sectors.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const pt = ([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`;
  const edgeOwner = new Map();
  sectors.forEach((s, i) => s.poly.forEach((a, k) => edgeOwner.set(`${pt(a)}>${pt(s.poly[(k + 1) % s.poly.length])}`, i)));
  sectors.forEach((s, i) => s.poly.forEach((a, k) => {
    const j = edgeOwner.get(`${pt(s.poly[(k + 1) % s.poly.length])}>${pt(a)}`);
    if (j === undefined || familyOf(sectors[j]) !== familyOf(s)) return;
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  }));
  return new Map(sectors.map((s, i) => [s.id, find(i)]));
}

function weighted(list, rng) {
  const total = list.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [v, w] of list) { if ((r -= w) < 0) return v; }
  return list[list.length - 1][0];
}

/**
 * Map<sectorId, { floor, wall, ceil }> of variant names. Deterministic for a given rng; rooms draw in
 * sector order, three draws each, so adding a family later does not reshuffle the others' rooms.
 */
export function planMaterials(level, rng) {
  const rooms = sectorRooms(level);
  const byRoom = new Map();
  const plan = new Map();
  for (const s of level.sectors) {
    const fam = familyOf(s), room = rooms.get(s.id);
    if (!byRoom.has(room)) {
      const v = VARIANTS[fam];
      const draw = (list) => weighted(list, rng);
      const own = [[fam, 1]];
      byRoom.set(room, { floor: draw(v?.floor ?? own), wall: draw(v?.wall ?? own), ceil: draw(v?.ceil ?? own), doorWall: draw(fam === 'steel' ? DOOR_WALL : own) });
    }
    const r = byRoom.get(room);
    plan.set(s.id, { floor: r.floor, wall: s.tags.has('door') ? r.doorWall : r.wall, ceil: r.ceil });
  }
  return plan;
}
