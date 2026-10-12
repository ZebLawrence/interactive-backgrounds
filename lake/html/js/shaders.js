// Loon Lake — Uniforms shared by every material, the fog override, and GLSL helpers.

import * as THREE from 'three';
import { v3, quantizer } from './util.js';

/** Uniforms shared across the scene (the standard materials get theirs from the scene's lights and fog). */
export const G = {
  uTime: { value: 0 },
  // 0 = dusk, 1 = night.
  uNight: { value: 0 },
  // 0 = dry, 1 = rain.
  uRain: { value: 0 },
  // The last of the sun: sixteen degrees up over the ridges to the left, an hour from setting.
  // It is the key light, and every shadow on the shore runs from it.
  uSunDir: { value: v3(-0.6, 0.29, -0.8).normalize() },
  // The moon, up to the right.
  uMoonDir: { value: v3(0.3, 0.3, -0.9).normalize() },
  uFogColor: { value: v3(0.42, 0.36, 0.46) },
  uFogNear: { value: 200 },
  uFogFar: { value: 5000 },
  // The breeze over the water: direction (x, z) and strength.
  uWind: { value: new THREE.Vector3(0.8, 0.6, 0.3) },
};

export const Q = quantizer('q');

// Make three.js fog behave like the other backgrounds': by distance from the camera, with a
// density exponent of 1.3, so the far shore dissolves gently into the haze.
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
vec2 hash22(vec2 p) { float n = hash21(p); return vec2(n, hash21(p + n + 17.3)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
`;

/**
 * Patch a MeshStandardMaterial: `vHead`/`vMain` edit the object-space position `gPos` (and may
 * edit `gNormal`) before three.js uses them; `fHead` adds fragment declarations; `fEmissive` is
 * appended after the emissive term (it can add to `totalEmissiveRadiance`); `fBeforeOpaque` runs
 * before output and may edit `diffuseColor` earlier via `fAfterMap`.
 */
export function patchMaterial(mat, cfg) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNormal = vec3(normal);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = gNormal;\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    vs = vs.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (cfg.fHead || ''));
    fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\n' + (cfg.fAfterMap || ''));
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (cfg.fEmissive || ''));
    fs = fs.replace('#include <opaque_fragment>', (cfg.fBeforeOpaque || '') + '\n#include <opaque_fragment>');
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => cfg.key;
  return mat;
}

/** Render layers: what the reflection and refraction passes see. */
export const LAYER = { MAIN: 0, ABOVE: 1, BELOW: 2 };
