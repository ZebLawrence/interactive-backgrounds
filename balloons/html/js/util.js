// Balloon Dawn — Math helpers, colours, procedural canvas images and the shader clock.

import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------------------------

export const TAU = Math.PI * 2;
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const coin = () => Math.random() < 0.5;
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
/** Roughly bell-shaped random in [-1, 1]. */
export const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export function unit(v) {
  const l = v.length();
  return l > 1e-5 ? v.clone().divideScalar(l) : v3();
}
export const quatAxis = (angle, x, y, z) => new THREE.Quaternion().setFromAxisAngle(v3(x, y, z), angle);

/** Deterministic hash noise in [0, 1) for a 2D point. */
export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in [0, 1]. */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

/** Fractal noise, `octaves` layers of noise2. */
export function fbm2(x, y, octaves = 4) {
  let v = 0, amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    v += noise2(x * f + i * 17.3, y * f + i * 9.1) * amp;
    sum += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / sum;
}

// ---------------------------------------------------------------------------------------------
// Colour: sRGB values that are easy to mix
// ---------------------------------------------------------------------------------------------

export class RGBA {
  constructor(r, g, b, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }
  alpha(x) { return new RGBA(this.r, this.g, this.b, x); }
  mix(o, t) { return new RGBA(lerp(this.r, o.r, t), lerp(this.g, o.g, t), lerp(this.b, o.b, t), lerp(this.a, o.a, t)); }
  get css() {
    const f = (x) => Math.round(clamp(x, 0, 1) * 255);
    return `rgba(${f(this.r)},${f(this.g)},${f(this.b)},${clamp(this.a, 0, 1)})`;
  }
  /** As a three.js colour (converted to the linear working space). */
  get color() { return new THREE.Color().setRGB(this.r, this.g, this.b, THREE.SRGBColorSpace); }
  /** As a linear-space vector, for shader uniforms. */
  get vec() { const c = this.color; return new THREE.Vector3(c.r, c.g, c.b); }
}

// ---------------------------------------------------------------------------------------------
// Procedural images drawn with Canvas 2D (origin top-left, y down)
// ---------------------------------------------------------------------------------------------

export const Art = {
  image(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    draw(ctx, w, h);
    return c;
  },

  texture(canvas, { repeat = false, srgb = true } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  },

  /** A soft radial blob, white fading to transparent, for mist and glows. */
  blob(size = 256, hardness = 0.0) {
    return Art.image(size, size, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25 + hardness * 0.5, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  },

  /** A thin vertical streak for rain, drawn on a square so it fits a point sprite. */
  streak(size = 128) {
    return Art.image(size, size, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(w * 0.46, 0, w * 0.08, h);
      ctx.filter = 'blur(1px)';
      ctx.fillRect(w * 0.46, 0, w * 0.08, h);
    });
  },

  /** Dark, mottled meadow soil and matted grass, tileable. */
  soil(size = 512) {
    return Art.image(size, size, (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // Tileable by sampling noise on a torus.
          const a = x / w * TAU, b = y / h * TAU;
          const nx = Math.cos(a) * 3, ny = Math.sin(a) * 3, nz = Math.cos(b) * 3, nw = Math.sin(b) * 3;
          const n = fbm2(nx + nz * 0.7, ny + nw * 0.7, 4);
          const m = fbm2(nx * 3.1 + nw, ny * 3.1 + nz, 3);
          const g = 0.35 + 0.65 * n;
          const i = (y * w + x) * 4;
          d[i] = (22 + 30 * g + 12 * m) | 0;
          d[i + 1] = (40 + 55 * g + 14 * m) | 0;
          d[i + 2] = (18 + 24 * g + 10 * m) | 0;
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    });
  },
};

// ---------------------------------------------------------------------------------------------
// The shader clock wraps hourly so float precision holds however long the page runs; every
// animation frequency is quantised to a whole number of cycles per wrap so the wrap is invisible.
// ---------------------------------------------------------------------------------------------

export const TIME_WRAP = 3600;
export const QK = TIME_WRAP / TAU;
export const quantize = (w) => Math.round(w * QK) / QK;
export const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const quantizer = (name) => `float ${name}(float w) { return floor(w * ${glslFloat(QK)} + 0.5) / ${glslFloat(QK)}; }\n`;

// ---------------------------------------------------------------------------------------------
// Extra helpers for the balloons
// ---------------------------------------------------------------------------------------------

/** A tileable fabric weave: fine crossed threads, for albedo modulation. */
Art.weave = function (size = 256, scale = 6) {
  return Art.image(size, size, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = Math.sin(x / scale * Math.PI) ** 2, b = Math.sin(y / scale * Math.PI) ** 2;
        const over = ((Math.floor(x / scale) + Math.floor(y / scale)) % 2) ? a : b;
        const v = 0.78 + 0.22 * over + (hash2(x, y) - 0.5) * 0.06;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
};

/** Pick a colour string from a palette by index, wrapping. */
export const cyc = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
