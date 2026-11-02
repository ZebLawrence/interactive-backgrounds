// Hangar — Level mesh: turns the pure Level into three.js meshes (floors, ceilings, wall quads).

import * as THREE from 'three';
import { wallQuads } from './level.js';

const TILE = 2;
const matOf = (s) => {
  const t = [...s.tags].find((x) => x.startsWith('mat:'));
  if (!t) throw new Error(`levelmesh: sector "${s.id}" has no mat: tag`);
  return t.slice(4);
};

function geometry(pos, uv, nrm) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Triangulate a sector polygon at height y, facing up (floor) or down (ceiling), UVs planar in world x/z. */
function flatGeometry(poly, y, up, tile) {
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos = [], uv = [], nrm = [];
  for (const t of tris) {
    let [a, b, c] = t.map((i) => poly[i]);
    const crossY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]); // +y when the triangle faces up
    if ((crossY > 0) !== up) [b, c] = [c, b];
    for (const [x, z] of [a, b, c]) {
      pos.push(x, y, z); uv.push(x / tile, z / tile); nrm.push(0, up ? 1 : -1, 0);
    }
  }
  return geometry(pos, uv, nrm);
}

function quadGeometry(quads) {
  const pos = [], uv = [], nrm = [], idx = [];
  quads.forEach((q, i) => {
    q.corners.forEach((c, k) => { pos.push(...c); uv.push(...q.uv[k]); nrm.push(...q.normal); });
    const o = i * 4;
    idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  });
  const g = geometry(pos, uv, nrm);
  g.setIndex(idx);
  return g;
}

/**
 * Build the level. `materials` maps a material name ('steel', 'concrete', ..., 'window') to a THREE.Material.
 * Window openings are two thin sill sectors, so each opening yields two window walls; only one pane (the first
 * per sill sector) is kept, the rest of the opening is left open.
 */
export function buildLevelMesh(level, materials, tile = TILE) {
  const group = new THREE.Group();
  const bySector = new Map();
  const colliders = [];
  const add = (sector, mat, geo, collider) => {
    const m = materials.get(mat);
    if (!m) throw new Error(`levelmesh: no material for "${mat}"`);
    const mesh = new THREE.Mesh(geo, m);
    mesh.userData.sector = sector; mesh.userData.mat = mat;
    group.add(mesh);
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(mesh);
    if (collider) colliders.push(mesh);
    return mesh;
  };

  for (const s of level.sectors) {
    const mat = matOf(s);
    add(s.id, mat, flatGeometry(s.poly, s.floor, true, tile), true);
    if (!s.tags.has('sky')) add(s.id, mat, flatGeometry(s.poly, s.ceil, false, tile), false);
  }

  const bySectorMat = new Map();
  const panes = new Set();
  for (const q of wallQuads(level, tile)) {
    if (q.kind === 'window') {
      if (panes.has(q.back)) continue; // one pane per opening
      panes.add(q.back);
    }
    const k = `${q.sector}|${q.mat}`;
    if (!bySectorMat.has(k)) bySectorMat.set(k, []);
    bySectorMat.get(k).push(q);
  }
  for (const [k, quads] of bySectorMat) {
    const [sector, mat] = k.split('|');
    add(sector, mat, quadGeometry(quads), mat !== 'window');
  }
  return { group, bySector, colliders };
}
