// Diorama — the office skin: a private investigator's office in the rain, as a 1:10 miniature behind the glass.
//
// The screen is the fourth wall of a room box, the kind a miniaturist builds: 3 m of ceiling height in the
// height of the window, 4 m deep. Nobody is ever in it. The story (noirstory.js) is told by what has changed
// on the pinboard and the desk since last night, by the shadows that come to the frosted door, and by what
// the light through the blinds is doing.
//
// How it is lit:
//   The street   One spot lamp outside the window, shining in through the blinds, with a shadow map: the
//                stripes across the floor and the desk are real shadows of the forty slats, near enough. Its colour is
//                the street lamp's blue-white plus whatever else is out there at the moment: the hotel sign's
//                red while it is lit, lightning, a patrol car. Between nights the same lamp is the sun, and
//                it is carried across the sky so the stripes sweep the room.
//   The lamp     The banker's lamp on the desk: a warm spot under a green glass shade. A click pulls its chain.
//   The door     The corridor's light through the frosted glass has no lamp of its own: the light probes see
//                the pane glowing, which is its light, as with the computer's fan rings.
//   Bounce, reflections and contact shadows are the computer's (gi.js, post.js).
//
// noirparts.js builds the room, noirprint.js paints everything flat, and this file lights it and makes it move.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GI } from './gi.js';
import { Batch } from './pcparts.js';
import { makeDust } from './pclife.js';
import { ROOM, plan, buildRoom, buildDoor, buildNight } from './noirparts.js';
import * as print from './noirprint.js';
import { Story, CHAPTERS, daylight } from './noirstory.js';

const LAYER = { LAMPED: 1, DETAIL: 2, PRINT: 3 };
const ASSETS = new URL('../assets/materials/', import.meta.url).href;
// Scanned sets: key -> the room metres one repeat covers (mirrors assets/manifest.json).
const SCANS = { floor: 1.6, wood: 0.9, woodLight: 0.9, plaster: 1.8, leather: 0.5, cloth: 0.35, carpet: 1.2, paper: 0.4, paint: 1.2 };
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ramp = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a)));

const NEAR_LIGHTS = THREE.ShaderChunk.lights_pars_begin.replace('max( pow( lightDistance, decayExponent ), 0.01 )', 'max( pow( lightDistance, decayExponent ), 0.00001 )');
if (NEAR_LIGHTS === THREE.ShaderChunk.lights_pars_begin) console.warn('Diorama: this three.js has a different distance falloff; lamps close to things will be dim');
const textureCache = new Map(), printCache = new Map();
function scan(renderer, key, map) {
  const id = `${key}/${map}`;
  if (!textureCache.has(id)) {
    const t = new THREE.TextureLoader().load(`${ASSETS}${key}/${map}.jpg`, undefined, undefined, () => console.warn(`Diorama: could not load the ${key} ${map} map; that surface stays plain`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (map === 'color') t.colorSpace = THREE.SRGBColorSpace;
    textureCache.set(id, t);
  }
  return textureCache.get(id);
}
function printed(renderer, key) {
  if (!printCache.has(key)) {
    const make = {
      clock: () => print.clockFace(renderer), nameplate: () => print.nameplate(renderer), licence: () => print.licence(renderer),
      paperA: () => print.newspaper(renderer, 'JEWELLER\nVANISHES', 'Harrow Sapphire gone from Finch & Son safe', 'finch'),
      paperB: () => print.newspaper(renderer, 'FINCH FOUND\nALIVE', 'Wife held in $40,000 sapphire plot', 'client'),
      dropit: () => print.note(renderer, ['DROP IT'], { size: 0.5 }), closed: () => print.folderStamp(renderer),
      facade: () => print.facade(renderer), train: () => print.trainWindows(renderer),
    }[key] ?? (key.startsWith('board') ? () => print.pinboard(renderer, Number(key.slice(5))) : key.startsWith('cal') ? () => print.calendar(renderer, CHAPTERS[Number(key.slice(3))].day, CHAPTERS[Number(key.slice(3))].date) : null);
    printCache.set(key, make());
  }
  return printCache.get(key);
}

const RAIN_VERT = /* glsl */ `
uniform float time; uniform vec3 box; uniform vec3 origin; uniform float width;
attribute vec4 seed;
varying float vA;
void main() {
  float cycles = floor( 2800.0 + seed.w * 1400.0 ); // whole falls an hour, so the hourly wrap of time is not seen
  vec3 p = origin + vec3( seed.x, fract( seed.y - time / 3600.0 * cycles ), seed.z ) * box;
  p.x += ( p.y - origin.y ) * 0.06; // a little wind
  p.y += position.y * ( 0.25 + 0.3 * seed.w );
  p.x += position.y * ( 0.25 + 0.3 * seed.w ) * 0.06;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  mv.x += position.x * width;
  gl_Position = projectionMatrix * mv;
  vA = ( 0.35 + 0.65 * fract( seed.w * 5.7 ) ) * ( 1.0 - abs( position.y ) * 2.0 );
}`;
const RAIN_FRAG = /* glsl */ `
uniform vec3 colour; varying float vA;
void main() { gl_FragColor = vec4( colour * vA, 1.0 ); }`;
const SMOKE_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;
const SMOKE_FRAG = /* glsl */ `
uniform float time; uniform vec3 colour; varying vec2 vUv;
void main() {
  float y = vUv.y, x = vUv.x - 0.5;
  float sway = 0.16 * sin( y * 9.0 - time * 1.30027 ) + 0.09 * sin( y * 17.0 + time * 0.90059 ) + 0.05 * sin( y * 31.0 - time * 2.0001 );
  float w = 0.025 + 0.16 * y;
  float a = exp( - pow( ( x - sway * y ) / w, 2.0 ) ) * ( 1.0 - y ) * ( 1.0 - y ) * smoothstep( 0.0, 0.06, y );
  gl_FragColor = vec4( colour * a, 1.0 );
}`;

export class Office {
  constructor(scene, renderer, { width, height }, ctx = {}) {
    this.scene = scene; this.renderer = renderer; this.ctx = ctx;
    this.disposables = [];
    const own = (x) => { this.disposables.push(x); return x; };

    const sc = Math.min(height / ROOM.h, width / ROOM.minW);
    this.scale = sc;
    const R = { w: width / sc, h: height / sc, d: ROOM.d };
    this.R = R;
    const root = new THREE.Group();
    root.scale.setScalar(sc);
    root.position.set(-width / 2, -height / 2, -R.d * sc);
    this.root = root;
    this.look = { ao: { radius: 0.22 * sc, intensity: 1 }, bloom: { strength: 0.38, radius: 0.6, threshold: 0.9 }, exposure: 1.25, vignette: 0.36 };

    const min = new THREE.Vector3(-width / 2, -height / 2, -R.d * sc), max = new THREE.Vector3(width / 2, height / 2, 0);
    this.gi = new GI(renderer, scene, {
      min, max, counts: [Math.max(7, Math.round(R.w / 0.6)), 5, 6],
      reflectBoxMax: new THREE.Vector3(width / 2, height / 2, 0.3 * sc),
      // The lamps' own glowing parts are left out of the reflection cube as well as the probes: each has a real
      // lamp, whose highlight is shadowed properly, and the cube's copy of the green shade showed on walls the
      // desk hides it from.
      probeLayers: [0], envLayers: [0, LAYER.DETAIL, LAYER.PRINT],
    });

    // --- Materials ---
    // three.js stops the inverse-square law at 10 cm (it clamps the squared distance at 0.01), which is right
    // for rooms in metres and wrong for a room 30 cm tall: every lamp nearer than a metre of the miniature
    // lit as if it were a metre away, and the desk lamp threw no pool. Here the clamp is at 3 mm.
    const std = (o) => {
      const m = own(new THREE.MeshStandardMaterial(o));
      m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <lights_pars_begin>', NEAR_LIGHTS); };
      m.customProgramCacheKey = () => 'near';
      return this.gi.patch(m);
    };
    const scanned = (key, o = {}) => ({ material: std({ map: scan(renderer, key, 'color'), normalMap: scan(renderer, key, 'normal'), roughnessMap: scan(renderer, key, 'roughness'), ...o }), tile: SCANS[key] });
    const flat = (color, roughness = 0.6, o = {}) => ({ material: std({ color, roughness, ...o }) });
    const M = {
      floor: scanned('floor', { color: 0x8a7462 }), wall: scanned('plaster', { color: 0x8f9483, normalScale: new THREE.Vector2(0.35, 0.35) }), ceiling: scanned('plaster', { color: 0xa9a696, normalScale: new THREE.Vector2(0.35, 0.35) }),
      dado: scanned('plaster', { color: 0x3a3f39, normalScale: new THREE.Vector2(0.35, 0.35) }), wood: scanned('wood', { color: 0x7a5236 }), woodLight: scanned('woodLight', { color: 0xa98c66 }),
      frame: scanned('woodLight', { color: 0x5d5a4c }), leather: scanned('leather', { color: 0x6b2a20 }), // The cloth scan is red: the coat and the hats take its weave (normal and roughness) and a colour of their own.
      coat: { material: std({ color: 0x8a7a5c, normalMap: scan(renderer, 'cloth', 'normal'), roughnessMap: scan(renderer, 'cloth', 'roughness') }), tile: SCANS.cloth },
      coatBelt: { material: std({ color: 0x6f6148, normalMap: scan(renderer, 'cloth', 'normal'), roughnessMap: scan(renderer, 'cloth', 'roughness') }), tile: SCANS.cloth },
      hat: { material: std({ color: 0x3a3632, normalMap: scan(renderer, 'cloth', 'normal'), roughnessMap: scan(renderer, 'cloth', 'roughness') }), tile: SCANS.cloth }, carpet: scanned('carpet', { color: 0x7a2a26 }), carpetEdge: scanned('carpet', { color: 0x2c1a14 }),
      paper: scanned('paper', { color: 0xe6e0cf }), manila: scanned('paper', { color: 0xc29a58 }), money: scanned('paper', { color: 0x6f8f62 }),
      cabinet: scanned('paint', { color: 0x5b6a56, metalness: 0.35 }), bin: scanned('paint', { color: 0x4a5548, metalness: 0.35, side: THREE.DoubleSide }),
      safe: scanned('paint', { color: 0x1e2622, metalness: 0.5 }), iron: scanned('paint', { color: 0xb9b199, metalness: 0.1 }),
      slat: scanned('paint', { color: 0xc9c2a8, metalness: 0.05 }), tape: flat(0x8b8468, 0.9), cork: flat(0x7b5a38, 0.95), felt: flat(0x1a2a22, 0.95),
      steel: flat(0xb6babf, 0.35, { metalness: 1 }), brass: flat(0xb08d4f, 0.33, { metalness: 1 }), bakelite: flat(0x0c0c0d, 0.28), void: flat(0x050505, 0.9),
      china: flat(0xe9e6dd, 0.25), amber: flat(0x5a2c0a, 0.08), glass: flat(0xcfd8d8, 0.06, { transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      bookRed: flat(0x5c1f1a, 0.7), bookGreen: flat(0x23382a, 0.7), bookBlue: flat(0x1f2c44, 0.7), bookTan: flat(0x8a7350, 0.75),
    };
    for (const k of Object.keys(M)) M[k].tile ??= 0.5;
    this.M = M;

    // --- The room ---
    const batch = new Batch();
    const room = buildRoom(batch, R);
    this.parts = room; this.P = room.plan;
    for (const mesh of batch.build(M)) { root.add(mesh); own(mesh.geometry); }
    const P = this.P;

    // Flat printed things.
    const plane = (key, w, h, pos, rot, o = {}) => {
      const geo = own(o.round ? new THREE.CircleGeometry(w / 2, 48) : new THREE.PlaneGeometry(w, h));
      const mesh = new THREE.Mesh(geo, o.material ?? std({ map: printed(renderer, key), roughness: o.metal ? 0.35 : 0.85, metalness: o.metal ? 0.9 : 0 }));
      mesh.position.set(...pos); mesh.rotation.set(...rot, 'YXZ');
      mesh.layers.set(LAYER.PRINT); mesh.receiveShadow = true;
      (o.parent ?? root).add(mesh);
      return mesh;
    };
    for (const p of room.prints) plane(p.key, p.w, p.h, p.pos, p.rot, p);
    this.board = plane('board0', room.board.w, room.board.h, room.board.pos, [0, 0, 0]);
    this.calendar = plane('cal0', room.calendar.w, room.calendar.h, room.calendar.pos, room.calendar.rot);

    // Things that give light: the lamp's shade and bulb, the cigarette's end.
    const glowGroups = new Map();
    this.glowMat = {
      shade: std({ color: 0x0f3a22, roughness: 0.15, emissive: 0x000000, side: THREE.DoubleSide }),
      bulb: own(new THREE.MeshBasicMaterial({ color: 0x000000 })),
      ember: own(new THREE.MeshBasicMaterial({ color: 0x000000 })),
    };
    const glowMesh = (list, group, parent) => {
      const geo = own(mergeGeometries(list.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const a of Object.keys(n.attributes)) if (a !== 'position' && a !== 'normal') n.deleteAttribute(a); return n; })));
      const mesh = new THREE.Mesh(geo, this.glowMat[group]);
      mesh.layers.set(LAYER.LAMPED); mesh.castShadow = group === 'shade'; // none of them is drawn for the probes: each has a lamp that is its light
      parent.add(mesh);
    };
    for (const e of room.glow) { if (!glowGroups.has(e.group)) glowGroups.set(e.group, []); glowGroups.get(e.group).push(e.geo); }
    for (const [group, list] of glowGroups) glowMesh(list, group, root);

    // --- The door, on its hinge ---
    this.door = new THREE.Group();
    this.door.position.set(...P.door.hinge); this.door.rotation.y = P.door.ry;
    const doorBatch = new Batch(), door = buildDoor(doorBatch);
    for (const mesh of doorBatch.build(M)) { this.door.add(mesh); own(mesh.geometry); }
    this.doorGlass = new print.DoorGlass(renderer);
    this.paneMat = own(new THREE.MeshBasicMaterial({ map: this.doorGlass.texture, color: new THREE.Color(1.5, 1.5, 1.5) }));
    const pane = new THREE.Mesh(own(new THREE.PlaneGeometry(door.glass.w, door.glass.h)), this.paneMat);
    pane.position.set(...door.glass.pos);
    this.door.add(pane);
    root.add(this.door);

    // --- The nights ---
    this.nights = CHAPTERS.map((_, n) => {
      const group = new THREE.Group(), b = new Batch(), night = buildNight(b, R, n);
      for (const mesh of b.build(M)) { group.add(mesh); own(mesh.geometry); }
      for (const p of night.prints) plane(p.key, p.w, p.h, p.pos, p.rot, { ...p, parent: group });
      const embers = night.glow.filter((e) => e.group === 'ember');
      if (embers.length) glowMesh(embers.map((e) => e.geo), 'ember', group);
      group.visible = false;
      root.add(group);
      return { group, ...night };
    });

    // --- What moves ---
    const detail = (mesh, parent = root) => { mesh.layers.set(LAYER.DETAIL); parent.add(mesh); return mesh; };
    // The ceiling fan.
    const blades = [];
    for (let i = 0; i < 4; i++) blades.push(new THREE.BoxGeometry(0.62, 0.012, 0.14).translate(0.42, 0, 0).rotateX(0.2).rotateY(i * Math.PI / 2));
    blades.push(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 24));
    this.fan = detail(new THREE.Mesh(own(mergeGeometries(blades)), M.wood.material));
    this.fan.position.set(...P.fan);
    // The clock's hands.
    const hand = (len, w) => { const m = detail(new THREE.Mesh(own(new THREE.BoxGeometry(w, len, 0.004).translate(0, len * 0.4, 0)), M.bakelite.material)); m.position.set(...room.clock); return m; };
    this.hour = hand(0.1, 0.016); this.minute = hand(0.15, 0.01); this.minute.position.z += 0.005;
    // The telephone's handset.
    const hs = [new THREE.CylinderGeometry(0.014, 0.014, 0.17, 10).rotateZ(Math.PI / 2), new THREE.CylinderGeometry(0.032, 0.026, 0.035, 14).translate(-0.095, -0.012, 0), new THREE.CylinderGeometry(0.032, 0.026, 0.035, 14).translate(0.095, -0.012, 0)];
    this.handset = detail(new THREE.Mesh(own(mergeGeometries(hs)), M.bakelite.material));
    this.handsetHome = room.handset;
    this.handset.position.set(...room.handset.slice(0, 3)); this.handset.rotation.y = room.handset[3];
    // Monday's envelope.
    this.envelope = detail(new THREE.Mesh(own(new THREE.BoxGeometry(0.24, 0.004, 0.12)), M.paper.material));
    this.envelope.visible = false; this.envelopeAt = 0;
    // Thursday's sapphire.
    this.gemMat = own(new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.gem = detail(new THREE.Mesh(own(new THREE.OctahedronGeometry(0.035, 0).scale(1, 0.75, 1)), this.gemMat));
    this.gem.visible = false;
    // Smoke off the cigarette.
    this.smokeMat = own(new THREE.ShaderMaterial({ uniforms: { time: { value: 0 }, colour: { value: new THREE.Vector3() } }, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.smoke = detail(new THREE.Mesh(own(new THREE.PlaneGeometry(0.22, 0.9).translate(0, 0.45, 0)), this.smokeMat));
    this.smoke.visible = false;
    // A mouse, and a moth for the lamp.
    const mouse = [new THREE.SphereGeometry(1, 12, 8).scale(0.026, 0.024, 0.05), new THREE.SphereGeometry(1, 8, 6).scale(0.015, 0.014, 0.022).translate(0, 0.004, 0.055), new THREE.CylinderGeometry(0.0025, 0.001, 0.09, 5).rotateX(Math.PI / 2).translate(0, -0.008, -0.09)];
    for (const s of [-1, 1]) mouse.push(new THREE.SphereGeometry(0.009, 6, 5).translate(s * 0.012, 0.018, 0.045));
    this.mouse = detail(new THREE.Mesh(own(mergeGeometries(mouse)), std({ color: 0x4a4540, roughness: 0.9 })));
    this.mouse.visible = false; this.mouseRun = null; this.mouseDue = rnd(40, 100);
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.022, 0.012, 0.008, 0.02, -0.01, -0.006, 0, 0, 0, -0.022, 0.012, 0.008, -0.02, -0.01, -0.006], 3));
    this.moth = detail(new THREE.Mesh(own(wing), own(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }))));
    this.moth.visible = false; this.mothFor = 0; this.mothDue = rnd(30, 90);
    // Dust in the light.
    this.dust = makeDust(R, ctx.lowPower ? 160 : 320, 0.8);
    detail(this.dust.mesh);

    // --- Outside the window ---
    const basic = (o) => own(new THREE.MeshBasicMaterial(o));
    const outside = (geo, mat, x, y, z, layer = 0) => { const m = new THREE.Mesh(own(geo), mat); m.position.set(x, y, z); m.layers.set(layer); root.add(m); return m; };
    const win = P.win, F = print.FACADE;
    this.facadeMat = basic({ map: printed(renderer, 'facade') });
    outside(new THREE.PlaneGeometry(F.w, F.h), this.facadeMat, win.cx, 1.5, -9);
    this.facadeLights = new print.FacadeLights(renderer);
    this.lightsMat = basic({ map: this.facadeLights.texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    outside(new THREE.PlaneGeometry(F.w, F.h), this.lightsMat, win.cx, 1.5, -8.98);
    this.skyMat = basic({ color: 0x000000, side: THREE.BackSide });
    this.sky = new THREE.Mesh(own(new THREE.SphereGeometry(3.2, 24, 12)), this.skyMat);
    scene.add(this.sky);
    // The elevated train: three dark cars and their lit windows.
    this.train = new THREE.Group();
    const trainTex = printed(renderer, 'train');
    this.trainMat = basic({ map: trainTex, color: 0x000000 });
    for (let i = 0; i < 3; i++) {
      const car = new THREE.Mesh(own(new THREE.BoxGeometry(14.4, 2.7, 0.2)), basic({ color: 0x0b0c0e }));
      car.position.set(i * 15, 1.75, 0); car.layers.set(LAYER.DETAIL); this.train.add(car);
      const geo = own(new THREE.PlaneGeometry(13.6, 0.8)); geo.attributes.uv.array.forEach((v, k, a) => { if (k % 2 === 0) a[k] = v * 2; });
      const w = new THREE.Mesh(geo, this.trainMat); w.position.set(i * 15, 2.05, 0.11); w.layers.set(LAYER.DETAIL); this.train.add(w);
    }
    this.train.position.set(0, 0, -4.6); this.train.visible = false; this.trainX = null;
    root.add(this.train);
    // Rain.
    const quad = new THREE.PlaneGeometry(1, 1), rainGeo = own(new THREE.InstancedBufferGeometry());
    rainGeo.index = quad.index; rainGeo.setAttribute('position', quad.getAttribute('position'));
    const n = ctx.lowPower ? 500 : 1100, seed = new Float32Array(n * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    rainGeo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4)); rainGeo.instanceCount = n;
    this.rainMat = own(new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, box: { value: new THREE.Vector3(14, 9, 8) }, origin: { value: new THREE.Vector3(win.cx - 7, -2.5, -8.6) }, width: { value: 0.012 * sc }, colour: { value: new THREE.Vector3() } },
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const rain = detail(new THREE.Mesh(rainGeo, this.rainMat)); rain.frustumCulled = false;
    this.rain = 1; own(quad);
    // The window's glass: there to catch a reflection.
    const glass = detail(new THREE.Mesh(own(new THREE.PlaneGeometry(room.glass.w, room.glass.h)), std({ color: 0x0a1014, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false })));
    glass.position.set(...room.glass.pos);

    // --- Lamps ---
    const k = sc * sc; // candela in the room's own metres -> the miniature's
    this.k = k;
    const street = new THREE.SpotLight(0xffffff, 0, 0, 0.3, 0.3, 2);
    street.castShadow = true; street.shadow.mapSize.set(ctx.lowPower ? 1024 : 2048, ctx.lowPower ? 1024 : 2048);
    street.shadow.camera.near = 1.5 * sc; street.shadow.camera.far = 16 * sc; street.shadow.bias = -0.0002; street.shadow.normalBias = 0.008 * sc; // a larger bias let the sun in along the top of the walls
    this.streetHome = new THREE.Vector3(win.cx + 1.2, win.cy + 2.5, -4.6);
    street.position.copy(this.streetHome); street.target.position.set(win.cx - 0.3, 0.9, 1.6);
    root.add(street, street.target); this.street = street;
    const lamp = new THREE.SpotLight(0xffc98a, 0, 6 * sc, 1.2, 0.8, 2);
    lamp.castShadow = true; lamp.shadow.mapSize.set(1024, 1024);
    lamp.shadow.camera.near = 0.03 * sc; lamp.shadow.camera.far = 6 * sc; lamp.shadow.bias = -0.001; lamp.shadow.normalBias = 0.004 * sc;
    lamp.position.set(...room.lampLight); lamp.target.position.set(room.lampLight[0], 0, room.lampLight[2] + 0.12);
    root.add(lamp, lamp.target); this.lamp = lamp;
    // The corridor's light through the frosted pane: wide and soft. It has a shadow map too: without one the
    // floor behind the filing cabinets and the coat stand shone as if nothing stood between it and the door.
    const glow = new THREE.SpotLight(0xffc37a, 0, 7 * sc, 1.15, 1, 2);
    glow.castShadow = true; glow.shadow.mapSize.set(1024, 1024);
    glow.shadow.camera.near = 0.04 * sc; glow.shadow.camera.far = 7 * sc; glow.shadow.bias = -0.0015; glow.shadow.normalBias = 0.008 * sc;
    glow.position.set(...P.onChamfer(0, 1.55, 0.07)); glow.target.position.set(...P.onChamfer(0, 0.9, 2.5));
    root.add(glow, glow.target); this.doorLight = glow;
    const pic = new THREE.SpotLight(0xffd29a, 0, 4 * sc, 1.05, 0.9, 2);
    pic.position.set(...room.boardLight); pic.target.position.set(room.boardLight[0], room.board.pos[1] - 0.25, 0.02);
    root.add(pic, pic.target); this.boardLight = pic;
    // The sapphire's own light, on Thursday: a cone out through the safe's doorway and nowhere else. (As a
    // point lamp with no shadow map it shone through the safe's steel onto the floor behind it.)
    this.gemLight = new THREE.SpotLight(0x3f7dff, 0, 1.8 * sc, 0.68, 0.6, 2);
    this.gemLight.position.set(...P.onSafe(0, 0.5, -0.03)); this.gemLight.target.position.set(...P.onSafe(0, 0.3, 1.5));
    root.add(this.gemLight, this.gemLight.target);
    /** Levels, in candela at the room's own scale: tuned by eye against the screenshots. */
    this.tune = { lamp: 2.6, street: 120, neon: 70, sun: 900, door: 9, sky: 16, board: 0.3 };

    scene.add(root);
    for (const l of Object.values(LAYER)) ctx.camera?.layers.enable(l);
    renderer.shadowMap.autoUpdate = false;
    this.shadowFrames = 4;

    // --- The story ---
    const start = Math.max(0, CHAPTERS.findIndex((c) => c.key === (ctx.mode ?? '').toLowerCase() || c.title.toLowerCase() === (ctx.mode ?? '').toLowerCase()));
    this.story = new Story(start);
    this.lampOn = true; this.lampLevel = 1; this.stutter = 0;
    this.sign = { on: true, left: 2.6, e: true };
    this.rings = 0; this.ringT = 0;
    this.flash = 0; this.flashes = [];
    this.police = 0; this.watcher = 0;
    this.visit = null; this.rattle = 0; this.passerDue = rnd(50, 110);
    this.corridor = 1; this.paneDirty = true;
    this.time = 0; this.eyeSpeed = 0; this.lastEye = null;
    this.tmp = new THREE.Vector3(); this.col = new THREE.Color();
    this.showNight(start);
    this.light(0);
  }

  // MARK: - The story's hooks

  get modeLabel() { return 'Chapter'; }
  get modeName() { return this.story.chapter.title; }
  /** On to the next night; returns the title of the one that is coming. */
  cycleMode() {
    this.handle(this.story.skip());
    return CHAPTERS[(this.story.index + (this.story.phase === 'lapse' && !this.story.swapped ? 1 : 0)) % CHAPTERS.length].title;
  }

  /** Puts the room in the state night `n` finds it in. */
  showNight(n) {
    this.nights.forEach((night, i) => { night.group.visible = i === n; });
    const night = this.nights[n];
    this.board.material.map = printed(this.renderer, `board${n}`);
    this.calendar.material.map = printed(this.renderer, `cal${n}`);
    this.gem.visible = !!night.gem; if (night.gem) this.gem.position.set(...night.gem);
    this.smoke.visible = !!night.smoke; if (night.smoke) this.smoke.position.set(...night.smoke);
    this.envelope.visible = false; this.envelopeAt = 0;
    this.doorGlass.damage = n === 2 ? 1 : n === 3 ? 2 : 0;
    this.paneDirty = true;
    this.visit = null; this.rings = 0; this.police = 0; this.watcher = 0; this.rain = n === 0 ? 1 : this.rain; this.dry = false;
    if (n === 0) this.rainTarget = 1;
    this.lampOn = true;
    this.shadowFrames = 4;
    this.gi.rush(2);
  }

  handle(events) {
    for (const e of events) {
      if (e.type === 'night') this.ctx.say?.(CHAPTERS[e.index].caption);
      else if (e.type === 'chapter') this.showNight(e.index);
      else if (e.type === 'lapse') { this.visit = null; this.rings = 0; this.police = 0; }
      else if (e.type === 'beat') this.beat(e);
    }
  }

  beat(e) {
    if (e.what === 'ring') { this.rings = e.rings; this.ringT = 0; }
    else if (e.what === 'train') this.trainX = -52;
    else if (e.what === 'visitor') this.visit = { who: e.who, act: e.act, t: 0 };
    else if (e.what === 'lightning') this.flashes = [0, 0.16, 0.26 + Math.random() * 0.4];
    else if (e.what === 'watcher') this.watcher = 24;
    else if (e.what === 'flicker') this.stutter = 2.2;
    else if (e.what === 'police') this.police = 46;
    else if (e.what === 'dry') this.rainTarget = 0;
  }

  /** Starts something by name (for the E key and the console): a beat's name, or a visitor's. */
  trigger(name) {
    const names = ['train', 'passer', 'lightning', 'ring', 'client', 'heavy', 'watcher', 'police', 'mouse', 'moth'];
    name ??= names[(this.cycle = ((this.cycle ?? -1) + 1) % names.length)];
    if (name === 'ring') this.beat({ what: 'ring', rings: 3 });
    else if (name === 'client') this.visit = { who: 'client', act: 'envelope', t: 0 };
    else if (name === 'heavy') this.visit = { who: 'heavy', act: 'handle', t: 0 };
    else if (name === 'passer') this.visit = { who: 'passer', act: 'pass', t: 0 };
    else if (name === 'escort') this.visit = { who: 'escort', act: 'pass', t: 0 };
    else if (name === 'mouse') this.mouseDue = 0;
    else if (name === 'moth') this.mothDue = 0;
    else if (names.includes(name)) this.beat({ what: name });
    else return null;
    return name;
  }

  /** A click: the lights' switch (the desk lamp and the picture light over the board). */
  knock() { this.lampOn = !this.lampOn; this.gi.rush(1); }

  // MARK: - Every frame

  step(dt, time, eye) {
    this.time = time;
    if (eye) {
      if (this.lastEye && dt > 0) this.eyeSpeed += (Math.hypot(eye.x - this.lastEye.x, eye.y - this.lastEye.y, eye.z - this.lastEye.z) / dt - this.eyeSpeed) * Math.min(1, dt * 8);
      this.lastEye = { ...eye };
    }
    this.handle(this.story.step(dt));
    const night = this.story.phase === 'night';

    // The fan, the clock.
    this.fan.rotation.y += 1.1 * dt;
    const clock = this.story.clock;
    this.hour.rotation.z = -(clock % 12) / 12 * Math.PI * 2; this.minute.rotation.z = -(clock % 1) * Math.PI * 2;

    // The telephone.
    let jump = 0;
    if (this.rings > 0) { this.ringT += dt; if (this.ringT > 3) { this.ringT = 0; this.rings--; } jump = this.ringT < 1.3 ? 1 : 0; }
    const h = this.handsetHome;
    this.handset.position.set(h[0] + jump * 0.004 * Math.sin(time * 71), h[1] + jump * 0.006 * Math.abs(Math.sin(time * 53)), h[2]);
    this.handset.rotation.set(0, h[3] + jump * 0.03 * Math.sin(time * 61), jump * 0.05 * Math.sin(time * 47));

    // The hotel's sign: on for a while, off for a moment, and its E is on its way out.
    const s = this.sign;
    s.left -= dt;
    if (s.left <= 0) { s.on = !s.on; s.left = s.on ? rnd(2.2, 3.4) : rnd(0.7, 1.3); s.dirty = true; }
    if (Math.random() < dt * 1.2) { s.e = !s.e || Math.random() < 0.7; s.dirty = true; }
    const watching = this.watcher > 0;
    this.watcher -= dt;
    if (s.dirty || watching !== this.facadeLights.watcher) { s.dirty = false; this.facadeLights.draw(watching, s.on ? [1, 1, 1, s.e ? 1 : 0, 1] : [0, 0, 0, 0, 0]); }

    // Lightning, the patrol car, the train.
    this.flash = Math.max(0, this.flash - dt * 7);
    this.flashes = this.flashes.map((t) => t - dt).filter((t) => { if (t <= 0) { this.flash = 1; return false; } return true; });
    this.police = Math.max(0, this.police - dt);
    if (this.trainX !== null) {
      this.trainX += 15 * dt;
      this.train.visible = true; this.train.position.x = this.trainX;
      if (this.trainX > this.R.w + 30) { this.trainX = null; this.train.visible = false; }
    }
    this.rain += ((this.rainTarget ?? 1) - this.rain) * Math.min(1, dt * 0.25);

    this.stepDoor(dt, night);
    this.stepCreatures(dt, night);
    this.light(dt);
  }

  /** Whoever is in the corridor, and what the door does about it. */
  stepDoor(dt, night) {
    if (night && !this.visit) { this.passerDue -= dt; if (this.passerDue <= 0) { this.passerDue = rnd(70, 160); this.visit = { who: 'passer', act: 'pass', t: 0 }; } }
    const v = this.visit, figures = [];
    this.rattle = Math.max(0, this.rattle - dt * 5);
    if (v) {
      v.t += dt;
      const t = v.t, bob = 0.012 * Math.sin(t * 6);
      const arrive = (T) => ({ x: -1.15 * (1 - smooth(t / T)), near: 0.3 + 0.62 * smooth(t / T) });
      const leave = (t0, T) => { const u = smooth((t - t0) / T); return { x: 1.25 * u, near: 0.92 - 0.6 * u }; };
      if (v.act === 'pass') {
        const x = -1.3 + t * 0.42 + bob;
        if (v.who === 'escort') figures.push({ kind: 'cop', x: x - 0.42, near: 0.5 }, { kind: 'client', x, near: 0.56 }, { kind: 'cop', x: x + 0.42, near: 0.5 });
        else figures.push({ kind: v.who, x, near: 0.5 });
        if (x > 1.9) this.visit = null;
      } else if (v.act === 'envelope') {
        const f = { kind: v.who, x: bob * (t < 3 || t > 12 ? 1 : 0), near: 0.92, bend: 0, fist: 0 };
        if (t < 3) Object.assign(f, arrive(3));
        else if (t < 5.4) { const p = ((t - 3.4) * 2.2) % 1; f.fist = t > 3.4 && p < 0.5 ? 1 : 0.3; if (t > 3.4 && p < 0.08 && this.rattle < 0.2) this.rattle = 1; }
        else if (t > 8.5 && t < 11.5) { f.bend = smooth((t - 8.5) / 1) * (1 - smooth((t - 10.6) / 0.9)); this.envelopeAt = Math.max(this.envelopeAt, smooth((t - 9.4) / 1.1)); }
        else if (t > 12) Object.assign(f, leave(12, 3.2));
        figures.push(f);
        if (t > 15.2) this.visit = null;
      } else if (v.act === 'handle') {
        const f = { kind: v.who, x: 0.05, near: 0.95 };
        if (t < 3.2) Object.assign(f, arrive(3.2));
        else if (t < 7) { if ((t > 3.8 && t < 4.5) || (t > 5.1 && t < 5.6) || (t > 6.2 && t < 6.9)) this.rattle = 1; }
        else if (t > 9.5) Object.assign(f, leave(9.5, 3));
        figures.push(f);
        if (t > 12.5) this.visit = null;
      } else if (v.act === 'loiter') {
        const f = { kind: v.who, x: 0.03 * Math.sin(t * 0.7), near: 0.8 };
        if (t < 4.5) { Object.assign(f, arrive(4.5)); f.near *= 0.87; } else if (t > 14) Object.assign(f, leave(14, 3.5));
        figures.push(f);
        if (t > 17.5) this.visit = null;
      }
    }
    this.door.rotation.y = this.P.door.ry + this.rattle * 0.012 * Math.sin(this.time * 55);
    // Monday's envelope, coming under the door.
    const env = this.nights[0].envelope;
    this.envelope.visible = this.story.index === 0 && this.envelopeAt > 0.01;
    if (this.envelope.visible) { const a = this.envelopeAt; this.envelope.position.set(env.from[0] + (env.to[0] - env.from[0]) * a, env.from[1], env.from[2] + (env.to[2] - env.from[2]) * a); this.envelope.rotation.y = env.ry; }
    if (figures.length || this.hadFigures || this.paneDirty || Math.abs(this.corridor - this.doorGlass.light) > 0.02) {
      this.doorGlass.draw(figures, this.doorGlass.damage, this.corridor);
      this.hadFigures = figures.length > 0; this.paneDirty = false;
    }
  }

  /** The mouse along the skirting, the moth round the lamp. */
  stepCreatures(dt, night) {
    const P = this.P, hole = this.parts.hole;
    this.mouseDue -= dt;
    if (night && !this.mouseRun && this.mouseDue <= 0) {
      this.mouseDue = rnd(90, 240);
      const far = [P.desk.x + 1.15, P.desk.z + 0.62];
      this.mouseRun = { pts: [[hole[0], 0.05], [hole[0] - 0.1, 0.5], [P.desk.x + 1.2, P.desk.z - 0.3], far, [P.desk.x + 1.2, P.desk.z - 0.3], [hole[0] - 0.1, 0.5], [hole[0], 0.03]], i: 1, x: hole[0], z: 0.05, pause: 0, bolt: false };
    }
    const m = this.mouseRun;
    this.mouse.visible = !!m;
    if (m) {
      if (this.eyeSpeed > 0.6 && !m.bolt) { m.bolt = true; m.i = Math.max(m.i, 4); m.pause = 0; }
      const [tx, tz] = m.pts[m.i], d = Math.hypot(tx - m.x, tz - m.z);
      if (m.pause > 0) m.pause -= dt;
      else {
        const stepLen = Math.min(d, (m.bolt ? 2.6 : 1.1) * dt);
        if (d > 1e-4) { m.x += (tx - m.x) / d * stepLen; m.z += (tz - m.z) / d * stepLen; this.mouse.rotation.y = Math.atan2(tx - m.x, tz - m.z); }
        if (d < 0.01) { m.i++; if (m.i === 4 && !m.bolt) m.pause = rnd(2, 5); else if (!m.bolt) m.pause = rnd(0.1, 0.7); if (m.i >= m.pts.length) this.mouseRun = null; }
      }
      this.mouse.position.set(m.x, 0.024, m.z);
    }
    this.mothDue -= dt;
    if (night && this.lampLevel > 0.5 && this.mothFor <= 0 && this.mothDue <= 0) { this.mothDue = rnd(80, 200); this.mothFor = rnd(14, 30); }
    this.mothFor -= dt;
    this.moth.visible = this.mothFor > 0 && this.lampLevel > 0.3;
    if (this.moth.visible) {
      const t = this.time, L = this.parts.lampLight, r = 0.16 + 0.07 * Math.sin(t * 1.7);
      this.moth.position.set(L[0] + Math.cos(t * 3.1) * r, L[1] - 0.08 + 0.08 * Math.sin(t * 4.3), L[2] + Math.sin(t * 3.1) * r * 0.8);
      this.moth.rotation.set(0.5 * Math.sin(t * 5), -t * 3.1, 0);
      this.moth.scale.set(1, 0.25 + 0.75 * Math.abs(Math.sin(t * 38)), 1);
      this.moth.material.color.setRGB(0.9, 0.7, 0.45).multiplyScalar(this.lampLevel);
    }
  }

  /** Every lamp's level and colour for the moment. */
  light(dt) {
    const story = this.story, d = story.phase === 'lapse' ? daylight(story.lapse) : { night: 1, sun: 0, arc: 0 };
    const k = this.k, win = this.P.win, t = this.time;
    // The desk lamp.
    this.stutter = Math.max(0, this.stutter - dt);
    const want = (this.lampOn ? 1 : 0) * d.night * (this.stutter > 0 ? (Math.sin(t * 43) * Math.sin(t * 17) > 0.1 ? 1 : 0.12) : 1);
    this.lampLevel += (want - this.lampLevel) * (dt > 0 ? Math.min(1, dt * 14) : 1);
    const L = this.lampLevel;
    this.lamp.intensity = this.tune.lamp * k * L;
    this.boardLight.intensity = this.tune.board * k * L; // on the same switch as the desk lamp: its tube goes dark with it, so its light must too
    this.glowMat.shade.emissive.setRGB(0.05, 0.75, 0.3).multiplyScalar(0.95 * L);
    this.glowMat.bulb.color.setRGB(3.2, 2.5, 1.5).multiplyScalar(L);
    this.glowMat.ember.color.setRGB(3.5, 0.9, 0.15).multiplyScalar(0.6 + 0.4 * Math.sin(t * 0.7));
    // The corridor.
    this.corridor = 0.2 + 0.8 * Math.max(d.night, d.sun);
    this.doorLight.intensity = this.tune.door * k * this.corridor;
    // The street: its lamp, the sign, lightning, the patrol car; or the sun.
    const neon = this.sign.on ? d.night : 0, c = this.col, sum = this.tmp.set(0, 0, 0);
    const add = (r, g, b, level) => { sum.x += r * level; sum.y += g * level; sum.z += b * level; };
    add(0.5, 0.68, 1.0, this.tune.street * d.night);
    add(1.0, 0.1, 0.16, this.tune.neon * neon);
    add(1.0, 0.82, 0.62, this.tune.sun * d.sun);
    add(0.8, 0.88, 1.0, 900 * this.flash);
    if (this.police > 0) { const p = Math.sin(t * 8.5), fade = ramp(0, 2, this.police) * d.night; add(1, 0.04, 0.04, 90 * Math.max(0, p) * fade); add(0.08, 0.16, 1, 110 * Math.max(0, -p) * fade); }
    if (this.trainX !== null) { const near = Math.exp(-(((this.trainX + 22 - win.cx) / 24) ** 2)); add(1.0, 0.8, 0.5, 50 * near * (0.6 + 0.4 * Math.sin(this.trainX * 2.2)) * d.night); }
    const level = Math.max(sum.x, sum.y, sum.z, 1e-6);
    this.street.color.setRGB(sum.x / level, sum.y / level, sum.z / level);
    this.street.intensity = level * k;
    if (d.sun > 0.001) {
      const az = d.arc * 0.95, el = 0.42 + 0.3 * Math.cos(d.arc * Math.PI / 2);
      this.street.position.set(win.cx + Math.sin(az) * Math.cos(el) * 7, win.cy + Math.sin(el) * 7, -Math.cos(az) * Math.cos(el) * 7);
      this.street.target.position.set(win.cx - Math.sin(az) * 1.6, 0.9, 1.6);
      this.sunMoving = true;
    } else if (this.sunMoving) {
      this.sunMoving = false;
      this.street.position.copy(this.streetHome); this.street.target.position.set(win.cx - 0.3, 0.9, 1.6);
      this.shadowFrames = 3;
    }
    // What is seen out there.
    const dayTint = 0.95 * d.sun, f = this.flash;
    this.facadeMat.color.setRGB(0.045 + dayTint + 0.5 * f + 0.05 * neon, 0.05 + dayTint * 0.95 + 0.52 * f, 0.07 + dayTint * 0.9 + 0.6 * f);
    this.lightsMat.color.setScalar(2.2 * d.night);
    this.skyMat.color.setRGB(0.008 * this.tune.sky + 0.55 * d.sun + 1.2 * f, 0.012 * this.tune.sky + 0.7 * d.sun + 1.3 * f, 0.024 * this.tune.sky + 0.95 * d.sun + 1.6 * f);
    this.trainMat.color.setScalar(2.2);
    this.rainMat.uniforms.time.value = t % 3600;
    this.rainMat.uniforms.colour.value.set(0.05 + 0.12 * neon + 0.5 * d.sun + 0.8 * f, 0.07 + 0.01 * neon + 0.5 * d.sun + 0.85 * f, 0.1 + 0.02 * neon + 0.55 * d.sun + 1.0 * f).multiplyScalar(this.rain * 0.55);
    this.paneMat.color.setScalar(1.5);
    this.gemMat.color.setRGB(0.15, 0.5, 3.4).multiplyScalar(0.75 + 0.25 * Math.sin(t * 2.3) + (Math.sin(t * 7.1) > 0.96 ? 1.5 : 0));
    this.gem.rotation.y = t * 0.4;
    this.gemLight.intensity = this.gem.visible ? 0.1 * k * (0.8 + 0.2 * Math.sin(t * 2.3)) : 0;
    this.smokeMat.uniforms.time.value = t % 3600;
    this.smokeMat.uniforms.colour.value.set(0.5, 0.42, 0.3).multiplyScalar(0.5 * L + 0.02 * level / 40);
    // Dust: in the lamp's pool, and in the light from the window.
    const u = this.dust.uniforms;
    u.time.value = t % 3600;
    this.lamp.getWorldPosition(u.lampPos.value[0]); u.lampCol.value[0].set(1, 0.78, 0.5).multiplyScalar(this.lamp.intensity * 0.012);
    u.lampPos.value[1].set(win.cx, win.cy - 0.5, 0.9).multiplyScalar(this.scale).add(this.root.position);
    u.lampCol.value[1].set(this.street.color.r, this.street.color.g, this.street.color.b).multiplyScalar(level * k * 0.0005);
    u.ambient.value.setScalar(0.0001);
  }

  update(renderer) {
    if (this.shadowFrames > 0 || this.sunMoving) { renderer.shadowMap.needsUpdate = true; this.shadowFrames--; }
    this.gi.update(this.ctx.lowPower ? 1 : this.story.phase === 'lapse' ? 6 : 2);
  }

  dispose() {
    this.scene.remove(this.root, this.sky);
    this.root.traverse((o) => { if (o.isLight) o.shadow?.map?.dispose(); });
    for (const d of this.disposables) d.dispose();
    this.dust.dispose(); this.doorGlass.dispose(); this.facadeLights.dispose();
    this.gi.dispose();
    this.ctx.camera?.layers.set(0);
    this.renderer.shadowMap.autoUpdate = true;
  }
}
