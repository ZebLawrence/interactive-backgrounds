// Balloon Dawn — A hot-air balloon: the quilted envelope with its painted pattern, cables, burner
// frame, wicker basket and crew; the burner flame; and how it drifts, sways, climbs and glows.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, randInt, pick, coin, smoothstep, v3, unit, hash2, fbm2, RGBA, Art, cyc } from './util.js';
import { G, NOISE_GLSL, Q, patchMaterial } from './shaders.js';

export const GORES = 24;
const ENVELOPE_H = 18;

// ---------------------------------------------------------------------------------------------
// Palettes and patterns: every envelope is painted on a 2048x1024 canvas, u around the balloon
// and v up it, then dressed with gore seams, load tapes, a dark scoop and a fabric weave.
// ---------------------------------------------------------------------------------------------

export const PALETTES = [
  ['#d8232a', '#f2c230', '#1f4e9c', '#f5f1e6'],
  ['#0b7a75', '#f7b538', '#e4572e', '#17223b'],
  ['#6a0dad', '#ff7f11', '#f8f4e3'],
  ['#1b998b', '#ed217c', '#2d3047', '#fffd98'],
  ['#c1121f', '#003049', '#fdf0d5', '#669bbc'],
  ['#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#264653'],
  ['#ff006e', '#8338ec', '#3a86ff', '#ffbe0b', '#fb5607'],
  ['#4a7c59', '#f2e8cf', '#bc4749'],
  ['#1d3557', '#f1faee', '#e63946'],
  ['#ffd166', '#06d6a0', '#118ab2', '#073b4c', '#ef476f'],
];
export const PATTERNS = ['gores', 'checker', 'chevron', 'diamonds', 'rainbow', 'sunburst', 'spiral', 'bands'];

/** Paint an envelope. `h` runs 0 at the throat to 1 at the crown; canvas rows are flipped on upload. */
export function paintEnvelope(pattern, palette, weave) {
  const W = 2048, H = 1024;
  return Art.image(W, H, (ctx) => {
    const Y = (h) => H * (1 - h);
    const rect = (u0, u1, h0, h1, color) => { ctx.fillStyle = color; ctx.fillRect(u0 * W, Y(h1), (u1 - u0) * W + 1, (h1 - h0) * H + 1); };
    const gw = 1 / GORES;
    ctx.fillStyle = palette[0];
    ctx.fillRect(0, 0, W, H);
    switch (pattern) {
      case 'gores':
        for (let g = 0; g < GORES; g++) rect(g * gw, (g + 1) * gw, 0, 1, cyc(palette, Math.floor(g / (palette.length === 2 ? 1 : 1))));
        break;
      case 'checker': {
        const rows = 7;
        for (let g = 0; g < GORES; g++) for (let r = 0; r < rows; r++) rect(g * gw, (g + 1) * gw, r / rows, (r + 1) / rows, cyc(palette, g + r));
        break;
      }
      case 'chevron': {
        const bands = 9;
        for (let b = -1; b < bands + 1; b++) {
          ctx.fillStyle = cyc(palette, b);
          ctx.beginPath();
          for (let g = 0; g <= GORES; g++) ctx.lineTo(g * gw * W, Y((b + (g % 2) * 0.5) / bands));
          for (let g = GORES; g >= 0; g--) ctx.lineTo(g * gw * W, Y((b + 1 + (g % 2) * 0.5) / bands));
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'diamonds': {
        const rows = 6;
        for (let g = 0; g < GORES; g++) for (let r = -1; r <= rows; r++) {
          ctx.fillStyle = cyc(palette, 1 + ((g + r) % 2 + 2) % 2 + (r % 3 === 0 ? 1 : 0));
          const cx = (g + 0.5) * gw * W, cy = Y((r + 0.5 + (g % 2) * 0.5) / rows);
          ctx.beginPath();
          ctx.moveTo(cx, cy - H / rows / 2);
          ctx.lineTo(cx + gw * W / 2, cy);
          ctx.lineTo(cx, cy + H / rows / 2);
          ctx.lineTo(cx - gw * W / 2, cy);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'rainbow': {
        const bands = palette.length * 2;
        for (let b = 0; b < bands; b++) rect(0, 1, b / bands, (b + 1) / bands, cyc(palette, b));
        break;
      }
      case 'sunburst':
        rect(0, 1, 0.55, 1, palette[1]);
        for (let g = 0; g < GORES; g++) {
          ctx.fillStyle = cyc(palette, g % 2 ? 2 : 0);
          ctx.beginPath();
          ctx.moveTo((g + 0.5) * gw * W, Y(0));
          ctx.lineTo(g * gw * W, Y(0.62));
          ctx.lineTo((g + 1) * gw * W, Y(0.62));
          ctx.closePath();
          ctx.fill();
        }
        rect(0, 1, 0.9, 1, palette[2 % palette.length]);
        break;
      case 'spiral': {
        const rows = 10;
        for (let g = 0; g < GORES; g++) for (let r = 0; r < rows; r++) rect(g * gw, (g + 1) * gw, r / rows, (r + 1) / rows, cyc(palette, Math.floor((g + r * 1.5) / 2)));
        break;
      }
      case 'bands': {
        rect(0, 1, 0.3, 0.42, palette[1]);
        rect(0, 1, 0.48, 0.52, palette[2 % palette.length]);
        rect(0, 1, 0.74, 0.8, palette[1]);
        // A badge on two opposite sides.
        for (const u of [0.25, 0.75]) {
          ctx.fillStyle = palette[2 % palette.length];
          ctx.beginPath();
          ctx.ellipse(u * W, Y(0.6), W * 0.06, H * 0.1, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = palette[0];
          ctx.beginPath();
          ctx.ellipse(u * W, Y(0.6), W * 0.04, H * 0.065, 0, 0, TAU);
          ctx.fill();
        }
        break;
      }
    }
    // The parachute vent at the crown and the dark scoop at the throat.
    rect(0, 1, 0.965, 1, '#2b2b2b');
    rect(0, 1, 0, 0.06, '#1c1a19');
    // Load tapes: dark seams down every gore and three horizontal tapes.
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    for (let g = 0; g <= GORES; g++) ctx.fillRect(g * gw * W - 1.5, 0, 3, H);
    for (const h of [0.06, 0.5, 0.965]) ctx.fillRect(0, Y(h) - 2, W, 4);
    // A hint of light stitching beside each seam.
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    for (let g = 0; g <= GORES; g++) { ctx.fillRect(g * gw * W + 2, 0, 1, H); ctx.fillRect(g * gw * W - 3, 0, 1, H); }
    // Fabric weave, tiled over everything.
    ctx.globalCompositeOperation = 'multiply';
    const pat = ctx.createPattern(weave, 'repeat');
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  });
}

/** A tangent-space normal map for the quilted gores: each gore bulges, with a groove at the seam. */
export function envelopeNormalMap() {
  const W = 1024, H = 256;
  return Art.image(W, H, (ctx) => {
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const a = u * TAU * GORES;
        let nx = Math.sin(a) * 0.55;
        // The seam: a sharp groove.
        const seam = (u * GORES) % 1;
        const sd = Math.min(seam, 1 - seam);
        if (sd < 0.03) nx += (seam < 0.5 ? -1 : 1) * (0.03 - sd) / 0.03 * 0.6;
        const weave = (hash2(x, y) - 0.5) * 0.08;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx));
        const i = (y * W + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (weave * 0.5 + 0.5) * 255;
        d[i + 2] = nz * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

// ---------------------------------------------------------------------------------------------
// Shared geometry: the envelope loft, basket, frame and crew parts
// ---------------------------------------------------------------------------------------------

export const Parts = {
  envelope: null, crown: null, throatRing: null, cables: null, frame: null, basket: null, basketRim: null,
  burner: null, body: null, head: null, arm: null, flame: null, weave: null, wicker: null, wickerNormal: null, normalMap: null,

  build() {
    if (this.envelope) return;
    // The envelope profile, from the throat up to the crown, resampled evenly so v is height.
    const ctrl = [[1.7, 0], [4.4, 2.2], [6.9, 4.8], [8.0, 7.8], [7.7, 11.2], [6.1, 14.5], [3.4, 16.9], [0.9, 17.9], [0, ENVELOPE_H]];
    const curve = new THREE.CatmullRomCurve3(ctrl.map(([r, y]) => v3(r, y, 0)), false, 'catmullrom', 0.5);
    const pts = curve.getSpacedPoints(56).map((p) => new THREE.Vector2(Math.max(p.x, 0), p.y));
    this.envelope = new THREE.LatheGeometry(pts, 120);
    this.crown = new THREE.TorusGeometry(0.9, 0.08, 8, 32);
    this.throatRing = new THREE.TorusGeometry(1.7, 0.05, 6, 48);
    // Eight cables from the throat ring down to the corners of the burner frame.
    const cables = [];
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * TAU;
      const top = v3(Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7);
      const ca = Math.round(i / 2) / 4 * TAU + TAU / 8;
      const bottom = v3(Math.cos(ca) * 0.75, -3.3, Math.sin(ca) * 0.75);
      cables.push(this.rod(top, bottom, 0.018));
    }
    this.cables = mergeGeometries(cables);
    // The burner frame: four uprights from the basket to a square load frame, and the frame itself.
    const frame = [];
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + TAU / 8;
      const x = Math.cos(a) * 0.75, z = Math.sin(a) * 0.75;
      frame.push(this.rod(v3(x, -3.3, z), v3(x * 0.85, -4.7, z * 0.85), 0.04));
      const b = (i + 1) / 4 * TAU + TAU / 8;
      frame.push(this.rod(v3(x, -3.3, z), v3(Math.cos(b) * 0.75, -3.3, Math.sin(b) * 0.75), 0.04));
    }
    this.frame = mergeGeometries(frame);
    this.burner = new THREE.CylinderGeometry(0.16, 0.2, 0.3, 12);
    // The basket: a rounded box with a leather rim.
    const basket = new THREE.BoxGeometry(1.5, 1.15, 1.25, 1, 1, 1);
    basket.translate(0, -5.3, 0);
    this.basket = basket;
    const rim = new THREE.TorusGeometry(0.9, 0.06, 6, 4);
    rim.rotateX(Math.PI / 2);
    rim.rotateY(Math.PI / 4);
    rim.translate(0, -4.72, 0);
    this.basketRim = rim;
    this.body = new THREE.CapsuleGeometry(0.17, 0.5, 4, 8);
    this.head = new THREE.SphereGeometry(0.13, 10, 8);
    this.arm = new THREE.CapsuleGeometry(0.05, 0.4, 3, 6);
    this.arm.translate(0, 0.2, 0);
    this.flame = new THREE.PlaneGeometry(1.4, 2.8);
    this.weave = Art.weave(256, 5);
    // Wicker: strands woven over and under, as colour and as a height map for bump shading.
    const weaveAt = (x, y) => {
      const row = Math.floor(y / 12), col = Math.floor(x / 20);
      const across = Math.sin((x % 20) / 20 * Math.PI), along = Math.sin((y % 12) / 12 * Math.PI);
      return (row + col) % 2 ? across : along;
    };
    const wicker = Art.image(256, 256, (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = 0.4 + 0.55 * (weaveAt(x, y) * 0.9 + 0.1) + (hash2(x, y) - 0.5) * 0.1;
        const i = (y * w + x) * 4;
        d[i] = (v * 190 + 20) | 0; d[i + 1] = (v * 140 + 15) | 0; d[i + 2] = (v * 80 + 8) | 0; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    const wickerHeight = Art.image(256, 256, (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = weaveAt(x, y) * 255; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    this.wicker = Art.texture(wicker, { repeat: true });
    this.wicker.repeat.set(3, 3);
    this.wickerBump = Art.texture(wickerHeight, { repeat: true, srgb: false });
    this.wickerBump.repeat.set(3, 3);
    this.normalMap = Art.texture(envelopeNormalMap(), { repeat: true, srgb: false });
    this.normalMap.repeat.set(2, 4);
  },

  rod(a, b, r) {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, 5, 1);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), unit(b.clone().sub(a)));
    g.applyQuaternion(q);
    g.translate(a.x, a.y, a.z);
    return g;
  },
};

function mergeGeometries(list) {
  // Minimal merge for non-indexed-compatible geometries: convert all to non-indexed and concatenate.
  const pos = [], nrm = [], uv = [];
  for (const g of list) {
    const ng = g.toNonIndexed();
    pos.push(...ng.attributes.position.array);
    nrm.push(...ng.attributes.normal.array);
    if (ng.attributes.uv) uv.push(...ng.attributes.uv.array);
    ng.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  if (uv.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

// ---------------------------------------------------------------------------------------------
// One balloon
// ---------------------------------------------------------------------------------------------

const WICKER_MATERIAL = () => new THREE.MeshStandardMaterial({ map: Parts.wicker, bumpMap: Parts.wickerBump, bumpScale: 0.6, roughness: 0.85, color: 0xffffff });
const DARK_METAL = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.7 });
const LEATHER = new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.8 });
const CABLE = new THREE.MeshStandardMaterial({ color: 0x8c8c88, roughness: 0.6, metalness: 0.5 });

export class Balloon {
  constructor(valley, index) {
    Parts.build();
    this.valley = valley;
    this.index = index;
    this.scale = rnd(0.85, 1.15);
    this.pattern = PATTERNS[index % PATTERNS.length];
    this.palette = pick(PALETTES).slice();
    if (coin()) this.palette.push(this.palette.shift());
    this.pos = v3();
    this.vel = v3();
    this.targetAlt = 0;
    // Heat in the envelope: 0.5 is neutral buoyancy; burning adds heat, which slowly leaks away.
    this.heat = 0.5 + rnd(-0.06, 0.06);
    this.pilotTimer = rnd(5, 60);
    this.tilt = new THREE.Vector2();
    this.tiltVel = new THREE.Vector2();
    this.burn = 0;
    this.burnTimer = 0;
    this.glow = 0;
    this.waveTimer = 0;
    this.tether = null;
    this.altWander = rnd(0, TAU);
    this.build();
  }

  build() {
    const node = new THREE.Group();
    this.node = node;
    this.textures = [];

    const skin = Art.texture(paintEnvelope(this.pattern, this.palette, Parts.weave));
    skin.anisotropy = 8;
    this.textures.push(skin);
    this.burnU = { value: 0 };
    this.envelopeMaterial = new THREE.MeshStandardMaterial({
      map: skin, normalMap: Parts.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.78, metalness: 0,
      side: THREE.DoubleSide,
    });
    patchMaterial(this.envelopeMaterial, {
      key: 'envelope',
      uniforms: { uBurn: this.burnU },
      vMain: `
        // Each gore bulges between its seams, most at the equator, not at the throat or crown.
        float bulge = (0.5 - 0.5 * cos(uv.x * 6.2831853 * ${GORES}.0)) * sin(uv.y * 3.14159) * 0.16;
        gPos += normal * bulge;`,
      fHead: 'uniform float uBurn;',
      fEmissive: `
        // When the burner fires the fabric glows from within, brightest near the throat.
        totalEmissiveRadiance += diffuseColor.rgb * uBurn * 2.4 * pow(clamp(1.0 - vMapUv.y, 0.0, 1.0), 1.3);`,
    });
    const envelope = new THREE.Mesh(Parts.envelope, this.envelopeMaterial);
    envelope.castShadow = true;
    node.add(envelope);
    const crown = new THREE.Mesh(Parts.crown, DARK_METAL);
    crown.rotation.x = Math.PI / 2;
    crown.position.y = ENVELOPE_H - 0.1;
    node.add(crown);
    const throat = new THREE.Mesh(Parts.throatRing, DARK_METAL);
    throat.rotation.x = Math.PI / 2;
    node.add(throat);
    node.add(new THREE.Mesh(Parts.cables, CABLE));
    node.add(new THREE.Mesh(Parts.frame, DARK_METAL));
    for (const x of [-0.25, 0.25]) {
      const b = new THREE.Mesh(Parts.burner, DARK_METAL);
      b.position.set(x, -3.1, 0);
      node.add(b);
    }
    this.wickerMaterial = WICKER_MATERIAL();
    const basket = new THREE.Mesh(Parts.basket, this.wickerMaterial);
    basket.castShadow = true;
    node.add(basket);
    node.add(new THREE.Mesh(Parts.basketRim, LEATHER));

    // The crew: two or three figures, one of whom waves when you rest the cursor on them.
    this.crew = [];
    const n = randInt(2, 3);
    for (let i = 0; i < n; i++) {
      const jacket = new THREE.MeshStandardMaterial({ color: pick([0xd14b2f, 0x2f6fd1, 0xe8d86a, 0x2b2b2b, 0xf3f0e8, 0x2a8a5e]), roughness: 0.9 });
      const person = new THREE.Group();
      const body = new THREE.Mesh(Parts.body, jacket);
      body.position.y = -4.95;
      const head = new THREE.Mesh(Parts.head, new THREE.MeshStandardMaterial({ color: pick([0xe6b89c, 0x8d5524, 0xc68642, 0xf1c27d]), roughness: 0.8 }));
      head.position.y = -4.45;
      const arm = new THREE.Mesh(Parts.arm, jacket);
      arm.position.set(0.22, -4.75, 0);
      arm.rotation.z = -0.3;
      person.add(body, head, arm);
      person.position.set((i - (n - 1) / 2) * 0.45, 0, (i % 2 ? 0.25 : -0.25));
      person.rotation.y = rnd(0, TAU);
      person.userData.arm = arm;
      node.add(person);
      this.crew.push(person);
    }

    // The burner flame: a billboard inside the throat, drawn when burning.
    this.flameMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uBurn: this.burnU },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uBurn; varying vec2 vUv;
        ${NOISE_GLSL}${Q}
        void main() {
          vec2 p = vUv;
          float n = fbm(vec2(p.x * 4.0, p.y * 2.5 - uTime * q(2.2)));
          float width = 0.42 - 0.3 * p.y;
          float core = smoothstep(width, width * 0.2, abs(p.x - 0.5) + (n - 0.5) * 0.25 * (0.3 + p.y));
          float env = smoothstep(0.0, 0.08, p.y) * smoothstep(1.0, 0.45, p.y);
          float a = clamp(core * env * uBurn, 0.0, 1.0);
          vec3 col = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.95, 0.7), core * 0.8);
          gl_FragColor = vec4(col * a * 3.5, a);
        }`,
    });
    this.flame = new THREE.Mesh(Parts.flame, this.flameMaterial);
    this.flame.position.y = -1.6;
    this.flame.visible = false;
    node.add(this.flame);

    node.scale.setScalar(this.scale);
  }

  /** Fire the burner for `seconds`; the balloon lights up and lifts, slowly, while it burns. */
  fire(seconds = 2.5) {
    this.burnTimer = Math.max(this.burnTimer, seconds);
  }

  wave() { this.waveTimer = 2.5; }

  /** Radius of the envelope on screen, in points. */
  screenRadius(scr) { return 8.5 * this.scale * this.valley.focal / scr.depth; }

  update(dt, valley) {
    const night = valley.night;
    // Burner and glow.
    this.burnTimer = Math.max(0, this.burnTimer - dt);
    const wantBurn = this.burnTimer > 0 ? 1 : 0;
    this.burn += clamp(wantBurn - this.burn, -dt * 1.2, dt * 6);
    this.burnU.value = this.burn;
    this.flame.visible = this.burn > 0.01;
    if (this.flame.visible) {
      this.flame.quaternion.copy(valley.camera.quaternion);
      this.flame.scale.set(1, 0.85 + 0.15 * Math.sin(valley.clock * 27 + this.index), 1);
    }

    // Where this balloon wants to be: drifting at dawn, tethered to the field at night.
    const wind = valley.windAt(this.pos);
    if (night > 0.5 && this.tether) {
      const t = this.tether;
      const desired = t.clone().sub(this.pos).multiplyScalar(0.2);
      desired.clampLength(0, 12);
      this.vel.lerp(desired, Math.min(1, dt * 0.8));
    } else {
      const floor = valley.groundHeight(this.pos.x, this.pos.z);
      // Stay above the ground and above the line of sight over the brow of the knoll (so the
      // hill never hides a balloon's lower half), and no higher than keeps it in frame.
      const depth = -this.pos.z;
      const minAlt = Math.max(floor + 25, valley.camera.position.y - depth * 0.02);
      // The crown must stay under the top of the frame (about 27 degrees up at this distance).
      const maxAlt = Math.max(minAlt + 10, valley.camera.position.y + depth * 0.45 - 20 * this.scale);
      // The burner heats the envelope; the heat leaks away slowly, so a burn keeps lifting for a
      // while after the flame, and a balloon left alone gradually cools and sinks.
      this.heat += this.burn * dt * 0.1 - dt * 0.006;
      if (this.pos.y > maxAlt) this.heat -= dt * 0.05; // the pilot vents
      this.heat = clamp(this.heat, 0, 1);
      // The pilot: burns when sinking low or cool, and now and then for the sake of it.
      this.pilotTimer -= dt;
      if (this.burnTimer <= 0 && (this.heat < 0.4 || this.pos.y < minAlt + 3 || this.pilotTimer <= 0)) {
        this.fire(rnd(2, 4));
        this.pilotTimer = rnd(25, 70);
      }
      const vy = clamp((this.heat - 0.5) * 3.0, -0.5, 1.0);
      this.vel.y += (vy - this.vel.y) * Math.min(1, dt * 0.5);
      this.vel.x += (wind.x - this.vel.x) * Math.min(1, dt * 0.25);
      this.vel.z += (wind.z - this.vel.z) * Math.min(1, dt * 0.25);
    }
    // The cursor's gust pushes it along and sets it swinging; so does any change in the wind.
    const gust = valley.gustAt(this).add(wind.clone().sub(this.vel).setY(0).multiplyScalar(0.25));
    this.vel.addScaledVector(gust, dt);
    this.pos.addScaledVector(this.vel, dt);
    valley.keepInView(this);

    // Pendulum sway: the envelope leans into any horizontal acceleration, then settles.
    const target = new THREE.Vector2(-gust.z * 0.05 - this.vel.z * 0.01, gust.x * 0.05 + this.vel.x * 0.01).clampLength(0, 0.3);
    const k = 5.0, damp = 1.6;
    this.tiltVel.add(target.clone().sub(this.tilt).multiplyScalar(k * dt)).multiplyScalar(Math.max(0, 1 - damp * dt));
    this.tilt.add(this.tiltVel.clone().multiplyScalar(dt));
    this.node.rotation.set(this.tilt.x, this.index * 0.7, this.tilt.y);
    this.node.position.copy(this.pos);

    // A wave from the crew.
    this.waveTimer = Math.max(0, this.waveTimer - dt);
    const arm = this.crew[0].userData.arm;
    const waving = this.waveTimer > 0;
    const goal = waving ? Math.PI * 0.85 + Math.sin(valley.clock * 9) * 0.4 : -0.3;
    arm.rotation.z += (goal - arm.rotation.z) * Math.min(1, dt * 8);
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    this.envelopeMaterial.dispose();
    this.flameMaterial.dispose();
    this.wickerMaterial.dispose();
    for (const p of this.crew) p.children.forEach((c) => c.material.dispose());
  }
}
