// Hangar — Post stack at native resolution: the scene into a half-float target (4x MSAA, Low Power too),
// ground-contact AO (GTAO, off in Low Power), haze in the tall spaces, bloom on the emissives and the slime,
// then ACES tone mapping. No TAA and no upscaling: sharpness over frame rate (the frame rate governor in app.js
// gives instead).
//
//   scene ─► beauty (MSAA, depth texture) ─► GTAO (AO map from the resolved depth; normals from depth too,
//   so no second scene pass) ─► haze + AO + NaN guard ─► bloom (in place) ─► output (ACES, sRGB) ─► canvas

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const POST = {
  msaa: 4,
  bloom: { strength: 0.35, radius: 0.4, threshold: 0.9 },
  // World-space AO: a 1 m reach finds the wall-floor creases, steps, props on floors and the door frames.
  // 8 samples and an 8-tap denoise: at 3840x2160 on the Mac (M4) 12/16 cost 23 ms, 8/8 16 ms, with no
  // visible noise at 8/8.
  ao: { radius: 1.0, distanceExponent: 1, thickness: 1, scale: 1.5, samples: 8, intensity: 0.75 },
  aoDenoise: { samples: 8 },
  haze: {
    sigma: 0.018, // per metre of fully hazy air
    reach: 36, // m of the view ray marched
    steps: 8,
    color: [0.05, 0.048, 0.044], // linear HDR: lamplit dust, faint against the lit walls
    emergency: [0.03, 0.004, 0.003], // the red light in the same dust
  },
};

const HAZE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// One full-screen pass: the beauty, darkened by AO, through the haze, with every non-finite value zeroed so a
// single NaN or Inf pixel can't spread through the bloom (guidelines section 4). The test reads the float's
// bits: isnan() may be compiled away under fast math.
const HAZE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D hazeMap;
uniform vec4 hazeRect; // minX, minZ, 1/sizeX, 1/sizeZ
uniform float hazeOn;
uniform float aoIntensity;
uniform vec3 hazeColor;
uniform float hazeSigma;
uniform float hazeReach;
uniform mat4 projInv;
uniform mat4 camWorld;
uniform vec3 camPos;
varying vec2 vUv;

vec3 finiteOrZero( vec3 c ) {
  uvec3 e = floatBitsToUint( c ) & 0x7f800000u;
  bvec3 bad = equal( e, uvec3( 0x7f800000u ) );
  return vec3( bad.x ? 0.0 : c.x, bad.y ? 0.0 : c.y, bad.z ? 0.0 : c.z );
}

void main() {
  vec3 c = finiteOrZero( texture2D( tColor, vUv ).rgb );
  c = clamp( c, 0.0, 32768.0 );
  #ifdef HAZE_AO
    float ao = finiteOrZero( vec3( texture2D( tAO, vUv ).r ) ).x;
    c *= mix( 1.0, clamp( ao, 0.0, 1.0 ), aoIntensity );
  #endif
  if ( hazeOn > 0.5 ) {
    float d = texture2D( tDepth, vUv ).x;
    vec4 v = projInv * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec3 p = ( camWorld * vec4( v.xyz / v.w, 1.0 ) ).xyz; // w > 0 for every depth in a perspective view
    vec3 ray = p - camPos;
    float len = length( ray );
    if ( len > 1e-4 ) {
      vec3 dir = ray / len;
      float L = min( len, hazeReach );
      // Interleaved gradient noise: each pixel starts its march at its own offset, so the steps don't band.
      float j = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
      float acc = 0.0;
      for ( int i = 0; i < HAZE_STEPS; i++ ) {
        vec3 q = camPos + dir * ( ( float( i ) + j ) / float( HAZE_STEPS ) * L );
        vec2 m = texture2D( hazeMap, ( q.xz - hazeRect.xy ) * hazeRect.zw ).rg;
        // Thin near the floor, fuller up under the roof where the lamps catch it.
        acc += m.r * mix( 0.35, 1.0, smoothstep( 1.0, 5.0, q.y - m.g ) );
      }
      float f = 1.0 - exp( -hazeSigma * acc * L / float( HAZE_STEPS ) );
      c = mix( c, hazeColor, clamp( f, 0.0, 1.0 ) );
    }
  }
  gl_FragColor = vec4( c, 1.0 );
}
`;

/** Renders the scene into the beauty target (shadow maps update here, once, as scene.render arranges). */
class BeautyPass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene; this.camera = camera; this.target = target;
    this.needsSwap = false;
  }
  render(renderer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
  setSize(w, h) { this.target.setSize(w, h); }
}

// View-space normals from the resolved depth, once per pixel (the same estimate as GTAOShader's, which picks
// the smoother side of each neighbour pair so edges don't smear). Handing GTAO a normal texture matters: left
// to derive normals itself it does so for every one of its denoiser's samples too, 9 depth reads each, which
// cost 25-30 ms a frame at 3840x2160 on the Mac against about 4 ms for this pass.
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
  vec2 size = vec2( textureSize( tDepth, 0 ) );
  float c0 = texelFetch( tDepth, p, 0 ).x;
  if ( c0 >= 1.0 ) { gl_FragColor = vec4( 0.5, 0.5, 1.0, 1.0 ); return; }
  float l2 = texelFetch( tDepth, p - ivec2( 2, 0 ), 0 ).x, l1 = texelFetch( tDepth, p - ivec2( 1, 0 ), 0 ).x;
  float r1 = texelFetch( tDepth, p + ivec2( 1, 0 ), 0 ).x, r2 = texelFetch( tDepth, p + ivec2( 2, 0 ), 0 ).x;
  float b2 = texelFetch( tDepth, p - ivec2( 0, 2 ), 0 ).x, b1 = texelFetch( tDepth, p - ivec2( 0, 1 ), 0 ).x;
  float t1 = texelFetch( tDepth, p + ivec2( 0, 1 ), 0 ).x, t2 = texelFetch( tDepth, p + ivec2( 0, 2 ), 0 ).x;
  vec2 px = 1.0 / size;
  vec3 ce = viewAt( vUv, c0 );
  vec3 dx = abs( 2.0 * l1 - l2 - c0 ) < abs( 2.0 * r1 - r2 - c0 ) ? ce - viewAt( vUv - vec2( px.x, 0.0 ), l1 ) : viewAt( vUv + vec2( px.x, 0.0 ), r1 ) - ce;
  vec3 dy = abs( 2.0 * b1 - b2 - c0 ) < abs( 2.0 * t1 - t2 - c0 ) ? ce - viewAt( vUv - vec2( 0.0, px.y ), b1 ) : viewAt( vUv + vec2( 0.0, px.y ), t1 ) - ce;
  vec3 n = cross( dx, dy );
  float l = length( n );
  n = l > 1e-12 ? n / l : vec3( 0.0, 0.0, 1.0 ); // a degenerate cross product would be NaN (guidelines section 4)
  gl_FragColor = vec4( packNormalToRGB( n ), 1.0 );
}
`;

class NormalPass extends Pass {
  constructor(depthTexture, camera, w, h) {
    super();
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.target.texture.name = 'hangar-normals';
    this.material = new THREE.ShaderMaterial({
      name: 'hangar-normals',
      uniforms: { tDepth: { value: depthTexture }, projInv: { value: new THREE.Matrix4() } },
      vertexShader: HAZE_VERT, fragmentShader: NORMAL_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer) {
    this.material.uniforms.projInv.value.copy(this.camera.projectionMatrixInverse);
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
  setSize(w, h) { this.target.setSize(w, h); }
  dispose() { this.target.dispose(); this.material.dispose(); this.quad.dispose(); }
}

/** Beauty x AO, through the haze, NaN-guarded, into the composer's buffer. */
class HazePass extends Pass {
  constructor(beauty, camera, ao) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      name: 'hangar-haze',
      defines: { HAZE_STEPS: POST.haze.steps, ...(ao ? { HAZE_AO: '' } : {}) },
      uniforms: {
        tColor: { value: beauty.texture }, tDepth: { value: beauty.depthTexture }, tAO: { value: ao?.gtaoMap ?? null },
        hazeMap: { value: null }, hazeRect: { value: new THREE.Vector4(0, 0, 1, 1) }, hazeOn: { value: 0 },
        aoIntensity: { value: POST.ao.intensity }, hazeColor: { value: new THREE.Color(...POST.haze.color) },
        hazeSigma: { value: POST.haze.sigma }, hazeReach: { value: POST.haze.reach },
        projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
      },
      vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer) {
    const u = this.material.uniforms, cam = this.camera;
    u.projInv.value.copy(cam.projectionMatrixInverse);
    u.camWorld.value.copy(cam.matrixWorld);
    u.camPos.value.setFromMatrixPosition(cam.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.material.dispose(); this.quad.dispose(); }
}

/**
 * The post stack for one scene. w, h in CSS px; the targets are w x h x pixelRatio (native: never smaller).
 * Returns { composer, render(), resize(w, h, pixelRatio?), setHazeMap(plan), setEmergency(e), targets(), dispose() }.
 */
export function buildPost(renderer, scene, camera, w, h, pixelRatio, lowPower) {
  let pr = pixelRatio;
  const W = () => Math.max(1, Math.round(w * pr)), H = () => Math.max(1, Math.round(h * pr));
  const depthTexture = new THREE.DepthTexture(W(), H());
  depthTexture.type = THREE.UnsignedIntType;
  // 4x MSAA in Low Power too: at its ~2 MP buffer it is cheap, it keeps railings and stair edges from
  // stair-stepping when the buffer is scaled up, and the far grating's alpha to coverage needs the samples.
  const beauty = new THREE.WebGLRenderTarget(W(), H(), {
    type: THREE.HalfFloatType, samples: POST.msaa, depthTexture, generateMipmaps: false,
  });
  beauty.texture.name = 'hangar-beauty';
  // The composer's own ping-pong buffers carry no depth and no MSAA: only full-screen passes draw into them.
  const rt = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  rt.texture.name = 'hangar-post';
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);

  composer.addPass(new BeautyPass(scene, camera, beauty));
  let gtao = null, normals = null;
  if (!lowPower) {
    // GTAO is constructed with its own G-buffer (whose target is never rendered, so never allocated), then
    // pointed at the beauty's resolved depth and the normals derived from it: the scene is drawn once.
    normals = new NormalPass(depthTexture, camera, W(), H());
    composer.addPass(normals);
    gtao = new GTAOPass(scene, camera, W(), H(), undefined, POST.ao, POST.aoDenoise);
    gtao.setGBuffer(depthTexture, normals.target.texture);
    gtao.gtaoMaterial.needsUpdate = gtao.pdMaterial.needsUpdate = true;
    gtao.output = GTAOPass.OUTPUT.Off; // the haze pass applies it
    gtao.needsSwap = false;
    composer.addPass(gtao);
  }
  const haze = new HazePass(beauty, camera, gtao);
  composer.addPass(haze);
  const b = POST.bloom;
  const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), b.strength, b.radius, b.threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const hazeEmergency = new THREE.Color(...POST.haze.emergency), hazeNormal = new THREE.Color(...POST.haze.color);
  let hazeTex = null;

  return {
    composer, beauty, gtao, bloom, haze, lowPower,
    get pixelRatio() { return pr; },
    render() { composer.render(1 / 60); },
    /** New window size (CSS px) and pixel ratio: only the targets change. */
    resize(nw, nh, npr = pr) {
      if (!(nw > 0 && nh > 0 && npr > 0)) return;
      w = nw; h = nh; pr = npr;
      composer.setPixelRatio(pr); // and setSize: every pass, the beauty and the composer's buffers
      composer.setSize(w, h);
    },
    /** The haze map from hazeplan.planHaze (tallness, floor height per 0.5 m cell). */
    setHazeMap(plan) {
      hazeTex?.dispose();
      const data = new Uint16Array(plan.data.length);
      for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(plan.data[i]);
      hazeTex = new THREE.DataTexture(data, plan.w, plan.h, THREE.RGFormat, THREE.HalfFloatType);
      hazeTex.magFilter = hazeTex.minFilter = THREE.LinearFilter; // soft edges at doorways
      hazeTex.wrapS = hazeTex.wrapT = THREE.ClampToEdgeWrapping;
      hazeTex.needsUpdate = true;
      const u = haze.material.uniforms;
      u.hazeMap.value = hazeTex;
      u.hazeRect.value.set(plan.minX, plan.minZ, 1 / plan.sizeX, 1 / plan.sizeZ);
      u.hazeOn.value = 1;
    },
    /** Emergency Power (0..1, eased): the dust takes the red light. */
    setEmergency(e) {
      const k = Number.isFinite(e) ? Math.min(1, Math.max(0, e)) : 0;
      haze.material.uniforms.hazeColor.value.copy(hazeNormal).lerp(hazeEmergency, k);
    },
    /** The render targets this stack owns (for the ?perf texture-memory estimate). */
    targets() {
      const t = [beauty, composer.renderTarget1, composer.renderTarget2, bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical];
      if (gtao) t.push(normals.target, gtao.gtaoRenderTarget, gtao.pdRenderTarget);
      return t;
    },
    dispose() {
      for (const p of composer.passes) p.dispose?.();
      gtao?.gtaoMaterial.dispose(); // GTAOPass.dispose leaves its main material behind
      gtao?.blendMaterial.dispose();
      composer.dispose();
      beauty.dispose();
      depthTexture.dispose();
      hazeTex?.dispose();
    },
  };
}

const BYTES = { [THREE.UnsignedByteType]: 1, [THREE.HalfFloatType]: 2, [THREE.FloatType]: 4, [THREE.UnsignedIntType]: 4, [THREE.UnsignedInt248Type]: 4, [THREE.UnsignedShortType]: 2 };
const CHANNELS = { [THREE.RGBAFormat]: 4, [THREE.RGFormat]: 2, [THREE.RedFormat]: 1, [THREE.DepthFormat]: 1, [THREE.DepthStencilFormat]: 1 };

/**
 * An estimate of GPU texture memory (bytes): every texture a scene material or uniform references, every render
 * target given (with MSAA buffers and depth), and the lights' shadow maps. three keeps no byte count itself.
 */
export function textureMemory(scene, targets = []) {
  const seen = new Set();
  let bytes = 0;
  const texBytes = (t) => {
    if (!t?.isTexture || seen.has(t)) return;
    seen.add(t);
    if (t.isRenderTargetTexture) return; // counted with its target
    if (t.isCompressedTexture && Array.isArray(t.mipmaps) && t.mipmaps.length) {
      for (const m of t.mipmaps) bytes += m.data?.byteLength ?? 0;
      return;
    }
    const img = t.image;
    const iw = img?.width ?? 0, ih = img?.height ?? 0;
    const base = img?.data?.byteLength ?? iw * ih * (CHANNELS[t.format] ?? 4) * (BYTES[t.type] ?? 1);
    bytes += base * (t.isCubeTexture ? 6 : 1) * (t.generateMipmaps && !t.isDataTexture ? 4 / 3 : 1);
  };
  const rtBytes = (rt) => {
    if (!rt || seen.has(rt)) return;
    seen.add(rt);
    const tex = rt.texture, px = rt.width * rt.height * (rt.isWebGLCubeRenderTarget ? 6 : 1);
    const colour = px * (CHANNELS[tex.format] ?? 4) * (BYTES[tex.type] ?? 1);
    bytes += colour * (tex.generateMipmaps ? 4 / 3 : 1);
    if (rt.samples > 0) bytes += colour * rt.samples; // the multisampled colour renderbuffer
    // Depth: a depth texture is the depth buffer itself, unless MSAA renders into a multisampled renderbuffer
    // and resolves into the texture (then both exist).
    if (rt.depthBuffer) bytes += rt.samples > 0 ? px * 4 * rt.samples + (rt.depthTexture ? px * 4 : 0) : px * 4;
  };
  scene.traverse((o) => {
    if (o.isLight && o.shadow?.map) rtBytes(o.shadow.map);
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const v of Object.values(m)) texBytes(v);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) texBytes(u?.value);
      if (m.envMap?.isRenderTargetTexture && m.envMap.userData?.target) rtBytes(m.envMap.userData.target);
    }
  });
  texBytes(scene.background);
  for (const t of targets) rtBytes(t);
  return bytes;
}
