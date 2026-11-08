// Trawler — The pilot house: the room the whole scene is seen from, and so the frame of every shot.
//
// Built in code rather than bought. There is no wheelhouse interior under a licence that can be
// fetched without an account (see the README), but more to the point the window openings, the
// mullion positions and the sight lines over the bow *are* the composition here: a model would
// have had to be rebuilt around them anyway.
//
// Body coordinates: +x starboard, +y up, +z aft, y = 0 at the waterline.
//
//   4.00  the wheelhouse sole, 4 m above the water
//   4.68  the console top
//   4.94  the dash top, which carries the sounder and the dials
//   4.98  the windscreen sill
//   5.52  the helmsman's eye
//   6.02  the windscreen head
//   6.14  the deckhead
//
// The composition, worked out from those numbers rather than by nudging a camera about: the eye is
// 1.58 m back from the windscreen, whose sill is 0.54 m below it and whose head is 0.50 m above
// it. Through a 62 degree lens pitched three degrees down, the glass fills the middle 63% of the
// frame, the console and its dash take the bottom sixth, and the deckhead and the overhead console
// take the top fifth. Three front panes, the middle one wide: the two mullions sit 24 degrees off
// the centreline, well clear of where the bow and the horizon are.
//
// Everything is modelled at a texel density of 1024 px per metre or better (materials.js), because
// all of it is within two metres of the viewer and the owner will lean in.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ } from './shaders.js';
import { Materials, paint, metreUvsBox, metreUvsPlane, scaleUvs } from './materials.js';
import { v3, DEG, TAU, lerp } from './util.js';

export const HOUSE = {
  sole: 4.00,
  deckhead: 6.14,
  halfWidth: 1.72,
  front: -1.40, // the windscreen sill's z
  frontTop: -1.56, // the windscreen head's z: the glass rakes forward, as a working boat's does
  back: 1.75,
  // The windscreen opening. The sill is 0.54 m below the eye, which leaves room under it for the
  // console and its dash without either of them climbing into the view.
  sill: 4.98,
  head: 6.02,
  glassHalf: 1.55,
  mullion: 0.70, // the two front mullions, either side of the centreline
  mullionWidth: 0.075,
  // The side windows.
  sideSill: 4.90,
  sideHead: 5.82,
  // The console. Its top is well below the sill; the dash is the strip between the two, and it
  // carries the sounder and the dials. The radar and the plotter go overhead, which is where a
  // trawler really has them and which puts them in the part of the frame that was bare deckhead.
  consoleTop: 4.68,
  consoleFront: -1.32,
  consoleBack: -0.62,
  dashTop: 4.94,
  // Where the overhead console hangs, and how far its face is raked down toward the helmsman.
  // It tucks up under the deckhead above the window head, so it frames the top of the view
  // instead of taking a third of it.
  overheadY: 6.00,
  overheadZ: -1.14,
  overheadRake: 42,
  // Where the helmsman stands.
  wheelZ: -0.42,
  wheelY: 4.92,
  wheelR: 0.27,
};

/** A box with its UVs in metres, so every material tiles at the size the manifest says. */
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const g = metreUvsBox(new THREE.BoxGeometry(w, h, d), w, h, d);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  return m;
}

/** A flat panel in the xy plane (facing +z), UVs in metres. */
function panel(w, h, material, x = 0, y = 0, z = 0) {
  const g = metreUvsPlane(new THREE.PlaneGeometry(w, h), w, h);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  return m;
}

/** A length of round bar between two points: handrails, the wheel's spokes, conduit. */
function bar(a, b, radius, material, segments = 12) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = scaleUvs(new THREE.CylinderGeometry(radius, radius, len, segments, 1), TAU * radius, len);
  const m = new THREE.Mesh(g, material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.normalize());
  return m;
}

export class PilotHouse {
  /**
   * @param {THREE.Scene} scene
   * @param {Materials} materials
   * @param {import('./util.js').Rng} rng
   */
  constructor(scene, materials, rng, glassMaterial = null) {
    this.scene = scene;
    this.materials = materials;
    this.rng = rng;
    this.glassMaterial = glassMaterial;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    scene.add(this.group);

    this.lamps = [];
    this.parts = {};
    this.lampMode = 'white';
    this.build();
    this.group.traverse((o) => {
      o.layers.set(LAYER.DEFAULT);
      o.layers.enable(LAYER.INTERIOR);
      if (o.isMesh && o.material && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  mat(tag, opts) { return this.materials.get(tag, opts); }

  build() {
    this.buildShell();
    this.buildWindscreen();
    this.buildSideWindows();
    this.buildAftBulkhead();
    this.buildConsole();
    this.buildWheel();
    this.buildOverhead();
    this.buildFittings();
  }

  add(mesh) { this.group.add(mesh); return mesh; }

  // --- the room --------------------------------------------------------------------------------

  buildShell() {
    const H = HOUSE;
    const w = H.halfWidth * 2;
    const d = H.back - H.front;
    const midZ = (H.back + H.front) / 2;

    // The sole: rubber tiles, worn through to the steel in a track from the wheel to the door.
    const sole = this.add(panel(w, d, this.mat('mat:rubber', { key: 'sole', roughness: 0.95, side: THREE.DoubleSide })));
    sole.rotation.x = -Math.PI / 2;
    sole.position.set(0, H.sole + 0.002, midZ);
    sole.receiveShadow = true;

    // The deckhead: plywood panels with the beams showing between them.
    const head = this.add(panel(w, d, this.mat('mat:enamel', { key: 'deckhead', tint: 0xdfe0d8, side: THREE.DoubleSide })));
    head.rotation.x = Math.PI / 2;
    head.position.set(0, H.deckhead, midZ);

    const beamMat = this.mat('mat:enamel', { key: 'beam', tint: 0xeceee6 });
    for (let i = 0; i < 4; i++) {
      const z = H.front + 0.42 + i * ((d - 0.84) / 3);
      this.add(box(w, 0.075, 0.09, beamMat, 0, H.deckhead - 0.04, z));
    }

    // The roof: the top of the house, and the deck the main mast and the radar stand on.
    const roof = this.add(panel(w + 0.14, d + 0.14, this.mat('mat:steel-rust', { key: 'wheelroof', desaturate: 0.8, tint: 0xb8b2a4 }),
      0, H.deckhead + 0.09, midZ));
    roof.rotation.x = -Math.PI / 2;
    roof.receiveShadow = true;
    roof.castShadow = true;
    // Its coaming, which is what you see from the deck.
    const coamMat = this.mat('mat:enamel', { key: 'coaming', tint: 0xe6e8e2, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const side = this.add(panel(d + 0.14, 0.12, coamMat, s * (H.halfWidth + 0.07), H.deckhead + 0.03, midZ));
      side.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    for (const [z, rot] of [[H.front - 0.07, Math.PI], [H.back + 0.07, 0]]) {
      const end = this.add(panel(w + 0.14, 0.12, coamMat, 0, H.deckhead + 0.03, z));
      end.rotation.y = rot;
    }

    // The side walls: painted panelling above the sole, down to the window sills.
    const wallMat = this.mat('mat:enamel', { key: 'wall', tint: 0xd9ded9, side: THREE.DoubleSide });
    const lowerH = H.sideSill - H.sole;
    for (const s of [-1, 1]) {
      const wall = this.add(panel(d, lowerH, wallMat, s * H.halfWidth, H.sole + lowerH / 2, midZ));
      wall.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      // Above the side windows, back to the deckhead.
      const upperH = H.deckhead - H.sideHead;
      const upper = this.add(panel(d, upperH, wallMat, s * H.halfWidth, H.sideHead + upperH / 2, midZ));
      upper.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      // The corner posts, which are what you actually see at the edge of the view.
      this.add(box(0.10, H.deckhead - H.sole, 0.12, beamMat, s * (H.halfWidth - 0.05), (H.sole + H.deckhead) / 2, H.front + 0.06));
      this.add(box(0.10, H.deckhead - H.sole, 0.12, beamMat, s * (H.halfWidth - 0.05), (H.sole + H.deckhead) / 2, H.back - 0.06));
    }
  }

  // --- the windscreen ---------------------------------------------------------------------------

  /** The z of the windscreen's face at a height y: it rakes forward as it rises. */
  frontZ(y) {
    const H = HOUSE;
    const t = (y - H.sill) / (H.head - H.sill);
    return lerp(H.front, H.frontTop, t);
  }

  buildWindscreen() {
    const H = HOUSE;
    const frameMat = this.mat('mat:enamel', { key: 'frame', tint: 0xeef0ea });
    const sealMat = paint(0x161a1c, 0.85, 0);
    const rake = Math.atan2(H.frontTop - H.front, H.head - H.sill);

    // The sill below the glass and the header above it, both raked with the glass.
    const sillH = H.sill - H.sole;
    const sillPanel = this.add(panel(H.halfWidth * 2, sillH, this.mat('mat:enamel', { key: 'wall', tint: 0xd9ded9, side: THREE.DoubleSide }),
      0, H.sole + sillH / 2, H.front + 0.004));
    sillPanel.rotation.y = Math.PI;
    this.add(box(H.halfWidth * 2, 0.10, 0.16, frameMat, 0, H.sill - 0.04, H.front - 0.02));
    this.add(box(H.halfWidth * 2, 0.11, 0.17, frameMat, 0, H.head + 0.05, H.frontTop - 0.02));
    // Above the header, up to the deckhead.
    const browH = H.deckhead - H.head - 0.1;
    const brow = this.add(panel(H.halfWidth * 2, browH,
      this.mat('mat:enamel', { key: 'frame2', tint: 0xeef0ea, side: THREE.DoubleSide }),
      0, H.head + 0.1 + browH / 2, H.frontTop - 0.01));
    brow.rotation.y = Math.PI;
    brow.rotation.x = -rake;

    // The two mullions, and the glazing bars round every opening.
    const glassH = H.head - H.sill;
    const midY = (H.sill + H.head) / 2;
    const midZ = this.frontZ(midY);
    for (const s of [-1, 1]) {
      const m = this.add(box(H.mullionWidth, glassH + 0.04, 0.13, frameMat, s * H.mullion, midY, midZ - 0.015));
      m.rotation.x = -rake;
      // The rubber seal either side of each mullion.
      for (const t of [-1, 1]) {
        const seal = this.add(box(0.016, glassH, 0.05, sealMat, s * H.mullion + t * (H.mullionWidth / 2 + 0.008), midY, midZ + 0.02));
        seal.rotation.x = -rake;
      }
      // The side posts at the outboard edge of the glass.
      const post = this.add(box(0.09, glassH + 0.04, 0.13, frameMat, s * (H.glassHalf + 0.045), midY, midZ - 0.015));
      post.rotation.x = -rake;
    }
    // Seals along the top and bottom edges of the glass.
    for (const y of [H.sill + 0.012, H.head - 0.012]) {
      const seal = this.add(box(H.glassHalf * 2, 0.024, 0.05, sealMat, 0, y, this.frontZ(y) + 0.02));
      seal.rotation.x = -rake;
    }

    // The glass itself, one pane at a time. glass.js gives it the material.
    this.panes = [];
    const spans = [
      [-H.glassHalf, -H.mullion - H.mullionWidth / 2],
      [-H.mullion + H.mullionWidth / 2, H.mullion - H.mullionWidth / 2],
      [H.mullion + H.mullionWidth / 2, H.glassHalf],
    ];
    for (const [x0, x1] of spans) {
      const w = x1 - x0;
      const g = metreUvsPlane(new THREE.PlaneGeometry(w, glassH, 2, 2), w, glassH);
      const mesh = new THREE.Mesh(g, this.glassMaterial ?? paint(0x8899aa, 0.04, 0, { transparent: true, opacity: 0.06 }));
      mesh.position.set((x0 + x1) / 2, midY, midZ + 0.03);
      mesh.rotation.x = -rake;
      mesh.rotation.y = Math.PI;
      mesh.renderOrder = 800;
      this.panes.push(mesh);
      this.add(mesh);
    }
    this.parts.rake = rake;
  }

  buildSideWindows() {
    const H = HOUSE;
    const frameMat = this.mat('mat:enamel', { key: 'frame', tint: 0xeef0ea });
    const h = H.sideHead - H.sideSill;
    const midY = (H.sideSill + H.sideHead) / 2;
    const spans = [[-1.22, -0.26], [-0.14, 0.82]];
    for (const s of [-1, 1]) {
      // The run of wall abaft the last window.
      const backW = H.back - 0.9;
      const backPanel = this.add(panel(backW, h, this.mat('mat:plywood', { key: 'liner', tint: 0xa88f68 }),
        s * (H.halfWidth - 0.004), midY, 0.9 + backW / 2));
      backPanel.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      for (const [z0, z1] of spans) {
        const w = z1 - z0;
        // The frame round the opening.
        this.add(box(0.10, 0.06, w + 0.1, frameMat, s * (H.halfWidth - 0.03), H.sideSill - 0.03, (z0 + z1) / 2));
        this.add(box(0.10, 0.06, w + 0.1, frameMat, s * (H.halfWidth - 0.03), H.sideHead + 0.03, (z0 + z1) / 2));
        for (const z of [z0 - 0.03, z1 + 0.03]) {
          this.add(box(0.10, h + 0.12, 0.06, frameMat, s * (H.halfWidth - 0.03), midY, z));
        }
        const g = metreUvsPlane(new THREE.PlaneGeometry(w, h), w, h);
        const mesh = new THREE.Mesh(g, this.glassMaterial ?? paint(0x8899aa, 0.04, 0, { transparent: true, opacity: 0.06 }));
        mesh.position.set(s * (H.halfWidth - 0.02), midY, (z0 + z1) / 2);
        mesh.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
        mesh.renderOrder = 800;
        this.panes.push(mesh);
        this.add(mesh);
      }
    }
  }

  buildAftBulkhead() {
    const H = HOUSE;
    const w = H.halfWidth * 2;
    const h = H.deckhead - H.sole;
    const linerMat = this.mat('mat:plywood', { key: 'liner', tint: 0xa88f68 });
    const frameMat = this.mat('mat:enamel', { key: 'frame', tint: 0xeef0ea });

    const back = this.add(panel(w, h, this.mat('mat:plywood', { key: 'liner2', tint: 0xa88f68, side: THREE.DoubleSide }),
      0, H.sole + h / 2, H.back - 0.01));
    back.rotation.y = Math.PI;

    // The door, slightly ajar, with a window in its upper half.
    const doorW = 0.72, doorH = 1.88;
    const door = new THREE.Group();
    door.position.set(0.98, H.sole, H.back - 0.04);
    door.rotation.y = -0.17;
    const leaf = box(doorW, doorH, 0.045, this.mat('mat:enamel', { key: 'door', tint: 0xdcdfd8 }), -doorW / 2, doorH / 2, 0);
    door.add(leaf);
    const glassH = 0.52;
    const dg = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(doorW - 0.18, glassH), doorW - 0.18, glassH),
      this.glassMaterial ?? paint(0x8899aa, 0.04, 0, { transparent: true, opacity: 0.07 }));
    dg.position.set(-doorW / 2, doorH - 0.42, 0.03);
    dg.renderOrder = 800;
    door.add(dg);
    this.panes.push(dg);
    // A bronze handle.
    const brass = paint(0x8a6a2e, 0.32, 0.85);
    door.add(bar(v3(-0.12, 1.02, 0.05), v3(-0.12, 1.22, 0.05), 0.012, brass));
    door.add(bar(v3(-0.12, 1.12, 0.03), v3(-0.12, 1.12, 0.07), 0.014, brass));
    this.group.add(door);
    this.parts.door = door;
    this.add(box(doorW + 0.12, 0.07, 0.09, frameMat, 0.98 - doorW / 2, H.sole + doorH + 0.03, H.back - 0.05));

    // The chart table along the port side of the aft bulkhead, with a light over it.
    const teak = this.mat('mat:teak', { key: 'teak', tint: 0x9a6334 });
    const tableW = 1.05, tableD = 0.46;
    this.add(box(tableW, 0.045, tableD, teak, -0.95, 4.74, H.back - 0.28));
    this.add(box(tableW - 0.06, 0.52, 0.03, teak, -0.95, 4.47, H.back - 0.07));
    for (const x of [-0.95 - tableW / 2 + 0.06, -0.95 + tableW / 2 - 0.06]) {
      this.add(box(0.05, 0.72, 0.05, teak, x, 4.36, H.back - 0.48));
    }
    // A rolled chart and a pencil on it.
    const chartMat = paint(0xc9c0a8, 0.85, 0);
    const roll = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.035, 0.035, 0.62, 16), 0.22, 0.62), chartMat);
    roll.rotation.z = Math.PI / 2;
    roll.position.set(-1.0, 4.80, H.back - 0.33);
    this.add(roll);
  }

  // --- the console ------------------------------------------------------------------------------

  buildConsole() {
    const H = HOUSE;
    const teak = this.mat('mat:teak', { key: 'teak', tint: 0x9a6334 });
    const frameMat = this.mat('mat:enamel', { key: 'frame', tint: 0xeef0ea });
    const dark = paint(0x24282b, 0.6, 0.1);
    const w = H.glassHalf * 2 + 0.18;

    // The top, sloping up a little toward the glass so instruments face the helmsman.
    const topD = H.consoleBack - H.consoleFront;
    const top = this.add(box(w, 0.05, topD, teak, 0, H.consoleTop, (H.consoleFront + H.consoleBack) / 2));
    top.rotation.x = -5 * DEG;
    top.receiveShadow = true;

    // The front face, down to the sole, and the kick panel at the back.
    const faceH = H.consoleTop - H.sole;
    this.add(box(w, faceH, 0.05, teak, 0, H.sole + faceH / 2, H.consoleBack));
    this.add(box(w, faceH - 0.26, 0.05, dark, 0, H.sole + 0.13 + (faceH - 0.26) / 2, H.consoleFront + 0.02));
    this.add(box(w, 0.02, topD, dark, 0, H.sole + 0.001, (H.consoleFront + H.consoleBack) / 2));

    // The dash: a panel standing up from the back of the console top, raked back, carrying the
    // instruments. instruments.js fills it; this is the carcass.
    const dashH = H.dashTop - H.consoleTop;
    const dash = this.add(box(w, dashH, 0.07, this.mat('mat:enamel', { key: 'dash', tint: 0x2d3238, roughness: 0.6 }),
      0, H.consoleTop + dashH / 2 - 0.01, H.consoleFront + 0.10));
    dash.rotation.x = 14 * DEG;
    this.parts.dash = dash;
    this.parts.dashRake = 14 * DEG;

    // The brass grab rail along the front edge: the thing you hold when she rolls.
    const brass = paint(0x9a7a34, 0.28, 0.88);
    const railY = H.consoleTop + 0.17, railZ = H.consoleBack - 0.04;
    this.add(bar(v3(-w / 2 + 0.08, railY, railZ), v3(w / 2 - 0.08, railY, railZ), 0.016, brass, 14));
    for (const x of [-w / 2 + 0.10, -0.52, 0.52, w / 2 - 0.10]) {
      this.add(bar(v3(x, H.consoleTop + 0.02, railZ), v3(x, railY, railZ), 0.013, brass, 10));
    }
    this.parts.consoleWidth = w;
  }

  buildWheel() {
    const H = HOUSE;
    const steel = this.mat('mat:steel-brushed', { key: 'wheelsteel', roughness: 0.3 });
    const teak = this.mat('mat:teak', { key: 'teak', tint: 0x9a6334 });
    const bronze = paint(0x8a6a2e, 0.3, 0.88);

    const wheel = new THREE.Group();
    wheel.position.set(0, H.wheelY, H.wheelZ);
    wheel.rotation.x = 18 * DEG; // the wheel leans back toward the helmsman

    // The rim: a torus with a turned section, in teak with bronze ferrules.
    const rim = new THREE.Mesh(scaleUvs(new THREE.TorusGeometry(H.wheelR, 0.022, 12, 64), TAU * H.wheelR, TAU * 0.022), teak);
    wheel.add(rim);
    // Six spokes with turned grips standing proud of the rim, as a working wheel has.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const dir = v3(Math.cos(a), Math.sin(a), 0);
      wheel.add(bar(v3(0, 0, 0), dir.clone().multiplyScalar(H.wheelR), 0.013, steel, 8));
      const grip = new THREE.Mesh(
        scaleUvs(new THREE.CylinderGeometry(0.018, 0.013, 0.085, 10), 0.11, 0.085), teak);
      grip.position.copy(dir).multiplyScalar(H.wheelR + 0.042);
      grip.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.clone().normalize());
      wheel.add(grip);
    }
    const hub = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.052, 0.058, 0.075, 20), 0.33, 0.075), bronze);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    this.group.add(wheel);
    this.parts.wheel = wheel;

    // The pedestal it stands on.
    const col = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.055, 0.085, H.wheelY - H.sole - 0.06, 18), 0.44, 1.0),
      this.mat('mat:steel-brushed', { key: 'pedestal', roughness: 0.42 }));
    col.position.set(0, (H.sole + H.wheelY - 0.06) / 2, H.wheelZ);
    this.add(col);
    const base = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.14, 0.17, 0.06, 20), 0.95, 0.06), this.mat('mat:steel-rust', { key: 'base' }));
    base.position.set(0, H.sole + 0.03, H.wheelZ);
    this.add(base);

    // Throttle and gearbox levers to starboard of the wheel, in a bronze quadrant.
    const quad = new THREE.Group();
    quad.position.set(0.56, H.consoleTop + 0.03, H.consoleBack - 0.16);
    const plate = box(0.2, 0.025, 0.16, bronze, 0, 0, 0);
    quad.add(plate);
    this.parts.levers = [];
    for (let i = 0; i < 2; i++) {
      const lever = new THREE.Group();
      lever.position.set(-0.045 + i * 0.09, 0.012, 0);
      lever.add(bar(v3(0, 0, 0), v3(0, 0.24, 0), 0.011, bronze, 8));
      const knob = new THREE.Mesh(scaleUvs(new THREE.SphereGeometry(0.026, 14, 10), 0.16, 0.16), paint(i === 0 ? 0x9b1f1f : 0x16181a, 0.5, 0.05));
      knob.position.set(0, 0.25, 0);
      lever.add(knob);
      quad.add(lever);
      this.parts.levers.push(lever);
    }
    this.group.add(quad);
    this.parts.quadrant = quad;
  }

  // --- overhead and fittings ---------------------------------------------------------------------

  buildOverhead() {
    const H = HOUSE;
    const frameMat = this.mat('mat:enamel', { key: 'frame', tint: 0xeef0ea });
    const dark = paint(0x2a2f33, 0.6, 0.1);

    // The overhead console: a box hung from the deckhead above and abaft the window head, with its
    // face raked down toward the helmsman. The radar and the plotter live on that face.
    const w = 1.42;
    const shelf = new THREE.Group();
    shelf.position.set(0, H.overheadY, H.overheadZ);
    // Positive, so the face turns down toward the helmsman rather than up at the deckhead.
    shelf.rotation.x = H.overheadRake * DEG;
    shelf.add(box(w, 0.34, 0.16, dark, 0, 0, -0.09));
    shelf.add(box(w + 0.03, 0.38, 0.02, frameMat, 0, 0, -0.172));
    this.group.add(shelf);
    this.parts.overhead = shelf;
    // The straps that hold it up.
    for (const s of [-1, 1]) {
      this.add(bar(v3(s * 0.60, H.overheadY + 0.10, H.overheadZ - 0.12), v3(s * 0.62, H.deckhead - 0.02, H.overheadZ - 0.18), 0.012, frameMat, 8));
      this.add(bar(v3(s * 0.60, H.overheadY - 0.02, H.overheadZ + 0.10), v3(s * 0.62, H.deckhead - 0.02, H.overheadZ + 0.16), 0.012, frameMat, 8));
    }
    // A row of switches and warning lamps along the bottom of it.
    this.parts.switches = [];
    for (let i = 0; i < 8; i++) {
      const x = -0.58 + i * 0.166;
      const body = box(0.05, 0.04, 0.045, paint(0x1b1f22, 0.6, 0.1), x, -0.135, 0.012);
      shelf.add(body);
      // The first switch of the row is the wipers: the one thing on this panel worth working by
      // hand, since everything else on it is already following the weather.
      if (i === 0) this.parts.wiperSwitch = body;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 10, 8),
        new THREE.MeshStandardMaterial({
          color: 0x401008, emissive: [0xff3020, 0x40ff60, 0xffc040][i % 3], emissiveIntensity: 0.2, roughness: 0.4,
        }));
      lamp.position.set(x, -0.078, 0.02);
      shelf.add(lamp);
      this.parts.switches.push(lamp);
    }

    // The grab rail you hold when you stand up into a sea.
    const brass = paint(0x9a7a34, 0.28, 0.88);
    const railY = H.deckhead - 0.26, railZ = H.frontTop + 0.62;
    this.add(bar(v3(-w / 2 + 0.1, railY, railZ), v3(w / 2 - 0.1, railY, railZ), 0.018, brass, 14));
    for (const x of [-w / 2 + 0.12, 0, w / 2 - 0.12]) {
      this.add(bar(v3(x, railY, railZ), v3(x, H.deckhead - 0.04, railZ - 0.05), 0.014, brass, 10));
    }

    // The cable run along the deckhead, which is what a real wheelhouse ceiling actually looks like.
    const conduit = paint(0x8d9298, 0.5, 0.6);
    for (const x of [-0.9, 0.9]) {
      this.add(bar(v3(x, H.deckhead - 0.055, H.frontTop + 0.5), v3(x, H.deckhead - 0.055, H.back - 0.1), 0.014, conduit, 8));
    }

    // Two deckhead lamps: white for working, red for night vision.
    this.parts.domeLamps = [];
    for (const z of [H.frontTop + 0.95, H.back - 0.55]) {
      const housing = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.085, 0.10, 0.055, 20), 0.6, 0.055), frameMat);
      housing.position.set(0, H.deckhead - 0.035, z);
      this.add(housing);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 12, 0, TAU, Math.PI / 2, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xf6f1e4, emissive: 0xfff0d0, emissiveIntensity: 2, roughness: 0.5 }));
      lens.position.set(0, H.deckhead - 0.062, z);
      this.add(lens);
      const light = new THREE.PointLight(0xffe8c0, 0, 4.2, 2);
      light.position.set(0, H.deckhead - 0.10, z);
      light.layers.set(LAYER.DEFAULT);
      light.layers.enable(LAYER.INTERIOR);
      this.group.add(light);
      this.parts.domeLamps.push({ light, lens });
      this.lamps.push(light);
    }
  }

  buildFittings() {
    const H = HOUSE;
    // Hooks and a shelf along the aft part of the port wall, for the props to hang from.
    const brass = paint(0x9a7a34, 0.3, 0.86);
    const shelfMat = this.mat('mat:teak', { key: 'teak', tint: 0x9a6334 });
    // The shelf runs fore and aft along the wall, not across it: 0.9 m long, 0.24 m deep, with a
    // fiddle along its outer edge, because anything on an unfenced shelf is on the sole by the
    // second roll.
    const shelf = this.add(box(0.24, 0.035, 0.9, shelfMat, -H.halfWidth + 0.12, 5.62, 1.15));
    this.parts.shelf = shelf;
    this.shelfTop = 5.62 + 0.0175;
    this.add(box(0.022, 0.05, 0.9, shelfMat, -H.halfWidth + 0.23, 5.655, 1.15));
    for (const [z, y] of [[0.80, 5.44], [1.52, 5.44]]) {
      this.add(bar(v3(-H.halfWidth + 0.02, y, z), v3(-H.halfWidth + 0.09, y - 0.04, z), 0.009, brass, 8));
    }
    // A coffee mug on the console: it slides when she rolls (update()).
    const mug = new THREE.Group();
    const body = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.042, 0.037, 0.095, 20, 1, true), 0.26, 0.095),
      paint(0xeae5dc, 0.5, 0, { side: THREE.DoubleSide }));
    body.position.y = 0.047;
    mug.add(body);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.037, 20), paint(0xeae5dc, 0.5, 0));
    bottom.rotation.x = -Math.PI / 2;
    mug.add(bottom);
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.038, 20), paint(0x2a1a0e, 0.18, 0));
    coffee.rotation.x = -Math.PI / 2;
    coffee.position.y = 0.072;
    mug.add(coffee);
    mug.add(bar(v3(0.042, 0.062, 0), v3(0.068, 0.046, 0), 0.006, paint(0xeae5dc, 0.5, 0), 8));
    mug.position.set(-0.34, H.consoleTop + 0.03, H.consoleBack - 0.17);
    this.group.add(mug);
    this.parts.mug = mug;
    this.mugX = -0.30;
    this.mugV = 0;
  }

  // --- props from the manifest --------------------------------------------------------------------

  /**
   * Where each scanned prop goes once it arrives. Positions are in body coordinates, in metres.
   *
   * Nothing here is scaled. Every one of these props is a Poly Haven scan, and Poly Haven models
   * are modelled at their real size in metres, which is the unit this scene is in as well: the
   * pocket compass is 8 cm across because a pocket compass is 8 cm across. An earlier version of
   * this table normalised each model to a guessed height, which is what you do to models of
   * unknown provenance, and the result measured out as a 1.7 m clipboard standing through the port
   * wall and a half-metre fisherman's hat. The sizes are checked by measurement, not by eye:
   * `trawler.propSizes()` prints the bounding box of every prop in metres, in the house's own
   * frame, and every one of them has to read like the real object.
   *
   * `anchor` says what the position means: 'base' (the default) stands the prop on its own bottom
   * face, which is what you want for anything standing on the console or the sole; 'centre' puts
   * its middle there, which is what you want for the things hanging on the port wall.
   */
  static PROPS = {
    // On the console, where the helmsman's hands are. The set is a valve transceiver 0.62 m across
    // and 0.43 m tall: that puts its top a hand's breadth above the window sill in the bottom port
    // corner of the view, which is exactly where a working boat's radio gets in the way.
    vhf: { pos: [-1.10, 4.68, -0.92], rot: [0, 0.42, 0] },
    compass: { pos: [-0.60, 4.68, -0.98], rot: [0, 0.35, 0] },
    torch: { pos: [0.72, 4.68, -0.95], rot: [0, 0.55, 0] },
    // On the sole.
    stool: { pos: [0.80, 4.00, 0.62], rot: [0, 0.4, 0] },
    extinguisher: { pos: [1.44, 4.00, 1.38], rot: [0, -0.6, 0] },
    // On the teak shelf on the port wall, whose top is at 5.6375.
    thermos: { pos: [-1.60, 5.6375, 0.88], rot: [0, 0.9, 0] },
    clipboard: { pos: [-1.575, 5.6375, 1.30], rot: [0, 0.12, 0] },
    // Hung on the port wall: the clock on the panelling, the glasses and the hat on the two brass
    // hooks at 5.44. These are placed by their centres.
    clock: { pos: [-1.690, 5.93, 1.15], rot: [0, 1.5708, 0], anchor: 'centre' },
    binoculars: { pos: [-1.615, 5.27, 0.80], rot: [1.5708, 0, 0.22], anchor: 'centre' },
    hat: { pos: [-1.505, 5.34, 1.48], rot: [0.30, 0.3, 0], anchor: 'centre' },
  };

  /** Drops a loaded glTF prop into the house. */
  addProp(name, model) {
    const spec = PilotHouse.PROPS[name];
    if (!spec || !model) return;
    const obj = model.clone(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.material) {
        o.material = o.material.clone();
        o.material.fog = true;
        // The props come out of the loader as standard materials, so they take the same
        // atmosphere as everything else once patched.
        o.material.onBeforeCompile = (shader) => { patchPropShader(shader); };
        o.material.needsUpdate = true;
      }
    });
    // Models arrive at whatever size they were modelled at and with their origin wherever the
    // author left it. Scale by the real height the prop should be, then sit it on its own base so
    // a thermos stands on the console rather than halfway through it.
    obj.rotation.set(spec.rot[0] ?? 0, spec.rot[1] ?? 0, spec.rot[2] ?? 0);
    obj.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(obj);
    const centre = bounds.getCenter(new THREE.Vector3());
    const yRef = spec.anchor === 'centre' ? centre.y : bounds.min.y;
    obj.position.set(
      spec.pos[0] - centre.x,
      spec.pos[1] - yRef,
      spec.pos[2] - centre.z,
    );
    obj.layers.set(LAYER.DEFAULT);
    obj.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); });
    const parent = spec.parent && this.parts[spec.parent] ? this.parts[spec.parent] : this.group;
    parent.add(obj);
    this.parts[`prop:${name}`] = obj;
  }

  // --- what can be worked -------------------------------------------------------------------------

  /**
   * Registers the things in the house a click can reach. Each is a mesh (or a group) and the name
   * of what working it does; scene.js does the rest.
   */
  registerControls() {
    this.controls = [];
    const add = (object, what) => { if (object) this.controls.push({ object, what }); };
    add(this.parts.quadrant, 'throttle');
    add(this.parts.wheel, 'wheel');
    for (const l of this.parts.domeLamps ?? []) add(l.lens, 'lamp');
    add(this.parts.overhead, 'horn');
    add(this.parts.dash, 'radar');
    add(this.parts.wiperSwitch, 'wipers');
  }

  /**
   * What a ray hits in the house, or null. Returns the *name* of the control rather than the mesh,
   * because that is all the caller wants and it keeps the house's insides to itself.
   */
  pick(raycaster) {
    if (!this.controls) this.registerControls();
    let best = null;
    for (const c of this.controls) {
      const hits = raycaster.intersectObject(c.object, true);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        best = { distance: hits[0].distance, what: c.what };
      }
    }
    return best ? best.what : null;
  }

  // --- the frame -----------------------------------------------------------------------------------

  /** Hangs the whole house off the boat, and moves the few things in it that move. */
  update(dt, boat, state) {
    const R = boat.R, p = boat.position;
    this.group.matrix.set(
      R[0], R[1], R[2], p.x,
      R[3], R[4], R[5], p.y,
      R[6], R[7], R[8], p.z,
      0, 0, 0, 1,
    );
    this.group.matrixWorldNeedsUpdate = true;

    // The wheel follows the rudder, geared about four turns lock to lock.
    if (this.parts.wheel) this.parts.wheel.rotation.z = -boat.rudder * 4.2;
    // The throttle lever follows the engine, the gear lever stays ahead.
    if (this.parts.levers) {
      this.parts.levers[0].rotation.x = lerp(0.42, -0.52, boat.throttle);
      this.parts.levers[1].rotation.x = -0.34;
    }
    // The mug slides on the console when she rolls, and fetches up against the rail.
    if (this.parts.mug) {
      const a = Math.sin(boat.roll) * 9.81 - boat.rate.x * 0.4;
      // Rubber matting under it: it holds until the slope beats the friction, then it goes.
      const stick = 0.9;
      if (Math.abs(a) > stick || Math.abs(this.mugV) > 1e-3) {
        this.mugV += (a - Math.sign(this.mugV || a) * stick) * dt;
        this.mugV *= Math.exp(-dt / 0.9);
        this.mugX += this.mugV * dt;
        if (this.mugX < -0.80) { this.mugX = -0.80; this.mugV = Math.abs(this.mugV) * 0.2; }
        if (this.mugX > 0.14) { this.mugX = 0.14; this.mugV = -Math.abs(this.mugV) * 0.2; }
      }
      this.parts.mug.position.x = this.mugX;
    }
    // The door swings on its hinge with the roll, and knocks at the stops.
    if (this.parts.door) {
      this.doorAngle ??= -0.17;
      this.doorRate ??= 0;
      const torque = -Math.sin(boat.roll) * 2.2 - this.doorRate * 1.1;
      this.doorRate += torque * dt;
      this.doorAngle = Math.max(-0.62, Math.min(0.02, this.doorAngle + this.doorRate * dt));
      if (this.doorAngle <= -0.62 || this.doorAngle >= 0.02) this.doorRate *= -0.25;
      this.parts.door.rotation.y = this.doorAngle;
    }
    this.updateLamps(dt, state);
  }

  /**
   * The deckhead lamps: white by day in the house, red at night, out when it is bright outside.
   *
   * Two different kinds of number here, and mixing them up is what makes a night scene blow out.
   * The *light* is physical: a wheelhouse dome lamp puts about five lux on a surface two metres
   * away against the sun's hundred thousand, so against this scene's sun of 6.4 it is a few
   * ten-thousandths, and three's point lights take candela, which is that times the distance
   * squared. The *lens*, like the stars and the moon, is drawn at a chosen screen brightness and
   * so has to be divided by whatever exposure the camera has adapted to.
   */
  updateLamps(dt, state) {
    const night = G.uNight.value;
    // Nobody lights a wheelhouse at night: a white light in here and you cannot see a thing
    // outside, which is the whole job. So the deckhead lamp is off unless it is asked for, and
    // when it is asked for it is red, which is what it is for.
    const want = (state?.redLight ? 1 : 0) * night;
    this.lampLevel = lerp(this.lampLevel ?? 0, want, 1 - Math.exp(-dt / 1.1));
    const screen = state?.emissiveScale ?? 1;
    for (const { light, lens } of this.parts.domeLamps ?? []) {
      light.intensity = this.lampLevel * 0.0009;
      light.color.setRGB(1, 0.12, 0.07);
      lens.material.emissive.setRGB(1, 0.14, 0.08);
      lens.material.emissiveIntensity = this.lampLevel * 0.42 * screen;
    }
    for (const lamp of this.parts.switches ?? []) {
      lamp.material.emissiveIntensity = (0.05 + 0.5 * this.lampLevel) * screen;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material && o.material.userData?.tag === undefined) o.material.dispose?.();
    });
    this.scene.remove(this.group);
  }
}

/**
 * The atmosphere, for a prop's own loaded material. A scanned prop arrives as a plain standard
 * material that knows nothing about this scene's aerial perspective; this bolts the same read onto
 * it that every other surface uses. deck.js uses it too, for the props out on the foredeck.
 */
export function patchPropShader(shader) {
  shader.uniforms.uSkyLut = G.uSkyLut;
  shader.uniforms.uTransLut = G.uTransLut;
  shader.uniforms.uSunDir = G.uSunDir;
  shader.uniforms.uMoonDir = G.uMoonDir;
  shader.uniforms.uSunColor = G.uSunColor;
  shader.uniforms.uMoonColor = G.uMoonColor;
  shader.uniforms.uHaze = G.uHaze;
  shader.uniforms.uHazeFar = G.uHazeFar;
  shader.fragmentShader = `${ATMOS_READ}\n${shader.fragmentShader}`;
}
