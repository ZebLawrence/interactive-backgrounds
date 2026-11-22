// Trawler — Post stack at native resolution: the scene into a half-float 4x MSAA target, a NaN
// guard, bloom for the sun's glare on the water and the instrument lights, then ACES tone mapping.
// No upscaling and no temporal anti-aliasing: sharpness first, and the frame-rate governor in
// app.js gives way instead (guidelines section 7).
//
//   scene ─► beauty (MSAA, half float) ─► ambient occlusion (the wheelhouse only) ─► guard (zeroes
//   non-finite pixels) ─► bloom ─► output ─► canvas
//
// MSAA matters here more than in a room: a sea horizon, railings, mast stays and window mullions
// are exactly the thin near-horizontal edges that crawl without it, and it is cheap at ~2 MP.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

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

/**
 * The contact shadows. Three has no global illumination, so where the pod meets the counter, a
 * drawer front meets its carcass or a chair's cushion meets its frame, the light is the same as
 * in the open and the joinery reads as cut-outs laid on each other. Ground-truth ambient
 * occlusion in screen space (three's GTAO) puts the darkening back where surfaces close on each
 * other. It works from the beauty pass's own depth, with normals rebuilt from it, rather than
 * rendering the scene a second time for a normal buffer: that render was most of the pass's cost.
 * The sea and the land are in that depth too, but at the pass's quarter-metre radius and with its
 * distance fall-off a shoreline kilometres off occludes nothing, and the glass is not in it at
 * all, so the view through a window is not darkened round its frame.
 */
const AO = {
  radius: 0.30, // metres: the reach of a contact shadow in a room of this size
  distanceExponent: 1.2,
  thickness: 1.0,
  scale: 2.4, // strong, deliberately: a varnished room's creases are what the eye reads its depth from
  samples: 12,
  distanceFallOff: 1.0,
  screenSpaceRadius: false,
};
const AO_DENOISE = { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 12 };

export function buildPost(renderer, scene, camera, w, h, pixelRatio, lowPower, aoCamera = null) {
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
    // The beauty pass keeps its depth, for the occlusion pass: reconstructing normals from this is
    // far cheaper than the second render of the room the pass would otherwise make for itself.
    depthTexture: new THREE.DepthTexture(size.x, size.y),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);

  const renderPass = new RenderPass(scene, camera);
  const guard = new ShaderPass(GuardShader);
  const bloom = new UnrealBloomPass(size.clone(), POST.bloom.strength, POST.bloom.radius, POST.bloom.threshold);
  const output = new OutputPass();
  let gtao = null;
  if (aoCamera) {
    // Built plain and handed the depth afterwards: r170's GTAOPass dereferences the normal target
    // it only creates when no depth is passed, so passing one in the constructor throws.
    gtao = new GTAOPass(scene, aoCamera, size.x, size.y);
    gtao.setGBuffer(target.depthTexture, undefined);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 1.0;
    gtao.updateGtaoMaterial(AO);
    gtao.updatePdMaterial(AO_DENOISE);
    gtao.enabled = !lowPower;
  }
  composer.addPass(renderPass);
  if (gtao) composer.addPass(gtao);
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
    /** The occlusion is the one pass Low Power drops: it is a second render of the room. */
    setLowPower(on) { if (gtao) gtao.enabled = !on; },
    gtao,
    render() { composer.render(); },
    dispose() {
      composer.dispose();
      gtao?.dispose?.();
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
