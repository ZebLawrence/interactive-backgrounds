// Diorama — the post stack: the scene into a half-float target with 4x MSAA, contact shadows from
// ground-truth ambient occlusion, bloom on whatever glows, then ACES tone mapping.
//
//   scene ─► beauty (MSAA, depth texture) ─► normals from the resolved depth ─► GTAO (an AO map; the scene
//   is drawn once) ─► beauty x AO, NaN-guarded ─► bloom ─► output (ACES, sRGB) ─► canvas
//
// The pattern is Hangar's (hangar/html/js/post.js), without its haze. One thing is particular to this page: the
// camera's projection is off-axis and set by hand every frame, so everything here reads the camera's
// projection matrices as they are and never asks the camera to rebuild them.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
`;

// View-space normals from the resolved depth, once per pixel, picking the smoother side of each neighbour pair
// so edges do not smear. Handing GTAO a normal texture saves it deriving one for every sample it takes.
const NORMAL_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform mat4 projInv;
varying vec2 vUv;
vec3 viewAt( vec2 uv, float d ) {
  vec4 v = projInv * vec4( vec3( uv, d ) * 2.0 - 1.0, 1.0 );
  return v.xyz / v.w;
}
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  vec2 px = 1.0 / vec2( textureSize( tDepth, 0 ) );
  float c0 = texelFetch( tDepth, p, 0 ).x;
  if ( c0 >= 1.0 ) { gl_FragColor = vec4( 0.5, 0.5, 1.0, 1.0 ); return; }
  float l2 = texelFetch( tDepth, p - ivec2( 2, 0 ), 0 ).x, l1 = texelFetch( tDepth, p - ivec2( 1, 0 ), 0 ).x;
  float r1 = texelFetch( tDepth, p + ivec2( 1, 0 ), 0 ).x, r2 = texelFetch( tDepth, p + ivec2( 2, 0 ), 0 ).x;
  float b2 = texelFetch( tDepth, p - ivec2( 0, 2 ), 0 ).x, b1 = texelFetch( tDepth, p - ivec2( 0, 1 ), 0 ).x;
  float t1 = texelFetch( tDepth, p + ivec2( 0, 1 ), 0 ).x, t2 = texelFetch( tDepth, p + ivec2( 0, 2 ), 0 ).x;
  vec3 ce = viewAt( vUv, c0 );
  vec3 dx = abs( 2.0 * l1 - l2 - c0 ) < abs( 2.0 * r1 - r2 - c0 ) ? ce - viewAt( vUv - vec2( px.x, 0.0 ), l1 ) : viewAt( vUv + vec2( px.x, 0.0 ), r1 ) - ce;
  vec3 dy = abs( 2.0 * b1 - b2 - c0 ) < abs( 2.0 * t1 - t2 - c0 ) ? ce - viewAt( vUv - vec2( 0.0, px.y ), b1 ) : viewAt( vUv + vec2( 0.0, px.y ), t1 ) - ce;
  vec3 n = cross( dx, dy );
  float l = length( n );
  n = l > 1e-14 ? n / l : vec3( 0.0, 0.0, 1.0 ); // a degenerate cross product would be NaN
  gl_FragColor = vec4( packNormalToRGB( n ), 1.0 );
}
`;

// Beauty x AO. Every non-finite value is zeroed so one NaN pixel cannot spread through the bloom; the test
// reads the float's bits because isnan() may be compiled away.
const COMBINE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform float aoIntensity;
uniform float vignette;
varying vec2 vUv;
vec3 finiteOrZero( vec3 c ) {
  bvec3 bad = equal( floatBitsToUint( c ) & uvec3( 0x7F800000u ), uvec3( 0x7F800000u ) );
  return vec3( bad.x ? 0.0 : c.x, bad.y ? 0.0 : c.y, bad.z ? 0.0 : c.z );
}
void main() {
  vec3 c = finiteOrZero( texture2D( tColor, vUv ).rgb );
  #ifdef USE_AO
    c *= mix( 1.0, texture2D( tAO, vUv ).r, aoIntensity );
  #endif
  c *= 1.0 - vignette * smoothstep( 0.3, 0.78, length( vUv - 0.5 ) ); // the corners fall away into the dark
  gl_FragColor = vec4( min( c, vec3( 64.0 ) ), 1.0 );
}
`;

// A depth-only pass ahead of the colour pass was tried, to shade each pixel once in a scene of stacked fins. It
// made things slower (37 to 46 ms at 3840 x 2160 on an M3, 4x MSAA): there is little wasted shading here, and
// filling a multisampled 4K target a second time costs more than it saves.
class BeautyPass extends Pass {
  constructor(scene, camera, target) { super(); this.scene = scene; this.camera = camera; this.target = target; this.needsSwap = false; }
  render(renderer) { renderer.setRenderTarget(this.target); renderer.render(this.scene, this.camera); }
  setSize(w, h) { this.target.setSize(w, h); }
}

class QuadPass extends Pass {
  constructor(material, target = null) {
    super();
    this.material = material; this.target = target; this.quad = new FullScreenQuad(material);
    this.needsSwap = !target;
    this.before = null;
  }
  render(renderer, writeBuffer) {
    this.before?.();
    renderer.setRenderTarget(this.target ?? (this.renderToScreen ? null : writeBuffer));
    this.quad.render(renderer);
  }
  setSize(w, h) { this.target?.setSize(w, h); }
  dispose() { this.target?.dispose(); this.material.dispose(); this.quad.dispose(); }
}

/**
 * The post stack for one scene. `look` is the skin's taste: { ao: { radius, intensity } | null, bloom:
 * { strength, radius, threshold } | null, vignette: 0..1 }, with the AO radius in metres of the world as drawn.
 * Returns { render(), resize(w, h, pixelRatio), dispose() }.
 */
export function buildPost(renderer, scene, camera, w, h, pixelRatio, look = {}, lowPower = false) {
  let pr = pixelRatio;
  const W = () => Math.max(1, Math.round(w * pr)), H = () => Math.max(1, Math.round(h * pr));
  const depthTexture = new THREE.DepthTexture(W(), H());
  depthTexture.type = THREE.UnsignedIntType;
  const beauty = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.HalfFloatType, samples: 4, depthTexture, generateMipmaps: false });
  // The composer's own ping-pong buffers carry no depth and no MSAA: only full-screen passes draw into them.
  const rt = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  composer.addPass(new BeautyPass(scene, camera, beauty));

  const ao = !lowPower && look.ao ? look.ao : null;
  let gtao = null;
  if (ao) {
    const normalMat = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: depthTexture }, projInv: { value: new THREE.Matrix4() } },
      vertexShader: VERT, fragmentShader: NORMAL_FRAG, depthTest: false, depthWrite: false,
    });
    const normalTarget = new THREE.WebGLRenderTarget(W(), H(), { depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const normals = new QuadPass(normalMat, normalTarget);
    normals.before = () => normalMat.uniforms.projInv.value.copy(camera.projectionMatrixInverse);
    composer.addPass(normals);
    // GTAO is built with its own G-buffer (never rendered, so never allocated) and then pointed at the beauty's
    // resolved depth and the normals derived from it.
    // At half the resolution: AO is a soft thing, and at full size it was a third of the frame at 4K.
    gtao = new GTAOPass(scene, camera, Math.ceil(W() / 2), Math.ceil(H() / 2), undefined,
      { radius: ao.radius, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 8, distanceFallOff: 1, screenSpaceRadius: false },
      { samples: 8 });
    const fullSize = gtao.setSize.bind(gtao);
    gtao.setSize = (pw, ph) => fullSize(Math.ceil(pw / 2), Math.ceil(ph / 2));
    gtao.setGBuffer(depthTexture, normalTarget.texture);
    gtao.gtaoMaterial.needsUpdate = gtao.pdMaterial.needsUpdate = true;
    gtao.output = GTAOPass.OUTPUT.Off; // the combine pass applies it
    gtao.needsSwap = false;
    composer.addPass(gtao);
  }
  const combine = new QuadPass(new THREE.ShaderMaterial({
    defines: gtao ? { USE_AO: '' } : {},
    uniforms: { tColor: { value: beauty.texture }, tAO: { value: gtao?.pdRenderTarget.texture ?? null }, aoIntensity: { value: ao?.intensity ?? 0 }, vignette: { value: look.vignette ?? 0 } },
    vertexShader: VERT, fragmentShader: COMBINE_FRAG, depthTest: false, depthWrite: false,
  }));
  composer.addPass(combine);
  let bloom = null;
  if (look.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), look.bloom.strength, look.bloom.radius, look.bloom.threshold);
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  return {
    composer, beauty, gtao, bloom,
    render() { composer.render(1 / 60); },
    resize(nw, nh, npr = pr) {
      if (!(nw > 0 && nh > 0 && npr > 0)) return;
      w = nw; h = nh; pr = npr;
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
    },
    dispose() {
      for (const p of composer.passes) p.dispose?.();
      gtao?.gtaoMaterial.dispose();
      gtao?.blendMaterial.dispose();
      composer.dispose();
      beauty.dispose();
      depthTexture.dispose();
    },
  };
}
