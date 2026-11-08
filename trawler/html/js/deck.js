// Trawler — Everything of the boat you can see from inside the pilot house: the foredeck she is
// looking over, the bulwarks, the mast, the working gear, and the stern when you turn round.
//
// This is the scene's framing (guidelines section 1: "the near corners and sides of the view are
// where the owner asks for more"). The composition is worked out from the real geometry: the eye
// is 5.5 m above the water, the bow rail 11 m forward at 3.7 m, so the rail sits nine degrees
// below the horizon and the sea beyond it is a band across the top of the deck. That is what the
// view from a wheelhouse looks like, and it is why the deck has to be worth looking at.
//
// Body coordinates: +x starboard, +y up, +z aft, y = 0 at the waterline.
//
//   1.80  the working deck aft
//   2.95  the forecastle deck forward
//   3.70  the top of the bow rail
//   4.00  the wheelhouse sole, on top of the deckhouse
//
// The paint is a west-coast scheme: a dark green hull, cream topsides, red lead inside the
// bulwarks (which is what the inside of a working bulwark is nearly always painted) and a deck
// left bare.

import * as THREE from 'three';
import { G, LAYER } from './shaders.js';
import { paint, metreUvsBox, metreUvsPlane, scaleUvs } from './materials.js';
import { patchPropShader } from './pilot.js';
import { v3, DEG, TAU, lerp, clamp01, srgb } from './util.js';

export const DECK = {
  mainDeck: 1.80,
  foreDeck: 2.62,
  bowRail: 3.30,
  houseSole: 4.00,
  deckhouseFront: -2.05,
  deckhouseBack: 2.05,
  halfWidth: 1.92, // of the deckhouse, a little wider than the wheelhouse above it
  // The mast stands well forward of the window. Any closer and it splits the view in two, which
  // no skipper would put up with and no screenshot survives.
  mastZ: -8.90,
  mastTop: 9.6,
  // The main mast is stepped on the wheelhouse roof, which is where a trawler's radar goes and
  // which keeps it out of the window altogether.
  mainMastZ: -0.35,
  mainMastTop: 11.2,
};

const PAINT = {
  hull: 0x20413c,
  topside: 0xe6e3d8,
  bulwarkIn: 0x6a3a2c,
  trim: 0x9c3028,
  mast: 0xdfd9c6,
  gear: 0x55564e,
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(metreUvsBox(new THREE.BoxGeometry(w, h, d), w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function panel(w, h, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(metreUvsPlane(new THREE.PlaneGeometry(w, h), w, h), material);
  m.position.set(x, y, z);
  return m;
}

function bar(a, b, radius, material, segments = 10) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(radius, radius, len, segments, 1), TAU * radius, len), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), dir.normalize());
  return m;
}

/**
 * The sheer: how high the deck and the rail stand above the water along her length. A working
 * boat's sheer rises hard forward, which is what keeps the foredeck dry and what gives her the
 * profile you would recognise from a mile off.
 */
export function sheer(z) {
  const t = clamp01((-z - 1.5) / 9.7); // 0 at midships, 1 at the stem
  return DECK.foreDeck - 0.88 * (1 - t) * (1 - t);
}

/** The half-beam of the deck at a station, which the bulwarks follow. */
export function deckHalfBeam(z) {
  const t = clamp01((-z + 11.2) / 22.4);
  // Full amidships, fining to the stem, with a transom that keeps most of her beam.
  const bow = clamp01((-z - 5.6) / 5.6);
  return 3.32 * (1 - 0.92 * bow * bow * bow) * (1 - 0.1 * clamp01((z - 6) / 5.2));
}

export class Deck {
  constructor(scene, materials, rng) {
    this.scene = scene;
    this.materials = materials;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.parts = {};
    this.lights = [];
    this.build();
    this.group.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      o.layers.set(LAYER.DEFAULT);
      o.layers.enable(LAYER.WORLD);
    });
  }

  mat(tag, opts) { return this.materials.get(tag, opts); }
  add(m) { this.group.add(m); return m; }

  build() {
    this.buildHull();
    this.buildDecks();
    this.buildBulwarks();
    this.buildDeckhouse();
    this.buildMast();
    this.buildForedeckGear();
    this.buildAftGear();
    this.buildLights();
  }

  // --- the hull --------------------------------------------------------------------------------

  /**
   * The hull as a lofted shell from the same stations the physics uses, so what you see is what
   * she floats on. Only the topsides matter here (the rest is under water), but the whole shape is
   * built so the bow wave has something to break against.
   */
  buildHull() {
    const stations = [];
    for (let i = 0; i <= 40; i++) {
      const z = lerp(-11.2, 11.2, i / 40);
      stations.push({ z, b: deckHalfBeam(z), top: sheer(z), keel: this.keelAt(z) });
    }
    const RINGS = 14;
    const pos = [], nor = [], uvs = [], idx = [];
    for (let s = 0; s < stations.length; s++) {
      const st = stations[s];
      for (let r = 0; r <= RINGS; r++) {
        const t = r / RINGS;
        // A section from the keel up to the sheer: round bilge, slab topsides, a little flare.
        const a = t * Math.PI * 0.5;
        const flare = 1 + 0.06 * t * t;
        const x = st.b * Math.sin(a) * flare;
        const y = lerp(st.keel, st.top, Math.pow(t, 0.72));
        pos.push(x, y, st.z);
        uvs.push(x * 1.0, y);
      }
    }
    const row = RINGS + 1;
    for (let s = 0; s < stations.length - 1; s++) {
      for (let r = 0; r < RINGS; r++) {
        const a = s * row + r, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const build = (mirror) => {
      const g = new THREE.BufferGeometry();
      const p = Float32Array.from(pos);
      if (mirror) for (let i = 0; i < p.length; i += 3) p[i] = -p[i];
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
      g.setIndex(mirror ? idx.slice().reverse() : idx);
      g.computeVertexNormals();
      return g;
    };
    const hullMat = this.mat('mat:paint-worn', { desaturate: 0.92, key: 'hull', tint: PAINT.hull, roughness: 0.52 });
    for (const mirror of [false, true]) {
      const m = new THREE.Mesh(build(mirror), hullMat);
      this.add(m);
    }
    // The boot top and the sheer strake: the two stripes that make a hull read as a hull.
    const stripe = paint(PAINT.trim, 0.5, 0.05);
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const z = lerp(-11.2, 11.2, i / 40);
        pts.push(v3(s * deckHalfBeam(z) * 1.002, sheer(z) - 0.17, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(scaleUvs(new THREE.TubeGeometry(curve, 60, 0.055, 6, false), 6, 24), stripe);
      this.add(tube);
    }
  }

  /** How deep the keel is at a station: full amidships, rising to the stem and to the transom. */
  keelAt(z) {
    const t = clamp01((-z + 11.2) / 22.4);
    const bow = clamp01((-z - 4.5) / 6.7);
    return -2.85 * (1 - 0.72 * bow * bow) * (1 - 0.18 * clamp01((z - 7) / 4.2));
  }

  // --- decks and bulwarks ------------------------------------------------------------------------

  buildDecks() {
    // A working deck is grey-brown with the colour walked out of it, not varnished mahogany.
    const deckMat = this.mat('mat:deck', { key: 'deck', desaturate: 0.9, tint: 0xcac2b2, roughness: 0.95, aoIntensity: 0.7 });
    // The deck as a strip between the bulwarks, following the sheer.
    const pos = [], uvs = [], idx = [];
    const N = 44;
    for (let i = 0; i <= N; i++) {
      const z = lerp(-11.0, 11.0, i / N);
      const b = deckHalfBeam(z) - 0.16;
      const y = sheer(z) - 0.02;
      pos.push(-b, y, z, b, y, z);
      // u along the boat, v across her: a deck is laid fore and aft, never athwartships.
      uvs.push(z, -b, z, b);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const deck = this.add(new THREE.Mesh(g, deckMat));
    deck.receiveShadow = true;
  }

  buildBulwarks() {
    const outside = this.mat('mat:paint-worn', { desaturate: 0.92, key: 'topside', tint: PAINT.topside, roughness: 0.55 });
    const inside = this.mat('mat:paint-worn', { desaturate: 0.92, key: 'bulwark', tint: PAINT.bulwarkIn, roughness: 0.66 });
    const capMat = this.mat('mat:steel-rust', { key: 'cap', tint: 0xb9b2a0 });
    // A bulwark 0.9 m high amidships, more forward: it follows the sheer and the half-beam.
    const N = 44;
    for (const s of [-1, 1]) {
      for (const [mat, off, flip] of [[outside, 0.02, false], [inside, -0.02, true]]) {
        const pos = [], uvs = [], idx = [];
        for (let i = 0; i <= N; i++) {
          const z = lerp(-11.05, 10.9, i / N);
          const b = deckHalfBeam(z) + off * s;
          const y0 = sheer(z) - 0.05;
          const y1 = y0 + this.bulwarkHeight(z);
          pos.push(s * b, y0, z, s * b, y1, z);
          uvs.push(z, y0, z, y1);
        }
        for (let i = 0; i < N; i++) {
          const a = i * 2;
          const up = (s > 0) !== flip;
          if (up) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
        g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        this.add(new THREE.Mesh(g, mat));
      }
      // The capping rail along the top, which is what your eye follows forward.
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const z = lerp(-11.05, 10.9, i / N);
        pts.push(v3(s * (deckHalfBeam(z) + 0.01), sheer(z) - 0.05 + this.bulwarkHeight(z) + 0.03, z));
      }
      const cap = new THREE.Mesh(
        scaleUvs(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 70, 0.055, 8, false), 8, 24), capMat);
      this.add(cap);
      // Freeing ports: the slots that let a sea on deck get away again.
      const portMat = paint(0x0b0e0f, 0.9, 0);
      for (let i = 0; i < 5; i++) {
        const z = 1.2 + i * 1.9;
        const b = deckHalfBeam(z);
        const p = box(0.06, 0.16, 0.42, portMat, s * (b + 0.01), sheer(z) + 0.05, z);
        this.add(p);
      }
    }
  }

  /**
   * How high the bulwark stands above the deck. It rises forward, but not as far as it would on a
   * real boat: from a 5.5 m eye a full-height bow bulwark stands only ten degrees under the
   * horizon and walls off the bottom half of the window.
   */
  bulwarkHeight(z) {
    const t = clamp01((-z - 2) / 9);
    return 0.80 + 0.18 * t * t;
  }

  // --- the deckhouse the wheelhouse stands on -----------------------------------------------------

  buildDeckhouse() {
    const D = DECK;
    const skin = this.mat('mat:paint-worn', { desaturate: 0.92, key: 'topside', tint: PAINT.topside, roughness: 0.55 });
    const h = D.houseSole - D.mainDeck + 0.1;
    const w = D.halfWidth * 2;
    const d = D.deckhouseBack - D.deckhouseFront;
    const midZ = (D.deckhouseBack + D.deckhouseFront) / 2;
    this.add(box(w, h, d, skin, 0, D.mainDeck + h / 2 - 0.05, midZ));
    // Its roof, which is the little deck in front of the wheelhouse windows.
    const roof = this.add(panel(w + 0.2, d + 0.2, this.mat('mat:steel-rust', { key: 'roof', tint: 0xa8a295 }), 0, D.houseSole + 0.02, midZ));
    roof.rotation.x = -Math.PI / 2;
    roof.receiveShadow = true;
    // A low rail round the roof so nobody goes over the side off it.
    const rail = paint(0xcfcabb, 0.5, 0.2);
    for (const s of [-1, 1]) {
      this.add(bar(v3(s * (D.halfWidth + 0.08), D.houseSole + 0.42, D.deckhouseFront - 0.08),
        v3(s * (D.halfWidth + 0.08), D.houseSole + 0.42, D.deckhouseBack + 0.08), 0.018, rail));
      for (const z of [D.deckhouseFront - 0.06, midZ, D.deckhouseBack + 0.06]) {
        this.add(bar(v3(s * (D.halfWidth + 0.08), D.houseSole + 0.04, z),
          v3(s * (D.halfWidth + 0.08), D.houseSole + 0.42, z), 0.015, rail));
      }
    }
    // Scuttles along the deckhouse side: the crew's cabins.
    const brass = paint(0x8a6a2e, 0.3, 0.88);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const z = -1.2 + i * 1.3;
        const ring = new THREE.Mesh(scaleUvs(new THREE.TorusGeometry(0.115, 0.022, 8, 20), 0.7, 0.14), brass);
        ring.position.set(s * (D.halfWidth + 0.015), D.mainDeck + 1.35, z);
        ring.rotation.y = Math.PI / 2;
        this.add(ring);
        const glass = new THREE.Mesh(new THREE.CircleGeometry(0.105, 20), paint(0x10171c, 0.12, 0.3));
        glass.position.set(s * (D.halfWidth + 0.012), D.mainDeck + 1.35, z);
        glass.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.add(glass);
      }
    }
  }

  // --- the mast and its gear ------------------------------------------------------------------------

  buildMast() {
    const D = DECK;
    const mastMat = this.mat('mat:paint-worn', { desaturate: 0.92, key: 'mast', tint: PAINT.mast, roughness: 0.5 });
    const steel = this.mat('mat:steel-rust', { key: 'gear', tint: 0x7d8486 });
    const wire = paint(0x2a2d2e, 0.45, 0.6);

    // The foremast: a short pole right forward, carrying the steaming light and the derrick. It is
    // on the centreline, as it must be, but nine metres away it is a pencil line across the view
    // rather than a post through the middle of it.
    const base = sheer(D.mastZ);
    const fore = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.075, 0.115, D.mastTop - base, 14, 1), 0.6, 6.5), mastMat);
    fore.position.set(0, (base + D.mastTop) / 2, D.mastZ);
    this.add(fore);
    this.parts.mastBase = base;
    const crossY = base + 2.9;
    this.add(box(2.0, 0.07, 0.09, mastMat, 0, crossY, D.mastZ));
    for (const s of [-1, 1]) {
      const z = D.mastZ + 1.9;
      const b = deckHalfBeam(z) + 0.02;
      this.add(bar(v3(s * 0.95, crossY, D.mastZ), v3(s * b, sheer(z) + this.bulwarkHeight(z), z), 0.009, wire, 6));
      this.add(bar(v3(s * 0.95, crossY - 0.03, D.mastZ), v3(0, D.mastTop - 0.4, D.mastZ), 0.008, wire, 6));
    }
    // The derrick boom, topped up and lashed, which is the shape that says "she works for a living".
    const boom = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.048, 0.065, 4.6, 12), 0.35, 4.6), mastMat);
    boom.position.set(0.30, base + 1.9, D.mastZ + 1.7);
    boom.rotation.set(-0.46, 0.06, 0.10);
    this.add(boom);

    // The main mast, stepped on the wheelhouse roof: the radar, the aerials and the whistle. From
    // inside the house it is overhead, so none of it crosses the windows.
    const roof = D.houseSole + 2.14;
    const main = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.085, 0.12, D.mainMastTop - roof, 14, 1), 0.6, 4.5), mastMat);
    main.position.set(0, (roof + D.mainMastTop) / 2, D.mainMastZ);
    this.add(main);
    const mainCross = roof + 1.5;
    this.add(box(2.4, 0.07, 0.09, mastMat, 0, mainCross, D.mainMastZ));
    for (const s of [-1, 1]) {
      this.add(bar(v3(s * 1.15, mainCross, D.mainMastZ), v3(s * 1.3, roof - 0.1, D.mainMastZ + 1.5), 0.008, wire, 6));
      // The whip aerials either end of the crosstree.
      this.add(bar(v3(s * 1.1, mainCross + 0.05, D.mainMastZ), v3(s * 1.18, mainCross + 1.7, D.mainMastZ), 0.008, wire, 6));
    }
    // The radar scanner, turning at about twenty-four revolutions a minute as a small set does.
    const scanner = new THREE.Group();
    scanner.position.set(0, roof + 2.35, D.mainMastZ);
    scanner.add(new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.15, 0.15, 0.18, 16), 0.95, 0.18), steel));
    scanner.add(box(1.7, 0.12, 0.08, paint(0xd9d6cc, 0.5, 0.1), 0, 0.14, 0));
    this.add(scanner);
    this.parts.scanner = scanner;
    this.parts.mainRoof = roof;

    // The whistle, on the forward face of the main mast.
    const whistle = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.05, 0.06, 0.28, 14), 0.33, 0.28),
      paint(0x9a7a34, 0.3, 0.9));
    whistle.position.set(0, roof + 0.95, D.mainMastZ - 0.16);
    whistle.rotation.x = 0.25;
    this.add(whistle);
    this.parts.whistle = whistle;
  }

  // --- scanned props on deck ----------------------------------------------------------------------

  /**
   * Where the scanned deck props go. These are Poly Haven scans, modelled at their real size in
   * metres, so none of them is scaled — see the same note on PilotHouse.PROPS.
   *
   * What can go where is decided by the sightline, not by taste. The eye is at y 5.52 and looks
   * out over a sill 0.54 m below it and 1.58 m forward, so the lowest thing visible at a distance
   * d forward of the eye is at y = 5.52 - 0.342 d. At the fish hatch, six metres out, that is
   * y 3.6 and the deck is at 2.45: the whole midships deck is under the sill and anything stowed
   * there would never be seen. Forward of about z = -8.5 the sheer has risen and the sightline has
   * dropped far enough that the deck comes into view, which is why everything here is right
   * forward, around the windlass and the foremast, or up on the bulwark capping.
   *
   *   onDeck   y is measured up from the deck at that station, sheer(z)
   *   outboard the prop is on the bulwark that side: x is measured in from deckHalfBeam(z)
   *   anchor   what the position means: 'base' (default), 'centre', or 'top' for a hanging thing
   */
  static PROPS = {
    // Fish crates stacked by the windlass, one askew on the other, as they always are.
    crate: [
      { pos: [1.38, 0.00, -9.74], rot: [0, 0.22, 0], onDeck: true },
      { pos: [1.44, 0.254, -9.80], rot: [0, -0.18, 0], onDeck: true },
    ],
    // Two cans of diesel for the winch, lashed on the port side forward.
    jerrycan: [
      { pos: [-1.34, 0.00, -9.28], rot: [0, 0.38, 0], onDeck: true },
      { pos: [-1.04, 0.00, -9.44], rot: [0, -0.52, 0], onDeck: true },
    ],
    // The lifebuoy on the inside of the port bulwark, where it is to hand and out of the view.
    lifebuoy: [
      { pos: [0.14, 3.02, -8.10], rot: [0, Math.PI / 2, 0], outboard: -1, anchor: 'centre' },
    ],
    // A jacket left hanging on the foremast.
    lifejacket: [
      { pos: [0.16, 3.00, -7.55], rot: [0, Math.PI / 2, 0.05], outboard: 1, anchor: 'centre' },
    ],
    // Tyre fenders over the side, which is where a boat that comes alongside keeps them.
    fender: [
      { pos: [-0.08, 3.02, -7.00], rot: [0, Math.PI / 2, 0], outboard: -1, anchor: 'centre' },
      { pos: [-0.08, 3.14, -8.60], rot: [0, Math.PI / 2, 0.08], outboard: 1, anchor: 'centre' },
    ],
    // The deck working light, hung under the foremast crosstree on its own flex.
    caged_light: [
      { pos: [0.26, 5.47, -8.74], rot: [0, 0.22, 0], anchor: 'top' },
    ],
  };

  /**
   * Drops a loaded glTF prop onto the deck, once for each place the table gives it. Called from
   * scene.js as each file lands, so the deck fills in while the scene is already running.
   */
  addProp(name, model) {
    const places = Deck.PROPS[name];
    if (!places || !model) return;
    for (const spec of places) this.placeProp(name, model, spec);
  }

  placeProp(name, model, spec) {
    const obj = model.clone(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        o.material = o.material.clone();
        o.material.fog = true;
        o.material.onBeforeCompile = (shader) => { patchPropShader(shader); };
        o.material.needsUpdate = true;
      }
    });
    obj.rotation.set(spec.rot?.[0] ?? 0, spec.rot?.[1] ?? 0, spec.rot?.[2] ?? 0);
    obj.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(obj);
    const centre = bounds.getCenter(new THREE.Vector3());
    const z = spec.pos[2];
    const x = spec.outboard ? spec.outboard * (deckHalfBeam(z) - spec.pos[0]) : spec.pos[0];
    const y = spec.onDeck ? sheer(z) + spec.pos[1] : spec.pos[1];
    const yRef = spec.anchor === 'centre' ? centre.y : spec.anchor === 'top' ? bounds.max.y : bounds.min.y;
    obj.position.set(x - centre.x, y - yRef, z - centre.z);
    obj.layers.set(LAYER.DEFAULT);
    obj.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.WORLD); });
    this.group.add(obj);
    (this.props ??= []).push({ name, obj });
  }

  buildForedeckGear() {
    const steel = this.mat('mat:steel-rust', { key: 'gear', tint: 0x7a8285 });
    // Flat paint, not a scan: these are small castings, and a 1 m tiled scan on a 0.2 m box shows
    // one stripe of itself. The colour is a warm grey rather than a blue one, because under a
    // northern sky the only light a vertical face gets is blue and a blue-grey goes frankly blue.
    const dark = paint(PAINT.gear, 0.62, 0.22);
    // The anchor windlass right forward.
    const wz = -9.4;
    const wy = sheer(wz);
    this.add(box(1.25, 0.22, 0.62, dark, 0, wy + 0.11, wz));
    for (const s of [-1, 1]) {
      const gy = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.17, 0.17, 0.2, 16), 1.1, 0.2), steel);
      gy.rotation.z = Math.PI / 2;
      gy.position.set(s * 0.5, wy + 0.32, wz);
      this.add(gy);
      // The cable running aft into the chain locker.
      this.add(bar(v3(s * 0.5, wy + 0.3, wz), v3(s * 0.62, wy + 0.04, wz + 0.9), 0.028, steel, 6));
    }
    this.add(box(0.5, 0.42, 0.42, dark, 0, wy + 0.35, wz + 0.4));

    // The hatch to the fish hold, with its cleats.
    const hz = -5.9;
    const hy = sheer(hz);
    const hatchMat = this.mat('mat:steel-rust', { desaturate: 0.5, key: 'hatch', tint: 0x9aa39a });
    this.add(box(1.36, 0.19, 1.18, hatchMat, 0, hy + 0.10, hz));
    this.add(box(1.46, 0.06, 1.28, steel, 0, hy + 0.21, hz));
    // The coaming the hatch sits on, and the cleats round it.
    this.add(box(1.52, 0.12, 1.34, steel, 0, hy + 0.06, hz));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.78;
      this.add(box(0.1, 0.07, 0.1, steel, Math.cos(a) * 0.8, hy + 0.2, hz + Math.sin(a) * 0.72));
    }

    // Mooring bitts and a fairlead each side.
    for (const s of [-1, 1]) {
      for (const z of [-10.2, -2.6]) {
        const y = sheer(z);
        const b = deckHalfBeam(z) - 0.45;
        this.add(box(0.26, 0.1, 0.26, steel, s * b, y + 0.05, z));
        for (const dx of [-0.07, 0.07]) {
          const bitt = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.052, 0.058, 0.34, 12), 0.33, 0.34), steel);
          bitt.position.set(s * b + dx, y + 0.27, z);
          this.add(bitt);
        }
      }
    }
    // A coil of warp on the deck, and the bight of it running to the bitts.
    const rope = paint(0x554c3a, 0.92, 0);
    const coil = new THREE.Group();
    coil.position.set(-1.25, sheer(-7.4) + 0.03, -7.4);
    for (let i = 0; i < 10; i++) {
      const ring = i % 5, tier = Math.floor(i / 5);
      const r = 0.38 - ring * 0.064 - tier * 0.03;
      const t = new THREE.Mesh(scaleUvs(new THREE.TorusGeometry(r, 0.034, 8, 30), 2.0, 0.21), rope);
      t.rotation.x = Math.PI / 2;
      t.position.set((i % 3 - 1) * 0.010, 0.034 + tier * 0.060, (i % 2) * 0.012);
      coil.add(t);
    }
    this.add(coil);
  }

  buildAftGear() {
    const steel = this.mat('mat:steel-rust', { key: 'gear', tint: 0x7a8285 });
    // Flat paint, not a scan: these are small castings, and a 1 m tiled scan on a 0.2 m box shows
    // one stripe of itself. The colour is a warm grey rather than a blue one, because under a
    // northern sky the only light a vertical face gets is blue and a blue-grey goes frankly blue.
    const dark = paint(PAINT.gear, 0.62, 0.22);
    // The gantry over the stern, which is the silhouette that says "trawler".
    const gz = 8.4;
    const gy = sheer(gz);
    const top = gy + 3.3;
    for (const s of [-1, 1]) {
      const b = deckHalfBeam(gz) - 0.25;
      this.add(bar(v3(s * b, gy, gz), v3(s * (b - 0.35), top, gz), 0.075, dark, 10));
    }
    this.add(bar(v3(-deckHalfBeam(gz) + 0.6, top, gz), v3(deckHalfBeam(gz) - 0.6, top, gz), 0.075, dark, 10));
    // Two blocks hanging from it.
    for (const s of [-1, 1]) {
      this.add(bar(v3(s * 1.1, top, gz), v3(s * 1.1, top - 0.5, gz), 0.02, steel, 6));
      this.add(box(0.16, 0.26, 0.09, steel, s * 1.1, top - 0.62, gz));
    }
    // The net drum forward of the gantry.
    const drum = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.72, 0.72, 2.6, 24), 4.5, 2.6), steel);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, sheer(6.0) + 0.95, 6.0);
    this.add(drum);
    // The net itself, wound on: a sleeve of dark mesh.
    const net = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.92, 0.92, 2.3, 24), 5.8, 2.3),
      paint(0x2c3a2b, 0.95, 0));
    net.rotation.z = Math.PI / 2;
    net.position.copy(drum.position);
    this.add(net);
    for (const s of [-1, 1]) {
      this.add(box(0.2, 1.1, 0.22, dark, s * 1.45, sheer(6.0) + 0.5, 6.0));
    }
    // The trawl doors stowed against the bulwark, and the winch.
    for (const s of [-1, 1]) {
      const z = 3.4;
      const door = box(0.1, 1.15, 1.9, this.mat('mat:steel-rust', { key: 'door', tint: 0x6f5a43 }),
        s * (deckHalfBeam(z) - 0.2), sheer(z) + 0.62, z);
      door.rotation.z = s * 0.08;
      this.add(door);
    }
    this.add(box(1.9, 0.75, 0.95, dark, 0, sheer(2.9) + 0.38, 2.9));
  }

  // --- lights ---------------------------------------------------------------------------------------

  buildLights() {
    const D = DECK;
    const base = this.parts.mastBase;
    // Side lights: red to port, green to starboard, in their screens on the deckhouse corners.
    const housing = paint(0x3a3f42, 0.6, 0.2);
    this.parts.navLights = [];
    for (const [s, hex] of [[-1, 0xff2a1a], [1, 0x1aff46]]) {
      const box1 = box(0.17, 0.26, 0.2, housing, s * (D.halfWidth + 0.08), D.houseSole - 0.35, D.deckhouseFront + 0.15);
      this.add(box1);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.065, 14, 10),
        new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 2.2, roughness: 0.4 }));
      lens.position.set(s * (D.halfWidth + 0.13), D.houseSole - 0.33, D.deckhouseFront + 0.08);
      this.add(lens);
      this.parts.navLights.push(lens);
    }
    // The masthead light forward and the stern light aft.
    for (const [y, z, hex] of [[base + 3.0, DECK.mastZ - 0.1, 0xfff3d8], [sheer(10.6) + 1.3, 10.6, 0xfff3d8]]) {
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10),
        new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 2.2, roughness: 0.4 }));
      lens.position.set(0, y, z);
      this.add(lens);
      this.parts.navLights.push(lens);
    }
    // Two working floods on the crosstree, which light the deck when they are on.
    this.parts.deckFloods = [];
    const roof = this.parts.mainRoof;
    for (const s of [-1, 1]) {
      const shell = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(0.1, 0.13, 0.17, 14), 0.8, 0.17), housing);
      shell.position.set(s * 1.0, roof + 1.38, DECK.mainMastZ + 0.12);
      shell.rotation.x = 1.15;
      this.add(shell);
      const light = new THREE.SpotLight(0xfff0d2, 0, 26, 0.8, 0.45, 1.6);
      light.position.set(s * 1.0, roof + 1.32, DECK.mainMastZ + 0.12);
      light.target.position.set(s * 1.5, DECK.mainDeck, 5.5);
      light.layers.set(LAYER.DEFAULT);
      light.layers.enable(LAYER.WORLD);
      this.group.add(light);
      this.group.add(light.target);
      this.parts.deckFloods.push({ light, shell });
    }
  }

  // --- the frame ---------------------------------------------------------------------------------------

  update(dt, boat, state) {
    const R = boat.R, p = boat.position;
    this.group.matrix.set(
      R[0], R[1], R[2], p.x,
      R[3], R[4], R[5], p.y,
      R[6], R[7], R[8], p.z,
      0, 0, 0, 1,
    );
    this.group.matrixWorldNeedsUpdate = true;
    // The radar turns at about 24 revolutions a minute, as a small-boat set does.
    if (this.parts.scanner) this.parts.scanner.rotation.y += dt * 2.5;
    const night = G.uNight.value;
    // A navigation light is drawn at a brightness, not at a radiance: it is divided by whatever
    // exposure the camera has settled on, the same as the stars are, or it goes white at night.
    const screen = state?.emissiveScale ?? 1;
    for (const lens of this.parts.navLights ?? []) {
      lens.material.emissiveIntensity = (0.1 + 0.9 * night) * 0.9 * screen;
    }
    // The deck floods are real lights, so they are in physical units: a few hundred lux on the
    // deck against the sun's hundred thousand.
    for (const { light } of this.parts.deckFloods ?? []) {
      light.intensity = night * (state?.deckLights === false ? 0 : 0.5);
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
