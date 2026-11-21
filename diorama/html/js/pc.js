// Diorama — the computer skin: the inside of a desktop PC, seen through its glass side panel.
//
// The screen is the glass. Behind it, at real size, is the main chamber of a tower case: the motherboard on
// the far wall, and the tower cooler, the memory and the graphics card standing out of it toward the viewer,
// which is what gives a moving head something to look round. (pcparts.js builds it; pcboard.js paints the
// circuit board.)
//
// How it is lit, and why it is lit that way:
//
//   Real lamps   Everything that glows is a lamp. The case's white strip, the memory's light bars and the strip
//                under the graphics card are three.js lights with shadow maps, placed where the glowing part is,
//                so they throw real shadows and real highlights that move as the head does. The scene is still
//                (only fan blades turn, and they cast nothing), so every shadow map is drawn once.
//   Bounce       gi.js: an irradiance volume measured from the scene and redone continuously, so the
//                underside of the graphics card is lit by the floor it lights and the colours of the LEDs
//                spill onto everything near them. The fan rings, the logo and the board's accents have no
//                lamp of their own: the probes see them glowing, which is their light.
//   Reflections  gi.js: a parallax-corrected cube of the chamber, so brushed aluminium and nickel show the
//                room they are in, and the reflection slides as the head moves.
//   The room     What is outside the glass: a dim room with a window in it, seen only by the probes and the
//                reflections. It is what lights the chamber when the LEDs are off, and what the polished
//                parts facing the viewer reflect.
//   The mood     Dark. The case's own strip is a failing tube that gives a little cold light and stutters; most
//                of what you see is lit by the LEDs' colour and its bounce, and the room outside is moonlit.
//                'Work Light' turns the strip up to see how the thing is made.
//   Contact      Ground-truth ambient occlusion in screen space (post.js) darkens every crease the lamps and
//                the volume are too coarse to: a capacitor's foot, a fin against its neighbour.
//
// Surfaces are scans (ambientCG, CC0; see the README), tiled small because this is a small world.
// What moves in here, and what happens now and then, is pclife.js.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GI } from './gi.js';
import { Batch, buildComputer, rotorGeometry, fanFrame, at } from './pcparts.js';
import { BOARD, paintBoard, label } from './pcboard.js';
import { Life } from './pclife.js';

/** The chamber in design metres: its height and depth are a real mid-tower's; its width is the window's. */
const DESIGN = { h: 0.31, d: 0.2, minW: 0.47 };
/** Layers: 0 everything the light probes should see; 1 glowing parts that have a lamp of their own (hidden
 *  from the probes, or their light would be counted twice); 2 small detail the probes need not draw. */
const LAYER = { LAMPED: 1, DETAIL: 2, PRINT: 3 };
const ASSETS = new URL('../assets/materials/', import.meta.url).href;

// Scanned material sets: key -> the metres one repeat covers (mirrors assets/manifest.json).
const SCANS = { aluminium: 0.16, paint: 0.3, plastic: 0.14, mesh: 0.06, weave: 0.02, rubber: 0.1 };

/** A slow heartbeat, two beats to the bar, about forty a minute: 0.5 between beats, 1 on the beat. */
const heartbeat = (t, k) => { const p = (t * 0.68 - k * 0.035 + 1) % 1; return 0.5 + 0.5 * Math.min(1, Math.exp(-(((p - 0.1) / 0.05) ** 2)) + 0.6 * Math.exp(-(((p - 0.33) / 0.07) ** 2))); };
const breath = (t, k) => 0.8 + 0.2 * Math.sin(t * 0.35 + k * 1.9);
const MOON = [0.17, 0.23, 0.38], COLD = [0.62, 0.78, 1];

/**
 * Lighting modes. hue(t, group) 0..1 and sat: each LED group's colour. level: how bright the LEDs are, and
 * pulse(t, group) what it is multiplied by. lamp: how much the LEDs' lamps are turned up to carry the scene.
 * key and keyColour: the case's strip. room: the colour the room outside is multiplied by.
 */
const MODES = [
  { name: 'Dread', hue: (t, k) => 0.995 + 0.012 * Math.sin(t * 0.05 + k * 1.7), sat: 1, level: 1, pulse: heartbeat, lamp: 4.5, key: 0.11, keyColour: COLD, room: MOON },
  { name: 'Abyss', hue: (t, k) => 0.64 + 0.05 * Math.sin(t * 0.04 + k * 1.3), sat: 0.95, level: 1, pulse: breath, lamp: 4.5, key: 0.1, keyColour: COLD, room: MOON },
  { name: 'Toxic', hue: (t, k) => 0.3 + 0.03 * Math.sin(t * 0.05 + k * 1.1), sat: 0.9, level: 0.9, pulse: breath, lamp: 3, key: 0.09, keyColour: COLD, room: MOON },
  { name: 'Spectrum', hue: (t, k) => (t * 0.012 + k * 0.11) % 1, sat: 0.95, level: 1, pulse: breath, lamp: 3, key: 0.1, keyColour: COLD, room: MOON },
  { name: 'Work Light', hue: () => 0.1, sat: 0.12, level: 0.9, pulse: () => 1, lamp: 1, key: 1, keyColour: [1, 0.94, 0.86], room: [1.6, 1.6, 1.6] },
  { name: 'Off', hue: () => 0, sat: 0, level: 0, pulse: () => 1, lamp: 1, key: 0, keyColour: COLD, room: MOON },
];
const GROUPS = ['ram', 'fans', 'gpu', 'board'];

// Loaded and painted once for the page: a resize rebuilds the scene but not these.
const textureCache = new Map();
let boardMaps = null;
const labelCache = new Map();

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

export class Computer {
  constructor(scene, renderer, { width, height }, ctx = {}) {
    this.scene = scene; this.renderer = renderer; this.ctx = ctx;
    this.disposables = [];
    this.modeIndex = Math.max(0, MODES.findIndex((m) => m.name.toLowerCase() === (ctx.mode ?? '').toLowerCase()));
    this.level = MODES[this.modeIndex].level; this.keyLevel = MODES[this.modeIndex].key; this.lampGain = MODES[this.modeIndex].lamp;

    // Real size on a display about 31 cm tall (a 25-inch 16:9 panel); otherwise scaled to fill the window's
    // height, or its width if the window is narrower than a case is.
    const s = Math.min(height / DESIGN.h, width / DESIGN.minW);
    this.scale = s;
    const L = { w: width / s, h: height / s, d: DESIGN.d };
    this.layout = L;
    const root = new THREE.Group();
    root.scale.setScalar(s);
    root.position.set(-width / 2, -height / 2, -L.d * s);
    this.root = root;
    this.look = { ao: { radius: 0.016 * s, intensity: 1 }, bloom: { strength: 0.42, radius: 0.65, threshold: 0.85 }, exposure: 1.0, vignette: 0.45 };

    // --- Global illumination ---
    const min = new THREE.Vector3(-width / 2, -height / 2, -L.d * s), max = new THREE.Vector3(width / 2, height / 2, 0);
    this.gi = new GI(renderer, scene, {
      min, max, counts: [Math.max(6, Math.round(L.w / 0.052)), 6, 4],
      reflectBoxMax: new THREE.Vector3(width / 2 + 0.6, height / 2 + 0.5, 1.2),
      probeLayers: [0], envLayers: [0, LAYER.LAMPED, LAYER.DETAIL, LAYER.PRINT],
    });
    this.gi.uniforms.giBias.value *= 0.6;

    // --- Materials ---
    const std = (o) => {
      const m = new THREE.MeshStandardMaterial(o);
      this.disposables.push(m);
      return this.gi.patch(m);
    };
    const scanned = (key, o = {}) => std({ map: scan(renderer, key, 'color'), normalMap: scan(renderer, key, 'normal'), roughnessMap: scan(renderer, key, 'roughness'), ...o });
    const M = {
      paint: { material: scanned('paint', { color: 0xc8cacf, metalness: 0.1 }), tile: SCANS.paint },
      aluminium: { material: scanned('aluminium', { metalness: 1, normalScale: new THREE.Vector2(0.6, 0.6) }), tile: SCANS.aluminium },
      aluDark: { material: scanned('aluminium', { color: 0x30333a, metalness: 0.9, normalScale: new THREE.Vector2(0.6, 0.6) }), tile: SCANS.aluminium },
      plastic: { material: scanned('plastic', { color: 0xb9bcc2 }), tile: SCANS.plastic },
      mesh: { material: scanned('mesh', { metalness: 0.7, color: 0xa8abb0 }), tile: SCANS.mesh },
      weave: { material: scanned('weave', { color: 0x9aa0a8, metalness: 0 }), tile: SCANS.weave },
      rubber: { material: scanned('rubber', { color: 0x6a6c70 }), tile: SCANS.rubber },
      steel: { material: std({ color: 0xb6babf, metalness: 1, roughness: 0.34 }) },
      nickel: { material: std({ color: 0xcfc8bd, metalness: 1, roughness: 0.2 }) },
      gold: { material: std({ color: 0xd8a545, metalness: 1, roughness: 0.3 }) },
      brass: { material: std({ color: 0xb08d4f, metalness: 1, roughness: 0.4 }) },
      void: { material: std({ color: 0x060607, roughness: 0.85 }) },
      capBody: { material: std({ color: 0x121317, roughness: 0.42 }) },
      ferrite: { material: std({ color: 0x2a2c30, roughness: 0.8 }) },
      slot: { material: std({ color: 0x16181c, roughness: 0.48 }) },
      slotLight: { material: std({ color: 0x4b4f55, roughness: 0.55 }) },
    };
    const blade = scanned('plastic', { color: 0x70747c, side: THREE.DoubleSide, roughness: 0.75 });
    // Each LED group: a white diffuser whose glow is set every frame.
    this.leds = {};
    for (const g of ['white', ...GROUPS]) this.leds[g] = { material: std({ color: g === 'white' ? 0xdfe3e8 : 0x3a3e44, roughness: 0.5, emissive: 0x000000 }), colour: new THREE.Color(), lights: [] };

    // --- Geometry ---
    const batch = new Batch();
    const parts = buildComputer(batch, L);
    this.parts = parts;
    this.rotors = [];
    const rotorGeos = new Map();
    for (const fan of parts.fans) {
      if (!fan.bare) {
        const f = fanFrame(fan.size);
        batch.add('plastic', at(f.frame, ...fan.pos, ...fan.rot));
        batch.add('plastic', at(f.struts, ...fan.pos, ...fan.rot));
        if (fan.ring) parts.emitters.push({ group: 'fans', layer: 0, geo: at(f.ring, ...fan.pos, ...fan.rot) });
        else f.ring.dispose();
      }
      if (!rotorGeos.has(fan.size)) { rotorGeos.set(fan.size, rotorGeometry(fan.size, fan.bare ? 11 : 9, fan.bare ? 0.011 : 0.016)); this.disposables.push(rotorGeos.get(fan.size)); }
      const mount = new THREE.Group();
      mount.position.set(...fan.pos); mount.rotation.set(...fan.rot, 'ZYX');
      const rotor = new THREE.Mesh(rotorGeos.get(fan.size), blade);
      rotor.receiveShadow = true; rotor.layers.set(LAYER.DETAIL);
      rotor.rotation.z = Math.random() * 6.28;
      mount.add(rotor); root.add(mount);
      this.rotors.push({ rotor, speed: 5.2 * fan.speed });
    }
    for (const mesh of batch.build(M)) { root.add(mesh); this.disposables.push(mesh.geometry); }

    // The circuit board, with its own painted maps.
    boardMaps ??= paintBoard(renderer, 7);
    const pcb = std({ map: boardMaps.map, normalMap: boardMaps.normalMap, roughnessMap: boardMaps.roughnessMap, metalnessMap: boardMaps.roughnessMap, roughness: 1, metalness: 1, normalScale: new THREE.Vector2(1.4, 1.4) });
    const boardGeo = new THREE.PlaneGeometry(BOARD.w, BOARD.h);
    const board = new THREE.Mesh(boardGeo, pcb);
    board.position.set(parts.board.x + BOARD.w / 2, parts.board.y + BOARD.h / 2, parts.board.z + 0.00003);
    board.receiveShadow = true;
    root.add(board); this.disposables.push(boardGeo);

    // Glowing parts, merged per group and layer.
    const glow = new Map();
    for (const e of parts.emitters) {
      const k = `${e.group}|${e.layer}`;
      if (!glow.has(k)) glow.set(k, []);
      const g = e.geo.index ? e.geo.toNonIndexed() : e.geo;
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      glow.get(k).push(g);
    }
    for (const [k, list] of glow) {
      const [group, layer] = k.split('|');
      const geo = mergeGeometries(list);
      const mesh = new THREE.Mesh(geo, this.leds[group].material);
      mesh.layers.set(Number(layer));
      root.add(mesh); this.disposables.push(geo);
    }

    // Printed labels and lit legends.
    for (const l of parts.labels) {
      if (l.skip) continue;
      const tex = this.labelTexture(l.key);
      let mat;
      if (l.group) {
        mat = std({ color: 0x000000, map: tex, emissiveMap: tex, emissive: 0xffffff, alphaToCoverage: true, alphaTest: 0.02 });
        this.leds[l.group].legend = mat;
      } else {
        mat = std({ map: tex, alphaToCoverage: true, alphaTest: 0.02, roughness: 0.62, metalness: 0 });
      }
      const geo = new THREE.PlaneGeometry(l.w, l.h);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...l.pos); mesh.rotation.set(...l.rot, 'YXZ');
      mesh.layers.set(LAYER.PRINT); mesh.receiveShadow = true;
      root.add(mesh); this.disposables.push(geo);
    }

    // --- Lamps ---
    // Intensities are candela at design scale; a scaled scene needs them scaled by the square, so that a
    // surface the same number of part-widths away is as bright.
    const k = s * s;
    const shadowed = (light, size) => {
      light.castShadow = true;
      light.shadow.mapSize.set(size, size);
      light.shadow.camera.near = 0.004 * s; light.shadow.camera.far = 1.2 * s;
      light.shadow.bias = -0.0012; light.shadow.normalBias = 0.0009 * s;
      return light;
    };
    for (const p of parts.lamps.white) {
      // 1024 a face: at this scale a shadow-map texel is a millimetre, and a 512 map's edge was visibly stepped.
      const lamp = shadowed(new THREE.PointLight(0xffffff, 0, 0, 2), ctx.lowPower ? 512 : 1024);
      lamp.position.set(...p); lamp.userData.base = 0.42 * k;
      root.add(lamp); this.leds.white.lights.push(lamp);
    }
    const ram = shadowed(new THREE.PointLight(0xffffff, 0, 0.5 * s, 2), 512);
    ram.position.set(...parts.lamps.ram); ram.userData.base = 0.02 * k;
    root.add(ram); this.leds.ram.lights.push(ram);
    const under = shadowed(new THREE.SpotLight(0xffffff, 0, 0.5 * s, 1.25, 1, 2), 512);
    under.position.set(...parts.lamps.gpu); under.userData.base = 0.05 * k;
    under.target.position.set(parts.lamps.gpu[0], 0, parts.lamps.gpu[2] - 0.02);
    root.add(under, under.target); this.leds.gpu.lights.push(under);

    // --- The room outside the glass ---
    this.room = makeRoom();
    this.room.position.set(0, 0, 0.6);
    this.room.material.color.setRGB(...MODES[this.modeIndex].room);
    scene.add(this.room);

    // --- What moves, and what happens now and then ---
    this.life = new Life({ root, L, s, parts, std, layer: LAYER.DETAIL, lowPower: ctx.lowPower });
    this.dustLamps = [...this.leds.white.lights, ram, under];
    this.view = { eye: new THREE.Vector3(L.w / 2, L.h / 2, L.d + 0.6), distance: 0.6, speed: 0 };
    this.lastEye = null;

    scene.add(root);
    for (const l of Object.values(LAYER)) ctx.camera?.layers.enable(l);
    renderer.shadowMap.autoUpdate = false;
    this.shadowFrames = 3; // the maps are drawn for the first few frames (textures and matrices settle), then never again
    this.time = 0;
    this.applyLighting(0);
  }

  get modeName() { return MODES[this.modeIndex].name; }
  /** The next lighting mode; returns its name. */
  cycleMode() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this.gi.rush(2);
    return this.modeName;
  }

  labelTexture(key) {
    if (labelCache.has(key)) return labelCache.get(key);
    const r = this.renderer, grey = '#c9ced4';
    const hair = (g, w, h) => { g.strokeStyle = 'rgba(200,206,212,0.55)'; g.lineWidth = Math.max(1, h * 0.012); for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(w * (0.56 + i * 0.012), h * 0.92); g.lineTo(w * (0.66 + i * 0.012), h * 0.08); g.stroke(); } };
    const make = {
      backplate: () => label(r, [
        { text: 'AURORA', size: 0.34, x: 0.04, y: 0.36, align: 'left', weight: 800, spacing: 0.02 },
        { text: 'RX 9000 · 24G', size: 0.1, x: 0.045, y: 0.68, align: 'left', weight: 500, spacing: 0.03 },
        { text: 'TRIPLE AXIAL · VAPOUR CHAMBER', size: 0.05, x: 0.96, y: 0.2, align: 'right', weight: 500, spacing: 0.02 },
        { text: 'DESIGNED FOR LIGHT', size: 0.05, x: 0.96, y: 0.3, align: 'right', weight: 500, spacing: 0.02 },
        { text: 'PCB REV 2.1   S/N 7F2A-0419-D10', size: 0.04, x: 0.96, y: 0.88, align: 'right', weight: 400, font: 'ui-monospace, Menlo, monospace' },
      ], { w: 2048, h: 860, colour: grey, draw: hair }),
      gpuLogo: () => label(r, [{ text: 'AURORA', size: 0.78, x: 0.02, y: 0.54, align: 'left', weight: 800, spacing: 0.22 }], { w: 1024, h: 144, colour: '#ffffff' }),
      cooler: () => label(r, [
        { text: 'NORTHWIND', size: 0.24, y: 0.42, weight: 800, spacing: 0.04 },
        { text: 'TOWER 120 · SIX HEAT PIPES', size: 0.075, y: 0.7, weight: 500, spacing: 0.03 },
      ], { w: 1024, h: 410, colour: grey }),
      io: () => label(r, [{ text: 'DIORAMA  Z-SERIES', size: 0.5, weight: 700, spacing: 0.08 }], { w: 1232, h: 144, colour: grey }),
      ram: () => label(r, [{ text: 'VELOCITY  DDR5 · 32GB · 6400', size: 0.5, weight: 700, spacing: 0.06 }], { w: 1024, h: 205, colour: grey }),
      m2: () => label(r, [{ text: 'M.2  NVMe', size: 0.42, x: 0.06, align: 'left', weight: 700, spacing: 0.08 }], { w: 1024, h: 205, colour: '#30343a', draw: hair }),
      chipset: () => label(r, [{ text: 'Z', size: 0.5, y: 0.52, weight: 800 }], {
        w: 512, h: 548, colour: grey,
        draw: (g, w, h) => { g.strokeStyle = grey; g.lineWidth = w * 0.022; g.beginPath(); for (let i = 0; i < 7; i++) { const a = i * Math.PI / 3 + Math.PI / 6; g.lineTo(w / 2 + Math.cos(a) * w * 0.36, h / 2 + Math.sin(a) * w * 0.36); } g.stroke(); },
      }),
      ssd: () => label(r, [
        { text: 'SOLID STATE DRIVE', size: 0.05, y: 0.14, weight: 700, colour: '#aeb4ba', spacing: 0.008 },
        { text: '2TB', size: 0.2, y: 0.36, weight: 800, colour: '#d5d9dd' },
        { text: 'SATA 6Gb/s · 2.5 in', size: 0.045, y: 0.52, weight: 500, colour: '#8d9399' },
        { text: 'DC 5V 1.7A   MODEL D-2000S', size: 0.035, y: 0.86, weight: 400, colour: '#8d9399', font: 'ui-monospace, Menlo, monospace' },
      ], { w: 704, h: 1024, bg: '#1d2024' }),
    };
    const t = make[key]();
    labelCache.set(key, t);
    return t;
  }

  /** Sets every LED's colour and its lamp's, for the mode and the moment. */
  applyLighting(dt) {
    const mode = MODES[this.modeIndex], t = this.time, life = this.life;
    const ease = dt > 0 ? Math.min(1, dt * 1.5) : 1; // modes ease into one another
    this.level += (mode.level - this.level) * ease;
    this.keyLevel += (mode.key - this.keyLevel) * ease;
    this.lampGain += (mode.lamp - this.lampGain) * ease;
    const power = life?.power ?? 1;
    const c = new THREE.Color(), sum = new THREE.Vector3();
    GROUPS.forEach((name, i) => {
      const led = this.leds[name];
      c.setHSL(((mode.hue(t, i) % 1) + 1) % 1, mode.sat, 0.5);
      led.colour.lerp(c, ease);
      const e = this.level * mode.pulse(t, i) * power;
      // Bright enough to bloom, not so bright that the tone curve bleaches the colour out of it.
      led.material.emissive.copy(led.colour).multiplyScalar(1.0 * e);
      led.legend?.emissive.copy(led.colour).multiplyScalar(1.5 * e);
      for (const l of led.lights) { l.color.copy(led.colour); l.intensity = l.userData.base * this.lampGain * e; }
      sum.x += led.colour.r * e; sum.y += led.colour.g * e; sum.z += led.colour.b * e;
    });
    const w = this.leds.white, key = this.keyLevel * power * (life?.key ?? 1);
    c.setRGB(...mode.keyColour);
    w.colour.lerp(c, ease);
    w.material.emissive.copy(w.colour).multiplyScalar(2.2 * Math.min(1, key * 2)); // the tube itself looks brighter than the light it gives
    for (const l of w.lights) { l.color.copy(w.colour); l.intensity = l.userData.base * key; }
    c.setRGB(...mode.room);
    this.room.material.color.lerp(c, ease);
    // The dust shows in the lamps' light, and faintly in everything else's.
    life?.lightDust(this.dustLamps, sum.multiplyScalar(0.05).addScalar(0.02 * key + 0.004));
  }

  /** `eye` is the viewer's eye in the window's frame (metres, as the app draws it). */
  step(dt, time, eye) {
    this.time = time;
    const v = this.view;
    if (eye) {
      if (this.lastEye && dt > 0) v.speed += (Math.hypot(eye.x - this.lastEye.x, eye.y - this.lastEye.y, eye.z - this.lastEye.z) / dt - v.speed) * Math.min(1, dt * 8);
      this.lastEye = { ...eye };
      v.eye.set(eye.x, eye.y, eye.z).sub(this.root.position).divideScalar(this.scale);
      v.distance = eye.z;
    }
    this.life.step(dt, time, v);
    if (this.life.rush) this.gi.rush(1);
    for (const r of this.rotors) r.rotor.rotation.z += r.speed * this.life.fan * dt;
    this.applyLighting(dt);
  }

  /** A knock on the glass. */
  knock() { this.life.knock(); }
  /** Starts one of the things that happen by themselves (see pclife.js), or the next in turn; returns its name. */
  trigger(name) { return this.life.trigger(name); }

  /** Before each frame is drawn: the probes' and the reflection cube's share of work, and the shadow maps while they settle. */
  update(renderer) {
    if (this.shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; this.shadowFrames--; }
    this.gi.update(this.ctx.lowPower ? 1 : 2);
  }

  dispose() {
    this.scene.remove(this.root, this.room);
    this.root.traverse((o) => { if (o.isLight) o.shadow?.map?.dispose(); });
    for (const d of this.disposables) d.dispose();
    this.room.geometry.dispose(); this.room.material.map.dispose(); this.room.material.dispose();
    this.life.dispose();
    this.gi.dispose();
    this.ctx.camera?.layers.set(0);
    this.renderer.shadowMap.autoUpdate = true;
  }
}

/**
 * The room beyond the glass, as a sphere painted from inside: dim walls, a tall window to one side, and a
 * small warm light on the other. Each lighting mode multiplies it by a colour: moonlight, mostly. Only the light probes and the reflection cube ever look at it.
 */
function makeRoom() {
  const w = 1024, h = 512, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const wall = g.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#3a3c40'); wall.addColorStop(0.5, '#2c2d30'); wall.addColorStop(1, '#17181a');
  g.fillStyle = wall; g.fillRect(0, 0, w, h);
  const soft = (x, y, rx, ry, colour) => {
    const r = g.createRadialGradient(x, y, 0, x, y, 1);
    r.addColorStop(0, colour); r.addColorStop(0.55, colour); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); g.translate(x, y); g.scale(rx, ry); g.translate(-x, -y); g.fillStyle = r; g.fillRect(x - 1, y - 1, 2, 2); g.restore();
  };
  soft(w * 0.2, h * 0.36, w * 0.07, h * 0.2, 'rgba(235,242,255,1)');   // a window, up and to the viewer's left
  soft(w * 0.78, h * 0.3, w * 0.02, h * 0.04, 'rgba(255,214,160,0.5)'); // a standby light somewhere to the right
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, color: new THREE.Color(1.6, 1.6, 1.6), toneMapped: false });
  const room = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 16), mat);
  room.rotation.y = Math.PI * 0.5;
  return room;
}
