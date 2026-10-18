// Aspen Snow — The snow: a soft, rolling snowpack that keeps the prints of hares, the grouse's
// roost and burst, and the pits of fallen snow, and slowly fills them in; the baked shadows of
// the far trunks and the contact shade round every trunk base; the dead grass, suckers and
// fallen wood that poke through it; and the far grove wall where the trunks fade into the haze.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, fbm2, noise2, v3, Art, seeded } from './util.js';
import { G, NOISE_GLSL, patchMaterial } from './shaders.js';

// The print map covers the ground where the animals live: 64 m square, 3.1 cm a texel.
export const PRINTS = { x0: -32, z0: -58, size: 64, res: 2048 };
const PRINT_ZERO = 200;          // the byte value of undisturbed snow
const PRINT_SCALE = 400;         // bytes per metre of depth

/**
 * The snow's surface height (m) at (x, z), before any prints. `wells`: [{x, z, r, depth}] round
 * the trunks; `lumps`: [{x, z, r, h}] buried shrubs and logs, and `capsules`: [{x, z, dx, dz, L, r, h}]
 * banked snow along fallen trunks.
 */
export function makeHeight(wells, lumps, capsules) {
  const grid = new Map();
  const key = (i, j) => i * 10007 + j;
  const put = (o, r) => {
    for (let i = Math.floor((o.x - r) / 10); i <= Math.floor((o.x + r) / 10); i++) {
      for (let j = Math.floor((o.z - r) / 10); j <= Math.floor((o.z + r) / 10); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(o);
      }
    }
  };
  for (const w of wells) put({ kind: 0, ...w }, w.r * 1.6);
  for (const l of lumps) put({ kind: 1, ...l }, l.r * 1.4);
  for (const c of capsules) put({ kind: 2, ...c }, c.L + c.r * 2);
  return (x, z) => {
    // Gentle swells of drifted snow over the grove floor, and a lumpier scale of hummocks.
    let h = (fbm2(x / 26 + 3.1, z / 26 + 7.7, 4) - 0.5) * 0.9;
    h += (fbm2(x / 7 + 11, z / 7 + 5, 3) - 0.5) * 0.28;
    const hum = noise2(x / 2.6 + 40, z / 2.6 + 13);
    h += smoothstep(0.6, 0.95, hum) * 0.1;
    // The land rises a little far off, so the grove floor doesn't read as a plane.
    const d = Math.hypot(x, z + 40);
    h += smoothstep(90, 300, d) * 3 * (0.6 + 0.4 * noise2(x / 50, z / 50));
    const i0 = Math.floor(x / 10), j0 = Math.floor(z / 10);
    const list = grid.get(key(i0, j0));
    if (list) {
      for (const o of list) {
        if (o.kind === 0) {
          // Round a trunk the snow is a little lower (the trunk's warmth and the crown above),
          // with a small collar banked right against the bark.
          const r = Math.hypot(x - o.x, z - o.z) / o.r;
          if (r < 1.6) h -= o.depth * Math.exp(-r * r * 2.0) * smoothstep(0.1, 0.5, r);
          if (r < 0.6) h += o.depth * 0.8 * (1 - smoothstep(0.15, 0.6, r));
        } else if (o.kind === 1) {
          const r = Math.hypot(x - o.x, z - o.z) / o.r;
          if (r < 1.3) h += o.h * Math.exp(-r * r * 2.6);
        } else {
          // Snow banked along a fallen trunk.
          const px = x - o.x, pz = z - o.z;
          const along = clamp(px * o.dx + pz * o.dz, 0, o.L);
          const dist = Math.hypot(px - o.dx * along, pz - o.dz * along) / o.r;
          if (dist < 2.5) h += o.h * Math.exp(-dist * dist * 0.8);
        }
      }
    }
    return h;
  };
}

/**
 * The same height function sampled once onto a 20 cm grid over the near ground, for the many
 * cheap lookups (every snowflake, every frame); the exact function beyond it.
 */
export function cacheHeight(height, x0 = -45, z0 = -75, w = 90, d = 85, step = 0.2) {
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

/** A grid denser in front of the viewer and coarse toward the horizon. */
function snowGeometry(height, n, extent) {
  const cz = -12;
  const warp = (t) => Math.sign(t) * extent * Math.pow(Math.abs(t), 2.2);
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
// Baked maps. R: the sun's shadows of every trunk the shadow map can't reach (a run of discs
// along the ground away from the sun, one per slice of the trunk and the crown). G: contact
// shade, the ambient light cut off round the foot of every trunk and under every log.
// ---------------------------------------------------------------------------------------------

export const CANOPY = { x0: -200, z0: -240, w: 400, d: 260, px: 2 };
// The contact map is finer (12 cm a texel) and covers only the near ground.
export const CONTACT = { x0: -48, z0: -84, w: 96, d: 90, px: 8 };

/** `casters`: [{x, z, height, crownBase, maxR, baseR}]. */
export function bakeCanopy(casters, sunDir) {
  const { x0, z0, w, d, px } = CANOPY;
  const nx = Math.round(w * px), nz = Math.round(d * px);
  const acc = new Float32Array(nx * nz);
  const flat = Math.hypot(sunDir.x, sunDir.z);
  const sx = -sunDir.x / flat, sz = -sunDir.z / flat;
  const run = flat / sunDir.y;            // metres of shadow per metre of height
  const disc = (buf, cx, cz, r, k, soft = 0.55) => {
    const i0 = Math.max(0, Math.floor((cx - r - x0) * px)), i1 = Math.min(nx - 1, Math.ceil((cx + r - x0) * px));
    const j0 = Math.max(0, Math.floor((cz - r - z0) * px)), j1 = Math.min(nz - 1, Math.ceil((cz + r - z0) * px));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) / px - cx, dz = z0 + (j + 0.5) / px - cz;
        const v = k * smoothstep(r, r * soft, Math.hypot(dx, dz));
        const q = j * nx + i;
        if (v > buf[q]) buf[q] = v;
      }
    }
  };
  for (const t of casters) {
    for (let y = 0.3; y < t.height; y += 0.6) {
      const f = (y - t.crownBase) / Math.max(0.1, t.height - t.crownBase);
      const r = f < 0 ? t.baseR * (1 - y / t.height * 0.6) + 0.3 : t.maxR * Math.sin(Math.PI * Math.min(1, f)) * 0.5 + 0.3;
      disc(acc, t.x + sx * y * run, t.z + sz * y * run, r, f < 0 ? 0.8 : 0.35);
    }
  }
  // A light blur for the penumbra.
  const out = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let aa = -1; aa <= 1; aa++) {
        const ii = i + aa, jj = j + b;
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

/**
 * Contact shade: the sky's light cut off where something stands on the snow, darkest right at
 * the foot and fading out over a radius or two. `contacts`: [{x, z, r, k}] discs, or
 * [{x, z, dx, dz, L, r, k}] for something lying along the ground.
 */
export function bakeContact(contacts) {
  const { x0, z0, w, d, px } = CONTACT;
  const nx = Math.round(w * px), nz = Math.round(d * px);
  const acc = new Float32Array(nx * nz);
  const spot = (cx, cz, r, k) => {
    const reach = r * 2.2;
    const i0 = Math.max(0, Math.floor((cx - reach - x0) * px)), i1 = Math.min(nx - 1, Math.ceil((cx + reach - x0) * px));
    const j0 = Math.max(0, Math.floor((cz - reach - z0) * px)), j1 = Math.min(nz - 1, Math.ceil((cz + reach - z0) * px));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) / px - cx, dz = z0 + (j + 0.5) / px - cz;
        const u = Math.hypot(dx, dz) / r;
        const v = k * Math.exp(-u * u * 1.6);
        const q = j * nx + i;
        acc[q] = 1 - (1 - acc[q]) * (1 - v);
      }
    }
  };
  for (const c of contacts) {
    if (c.L) { for (let s = 0; s <= c.L; s += c.r * 0.5) spot(c.x + c.dx * s, c.z + c.dz * s, c.r, c.k); }
    else spot(c.x, c.z, c.r, c.k);
  }
  const out = new Uint8Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) out[i] = Math.round(Math.min(1, acc[i]) * 255);
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
    this.contactUniform = { value: null };
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xf4f6fb, roughness: 0.8, metalness: 0 }), {
      key: 'snowpack',
      uniforms: {
        uPrints: { value: this.printTex },
        uPrintRect: { value: new THREE.Vector4(PRINTS.x0, PRINTS.z0, PRINTS.size, 1 / res) },
        uKeyDir: G.uKeyDir, uSun: G.uSun, uNight: G.uNight, uTime: G.uTime, uSkyLight: G.uSkyLight,
        uCanopy: this.canopyUniform,
        uCanopyRect: { value: new THREE.Vector4(CANOPY.x0, CANOPY.z0, CANOPY.w, CANOPY.d) },
        uContact: this.contactUniform,
        uContactRect: { value: new THREE.Vector4(CONTACT.x0, CONTACT.z0, CONTACT.w, CONTACT.d) },
      },
      fHead: `
        uniform sampler2D uPrints, uCanopy, uContact; uniform vec4 uPrintRect, uCanopyRect, uContactRect; uniform vec3 uKeyDir, uSkyLight; uniform float uSun, uNight, uTime;
        ${NOISE_GLSL}
        float printH(vec2 p) {
          vec2 uv = (p - uPrintRect.xy) / uPrintRect.z;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
          return (texture2D(uPrints, uv).r * 255.0 - ${PRINT_ZERO}.0) / ${PRINT_SCALE}.0;
        }
        // The fine texture of settled snow: soft lumps where flakes piled, and a few wind ripples.
        float grain(vec2 p) {
          float r = fbm(p * 2.2) * 0.02 + vnoise(p * 9.0) * 0.006 + vnoise(p * 40.0) * 0.0015;
          vec2 q = vec2(p.x * 0.8 + p.y * 0.6, -p.x * 0.6 + p.y * 0.8);
          float rip = sin(q.x * 7.0 + fbm(q * 0.3) * 5.0) * 0.5 + 0.5;
          return r + rip * rip * smoothstep(0.45, 0.75, fbm(q * 0.1 + 4.0)) * 0.006;
        }`,
      fNormal: `
        {
          vec2 p = vWPos.xz;
          float e = uPrintRect.z * uPrintRect.w;
          float h0 = printH(p);
          float hx = printH(p + vec2(e, 0.0)) - printH(p - vec2(e, 0.0));
          float hz = printH(p + vec2(0.0, e)) - printH(p - vec2(0.0, e));
          float gx = grain(p + vec2(0.02, 0.0)) - grain(p - vec2(0.02, 0.0));
          float gz = grain(p + vec2(0.0, 0.02)) - grain(p - vec2(0.0, 0.02));
          // Fade the fine grain out with distance so it doesn't shimmer.
          float fine = 1.0 - smoothstep(14.0, 50.0, length(vWPos - cameraPosition));
          vec3 g = vec3(hx / (2.0 * e) + gx / 0.04 * fine, 0.0, hz / (2.0 * e) + gz / 0.04 * fine);
          vec3 nW = normalize(vec3(-g.x, 1.0, -g.z));
          vec3 tilt = (viewMatrix * vec4(nW - vec3(0.0, 1.0, 0.0), 0.0)).xyz;
          normal = normalize(normal + tilt);
          float slope = length(vec2(hx, hz)) / (2.0 * e);
          snowCavity = clamp(-h0 * 9.0 + slope * 0.35, 0.0, 0.6);
        }`,
      fColor: `
        float snowCavity = 0.0;`,
      fEmissive: `
        {
          // Glitter: each centimetre of the surface holds a crystal facet tilted its own way; when
          // one happens to mirror the sun (or the moon) into the eye it flashes.
          vec3 V = normalize(cameraPosition - vWPos);
          vec2 cellP = vWPos.xz / 0.012;
          vec2 cell = floor(cellP);
          vec2 f = fract(cellP) - 0.5;
          vec2 r = hash22(cell);
          float r3 = hash21(cell + 7.3);
          vec3 facet = normalize(vec3((r.x - 0.5) * 2.4, 1.0, (r.y - 0.5) * 2.4));
          vec3 H = normalize(uKeyDir + V);
          float spec = pow(max(dot(facet, H), 0.0), 500.0);
          float dotMask = smoothstep(0.3, 0.08, length(f)) * step(0.9, r3);
          float px = length(fwidth(cellP));
          float resolve = 1.0 / (1.0 + px * px * 4.0);
          float key = mix(uSun * 1.0, uSun * 0.5, uNight);
          float glint = spec * dotMask * resolve * key * 2.0;
          totalEmissiveRadiance += vec3(1.0, 0.98, 0.95) * glint;
        }`,
      fBeforeOpaque: `
        // Shaded snow in a print looks blue.
        outgoingLight *= mix(vec3(1.0), vec3(0.58, 0.66, 0.84), snowCavity);
        {
          vec2 cuv = (vWPos.xz - uCanopyRect.xy) / uCanopyRect.zw;
          float baked = (cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) ? texture2D(uCanopy, cuv).r : 0.0;
          // The sun's shadows of the trunks the shadow map can't reach.
          outgoingLight *= 1.0 - baked * 0.55 * uSun * (1.0 - uNight);
          // Contact shade round the trunks, the suckers, the grass and under the fallen wood: the
          // sky's light is cut off there, so it is bluer as well as darker.
          vec2 kuv = (vWPos.xz - uContactRect.xy) / uContactRect.zw;
          float contact = (kuv.x > 0.0 && kuv.y > 0.0 && kuv.x < 1.0 && kuv.y < 1.0) ? texture2D(uContact, kuv).r : 0.0;
          outgoingLight *= mix(vec3(1.0), vec3(0.3, 0.35, 0.47), contact);
          // Far off, the snow is seen between trunks and under crowns: it greys down a touch.
          float far = length(vWPos - cameraPosition);
          outgoingLight *= 1.0 - 0.12 * smoothstep(40.0, 150.0, far);
        }`,
    });
    this.mesh = new THREE.Mesh(snowGeometry(height, 720, 300), this.material);
    this.mesh.receiveShadow = true;
  }

  /** Height of the undisturbed snow at (x, z). */
  heightAt(x, z) { return this.height(x, z); }

  inMap(x, z) {
    return x > PRINTS.x0 + 1 && x < PRINTS.x0 + PRINTS.size - 1 && z > PRINTS.z0 + 1 && z < PRINTS.z0 + PRINTS.size - 1;
  }

  /** Apply `depthAt(dx, dz)` (metres, negative down) over a square of half-size `reach` round (x, z). */
  stamp(x, z, reach, depthAt) {
    const { x0, z0, size, res } = PRINTS;
    const texel = size / res;
    const ci = (x - x0) / texel, cj = (z - z0) / texel;
    const r = Math.ceil(reach / texel);
    for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(res - 1, Math.ceil(cj + r)); j++) {
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(res - 1, Math.ceil(ci + r)); i++) {
        const h = depthAt((i - ci) * texel, (j - cj) * texel);
        if (h === 0) continue;
        const k = j * res + i;
        this.prints[k] = clamp(Math.round(this.prints[k] + h * PRINT_SCALE), 0, 255);
      }
    }
    this.extend(ci - r, cj - r, ci + r, cj + r);
    this.printTex.needsUpdate = true;
  }

  /**
   * A hare's landing: the classic set of four, the two long hind feet side by side ahead of the
   * two small fore feet, one behind the other. `heading` is the direction of travel, radians
   * from +x toward +z; `scale` the hare's size.
   */
  stampHare(x, z, heading, scale = 1) {
    const fx = Math.cos(heading), fz = Math.sin(heading), sx = -fz, sz = fx;
    const feet = [
      { f: 0.12, s: 0.085, l: 0.15, w: 0.075, d: 0.07 }, { f: 0.12, s: -0.085, l: 0.15, w: 0.075, d: 0.07 },
      { f: -0.12, s: 0.02, l: 0.06, w: 0.045, d: 0.05 }, { f: -0.25, s: -0.03, l: 0.06, w: 0.045, d: 0.05 },
    ];
    this.stamp(x, z, 0.45 * scale, (dx, dz) => {
      const f = (dx * fx + dz * fz) / scale, s = (dx * sx + dz * sz) / scale;
      let h = 0;
      for (const ft of feet) {
        const u = (f - ft.f) / ft.l, v = (s - ft.s) / ft.w;
        const r = Math.sqrt(u * u + v * v);
        // A flat-floored print with steep walls, and a rim of pushed-up snow round it.
        if (r < 1) h -= ft.d * (1 - smoothstep(0.55, 1, r));
        else if (r < 1.5) h += 0.012 * (1 - (r - 1) / 0.5) * (ft.l > 0.1 ? 1 : 0.6);
        // More thrown up behind the hind feet, where they pushed off.
        if (u < -0.9 && u > -1.8 && Math.abs(v) < 1.4 && ft.l > 0.1) h += 0.012 * (1 - Math.abs(v) / 1.4);
      }
      return h;
    });
  }

  /** The grouse bursting out: a ragged crater where it lay, the snow thrown back round it. */
  stampBurst(x, z, heading) {
    const fx = Math.cos(heading), fz = Math.sin(heading);
    this.stamp(x, z, 0.75, (dx, dz) => {
      const d = Math.hypot(dx, dz);
      const ragged = 0.22 + 0.06 * Math.sin(Math.atan2(dz, dx) * 5 + x) + 0.03 * Math.sin(Math.atan2(dz, dx) * 9 + z);
      let h = 0;
      const r = d / ragged;
      if (r < 1) h -= 0.2 * (1 - r * r);
      // The rim and the spray thrown out, mostly behind the direction it left.
      const back = -(dx * fx + dz * fz) / Math.max(d, 1e-3);
      const rim = Math.exp(-(((r - 1.25) / 0.3) ** 2));
      h += rim * (0.03 + 0.03 * Math.max(back, 0));
      return h;
    });
  }

  /** Where the grouse dived in: a small hole with a short tunnel, soon drifted over. */
  stampRoost(x, z, heading) {
    const fx = Math.cos(heading), fz = Math.sin(heading);
    this.stamp(x, z, 0.5, (dx, dz) => {
      const f = dx * fx + dz * fz, s = -dx * fz + dz * fx;
      const hole = Math.hypot(f / 0.1, s / 0.09);
      let h = hole < 1 ? -0.12 * (1 - hole * hole) : 0;
      if (f > 0 && f < 0.4 && Math.abs(s) < 0.08) h -= 0.03 * (1 - f / 0.4);
      return h;
    });
  }

  /** A clump of snow fallen from a tree: a small dent with the clump's own lump in it. */
  stampClump(x, z, size) {
    this.stamp(x, z, size * 2, (dx, dz) => {
      const r = Math.hypot(dx, dz) / size;
      if (r > 1.6) return 0;
      return -0.03 * Math.exp(-r * r * 1.5) + 0.02 * Math.exp(-r * r * 6);
    });
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

  setContact(tex) {
    this.contactTex?.dispose();
    this.contactTex = tex;
    this.contactUniform.value = tex;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.printTex.dispose(); this.canopyTex?.dispose(); this.contactTex?.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Dead grass and shrub stems poking through the snow: tufts of thin tan blades, instanced.
// ---------------------------------------------------------------------------------------------

export class Tufts {
  /** `tufts`: [{x, y, z, rot, scale}] */
  constructor(tufts, rng) {
    const R = (lo, hi) => lo + rng() * (hi - lo);
    const pos = [], col = [], idx = [], ph = [];
    const blades = 9;
    for (let b = 0; b < blades; b++) {
      const a = R(0, TAU), lean = R(0.15, 0.7), L = R(0.14, 0.42), w = R(0.004, 0.009);
      const dx = Math.cos(a) * Math.sin(lean), dz = Math.sin(a) * Math.sin(lean), dy = Math.cos(lean);
      const bend = R(0.1, 0.5);
      const shade = R(0.6, 1.0);
      const c = [0.42 * shade, 0.31 * shade, 0.15 * shade];
      if (rng() < 0.3) { c[0] = 0.2 * shade; c[1] = 0.16 * shade; c[2] = 0.1 * shade; }   // darker woody stems
      const base = pos.length / 3;
      const segs = 3;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const px = dx * t * L + dx * bend * t * t * L * 0.5, pz = dz * t * L + dz * bend * t * t * L * 0.5, py = dy * t * L - bend * t * t * L * 0.4 - 0.05;
        const sx = -Math.sin(a) * w * (1 - t), sz = Math.cos(a) * w * (1 - t);
        pos.push(px - sx, py, pz - sz, px + sx, py, pz + sz);
        col.push(...c, ...c);
        ph.push(t, t);
      }
      for (let s = 0; s < segs; s++) {
        const k = base + s * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setAttribute('aPh', new THREE.BufferAttribute(new Float32Array(ph), 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), {
      key: 'tufts',
      uniforms: { uTime: G.uTime, uWind: G.uWind },
      vHead: `attribute float aPh; uniform float uTime; uniform vec2 uWind;`,
      vMain: `
        // Stems nod in the wind, most at the tips.
        float w = length(uWind) * 0.03 + 0.01;
        float ph = uTime * 1.7 + gPos.x * 3.0 + gPos.z * 2.0;
        gPos.xz += vec2(sin(ph), cos(ph * 1.3)) * w * aPh * aPh;`,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, tufts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    tufts.forEach((t, i) => {
      q.setFromAxisAngle(v3(0, 1, 0), t.rot);
      m.compose(v3(t.x, t.y, t.z), q, v3(t.scale, t.scale, t.scale));
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The far grove wall: pale trunks drawn in metres on a canvas, standing where the real trees end
// and the haze takes over, so the grove never shows a back edge.
// ---------------------------------------------------------------------------------------------

function maskTexture(canvas) {
  const w = canvas.width, h = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h * 2);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) {
      mask[(dst + x) * 2] = rgba[(src + x) * 4];        // brightness
      mask[(dst + x) * 2 + 1] = rgba[(src + x) * 4 + 3]; // coverage
    }
  }
  const tex = new THREE.DataTexture(mask, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function groveWallCanvas(widthM, heightM, px, rng) {
  const w = Math.round(widthM * px), h = Math.round(heightM * px);
  const R = (lo, hi) => lo + rng() * (hi - lo);
  return Art.image(w, h, (ctx) => {
    ctx.setTransform(px, 0, 0, px, 0, 0);
    const W = widthM, H = heightM;
    // Trunks: pale, with darker bases and black eyes; crowns: a grey mist of twigs.
    for (let x = -1; x < W + 1; x += R(0.9, 2.6)) {
      const base = H - R(0.2, 1.2), top = R(0.5, 4), r = R(0.08, 0.2);
      const lean = R(-0.03, 0.03);
      const g = ctx.createLinearGradient(0, base, 0, top);
      const v = R(170, 215);
      g.addColorStop(0, `rgb(${v * 0.35},${v * 0.35},${v * 0.35})`);
      g.addColorStop(0.1, `rgb(${v},${v},${v * 0.96})`);
      g.addColorStop(1, `rgb(${v * 0.85},${v * 0.85},${v * 0.82})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - r, base);
      ctx.lineTo(x + r, base);
      ctx.lineTo(x + lean * (base - top) + r * 0.35, top);
      ctx.lineTo(x + lean * (base - top) - r * 0.35, top);
      ctx.fill();
      ctx.fillStyle = 'rgb(40,38,34)';
      for (let y = base - 2; y > top + 4; y -= R(0.8, 2.5)) {
        if (rng() < 0.5) continue;
        const cx = x + lean * (base - y);
        ctx.beginPath();
        ctx.ellipse(cx + R(-r, r) * 0.5, y, R(0.06, 0.12), R(0.03, 0.05), 0, 0, TAU);
        ctx.fill();
      }
      // The crown: a few rising strokes.
      ctx.strokeStyle = 'rgba(90,86,80,0.7)';
      for (let k = 0; k < 5; k++) {
        const y0 = top + R(2, 9), cx = x + lean * (base - y0);
        const dir = R(-1, 1);
        ctx.lineWidth = R(0.04, 0.09);
        ctx.beginPath();
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx + dir * R(1.5, 3), y0 - R(2.5, 5));
        ctx.stroke();
      }
    }
    // The twig mist over everything, denser in the upper part.
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const my = y / h;
      const mist = smoothstep(0.75, 0.15, my) * 0.55;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = fbm2(x / px / 2.5, y / px / 2.5, 3);
        const a = mist * smoothstep(0.35, 0.75, n) * 255;
        if (a > d[i + 3]) { d[i] = d[i + 1] = d[i + 2] = 120; d[i + 3] = a; }
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

export class Horizon {
  constructor(height, rng) {
    this.group = new THREE.Group();
    const dist = 125, widthDeg = 170, heightM = 26;
    const lenM = dist * widthDeg * Math.PI / 180;
    const px = Math.min(10, 14000 / lenM);
    this.texture = maskTexture(groveWallCanvas(lenM, heightM, px, rng));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uFogColor: G.uFogColor, uSkyLight: G.uSkyLight, uNight: G.uNight },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform vec3 uFogColor, uSkyLight; uniform float uNight;
        varying vec2 vUv;
        void main() {
          vec2 m = texture2D(uMap, vUv).rg;
          if (m.g < 0.4) discard;
          vec3 bark = vec3(0.6, 0.6, 0.52) * m.r * 1.5 * uSkyLight;
          // Mostly haze by here.
          vec3 c = mix(bark, uFogColor, 0.78);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const segs = 64, half = widthDeg / 2 * Math.PI / 180;
    const geo = new THREE.PlaneGeometry(1, 1, segs, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5;
      const a = -half + u * half * 2;
      const x = Math.sin(a) * dist, z = -Math.cos(a) * dist;
      p.setXYZ(i, x, height(x, z) - 1 + v * heightM, z);
    }
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.group.add(this.mesh);
  }

  dispose() { this.texture.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}
