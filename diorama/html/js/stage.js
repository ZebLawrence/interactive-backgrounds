// Diorama — the paper theatre skin: a mechanical toy theatre at real size, playing "The Voyage of the Petrel".
//
// The screen is the front of a table-top theatre about 55 cm wide: a painted proscenium a couple of
// centimetres behind the glass, a red curtain, and behind that a stage 33 cm deep on which everything is a
// piece of painted card (stageart.js) worked from off stage. The sea is four rows of cut waves that slide
// and bob against one another; the ship rides between the second and third; the sun and the moon come up on
// rods; clouds, stars, rain and lightning are let down from the flies; the town slides in from the wings.
// The play (stageplay.js) runs five scenes and a curtain, for ever.
//
// It suits the window because a toy theatre is already a stack of flat things at different depths, each
// facing the audience: move your head and the rows of the sea shear past one another, and from the side you
// can see into the wings.
//
// How it is lit: as a stage is. Footlights (a spot from the front edge of the stage, throwing shadows up the
// scenery), a border light from above the proscenium whose colour is the time of day, and a little house
// light on the proscenium's front. All three have shadow maps, redrawn every frame because nothing here
// stands still. The sky cloth is lit from behind: a gradient laid into its emissive map. Bounce, reflections
// and contact shadows are the computer's (gi.js, post.js).

import * as THREE from 'three';
import { GI } from './gi.js';
import { at, box, rbox, Batch } from './pcparts.js';
import * as art from './stageart.js';
import { Play, SCENES } from './stageplay.js';

const DESIGN = { h: 0.31, d: 0.36, minW: 0.47 };
const LAYER = { LAMPED: 1, DETAIL: 2 };
const MM = 0.001, HALF_PI = Math.PI / 2;
const ASSETS = new URL('../assets/materials/', import.meta.url).href;
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ramp = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a)));
const lerp = (a, b, k) => a + (b - a) * k;
// See noir.js: three.js stops the inverse-square law at 10 cm, which a table-top scene cannot live with.
const NEAR_LIGHTS = THREE.ShaderChunk.lights_pars_begin.replace('max( pow( lightDistance, decayExponent ), 0.01 )', 'max( pow( lightDistance, decayExponent ), 0.00001 )');

/**
 * The sky and the light for each scene, as keys through it: [u, top of the cloth, foot of it, the border
 * light's colour, its level, the footlights' level].
 */
const SKY = [
  [[0, 0x141c3c, 0x5a3550, 0x8fa0ff, 0.3, 0.5], [0.35, 0x4d7fc0, 0xf2b98a, 0xffd9b0, 0.8, 0.8], [1, 0x4f9be0, 0xcfe6f2, 0xfff6e6, 1, 1]],
  [[0, 0x3f8fe0, 0xbfe2f2, 0xfff6e6, 1.05, 1], [1, 0x3f8fe0, 0xbfe2f2, 0xfff6e6, 1.05, 1]],
  [[0, 0x3b5a78, 0x9fb0b0, 0xdfe6ea, 0.8, 0.9], [0.2, 0x10151c, 0x2c3a38, 0x8fa6b4, 0.34, 0.45], [0.8, 0x10151c, 0x2c3a38, 0x8fa6b4, 0.34, 0.45], [1, 0x2a3550, 0x5c6a78, 0xb0bccb, 0.5, 0.6]],
  [[0, 0x050a20, 0x18294e, 0x7f9aff, 0.3, 0.3], [1, 0x050a20, 0x18294e, 0x7f9aff, 0.3, 0.3]],
  [[0, 0x3a5fa8, 0xf4a860, 0xffcf9a, 0.9, 0.9], [0.5, 0x1c1f4a, 0xb0486a, 0xe69ab0, 0.5, 0.6], [1, 0x070a20, 0x2a2248, 0x8088e6, 0.3, 0.4]],
];

const textureCache = new Map(), artCache = new Map();
function scan(renderer, key, map) {
  const id = `${key}/${map}`;
  if (!textureCache.has(id)) {
    const t = new THREE.TextureLoader().load(`${ASSETS}${key}/${map}.jpg`, undefined, undefined, () => console.warn(`Diorama: could not load the ${key} ${map} map; that surface stays plain`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (map === 'color') t.colorSpace = THREE.SRGBColorSpace;
    textureCache.set(id, t);
  }
  return textureCache.get(id);
}
/** A piece of card from stageart.js, painted once for the page. */
function piece(key, make) { if (!artCache.has(key)) artCache.set(key, make()); return artCache.get(key); }

export class Theatre {
  constructor(scene, renderer, { width, height }, ctx = {}) {
    this.scene = scene; this.renderer = renderer; this.ctx = ctx;
    this.disposables = [];
    const own = (x) => { this.disposables.push(x); return x; };
    const s = Math.min(height / DESIGN.h, width / DESIGN.minW);
    this.scale = s;
    const L = { w: width / s, h: height / s, d: DESIGN.d };
    this.L = L;
    const root = new THREE.Group();
    root.scale.setScalar(s); root.position.set(-width / 2, -height / 2, -L.d * s);
    this.root = root;
    this.look = { ao: { radius: 0.014 * s, intensity: 0.9 }, bloom: { strength: 0.3, radius: 0.6, threshold: 0.92 }, exposure: 1.1, vignette: 0.28 };
    const min = new THREE.Vector3(-width / 2, -height / 2, -L.d * s), max = new THREE.Vector3(width / 2, height / 2, 0);
    this.gi = new GI(renderer, scene, { min, max, counts: [Math.max(6, Math.round(L.w / 0.065)), 5, 5], reflectBoxMax: new THREE.Vector3(width / 2, height / 2, 0.3 * s), probeLayers: [0], envLayers: [0, LAYER.DETAIL] });

    // --- Materials ---
    const std = (o) => {
      const m = own(new THREE.MeshStandardMaterial(o));
      m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <lights_pars_begin>', NEAR_LIGHTS); };
      m.customProgramCacheKey = () => 'near';
      return this.gi.patch(m);
    };
    const scanned = (key, tile, o = {}) => ({ material: std({ map: scan(renderer, key, 'color'), normalMap: scan(renderer, key, 'normal'), roughnessMap: scan(renderer, key, 'roughness'), ...o }), tile });
    const M = {
      boards: scanned('floor', 0.16, { color: 0x2c2723, roughness: 1 }) /* a stage floor is painted dark and flat */, wood: scanned('wood', 0.12, { color: 0x6e4a32 }), pine: scanned('woodLight', 0.12, { color: 0xb9a078 }),
      brass: { material: std({ color: 0xb08d4f, roughness: 0.32, metalness: 1 }) }, gilt: { material: std({ color: 0xc9a04a, roughness: 0.5, metalness: 0.25 }) }, iron: { material: std({ color: 0x1b1b1d, roughness: 0.5, metalness: 0.6 }) }, void: { material: std({ color: 0x050505, roughness: 0.95 }) },
    };
    for (const k of Object.keys(M)) M[k].tile ??= 0.1;
    const cardMat = (map, o = {}) => std({ map, roughness: 0.93, ...o });
    const basic = (o) => own(new THREE.MeshBasicMaterial(o));

    // --- The geometry of the house ---
    const cx = L.w / 2, D = L.d, y0 = 0.05, a = Math.min(0.225, cx - 0.045), y1 = L.h - 0.045, zP = D - 0.025;
    this.G = { cx, y0, a, y1, zP };
    const b = new Batch();
    b.add('boards', at(box(L.w + 0.1, 0.012, zP), cx, y0 - 0.006, zP / 2)); // the stage stops at the proscenium; the table runs on to the glass
    b.add('pine', at(box(L.w + 0.1, 0.01, D), cx, 0.005, D / 2));                                 // the table it stands on
    b.add('pine', at(box(0.012, L.h + 0.1, D), cx - a - 0.075, L.h / 2, D / 2)); b.add('pine', at(box(0.012, L.h + 0.1, D), cx + a + 0.075, L.h / 2, D / 2));
    b.add('pine', at(box(L.w + 0.1, L.h + 0.1, 0.008), cx, L.h / 2, -0.004));
    b.add('pine', at(box(L.w + 0.1, 0.01, D * 0.45), cx, L.h + 0.035, D * 0.2));                  // the roof over the back half; the front is open to the grid
    // The grid: battens across the top that everything hung is tied off to, and the slots in the floor that
    // everything risen comes up through.
    const rows = [0.085, 0.125, 0.185, 0.235];
    this.rowsZ = rows;
    for (const z of [0.03, 0.06, 0.1, 0.14, 0.2, 0.26, 0.31]) b.add('wood', at(rbox(L.w + 0.06, 0.008, 0.012, 0.002), cx, L.h + 0.012, z));
    for (const z of [...rows, 0.035, 0.105, 0.155, 0.21]) b.add('void', at(box(2 * a + 0.12, 0.0006, 0.004), cx, y0 + 0.0003, z));
    // The footlights: a brass trough along the front of the stage with nine lamps behind it.
    // They stand where footlights do: on a shelf in front of the proscenium, so they light the curtain as well as the stage.
    b.add('wood', at(box(2 * a - 0.01, 0.004, 0.022), cx, y0 - 0.002, zP + 0.011)); b.add('gilt', at(rbox(2 * a - 0.02, 0.013, 0.002, 0.0008), cx, y0 + 0.0065, zP + 0.02));
    for (const mesh of b.build(M)) { root.add(mesh); own(mesh.geometry); }
    const bulbs = new THREE.InstancedMesh(own(new THREE.SphereGeometry(0.0035, 10, 8)), (this.bulbMat = basic({ color: 0x000000 })), 9);
    for (let i = 0; i < 9; i++) bulbs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(cx + (i - 4) * (2 * a - 0.06) / 8, y0 + 0.005, zP + 0.013));
    bulbs.layers.set(LAYER.LAMPED); root.add(bulbs);

    // --- Card ---
    /** A card as a mesh. `c` is { geo, map } from stageart.js. */
    const mesh = (c, parent = root, o = {}) => {
      if (o.emissive) o.emissiveMap = c.map; // a piece that glows, glows where it is painted
      const m = new THREE.Mesh(c.geo, o.material ?? cardMat(c.map, o));
      m.castShadow = m.receiveShadow = true; parent.add(m);
      return m;
    };
    const R = renderer;
    this.cast = {};
    /** Registers something worked from off stage: where it plays (home), and which way it leaves (away: dx, dy). */
    const player = (name, obj, home, away, scenes = []) => { obj.position.set(...home); root.add(obj); this.cast[name] = { obj, home, away, k: 0, show: 0, scenes, off: [0, 0], rot: 0 }; return obj; };
    const threads = (obj, xs, y, len = 0.34) => { for (const x of xs) { const t = new THREE.Mesh(this.threadGeo ??= own(new THREE.CylinderGeometry(0.00012, 0.00012, 1, 4).translate(0, 0.5, 0)), this.threadMat ??= std({ color: 0xd8d2c4, roughness: 0.5 })); t.position.set(x, y, 0); t.scale.y = len; t.layers.set(LAYER.DETAIL); obj.add(t); } };
    const rod = (obj, x, len = 0.22) => { const r = new THREE.Mesh(this.rodGeo ??= own(new THREE.CylinderGeometry(0.0012, 0.0012, 1, 6).translate(0, -0.5, 0)), M.iron.material); r.position.set(x, 0.004, -0.0012); r.scale.y = len; obj.add(r); };

    // The sky cloth, lit from behind.
    this.skyCanvas = document.createElement('canvas'); this.skyCanvas.width = 4; this.skyCanvas.height = 128;
    this.skyTex = own(new THREE.CanvasTexture(this.skyCanvas)); this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.skyMat = std({ color: 0x3c3a36, roughness: 1, normalMap: scan(R, 'paper', 'normal'), emissive: 0xffffff, emissiveMap: this.skyTex });
    const sky = new THREE.Mesh(own(new THREE.PlaneGeometry(2 * a + 0.16, y1 - y0 + 0.09)), this.skyMat);
    sky.position.set(cx, (y0 + y1) / 2 + 0.03, 0.012); sky.receiveShadow = true; root.add(sky);

    // The sea: four rows, paler and smaller toward the back.
    const sea = [{ amp: 8, step: 30, body: 22, deep: '#3a7d92', top: '#8cc4c8' }, { amp: 10, step: 37, body: 22, deep: '#266a84', top: '#63adba' }, { amp: 12, step: 45, body: 21, deep: '#17536e', top: '#4494a8' }, { amp: 15, step: 54, body: 20, deep: '#0f3e58', top: '#2f7c94' }];
    this.rows = sea.map((o, i) => { const m = mesh(piece(`waves${i}`, () => art.waves(R, { ...o, w: 760, seed: i + 1 }))); m.position.set(cx, y0 - 0.004, rows[i]); return m; });

    // The Petrel.
    const ship = new THREE.Group();
    for (const p of piece('ship', () => art.ship(R))) mesh(p, ship).position.z = p.z * MM;
    ship.scale.setScalar(0.92);
    this.shipLamp = new THREE.Mesh(own(new THREE.SphereGeometry(0.0016, 8, 6)), basic({ color: 0x000000 })); this.shipLamp.position.set(-0.061, 0.039, 0.002); this.shipLamp.layers.set(LAYER.LAMPED); ship.add(this.shipLamp);
    rod(ship, 0, 0.2);
    this.ship = ship; ship.position.set(cx, y0 + 0.004, 0.155); root.add(ship);
    this.shipX = cx - 0.07;

    // The sky's company.
    rod(player('sun', mesh(piece('sun', () => art.sun(R))), [cx + 0.05, y0 + 0.1, 0.034], [0, -0.3]), 0, 0.3);
    this.moon = mesh(piece('moon', () => art.moon(R)), root, { emissive: 0xfff3c8, emissiveIntensity: 0 }); // thin paper, with a lamp behind it
    rod(player('moon', this.moon, [cx - 0.11, y0 + 0.09, 0.036], [0, -0.3]), 0, 0.3);
    const cloudAt = [[-0.13, 0.15, 0.06, 86, 0], [0.08, 0.162, 0.062, 110, 1], [0.0, 0.135, 0.11, 70, 2]];
    cloudAt.forEach(([x, y, z, w, i]) => { const c = player(`cloud${i}`, mesh(piece(`cloud${i}`, () => art.cloud(R, w, i + 3))), [cx + x, y0 + y - 0.02, z], [0, 0.25], [0, 1, 4]); threads(c, [-w * 0.3 * MM, w * 0.3 * MM], w * 0.3 * MM); });
    [[-0.1, 0.165, 0.1, 190, 0], [0.11, 0.15, 0.142, 220, 1], [0.0, 0.18, 0.07, 170, 2]].forEach(([x, y, z, w, i]) => { const c = player(`storm${i}`, mesh(piece(`storm${i}`, () => art.cloud(R, w, i + 11, true))), [cx + x, y0 + y - 0.03, z], [0, 0.28], [2]); threads(c, [-w * 0.3 * MM, w * 0.3 * MM], w * 0.28 * MM); });
    // Stars, each on its own thread and each turning a little.
    const starCard = piece('star', () => art.star(R));
    this.stars = new THREE.Group();
    this.starMat = cardMat(starCard.map, { emissive: 0xffe9a0, emissiveMap: starCard.map, emissiveIntensity: 0, roughness: 0.4, metalness: 0.5 }); // gilt foil
    for (let i = 0; i < 26; i++) { const st = mesh(starCard, this.stars, { material: this.starMat }); st.position.set(rnd(-a + 0.02, a - 0.02), rnd(0.095, y1 - y0 - 0.02), rnd(-0.012, 0.03)); st.scale.setScalar(rnd(0.6, 1.25)); st.userData.w = rnd(0.6, 1.6); threads(st, [0], 0.012, 0.3 / st.scale.y); }
    player('stars', this.stars, [cx, y0, 0.045], [0, 0.3], [3]);
    // Rain: threads let down on a slant, with a bead of glue every so often.
    const rainGeo = own(new THREE.CylinderGeometry(0.00022, 0.00022, 0.26, 4)), rain = new THREE.InstancedMesh(rainGeo, std({ color: 0xcfe0e8, roughness: 0.3 }), 90), mat4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.22));
    for (let i = 0; i < 90; i++) rain.setMatrixAt(i, mat4.compose(new THREE.Vector3(rnd(-a - 0.02, a + 0.02), 0.14, rnd(-0.07, 0.07)), q, new THREE.Vector3(1, 1, 1)));
    rain.layers.set(LAYER.DETAIL);
    player('rain', rain, [cx, y0, 0.15], [0, 0.32], [2]);
    this.bolt = mesh(piece('bolt', () => art.bolt(R)), root, { emissive: 0xfff4c0, emissiveIntensity: 3 }); this.bolt.position.set(cx, y0 + 0.05, 0.075); this.bolt.visible = false; this.bolt.castShadow = false;
    // Gulls on their wires.
    this.gulls = [0, 1, 2].map((i) => { const gm = mesh(piece('gull', () => art.gull(R))); gm.position.set(cx - 0.1 + i * 0.09, y0 + 0.13 + (i % 2) * 0.03, 0.118 + i * 0.012); gm.userData = { x: gm.position.x, y: gm.position.y, ph: i * 2.1 }; threads(gm, [0], 0.004, 0.3); return gm; });
    this.gullLift = 0;

    // The harbour.
    const tw = piece('town', () => art.town(R)), town = mesh(tw);
    const lit = new THREE.PlaneGeometry(0.0046, 0.007), litMesh = new THREE.InstancedMesh(own(lit), (this.windowMat = basic({ color: 0x000000 })), tw.windows.length);
    tw.windows.forEach(([x, y], i) => litMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x * MM, y * MM, 0.00075))); litMesh.layers.set(LAYER.LAMPED); town.add(litMesh); this.litWindows = litMesh;
    player('town', town, [cx - 0.075, y0 + 0.014, 0.068], [-0.45, 0], [0, 4]);
    const lh = player('lighthouse', mesh(piece('lighthouse', () => art.lighthouse(R))), [cx + a - 0.062, y0 + 0.01, 0.1], [0.3, 0], [0, 4]);
    this.beacon = new THREE.Mesh(own(new THREE.PlaneGeometry(0.016, 0.015)), basic({ color: 0x000000 })); this.beacon.position.set(0, 0.1345, 0.0008); this.beacon.layers.set(LAYER.LAMPED); lh.add(this.beacon);
    const qy = player('quay', mesh(piece('quay', () => art.quay(R))), [cx - 0.09, y0 + 0.002, 0.105], [0, -0.07], [0, 4]);
    this.lanterns = new THREE.InstancedMesh(own(new THREE.SphereGeometry(0.0022, 8, 6)), (this.lanternMat = basic({ color: 0x000000 })), 9);
    for (let i = 0; i < 9; i++) this.lanterns.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-0.15 + i * 0.037, 0.05 - 0.008 * Math.sin(i / 8 * Math.PI), 0.001)); this.lanterns.layers.set(LAYER.LAMPED); qy.add(this.lanterns);
    this.pano = player('panorama', mesh(piece('panorama', () => art.panorama(R))), [cx, y0 + 0.016, 0.052], [0, -0.1], [1]);

    // What comes up out of the sea.
    const sp = piece('serpent', () => art.serpent(R));
    this.serpent = { tail: mesh(sp.tail), humps: [mesh(sp.hump), mesh(sp.hump)], head: mesh(sp.head), k: 0, show: 0 };
    this.serpent.head.scale.x = -1;
    for (const m of [this.serpent.tail, ...this.serpent.humps, this.serpent.head]) rod(m, 0, 0.2);
    const wh = piece('whale', () => art.whale(R));
    this.whale = { body: mesh(wh.body), fluke: mesh(wh.fluke), spout: mesh(wh.spout), k: 0, show: 0, fk: 0, flukeFor: 0, blow: 0 };
    this.whale.spout.castShadow = false;
    const dol = piece('dolphin', () => art.dolphin(R));
    this.dolphins = [0, 1, 2].map(() => { const m = mesh(dol); m.visible = false; return { m, t: -1 }; });
    this.fallStar = mesh(starCard, root, { material: this.starMat }); this.fallStar.visible = false; this.fallT = -1;
    this.rockets = ['#ff5a4a', '#5ad0ff', '#ffd75a'].map((c, i) => { const m = mesh(piece(`burst${i}`, () => art.burst(R, c)), root, { emissive: new THREE.Color(c), emissiveIntensity: 0 }); m.visible = false; m.castShadow = false; return { m, t: -1, x: 0, colour: new THREE.Color(c) }; });
    this.rocketLight = new THREE.PointLight(0xffffff, 0, 0.4 * s, 2); this.rocketLight.position.set(cx - 0.05, y0 + 0.19, 0.09); root.add(this.rocketLight);

    // --- The house: wings, borders, the curtain, the proscenium, the placard ---
    for (const side of [-1, 1]) for (const [z, w] of [[0.2, 60], [0.275, 70]]) mesh(piece(`wing${side}${w}`, () => art.wing(R, w, (y1 - y0) * 1000 + 40, side))).position.set(cx + side * (a + 0.03 + (z > 0.25 ? 0.004 : 0.018)), y0, z);
    for (const [z, h] of [[0.215, 34], [0.31, 40]]) mesh(piece(`border${h}`, () => art.border(R, 2 * a * 1000 + 120, h))).position.set(cx, y1 - h * MM + 0.012, z);
    const pc = piece(`prosc${Math.round(L.w * 1000)}x${Math.round(L.h * 1000)}`, () => art.proscenium(R, L.w * 1000 + 30, L.h * 1000 + 16, { w: 2 * a * 1000, y0: y0 * 1000 + 8, y1: y1 * 1000 + 8 }));
    mesh(pc).position.set(cx, -0.008, zP);
    // The curtain: two halves of red cloth in deep folds, each drawn to its own side and gathered there.
    const fold = (wd, ht) => { const g = new THREE.PlaneGeometry(wd, ht, 64, 1).translate(wd / 2, ht / 2, 0), p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, 0.0045 * Math.sin(p.getX(i) / wd * Math.PI * 15) + 0.002 * Math.sin(p.getX(i) / wd * Math.PI * 41)); g.computeVertexNormals(); return own(g); };
    const cloth = std({ map: scan(R, 'cloth', 'color'), normalMap: scan(R, 'cloth', 'normal'), roughnessMap: scan(R, 'cloth', 'roughness'), color: 0xb22a26, side: THREE.DoubleSide });
    this.curtain = [-1, 1].map((side) => {
      const g = new THREE.Group(), half = new THREE.Mesh(fold(a + 0.012, y1 - y0 + 0.02), cloth);
      half.geometry.attributes.uv.array.forEach((v, i, arr) => { arr[i] = v * (i % 2 ? 3 : 4); });
      half.castShadow = half.receiveShadow = true; g.add(half);
      const fringe = new THREE.Mesh(own(new THREE.BoxGeometry(a + 0.012, 0.006, 0.011).translate((a + 0.012) / 2, 0.003, 0)), M.brass.material); g.add(fringe);
      g.position.set(cx + side * (a + 0.012), y0, zP - 0.011); g.scale.x = -side; root.add(g);
      return g;
    });
    this.placards = SCENES.map((sc) => piece(`placard${sc.key}`, () => art.placard(R, sc.numeral, sc.title)));
    this.placard = mesh(this.placards[0]); this.placard.position.set(cx - a + 0.03, 0.011, D - 0.011); this.placard.rotation.x = -0.12;
    const easel = new THREE.Mesh(own(new THREE.BoxGeometry(0.05, 0.003, 0.012)), M.wood.material); easel.position.set(0, -0.0012, -0.004); this.placard.add(easel);

    // --- Lamps ---
    const k = s * s; this.k = k;
    const spot = (colour, angle, size, pos, target, near, far) => {
      const l = new THREE.SpotLight(colour, 0, 0, angle, 0.7, 2);
      l.castShadow = true; l.shadow.mapSize.set(size, size); l.shadow.camera.near = near * s; l.shadow.camera.far = far * s; l.shadow.bias = -0.0012; l.shadow.normalBias = 0.0012 * s;
      l.position.set(...pos); l.target.position.set(...target); root.add(l, l.target);
      return l;
    };
    const big = ctx.lowPower ? 1024 : 2048;
    this.foots = spot(0xffd9a0, 1.2, big, [cx, y0 + 0.011, zP + 0.012], [cx, y0 + 0.11, 0.02], 0.006, 0.6);
    // Just under the arch and in front of the borders: from above them, the borders shadowed everything hung high.
    this.borderLight = spot(0xffffff, 1.15, big, [cx, y1 - 0.03, zP - 0.04], [cx, y0 + 0.04, 0.03], 0.02, 0.7);
    this.house = spot(0xffe2b8, 0.5, 1024, [cx, L.h * 0.95, D + 1.1], [cx, L.h * 0.45, D], 0.3, 2.2); // the room's light, from where the audience sits

    scene.add(root);
    for (const l of Object.values(LAYER)) ctx.camera?.layers.enable(l);

    // --- The play ---
    const start = Math.max(0, SCENES.findIndex((c) => c.key === (ctx.mode ?? '').toLowerCase() || c.title.toLowerCase() === (ctx.mode ?? '').toLowerCase()));
    this.play = new Play(start);
    this.set(start);
    this.sea = 1; this.flash = 0; this.sailing = false; this.lamps = 0; this.lampsOn = false; this.fishDue = rnd(8, 20);
    this.time = 0; this.eyeSpeed = 0; this.lastEye = null;
    this.c1 = new THREE.Color(); this.c2 = new THREE.Color(); this.c3 = new THREE.Color();
    for (const p of Object.values(this.cast)) { p.k = p.show; }
    this.animate(0);
  }

  // MARK: - The play's hooks

  get modeLabel() { return 'Scene'; }
  get modeName() { return this.play.scene.title; }
  cycleMode() { this.play.skip(); return SCENES[(this.play.index + 1) % SCENES.length].title; }

  /** Sets the stage for scene `n`: who is on, and where the ship starts. */
  set(n) {
    for (const p of Object.values(this.cast)) p.show = p.scenes.includes(n) ? 1 : 0;
    this.cast.sun.show = n === 0 || n === 1 || n === 4 ? 1 : 0;
    this.cast.moon.show = n === 3 ? 1 : 0;
    const { cx, a } = this.G;
    this.shipX = [cx - 0.07, cx - a - 0.12, cx - 0.04, cx - 0.02, cx - a - 0.12][n];
    this.sailing = false; this.lampsOn = false; this.serpent.show = 0; this.whale.show = 0;
    if (this.placard.material.map !== this.placards[n].map) { this.placard.geometry = this.placards[n].geo; this.placard.material.map = this.placards[n].map; }
    this.gi.rush(1);
  }

  handle(events) {
    for (const e of events) {
      if (e.type === 'scene') this.ctx.say?.(SCENES[e.index].caption);
      else if (e.type === 'set') this.set(e.index);
      else if (e.type === 'cue') this.cue(e.what);
    }
  }

  cue(what) {
    const { cx, a } = this.G;
    if (what === 'sail') this.sailing = true;
    else if (what === 'leap') { const d = this.dolphins.find((o) => o.t < 0); if (d) { d.t = 0; d.x = this.shipX + rnd(-0.14, 0.16); d.dir = Math.random() < 0.7 ? 1 : -1; d.z = Math.random() < 0.5 ? 0.17 : 0.21; d.size = 1; } }
    else if (what === 'fish') { const d = this.dolphins.find((o) => o.t < 0); if (d) { d.t = 0; d.x = cx + rnd(-a + 0.05, a - 0.05); d.dir = Math.random() < 0.5 ? 1 : -1; d.z = 0.21; d.size = 0.5; } }
    else if (what === 'bolt') { this.flash = 1; this.boltFor = 0.28; this.bolt.position.x = cx + rnd(-a + 0.05, a - 0.05); this.bolt.scale.x = Math.random() < 0.5 ? 1 : -1; }
    else if (what === 'serpent') this.serpent.show = 1;
    else if (what === 'dive') this.serpent.show = 0;
    else if (what === 'whale') this.whale.show = 1;
    else if (what === 'spout') this.whale.blow = 1;
    else if (what === 'sound') { this.whale.show = 0; this.whale.flukeFor = 3.2; }
    else if (what === 'fall') this.fallT = 0;
    else if (what === 'lamps') this.lampsOn = true;
    else if (what === 'rocket') { const r = this.rockets.find((o) => o.t < 0); if (r) { r.t = 0; r.x = cx + rnd(-0.17, 0.05); r.top = rnd(0.13, 0.19); } }
    else return null;
    return what;
  }

  /** Starts an effect by name (the E key and the console). */
  trigger(name) {
    const names = ['leap', 'bolt', 'rocket', 'spout', 'fall', 'fish'];
    return this.cue(name ?? names[(this.cycle = ((this.cycle ?? -1) + 1) % names.length)]);
  }

  /** A click: the effects man obliges. Lightning in the storm, a rocket over the harbour at night, otherwise a dolphin. */
  knock() {
    const n = this.play.index;
    if (this.play.phase !== 'scene') return;
    this.cue(n === 2 ? 'bolt' : n === 4 && this.play.u > 0.45 ? 'rocket' : n === 3 && this.whale.show ? 'spout' : 'leap');
  }

  // MARK: - Every frame

  step(dt, time, eye) {
    this.time = time;
    if (eye) {
      if (this.lastEye && dt > 0) this.eyeSpeed += (Math.hypot(eye.x - this.lastEye.x, eye.y - this.lastEye.y, eye.z - this.lastEye.z) / dt - this.eyeSpeed) * Math.min(1, dt * 8);
      this.lastEye = { ...eye };
    }
    this.handle(this.play.step(dt));
    if (this.play.phase === 'scene' && this.play.index !== 2) { this.fishDue -= dt; if (this.fishDue <= 0) { this.fishDue = rnd(14, 40); this.cue('fish'); } }
    this.animate(dt);
  }

  animate(dt) {
    const play = this.play, n = play.index, u = play.phase === 'scene' ? play.u : play.phase === 'opening' ? 0 : 1, t = this.time;
    const { cx, y0, a, y1 } = this.G, ease = (rate) => Math.min(1, dt * rate);
    const playing = play.phase === 'scene';

    // The sea's temper: three times the swell in the storm.
    const storm = n === 2 ? ramp(0.08, 0.25, u) * (1 - ramp(0.8, 1, u)) : 0;
    this.sea += ((1 + 2.4 * storm) - this.sea) * ease(0.8);
    const sea = this.sea, w = 0.9 + 0.5 * (sea - 1);
    this.rows.forEach((row, i) => {
      const dir = i % 2 ? -1 : 1, ph = i * 1.7;
      row.position.x = cx + dir * 0.011 * sea * Math.sin(t * w + ph);
      row.position.y = y0 - 0.004 + (0.0022 + 0.0006 * i) * sea * Math.sin(t * w * 2 + ph * 1.3) - 0.002 * (sea - 1);
      row.rotation.z = 0.006 * (sea - 1) * Math.sin(t * w * 0.7 + ph);
    });

    // The ship's passage.
    const speed = [this.sailing ? 0.016 : 0, 0.0058, 0.0012 * Math.sin(t * 0.3), 0.0012, 0.0062][n] * (playing ? 1 : 0.4);
    const stop = [9, cx + 0.01, 9, 9, cx - 0.085][n];
    this.shipX = Math.min(stop, this.shipX + speed * dt);
    const sp = this.ship;
    sp.position.set(this.shipX, y0 + 0.017 + 0.003 * sea * Math.sin(t * w * 2 + 1.1), 0.155);
    sp.rotation.z = (0.035 + 0.075 * (sea - 1)) * Math.sin(t * w + 0.4) + 0.02 * Math.sin(t * 2.3) * (sea - 1);

    // The cast: each eases between its place off stage and its place on.
    for (const p of Object.values(this.cast)) {
      p.k += (p.show - p.k) * ease(1.1);
      const k = smooth(p.k);
      p.obj.position.set(p.home[0] + p.away[0] * (1 - k) + p.off[0], p.home[1] + p.away[1] * (1 - k) + p.off[1], p.home[2]);
      p.obj.rotation.z = p.rot;
    }
    const C = this.cast;
    // The sun's and the moon's travel.
    C.sun.off = n === 0 ? [0, lerp(-0.085, 0.04, smooth(u))] : n === 1 ? [lerp(-0.2, 0.1, u), 0.005 + 0.03 * Math.sin(u * Math.PI)] : n === 4 ? [0.02, lerp(0.0, -0.2, smooth(ramp(0, 0.55, u)))] : C.sun.off;
    C.sun.rot = 0;
    C.moon.off = [0.02 * u, lerp(-0.1, 0.012, smooth(ramp(0, 0.3, u)))]; C.moon.rot = 0.04 * Math.sin(t * 0.4);
    if (n === 4) C.stars.show = playing && u > 0.55 ? 1 : 0;
    ['cloud0', 'cloud1', 'cloud2'].forEach((key, i) => { C[key].off = [0.018 * Math.sin(t * 0.11 + i * 2) + (n === 1 ? (u - 0.5) * 0.06 * (i + 1) * 0.5 : 0), 0.002 * Math.sin(t * 0.5 + i)]; C[key].rot = 0.01 * Math.sin(t * 0.4 + i); });
    ['storm0', 'storm1', 'storm2'].forEach((key, i) => { C[key].off = [0.012 * Math.sin(t * 0.5 + i * 2), 0.004 * Math.sin(t * 0.9 + i)]; C[key].rot = 0.015 * Math.sin(t * 0.6 + i); C[key].show = n === 2 && storm > 0.05 ? 1 : 0; });
    C.rain.show = n === 2 && storm > 0.5 ? 1 : 0; C.rain.off = [0.004 * Math.sin(t * 9), 0.006 * Math.sin(t * 13)];
    C.panorama.off = [n === 1 ? lerp(0.38, -0.38, u) : C.panorama.off[0], 0];
    for (const st of this.stars.children) st.rotation.y = 0.9 * Math.sin(t * st.userData.w + st.position.x * 40);

    // Gulls: a slow figure on their wires; a start, and up they go.
    if (this.eyeSpeed > 0.6) this.gullLift = 1;
    this.gullLift = Math.max(0, this.gullLift - dt * 0.35);
    const gullsOn = (n === 0 || n === 1 || n === 4) && !(n === 4 && u > 0.6);
    this.gullK = (this.gullK ?? 0) + ((gullsOn ? 1 : 0) - (this.gullK ?? 0)) * ease(1);
    this.gulls.forEach((gm) => {
      const d = gm.userData, lift = smooth(this.gullLift) * 0.06 + (1 - smooth(this.gullK)) * 0.3;
      gm.position.set(d.x + 0.03 * Math.sin(t * 0.5 + d.ph), d.y + 0.012 * Math.sin(t * 1.0 + d.ph) + lift, gm.position.z);
      gm.rotation.z = 0.25 * Math.cos(t * 0.5 + d.ph); gm.scale.y = 0.55 + 0.45 * Math.sin(t * (5 + 6 * this.gullLift) + d.ph);
    });

    // The serpent: tail, two humps and the head, each on its own rod, coming up one after another.
    const S = this.serpent;
    S.k += (S.show - S.k) * ease(0.7);
    const sx = this.shipX, rise = (delay) => smooth(ramp(delay, delay + 0.45, S.k));
    const sUp = (m, x, z, delay, lift) => { const r = rise(delay); m.visible = r > 0.01; m.position.set(x, y0 - 0.13 + (0.13 + lift) * r + 0.006 * Math.sin(t * 2.2 - x * 30), z); m.rotation.z = 0.08 * Math.sin(t * 1.6 - x * 25); };
    sUp(S.tail, sx - 0.2, 0.14, 0, -0.012); sUp(S.humps[0], sx - 0.125, 0.14, 0.12, -0.02); sUp(S.humps[1], sx + 0.19, 0.172, 0.24, -0.024); sUp(S.head, sx + 0.115, 0.172, 0.4, 0.0);
    S.head.rotation.z = 0.12 * Math.sin(t * 1.3) - 0.1 * rise(0.4);

    // The whale.
    const W = this.whale, wx = cx - 0.12;
    W.k += (W.show - W.k) * ease(0.6); W.flukeFor -= dt; W.fk += ((W.flukeFor > 0.8 ? 1 : 0) - W.fk) * ease(1.6); W.blow = Math.max(0, W.blow - dt * 0.45);
    W.body.visible = W.k > 0.01; W.body.position.set(wx, y0 - 0.075 + 0.07 * smooth(W.k) + 0.003 * Math.sin(t * 0.8), 0.21); W.body.rotation.z = 0.03 * Math.sin(t * 0.6);
    W.fluke.visible = W.fk > 0.01; W.fluke.position.set(wx + 0.16, y0 - 0.08 + 0.085 * smooth(W.fk), 0.212); W.fluke.rotation.z = -0.3 + 0.5 * Math.sin(Math.min(1, W.fk) * Math.PI);
    const blow = Math.sin(Math.min(1, (1 - W.blow) * 2.4) * Math.PI) ** 0.6 || 0;
    W.spout.visible = W.blow > 0.02 && W.k > 0.5; W.spout.position.set(wx - 0.035, W.body.position.y + 0.058, 0.2105); W.spout.scale.set(0.6 + 0.4 * blow, Math.max(0.02, blow), 1);

    // Dolphins and fish: an arc out of one wave and into the next.
    for (const d of this.dolphins) {
      if (d.t < 0) { d.m.visible = false; continue; }
      d.t += dt / 1.5;
      const p = d.t, x = d.x + d.dir * 0.11 * (p - 0.5) * d.size, y = y0 - 0.012 + 0.058 * d.size * Math.sin(Math.PI * p);
      d.m.visible = true; d.m.position.set(x, y, d.z); d.m.scale.set(d.dir * d.size, d.size, 1); d.m.rotation.z = d.dir * Math.atan2(0.058 * Math.PI * Math.cos(Math.PI * p), 0.11);
      if (p >= 1) d.t = -1;
    }
    // A falling star, down its wire.
    if (this.fallT >= 0) { this.fallT += dt / 1.4; const p = this.fallT; this.fallStar.visible = p < 1; this.fallStar.position.set(cx + lerp(0.17, -0.08, p), lerp(y1 - 0.01, y0 + 0.11, p * p), 0.04); this.fallStar.rotation.z = p * 9; this.fallStar.scale.setScalar(1.5); if (p >= 1) this.fallT = -1; } else this.fallStar.visible = false;
    // Rockets: up on a rod, open, hang, and down.
    let glow = 0; const glowCol = this.c3.setRGB(0, 0, 0);
    for (const r of this.rockets) {
      if (r.t < 0) { r.m.visible = false; continue; }
      r.t += dt;
      const up = smooth(r.t / 0.5), open = smooth((r.t - 0.45) / 0.25), fade = 1 - smooth((r.t - 1.5) / 0.7);
      r.m.visible = true; r.m.position.set(r.x, y0 - 0.05 + (r.top + 0.05) * up - 0.046 * open - 0.05 * (1 - fade), 0.05); r.m.scale.setScalar(0.12 + 0.88 * open); r.m.rotation.z = r.t * 0.4;
      r.m.material.emissiveIntensity = 2.4 * open * fade;
      if (open * fade > glow) { glow = open * fade; glowCol.copy(r.colour); this.rocketLight.position.x = r.x; }
      if (r.t > 2.3) r.t = -1;
    }
    this.rocketLight.color.copy(glowCol); this.rocketLight.intensity = 0.006 * this.k * glow;
    // Lightning.
    this.flash = Math.max(0, this.flash - dt * 5); this.boltFor = (this.boltFor ?? 0) - dt;
    this.bolt.visible = this.boltFor > 0; this.bolt.position.y = y1 - 0.19 + 0.01 * Math.sin(t * 90);

    // The curtain.
    const up = smooth(play.curtain);
    this.curtain.forEach((half, i) => { half.scale.x = (i ? -1 : 1) * lerp(1, 0.16, up); });

    // The lights.
    const keys = SKY[n];
    let j = 0; while (j < keys.length - 2 && u > keys[j + 1][0]) j++;
    const A = keys[j], B = keys[j + 1], f = ramp(A[0], B[0], u), L = play.lights, fl = this.flash;
    const top = this.c1.setHex(A[1]).lerp(this.c2.setHex(B[1]), f).multiplyScalar(L).addScalar(fl * 0.9).getStyle();
    const foot = this.c1.setHex(A[2]).lerp(this.c2.setHex(B[2]), f).multiplyScalar(L).addScalar(fl * 0.9).getStyle();
    if (top !== this.skyTop || foot !== this.skyFoot) {
      this.skyTop = top; this.skyFoot = foot;
      const g = this.skyCanvas.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128);
      gr.addColorStop(0, top); gr.addColorStop(0.72, foot); gr.addColorStop(1, foot); g.fillStyle = gr; g.fillRect(0, 0, 4, 128); this.skyTex.needsUpdate = true;
    }
    const keyLevel = lerp(A[4], B[4], f), footLevel = lerp(A[5], B[5], f), k = this.k;
    this.borderLight.color.setHex(A[3]).lerp(this.c2.setHex(B[3]), f).lerp(this.c2.setRGB(0.9, 0.95, 1), Math.min(1, fl));
    this.borderLight.intensity = (0.11 * keyLevel * L + 0.5 * fl) * k;
    this.foots.intensity = 0.03 * Math.max(footLevel * L, 1.1 * (1 - up)) * k; // up on the curtain while it is down
    this.bulbMat.color.setRGB(3, 2.3, 1.4).multiplyScalar(0.15 + 0.85 * Math.max(footLevel * L, 1 - up));
    this.house.intensity = lerp(1.6, 0.5, up) * k;
    // The small lamps: the town's windows, the lighthouse, the quay's lanterns, the ship's stern lamp.
    const dark = 1 - Math.min(1, keyLevel / 0.6);
    this.lamps += ((n === 0 ? 1 - ramp(0.2, 0.4, u) : n === 4 && this.lampsOn ? 1 : 0) - this.lamps) * ease(1.5);
    this.windowMat.color.setRGB(2.6, 1.9, 0.9).multiplyScalar(this.lamps * L);
    this.litWindows.visible = this.lamps * L > 0.02; this.lanterns.visible = n === 4 && this.lampsOn && this.lamps * L > 0.02; // unlit, they are not there
    this.lanternMat.color.setRGB(3, 1.6, 0.6).multiplyScalar((n === 4 && this.lampsOn ? this.lamps : 0) * L);
    this.beacon.material.color.setRGB(3.4, 3, 1.8).multiplyScalar((n === 0 || n === 4 ? (0.25 + 0.75 * dark) * (0.55 + 0.45 * Math.sin(t * 1.6) ** 2) : 0) * L);
    this.shipLamp.material.color.setRGB(3.4, 2.2, 0.8).multiplyScalar(dark * L);
    this.moon.material.emissiveIntensity = 0.85 * L;
    this.starMat.emissiveIntensity = 0.5 * L;
  }

  update() { this.gi.update(this.ctx.lowPower ? 1 : 2); }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.isLight) o.shadow?.map?.dispose(); if (o.isInstancedMesh) o.dispose(); });
    for (const d of this.disposables) d.dispose();
    this.gi.dispose();
    this.ctx.camera?.layers.set(0);
  }
}
