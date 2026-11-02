// Hangar — Scene: greybox of the traced level. Later tasks replace materials, lights and the camera path, keeping the contract
// app.js relies on: constructor(app, renderer, w, h, settings, seed), step, click, render, resize, dispose.

import * as THREE from 'three';
import { loadLevel } from './level.js';
import { buildLevelMesh } from './levelmesh.js';

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
    this.ready = fetch('./data/e1m1.json').then((r) => r.json()).then((json) => this.build(json));
  }

  build(json) {
    const level = (this.level = loadLevel(json));
    const mats = new Map();
    for (const [name, color] of Object.entries(GREYS)) mats.set(name, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.FrontSide }));
    mats.set('window', new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.18, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    this.mesh = buildLevelMesh(level, mats);
    this.scene.add(this.mesh.group);
    this.camera.position.set(level.start.x, 1.7, level.start.z);
    this.camera.rotation.set(0, level.start.yaw, 0);
  }

  step(dt) { this.time += dt; }

  click(pt) { void pt; }

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
