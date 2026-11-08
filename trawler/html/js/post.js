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
 * Zeroes any non-finite pixel before the bloom spreads it over the whole frame and tone mapping
 * turns it black (guidelines section 4). The test reads the float's exponent bits: isnan() can be
 * compiled away under fast math.
 */
const GuardShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    vec3 finiteOrZero( vec3 c ) {
      uvec3 e = floatBitsToUint( c ) & 0x7f800000u;
      bvec3 bad = equal( e, uvec3( 0x7f800000u ) );
      return vec3( bad.x ? 0.0 : c.x, bad.y ? 0.0 : c.y, bad.z ? 0.0 : c.z );
    }
    void main() {
      gl_FragColor = vec4( clamp( finiteOrZero( texture2D( tDiffuse, vUv ).rgb ), 0.0, 32768.0 ), 1.0 );
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
