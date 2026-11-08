// Trawler — The wheelhouse: the room the whole background is seen from.
//
// Built to the owner's reference photograph of a trawler yacht's pilot house: lacquered cherry
// joinery everywhere, a big chrome destroyer wheel on a varnished pedestal, a dash of plotter and
// radar under the windscreen, an overhead fascia of gauges and radio sets, louvred lockers, two
// cream leather helm chairs, and a teak-and-holly sole. Nothing in here is a downloaded model: the
// joinery, the leather and the chrome are scanned materials (CC0, see the README) and every gauge
// face, switch legend and radio fascia is drawn in code by panel.js at better than 2000 pixels to
// the metre, because nobody publishes a CC0 scan of a marine instrument and a drawn one can be made
// exactly as sharp as it needs to be.
//
// Body coordinates: +x starboard, +y up, +z aft, y = 0 at the waterline.
//
//   4.00  the sole
//   4.30  the bottom rail of the dash lockers
//   4.86  the dash top, the side desks and the wheel's centre
//   4.98  the windscreen sill
//   5.52  the helmsman's eye
//   6.02  the windscreen head
//   6.14  the deckhead
//
// The composition, worked out from those numbers rather than by nudging a camera about: the eye is
// 1.58 m back from the windscreen, whose sill is 0.54 m below it and whose head is 0.50 m above it.
// Through a 62 degree lens pitched three degrees down the glass fills the middle 63% of the frame,
// the dash and its instrument panel take the bottom sixth, and the deckhead and the overhead fascia
// take the top fifth. Three front panes, the middle one wide: the two mullions sit 24 degrees off
// the centreline, well clear of where the bow and the horizon are. Those numbers are why the
// rebuild kept the window openings exactly where they were and changed everything inside them.
//
// Everything is modelled at a texel density of 1024 px per metre or better (materials.js), and the
// cherry at 2048, because all of it is within two metres of the viewer and the owner will lean in.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ } from './shaders.js';
import { Materials, paint, metreUvsBox, metreUvsPlane, scaleUvs } from './materials.js';
import { Gauge, SwitchBank, RadioSet, handset, louvreDoor } from './panel.js';
import { v3, DEG, TAU, lerp, clamp01, Art } from './util.js';

export const HOUSE = {
  sole: 4.00,
  deckhead: 6.14,
  halfWidth: 1.72,
  front: -1.40, // the windscreen sill's z
  frontTop: -1.56, // the windscreen head's z: the glass rakes forward, as a working boat's does
  back: 1.75,
  // The windscreen opening. The sill is 0.54 m below the eye, which leaves room under it for the
  // dash and its instrument panel without either of them climbing into the view.
  sill: 4.98,
  head: 6.02,
  glassHalf: 1.55,
  mullion: 0.70, // the two front mullions, either side of the centreline
  mullionWidth: 0.075,
  // The side windows.
  sideSill: 4.90,
  sideHead: 5.82,
  // The dash. Its top is a hand's breadth below the sill; the instrument panel stands on it,
  // raked back, and carries the plotter and the radar.
  dashTop: 4.86,
  dashFront: -1.34,
  dashBack: -0.72,
  dashRake: 24,
  lockerTop: 4.34, // where the louvred lockers under the dash begin
  // The overhead fascia: a cherry panel hung under the deckhead above the window head, raked down
  // toward the helmsman, carrying the gauges and the sets.
  overheadY: 5.99,
  overheadZ: -1.13,
  overheadRake: 40,
  overheadHeight: 0.30,
  // The side desks: a chart table to port and a desk with a screen to starboard.
  deskTop: 4.86,
  deskInboard: 0.98,
  deskFront: -0.70,
  deskBack: 0.72,
  // Where the helmsman stands, and the wheel he stands at.
  wheelZ: -0.50,
  wheelY: 4.86,
  wheelR: 0.325,
  wheelTilt: 13,
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

/**
 * A half-round nosing along the front edge of a worktop. Every horizontal edge of this joinery has
 * one, and they are what catch the light along the dash and the desks: a square edge there reads
 * as cardboard however good the timber is.
 */
function nosing(length, radius, material, x, y, z, alongX = true) {
  const g = scaleUvs(new THREE.CylinderGeometry(radius, radius, length, 10, 1, false, 0, Math.PI), TAU * radius, length);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  if (alongX) m.rotation.set(0, 0, Math.PI / 2);
  else m.rotation.set(Math.PI / 2, 0, 0);
  return m;
}

/**
 * The sole: teak laid fore and aft with holly seams between the planks, which is what the deck of
 * a boat like this is. Drawn rather than scanned because the stripe is a 6 mm line in a 75 mm
 * plank and no tiling photograph keeps that crisp at arm's length.
 */
function teakAndHollyTexture() {
  return Art.image(1024, 1024, (ctx, w, h) => {
    const plank = w / 12; // twelve 83 mm planks to the metre-square tile
    for (let i = 0; i < 12; i++) {
      const x = i * plank;
      const base = 118 + Math.sin(i * 2.7) * 9;
      ctx.fillStyle = `rgb(${base + 28}, ${base - 16}, ${base - 54})`;
      ctx.fillRect(x, 0, plank, h);
      // Grain: long fine streaks, darker and lighter, running the length of the plank.
      for (let k = 0; k < 90; k++) {
        const gx = x + 2 + Math.random() * (plank - 4);
        const a = 0.025 + Math.random() * 0.05;
        ctx.strokeStyle = Math.random() < 0.5 ? `rgba(60,34,16,${a})` : `rgba(226,186,138,${a * 0.8})`;
        ctx.lineWidth = 0.6 + Math.random() * 1.6;
        ctx.beginPath();
        let gy = -10;
        ctx.moveTo(gx, gy);
        while (gy < h) { gy += 40 + Math.random() * 90; ctx.lineTo(gx + (Math.random() - 0.5) * 3.5, gy); }
        ctx.stroke();
      }
      // The holly seam on the port side of each plank.
      ctx.fillStyle = '#efe9d6';
      ctx.fillRect(x, 0, plank * 0.075, h);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x + plank * 0.075, 0, plank * 0.02, h);
    }
  });
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
    this.buildFill();
    this.gauges = {};
    this.banks = [];
    this.sets = [];
    this.panes = [];
    this.lampMode = 'white';
    this.build();
    this.group.traverse((o) => {
      o.layers.set(LAYER.DEFAULT);
      o.layers.enable(LAYER.INTERIOR);
      if (o.isMesh && o.material && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  /**
   * The light inside the room, which is not the light outside it.
   *
   * Three's hemisphere light and its ambient fill are the whole sky, and they reach in here
   * unoccluded - but the sun does not, because the roof is over it. So on a bright day the cabin
   * sits four stops under the sea in the window and reads as a cave, where in life a wheelhouse
   * with six square metres of glass is a bright room: the sea throws light up through the windows
   * from below, the cream deckhead throws it back down, and the varnish bounces it round again.
   * None of that is in a single hemisphere term, and none of it can be, because three has no
   * global illumination.
   *
   * So the house carries its own fill, on the interior layer alone so it touches nothing outside:
   * warm from above (the deckhead), cool from below (the water through the glass), and scaled by
   * the real sky irradiance so it follows the day down to nothing at night. The number is set by
   * measurement - see the comment on `setFill` - not by eye.
   */
  buildFill() {
    this.fill = new THREE.HemisphereLight(0xfff1dc, 0x8fb4c8, 0);
    this.fill.position.set(0, HOUSE.deckhead, (HOUSE.front + HOUSE.back) / 2);
    this.fill.layers.set(LAYER.INTERIOR);
    this.group.add(this.fill);
  }

  /**
   * Sets that fill from the sky's own irradiance. The gain of 16 was chosen by measuring the frame:
   * at noon it puts the mean of the cabin about a third of the mean of the sea in the window -
   * which is what a photograph of a wheelhouse looks like - where the sky term alone left it at a
   * seventh and the room read as a cave.
   */
  setFill(skyIrradiance) {
    if (!this.fill) return;
    const m = Math.max(skyIrradiance.x, skyIrradiance.y, skyIrradiance.z);
    this.fill.intensity = m * 16.0;
  }

  mat(tag, opts) { return this.materials.get(tag, opts); }
  add(mesh) { this.group.add(mesh); return mesh; }

  /** The lacquered cherry everything in here is made of, shared so it is one material. */
  get cherry() {
    return this.mat('mat:cherry', { key: 'cherry', roughness: 0.22, normalScale: 0.8 });
  }

  /** The same timber in a darker, flatter cut, for the big flat panels and the locker fronts. */
  get cherryPanel() {
    return this.mat('mat:cherry-panel', { key: 'cherry-panel', tint: 0xcf9d6e, roughness: 0.3 });
  }

  build() {
    this.buildShell();
    this.buildWindscreen();
    this.buildSideWindows();
    this.buildAftBulkhead();
    this.buildDash();
    this.buildWheel();
    this.buildOverhead();
    this.buildSideDesks();
    this.buildSeats();
    this.buildFittings();
  }

  // --- the room --------------------------------------------------------------------------------

  buildShell() {
    const H = HOUSE;
    const w = H.halfWidth * 2;
    const d = H.back - H.front;
    const midZ = (H.front + H.back) / 2;

    // The sole: teak and holly, laid fore and aft.
    // The tile is one metre square and the plane's uvs are already in metres, so the texture
    // repeats once a metre on its own: setting a repeat as well squeezed twelve planks into
    // 85 mm and the sole aliased to a flat orange sheet.
    this.soleTex = Art.texture(teakAndHollyTexture(), { repeat: true });
    const sole = this.add(new THREE.Mesh(
      metreUvsPlane(new THREE.PlaneGeometry(w, d), w, d),
      new THREE.MeshStandardMaterial({ map: this.soleTex, roughness: 0.34, metalness: 0, side: THREE.DoubleSide }),
    ));
    sole.rotation.x = -Math.PI / 2;
    sole.position.set(0, H.sole, midZ);
    sole.receiveShadow = true;

    // The deckhead: cream painted panels between varnished battens running athwartships.
    const headMat = this.mat('mat:enamel', { key: 'deckhead', tint: 0xf2ece0, roughness: 0.78, side: THREE.DoubleSide });
    const head = this.add(panel(w, d, headMat));
    head.rotation.x = Math.PI / 2;
    head.position.set(0, H.deckhead, midZ);
    head.receiveShadow = true;
    const batten = this.cherry;
    for (let z = H.front + 0.46; z < H.back - 0.2; z += 0.52) {
      this.add(box(w, 0.016, 0.055, batten, 0, H.deckhead - 0.010, z));
    }
    // And the perimeter trim where the deckhead meets the walls.
    for (const s of [-1, 1]) this.add(box(0.05, 0.022, d, batten, s * (H.halfWidth - 0.025), H.deckhead - 0.013, midZ));

    // The side walls: cherry panelling above the side windows and below their sills.
    const wallMat = this.cherryPanel;
    for (const s of [-1, 1]) {
      const lowerH = H.sideSill - H.sole;
      const lower = this.add(panel(d, lowerH, wallMat, s * H.halfWidth, H.sole + lowerH / 2, midZ));
      lower.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      const upperH = H.deckhead - H.sideHead;
      const upper = this.add(panel(d, upperH, wallMat, s * H.halfWidth, H.sideHead + upperH / 2, midZ));
      upper.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      // The corner posts, fore and aft, in solid cherry.
      this.add(box(0.11, H.deckhead - H.sole, 0.13, batten, s * (H.halfWidth - 0.055), (H.sole + H.deckhead) / 2, H.front + 0.065));
      this.add(box(0.11, H.deckhead - H.sole, 0.13, batten, s * (H.halfWidth - 0.055), (H.sole + H.deckhead) / 2, H.back - 0.065));
    }

    // The roof above, which is the deck the main mast and the radar stand on.
    const roof = this.add(panel(w + 0.14, d + 0.14, this.mat('mat:steel-rust', { key: 'wheelroof', desaturate: 0.8, tint: 0xb8b2a4 }),
      0, H.deckhead + 0.09, midZ));
    roof.rotation.x = -Math.PI / 2;
    roof.receiveShadow = true;
    roof.castShadow = true;
    const coamMat = this.mat('mat:enamel', { key: 'coaming', tint: 0xe6e8e2, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const side = this.add(panel(d + 0.14, 0.12, coamMat, s * (H.halfWidth + 0.07), H.deckhead + 0.03, midZ));
      side.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    for (const [z, rot] of [[H.front - 0.07, Math.PI], [H.back + 0.07, 0]]) {
      const end = this.add(panel(w + 0.14, 0.12, coamMat, 0, H.deckhead + 0.03, z));
      end.rotation.y = rot;
    }
  }

  /** The windscreen's z at a height: it rakes forward from the sill to the head. */
  frontZ(y) {
    const H = HOUSE;
    const t = clamp01((y - H.sill) / (H.head - H.sill));
    return lerp(H.front, H.frontTop, t);
  }

  buildWindscreen() {
    const H = HOUSE;
    const frame = this.cherry;
    const rake = Math.atan2(H.frontTop - H.front, H.head - H.sill);
    const openH = H.head - H.sill;
    const glassH = openH / Math.cos(rake);

    // Under the sill: the bulkhead the dash is built against.
    const sillH = H.sill - H.sole;
    const sillPanel = this.add(panel(H.halfWidth * 2, sillH, this.cherryPanel, 0, H.sole + sillH / 2, H.front - 0.012));
    sillPanel.rotation.y = Math.PI;

    // The sill capping and the head rail, both with a half-round nosing on the inboard edge: these
    // are the two horizontals that frame the view and they are 1.5 m from the eye.
    this.add(box(H.halfWidth * 2, 0.085, 0.14, frame, 0, H.sill - 0.042, H.front - 0.005));
    this.add(nosing(H.halfWidth * 2, 0.042, frame, 0, H.sill - 0.042, H.front + 0.065));
    this.add(box(H.halfWidth * 2, 0.095, 0.15, frame, 0, H.head + 0.047, H.frontTop + 0.01));

    // Three panes: a wide one on the centreline and a narrower one each side. The two mullions are
    // what the composition is built round, so they are placed and not nudged.
    const mullions = [-H.mullion, H.mullion];
    for (const x of mullions) {
      const m = this.add(box(H.mullionWidth, openH + 0.02, 0.12, frame, x, (H.sill + H.head) / 2, this.frontZ((H.sill + H.head) / 2)));
      m.rotation.x = -rake;
    }
    const spans = [
      [-H.glassHalf, -H.mullion - H.mullionWidth / 2],
      [-H.mullion + H.mullionWidth / 2, H.mullion - H.mullionWidth / 2],
      [H.mullion + H.mullionWidth / 2, H.glassHalf],
    ];
    for (const [x0, x1] of spans) {
      const w = x1 - x0;
      const y = (H.sill + H.head) / 2;
      const mesh = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(w, glassH), w, glassH), this.glassMaterial ?? paint(0xffffff, 0.05, 0));
      mesh.position.set((x0 + x1) / 2, y, this.frontZ(y) + 0.004);
      mesh.rotation.x = -rake;
      mesh.renderOrder = 820;
      this.group.add(mesh);
      this.panes.push({ mesh, kind: 'FRONT', width: w, height: glassH });
    }

    // The angled corner panes, which is what makes a wheelhouse of this kind look like one: a
    // narrow light each side running from the windscreen's outboard edge back to the side window.
    for (const s of [-1, 1]) {
      const cw = 0.42;
      const y = (H.sill + H.head) / 2;
      const z = (this.frontZ(y) + H.front + 0.30) / 2;
      const mesh = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(cw, openH), cw, openH), this.glassMaterial ?? paint(0xffffff, 0.05, 0));
      mesh.position.set(s * (H.glassHalf + 0.09), y, z);
      mesh.rotation.y = s * 52 * DEG;
      mesh.renderOrder = 820;
      this.group.add(mesh);
      this.panes.push({ mesh, kind: 'SIDE', width: cw, height: openH });
      // Its frame: a post at the outboard end and cappings top and bottom.
      const post = this.add(box(0.09, openH + 0.1, 0.11, frame, s * (H.halfWidth - 0.05), y, H.front + 0.30));
      post.rotation.y = s * 18 * DEG;
      for (const yy of [H.sill - 0.042, H.head + 0.047]) {
        const cap = this.add(box(cw + 0.12, 0.085, 0.11, frame, s * (H.glassHalf + 0.09), yy, z));
        cap.rotation.y = s * 52 * DEG;
      }
    }
  }

  buildSideWindows() {
    const H = HOUSE;
    const frame = this.cherry;
    const openH = H.sideHead - H.sideSill;
    const y = (H.sideSill + H.sideHead) / 2;
    // Two lights each side, between the corner posts.
    const zs = [[H.front + 0.52, H.front + 1.52], [H.front + 1.62, H.back - 0.22]];
    for (const s of [-1, 1]) {
      for (const [z0, z1] of zs) {
        const w = z1 - z0;
        const mesh = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(w, openH), w, openH), this.glassMaterial ?? paint(0xffffff, 0.05, 0));
        mesh.position.set(s * (H.halfWidth - 0.012), y, (z0 + z1) / 2);
        mesh.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
        mesh.renderOrder = 820;
        this.group.add(mesh);
        this.panes.push({ mesh, kind: 'SIDE', width: w, height: openH });
      }
      // The capping above and below, and the post between the two lights.
      for (const yy of [H.sideSill - 0.045, H.sideHead + 0.045]) {
        this.add(box(0.12, 0.09, H.back - H.front - 0.24, frame, s * (H.halfWidth - 0.055), yy, (H.front + H.back) / 2 + 0.06));
      }
      this.add(box(0.12, openH, 0.08, frame, s * (H.halfWidth - 0.055), y, H.front + 1.57));
    }
  }

  buildAftBulkhead() {
    const H = HOUSE;
    const w = H.halfWidth * 2;
    const h = H.deckhead - H.sole;
    const back = this.add(panel(w, h, this.cherryPanel, 0, H.sole + h / 2, H.back - 0.012));
    back.rotation.y = Math.PI;

    // The door down to the saloon, on the port quarter: a cherry door with a glazed light in it.
    const dw = 0.78, dh = 1.92;
    const dx = -0.86, dz = H.back - 0.035;
    this.add(box(dw + 0.09, dh + 0.05, 0.06, this.cherry, dx, H.sole + dh / 2 + 0.02, dz - 0.005));
    this.add(box(dw, dh, 0.042, this.cherryPanel, dx, H.sole + dh / 2, dz - 0.03));
    const gw = 0.52, gh = 0.56;
    const mesh = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(gw, gh), gw, gh), this.glassMaterial ?? paint(0xffffff, 0.05, 0));
    mesh.position.set(dx, H.sole + 1.42, dz - 0.052);
    mesh.rotation.y = Math.PI;
    mesh.renderOrder = 820;
    this.group.add(mesh);
    this.panes.push({ mesh, kind: 'DOOR', width: gw, height: gh });
    this.add(bar(v3(dx + 0.30, H.sole + 1.00, dz - 0.06), v3(dx + 0.30, H.sole + 1.18, dz - 0.06), 0.013, paint(0xc8ccd0, 0.28, 0.85), 10));
  }

  // --- the dash --------------------------------------------------------------------------------

  buildDash() {
    const H = HOUSE;
    const cherry = this.cherry;
    const wHalf = 1.52;
    const topD = H.dashBack - H.dashFront;

    // The worktop, with a nosing along its aft edge where a hand would rest.
    const top = this.add(box(wHalf * 2, 0.042, topD, cherry, 0, H.dashTop, (H.dashFront + H.dashBack) / 2));
    top.receiveShadow = true;
    this.add(nosing(wHalf * 2, 0.026, cherry, 0, H.dashTop - 0.005, H.dashBack));
    this.parts.dashTop = top;

    // The face below it, down to the lockers: this is where the breaker panels live.
    const faceH = H.dashTop - H.lockerTop;
    this.add(box(wHalf * 2, faceH, 0.05, cherry, 0, H.lockerTop + faceH / 2, H.dashBack - 0.02));

    // The louvred lockers under the dash, three a side with the wheel pedestal between them.
    const lockH = H.lockerTop - H.sole - 0.06;
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const dw = 0.46;
        const x = s * (0.42 + i * (dw + 0.045));
        const door = louvreDoor(dw, lockH, cherry);
        door.position.set(x, H.sole + 0.06 + lockH / 2, H.dashBack - 0.052);
        door.rotation.y = Math.PI;
        this.group.add(door);
        // A chrome flush pull on the inboard stile.
        this.add(bar(
          v3(x - s * dw * 0.38, H.sole + 0.06 + lockH * 0.74, H.dashBack - 0.064),
          v3(x - s * dw * 0.38, H.sole + 0.06 + lockH * 0.86, H.dashBack - 0.064),
          0.009, paint(0xcdd1d5, 0.26, 0.88), 10));
      }
    }
    // The plinth they stand on, set back so the sole runs under it.
    this.add(box(wHalf * 2, 0.06, topD * 0.6, this.cherryPanel, 0, H.sole + 0.03, H.dashBack - 0.14));

    // The instrument panel: a raked cherry surround standing on the worktop, carrying the plotter,
    // the sounder and the radar. In the reference it sits just under the window sill and the
    // screens are square to the helmsman rather than to the boat, which is what the rake is for.
    const panelH = 0.30;
    const stand = new THREE.Group();
    stand.position.set(0, H.dashTop + 0.021, H.dashFront + 0.10);
    stand.rotation.x = -H.dashRake * DEG;
    const carcass = box(wHalf * 1.42, panelH, 0.06, cherry, 0, panelH / 2 - 0.02, -0.03);
    stand.add(carcass);
    this.group.add(stand);
    this.parts.instrumentPanel = stand;
    this.parts.dash = carcass;

    // The breaker and switch banks either side of the wheel, in the dash face.
    const dcBank = new SwitchBank(
      ['nav lights', 'anchor', 'deck flood', 'steaming', 'wipers', 'horn', 'bilge', 'blower'],
      { width: 0.40, height: 0.26, columns: 2, title: 'DC main', on: [0, 4] },
    );
    dcBank.group.position.set(-0.92, H.lockerTop + 0.26, H.dashBack - 0.047);
    dcBank.group.rotation.y = Math.PI;
    this.group.add(dcBank.group);
    this.banks.push(dcBank);
    this.parts.wiperSwitch = dcBank.switches[4].body;

    const acBank = new SwitchBank(
      ['radar', 'plotter', 'sounder', 'vhf', 'autopilot', 'instruments', 'panel light', 'spare'],
      { width: 0.40, height: 0.26, columns: 2, title: 'electronics', breaker: true, on: [0, 1, 2, 3, 4, 5] },
    );
    acBank.group.position.set(0.92, H.lockerTop + 0.26, H.dashBack - 0.047);
    acBank.group.rotation.y = Math.PI;
    this.group.add(acBank.group);
    this.banks.push(acBank);

    // The engine controls: a single-lever head on a cherry plinth to starboard of the wheel.
    const quad = new THREE.Group();
    quad.position.set(0.74, H.dashTop + 0.021, H.dashBack - 0.20);
    const plinth = box(0.17, 0.05, 0.22, cherry, 0, 0.025, 0);
    quad.add(plinth);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.055, 0.19), paint(0x1b1e21, 0.5, 0.35));
    head.position.y = 0.078;
    quad.add(head);
    const lever = new THREE.Group();
    lever.position.set(0, 0.10, 0.0);
    const shaft = bar(v3(0, 0, 0), v3(0, 0.20, 0), 0.011, paint(0xc9ced2, 0.26, 0.9), 12);
    lever.add(shaft);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), paint(0x16181a, 0.45, 0.1));
    knob.position.y = 0.21;
    lever.add(knob);
    quad.add(lever);
    this.group.add(quad);
    this.parts.quadrant = quad;
    this.parts.levers = [lever];

    // The chrome grab rail along the aft edge: the thing you hold when she rolls.
    const chrome = paint(0xcdd1d5, 0.24, 0.9);
    const railY = H.dashTop + 0.115, railZ = H.dashBack - 0.045;
    this.add(bar(v3(-wHalf + 0.10, railY, railZ), v3(wHalf - 0.10, railY, railZ), 0.015, chrome, 14));
    for (const x of [-wHalf + 0.12, -0.46, 0.46, wHalf - 0.12]) {
      this.add(bar(v3(x, H.dashTop + 0.022, railZ), v3(x, railY, railZ), 0.012, chrome, 10));
    }
  }

  // --- the wheel -------------------------------------------------------------------------------

  buildWheel() {
    const H = HOUSE;
    const chrome = this.mat('mat:steel-brushed', { key: 'wheelchrome', roughness: 0.16, metalness: 0.95 });
    const cherry = this.cherry;

    // The pedestal: a cherry column with a chrome collar, standing on the sole.
    const colH = H.wheelY - H.sole - 0.30;
    this.add(box(0.19, colH, 0.19, cherry, 0, H.sole + colH / 2, H.wheelZ));
    this.add(box(0.26, 0.05, 0.26, cherry, 0, H.sole + 0.025, H.wheelZ));
    const collar = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.075, 0.075, 0.09, 20), 0.47, 0.09), chrome);
    collar.position.set(0, H.sole + colH + 0.045, H.wheelZ);
    this.add(collar);

    // The wheel itself: a destroyer type, six spokes with turned grips standing proud of the rim.
    const wheel = new THREE.Group();
    wheel.position.set(0, H.wheelY, H.wheelZ);
    wheel.rotation.x = H.wheelTilt * DEG;
    const R = H.wheelR;
    const rim = new THREE.Mesh(scaleUvs(new THREE.TorusGeometry(R, 0.017, 14, 72), TAU * R, TAU * 0.017), chrome);
    wheel.add(rim);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6;
      const dir = v3(Math.cos(a), Math.sin(a), 0);
      // A spoke that tapers from the hub out to the rim.
      const sp = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.0085, 0.014, R - 0.05, 10), 0.07, R), chrome);
      sp.position.copy(dir).multiplyScalar((R - 0.05) / 2 + 0.05);
      sp.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.clone().normalize());
      wheel.add(sp);
      // The grip beyond the rim, turned from the same timber as the joinery.
      const grip = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.019, 0.014, 0.085, 12), 0.11, 0.085), cherry);
      grip.position.copy(dir).multiplyScalar(R + 0.044);
      grip.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.clone().normalize());
      wheel.add(grip);
    }
    const hub = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.052, 0.058, 0.085, 22), 0.33, 0.085), chrome);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.036, 20, 14), paint(0x8f6f2c, 0.26, 0.9));
    cap.position.z = -0.05;
    wheel.add(cap);
    this.group.add(wheel);
    this.parts.wheel = wheel;
  }

  // --- the overhead ----------------------------------------------------------------------------

  buildOverhead() {
    const H = HOUSE;
    const cherry = this.cherry;
    const w = 3.00;
    const fascia = new THREE.Group();
    fascia.position.set(0, H.overheadY, H.overheadZ);
    fascia.rotation.x = H.overheadRake * DEG;
    // The carcass and its surround: a cherry box with a raked face.
    fascia.add(box(w, H.overheadHeight, 0.16, cherry, 0, 0, -0.09));
    fascia.add(box(w + 0.05, H.overheadHeight + 0.05, 0.022, cherry, 0, 0, -0.004));
    this.group.add(fascia);
    this.parts.overhead = fascia;

    // What is on it, left to right, as in the reference: a hailer, the AIS and radar repeats (left
    // to instruments.js), a bank of engine gauges in the middle, the VHF with its handset, and a
    // small switch panel outboard.
    const face = 0.012;

    const hailer = new RadioSet('hailer', { width: 0.21, height: 0.082, brand: 'STANDARD', lcdText: '2', lcdSub: 'PA' });
    hailer.group.position.set(-1.24, 0.03, face);
    fascia.add(hailer.group);
    this.sets.push(hailer);

    const vhf = new RadioSet('vhf', { width: 0.21, height: 0.082, brand: 'ICOM', lcdText: '16', lcdSub: 'DUP' });
    vhf.group.position.set(0.96, 0.03, face);
    fascia.add(vhf.group);
    this.sets.push(vhf);
    // Its handset, hanging on a clip under the fascia on its curly cord.
    const hs = handset();
    hs.position.set(1.14, -H.overheadHeight / 2 - 0.02, 0.03);
    hs.rotation.set(-H.overheadRake * DEG, 0, 0.18);
    fascia.add(hs);
    this.parts.handset = hs;
    fascia.add(box(0.05, 0.03, 0.05, paint(0xc9ced2, 0.3, 0.85), 1.14, -H.overheadHeight / 2 + 0.02, 0.03));

    // The engine gauges: a bank of four over the centreline and two outboard of them. Their
    // numbers come from the boat every frame (update), which is the point of modelling the needle.
    const spec = [
      ['tacho', { label: 'TACH', unit: 'rpm x100', min: 0, max: 30, major: 5, minor: 1, redFrom: 24 }, -0.56],
      ['temp', { label: 'TEMP', unit: 'deg C', min: 40, max: 120, major: 20, minor: 5, redFrom: 100 }, -0.34],
      ['oil', { label: 'OIL', unit: 'bar', min: 0, max: 8, major: 2, minor: 0.5, redFrom: 7 }, -0.12],
      ['volts', { label: 'VOLTS', unit: 'DC', min: 8, max: 16, major: 2, minor: 0.5, redFrom: null }, 0.10],
      ['rudder', { label: 'RUDDER', unit: 'deg', min: -35, max: 35, major: 10, minor: 5, redFrom: null }, 0.36],
      ['clino', { label: 'HEEL', unit: 'deg', min: -30, max: 30, major: 10, minor: 5, redFrom: null }, 0.60],
    ];
    for (const [name, opts, x] of spec) {
      const gauge = new Gauge({ ...opts, diameter: 0.098, start: opts.min });
      gauge.group.position.set(x, 0.0, face);
      fascia.add(gauge.group);
      this.gauges[name] = gauge;
    }

    // A small bank of switches at the outboard end, and the deckhead lamps under the fascia.
    const bank = new SwitchBank(['chart lt', 'dome', 'red', 'inst'], { width: 0.24, height: 0.20, title: null, on: [3] });
    bank.group.position.set(1.36, 0.0, face);
    fascia.add(bank.group);
    this.banks.push(bank);

    this.parts.domeLamps = [];
    for (const x of [-0.95, 0.95]) {
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.055, 18, 12, 0, TAU, Math.PI * 0.5, Math.PI * 0.5),
        new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xffeedd, emissiveIntensity: 0, roughness: 0.35 }));
      lens.position.set(x, HOUSE.deckhead - 0.03, -0.55);
      lens.rotation.x = Math.PI;
      this.add(lens);
      this.add(box(0.14, 0.016, 0.14, this.cherry, x, HOUSE.deckhead - 0.012, -0.55));
      const light = new THREE.PointLight(0xffe9cf, 0, 5.5, 2);
      light.position.set(x, HOUSE.deckhead - 0.10, -0.55);
      this.add(light);
      this.lamps.push(light);
      this.parts.domeLamps.push({ light, lens });
    }
  }

  // --- the side desks --------------------------------------------------------------------------

  buildSideDesks() {
    const H = HOUSE;
    const cherry = this.cherry;
    const d = H.deskBack - H.deskFront;
    for (const s of [-1, 1]) {
      const w = H.halfWidth - H.deskInboard;
      const cx = s * (H.deskInboard + w / 2);
      // The top and its nosing.
      const top = this.add(box(w, 0.042, d, cherry, cx, H.deskTop, (H.deskFront + H.deskBack) / 2));
      top.receiveShadow = true;
      this.add(nosing(d, 0.026, cherry, s * H.deskInboard, H.deskTop - 0.005, (H.deskFront + H.deskBack) / 2, false));
      // A fiddle along the outboard and forward edges, so nothing slides off in a sea.
      this.add(box(0.018, 0.045, d, cherry, s * (H.halfWidth - 0.015), H.deskTop + 0.042, (H.deskFront + H.deskBack) / 2));
      this.add(box(w, 0.045, 0.018, cherry, cx, H.deskTop + 0.042, H.deskFront + 0.01));

      // Lockers under: two louvred doors and a bank of three drawers.
      const lockH = H.deskTop - H.sole - 0.10;
      const door = louvreDoor(w * 0.92, lockH * 0.98, cherry);
      door.position.set(cx, H.sole + 0.10 + lockH / 2, H.deskFront + 0.02);
      this.group.add(door);
      const chrome = paint(0xcdd1d5, 0.26, 0.88);
      for (let i = 0; i < 3; i++) {
        const dh = (d - 0.10) / 3;
        const z = H.deskFront + 0.30 + i * dh + dh / 2;
        const front = this.add(panel(dh - 0.012, lockH - 0.02, cherry, s * (H.deskInboard - 0.012), H.sole + 0.10 + lockH / 2, z));
        front.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.add(bar(
          v3(s * (H.deskInboard - 0.03), H.sole + 0.10 + lockH * 0.5, z - dh * 0.22),
          v3(s * (H.deskInboard - 0.03), H.sole + 0.10 + lockH * 0.5, z + dh * 0.22),
          0.010, chrome, 10));
      }
      // The plinth.
      this.add(box(w, 0.10, d - 0.06, this.cherryPanel, cx, H.sole + 0.05, (H.deskFront + H.deskBack) / 2));
    }

    // To starboard, the flat screen on its stand that the reference has over the desk.
    const mon = new THREE.Group();
    mon.position.set(1.30, H.deskTop + 0.021, 0.10);
    const base = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.075, 0.085, 0.016, 20), 0.5, 0.016), paint(0x1a1d20, 0.42, 0.5));
    mon.add(base);
    mon.add(bar(v3(0, 0.008, 0), v3(0, 0.17, -0.02), 0.014, paint(0x1a1d20, 0.42, 0.5), 10));
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.26, 0.016), paint(0x15171a, 0.48, 0.2));
    bezel.position.set(0, 0.30, -0.03);
    bezel.rotation.set(-0.12, -0.42, 0);
    mon.add(bezel);
    this.group.add(mon);
    this.parts.monitor = bezel;

    // To port, the chart table's fiddled binder and a pair of dividers: the two things that are
    // always on one.
    const binder = this.add(box(0.30, 0.035, 0.22, paint(0x24303a, 0.72, 0.02), -1.34, H.deskTop + 0.040, 0.18));
    binder.rotation.y = 0.18;
    this.add(box(0.012, 0.004, 0.17, paint(0xb8bcc0, 0.3, 0.85), -1.16, H.deskTop + 0.024, -0.06));
  }

  // --- the seats -------------------------------------------------------------------------------

  /**
   * Two helm chairs in cream leather on chrome pedestals, abaft the wheel. They are behind the eye
   * and so are only seen when the cursor swings the gaze aft, but the room is wrong without them:
   * from the door this is the first thing you see.
   */
  buildSeats() {
    const H = HOUSE;
    const hide = this.mat('mat:leather-cream', { key: 'hide', tint: 0xe6ddcb, roughness: 0.52 });
    const chrome = paint(0xcdd1d5, 0.24, 0.9);
    this.parts.seats = [];
    for (const s of [-1, 1]) {
      const seat = new THREE.Group();
      seat.position.set(s * 0.60, H.sole, 0.92);
      // The pedestal and its foot.
      seat.add(new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.20, 0.23, 0.035, 22), 1.3, 0.035), chrome).translateY(0.018));
      seat.add(new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.055, 0.055, 0.48, 18), 0.35, 0.48), chrome).translateY(0.27));
      // The squab, its front edge rolled.
      const squab = box(0.50, 0.11, 0.46, hide, 0, 0.56, 0);
      seat.add(squab);
      seat.add(nosing(0.50, 0.055, hide, 0, 0.555, -0.23));
      // The back, raked, with a roll along its top.
      const back = box(0.48, 0.52, 0.10, hide, 0, 0.84, 0.20);
      back.rotation.x = -0.14;
      seat.add(back);
      seat.add(nosing(0.48, 0.05, hide, 0, 1.095, 0.165));
      // Armrests.
      for (const a of [-1, 1]) {
        const arm = box(0.07, 0.065, 0.34, hide, a * 0.265, 0.70, 0.02);
        seat.add(arm);
        seat.add(bar(v3(a * 0.265, 0.62, 0.15), v3(a * 0.265, 0.68, 0.15), 0.011, chrome, 8));
      }
      this.group.add(seat);
      this.parts.seats.push(seat);
    }
  }

  // --- the small things ------------------------------------------------------------------------

  buildFittings() {
    const H = HOUSE;
    const cherry = this.cherry;
    const brass = paint(0x9a7a34, 0.3, 0.86);

    // A grab rail under the overhead fascia, which is what you hold standing up into a sea.
    this.add(bar(v3(-1.30, H.deckhead - 0.14, -0.74), v3(1.30, H.deckhead - 0.14, -0.74), 0.016, paint(0xcdd1d5, 0.24, 0.9), 14));
    for (const x of [-1.28, 0, 1.28]) {
      this.add(bar(v3(x, H.deckhead - 0.14, -0.74), v3(x, H.deckhead - 0.02, -0.80), 0.012, paint(0xcdd1d5, 0.24, 0.9), 10));
    }

    // A brass clock and a barometer on the aft bulkhead, the pair every wheelhouse has.
    for (const [x, label, unit, min, max, major, minor] of [
      [0.62, 'CLOCK', '', 0, 12, 3, 1],
      [0.92, 'BAROMETER', 'mb', 960, 1050, 30, 10],
    ]) {
      const g = new Gauge({ label, unit, min, max, major, minor, dark: false, diameter: 0.145, maker: 'WEMPE', start: (min + max) / 2 });
      g.group.position.set(x, 5.58, H.back - 0.045);
      g.group.rotation.y = Math.PI;
      this.group.add(g.group);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.012, 10, 32), brass);
      ring.position.set(x, 5.58, H.back - 0.050);
      ring.rotation.y = Math.PI;
      this.add(ring);
      this.gauges[label.toLowerCase()] = g;
    }

    // A teak shelf on the port wall aft, with a fiddle: the one flat place in the room.
    const shelf = this.add(box(0.24, 0.035, 0.80, cherry, -H.halfWidth + 0.12, 5.44, 1.20));
    this.parts.shelf = shelf;
    this.shelfTop = 5.44 + 0.0175;
    this.add(box(0.022, 0.05, 0.80, cherry, -H.halfWidth + 0.23, 5.4725, 1.20));
    this.add(box(0.26, 0.05, 0.05, cherry, -H.halfWidth + 0.13, 5.415, 0.82));

    // A mug on the dash: it slides when she rolls (update), and fetches up against the rail.
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
    mug.position.set(-0.34, H.dashTop + 0.021, H.dashBack - 0.17);
    this.group.add(mug);
    this.parts.mug = mug;
    this.mugX = -0.30;
    this.mugV = 0;
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
    add(this.parts.instrumentPanel, 'radar');
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
    // The single-lever head: ahead is forward, and it comes back to the detent at neutral.
    if (this.parts.levers) this.parts.levers[0].rotation.x = lerp(0.40, -0.50, boat.throttle);

    // The gauges read the boat. A needle that does not move is a sticker.
    const g = this.gauges;
    if (g.tacho) g.tacho.set(boat.rpm ? boat.rpm / 100 : boat.throttle * 22 + 5);
    if (g.temp) g.temp.set(62 + boat.throttle * 24);
    if (g.oil) g.oil.set(2.4 + boat.throttle * 2.2);
    if (g.volts) g.volts.set(13.8 + Math.sin(this.lampLevel ?? 0) * 0.1);
    if (g.rudder) g.rudder.set(-boat.rudder * 35);
    if (g.clino) g.clino.set(boat.roll * 57.2957795);
    if (g.clock) g.clock.set(((G.uDayTime.value * 24) % 12));

    // The mug slides on the dash when she rolls, and fetches up against the rail.
    if (this.parts.mug) {
      const a = Math.sin(boat.roll) * 9.81 - boat.rate.x * 0.4;
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

    this.setFill(G.uSkyLight.value);
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
    const red = state?.redLight ? 1 : 0;
    const off = state?.lampsOff ? 0 : 1;
    const want = Math.max(night, state?.redLight ? 1 : 0) * off;
    this.lampLevel = lerp(this.lampLevel ?? 0, want, 1 - Math.exp(-dt / 1.1));
    const screen = state?.emissiveScale ?? 1;
    for (const { light, lens } of this.parts.domeLamps ?? []) {
      light.intensity = this.lampLevel * (red ? 0.0011 : 0.0026);
      light.color.setRGB(1, red ? 0.12 : 0.88, red ? 0.07 : 0.68);
      lens.material.emissive.setRGB(1, red ? 0.14 : 0.94, red ? 0.08 : 0.82);
      lens.material.emissiveIntensity = this.lampLevel * (red ? 0.45 : 0.75) * screen;
    }
    // The tell-tales in the switch banks and the sets' displays, all screen brightnesses.
    const panelLit = Math.max(0.15, this.lampLevel);
    for (const b of this.banks) b.setLamps(panelLit, screen);
    for (const s of this.sets) s.setLit(Math.max(0.35, this.lampLevel), screen);
  }

  dispose() {
    for (const b of this.banks) b.dispose();
    for (const s of this.sets) s.dispose();
    for (const g of Object.values(this.gauges)) g.dispose();
    this.soleTex?.dispose();
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
 * it that every other surface uses. deck.js and wildlife.js use it, for the props out on the
 * foredeck and the channel marks: nothing in the wheelhouse is a downloaded model any more.
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
