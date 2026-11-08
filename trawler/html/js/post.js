// Trawler — Post stack at native resolution: the scene into a half-float 4x MSAA target, a NaN
// guard, bloom for the sun's glare on the water and the instrument lights, then ACES tone mapping.
// No upscaling and no temporal anti-aliasing: sharpness first, and the frame-rate governor in
// app.js gives way instead (guidelines section 7).
//
//   scene ─► beauty (MSAA, half float) ─► guard (zeroes non-finite pixels) ─► bloom ─► output ─► canvas
//
// MSAA matters here more than in a room: a sea horizon, railings, mast stays and window mullions
// are exactly the thin near-horizontal edges that crawl without it, and it is cheap at ~2 MP.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const POST = {
  msaa: 4,
  // The sun's glitter path on water is the brightest thing in the scene by a long way; a tight,
  // fairly strong bloom round it is what a camera (and an eye) actually does with it.
  bloom: { strength: 0.30, radius: 0.34, threshold: 1.45 },
  bloomNight: { strength: 0.75, radius: 0.5, threshold: 0.35 },
};

/**
 * The bloom's guard rail. Two jobs, and the scene needs both.
 *
 * **Non-finite pixels.** A NaN or an infinity anywhere in the frame is spread over it by the
 * bloom's blur and then turned black by tone mapping.
 *
 * **Pixels that are merely absurd.** This is the one that bit. A bloom pass is a blur over a
 * mip chain: feed it a single texel a hundred thousand times brighter than white and the coarse
 * levels turn that one texel into a tile, and the tile comes out of the blur as a hard-edged
 * coloured square sitting on the horizon. At dawn and dusk the sea was handing it exactly that -
 * two pixels at fourteen thousand against a white of 0.09 - and the frame grew 66-pixel squares.
 *
 * So the guard also ceilings the radiance at a multiple of the camera's own white point. The
 * multiple has to clear the bloom's own threshold, which runs from 1.45 by day down to 0.35 at
 * night, or nothing would glow at all; and it has to stay low enough that one clamped pixel cannot
 * fill a bloom tile. Sixteen times white sits between the two: the sun's disc, its glitter path
 * and a lamp close aboard all still bloom, and the horizon's pathological texels come out as a
 * bright dot rather than a square. Clamping rather than zeroing is deliberate - a real highlight
 * stays a highlight, it just stops being a bomb.
 */
const GuardShader = {
  uniforms: { tDiffuse: { value: null }, uCeiling: { value: 16 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uCeiling;
    varying vec2 vUv;
    vec3 finiteOrZero( vec3 c ) {
      // A NaN fails every comparison, so this catches NaN and both infinities in one test, with
      // no bit tricks and no isnan() for a driver to compile away under fast math.
      bvec3 ok = lessThanEqual( abs( c ), vec3( 3.0e38 ) );
      return vec3( ok.x ? c.x : 0.0, ok.y ? c.y : 0.0, ok.z ? c.z : 0.0 );
    }
    void main() {
      vec3 c = finiteOrZero( texture2D( tDiffuse, vUv ).rgb );
      // Ceiling the brightest channel and keep the hue: scaling all three together means a clamped
      // highlight stays the colour it was instead of sliding toward white a channel at a time.
      float m = max( c.r, max( c.g, c.b ) );
      c *= m > uCeiling ? uCeiling / m : 1.0;
      gl_FragColor = vec4( max( c, vec3( 0.0 ) ), 1.0 );
    }
  `,
};

export function buildPost(renderer, scene, camera, w, h, pixelRatio, lowPower) {
  const size = new THREE.Vector2(Math.max(1, Math.round(w * pixelRatio)), Math.max(1, Math.round(h * pixelRatio)));
  // The composer owns the target's size from here: setPixelRatio + setSize resize it and every pass.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    samples: POST.msaa, // kept in Low Power: without it every railing and mullion stair-steps
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    stencilBuffer: false,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);

  const renderPass = new RenderPass(scene, camera);
  const guard = new ShaderPass(GuardShader);
  const bloom = new UnrealBloomPass(size.clone(), POST.bloom.strength, POST.bloom.radius, POST.bloom.threshold);
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(guard);
  composer.addPass(bloom);
  composer.addPass(output);

  return {
    composer,
    target,
    bloom,
    renderPass,
    /**
     * The guard's ceiling, in the renderer's own linear units. The camera's exposure is what turns
     * radiance into screen brightness, so white is 1 / exposure and the ceiling follows it: at noon
     * it is a radiance of about 10 and on a dark night about 0.017, and in both cases it is 16
     * times whatever the camera is calling white.
     */
    setExposure(exposure) {
      guard.uniforms.uCeiling.value = 16 / Math.max(exposure, 1e-3);
    },
    /** Blends the bloom between its day and night settings (night makes the lights glow). */
    setNight(night) {
      const d = POST.bloom, n = POST.bloomNight;
      bloom.strength = d.strength + (n.strength - d.strength) * night;
      bloom.radius = d.radius + (n.radius - d.radius) * night;
      bloom.threshold = d.threshold + (n.threshold - d.threshold) * night;
    },
    setSize(nw, nh, ratio) {
      composer.setPixelRatio(ratio);
      composer.setSize(nw, nh);
    },
    render() { composer.render(); },
    dispose() {
      composer.dispose();
      bloom.dispose();
      guard.dispose?.();
      output.dispose?.();
      target.dispose();
    },
  };
}

/** Rough texture memory of everything the scene holds, in bytes, for the ?perf overlay. */
export function textureMemory(scene, targets = []) {
  const seen = new Set();
  let bytes = 0;
  const bpp = (t) => {
    const type = t.type === THREE.HalfFloatType ? 2 : (t.type === THREE.FloatType ? 4 : 1);
    const ch = t.format === THREE.RedFormat ? 1 : (t.format === THREE.RGFormat ? 2 : 4);
    return type * ch;
  };
  const add = (t) => {
    if (!t || !t.isTexture || seen.has(t)) return;
    seen.add(t);
    const img = t.image ?? {};
    const w = img.width ?? t.width ?? 0, hh = img.height ?? t.height ?? 0;
    if (!(w > 0 && hh > 0)) return;
    const mips = t.generateMipmaps || (t.mipmaps?.length > 1) ? 4 / 3 : 1;
    bytes += w * hh * bpp(t) * mips;
  };
  scene?.traverse?.((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) if (m[k]?.isTexture) add(m[k]);
      for (const u of Object.values(m.uniforms ?? {})) if (u?.value?.isTexture) add(u.value);
    }
  });
  for (const t of targets) {
    if (!t) continue;
    const list = Array.isArray(t.texture) ? t.texture : [t.texture];
    for (const tex of list) { if (tex) { tex.width = t.width; tex.height = t.height; add(tex); } }
  }
  return bytes;
}
