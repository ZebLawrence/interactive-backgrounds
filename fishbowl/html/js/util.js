// Fishbowl — Math helpers, colours, procedural images and normal maps, the mesh builder and baked occlusion.

import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Math helpers (Math.swift)
// ---------------------------------------------------------------------------------------------

export const TAU = Math.PI * 2;
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
/** Random integer in lo...hi (inclusive, like Swift's `Int.random(in: lo...hi)`). */
export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const coin = () => Math.random() < 0.5;
export const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest signed difference between two angles. */
export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
/** Normalised copy, or zero for (near) zero vectors. */
export function unit(v) {
  const l = v.length();
  return l > 1e-5 ? v.clone().divideScalar(l) : v3();
}
export const quatAxis = (angle, x, y, z) => new THREE.Quaternion().setFromAxisAngle(v3(x, y, z), angle);
export const quatFromTo = (a, b) => new THREE.Quaternion().setFromUnitVectors(unit(a), unit(b));

// ---------------------------------------------------------------------------------------------
// Colour (Art.swift RGBA): sRGB values that are easy to mix
// ---------------------------------------------------------------------------------------------

export class RGBA {
  constructor(r, g, b, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }
  alpha(x) { return new RGBA(this.r, this.g, this.b, x); }
  mix(o, t) { return new RGBA(lerp(this.r, o.r, t), lerp(this.g, o.g, t), lerp(this.b, o.b, t), lerp(this.a, o.a, t)); }
  darker(t) { return this.mix(RGBA.black, t).alpha(this.a); }
  lighter(t) { return this.mix(RGBA.white, t).alpha(this.a); }
  get css() {
    const f = (x) => Math.round(clamp(x, 0, 1) * 255);
    return `rgba(${f(this.r)},${f(this.g)},${f(this.b)},${clamp(this.a, 0, 1)})`;
  }
  /** As a three.js colour (converted to the linear working space). */
  get color() { return new THREE.Color().setRGB(this.r, this.g, this.b, THREE.SRGBColorSpace); }
}
RGBA.white = new RGBA(1, 1, 1);
RGBA.black = new RGBA(0, 0, 0);
RGBA.clear = new RGBA(0, 0, 0, 0);

// ---------------------------------------------------------------------------------------------
// Procedural images (Art.swift). Drawing uses Core Graphics conventions: points, origin at the
// bottom-left, y up. Textures are uploaded with flipY = false so UVs match SceneKit's (v = 0 at
// the top of the image).
// ---------------------------------------------------------------------------------------------

export const Art = {
  /** Images are rendered at 4 pixels per point so fish stay crisp up close to the glass. */
  scale: 4,

  image(w, h, scale, draw) {
    const pw = Math.max(1, Math.ceil(w * scale));
    const ph = Math.max(1, Math.ceil(h * scale));
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, -scale, 0, ph);
    ctx.imageSmoothingQuality = 'high';
    draw(ctx);
    return c;
  },

  gradientStops(g, colors, locations) {
    colors.forEach((c, i) => g.addColorStop(locations ? locations[i] : i / (colors.length - 1), c.css));
    return g;
  },

  /** Fills the current clip with a linear gradient (extended past both ends). */
  linear(ctx, colors, locations, from, to) {
    ctx.fillStyle = Art.gradientStops(ctx.createLinearGradient(from[0], from[1], to[0], to[1]), colors, locations);
    ctx.fillRect(-1e4, -1e4, 2e4, 2e4);
  },

  /** A radial gradient, drawn only out to its radius (as Core Graphics does). */
  radial(ctx, colors, locations, center, radius) {
    ctx.fillStyle = Art.gradientStops(ctx.createRadialGradient(center[0], center[1], 0, center[0], center[1], radius),
      colors, locations);
    ctx.beginPath();
    ctx.arc(center[0], center[1], radius, 0, TAU);
    ctx.fill();
  },

  /** A 1-pixel-tall strip of flat colours. Meshes pick a colour with `paletteUV`. */
  palette(colors) {
    return Art.image(colors.length, 1, 1, (ctx) => {
      colors.forEach((c, i) => { ctx.fillStyle = c.css; ctx.fillRect(i, 0, 1, 1); });
    });
  },
  paletteUV: (index, count) => [(index + 0.5) / count, 0.5],

  texture(canvas, { srgb = true, repeat = false, mipmaps = true, premultiplied = false, nearest = false } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = mipmaps;
    t.minFilter = nearest ? THREE.NearestFilter : (mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter);
    t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.premultiplyAlpha = premultiplied;
    t.anisotropy = 4;
    return t;
  },
};

/** Vertical water gradient used for the image-based lighting. */
Art.waterGradient = (w, h) => Art.image(w, h, 1, (ctx) => {
  Art.linear(ctx, [new RGBA(0.012, 0.06, 0.11), new RGBA(0.03, 0.19, 0.27), new RGBA(0.05, 0.28, 0.37), new RGBA(0.14, 0.52, 0.62)],
    [0, 0.45, 0.62, 1], [0, 0], [0, h]);
});

/** Tileable-ish sand: mottled base with scattered grains. */
Art.sand = () => Art.image(512, 512, 1, (ctx) => {
  ctx.fillStyle = new RGBA(0.66, 0.58, 0.42).css;
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    const r = rnd(10, 60);
    const c = [rnd(0, 512), rnd(0, 512)];
    const tone = coin() ? new RGBA(0.80, 0.71, 0.53, 0.18) : new RGBA(0.45, 0.38, 0.27, 0.18);
    Art.radial(ctx, [tone, tone.alpha(0)], null, c, r);
  }
  const tones = [new RGBA(0.9, 0.84, 0.7), new RGBA(0.35, 0.3, 0.24), new RGBA(0.75, 0.62, 0.45), new RGBA(0.95, 0.95, 0.92)];
  for (let i = 0; i < 9000; i++) {
    const s = rnd(0.8, 2.4);
    ctx.fillStyle = pick(tones).alpha(rnd(0.25, 0.7)).css;
    ctx.beginPath();
    ctx.ellipse(rnd(0, 512) + s / 2, rnd(0, 512) + s / 2, s / 2, s / 2, 0, 0, TAU);
    ctx.fill();
  }
});

/** Soft vertical beam of light, brightest at the top. */
Art.lightShaft = () => Art.image(64, 256, 1, (ctx) => {
  Art.linear(ctx, [RGBA.clear, new RGBA(1, 1, 1, 1), RGBA.clear], [0, 0.5, 1], [0, 0], [64, 0]);
  ctx.globalCompositeOperation = 'destination-in';
  Art.linear(ctx, [RGBA.clear, new RGBA(1, 1, 1, 0.35), RGBA.white], [0, 0.45, 1], [0, 0], [0, 256]);
});

/** Ripple ring for the glass overlay. */
Art.ring = () => Art.image(128, 128, 2, (ctx) => {
  ctx.strokeStyle = new RGBA(0.85, 1, 1, 0.9).css;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(64, 64, 60, 60, 0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = new RGBA(0.85, 1, 1, 0.35).css;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(64, 64, 50, 50, 0, 0, TAU); ctx.stroke();
});

/** A soft vertical streak used to suggest light reflecting on the glass. */
Art.glassStreak = () => Art.image(64, 256, 2, (ctx) => {
  Art.linear(ctx, [RGBA.clear, new RGBA(1, 1, 1, 1), new RGBA(1, 1, 1, 0.6), RGBA.clear], [0, 0.35, 0.6, 1], [0, 0], [64, 0]);
  ctx.globalCompositeOperation = 'destination-in';
  Art.linear(ctx, [RGBA.clear, RGBA.white, RGBA.white, RGBA.clear], [0, 0.25, 0.75, 1], [0, 0], [0, 256]);
});

// ---------------------------------------------------------------------------------------------
// Procedural normal maps (Detail.swift), each generated once from a tileable height field
// ---------------------------------------------------------------------------------------------

export const Detail = {
  /** Tileable value noise: lattice values repeat every `period` cells across the 0...1 square. */
  noise(u, v, period, seed) {
    const x = u * period, y = v * period;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const lattice = (i, j) => {
      let h = Math.imul(((i % period) + period) % period, 374761393) >>> 0;
      h = (h + Math.imul(((j % period) + period) % period, 668265263) + Math.imul(seed, 2147483647)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(xi, yi), b = lattice(xi + 1, yi), c = lattice(xi, yi + 1), d = lattice(xi + 1, yi + 1);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  },

  /** Fractal (multi-octave) tileable noise in roughly 0...1. */
  fbm(u, v, period, octaves, seed) {
    let sum = 0, amp = 0.5, total = 0, p = period;
    for (let o = 0; o < octaves; o++) {
      sum += Detail.noise(u, v, p, seed + o) * amp;
      total += amp;
      amp *= 0.5;
      p *= 2;
    }
    return sum / total;
  },

  /** Encode the slopes of a tileable height field as a tangent-space normal map. */
  normalMap(n, strength, h) {
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = h(i / n, j / n);
    const bytes = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const l = heights[j * n + (i + n - 1) % n], r = heights[j * n + (i + 1) % n];
        const d = heights[((j + 1) % n) * n + i], u = heights[((j + n - 1) % n) * n + i];
        let x = (l - r) * strength, y = (d - u) * strength, z = 1;
        const len = Math.hypot(x, y, z);
        x /= len; y /= len; z /= len;
        const k = (j * n + i) * 4;
        bytes[k] = clamp((x * 0.5 + 0.5) * 255, 0, 255);
        bytes[k + 1] = clamp((y * 0.5 + 0.5) * 255, 0, 255);
        bytes[k + 2] = clamp((z * 0.5 + 0.5) * 255, 0, 255);
        bytes[k + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(bytes, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  },
};

export let _detailCache = {};
/** Sand: gentle ripple bars across the floor plus fine grain. Tiles every 2.5 world units. */
Detail.sand = () => _detailCache.sand ??= Detail.normalMap(512, 5, (u, v) => {
  const warp = Detail.fbm(u, v, 4, 3, 3);
  const phase = (v * 14 + warp * 1.6) * TAU;
  const ripple = Math.pow(0.5 + 0.5 * Math.sin(phase), 1.6) * 0.6;
  const grain = Detail.fbm(u, v, 64, 2, 11) * 0.35;
  return ripple + grain;
});

/** Rock and coral: pitted, porous bumps. Projected onto the reef from three directions. */
Detail.rock = () => _detailCache.rock ??= Detail.normalMap(256, 7, (u, v) => {
  const bumps = Detail.fbm(u, v, 6, 4, 5);
  const pores = 0.6 * Detail.fbm(u, v, 24, 2, 9) + 0.4 * Detail.fbm(u, v, 40, 1, 13);
  return bumps - 0.5 * smoothstep(0.6, 0.78, pores);
});

/** Fish scales: overlapping domes in offset columns (8 columns x 10 rows per tile). */
Detail.scales = () => _detailCache.scales ??= Detail.normalMap(256, 3, (u, v) => {
  const cols = 8, rows = 10;
  const x = u * cols, y = v * rows;
  let best = -1, height = 0;
  const ci = Math.floor(x);
  for (let dc = -1; dc <= 1; dc++) {
    const c = ci + dc;
    const offset = ((c % 2) + 2) % 2 === 0 ? 0 : 0.5;
    const ri = Math.floor(y - offset);
    for (let dr = -1; dr <= 1; dr++) {
      const cx = c + 0.5, cy = ri + dr + offset + 0.5;
      const d = Math.hypot(x - cx, (y - cy) * 0.8);
      if (d < 0.85 && cx > best) {
        best = cx;
        height = 1 - (d / 0.85) * (d / 0.85);
      }
    }
  }
  return height;
});

// ---------------------------------------------------------------------------------------------
// Minimal indexed triangle mesh (Mesh.swift)
// ---------------------------------------------------------------------------------------------

export class Mesh {
  constructor() {
    this.p = [];    // positions, flat xyz
    this.n = [];    // normals, flat xyz
    this.uv = [];   // flat uv
    this.uv2 = [];  // optional second uv set
    this.c = [];    // optional per-vertex data, flat xyzw
    this.idx = [];
  }

  get count() { return this.p.length / 3; }
  pos(i) { return v3(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]); }
  setPos(i, v) { this.p[i * 3] = v.x; this.p[i * 3 + 1] = v.y; this.p[i * 3 + 2] = v.z; }
  addPos(v) { this.p.push(v.x, v.y, v.z); }
  addUV(uv) { this.uv.push(uv[0], uv[1]); }
  triangle(a, b, c) { this.idx.push(a, b, c); }
  /** Two triangles for the quad a-b (bottom edge) / c-d (top edge). */
  quad(a, b, c, d) { this.triangle(a, b, c); this.triangle(b, d, c); }

  mapPositions(f) {
    for (let i = 0; i < this.count; i++) this.setPos(i, f(this.pos(i), i));
    return this;
  }
  scaled(k) {
    const m = this.clone();
    for (let i = 0; i < m.p.length; i++) m.p[i] *= k;
    return m;
  }
  clone() {
    const m = new Mesh();
    m.p = this.p.slice(); m.n = this.n.slice(); m.uv = this.uv.slice(); m.uv2 = this.uv2.slice();
    m.c = this.c.slice(); m.idx = this.idx.slice();
    return m;
  }

  /** Merge another mesh into this one, transforming its positions and normals by a Matrix4. */
  append(o, t = null) {
    const base = this.count;
    if (t) {
      const e = t.elements;
      for (let i = 0; i < o.p.length; i += 3) {
        const x = o.p[i], y = o.p[i + 1], z = o.p[i + 2];
        this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      for (let i = 0; i < o.n.length; i += 3) {
        const x = o.n[i], y = o.n[i + 1], z = o.n[i + 2];
        let nx = e[0] * x + e[4] * y + e[8] * z, ny = e[1] * x + e[5] * y + e[9] * z, nz = e[2] * x + e[6] * y + e[10] * z;
        const l = Math.hypot(nx, ny, nz) || 1;
        this.n.push(nx / l, ny / l, nz / l);
      }
    } else {
      for (const x of o.p) this.p.push(x);
      for (const x of o.n) this.n.push(x);
    }
    for (const x of o.uv) this.uv.push(x);
    for (const x of o.c) this.c.push(x);
    for (const i of o.idx) this.idx.push(i + base);
  }

  /** Smooth normals from the area-weighted face normals (counter-clockwise = front). */
  computeNormals() {
    const n = new Float32Array(this.p.length);
    const p = this.p, idx = this.idx;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      n[a] += fx; n[a + 1] += fy; n[a + 2] += fz;
      n[b] += fx; n[b + 1] += fy; n[b + 2] += fz;
      n[c] += fx; n[c + 1] += fy; n[c + 2] += fz;
    }
    this.n = new Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
      if (l > 1e-8) { this.n[i] = n[i] / l; this.n[i + 1] = n[i + 1] / l; this.n[i + 2] = n[i + 2] / l; }
      else { this.n[i] = 0; this.n[i + 1] = 1; this.n[i + 2] = 0; }
    }
  }

  /** `dataName` names the attribute the per-vertex data (`c`) goes to. */
  geometry(dataName = 'aData') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (this.n.length === this.p.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.uv2.length) g.setAttribute('aUV2', new THREE.Float32BufferAttribute(this.uv2, 2));
    if (this.c.length) g.setAttribute(dataName, new THREE.Float32BufferAttribute(this.c, 4));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** Unit icosphere (radius 1) with the given number of subdivisions. */
  static icosphere(subdivisions) {
    const t = (1 + Math.sqrt(5)) / 2;
    const p = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(([x, y, z]) => v3(x, y, z).normalize());
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < subdivisions; s++) {
      const cache = new Map();
      const mid = (a, b) => {
        const key = Math.min(a, b) * 100000 + Math.max(a, b);
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        p.push(p[a].clone().add(p[b]).multiplyScalar(0.5).normalize());
        cache.set(key, p.length - 1);
        return p.length - 1;
      };
      const next = [];
      for (const [a, b, c] of faces) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      faces = next;
    }
    const m = new Mesh();
    for (const v of p) m.addPos(v);
    for (const [a, b, c] of faces) m.triangle(a, b, c);
    m.computeNormals();
    return m;
  }
}

export const mat4Translate = (v) => new THREE.Matrix4().makeTranslation(v.x, v.y, v.z);
export const mat4Rotate = (q) => new THREE.Matrix4().makeRotationFromQuaternion(q);

// ---------------------------------------------------------------------------------------------
// Baked contact shadows (Occlusion.swift). Scenery never moves, so this is computed once.
// ---------------------------------------------------------------------------------------------

export const Occlusion = {
  /** How much light reaches point `p` (normal `n`): 1 = fully open, lower = tucked in. */
  visibility(px, py, pz, nx, ny, nz, occluders, ignoring, strength) {
    let vis = 1;
    for (const o of occluders) {
      if (o.piece === ignoring) continue;
      const dx = o.cx - px, dy = o.cy - py, dz = o.cz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r2 = o.radius * o.radius;
      if (d2 > r2 * 16) continue;
      const dist = Math.sqrt(d2);
      const inv = 1 / Math.max(dist, 1e-4);
      const facing = 0.35 + 0.65 * Math.max(0, (nx * dx + ny * dy + nz * dz) * inv);
      const occ = Math.min(1, r2 / Math.max(d2, r2 * 0.25)) * facing;
      vis *= 1 - Math.min(0.85, occ * strength);
    }
    return vis;
  },

  /** A linear grey map covering the floor rectangle (row 0 = near), darkened around every
   *  occluder's footprint. */
  floorMap(minX, maxX, nearZ, farZ, width, floor, occluders) {
    const height = Math.max(1, Math.floor(width * Math.abs(farZ - nearZ) / (maxX - minX)));
    const vis = new Float32Array(width * height).fill(1);
    const du = (maxX - minX) / width, dv = (farZ - nearZ) / height;
    for (const o of occluders) {
      const reach = o.radius * 4;
      const i0 = Math.max(0, Math.floor((o.cx - reach - minX) / du)), i1 = Math.min(width - 1, Math.floor((o.cx + reach - minX) / du));
      const jA = Math.trunc((o.cz - reach - nearZ) / dv), jB = Math.trunc((o.cz + reach - nearZ) / dv);
      const j0 = Math.max(0, Math.min(jA, jB)), j1 = Math.min(height - 1, Math.max(jA, jB));
      if (i0 > i1 || j0 > j1) continue;
      const single = [o];
      for (let j = j0; j <= j1; j++) {
        const z = nearZ + (j + 0.5) * dv;
        for (let i = i0; i <= i1; i++) {
          const x = minX + (i + 0.5) * du;
          vis[j * width + i] *= Occlusion.visibility(x, floor(x, z), z, 0, 1, 0, single, -99, 1.3);
        }
      }
    }
    const bytes = new Uint8Array(width * height);
    for (let i = 0; i < bytes.length; i++) bytes[i] = clamp(vis[i], 0, 1) * 255;
    const t = new THREE.DataTexture(bytes, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    t.unpackAlignment = 1;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  },
};

export const occluder = (center, radius, piece) => ({ cx: center.x, cy: center.y, cz: center.z, radius, piece });

/** Geometry shared by every tank (the per-species fish models), which a tank must not dispose. */
export const sharedGeometry = new WeakSet();
