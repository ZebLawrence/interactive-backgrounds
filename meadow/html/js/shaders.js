// Firefly Meadow — Uniforms shared by every material, and GLSL chunks for wind, the cursor,
// firefly light, moonlight and fog.

import * as THREE from 'three';
import { v3, quantizer } from './util.js';

export const TRAIL_N = 24;
export const RING_N = 4;
export const LIGHT_N = 32;

/** Uniforms shared by every material in the meadow. */
export const G = {
  uTime: { value: 0 },
  // Wind: direction on the ground (xz) and strength.
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  uWind: { value: 1 },
  // The cursor's point on the ground: (x, z, radius, strength).
  uCursor: { value: new THREE.Vector4(0, 0, 1, 0) },
  // Where the cursor has recently been, each (x, z, radius, strength).
  uTrail: { value: Array.from({ length: TRAIL_N }, () => new THREE.Vector4()) },
  // Expanding rings from claps: (x, z, radius, strength).
  uRings: { value: Array.from({ length: RING_N }, () => new THREE.Vector4()) },
  // The brightest fireflies: (x, y, z, light) and each one's colour.
  uLights: { value: Array.from({ length: LIGHT_N }, () => new THREE.Vector4()) },
  uLightCol: { value: Array.from({ length: LIGHT_N }, () => new THREE.Vector3()) },
  uMoon: { value: 1 },
  uMoonDir: { value: v3(0.42, 0.26, -0.88).normalize() },
  uMoonColor: { value: v3(0.55, 0.65, 0.9) },
  uSkyLight: { value: v3(0.09, 0.11, 0.18) },
  uStorm: { value: 0 },
  uFlash: { value: 0 },
  uFogColor: { value: v3(0, 0, 0) },
  uFogNear: { value: 15 },
  uFogFar: { value: 160 },
};

export const Q = quantizer('q');

/** Fog like SceneKit's: by distance from the camera, with a density exponent of 1.3. */
export const FOG_HEAD = `
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
vec3 applyFog(vec3 c, float dist) {
  float f = pow(clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3);
  return mix(c, uFogColor, f);
}
`;

// Make three.js's own fog (used by the sprites and the tree line) match.
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = length( mvPosition.xyz );
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogFactor = pow( clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 ), 1.3 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/** How much the ground at `p` (xz) is pushed sideways: by the cursor, its trail and clap rings. */
export const PUSH_HEAD = `
uniform vec4 uCursor; uniform vec4 uTrail[${TRAIL_N}]; uniform vec4 uRings[${RING_N}];
vec2 pushAt(vec2 p) {
  vec2 push = vec2(0.0);
  {
    vec2 d = p - uCursor.xy; float r = length(d);
    push += d / max(r, 1e-4) * smoothstep(uCursor.z, 0.0, r) * uCursor.w;
  }
  for (int i = 0; i < ${TRAIL_N}; i++) {
    vec4 t = uTrail[i];
    if (t.w <= 0.0) continue;
    vec2 d = p - t.xy; float r = length(d);
    push += d / max(r, 1e-4) * smoothstep(t.z, 0.0, r) * t.w;
  }
  for (int i = 0; i < ${RING_N}; i++) {
    vec4 g = uRings[i];
    if (g.w <= 0.0) continue;
    vec2 d = p - g.xy; float r = length(d);
    float band = exp(-pow((r - g.z) / (0.5 + g.z * 0.12), 2.0));
    push += d / max(r, 1e-4) * band * g.w;
  }
  return push;
}
`;

/** Wind at `p`: travelling waves along the wind plus a flutter, scaled by the wind strength. */
export const WIND_HEAD = `
uniform float uTime; uniform vec2 uWindDir; uniform float uWind;
${Q}
vec2 windAt(vec2 p, float phase) {
  float t = uTime;
  float along = dot(p, uWindDir), across = dot(p, vec2(uWindDir.y, -uWindDir.x));
  float w = 0.55 + 0.45 * sin(t * q(0.5) - along * 0.35 + phase)
          + 0.3 * sin(t * q(1.05) - along * 0.9 + across * 0.5 + phase * 1.7)
          + 0.18 * sin(t * q(0.17) - along * 0.08 + across * 0.11);
  vec2 flutter = vec2(sin(t * q(1.4) + phase * 2.0), cos(t * q(1.15) + phase)) * 0.08;
  return (uWindDir * w + flutter) * uWind;
}
`;

/** Light from the brightest fireflies falling on a point, in each one's own colour. */
export const LIGHTS_HEAD = `
uniform vec4 uLights[${LIGHT_N}]; uniform vec3 uLightCol[${LIGHT_N}];
vec3 fireflyLight(vec3 p) {
  vec3 glow = vec3(0.0);
  for (int i = 0; i < ${LIGHT_N}; i++) {
    vec4 L = uLights[i];
    if (L.w <= 0.0) continue;
    vec3 d = L.xyz - p;
    float r2 = dot(d, d);
    glow += uLightCol[i] * (L.w * max(1.0 / (1.0 + r2 * 14.0) - 1.0 / (1.0 + 4.0 * 14.0), 0.0));
  }
  return glow;
}
`;

/** Moon, sky and lightning on a surface with normal n, before firefly light and fog. */
export const SHADE_HEAD = `
uniform float uMoon; uniform vec3 uMoonDir; uniform vec3 uMoonColor; uniform vec3 uSkyLight; uniform float uFlash; uniform float uStorm;
vec3 shade(vec3 albedo, vec3 n, float ao) {
  float ndl = max(dot(n, uMoonDir), 0.0);
  vec3 moon = uMoonColor * (0.2 + 0.8 * ndl) * uMoon;
  vec3 sky = uSkyLight * (0.6 + 0.4 * max(n.y, 0.0));
  vec3 flash = vec3(0.7, 0.75, 1.0) * uFlash * (0.5 + 0.5 * max(n.y, 0.0)) * 1.3;
  return albedo * (moon + sky + flash) * ao;
}
`;
