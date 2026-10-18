// Aspen Snow — The bark, painted once at load into textures rather than computed per pixel every
// frame, so the detail is the same resolution from the foot of a trunk to its crown and the
// hardware's mipmaps handle distance (no shimmer as the trunks sway).
//
// Three textures, all in metres:
// - the feature map: 1 m round by 4 m up, 1024 px per metre: the chalky mottle, the weathered
//   grey bands, lenticels in loose rows, the black eyes of shed branches with their pale raised
//   rims and dark tears, and the odd canker. Alpha is a height for the bump.
// - the detail tile: 20 cm square at 5 px per millimetre: the fine grain of the powdery bloom
//   (r), the grain of rough bark (g), vertical fibres (b) and a height (a). Tiles seamlessly.
// - the rough tile: 1 m round by 2 m up: the furrowed, plated bark of a trunk's foot, with the
//   crest height in alpha. Tiles seamlessly.
// Every trunk samples them at its own offset, and squeezed round its own circumference, so no
// two trunks show the same eyes.

import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep, seeded } from './util.js';

const PX = 1024;              // feature map pixels per metre
const FEAT_H = 4;             // metres up per repeat
const ROUGH_H = 2;

/** Value noise on a lattice that wraps every `nx` x `ny` cells, so the result tiles. */
function periodicNoise(x, y, nx, ny) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (i, j) => {
    i = ((i % nx) + nx) % nx; j = ((j % ny) + ny) % ny;
    const s = Math.sin(i * 127.1 + j * 311.7 + nx * 0.37) * 43758.5453;
    return s - Math.floor(s);
  };
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), ux), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), ux), uy);
}

/** Tiling fractal noise over a `w` x `h` metre tile, base frequency `f` cells per tile. */
function pfbm(x, y, w, h, f, octaves = 4) {
  let v = 0, amp = 0.5, sum = 0, fx = f, fy = Math.max(1, Math.round(f * h / w));
  for (let i = 0; i < octaves; i++) {
    v += periodicNoise(x / w * fx + i * 3.1, y / h * fy + i * 7.7, fx, fy) * amp;
    sum += amp; amp *= 0.5; fx *= 2; fy *= 2;
  }
  return v / sum;
}

/**
 * Relief baked into the colour: the sky lights slopes that face up and leaves the undersides of
 * rims and the floors of pits in shade, so the height shows even in flat light. `rgba` is
 * shaded in place from the height in `hgt` (red channel, mid grey flat); the map wraps.
 */
function reliefShade(rgba, hgt, W, H, k) {
  const hAt = (i, j) => hgt[((((j % H) + H) % H) * W + (((i % W) + W) % W)) * 4] / 255;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Light from above and a little from the left; slopes over three pixels.
      const dy = hAt(i, j - 2) - hAt(i, j + 2);
      const dx = hAt(i - 2, j) - hAt(i + 2, j);
      const h = hAt(i, j);
      let shade = 1 + k * (dy * 1.0 + dx * 0.25) - (0.5 - h) * 0.2;
      shade = Math.max(0.3, Math.min(1.5, shade));
      const q = (j * W + i) * 4;
      rgba[q] = Math.min(255, rgba[q] * shade);
      rgba[q + 1] = Math.min(255, rgba[q + 1] * shade);
      rgba[q + 2] = Math.min(255, rgba[q + 2] * shade);
    }
  }
}

function dataTexture(rgba, w, h, color = true) {
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// The feature map
// ---------------------------------------------------------------------------------------------

function paintFeatures(rng) {
  const W = PX, H = PX * FEAT_H;
  const R = (lo, hi) => lo + rng() * (hi - lo);
  // The mottle, computed at a quarter resolution (it is soft) and scaled up.
  const mw = W / 4, mh = H / 4;
  const mc = document.createElement('canvas');
  mc.width = mw; mc.height = mh;
  const mctx = mc.getContext('2d');
  const img = mctx.createImageData(mw, mh);
  const d = img.data;
  // White bark: a chalky white with only a breath of the green living bark and grey weathering.
  const cream = [0.90, 0.90, 0.88], green = [0.82, 0.84, 0.78], chalk = [0.97, 0.97, 0.96], grey = [0.80, 0.80, 0.79];
  for (let j = 0; j < mh; j++) {
    const y = j / mh * FEAT_H;
    const band = smoothstep(0.55, 0.85, pfbm(0.5, y, 1, FEAT_H, 1, 2) * 0.5 + pfbm(0.2, y, 1, FEAT_H, 2, 2) * 0.5);
    for (let i = 0; i < mw; i++) {
      const x = i / mw;
      const m1 = pfbm(x, y, 1, FEAT_H, 2, 4);
      const m2 = pfbm(x + 0.3, y + 1.1, 1, FEAT_H, 6, 4);
      let c = cream.map((v, k) => lerp(v, green[k], smoothstep(0.3, 0.72, m1 * 0.6 + m2 * 0.4)));
      const ch = smoothstep(0.45, 0.85, m2) * 0.5;
      c = c.map((v, k) => lerp(v, chalk[k], ch));
      c = c.map((v, k) => lerp(v, grey[k], band * 0.6 * smoothstep(0.3, 0.7, m2)));
      const q = (j * mw + i) * 4;
      d[q] = c[0] * 255; d[q + 1] = c[1] * 255; d[q + 2] = c[2] * 255; d[q + 3] = 255;
    }
  }
  mctx.putImageData(img, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mc, 0, 0, W, H);
  // The height map: mid grey is flat.
  const hc = document.createElement('canvas');
  hc.width = W; hc.height = H;
  const hctx = hc.getContext('2d');
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, W, H);

  // Everything is drawn in metres; features near an edge are drawn again across it so the map
  // tiles.
  const wraps = [[0, 0], [-1, 0], [1, 0], [0, -FEAT_H], [0, FEAT_H], [-1, -FEAT_H], [1, -FEAT_H], [-1, FEAT_H], [1, FEAT_H]];
  const each = (fn) => { for (const [ox, oy] of wraps) { for (const c of [ctx, hctx]) { c.save(); c.setTransform(PX, 0, 0, PX, ox * PX, oy * PX); } fn(ctx, hctx); for (const c of [ctx, hctx]) c.restore(); } };

  // Every feature is decided before it is drawn, so its copies across the edges match.
  // Horizontal wrinkles: the bark is ringed with long, faint, slightly wavy ridges and grooves,
  // a few centimetres apart, running part way round the trunk.
  const wrinkles = [];
  for (let y = 0; y < FEAT_H; y += R(0.006, 0.028)) {
    const n = 1 + Math.floor(R(0, 4));
    for (let k = 0; k < n; k++) {
      wrinkles.push({ x: rng(), y: y + R(-0.003, 0.003), len: R(0.03, 0.28), w: R(0.0006, 0.0018), raised: rng() < 0.6, wave: R(0.0005, 0.003), bend: R(-0.006, 0.006), k: R(0.3, 1) });
    }
  }
  each((c, h) => {
    for (const r of wrinkles) {
      const path = (k) => { k.beginPath(); k.moveTo(r.x, r.y); k.quadraticCurveTo(r.x + r.len * 0.5, r.y + r.bend + r.wave, r.x + r.len, r.y + r.bend * 0.3); };
      // Height: a raised ridge or a groove, soft-edged, fading at the ends.
      const g = h.createLinearGradient(r.x, 0, r.x + r.len, 0);
      const v = r.raised ? 255 : 0, a = 0.4 * r.k;
      g.addColorStop(0, `rgba(${v},${v},${v},0)`); g.addColorStop(0.2, `rgba(${v},${v},${v},${a})`); g.addColorStop(0.8, `rgba(${v},${v},${v},${a})`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      h.strokeStyle = g; h.lineWidth = r.w; h.lineCap = 'round'; path(h); h.stroke();
      // A whisper of it in the colour too.
      const gc = c.createLinearGradient(r.x, 0, r.x + r.len, 0);
      const cv = r.raised ? '255,255,252' : '70,66,60', ca = (r.raised ? 0.12 : 0.07) * r.k;
      gc.addColorStop(0, `rgba(${cv},0)`); gc.addColorStop(0.2, `rgba(${cv},${ca})`); gc.addColorStop(0.8, `rgba(${cv},${ca})`); gc.addColorStop(1, `rgba(${cv},0)`);
      c.strokeStyle = gc; c.lineWidth = r.w * 0.8; c.lineCap = 'round'; path(c); c.stroke();
    }
  });

  // Lenticels: short dark dashes in loose rows, with a thread of pale bark lifted just below.
  const lents = [];
  for (let y = 0.02; y < FEAT_H; y += R(0.03, 0.09)) {
    const density = R(0.1, 0.7);
    for (let x = R(0, 0.05); x < 1; x += R(0.04, 0.16)) {
      if (rng() > density) continue;
      lents.push({ x, y: y + R(-0.006, 0.006), len: R(0.006, 0.024), ht: R(0.003, 0.0048), ang: R(-0.06, 0.06) });
    }
  }
  each((c, h) => {
    for (const l of lents) {
      for (const [k, col] of [[c, 'rgba(44,38,32,0.8)'], [h, 'rgba(0,0,0,0.7)']]) {
        k.save(); k.translate(l.x, l.y); k.rotate(l.ang);
        k.fillStyle = col;
        k.beginPath(); k.roundRect(-l.len / 2, -l.ht / 2, l.len, l.ht, l.ht / 2); k.fill();
        k.restore();
      }
      for (const [k, col, a] of [[c, 'rgba(255,255,250,0.35)'], [h, 'rgba(255,255,255,0.6)']]) {
        k.save(); k.translate(l.x, l.y + l.ht * 0.8); k.rotate(l.ang);
        k.strokeStyle = col; k.lineWidth = 0.0012;
        k.beginPath(); k.moveTo(-l.len / 2, 0); k.lineTo(l.len / 2, 0); k.stroke();
        k.restore();
      }
    }
  });

  // Eyes: the scars of shed branches.
  const eyes = [];
  for (let n = 0; n < 9; n++) {
    const w = R(0.045, 0.11);
    const e = { x: rng(), y: R(0, FEAT_H), w, hh: w * R(0.38, 0.7), tilt: R(-0.15, 0.15), tears: [] };
    if (rng() < 0.6) {
      const L = R(0.25, 0.6);
      for (let s = 0; s < 8; s++) e.tears.push({ ox: R(-w * 0.3, w * 0.3), wdt: R(0.004, 0.014), L: L * R(0.5, 1), a: R(0.2, 1), b: R(0.2, 1), jx: R(-0.01, 0.01), jy: R(-0.01, 0.01) });
    }
    eyes.push(e);
  }
  const lens = (k, w, hh) => { k.beginPath(); k.moveTo(-w, 0); k.quadraticCurveTo(0, -hh * 2, w, 0); k.quadraticCurveTo(0, hh * 2, -w, 0); k.closePath(); };
  each((c, h) => {
    for (const e of eyes) {
      const hh = e.hh;
      c.save(); c.translate(e.x, e.y); c.rotate(e.tilt);
      h.save(); h.translate(e.x, e.y); h.rotate(e.tilt);
      // The tear below: soft, ragged, fading.
      for (const t of e.tears) {
        const g = c.createLinearGradient(0, hh * 0.5, 0, hh * 0.5 + t.L);
        g.addColorStop(0, 'rgba(30,26,22,0.09)'); g.addColorStop(1, 'rgba(30,26,22,0)');
        c.fillStyle = g;
        c.beginPath(); c.moveTo(t.ox - t.wdt, hh * 0.3); c.lineTo(t.ox + t.wdt, hh * 0.3); c.lineTo(t.ox + t.wdt * t.a + t.jx, hh * 0.5 + t.L); c.lineTo(t.ox - t.wdt * t.b + t.jy, hh * 0.5 + t.L); c.closePath(); c.fill();
      }
      // The rim: a pale raised ring, darker toward the core.
      const rim = c.createRadialGradient(0, 0, e.w * 0.5, 0, 0, e.w);
      rim.addColorStop(0, 'rgba(96,92,84,1)'); rim.addColorStop(0.7, 'rgba(158,155,148,1)'); rim.addColorStop(1, 'rgba(200,198,194,1)');
      c.fillStyle = rim; lens(c, e.w, hh); c.fill();
      c.strokeStyle = 'rgba(60,54,44,0.5)'; c.lineWidth = 0.0015; c.stroke();
      h.fillStyle = '#c8c8c8'; lens(h, e.w, hh); h.fill();
      // The core: the black scar, with a slit of light along its top.
      c.fillStyle = '#120e0b'; lens(c, e.w * 0.74, hh * 0.62); c.fill();
      h.fillStyle = '#303030'; lens(h, e.w * 0.74, hh * 0.62); h.fill();
      c.strokeStyle = 'rgba(90,84,70,0.6)'; c.lineWidth = 0.0012;
      c.beginPath(); c.moveTo(-e.w * 0.5, -hh * 0.15); c.quadraticCurveTo(0, -hh * 0.9, e.w * 0.5, -hh * 0.15); c.stroke();
      c.restore(); h.restore();
    }
  });

  // Cankers: rare, ragged black wounds with a few cracks of lighter wood showing.
  const cankers = [];
  for (let n = 0; n < 2; n++) {
    const r = R(0.03, 0.09), pts = [], cracks = [];
    for (let a = 0; a < TAU; a += TAU / 28) pts.push([Math.cos(a) * r * R(0.6, 1.3), Math.sin(a) * r * R(0.6, 1.3) * 1.4]);
    for (let s = 0; s < 4; s++) cracks.push([R(-r, r) * 0.5, R(-r, r), R(-r, r) * 0.5, R(-r, r)]);
    cankers.push({ x: rng(), y: R(0, FEAT_H), pts, cracks });
  }
  each((c, h) => {
    for (const k of cankers) {
      c.save(); c.translate(k.x, k.y); h.save(); h.translate(k.x, k.y);
      for (const [t, col] of [[c, '#1a1512'], [h, '#404040']]) {
        t.fillStyle = col; t.beginPath(); t.moveTo(k.pts[0][0], k.pts[0][1]);
        for (const p of k.pts) t.lineTo(p[0], p[1]);
        t.closePath(); t.fill();
      }
      c.strokeStyle = 'rgba(110,100,80,0.5)'; c.lineWidth = 0.0015;
      for (const cr of k.cracks) { c.beginPath(); c.moveTo(cr[0], cr[1]); c.lineTo(cr[2], cr[3]); c.stroke(); }
      c.restore(); h.restore();
    }
  });

  const rgba = ctx.getImageData(0, 0, W, H).data;
  const hgt = hctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  reliefShade(rgba, hgt, W, H, 1.6);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = rgba[i * 4]; out[i * 4 + 1] = rgba[i * 4 + 1]; out[i * 4 + 2] = rgba[i * 4 + 2];
    out[i * 4 + 3] = hgt[i * 4];
  }
  return dataTexture(out, W, H, true);
}

// ---------------------------------------------------------------------------------------------
// The detail tile
// ---------------------------------------------------------------------------------------------

function paintDetail() {
  const N = 1024, T = 0.2;
  const out = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const y = j / N * T;
    for (let i = 0; i < N; i++) {
      const x = i / N * T;
      // Powdery bloom: a soft, even grain, no pits.
      const bloom = pfbm(x, y, T, T, 4, 3);
      const pits = 0;
      const grainR = clamp(0.5 + (bloom - 0.5) * 0.8, 0, 1);
      // Rough-bark grain: harsher, more contrast.
      const rough = pfbm(x + 0.07, y + 0.03, T, T, 8, 4);
      const grainG = clamp(0.5 + (rough - 0.5) * 2.2, 0, 1);
      // Fine horizontal fibres: long across, fine up.
      const fibre = periodicNoise(i / N * 3, j / N * 48, 3, 48) * 0.6 + periodicNoise(i / N * 8, j / N * 160, 8, 160) * 0.4;
      const q = (j * N + i) * 4;
      out[q] = grainR * 255; out[q + 1] = grainG * 255; out[q + 2] = fibre * 255;
      out[q + 3] = clamp(0.5 + (bloom - 0.5) * 0.3 + (fibre - 0.5) * 0.5, 0, 1) * 255;
    }
  }
  return dataTexture(out, N, N, false);
}

// ---------------------------------------------------------------------------------------------
// The rough tile: furrowed, plated bark
// ---------------------------------------------------------------------------------------------

function paintRough(rng) {
  const W = PX, H = PX * ROUGH_H;
  const out = new Uint8Array(W * H * 4);
  const strips = 52;
  const stripW = [], stripH = [];
  for (let s = 0; s < strips; s++) { stripW.push(0.6 + rng() * 0.9); stripH.push(rng()); }
  const plateRate = stripH.map((h) => Math.round((5 + h * 6) * ROUGH_H) / ROUGH_H);
  const plateShade = new Map();
  const shade = (s, cy) => {
    const k = s * 1000 + cy;
    if (!plateShade.has(k)) { const r = seeded(k * 7919 + 13)(); plateShade.set(k, r); }
    return plateShade.get(k);
  };
  // A weathered grey-brown: darker than this, a trunk's foot read as a burnt, near-black band.
  const furrow = [0.30, 0.285, 0.265], crest = [0.58, 0.555, 0.51];
  for (let j = 0; j < H; j++) {
    const y = j / PX;
    for (let i = 0; i < W; i++) {
      const x = i / PX;
      // The strips wander across the trunk.
      const wander = (pfbm(x, y, 1, ROUGH_H, 3, 3) - 0.5) * 3.0 + (pfbm(x + 0.4, y + 0.2, 1, ROUGH_H, 12, 2) - 0.5) * 0.8;
      const sx = x * strips + wander;
      const s = ((Math.floor(sx) % strips) + strips) % strips, f = sx - Math.floor(sx);
      let c = 1 - Math.abs(f * 2 - 1);
      c = Math.pow(c, stripW[s]);
      const py = y * plateRate[s] + stripH[s] * 10;
      const cy = Math.floor(py), fy = py - cy;
      const per = Math.round(plateRate[s] * ROUGH_H), cyp = ((cy % per) + per) % per;
      const brk = smoothstep(0.1, 0, Math.min(fy, 1 - fy)) * (shade(s, cyp + 500) > 0.2 ? 1 : 0);
      c *= 1 - brk * 0.8;
      const hp = shade(s, cyp + 1000);
      c *= 0.45 + 0.7 * hp;
      if (hp < 0.06) c *= 0.3;
      const sub = 1 - Math.abs(((sx * 3 + stripH[s]) % 1) * 2 - 1);
      c *= 0.75 + 0.25 * sub;
      const plates = pfbm(x + 0.5, y + 0.7, 1, ROUGH_H, 8, 2);
      const cr = smoothstep(0.1, 0.9, c * (0.7 + 0.5 * plates));
      const fine = pfbm(x * 7 + 0.3, y * 7 + 0.1, 7, 7 * ROUGH_H, 20, 2);
      const col = furrow.map((v, k) => lerp(v, crest[k], cr) * (0.78 + 0.44 * fine));
      const q = (j * W + i) * 4;
      out[q] = col[0] * 255; out[q + 1] = col[1] * 255; out[q + 2] = col[2] * 255;
      out[q + 3] = clamp(0.15 + cr * 0.75, 0, 1) * 255;
    }
  }
  // The ridges lit from above, shaded below.
  const hgt = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) hgt[i * 4] = out[i * 4 + 3];
  reliefShade(out, hgt, W, H, 0.3);
  return dataTexture(out, W, H, true);
}

let cache = null;

/** The bark textures, painted once per page load and shared by every grove. */
export function makeBarkTextures() {
  if (cache) return cache;
  const rng = seeded(90210);
  cache = { feature: paintFeatures(rng), detail: paintDetail(), rough: paintRough(rng) };
  return cache;
}
