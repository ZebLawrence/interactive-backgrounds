// Trawler — The toolbox that needs three.js: colours, procedural canvas images and disposal. The
// pure maths, randomness, noise and the shader clock live in mathutil.js and are re-exported here,
// so a module can simply import from './util.js' and not think about it.

import * as THREE from 'three';
import { clamp } from './mathutil.js';

export * from './mathutil.js';

export const v2 = (x = 0, y = 0) => new THREE.Vector2(x, y);
export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

/** An sRGB triple as a linear-space THREE.Color (the renderer's working space). */
export const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
/** An sRGB triple as a linear vec3, for shader uniforms. */
export function srgbVec(r, g, b) {
  const c = srgb(r, g, b);
  return new THREE.Vector3(c.r, c.g, c.b);
}
/** #rrggbb as a linear vec3. */
export function hexVec(hex) {
  const c = new THREE.Color(hex);
  c.convertSRGBToLinear();
  return new THREE.Vector3(c.r, c.g, c.b);
}

/** Kelvin to a linear RGB vector, normalised to luminance 1 (Planckian locus, Tanner Helland fit). */
export function kelvinVec(k) {
  const t = clamp(k, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.52 * Math.log(t - 10) - 305.04;
  const c = new THREE.Color().setRGB(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255, THREE.SRGBColorSpace);
  const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return new THREE.Vector3(c.r / y, c.g / y, c.b / y);
}

// ---------------------------------------------------------------------------------------------
// Procedural images drawn with Canvas 2D (origin top-left, y down). Used for the things that are
// genuinely flat art — instrument faces, chart paper, dial scales — and for the detail tiles that
// are painted once at load (guidelines: paint big surfaces, don't composite them per pixel).
// ---------------------------------------------------------------------------------------------

export const Art = {
  image(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: false });
    ctx.imageSmoothingQuality = 'high';
    draw(ctx, w, h);
    return c;
  },

  texture(canvas, { repeat = false, srgb: isSrgb = true, aniso = 8 } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = isSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  },

  /** A soft radial blob, white fading to transparent: spray, mist, glows, point sprites. */
  blob(size = 128, hardness = 0) {
    return Art.image(size, size, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.22 + hardness * 0.55, 'rgba(255,255,255,0.6)');
      g.addColorStop(0.58, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  },
};

/** Fills a 1D lookup canvas (width x 1) from a function of t in [0, 1] returning [r, g, b] in 0..255. */
export function ramp(width, fn) {
  return Art.image(width, 1, (ctx, w) => {
    for (let i = 0; i < w; i++) {
      const [r, g, b] = fn(i / (w - 1));
      ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
      ctx.fillRect(i, 0, 1, 1);
    }
  });
}

/**
 * Disposes a three object tree's own geometries, materials and textures. Scenes are rebuilt on a
 * reseed, so every builder must be able to let go of its GPU memory.
 */
export function disposeTree(root) {
  if (!root) return;
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture && !v.userData?.shared) v.dispose();
      }
      m.dispose?.();
    }
  });
}
