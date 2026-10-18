// Aspen Snow — Uniforms shared by every material, the haze fog, and GLSL helpers.

import * as THREE from 'three';
import { v3, quantizer } from './util.js';

/** Uniforms shared across the scene (the standard materials get theirs from the scene's lights and fog). */
export const G = {
  uTime: { value: 0 },
  // 0..1: how far the cloud has broken and the sun is out.
  uSun: { value: 0 },
  // 0..1: night (moonlight instead of daylight).
  uNight: { value: 0 },
  // Toward the sun and toward the moon (world space, unit).
  uSunDir: { value: v3(-0.52, 0.36, -0.78).normalize() },
  uMoonDir: { value: v3(0.46, 0.5, -0.73).normalize() },
  // The key light's direction for glints: the sun by day, the moon at night.
  uKeyDir: { value: v3(-0.52, 0.36, -0.78).normalize() },
  // The sky's light on an upward face, linear RGB, for custom shaders.
  uSkyLight: { value: v3(0.75, 0.78, 0.84) },
  // Ambient wind at the crowns, m/s in x and z.
  uWind: { value: new THREE.Vector2(0.5, 0.1) },
  // 0..1: how heavily it is snowing (the haze and the sky lighten with it).
  uSnowing: { value: 0 },
  uFogColor: { value: v3(0.62, 0.65, 0.70) },
  uFogNear: { value: 12 },
  uFogFar: { value: 150 },
};

export const Q = quantizer('q');

// Fog by distance from the camera with a density exponent of 1.3, like the other backgrounds:
// by day the grove sinks into snow haze the colour of the sky, at night into the dark.
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
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNormal = vec3(normal);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = gNormal;\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    vs = vs.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWPos = (modelMatrix * ' +
      '(\n#ifdef USE_INSTANCING\n instanceMatrix *\n#endif\n vec4(transformed, 1.0))).xyz;\n' + (cfg.vEnd || ''));
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.fHead || ''));
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
