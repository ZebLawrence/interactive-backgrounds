// Sandstone Arch — Uniforms shared by every material, the haze fog, render layers and GLSL helpers.

import * as THREE from 'three';
import { v3, quantizer } from './util.js';

/** Uniforms shared across the scene (the standard materials get theirs from the scene's lights and fog). */
export const G = {
  uTime: { value: 0 },
  // 0..1 blends: afternoon -> dusk, and day -> night. Aurora is 0..1 too (only shows at night).
  uDusk: { value: 0 },
  uNight: { value: 1 },
  uAurora: { value: 1 },
  // The aurora's light on the ground, linear RGB (set by aurora.js).
  uAuroraLight: { value: v3() },
  uRain: { value: 0 },
  uFlash: { value: new THREE.Vector4(0, 1, 0, 0) },
  // Toward the sun: low down the canyon ahead of us (-z), a little left, 26 degrees up, so it
  // hides behind the crown of the arch and pours its light under it toward the viewer (20.5 degrees up, 4 left).
  uSunDir: { value: v3(-0.0653, 0.3502, -0.9344).normalize() },
  // The moon: behind the viewer, high to the right, so it lights the near face of the arch and
  // the walls, and the Milky Way stands in the dark sky over the bridge.
  uMoonDir: { value: v3(-0.3, 0.34, 0.89).normalize() },
  // The key light's direction right now (sun by day, moon at night), for glints.
  uKeyDir: { value: v3(-0.0653, 0.3502, -0.9344).normalize() },
  // The key light's colour and intensity, linear, for custom shaders that light themselves.
  uKeyColor: { value: v3(1.0, 0.68, 0.40) },
  uKeyI: { value: 2.7 },
  // The sky's light on an upward face, linear RGB, and the bounce from sunlit rock on a downward one.
  uSkyLight: { value: v3(0.5, 0.6, 0.8) },
  uBounceLight: { value: v3(0.5, 0.25, 0.1) },
  // The breeze over the water: direction (x, z) and strength 0..1.
  uWind: { value: new THREE.Vector3(0.6, -0.8, 0.25) },
  uFogColor: { value: v3(0.8, 0.62, 0.45) },
  uFogNear: { value: 60 },
  uFogFar: { value: 900 },
  // The key light's shadow map and matrix, for the custom shaders (water, motes) that want shadows.
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowOn: { value: 0 },
};

export const Q = quantizer('q');

// Fog by distance from the camera with a density exponent of 1.3, like the other backgrounds:
// by day the canyon dissolves into warm haze, at night into the dark.
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = length( mvPosition.xyz );
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogFactor = pow( clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 ), 1.3 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/** The same fog for custom shaders. */
export const FOG_HEAD = `
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
vec3 applyFog(vec3 c, float dist) {
  float f = pow(clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3);
  return mix(c, uFogColor, f);
}
`;

export const NOISE_GLSL = `
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2 hash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise1(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
float fbm3(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
`;

/**
 * A manual lookup into the key light's shadow map (three packs depth into RGBA), for the custom
 * shaders that cannot use three's lighting chunks: 1 in the light, 0 in shadow, with a 3x3 PCF.
 */
export const SHADOW_GLSL = `
uniform sampler2D uShadowMap; uniform mat4 uShadowMatrix; uniform float uShadowOn;
float unpackDepth(vec4 v) { return dot(v, vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0)); }
float shadowAt(vec3 wpos) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wpos, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float bias = 0.0015;
  float texel = 1.0 / 4096.0;
  float lit = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float d = unpackDepth(texture2D(uShadowMap, sc.xy + vec2(float(i), float(j)) * texel * 1.5));
    lit += step(sc.z - bias, d);
  }
  return lit / 9.0;
}
`;

/**
 * Patch a standard material: `vHead`/`vMain` edit the object-space position `gPos` (and may set
 * `gNormal`) before three.js uses it; `fHead` adds fragment declarations; `fColor` runs after the
 * map is applied and may change `diffuseColor`; `fNormal` runs after the normal is set up and may
 * change `normal`; `fRough` runs after the roughness is set; `fEmissive` is appended after the
 * emissive term; `fBeforeOpaque` runs before output. The edited shader strings are written back
 * to the shader object.
 */
export function patchMaterial(mat, cfg) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vONormal;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNormal = vec3(normal);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = gNormal;\n  vONormal = gNormal;\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    vs = vs.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWPos = (modelMatrix * ' +
      '(\n#ifdef USE_INSTANCING\n instanceMatrix *\n#endif\n vec4(transformed, 1.0))).xyz;\n' + (cfg.vEnd || ''));
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vONormal;\n' + (cfg.fHead || ''));
    fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\n' + (cfg.fColor || ''));
    fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (cfg.fNormal || ''));
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + (cfg.fRough || ''));
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (cfg.fEmissive || ''));
    fs = fs.replace('#include <opaque_fragment>', (cfg.fBeforeOpaque || '') + '\n#include <opaque_fragment>');
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => cfg.key;
  return mat;
}

/**
 * The matching shadow-pass material: the same vertex deformation (`vHead`/`vMain` on `gPos`), and
 * an optional `fDiscard` that may `discard` fragments (with `vDUv` the geometry's uv).
 */
export function patchDepth(cfg) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec2 vDUv;\nvarying vec3 vDPos;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNormal = vec3(normal);\n  vDUv = uv;\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;\n  vDPos = gPos;');
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec2 vDUv;\nvarying vec3 vDPos;\n' + (cfg.fHead || ''));
    fs = fs.replace('void main() {', 'void main() {\n' + (cfg.fDiscard || ''));
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => cfg.key + '-depth';
  return mat;
}

/** Render layers: what the reflection and refraction passes see. */
export const LAYER = { MAIN: 0, ABOVE: 1, BELOW: 2 };

/** Put an object (and its children) in the main pass plus the given extra layers. */
export function setLayers(obj, ...layers) {
  obj.traverse((o) => { o.layers.set(LAYER.MAIN); for (const l of layers) o.layers.enable(l); });
}
