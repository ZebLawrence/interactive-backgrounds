// Balloon Dawn — Uniforms shared by every material, the fog override, and GLSL helpers.

import * as THREE from 'three';
import { v3, quantizer } from './util.js';

/** Uniforms shared across the scene (the standard materials get theirs from the scene's lights and fog). */
export const G = {
  uTime: { value: 0 },
  // 0 = dawn, 1 = the night glow.
  uNight: { value: 0 },
  uSunDir: { value: v3(0.88, 0.2, -0.42).normalize() },
  uSunColor: { value: v3(1.0, 0.75, 0.5) },
  uFogColor: { value: v3(0.78, 0.55, 0.42) },
  uFogNear: { value: 150 },
  uFogFar: { value: 6000 },
};

export const Q = quantizer('q');

// Make three.js fog behave like the other backgrounds': by distance from the camera, with a
// density exponent of 1.3, so far ridges dissolve gently into the haze.
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
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
`;

/**
 * Patch a MeshStandardMaterial: `vHead`/`vMain` edit the object-space position `gPos` before
 * three.js uses it; `fHead` adds fragment declarations; `fEmissive` is appended after the
 * emissive term (it can add to `totalEmissiveRadiance`); `fBeforeOpaque` runs before output.
 */
export function patchMaterial(mat, cfg) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    vs = vs.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.fHead || ''));
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (cfg.fEmissive || ''));
    fs = fs.replace('#include <opaque_fragment>', (cfg.fBeforeOpaque || '') + '\n#include <opaque_fragment>');
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => cfg.key;
  return mat;
}
