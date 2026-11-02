// Hangar — Scene: greybox of the traced level. Later tasks replace materials, lights and the camera path, keeping the contract
// app.js relies on: constructor(app, renderer, w, h, settings, seed), step, click, render, resize, dispose.

import * as THREE from 'three';
import { loadLevel } from './level.js';
import { buildLevelMesh } from './levelmesh.js';
import { buildNavGraph } from './navgraph.js';
import { makeRng } from './rng.js';
import { makeTour } from './tour.js';
import { Walker, resolveClickTarget } from './walker.js';

// The cursor "comes to rest after moving": it travelled more than REST_MOVE px within the last
// second, then stayed within REST_STILL px for REST_HOLD s. A cursor that just sits does nothing.
const REST_MOVE = 30, REST_STILL = 4, REST_HOLD = 0.8;

const GREYS = { steel: 0x8d96a0, concrete: 0x777777, computer: 0x5d7a8a, 'panel-brown': 0x8a6a4e, grate: 0x4a4a4a, regolith: 0xa0907a };

export class Scene {
  constructor(app, renderer, w, h, settings, seed) {
    this.app = app;
    this.renderer = renderer;
    this.seed = seed;
    this.settings = settings;
    this.screenW = w;
    this.screenH = h;
    this.time = 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1018);
    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(new THREE.HemisphereLight(0xcfd8e4, 0x303038, 2.2));
    this.level = null;
    this.walker = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.pendingClick = null;
    this.trail = []; // recent pointer samples [t, x, y] over the last second
    this.rest = { x: 0, y: 0, t: 0, armed: false };
    this.input = { gaze: null, restedAt: null, click: null };
    this.ready = fetch('./data/e1m1.json').then((r) => {
      if (!r.ok) throw new Error(`level data ${r.url} returned HTTP ${r.status}`);
      return r.json();
    }).then((json) => this.build(json));
  }

  build(json) {
    const level = (this.level = loadLevel(json));
    const mats = new Map();
    for (const [name, color] of Object.entries(GREYS)) mats.set(name, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.FrontSide }));
    mats.set('window', new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.18, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    this.mesh = buildLevelMesh(level, mats);
    this.scene.add(this.mesh.group);
    this.graph = buildNavGraph(level);
    const rng = makeRng(this.seed);
    const tour = makeTour(level.pois, rng.fork('tour'));
    this.walker = new Walker(level, this.graph, tour, rng.fork('walker'));
    this.applyPose(this.walker.step(0, this.input));
  }

  applyPose(p) {
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, p.roll);
  }

  step(dt, pointer, settings) {
    void settings;
    this.time += dt;
    if (!this.walker) return;
    const inp = this.input;
    inp.gaze = null; inp.restedAt = null; inp.click = null;
    if (pointer?.inside && this.screenW > 0 && this.screenH > 0) {
      // Gaze: the cursor's direction from the screen centre, as angles relative to the view.
      const nx = (pointer.x / this.screenW) * 2 - 1, ny = (pointer.y / this.screenH) * 2 - 1;
      const tv = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      inp.gaze = { yaw: -Math.atan(nx * tv * this.camera.aspect), pitch: Math.atan(ny * tv) };
      if (this.cursorRested(pointer)) inp.restedAt = this.pick(pointer, true);
    } else {
      this.trail.length = 0;
      this.rest.armed = false;
    }
    if (this.pendingClick) {
      const hit = this.pick(this.pendingClick, false);
      this.pendingClick = null;
      const t = resolveClickTarget(this.level, this.graph, hit);
      if (t) inp.click = { x: t.x, y: hit.y, z: t.z };
    }
    this.applyPose(this.walker.step(dt, inp));
  }

  /** True once when the pointer has come to rest after a deliberate move. */
  cursorRested(pt) {
    const now = this.time, tr = this.trail, r = this.rest;
    tr.push([now, pt.x, pt.y]);
    while (tr.length && tr[0][0] < now - 1) tr.shift();
    let travel = 0;
    for (let i = 1; i < tr.length; i++) travel += Math.hypot(tr[i][1] - tr[i - 1][1], tr[i][2] - tr[i - 1][2]);
    if (travel > REST_MOVE) r.armed = true;
    if (Math.hypot(pt.x - r.x, pt.y - r.y) > REST_STILL) { r.x = pt.x; r.y = pt.y; r.t = now; return false; }
    if (r.armed && now - r.t >= REST_HOLD) { r.armed = false; return true; }
    return false;
  }

  /** World point under a screen point (CSS px, y up): the first collider hit, or (if `far`) a point 40 m out. */
  pick(pt, far) {
    if (!this.mesh) return null;
    this.ndc.set((pt.x / this.screenW) * 2 - 1, (pt.y / this.screenH) * 2 - 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.mesh.colliders, false)[0];
    if (hit) return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    if (!far) return null;
    const p = this.raycaster.ray.at(40, new THREE.Vector3());
    return { x: p.x, y: p.y, z: p.z };
  }

  click(pt) { this.pendingClick = { x: pt.x, y: pt.y }; }

  render() { this.renderer.render(this.scene, this.camera); }

  resize(w, h) {
    this.screenW = w;
    this.screenH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }
}
