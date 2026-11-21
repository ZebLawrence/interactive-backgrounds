// Diorama — the box. This is the proof of concept's "skin": the plainest thing that shows the effect.
//
// A skin is whatever lives behind the window. The shell (app.js) owns the renderer, the eye and the window
// projection, and asks a skin for only this:
//
//   new Skin(scene, renderer, { width, height })   build into `scene`; the window is `width` x `height`
//                                                  metres in the plane z = 0, centred on the origin, and the
//                                                  world is in metres, at real size, behind it (-z)
//   skin.step(dt, time)                            advance by dt seconds
//   skin.dispose()                                 take everything back out (the window was resized)
//
// Everything here is sized from the window, so the box's open face is exactly the screen: its four walls
// leave from the four edges of the glass, which is what makes the screen read as an opening and not a picture.
//
// What is in it is chosen to give the eye depth to measure: a ruled grid on every wall (its lines converge
// and slide against each other as the head moves), things hung at different depths that pass in front of one
// another, shadows that pin each thing to a wall, and one ball on a rod that comes out of the screen.

import * as THREE from 'three';

const PALETTE = [0xe4572e, 0xf2a541, 0x4c9f70, 0x3d7ea6, 0x8e6bbf, 0xe8e4dc];

/** One cell of the wall ruling: a pale tile with a darker line round its edge. Tiled, mipmapped. */
function gridTexture(renderer) {
  const n = 256, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#c9ced2'; g.fillRect(0, 0, n, n);
  g.strokeStyle = '#59646d'; g.lineWidth = 5; g.strokeRect(0, 0, n, n); // half of it falls on each neighbour
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

export class Room {
  constructor(scene, renderer, { width, height }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.disposables = [];
    this.swingers = [];
    const W = width, H = height, D = Math.max(width, height) * 0.85;
    this.depth = D;
    const cell = H / 8;

    // --- The five walls ---
    const base = gridTexture(renderer);
    this.disposables.push(base);
    const wall = (w, h, pos, rot) => {
      const map = base.clone();
      map.repeat.set(Math.max(1, Math.round(w / cell)), Math.max(1, Math.round(h / cell)));
      map.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0 });
      const geo = new THREE.PlaneGeometry(w, h);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos); m.rotation.set(...rot);
      m.receiveShadow = true;
      this.group.add(m);
      this.disposables.push(map, mat, geo);
    };
    const q = Math.PI / 2;
    wall(W, H, [0, 0, -D], [0, 0, 0]);               // back
    wall(W, D, [0, -H / 2, -D / 2], [-q, 0, 0]);     // floor
    wall(W, D, [0, H / 2, -D / 2], [q, 0, 0]);       // ceiling
    wall(D, H, [-W / 2, 0, -D / 2], [0, q, 0]);      // left
    wall(D, H, [W / 2, 0, -D / 2], [0, -q, 0]);      // right

    // --- Light: one lamp inside the box, up near the front, so everything throws a shadow back and down ---
    const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x9a958a, 1.9);
    const lamp = new THREE.PointLight(0xfff1dc, 3.0 * H * H, 0, 2);
    lamp.position.set(-W * 0.12, H * 0.2, -D * 0.2);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(1024, 1024);
    lamp.shadow.camera.near = H * 0.02;
    lamp.shadow.camera.far = (W + H + D) * 1.2;
    lamp.shadow.bias = -0.003;
    lamp.shadow.radius = 4;
    this.group.add(hemi, lamp);

    // --- The things in it ---
    const mat = (i, rough = 0.45) => {
      const m = new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], roughness: rough, metalness: 0.05 });
      this.disposables.push(m);
      return m;
    };
    const threadMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.8 });
    this.disposables.push(threadMat);
    const add = (geo, material, parent = this.group) => {
      const m = new THREE.Mesh(geo, material);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
      this.disposables.push(geo);
      return m;
    };
    const s = H; // every size below is a fraction of the window's height

    // Hung from the ceiling on threads, at depths from just behind the glass to nearly the back wall.
    const shapes = [
      () => new THREE.SphereGeometry(0.055 * s, 48, 32),
      () => new THREE.BoxGeometry(0.09 * s, 0.09 * s, 0.09 * s),
      () => new THREE.OctahedronGeometry(0.07 * s),
      () => new THREE.TorusGeometry(0.05 * s, 0.02 * s, 24, 64),
      () => new THREE.IcosahedronGeometry(0.06 * s),
      () => new THREE.ConeGeometry(0.05 * s, 0.11 * s, 40),
    ];
    //            x (of W)  drop (of H)  z (of D)
    const hung = [[-0.34, 0.30, -0.14], [0.30, 0.52, -0.26], [-0.12, 0.62, -0.44], [0.38, 0.28, -0.58],
      [-0.30, 0.48, -0.72], [0.08, 0.34, -0.86]];
    hung.forEach(([x, drop, z], i) => {
      const pivot = new THREE.Group();
      pivot.position.set(x * W, H / 2, z * D);
      this.group.add(pivot);
      const len = drop * H;
      const thread = add(new THREE.CylinderGeometry(0.0022 * s, 0.0022 * s, len, 6), threadMat, pivot);
      thread.position.y = -len / 2;
      const body = add(shapes[i % shapes.length](), mat(i), pivot);
      body.position.y = -len;
      // A real pendulum of this length swings in 2 pi sqrt(L / g) seconds; a few degrees of it is plenty.
      const period = 2 * Math.PI * Math.sqrt(len / 9.81);
      this.swingers.push({ pivot, body, period: period * 3, amp: 0.035 + 0.02 * ((i * 7) % 3), phase: i * 1.7, spin: 0.12 + 0.05 * (i % 3) });
    });

    // Standing on the floor: blocks at three depths, one stack, so the floor has things on it.
    const block = (x, z, w, h, d, i, yaw = 0, y0 = 0) => {
      const b = add(new THREE.BoxGeometry(w * s, h * s, d * s), mat(i, 0.7));
      b.position.set(x * W, -H / 2 + y0 * s + h * s / 2, z * D);
      b.rotation.y = yaw;
      return b;
    };
    block(-0.24, -0.30, 0.16, 0.10, 0.16, 3, 0.3);
    block(-0.24, -0.30, 0.10, 0.08, 0.10, 0, -0.4, 0.10);
    block(0.20, -0.52, 0.12, 0.22, 0.12, 4, 0.7);
    block(-0.02, -0.78, 0.26, 0.07, 0.14, 1, -0.15);
    const ball = add(new THREE.SphereGeometry(0.06 * s, 48, 32), mat(5, 0.3));
    ball.position.set(0.34 * W, -H / 2 + 0.06 * s, -0.22 * D);

    // A ball on a rod from the back wall that ends in FRONT of the glass: the one thing that leaves the box.
    const out = 0.22 * H; // how far it stands out of the screen
    const rodLen = D + out - 0.04 * s;
    const rod = add(new THREE.CylinderGeometry(0.006 * s, 0.006 * s, rodLen, 12), threadMat);
    rod.rotation.x = q;
    rod.position.set(0.10 * W, -0.06 * H, -D + rodLen / 2);
    const tip = add(new THREE.SphereGeometry(0.04 * s, 48, 32), mat(0, 0.35));
    tip.position.set(0.10 * W, -0.06 * H, out);

    scene.add(this.group);
  }

  step(dt, time) {
    for (const o of this.swingers) {
      const w = 2 * Math.PI / o.period;
      o.pivot.rotation.z = o.amp * Math.sin(time * w + o.phase);
      o.pivot.rotation.x = o.amp * 0.6 * Math.sin(time * w * 0.83 + o.phase * 2.1);
      o.body.rotation.y = time * o.spin + o.phase;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isLight && o.shadow?.map) o.shadow.map.dispose(); });
    for (const d of this.disposables) d.dispose();
  }
}
