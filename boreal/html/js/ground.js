// Boreal Night — The snow: a deep, wind-rippled snowpack that glitters in the moonlight, keeps the
// craters and wing prints the owls leave, and slowly fills them in again; and the far horizon of
// spruce spires and low hills.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, fbm2, noise2, v3, Art } from './util.js';
import { G, NOISE_GLSL, patchMaterial } from './shaders.js';

// The print map covers the clearing where the owls hunt: 48 m square, 4.7 cm a texel.
export const PRINTS = { x0: -24, z0: -50, size: 48, res: 1024 };
const PRINT_ZERO = 200;          // the byte value of undisturbed snow
const PRINT_SCALE = 400;         // bytes per metre of depth

/** The snow's surface height (m) at (x, z), before any prints. */
export function makeHeight(wells) {
  // Bucket the tree wells on a 10 m grid so each lookup checks only its neighbours.
  const grid = new Map();
  const key = (i, j) => i * 10007 + j;
  for (const w of wells) {
    const k = key(Math.floor(w.x / 10), Math.floor(w.z / 10));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(w);
  }
  return (x, z) => {
    // Gentle swells of drifted snow over the bog, hummocks, and the land rising far off.
    let h = (fbm2(x / 38 + 3.1, z / 38 + 7.7, 4) - 0.5) * 1.1;
    h += (fbm2(x / 9 + 11, z / 9 + 5, 3) - 0.5) * 0.35;
    // Snow-buried hummocks (tussocks and low shrubs under the snow), a little lumpy.
    const hum = noise2(x / 3.4 + 40, z / 3.4 + 13);
    h += smoothstep(0.6, 0.95, hum) * 0.13;
    const d = Math.hypot(x, z + 30);
    h += smoothstep(120, 420, d) * 9 * (0.6 + 0.4 * noise2(x / 60, z / 60));
    // The viewer stands on a low rise at the forest edge, looking down over the bog.
    h *= smoothstep(1.5, 8, Math.hypot(x, z)) * 0.8 + 0.2;
    h += 1.9 * Math.exp(-(x * x + (z - 2) * (z - 2)) / 70);
    // Tree wells: the snow is shallower under a spruce, where the branches caught it.
    const i0 = Math.floor(x / 10), j0 = Math.floor(z / 10);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (const w of list) {
          const r = Math.hypot(x - w.x, z - w.z) / w.r;
          if (r < 1.4) h -= w.depth * Math.exp(-r * r * 2.2);
        }
      }
    }
    return h;
  };
}

/**
 * The same height function sampled once onto a 25 cm grid over the near ground, for the many
 * cheap lookups (every snowflake, every frame); the exact function beyond it.
 */
export function cacheHeight(height, x0 = -40, z0 = -70, w = 80, d = 80, step = 0.25) {
  const nx = Math.round(w / step) + 1, nz = Math.round(d / step) + 1;
  const grid = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = height(x0 + i * step, z0 + j * step);
  return (x, z) => {
    const fx = (x - x0) / step, fz = (z - z0) / step;
    if (fx < 0 || fz < 0 || fx >= nx - 1 || fz >= nz - 1) return height(x, z);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const k = j * nx + i;
    return (grid[k] * (1 - u) + grid[k + 1] * u) * (1 - v) + (grid[k + nx] * (1 - u) + grid[k + nx + 1] * u) * v;
  };
}

/** A grid denser in the middle of the clearing and coarse toward the horizon. */
function snowGeometry(height, n, extent) {
  const cz = -16;
  const warp = (t) => Math.sign(t) * extent * Math.pow(Math.abs(t), 2.1);
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    const z = cz + warp(j / n * 2 - 1);
    for (let i = 0; i <= n; i++) {
      const x = warp(i / n * 2 - 1);
      const k = (j * (n + 1) + i) * 3;
      pos[k] = x;
      pos[k + 1] = height(x, z);
      pos[k + 2] = z;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// Far moon shadows. The shadow map covers the near clearing; beyond it every tree still throws a
// long shadow toward the viewer (the moon is low in front), so the snow darkens with distance as
// the forest thickens. They're baked once: each tree's shadow is a run of discs along the ground
// away from the moon, one per slice of its crown, as wide as the crown at that height.
// ---------------------------------------------------------------------------------------------

export const CANOPY = { x0: -230, z0: -300, w: 460, d: 310, px: 2 };

/** `casters`: [{x, z, height, crownBase, maxR}] in world space. */
export function bakeCanopy(casters, moonDir) {
  const { x0, z0, w, d, px } = CANOPY;
  const nx = Math.round(w * px), nz = Math.round(d * px);
  const acc = new Float32Array(nx * nz);
  const flat = Math.hypot(moonDir.x, moonDir.z);
  const sx = -moonDir.x / flat, sz = -moonDir.z / flat;
  const run = flat / moonDir.y;            // metres of shadow per metre of height
  const disc = (cx, cz, r, k) => {
    const i0 = Math.max(0, Math.floor((cx - r - x0) * px)), i1 = Math.min(nx - 1, Math.ceil((cx + r - x0) * px));
    const j0 = Math.max(0, Math.floor((cz - r - z0) * px)), j1 = Math.min(nz - 1, Math.ceil((cz + r - z0) * px));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) / px - cx, dz = z0 + (j + 0.5) / px - cz;
        const v = k * smoothstep(r, r * 0.55, Math.hypot(dx, dz));
        const q = j * nx + i;
        if (v > acc[q]) acc[q] = v;
      }
    }
  };
  for (const t of casters) {
    for (let y = 0.3; y < t.height; y += 0.5) {
      const f = (y - t.crownBase) / Math.max(0.1, t.height - t.crownBase);
      const r = f < 0 ? 0.15 : t.maxR * Math.pow(Math.max(0, 1 - f), 0.9) + 0.12;
      disc(t.x + sx * y * run, t.z + sz * y * run, r, f < 0 ? 0.7 : 0.9);
    }
  }
  // A light blur for the penumbra.
  const out = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        s += acc[jj * nx + ii]; n++;
      }
      out[j * nx + i] = Math.round(s / n * 255);
    }
  }
  const tex = new THREE.DataTexture(out, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class Snowpack {
  constructor(height) {
    this.height = height;
    const { res } = PRINTS;
    this.prints = new Uint8Array(res * res).fill(PRINT_ZERO);
    this.printTex = new THREE.DataTexture(this.prints, res, res, THREE.RedFormat, THREE.UnsignedByteType);
    this.printTex.magFilter = THREE.LinearFilter;
    this.printTex.minFilter = THREE.LinearFilter;
    this.printTex.needsUpdate = true;
    this.dirty = null;          // the bounding box of every print not yet fully filled in
    this.fillTimer = 0;

    this.canopyUniform = { value: null };
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.82, metalness: 0 }), {
      key: 'snowpack',
      uniforms: {
        uPrints: { value: this.printTex },
        uPrintRect: { value: new THREE.Vector4(PRINTS.x0, PRINTS.z0, PRINTS.size, 1 / res) },
        uMoonDir: G.uMoonDir, uMoon: G.uMoon, uAuroraLight: G.uAuroraLight, uTime: G.uTime,
        uCanopy: this.canopyUniform,
        uCanopyRect: { value: new THREE.Vector4(CANOPY.x0, CANOPY.z0, CANOPY.w, CANOPY.d) },
      },
      fHead: `
        uniform sampler2D uPrints, uCanopy; uniform vec4 uPrintRect, uCanopyRect; uniform vec3 uMoonDir, uAuroraLight; uniform float uMoon, uTime;
        ${NOISE_GLSL}
        float printH(vec2 p) {
          vec2 uv = (p - uPrintRect.xy) / uPrintRect.z;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
          return (texture2D(uPrints, uv).r * 255.0 - ${PRINT_ZERO}.0) / ${PRINT_SCALE}.0;
        }
        // Wind ripples: long low ridges across the prevailing wind, broken up and wandering.
        float ripples(vec2 p) {
          vec2 q = vec2(p.x * 0.8 + p.y * 0.6, -p.x * 0.6 + p.y * 0.8);
          float warp = fbm(q * 0.35) * 6.0;
          float r = sin(q.x * 9.0 + warp) * 0.5 + 0.5;
          return r * r * smoothstep(0.3, 0.7, fbm(q * 0.12 + 4.0)) * 0.012 + fbm(p * 3.0) * 0.006;
        }`,
      fNormal: `
        {
          vec2 p = vWPos.xz;
          float e = uPrintRect.z * uPrintRect.w;
          float h0 = printH(p);
          float hx = printH(p + vec2(e, 0.0)) - printH(p - vec2(e, 0.0));
          float hz = printH(p + vec2(0.0, e)) - printH(p - vec2(0.0, e));
          float rx = ripples(p + vec2(0.02, 0.0)) - ripples(p - vec2(0.02, 0.0));
          float rz = ripples(p + vec2(0.0, 0.02)) - ripples(p - vec2(0.0, 0.02));
          // Fade the fine ripples out with distance so they don't shimmer.
          float fine = 1.0 - smoothstep(25.0, 70.0, length(vWPos - cameraPosition));
          vec3 g = vec3(hx / (2.0 * e) + rx / 0.04 * fine, 0.0, hz / (2.0 * e) + rz / 0.04 * fine);
          vec3 nW = normalize(vec3(-g.x, 1.0, -g.z));
          // Tilt the interpolated normal by the same amount, in view space.
          vec3 tilt = (viewMatrix * vec4(nW - vec3(0.0, 1.0, 0.0), 0.0)).xyz;
          normal = normalize(normal + tilt);
          snowCavity = clamp(-h0 * 3.0, 0.0, 0.6);
        }`,
      fColor: `
        float snowCavity = 0.0;`,
      fEmissive: `
        {
          // Glitter: each centimetre-sized cell of the surface holds a crystal facet tilted its own
          // way; when a facet happens to mirror the moon into the eye it flashes.
          vec3 V = normalize(cameraPosition - vWPos);
          float dist = length(cameraPosition - vWPos);
          vec2 cellP = vWPos.xz / 0.012;
          vec2 cell = floor(cellP);
          vec2 f = fract(cellP) - 0.5;
          vec2 r = hash22(cell);
          float r3 = hash21(cell + 7.3);
          // Crystals lie every which way, some steeply tilted (the moon is low, so only those can
          // mirror it back toward the viewer).
          vec3 facet = normalize(vec3((r.x - 0.5) * 2.4, 1.0, (r.y - 0.5) * 2.4));
          vec3 H = normalize(uMoonDir + V);
          float spec = pow(max(dot(facet, H), 0.0), 500.0);
          // Only a few cells hold a facet big and flat enough to flash.
          float dotMask = smoothstep(0.3, 0.08, length(f)) * step(0.9, r3);
          // Once a cell is smaller than a couple of pixels a crisp glint can't be drawn, only
          // aliased into flashing squares: fade them out instead.
          float px = length(fwidth(cellP));
          float resolve = 1.0 / (1.0 + px * px * 4.0);
          float glint = spec * dotMask * resolve * uMoon * 2.4;
          // The aurora glints too, more faintly, in its own colour.
          vec3 Ha = normalize(vec3(0.0, 0.55, -0.83) + V);
          float specA = pow(max(dot(facet, Ha), 0.0), 900.0) * dotMask * resolve;
          totalEmissiveRadiance += vec3(0.85, 0.92, 1.0) * glint + uAuroraLight * specA * 2.0;
        }`,
      fBeforeOpaque: `
        outgoingLight *= 1.0 - snowCavity;
        {
          // Moon shadows of the trees the shadow map can't reach, baked (see bakeCanopy).
          vec2 cuv = (vWPos.xz - uCanopyRect.xy) / uCanopyRect.zw;
          float shade = (cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) ? texture2D(uCanopy, cuv).r : 0.0;
          outgoingLight *= 1.0 - shade * 0.8 * uMoon;
          // Far off, the snow is mostly seen between trunks and under boughs: it greys down.
          float far = length(vWPos - cameraPosition);
          outgoingLight *= 1.0 - 0.3 * smoothstep(70.0, 260.0, far);
        }`,
    });
    // fColor declares snowCavity before fNormal uses it (map_fragment comes first).
    this.mesh = new THREE.Mesh(snowGeometry(height, 760, 460), this.material);
    this.mesh.receiveShadow = true;
  }

  /** Height of the undisturbed snow at (x, z). */
  heightAt(x, z) { return this.height(x, z); }

  /**
   * An owl's strike: a pit where the feet and body went in, and either side the long impressions
   * of the wings spread flat on the snow, ending in the fingered primaries; the tail fans behind.
   * `heading` is the direction the owl was flying, radians from +x toward +z.
   */
  stampStrike(x, z, heading, scale = 1) {
    const { x0, z0, size, res } = PRINTS;
    const texel = size / res;
    const reach = 0.95 * scale;
    const ci = (x - x0) / texel, cj = (z - z0) / texel;
    const r = Math.ceil(reach / texel);
    const fx = Math.cos(heading), fz = Math.sin(heading);    // forward
    const sx = -fz, sz = fx;                                  // to the owl's right
    for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(res - 1, Math.ceil(cj + r)); j++) {
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(res - 1, Math.ceil(ci + r)); i++) {
        const dx = (i - ci) * texel, dz = (j - cj) * texel;
        const f = (dx * fx + dz * fz) / scale, s = (dx * sx + dz * sz) / scale;
        let h = 0;
        // The pit: an oval bowl with a little thrown-up rim.
        const pr = Math.hypot(f / 0.24, s / 0.19);
        if (pr < 1) h -= 0.32 * (1 - pr * pr) ** 2;
        h += 0.03 * Math.exp(-(((pr - 1.12) / 0.16) ** 2));
        // Wings: from the shoulders out to 0.72 m, the chord narrowing, swept slightly back.
        const as = Math.abs(s);
        if (as > 0.12 && as < 0.78) {
          const t = (as - 0.12) / 0.66;
          const lead = 0.06 - t * 0.1, chord = lerp(0.3, 0.16, t);
          const ff = f - lead + t * 0.06;
          if (ff < 0 && ff > -chord) {
            const across = 1 - Math.abs((ff + chord / 2) / (chord / 2));
            let depth = 0.07 * smoothstep(0, 0.35, across) * (1 - t * 0.35);
            // The primaries spread like fingers near the tip: grooves running outward.
            if (t > 0.55) {
              const fingers = 0.5 + 0.5 * Math.cos((ff / chord) * 6 * TAU / 2 * 2);
              depth *= lerp(1, fingers, smoothstep(0.55, 0.8, t));
            }
            // Feather lines along the wing.
            depth *= 0.85 + 0.15 * Math.cos(ff / 0.025 * TAU);
            h -= depth;
          }
        }
        // The tail: a short fan behind the pit.
        const tf = -f - 0.2;
        if (tf > 0 && tf < 0.28 && Math.abs(s) < 0.06 + tf * 0.35) h -= 0.05 * (1 - tf / 0.28);
        if (h === 0) continue;
        const k = j * res + i;
        this.prints[k] = clamp(Math.round(this.prints[k] + h * PRINT_SCALE), 0, 255);
      }
    }
    this.extend(ci - r, cj - r, ci + r, cj + r);
    this.printTex.needsUpdate = true;
  }

  /** A vole's rustle: the faintest stir in the snow surface, a few crystals tossed up. */
  stampRustle(x, z) {
    const { x0, z0, size, res } = PRINTS;
    const texel = size / res;
    const ci = (x - x0) / texel, cj = (z - z0) / texel;
    const r = Math.ceil(0.12 / texel);
    for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(res - 1, Math.ceil(cj + r)); j++) {
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(res - 1, Math.ceil(ci + r)); i++) {
        const d = Math.hypot(i - ci, j - cj) * texel / 0.12;
        if (d >= 1) continue;
        const k = j * res + i;
        this.prints[k] = clamp(Math.round(this.prints[k] + 0.012 * (1 - d * d) * PRINT_SCALE * (Math.random() < 0.5 ? 1 : -0.5)), 0, 255);
      }
    }
    this.extend(ci - r, cj - r, ci + r, cj + r);
    this.printTex.needsUpdate = true;
  }

  extend(i0, j0, i1, j1) {
    const { res } = PRINTS;
    const b = [Math.max(0, Math.floor(i0)), Math.max(0, Math.floor(j0)), Math.min(res - 1, Math.ceil(i1)), Math.min(res - 1, Math.ceil(j1))];
    if (!this.dirty) this.dirty = b;
    else this.dirty = [Math.min(this.dirty[0], b[0]), Math.min(this.dirty[1], b[1]), Math.max(this.dirty[2], b[2]), Math.max(this.dirty[3], b[3])];
  }

  /** Falling snow fills the prints in, over ten minutes or so (slower without snowfall: drift). */
  update(dt, snowing) {
    if (!this.dirty) return;
    this.fillTimer += dt;
    if (this.fillTimer < 2) return;
    const step = this.fillTimer * (snowing ? 1 / 600 : 1 / 2400);
    this.fillTimer = 0;
    const { res } = PRINTS;
    const [i0, j0, i1, j1] = this.dirty;
    let any = false;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * res + i;
        const v = this.prints[k];
        if (v === PRINT_ZERO) continue;
        // Ease toward undisturbed snow, always moving at least one step.
        const d = (PRINT_ZERO - v) * step;
        const nv = v + (Math.abs(d) < 1 ? Math.sign(PRINT_ZERO - v) * (Math.random() < Math.abs(d) * 4 + 0.05 ? 1 : 0) : Math.round(d));
        this.prints[k] = nv;
        if (nv !== PRINT_ZERO) any = true;
      }
    }
    if (!any) this.dirty = null;
    this.printTex.needsUpdate = true;
  }

  setCanopy(tex) {
    this.canopyTex?.dispose();
    this.canopyTex = tex;
    this.canopyUniform.value = tex;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.printTex.dispose(); this.canopyTex?.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The horizon: black spruce spires standing on the far edge of the bog, and low hills beyond.
// Drawn in metres on a canvas fine enough (about 12 px per metre at 260 m) to stay sharp at 4K.
// ---------------------------------------------------------------------------------------------

/** A single-channel mask texture from a canvas's alpha, flipped so row 0 is the bottom. */
function maskTexture(canvas) {
  const w = canvas.width, h = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) mask[dst + x] = rgba[(src + x) * 4 + 3];
  }
  const tex = new THREE.DataTexture(mask, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Boreal spruce: narrow spires, drooping branches with upturned tips, the odd club top. */
function spireLineCanvas(widthM, heightM, px) {
  const w = Math.round(widthM * px), h = Math.round(heightM * px);
  return Art.image(w, h, (ctx) => {
    ctx.setTransform(px, 0, 0, px, 0, 0);
    const W = widthM, H = heightM;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    const line = (x0, y0, x1, y1, width) => { ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    const groundAt = (x) => H - 1.2 - fbm2(x / 60, 1.7, 3) * 2.5;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 0.5) ctx.lineTo(x, groundAt(x));
    ctx.lineTo(W, H);
    ctx.fill();
    const spruce = (x, base, height) => {
      const top = base - height;
      const lean = rnd(-0.02, 0.02);
      line(x, base, x + lean * height, top, 0.1 + height * 0.01);
      const club = Math.random() < 0.25;
      for (let y = top + 0.15; y < base - 0.4; y += rnd(0.18, 0.32)) {
        const f = (y - top) / height;
        const cx = x + lean * (base - y);
        // Narrow crowns: snow-country spruce shed snow by being slender.
        let len = (0.25 + f * 0.95) * rnd(0.6, 1.1) * (height / 12);
        if (club && f < 0.15) len *= 1.8;
        for (const side of [-1, 1]) {
          if (Math.random() < 0.12) continue;
          const droop = rnd(0.25, 0.6);
          const ex = cx + side * Math.cos(droop) * len, ey = y + Math.sin(droop) * len;
          line(cx, y, ex, ey, 0.05 + len * 0.06);
          line(ex, ey, ex + side * 0.08, ey - rnd(0.05, 0.15), 0.05);
        }
      }
      line(x + lean * height, top, x + lean * height, top - 0.4, 0.05);
    };
    for (let x = -3; x < W + 3; x += rnd(0.7, 2.4)) {
      const open = fbm2(x / 45 + 3, 2.2, 2) < 0.36;
      if (open && Math.random() < 0.8) continue;
      const base = groundAt(x) + rnd(0, 0.8);
      spruce(x, base, rnd(5, 13) * (Math.random() < 0.06 ? 1.4 : 1));
    }
  });
}

function hillsCanvas(seed) {
  const w = 4096, h = 256;
  return Art.image(w, h, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const n = fbm2(x / 520 + seed, seed, 5);
      ctx.lineTo(x, h - 30 - n * n * 190);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
}

export class Horizon {
  constructor(height) {
    this.group = new THREE.Group();
    this.textures = [];
    this.materials = [];
    const make = (tex, tint, snowTint) => {
      this.textures.push(tex);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: tex }, uTint: { value: tint }, uSnow: { value: snowTint },
          uFogColor: G.uFogColor, uMoon: G.uMoon, uAuroraLight: G.uAuroraLight,
        },
        vertexShader: `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform vec3 uTint, uSnow, uFogColor, uAuroraLight; uniform float uMoon;
          varying vec2 vUv;
          void main() {
            if (texture2D(uMap, vUv).r < 0.5) discard;
            // Moonlit snow on the far slopes, fading up into dark forest.
            vec3 c = uTint + uSnow * (uMoon * 0.8 + 0.2) * (1.0 - vUv.y) + uAuroraLight * 0.15 * (1.0 - vUv.y);
            gl_FragColor = vec4(c, 1.0);
          }`,
      });
      this.materials.push(mat);
      return mat;
    };
    const arc = (dist, widthDeg, heightM, tex, mat, lift) => {
      // A curved band facing the viewer, so the tree line holds its distance across the view.
      const segs = 48, half = widthDeg / 2 * Math.PI / 180;
      const geo = new THREE.PlaneGeometry(1, 1, segs, 1);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5;
        const a = -half + u * half * 2;
        p.setXYZ(i, Math.sin(a) * dist, lift + v * heightM, -Math.cos(a) * dist);
      }
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      return mesh;
    };
    // The far tree line: 160 degrees of it at 260 m.
    const treeDist = 260, treeW = 160, treeH = 22;
    const lenM = treeDist * treeW * Math.PI / 180;
    const px = Math.min(12, 16000 / lenM);
    const spires = make(maskTexture(spireLineCanvas(lenM, treeH, px)), v3(0.0, 0.0, 0.0), v3(0, 0, 0));
    arc(treeDist, treeW, treeH, null, spires, height(0, -treeDist) + 2.5);
    // Two ranges of low hills, 4 and 9 km off, their snow faintly moonlit.
    arc(4200, 170, 380, null, make(maskTexture(hillsCanvas(2.3)), v3(0.003, 0.004, 0.007), v3(0.006, 0.008, 0.014)), -60);
    arc(9000, 170, 700, null, make(maskTexture(hillsCanvas(8.9)), v3(0.006, 0.008, 0.014), v3(0.008, 0.011, 0.02)), -150);
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.group.children.forEach((c) => c.geometry.dispose());
  }
}
