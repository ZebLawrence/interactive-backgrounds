// Trawler — The wheelhouse: the room the whole background is seen from.
//
// Built to the owner's reference photograph of a trawler yacht's pilot house, region by region:
// varnished cherry joinery everywhere; windows with radiused corners in cherry frames with black
// gaskets, set in a cream-painted house side; a cherry pod across the dash carrying a wide nav
// display, a fishfinder, the autopilot stack and three engine gauges under a compass; a thin-rim
// five-spoke stainless wheel on a chrome column; a twin-lever chrome engine control; breaker panels
// in raised cherry frames either side of the wheel, each toggle lit by its own red tell-tale; an
// overhead fascia of gauges, repeaters, the VHF and its handset; side desks with fiddle rails cut
// with oval handholds, two rows of drawers with routed pulls and louvred doors under them; a monitor,
// keyboard, handhelds in their cradle and a thruster stick to starboard; two cream leather helm
// chairs with bolstered seats and winged backs; a teak-and-holly sole.
//
// Nothing in here is a downloaded model. The joinery, the leather and the enamel are scanned
// materials (CC0, see the README); every instrument and set is modelled in panel.js as the real one
// is shaped - a case is a bevelled extrusion, a key is a cap you could press, a knob is turned - with
// its printing drawn at better than 5000 pixels to the metre, because nobody publishes a CC0 scan of
// a marine instrument and a drawn one can be made exactly as sharp as it needs to be.
//
// Body coordinates: +x starboard, +y up, +z aft, y = 0 at the waterline.
//
//   4.00  the sole
//   4.80  the dash top, the side desks
//   4.90  the wheel's centre
//   4.98  the windscreen sill
//   5.52  the helmsman's eye
//   6.02  the windscreen head
//   6.14  the deckhead
//
// The composition, worked out from those numbers rather than by nudging a camera about: the eye is
// 1.58 m back from the windscreen, whose sill is 0.54 m below it and whose head is 0.50 m above it.
// Through a 62 degree lens pitched three degrees down the glass fills the middle of the frame, the
// pod on the dash takes the bottom sixth, and the deckhead and the overhead fascia take the top
// fifth. The two front window frames sit 24 degrees off the centreline, clear of where the bow and
// the horizon are. Those numbers are why every rebuild has kept the window openings where they were
// and changed everything inside them.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ } from './shaders.js';
import { Materials, paint, metreUvsBox, metreUvsPlane, scaleUvs } from './materials.js';
import {
  Gauge, VhfSet, Handset, EngineControl, BreakerPanel, SwitchPanel, Hailer,
  blankPanel, chartLight, handheldVhf, joystick, compassDome, wallPlate, louvreDoor, label,
  roundedRectShape, lathe, PLASTIC, chromeMaterial, setChromeLevel,
} from './panel.js';
import { v3, DEG, TAU, lerp, clamp01, Art } from './util.js';

export const HOUSE = {
  sole: 4.00,
  deckhead: 6.14,
  halfWidth: 1.72,
  front: -1.40, // the windscreen sill's z
  frontTop: -1.56, // the windscreen head's z: the glass rakes forward, as a working boat's does
  back: 1.75,
  // The windscreen opening. The sill is 0.54 m below the eye, which leaves room under it for the
  // dash and its pod without either of them climbing into the view.
  sill: 4.98,
  head: 6.02,
  glassHalf: 1.55,
  mullion: 0.70, // the two front window divisions, either side of the centreline
  mullionWidth: 0.13,
  frameInset: 0.04, // how far each window's frame overlaps its glass
  // The side windows.
  sideSill: 4.90,
  sideHead: 5.82,
  // The dash: a counter at desk height across the front of the room, the pod standing on it.
  dashTop: 4.80,
  dashFront: -1.34,
  dashBack: -0.72,
  podZ: -1.04, // the pod's face, at its foot
  podHeight: 0.38,
  podDepth: 0.22,
  podRake: 12,
  // The overhead fascia: a cherry panel hung under the deckhead above the window head, raked down
  // toward the helmsman, carrying the gauges and the sets.
  overheadY: 6.00,
  overheadZ: -1.10,
  overheadRake: 34,
  overheadHeight: 0.30,
  // The side desks: a chart table to port and a desk with a screen to starboard.
  deskTop: 4.80,
  deskInboard: 1.14,
  deskFront: -0.70,
  deskBack: 0.72,
  // The wheel: hung on a column from the dash's face, its upper half rising in front of the pod.
  wheelZ: -0.50,
  wheelY: 4.90,
  wheelR: 0.34,
  wheelTilt: 10,
};

/**
 * Polished stainless: the wheel, the column, the pulls. A matcap of the room (panel.js), because
 * this renderer has no environment to reflect and a lit grey came out as pale plastic. It was
 * tried as a full metal (black: no diffuse and nothing to reflect) and as a part-metal (flat); the
 * wheel in the reference is bright where it faces the windows and dark where it faces the dash,
 * and only a reflection does that.
 */
const PILOT_CHROME = () => chromeMaterial(1);

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

/** A length of round bar between two points: handrails, the wheel's spokes, a bullnose edge. */
function bar(a, b, radius, material, segments = 12) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = scaleUvs(new THREE.CylinderGeometry(radius, radius, len, segments, 1), TAU * radius, len);
  const m = new THREE.Mesh(g, material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.normalize());
  return m;
}

/** A capsule - a rounded cushion or a bolster - along x, y or z, UVs in metres. */
function capsule(r, len, axis, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(scaleUvs(new THREE.CapsuleGeometry(r, len, 6, 18), TAU * r, len + 2 * r), material);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  else if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

/**
 * A window frame as this wheelhouse has them: cherry, with the inside corners radiused, a bevel on
 * its room-side edge, and a black rubber gasket between it and the glass. Built in the plane of the
 * glass with +z toward the room; `w` and `h` are the opening the frame surrounds.
 */
function windowFrame(w, h, material, { t = 0.055, depth = 0.030, gasket = 0.014, rOuter = 0.10, rInner = 0.07 } = {}) {
  const g = new THREE.Group();
  const outer = roundedRectShape(w + 2 * t, h + 2 * t, rOuter);
  outer.holes.push(roundedRectShape(w, h, rInner));
  const fg = new THREE.ExtrudeGeometry(outer, {
    depth: depth - 0.008, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 10,
  });
  fg.computeVertexNormals();
  const frame = new THREE.Mesh(fg, material);
  frame.position.z = 0.006;
  g.add(frame);
  const ring = roundedRectShape(w + 0.004, h + 0.004, rInner);
  ring.holes.push(roundedRectShape(w - 2 * gasket, h - 2 * gasket, Math.max(rInner - gasket, 0.01)));
  const rubber = new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: 0.010, bevelEnabled: false, curveSegments: 10 }), PLASTIC.rubber());
  rubber.position.z = 0.002;
  g.add(rubber);
  return g;
}

/**
 * A fiddle rail: the raised lip round a desk that stops things sliding off in a sea, cut with the
 * oval handholds the reference has along every edge. Built lying along x, standing in y, with its
 * thickness along z; the caller turns it.
 */
function fiddle(length, height, thickness, material, { slot = 0.16, slotH = 0.026, pitch = 0.36 } = {}) {
  const s = roundedRectShape(length, height, 0.004);
  const n = Math.max(1, Math.floor((length - 0.16) / pitch));
  const x0 = -((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) s.holes.push(roundedRectShape(slot, slotH, slotH / 2, x0 + i * pitch, height * 0.08));
  const g = new THREE.ExtrudeGeometry(s, {
    depth: thickness - 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 8,
  });
  g.computeVertexNormals();
  g.translate(0, 0, 0.003);
  return new THREE.Mesh(g, material);
}

/**
 * A routed finger pull of the kind on every drawer in the reference: an oval scoop with a bevelled
 * lip that catches the light. The scoop is a dark disc flush with the front and the lip is proud
 * of it, which is the opposite of how it is cut and the same in every way the eye can tell.
 */
function routedPull(material, w = 0.10, h = 0.034) {
  const g = new THREE.Group();
  const inner = roundedRectShape(w - 0.012, h - 0.012, (h - 0.012) / 2);
  const lip = roundedRectShape(w, h, h / 2);
  lip.holes.push(roundedRectShape(w - 0.012, h - 0.012, (h - 0.012) / 2));
  const lg = new THREE.ExtrudeGeometry(lip, { depth: 0.001, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 8 });
  lg.computeVertexNormals();
  const lipMesh = new THREE.Mesh(lg, material);
  lipMesh.position.z = 0.002;
  g.add(lipMesh);
  const scoop = new THREE.Mesh(new THREE.ShapeGeometry(inner, 8), paint(0x3b2512, 0.6, 0));
  scoop.position.z = 0.0006;
  g.add(scoop);
  return g;
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
      ctx.fillStyle = `rgb(${base + 20}, ${base - 4}, ${base - 46})`;
      ctx.fillRect(x, 0, plank, h);
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
      ctx.fillStyle = '#efe9d6';
      ctx.fillRect(x, 0, plank * 0.075, h);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x + plank * 0.075, 0, plank * 0.02, h);
    }
  });
}

/** A computer keyboard's key field, drawn: the one on the starboard desk. */
function keyboardTexture() {
  return Art.image(768, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1a1c1f';
    ctx.fillRect(0, 0, w, h);
    const rows = [14, 14, 13, 12, 8];
    rows.forEach((n, r) => {
      const kw = (w * 0.94) / 14, kh = h * 0.17, y = h * 0.06 + r * (kh + h * 0.02);
      for (let i = 0; i < n; i++) {
        const wide = r === 4 && i === 3 ? 5 : 1;
        const x = w * 0.03 + (r === 4 ? (i < 3 ? i : i + 4) : i) * kw;
        ctx.fillStyle = '#2b2e33';
        ctx.fillRect(x + 2, y, kw * wide - 4, kh);
        ctx.fillStyle = '#3a3e44';
        ctx.fillRect(x + 4, y + 2, kw * wide - 8, kh * 0.6);
        if (r === 4 && i === 3) i += 4;
      }
    });
  });
}

export class PilotHouse {
  /**
   * @param {THREE.Scene} scene
   * @param {Materials} materials
   * @param {import('./util.js').Rng} rng
   */
  constructor(scene, materials, rng, glassMaterial = null, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.materials = materials;
    this.rng = rng;
    this.glassMaterial = glassMaterial;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    scene.add(this.group);

    this.lamps = [];
    this.parts = {};
    this.mounts = {};
    this.buildFill();
    this.gauges = {};
    this.panels = [];
    this.sets = [];
    this.panes = [];
    this.lampMode = 'white';
    this.build();
    this.group.traverse((o) => {
      o.layers.set(LAYER.DEFAULT);
      o.layers.enable(LAYER.INTERIOR);
      if (o.isMesh && o.material && !o.material.transparent) {
        o.receiveShadow = true;
        // Only things of a size cast a shadow: a wheelhouse full of key caps and toggles would
        // double the shadow pass for shadows no one could see.
        o.geometry.computeBoundingSphere();
        const r = o.geometry.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z);
        o.castShadow = r > 0.04;
      }
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
   * So the house carries its own fill: warm from above (the deckhead), cool from below (the water
   * through the glass), scaled by the real sky irradiance so it follows the day down to nothing at
   * night, and on the interior layer so that it reaches the room and not the sea.
   */
  buildFill() {
    this.fill = new THREE.HemisphereLight(0xfff1dc, 0x8fb4c8, 0);
    this.fill.position.set(0, HOUSE.deckhead, (HOUSE.front + HOUSE.back) / 2);
    this.fill.layers.set(LAYER.INTERIOR);
    this.group.add(this.fill);
  }

  /**
   * Sets that fill from the sky's own irradiance.
   *
   * A modest number, deliberately. An earlier pass had this at forty and used it to drag the whole
   * cabin up to the brightness of the reference photograph - which worked on the timber and blew
   * every white surface in the room to paper, because a flat fill of that size is thirteen times
   * the entire sky. What the photograph actually shows is a camera exposed for the inside of a
   * room, and that is a question for the meter (see EXPOSURE in scene.js), not for the lamps. So
   * this is left at what it is for: several bounces of light round a varnished room with a cream
   * deckhead, about four times the sky's own term.
   */
  setFill(skyIrradiance) {
    if (!this.fill) return;
    const m = Math.max(skyIrradiance.x, skyIrradiance.y, skyIrradiance.z);
    this.fill.intensity = m * 8.0;
  }

  mat(tag, opts) { return this.materials.get(tag, opts); }
  add(mesh) { this.group.add(mesh); return mesh; }

  /**
   * The lacquered cherry everything in here is made of, shared so it is one material.
   *
   * The scan is a dark cherry and the reference is a honey one: measured at noon the scan's dash
   * top read 73 of 255 in red against the photograph's 190, with the hue right. So the tint is a
   * gain rather than a colour - a Color with components past one, which the loader copies into
   * the material as it is - and it is tuned to put the dash top where the photograph's is. The
   * grain's normal map is turned well down for the same reason: lacquer on cherry is satin, and at
   * full strength the scan's grain read as rough-sawn.
   */
  get cherry() {
    return this.mat('mat:cherry', { key: 'cherry', tint: new THREE.Color(2.6, 2.35, 1.8), roughness: 0.18, normalScale: 0.35 });
  }

  /** The same timber in a flatter veneer, for the big panels: the walls, the sill, the aft bulkhead. */
  get cherryPanel() {
    return this.mat('mat:cherry-panel', { key: 'cherry-panel', tint: new THREE.Color(1.05, 0.66, 0.36), roughness: 0.26, normalScale: 0.4 });
  }

  /** The cream-painted house side round the windows, and the headliner. */
  get cream() {
    return this.mat('mat:enamel', { key: 'cream', tint: 0xf3eee3, roughness: 0.62, side: THREE.DoubleSide });
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

    // The sole: teak and holly, laid fore and aft. The tile is one metre square and the plane's
    // uvs are already in metres, so it repeats once a metre on its own.
    this.soleTex = Art.texture(teakAndHollyTexture(), { repeat: true });
    const sole = this.add(new THREE.Mesh(
      metreUvsPlane(new THREE.PlaneGeometry(w, d), w, d),
      new THREE.MeshStandardMaterial({ map: this.soleTex, roughness: 0.34, metalness: 0, side: THREE.DoubleSide }),
    ));
    sole.rotation.x = -Math.PI / 2;
    sole.position.set(0, H.sole, midZ);
    sole.receiveShadow = true;

    // The headliner: cream vinyl with cherry trim strips, and recessed lights.
    const headMat = this.mat('mat:enamel', { key: 'deckhead', tint: 0xfbf7ef, roughness: 0.84, side: THREE.DoubleSide });
    const head = this.add(panel(w, d, headMat));
    head.rotation.x = Math.PI / 2;
    head.position.set(0, H.deckhead, midZ);
    head.receiveShadow = true;
    const batten = this.cherry;
    for (let z = H.front + 0.46; z < H.back - 0.2; z += 0.52) {
      this.add(box(w, 0.016, 0.055, batten, 0, H.deckhead - 0.010, z));
    }
    // The cornice where the headliner meets the walls, all round.
    for (const s of [-1, 1]) this.add(box(0.06, 0.05, d, batten, s * (H.halfWidth - 0.03), H.deckhead - 0.025, midZ));
    this.add(box(w, 0.05, 0.06, batten, 0, H.deckhead - 0.025, H.back - 0.03));

    // The recessed lights: a cream trim ring let into the headliner with a frosted lens, four of
    // them, white by day in the house and red at night (updateLamps).
    this.parts.domeLamps = [];
    const trimMat = paint(0xeee8dc, 0.5, 0);
    for (const [x, z] of [[-0.95, -0.55], [0.95, -0.55], [-0.95, 0.95], [0.95, 0.95]]) {
      const trim = lathe([[0.050, 0], [0.074, 0], [0.074, 0.006], [0.060, 0.013], [0.050, 0.013]], trimMat, 32);
      trim.rotation.x = Math.PI;
      trim.position.set(x, H.deckhead - 0.001, z);
      this.add(trim);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.050, 24),
        new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xffeedd, emissiveIntensity: 0, roughness: 0.35 }));
      lens.rotation.x = Math.PI / 2;
      lens.position.set(x, H.deckhead - 0.005, z);
      this.add(lens);
      const light = new THREE.PointLight(0xffe9cf, 0, 5.5, 2);
      light.position.set(x, H.deckhead - 0.10, z);
      this.add(light);
      this.lamps.push(light);
      this.parts.domeLamps.push({ light, lens });
    }

    // The side walls: cherry panelling below the side windows; the cream house side above them is
    // built with the windows (buildSideWindows), cut round their frames.
    const wallMat = this.cherryPanel;
    for (const s of [-1, 1]) {
      const lowerH = H.sideSill - 0.06 - H.sole;
      const lower = this.add(panel(d, lowerH, wallMat, s * H.halfWidth, H.sole + lowerH / 2, midZ));
      lower.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
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

  /** A pane of glass with its frame and gasket, placed and registered. */
  glaze(kind, w, h, position, rotation, { wall = null } = {}) {
    const mesh = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(w, h), w, h), this.glassMaterial ?? paint(0xffffff, 0.05, 0));
    mesh.position.copy(position);
    mesh.rotation.copy(rotation);
    mesh.renderOrder = 820;
    this.group.add(mesh);
    this.panes.push({ mesh, kind, width: w, height: h });
    const inset = HOUSE.frameInset;
    const frame = windowFrame(w - 2 * inset, h - 2 * inset, this.cherry);
    frame.position.copy(position);
    frame.rotation.copy(rotation);
    this.group.add(frame);
    if (wall) {
      // The painted house side round this window: a ring behind the glass's edge whose hole sits
      // just inside the frame's outer edge, so the frame hides the join.
      const p = this.wallRing(wall[0], wall[1], [[0, 0, w, h]]);
      p.position.copy(position);
      p.rotation.copy(rotation);
      p.translateZ(-0.014);
      this.group.add(p);
    }
    return mesh;
  }

  /**
   * A piece of the cream house side with window openings cut in it: `holes` are [x, y, paneW,
   * paneH] in the piece's own plane, each cut just inside where that pane's frame reaches.
   */
  wallRing(w, h, holes) {
    const inset = HOUSE.frameInset, t = 0.055;
    const shape = roundedRectShape(w, h, 0.01);
    for (const [x, y, pw, ph] of holes) shape.holes.push(roundedRectShape(pw - 2 * inset + 2 * t - 0.02, ph - 2 * inset + 2 * t - 0.02, 0.09, x, y));
    const g = new THREE.ShapeGeometry(shape, 10);
    return new THREE.Mesh(g, this.cream);
  }

  buildWindscreen() {
    const H = HOUSE;
    const frame = this.cherry;
    const rake = Math.atan2(H.frontTop - H.front, H.head - H.sill);
    const openH = H.head - H.sill;
    const glassH = openH / Math.cos(rake);
    const y = (H.sill + H.head) / 2;

    // Under the sill: the bulkhead the dash is built against.
    const sillH = H.sill - H.sole;
    const sillPanel = this.add(panel(H.halfWidth * 2, sillH, this.cherryPanel, 0, H.sole + sillH / 2, H.front - 0.012));
    sillPanel.rotation.y = Math.PI;

    // The sill capping with its bullnose, and the head rail - the valance - up to the deckhead.
    // These are the two horizontals that frame the view and they are 1.5 m from the eye.
    this.add(box(H.halfWidth * 2, 0.085, 0.14, frame, 0, H.sill - 0.062, H.front - 0.005));
    this.add(bar(v3(-H.halfWidth, H.sill - 0.062, H.front + 0.065), v3(H.halfWidth, H.sill - 0.062, H.front + 0.065), 0.0425, frame, 16));
    const railH = H.deckhead - H.head - 0.015;
    this.add(box(H.halfWidth * 2, railH, 0.10, frame, 0, H.head + 0.015 + railH / 2, H.frontTop + 0.03));

    // Three windows: a wide one on the centreline and a narrower one each side. The two divisions
    // are what the composition is built round, so they are placed and not nudged. Behind the
    // glass's edges, the cream house side shows between the frames.
    const spans = [
      [-H.glassHalf, -H.mullion - H.mullionWidth / 2],
      [-H.mullion + H.mullionWidth / 2, H.mullion - H.mullionWidth / 2],
      [H.mullion + H.mullionWidth / 2, H.glassHalf],
    ];
    const rot = new THREE.Euler(-rake, 0, 0);
    for (const [x0, x1] of spans) {
      const w = x1 - x0;
      this.glaze('FRONT', w, glassH, v3((x0 + x1) / 2, y, this.frontZ(y) + 0.004), rot);
    }
    // The house side across the front, in the plane of the glass behind it, with the three
    // openings cut in it: what shows between the frames.
    const frontWall = this.wallRing(H.glassHalf * 2 + 0.30, glassH + 0.10, spans.map(([x0, x1]) => [(x0 + x1) / 2, 0, x1 - x0, glassH]));
    frontWall.position.set(0, y, this.frontZ(y) + 0.004);
    frontWall.rotation.copy(rot);
    frontWall.translateZ(-0.014);
    this.add(frontWall);

    // The angled corner windows, which is what makes a wheelhouse of this kind look like one: a
    // narrow light each side running from the windscreen's outboard edge back to the side window.
    for (const s of [-1, 1]) {
      const cw = 0.42;
      const z = (this.frontZ(y) + H.front + 0.30) / 2;
      this.glaze('SIDE', cw, openH, v3(s * (H.glassHalf + 0.09), y, z), new THREE.Euler(0, -s * 52 * DEG, 0), { wall: [cw + 0.24, openH + 0.12] });
      // Its post at the outboard end and cappings top and bottom.
      const post = this.add(box(0.09, openH + 0.24, 0.11, frame, s * (H.halfWidth - 0.05), y, H.front + 0.30));
      post.rotation.y = s * 18 * DEG;
      for (const yy of [H.sill - 0.062, H.head + 0.015 + railH / 2]) {
        const cap = this.add(box(cw + 0.14, yy < H.sill ? 0.085 : railH, 0.11, frame, s * (H.glassHalf + 0.09), yy, z));
        cap.rotation.y = -s * 52 * DEG;
      }
    }
  }

  buildSideWindows() {
    const H = HOUSE;
    const frame = this.cherry;
    const openH = H.sideHead - H.sideSill;
    const y = (H.sideSill + H.sideHead) / 2;
    // Two lights each side, between the corner posts, each in its own radiused frame.
    const zs = [[H.front + 0.52, H.front + 1.52], [H.front + 1.62, H.back - 0.22]];
    for (const s of [-1, 1]) {
      const rot = new THREE.Euler(0, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0);
      for (const [z0, z1] of zs) {
        const w = z1 - z0;
        this.glaze('SIDE', w, openH, v3(s * (H.halfWidth - 0.012), y, (z0 + z1) / 2), rot);
      }
      // The cream house side above the cherry, with both lights cut out of it. In the wall's own
      // plane +x runs forward on one side and aft on the other, hence the sign on the holes.
      const d = H.back - H.front, zMid = (H.front + H.back) / 2;
      const upperH = H.deckhead - (H.sideSill - 0.06);
      const upper = this.wallRing(d, upperH, zs.map(([z0, z1]) => [-s * ((z0 + z1) / 2 - zMid), y - (H.sideSill - 0.06 + upperH / 2), z1 - z0, openH]));
      upper.position.set(s * (H.halfWidth - 0.002), H.sideSill - 0.06 + upperH / 2, zMid);
      upper.rotation.copy(rot);
      this.add(upper);
      // The sill ledge below the windows and the capping above.
      this.add(box(0.12, 0.08, H.back - H.front - 0.24, frame, s * (H.halfWidth - 0.055), H.sideSill - 0.06, (H.front + H.back) / 2 + 0.06));
      this.add(box(0.10, 0.08, H.back - H.front - 0.24, frame, s * (H.halfWidth - 0.045), H.sideHead + 0.06, (H.front + H.back) / 2 + 0.06));
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
    const doorFrame = windowFrame(gw - 0.06, gh - 0.06, this.cherry, { t: 0.04, rOuter: 0.06, rInner: 0.04 });
    doorFrame.position.set(dx, H.sole + 1.42, dz - 0.052);
    doorFrame.rotation.y = Math.PI;
    this.group.add(doorFrame);
    this.add(bar(v3(dx + 0.30, H.sole + 1.00, dz - 0.06), v3(dx + 0.30, H.sole + 1.18, dz - 0.06), 0.013, PILOT_CHROME(), 10));
  }

  // --- the dash --------------------------------------------------------------------------------

  buildDash() {
    const H = HOUSE;
    const cherry = this.cherry;
    const wHalf = 1.52;
    const topD = H.dashBack - H.dashFront;
    const chrome = PILOT_CHROME();

    // The counter, with a bullnose along its aft edge where a hand would rest.
    const top = this.add(box(wHalf * 2, 0.042, topD, cherry, 0, H.dashTop, (H.dashFront + H.dashBack) / 2));
    top.receiveShadow = true;
    this.add(bar(v3(-wHalf, H.dashTop, H.dashBack), v3(wHalf, H.dashTop, H.dashBack), 0.021, cherry, 16));
    this.parts.dashTop = top;

    // The face below it, the whole way to the sole, with a kick along the bottom. The breaker
    // panels are set into it either side of the wheel's column.
    const faceTop = H.dashTop - 0.021, faceBottom = H.sole + 0.08;
    this.add(box(wHalf * 2, faceTop - faceBottom, 0.05, cherry, 0, (faceTop + faceBottom) / 2, H.dashBack - 0.025));
    this.add(box(wHalf * 2, 0.08, 0.05, this.cherryPanel, 0, H.sole + 0.04, H.dashBack - 0.065));

    // The pod: a raked cherry case standing on the counter, its top edge bullnosed, carrying the
    // nav display, the fishfinder, the autopilot stack and the engine gauges. In the reference it
    // sits just under the window sill with its face square to the helmsman, which is the rake.
    const pod = new THREE.Group();
    pod.position.set(0, H.dashTop + 0.021, H.podZ);
    pod.rotation.x = -H.podRake * DEG;
    const podW = 1.72, podH = H.podHeight, podD = H.podDepth;
    pod.add(box(podW, podH - 0.02, podD, cherry, 0, (podH - 0.02) / 2, -podD / 2));
    pod.add(box(podW, 0.02, podD - 0.02, cherry, 0, podH - 0.01, -podD / 2 - 0.01));
    pod.add(bar(v3(-podW / 2, podH - 0.02, -0.02), v3(podW / 2, podH - 0.02, -0.02), 0.02, cherry, 16));
    this.group.add(pod);
    this.parts.pod = pod;
    this.parts.instrumentPanel = pod;
    const face = 0.004;

    // Where instruments.js hangs the live screens. Each is a bezelled display built there, so the
    // house only says where and how big.
    this.mounts.nav = { parent: pod, position: v3(-0.50, 0.235, face), size: [0.40, 0.20], keysRight: true, brand: 'FURUNO', keys: ['MENU', 'HOME', 'RNG+', 'RNG−', 'MOB', 'ENT'] };
    this.mounts.fish = { parent: pod, position: v3(0.07, 0.235, face), size: [0.26, 0.20], keysRight: true, brand: 'GARMIN', keys: ['MENU', 'GAIN', 'RNG+', 'RNG−', 'ENT'] };
    this.mounts.pilotHead = { parent: pod, position: v3(0.50, 0.305, face) };

    // The loudhailer under the autopilot head, and its hand mic on a clip beside the stack.
    const hailer = new Hailer();
    hailer.group.position.set(0.50, 0.17, face);
    pod.add(hailer.group);
    this.sets.push(hailer);
    const micAt = v3(0.675, 0.25, face + 0.040);
    const micSocket = v3(0.50 + 0.062, 0.17 - 0.036, face + 0.004);
    const mic = new Handset({ cordTo: micSocket.clone().sub(micAt) });
    mic.group.position.copy(micAt);
    mic.group.rotation.z = 0.06;
    pod.add(mic.group);
    this.handsets = [mic];
    pod.add(box(0.026, 0.010, 0.030, chrome, 0.675, 0.25 + 0.0336 + 0.005, face + 0.004 + 0.015));

    // The three engine gauges under the fishfinder: the tachometer a size up, as it always is.
    const dialSpec = [
      ['tacho', { label: 'TACH', unit: 'rpm x100', min: 0, max: 30, major: 5, minor: 1, redFrom: 24 }, -0.08, 0.098],
      ['temp', { label: 'TEMP', unit: 'deg C', min: 40, max: 120, major: 20, minor: 5, redFrom: 100 }, 0.05, 0.085],
      ['oil', { label: 'OIL', unit: 'bar', min: 0, max: 8, major: 2, minor: 0.5, redFrom: 7 }, 0.17, 0.085],
    ];
    for (const [name, opts, x, d] of dialSpec) {
      const gauge = new Gauge({ ...opts, diameter: d, start: opts.min });
      gauge.group.position.set(x, 0.085, face);
      pod.add(gauge.group);
      this.gauges[name] = gauge;
    }
    const tag = label('CAT C7  PORT MAIN', 0.12, 0.012);
    tag.position.set(0.045, 0.025, face);
    pod.add(tag);

    // The steering compass in its binnacle on the pod's top, level in the room though the pod is
    // raked, which is what a compass has to be.
    const compass = compassDome();
    const topLocal = v3(0, podH, -podD * 0.45).applyEuler(pod.rotation).add(pod.position);
    compass.position.copy(topLocal).add(v3(0, -0.004, 0));
    this.group.add(compass);
    this.parts.compass = compass;

    // The engine control on the counter to starboard of the wheel, where a hand falls on it.
    const control = new EngineControl();
    control.group.position.set(0.62, H.dashTop + 0.021, H.dashBack - 0.16);
    this.group.add(control.group);
    this.control = control;
    this.parts.quadrant = control.group;
    this.parts.levers = control.levers;

    // The breaker panels, in raised cherry frames across the dash's face: AC and DC to port of
    // the wheel, electronics and pumps to starboard. The wipers' breaker is the one a click works.
    const spec = [
      [-1.20, 'AC DISTRIBUTION', ['VOLTS AC', 'HERTZ'], ['shore 1', 'shore 2', 'inverter', 'water heater', 'galley', 'air con', 'battery chgr', 'outlets', 'washer', 'spare'], [0, 2, 3, 6, 7]],
      [-0.60, 'DC DISTRIBUTION', ['VOLTS', 'AMPS'], ['nav lights', 'anchor light', 'deck flood', 'steaming', 'wipers', 'horn', 'cabin lights', 'spreaders', 'bilge pump', 'fresh water', 'refrigeration', 'windlass'], [0, 3, 4, 5, 6, 8, 9, 10]],
      [0.60, 'ELECTRONICS', ['VOLTS', 'AMPS'], ['radar', 'chartplotter', 'sounder', 'VHF 1', 'VHF 2', 'autopilot', 'AIS', 'GPS', 'stabiliser', 'instruments', 'panel lights', 'spare'], [0, 1, 2, 3, 5, 6, 7, 8, 9, 10]],
      [1.20, 'PUMPS & TANKS', ['FUEL %', 'WATER %'], ['bilge fwd', 'bilge aft', 'shower sump', 'grey tank', 'black tank', 'wash down', 'fuel transfer', 'gen start'], [0, 1, 2]],
    ];
    for (const [x, title, meters, circuits, on] of spec) {
      const pw = 0.30, ph = 0.44;
      const yC = H.sole + 0.46;
      this.add(box(pw + 0.07, ph + 0.07, 0.03, cherry, x, yC, H.dashBack + 0.015));
      const p = new BreakerPanel(circuits, { width: pw, height: ph, title, meters, on });
      p.group.position.set(x, yC, H.dashBack + 0.031);
      this.group.add(p.group);
      this.panels.push(p);
      p.values = title.startsWith('AC') ? [118.0, 60.0] : title.startsWith('PUMPS') ? [64.0, 48.0] : [13.8, 14.2];
      if (title.startsWith('DC')) { this.parts.wiperSwitch = p.group; this.wiperPanel = p; this.wiperBreaker = circuits.indexOf('wipers'); }
    }
  }

  // --- the wheel -------------------------------------------------------------------------------

  buildWheel() {
    const H = HOUSE;
    const chrome = PILOT_CHROME();

    // The column: a chrome boss on the dash's face, a tube up to a knuckle behind the hub, and the
    // hub itself along the wheel's axis. A tilt helm's wheel is not square to its column, which
    // is what the knuckle is for.
    const base = v3(0, H.dashTop - 0.09, H.dashBack - 0.005);
    const hub = v3(0, H.wheelY, H.wheelZ);
    const axis = v3(0, Math.sin(H.wheelTilt * DEG), -Math.cos(H.wheelTilt * DEG)).negate(); // out of the wheel's face, toward the helmsman
    const knuckle = hub.clone().addScaledVector(axis, -0.085);
    const dir = knuckle.clone().sub(base).normalize();
    const boss = lathe([[0, 0], [0.060, 0], [0.064, 0.012], [0.064, 0.030], [0.050, 0.042], [0.034, 0.046], [0, 0.046]], chrome, 32);
    boss.position.copy(base);
    boss.quaternion.setFromUnitVectors(v3(0, 1, 0), dir);
    this.add(boss);
    this.add(bar(base.clone().addScaledVector(dir, 0.04), knuckle, 0.027, chrome, 20));
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.040, 20, 14), chrome);
    ball.position.copy(knuckle);
    this.add(ball);

    // The wheel itself: a thin-rimmed stainless destroyer wheel, five spokes, a domed hub with its
    // maker's badge. The rim is 22 mm, which is what makes it read as the reference's rather than
    // as a ship's wheel.
    const wheel = new THREE.Group();
    wheel.position.copy(hub);
    wheel.rotation.x = H.wheelTilt * DEG;
    const R = H.wheelR;
    wheel.add(new THREE.Mesh(scaleUvs(new THREE.TorusGeometry(R, 0.011, 12, 96), TAU * R, TAU * 0.011), chrome));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + Math.PI / 2;
      const d = v3(Math.cos(a), Math.sin(a), 0);
      wheel.add(bar(d.clone().multiplyScalar(0.040), d.clone().multiplyScalar(R - 0.006), 0.0055, chrome, 10));
    }
    const hubCan = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.046, 0.046, 0.060, 28), 0.29, 0.06), chrome);
    hubCan.rotation.x = Math.PI / 2;
    wheel.add(hubCan);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.046, 28, 16, 0, TAU, 0, Math.PI / 2), chrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.030;
    cap.scale.set(1, 1, 0.55);
    wheel.add(cap);
    const badge = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), paint(0x9a7a34, 0.3, 0.6));
    badge.position.z = 0.0555;
    wheel.add(badge);
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
    fascia.add(box(w, H.overheadHeight, 0.016, cherry, 0, 0, 0));
    fascia.add(box(w, H.overheadHeight - 0.02, 0.15, cherry, 0, 0, -0.08));
    // A cherry strip along its bottom edge, where it meets the headliner.
    fascia.add(bar(v3(-w / 2, -H.overheadHeight / 2, 0.006), v3(w / 2, -H.overheadHeight / 2, 0.006), 0.012, cherry, 12));
    this.group.add(fascia);
    this.parts.overhead = fascia;
    const face = 0.012;

    // What is on it, left to right, as in the reference: a blanking panel; the AIS and the
    // stabiliser's display; a switch panel; a single gauge; the six-gauge cluster; another single
    // gauge; a second switch panel; the VHF with its handset on a clip; the heading repeater; and
    // the nav data display at the end.
    fascia.add(blankPanel(0.26, 0.19).translateX(-1.29).translateZ(face));
    this.mounts.ais = { parent: fascia, position: v3(-1.015, 0.0, face), size: [0.13, 0.085], brand: 'AIS', keys: ['MENU', 'ENT', 'ESC'] };
    this.mounts.trac = { parent: fascia, position: v3(-0.74, 0.0, face), size: [0.17, 0.11], brand: 'TRAC', keys: ['ON', 'OFF', 'MODE', 'SET'] };

    const sp1 = new SwitchPanel(['NAV', 'ANCHOR', 'DECK', 'SPOT'], { title: 'LIGHTING', lit: [0] });
    sp1.group.position.set(-0.485, 0.0, face);
    fascia.add(sp1.group);
    this.panels.push(sp1);

    const singles = [
      ['rudder', { label: 'RUDDER', unit: 'deg', min: -35, max: 35, major: 10, minor: 5 }, -0.3175, 0.0],
      ['clino', { label: 'HEEL', unit: 'deg', min: -30, max: 30, major: 10, minor: 5 }, 0.22, 0.0],
    ];
    const cluster = [
      ['tacho2', { label: 'TACH', unit: 'rpm x100', min: 0, max: 30, major: 5, minor: 1, redFrom: 24 }, -0.125, 0.06],
      ['temp2', { label: 'TEMP', unit: 'deg C', min: 40, max: 120, major: 20, minor: 5, redFrom: 100 }, -0.025, 0.06],
      ['oil2', { label: 'OIL', unit: 'bar', min: 0, max: 8, major: 2, minor: 0.5, redFrom: 7 }, 0.075, 0.06],
      ['volts', { label: 'VOLTS', unit: 'DC', min: 8, max: 16, major: 2, minor: 0.5 }, -0.125, -0.055],
      ['fuel', { label: 'FUEL', unit: '%', min: 0, max: 100, major: 25, minor: 5 }, -0.025, -0.055],
      ['trans', { label: 'TRANS', unit: 'bar', min: 0, max: 30, major: 10, minor: 2, redFrom: 26 }, 0.075, -0.055],
    ];
    for (const [name, opts, x, y] of [...singles, ...cluster]) {
      const gauge = new Gauge({ ...opts, diameter: 0.085, start: opts.min });
      gauge.group.position.set(x, y, face);
      fascia.add(gauge.group);
      this.gauges[name] = gauge;
    }
    fascia.add(label('STBD MAIN  CAT C7', 0.14, 0.012).translateX(-0.025).translateY(-0.125).translateZ(face));

    const sp2 = new SwitchPanel(['HORN', 'WIPERS', 'WASH', 'DEFROST'], { title: 'DECK', lit: [1] });
    sp2.group.position.set(0.39, 0.0, face);
    fascia.add(sp2.group);
    this.panels.push(sp2);

    // The VHF, its handset on a clip to the right of it, and the cord between them.
    const vhf = new VhfSet();
    vhf.group.position.set(0.646, 0.0, face);
    fascia.add(vhf.group);
    this.sets.push(vhf);
    this.parts.vhf = vhf.group;
    const hsAt = v3(0.862, -0.02, face + 0.040);
    const socket = vhf.group.position.clone().add(vhf.socket);
    const hs = new Handset({ cordTo: socket.clone().sub(hsAt) });
    hs.group.position.copy(hsAt);
    hs.group.rotation.z = 0.05;
    fascia.add(hs.group);
    this.handsets.push(hs);
    this.parts.handset = hs.group;
    fascia.add(box(0.026, 0.010, 0.030, PILOT_CHROME(), 0.862, -0.02 + 0.0336 + 0.005, face + 0.004 + 0.015));

    const hdg = new Gauge({ label: 'HDG', unit: 'deg', min: 0, max: 360, major: 90, minor: 30, blue: true, maker: 'RITCHIE', diameter: 0.090, start: 0 });
    hdg.group.position.set(0.992, 0.0, face);
    fascia.add(hdg.group);
    this.gauges.hdg = hdg;

    this.mounts.navData = { parent: fascia, position: v3(1.217, 0.0, face), size: [0.19, 0.15], brand: 'FURUNO', keys: ['PAGE', 'MENU', 'MOB', 'ENT', 'ESC'] };
    fascia.add(label('NAV DATA', 0.08, 0.011).translateX(0.992).translateY(-0.085).translateZ(face));
  }

  // --- the side desks --------------------------------------------------------------------------

  buildSideDesks() {
    const H = HOUSE;
    const cherry = this.cherry;
    const d = H.deskBack - H.deskFront;
    const zMid = (H.deskFront + H.deskBack) / 2;
    const chrome = PILOT_CHROME();
    for (const s of [-1, 1]) {
      const w = H.halfWidth - H.deskInboard;
      const cx = s * (H.deskInboard + w / 2);
      // The top, and the fiddle rails along its inboard and aft edges, cut with handholds.
      const top = this.add(box(w, 0.042, d, cherry, cx, H.deskTop, zMid));
      top.receiveShadow = true;
      const inboardRail = fiddle(d, 0.05, 0.022, cherry);
      inboardRail.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      inboardRail.position.set(s * (H.deskInboard - 0.011), H.deskTop + 0.021 + 0.025, zMid);
      this.add(inboardRail);
      const aftRail = fiddle(w - 0.022, 0.05, 0.022, cherry, { pitch: 0.30 });
      aftRail.rotation.y = Math.PI;
      aftRail.position.set(cx + s * 0.011, H.deskTop + 0.021 + 0.025, H.deskBack - 0.011);
      this.add(aftRail);
      this.add(bar(v3(s * H.deskInboard, H.deskTop + 0.021 + 0.05, H.deskFront), v3(s * H.deskInboard, H.deskTop + 0.021 + 0.05, H.deskBack), 0.011, cherry, 12));

      // The carcass below, and on its inboard face two rows of drawers over louvred doors, every
      // drawer with a routed pull. The third bay is drawers all the way down.
      const lockH = H.deskTop - 0.021 - (H.sole + 0.10);
      this.add(box(w - 0.02, lockH, d - 0.02, cherry, cx + s * 0.01, H.sole + 0.10 + lockH / 2, zMid));
      this.add(box(w - 0.06, 0.10, d - 0.08, this.cherryPanel, cx, H.sole + 0.05, zMid));
      const bays = 3, gap = 0.018;
      const bayW = (d - gap * (bays + 1)) / bays;
      const rowH = 0.16;
      const faceX = s * (H.deskInboard - 0.001);
      const rotY = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      for (let b = 0; b < bays; b++) {
        const z = H.deskFront + gap + bayW / 2 + b * (bayW + gap);
        const rows = b === 2 ? 4 : 2;
        for (let r = 0; r < rows; r++) {
          const y = H.deskTop - 0.021 - gap - rowH / 2 - r * (rowH + gap);
          const front = this.add(panel(bayW, rowH, cherry, faceX, y, z));
          front.rotation.y = rotY;
          const pull = routedPull(cherry);
          pull.position.set(faceX, y, z);
          pull.rotation.y = rotY;
          pull.translateZ(0.0005);
          this.group.add(pull);
        }
        if (rows === 2) {
          const doorTop = H.deskTop - 0.021 - gap - 2 * (rowH + gap);
          const doorH = doorTop - (H.sole + 0.10) - gap;
          const dw = (bayW - gap) / 2;
          for (const k of [-1, 1]) {
            const door = louvreDoor(dw, doorH, cherry, { hinge: -k, slat: 0.024, frame: 0.045 });
            door.position.set(faceX - s * 0.011, doorTop - gap / 2 - doorH / 2, z + k * (dw + gap) / 2);
            door.rotation.y = rotY;
            this.group.add(door);
          }
        }
      }
      // A chart light at the outboard aft corner of each desk.
      const lamp = chartLight(0.30, -s * 0.16);
      lamp.position.set(s * (H.halfWidth - 0.14), H.deskTop + 0.021, H.deskBack - 0.14);
      this.add(lamp);
      this.chartBulbs = this.chartBulbs ?? [];
      this.chartBulbs.push(lamp.userData.bulb);
    }

    // To starboard: the monitor on its stand, the keyboard and mouse, the two handhelds standing
    // in their cherry cradle under the window, and the thruster stick at the inboard corner.
    const black = paint(0x1a1d20, 0.42, 0.5);
    const mon = new THREE.Group();
    mon.position.set(1.42, H.deskTop + 0.021, -0.30);
    mon.rotation.y = -0.45;
    mon.add(lathe([[0, 0], [0.10, 0], [0.11, 0.008], [0.09, 0.014], [0.02, 0.016], [0, 0.016]], black, 28));
    mon.add(bar(v3(0, 0.016, 0.0), v3(0, 0.20, 0.0), 0.018, black, 12));
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.27, 0.014), paint(0x15171a, 0.48, 0.2));
    bezel.position.set(0, 0.33, 0.012);
    bezel.rotation.x = -0.10;
    mon.add(bezel);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.415, 0.235), paint(0x0b0d10, 0.08, 0.1));
    screen.position.set(0, 0.33 + 0.0007, 0.0192);
    screen.rotation.x = -0.10;
    mon.add(screen);
    this.group.add(mon);
    this.parts.monitor = bezel;
    this.keyboardTex = Art.texture(keyboardTexture());
    const kb = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.012, 0.13), [
      black, black, new THREE.MeshStandardMaterial({ map: this.keyboardTex, roughness: 0.55 }), black, black, black,
    ]));
    kb.position.set(1.38, H.deskTop + 0.027, -0.05);
    kb.rotation.y = -0.45;
    kb.rotation.x = 0.04;
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.032, 18, 12), black);
    mouse.scale.set(1, 0.55, 1.6);
    mouse.position.set(1.22, H.deskTop + 0.021 + 0.017, 0.12);
    this.add(mouse);
    const cradle = this.add(box(0.17, 0.045, 0.075, cherry, 1.56, H.deskTop + 0.021 + 0.0225, 0.38));
    for (const x of [1.52, 1.60]) {
      const hh = handheldVhf();
      hh.position.set(x, H.deskTop + 0.021 + 0.03, 0.38);
      hh.rotation.y = -Math.PI / 2 + 0.2;
      this.add(hh);
    }
    const stick = joystick();
    stick.position.set(1.25, H.deskTop + 0.021, -0.56);
    this.add(stick);
    this.parts.joystick = stick;
    // The outlets on the starboard side above the desk.
    for (const z of [0.08, 0.40]) {
      const plate = wallPlate('outlet');
      plate.position.set(H.halfWidth - 0.003, H.deskTop + 0.26, z);
      plate.rotation.y = -Math.PI / 2;
      this.add(plate);
    }

    // To port: the chart table's binder and a pair of dividers, and the wall switch by the door.
    const binder = this.add(box(0.30, 0.035, 0.22, paint(0x24303a, 0.72, 0.02), -1.40, H.deskTop + 0.021 + 0.0175, 0.18));
    binder.rotation.y = 0.18;
    this.add(bar(v3(-1.30, H.deskTop + 0.025, -0.30), v3(-1.16, H.deskTop + 0.025, -0.20), 0.003, chrome, 8));
    this.add(bar(v3(-1.30, H.deskTop + 0.025, -0.30), v3(-1.20, H.deskTop + 0.025, -0.38), 0.003, chrome, 8));
    const sw = wallPlate('switch');
    sw.position.set(-H.halfWidth + 0.003, H.deskTop + 0.30, 0.40);
    sw.rotation.y = Math.PI / 2;
    this.add(sw);
  }

  // --- the seats -------------------------------------------------------------------------------

  /**
   * Two helm chairs in cream leather on chrome pedestals, abaft the wheel: bolstered seats, high
   * winged backs with a roll at the top, padded arms on chrome brackets. They are behind the eye
   * and so are only seen when the cursor swings the gaze aft, but the room is wrong without them.
   */
  buildSeats() {
    const H = HOUSE;
    const hide = this.mat('mat:leather-cream', { key: 'hide', tint: 0xcbbda3, roughness: 0.55 });
    const chrome = PILOT_CHROME();
    const frame = paint(0x15171a, 0.5, 0.3);
    this.parts.seats = [];
    for (const s of [-1, 1]) {
      const seat = new THREE.Group();
      seat.position.set(s * 0.60, H.sole, 0.92);
      seat.add(lathe([[0, 0], [0.21, 0], [0.22, 0.012], [0.20, 0.03], [0.06, 0.035], [0.06, 0.045], [0, 0.045]], chrome, 32));
      seat.add(new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 20), 0.28, 0.42), chrome).translateY(0.25));
      seat.add(box(0.44, 0.03, 0.40, frame, 0, 0.475, 0));
      // The squab, its front edge rolled, with a bolster down each side.
      seat.add(box(0.46, 0.09, 0.44, hide, 0, 0.535, 0));
      seat.add(capsule(0.045, 0.40, 'x', hide, 0, 0.535, -0.22));
      seat.add(capsule(0.05, 0.34, 'z', hide, -0.235, 0.585, 0.02));
      seat.add(capsule(0.05, 0.34, 'z', hide, 0.235, 0.585, 0.02));
      // The back, raked, winged, with the headrest roll across its top.
      const back = new THREE.Group();
      back.position.set(0, 0.58, 0.20);
      back.rotation.x = -0.14;
      back.add(box(0.44, 0.56, 0.09, hide, 0, 0.28, 0));
      back.add(capsule(0.05, 0.48, 'y', hide, -0.235, 0.27, -0.03));
      back.add(capsule(0.05, 0.48, 'y', hide, 0.235, 0.27, -0.03));
      back.add(capsule(0.055, 0.30, 'x', hide, 0, 0.60, -0.02));
      seat.add(back);
      // The arms.
      for (const a of [-1, 1]) {
        seat.add(capsule(0.035, 0.26, 'z', hide, a * 0.315, 0.76, 0.0));
        seat.add(bar(v3(a * 0.30, 0.555, 0.10), v3(a * 0.315, 0.73, 0.06), 0.012, chrome, 10));
      }
      this.group.add(seat);
      this.parts.seats.push(seat);
    }
  }

  // --- the small things ------------------------------------------------------------------------

  buildFittings() {
    const H = HOUSE;
    const cherry = this.cherry;
    const brass = paint(0x9a7a34, 0.3, 0.6);

    // A grab rail under the overhead fascia, which is what you hold standing up into a sea.
    this.add(bar(v3(-1.30, H.deckhead - 0.14, -0.74), v3(1.30, H.deckhead - 0.14, -0.74), 0.016, PILOT_CHROME(), 14));
    for (const x of [-1.28, 0, 1.28]) {
      this.add(bar(v3(x, H.deckhead - 0.14, -0.74), v3(x, H.deckhead - 0.02, -0.80), 0.012, PILOT_CHROME(), 10));
    }

    // A brass clock and a barometer on the aft bulkhead, the pair every wheelhouse has.
    for (const [x, lbl, unit, min, max, major, minor] of [
      [0.62, 'CLOCK', '', 0, 12, 3, 1],
      [0.92, 'BAROMETER', 'mb', 960, 1050, 30, 10],
    ]) {
      const g = new Gauge({ label: lbl, unit, min, max, major, minor, dark: false, diameter: 0.145, maker: 'WEMPE', start: (min + max) / 2, bezel: 'chrome' });
      g.group.position.set(x, 5.58, H.back - 0.045);
      g.group.rotation.y = Math.PI;
      this.group.add(g.group);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.012, 10, 32), brass);
      ring.position.set(x, 5.58, H.back - 0.050);
      ring.rotation.y = Math.PI;
      this.add(ring);
      this.gauges[lbl.toLowerCase()] = g;
    }

    // A teak shelf on the port wall aft, with a fiddle: the one flat place in the room.
    const shelf = this.add(box(0.24, 0.035, 0.80, cherry, -H.halfWidth + 0.12, 5.44, 1.20));
    this.parts.shelf = shelf;
    this.shelfTop = 5.44 + 0.0175;
    this.add(box(0.022, 0.05, 0.80, cherry, -H.halfWidth + 0.23, 5.4725, 1.20));
    this.add(box(0.26, 0.05, 0.05, cherry, -H.halfWidth + 0.13, 5.415, 0.82));

    // A mug on the dash: it slides when she rolls (update), and fetches up against the pod.
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
    add(this.parts.pod, 'radar');
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

  /** Throws the wipers' breaker to match the state scene.js keeps. */
  setWipers(on) {
    if (!this.wiperPanel || this.wiperBreaker < 0) return;
    const b = this.wiperPanel.breakers[this.wiperBreaker];
    if (b && b.on !== !!on) this.wiperPanel.throwBreaker(this.wiperBreaker);
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
    // The engine control: the throttle lever follows the order, the gear lever sits in ahead.
    if (this.control) this.control.set(boat.throttle, boat.throttle > 0.02 ? 1 : 0);

    // The gauges read the boat. A needle that does not move is a sticker.
    const g = this.gauges;
    const rpm = boat.rpm ? boat.rpm / 100 : boat.throttle * 22 + 5;
    if (g.tacho) g.tacho.set(rpm);
    if (g.tacho2) g.tacho2.set(rpm * 0.985);
    if (g.temp) g.temp.set(62 + boat.throttle * 24);
    if (g.temp2) g.temp2.set(63 + boat.throttle * 23);
    if (g.oil) g.oil.set(2.4 + boat.throttle * 2.2);
    if (g.oil2) g.oil2.set(2.5 + boat.throttle * 2.1);
    if (g.volts) g.volts.set(13.8 + Math.sin(this.lampLevel ?? 0) * 0.1);
    if (g.fuel) g.fuel.set(64);
    if (g.trans) g.trans.set(16 + boat.throttle * 6);
    if (g.rudder) g.rudder.set(-boat.rudder * 35);
    if (g.clino) g.clino.set(boat.roll * 57.2957795);
    const headingDeg = ((boat.heading * 57.2957795) % 360 + 360) % 360;
    if (g.hdg) g.hdg.set(headingDeg);
    if (g.clock) g.clock.set(((G.uDayTime.value * 24) % 12));
    if (this.parts.compass?.userData.card) this.parts.compass.userData.card.rotation.z = boat.heading;

    // The mug slides on the dash when she rolls, and fetches up against the pod or the control.
    if (this.parts.mug) {
      const a = Math.sin(boat.roll) * 9.81 - boat.rate.x * 0.4;
      const stick = 0.9;
      if (Math.abs(a) > stick || Math.abs(this.mugV) > 1e-3) {
        this.mugV += (a - Math.sign(this.mugV || a) * stick) * dt;
        this.mugV *= Math.exp(-dt / 0.9);
        this.mugX += this.mugV * dt;
        if (this.mugX < -0.80) { this.mugX = -0.80; this.mugV = Math.abs(this.mugV) * 0.2; }
        if (this.mugX > 0.40) { this.mugX = 0.40; this.mugV = -Math.abs(this.mugV) * 0.2; }
      }
      this.parts.mug.position.x = this.mugX;
    }

    this.setWipers(state?.wipers);
    this.setFill(G.uSkyLight.value);
    this.updateLamps(dt, state);
  }

  /**
   * The deckhead lamps: white by day in the house, red at night, out when it is bright outside.
   *
   * Two different kinds of number here, and mixing them up is what makes a night scene blow out.
   * The *light* is physical: a wheelhouse lamp puts about five lux on a surface two metres away
   * against the sun's hundred thousand, so against this scene's sun of 6.4 it is a few
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
      light.intensity = this.lampLevel * (red ? 0.0008 : 0.0018);
      light.color.setRGB(1, red ? 0.12 : 0.88, red ? 0.07 : 0.68);
      lens.material.emissive.setRGB(1, red ? 0.14 : 0.94, red ? 0.08 : 0.82);
      lens.material.emissiveIntensity = this.lampLevel * (red ? 0.45 : 0.75) * screen;
    }
    for (const bulb of this.chartBulbs ?? []) bulb.material.emissiveIntensity = this.lampLevel * 0.7 * screen;
    // The chrome reflects the room, so it is worth what a white surface in the room is worth times
    // the sixty per cent a polished stainless returns: the fill's share by day (measured: the cream
    // wall renders at 0.7 of white with the fill at 4.1) and the lamps' share by night (four lamps
    // of 0.0018 cd at a metre and a half, over pi). Both are radiances, so neither is divided by
    // the exposure - the camera does that.
    setChromeLevel(this.fill.intensity * 0.10 + this.lampLevel * 0.00018);
    // The tell-tales, the meters and the sets' displays, all screen brightnesses.
    const panelLit = Math.max(0.15, this.lampLevel);
    for (const p of this.panels) p.setLit(panelLit, screen, p.values);
    for (const s of this.sets) s.setLit(Math.max(0.35, this.lampLevel), screen);
    for (const g of Object.values(this.gauges)) g.setLit(this.lampLevel, screen);
    this.control?.setLit(Math.max(0.3, this.lampLevel), screen);
  }

  dispose() {
    for (const p of this.panels) p.dispose();
    for (const s of this.sets) s.dispose();
    for (const h of this.handsets ?? []) h.dispose();
    for (const g of Object.values(this.gauges)) g.dispose();
    this.control?.dispose();
    this.soleTex?.dispose();
    this.keyboardTex?.dispose();
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material && o.material.userData?.tag === undefined) o.material.dispose?.();
      o.userData?.tex?.dispose?.();
    });
    this.scene.remove(this.group);
  }
}

/**
 * The atmosphere, for a prop's own loaded material. A scanned prop arrives as a plain standard
 * material that knows nothing about this scene's aerial perspective; this bolts the same read onto
 * it that every other surface uses. deck.js and wildlife.js use it, for the props out on the
 * foredeck and the channel marks: nothing in the wheelhouse is a downloaded model.
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
