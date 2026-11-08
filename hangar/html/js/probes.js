// Hangar — Room probes: one cube capture per room, PMREM-filtered, as each surface's reflection.
//
// bakeProbes(level, scene, renderer, opts) -> Map<sectorId, THREE.Texture>. wetplan.planProbes places one
// probe per room at eye height (small rooms, such as sills, doors and single steps, share the nearest); each
// probe renders the scene into a 128 px half-float cube (the slime layer included, its mirror off) and PMREM
// filters it into a probe-owned target. Re-bakes reuse that target, so a texture handed out stays valid and
// materials never need touching again: queue() marks probes dirty (nearest to a point first) and update()
// bakes a few per frame, so a re-bake (Emergency Power settling, materials arriving) costs no stall.
// opts.before() / opts.after() run around every bake (the slime switches its mirror off).

import * as THREE from 'three';
import { planProbes } from './wetplan.js';
import { SLIME_LAYER } from './slime.js';
import { BAR_LAYER } from './grate.js';

export const PROBE_SIZE = 128;

class ProbeMap extends Map {
  constructor(level, scene, renderer, opts) {
    super();
    this.scene = scene;
    this.renderer = renderer;
    this.opts = opts;
    const { probes, bySector } = planProbes(level);
    this.probes = probes.map((p) => ({ ...p, target: null }));
    this.bySector = bySector;
    this.cube = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.camera = new THREE.CubeCamera(0.05, 120, this.cube);
    for (const c of this.camera.children) { c.layers.enable(SLIME_LAYER); c.layers.enable(BAR_LAYER); }
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.dirty = [];
    this.bakes = 0;
  }

  bake(i) {
    const p = this.probes[i];
    this.opts.before?.();
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.updateMatrixWorld(true);
    this.camera.update(this.renderer, this.scene);
    p.target = this.pmrem.fromCubemap(this.cube.texture, p.target);
    p.target.texture.name = `probe-${i}`;
    this.opts.after?.();
    this.bakes++;
  }

  bakeAll() {
    for (let i = 0; i < this.probes.length; i++) this.bake(i);
    for (const [sector, i] of this.bySector) this.set(sector, this.probes[i].target.texture);
    this.dirty.length = 0;
  }

  /** Mark every probe for re-baking, nearest to `near` ({ x, z }) first. */
  queue(near = null) {
    const order = this.probes.map((p, i) => [near ? Math.hypot(p.x - near.x, p.z - near.z) : i, i]).sort((a, b) => a[0] - b[0]);
    this.dirty = order.map(([, i]) => i);
  }

  /** Bakes up to `n` queued probes; returns how many are still waiting. */
  update(n = 1) {
    for (let k = 0; k < n && this.dirty.length; k++) this.bake(this.dirty.shift());
    return this.dirty.length;
  }

  /** The probe texture for a world point's sector, or null. */
  textureFor(sectorId) { return this.get(sectorId) ?? null; }

  dispose() {
    for (const p of this.probes) p.target?.dispose();
    this.cube.dispose();
    this.pmrem.dispose();
  }
}

/** Places and bakes every room probe now; the returned Map also re-bakes (see ProbeMap). */
export function bakeProbes(level, scene, renderer, opts = {}) {
  const map = new ProbeMap(level, scene, renderer, opts);
  map.bakeAll();
  return map;
}
