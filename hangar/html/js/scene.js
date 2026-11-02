// Hangar — Scene stub: clears to near-black and draws one lit cube. Later tasks replace the body, keeping the contract
// app.js relies on: constructor(app, renderer, w, h, settings, seed), step, click, render, resize, dispose.

import * as THREE from 'three';

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
    this.scene.background = new THREE.Color(0x05070a);
    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 200);
    this.camera.position.set(0, 1.7, 3);
    this.camera.lookAt(0, 1.2, 0);
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.6 }));
    this.cube.position.set(0, 1.2, 0);
    this.scene.add(this.cube);
    this.scene.add(new THREE.HemisphereLight(0x405060, 0x101010, 0.6));
    const key = new THREE.DirectionalLight(0xfff0dd, 2.5);
    key.position.set(2, 4, 3);
    this.scene.add(key);
  }

  step(dt) {
    this.time += dt;
    this.cube.rotation.y += dt * 0.4;
  }

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
