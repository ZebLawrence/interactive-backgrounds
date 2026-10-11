// Fishbowl — Shader patches for MeshStandardMaterial: caustics, plant sway, fish swim, fin motion, skin.

import * as THREE from 'three';
import { TAU, clamp, smoothstep, v3 } from './util.js';

// ---------------------------------------------------------------------------------------------
// Shaders (Shaders.swift, FishShaders.swift, FishMaterials.swift skin). SceneKit shader modifiers
// become `onBeforeCompile` patches of MeshStandardMaterial.
// ---------------------------------------------------------------------------------------------

/** Shader time wraps every `TIME_WRAP` seconds, keeping float precision however long the page
 *  runs. Every animation frequency is quantised to a whole number of cycles per wrap. */
export const TIME_WRAP = 3600;
export const QK = TIME_WRAP / TAU;
/** Quantise an angular frequency on the CPU, matching the shaders' quantisers. */
export const quantize = (w) => Math.round(w * QK) / QK;
export const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const quantizer = (name) => `float ${name}(float w) { return floor(w * ${glslFloat(QK)} + 0.5) / ${glslFloat(QK)}; }\n`;

/** Uniforms shared by every material in the tank (time, the night lamp, the cursor). */
export const G = {
  uTime: { value: 0 },
  // Caustics and the night spotlight (driven by `Lighting`).
  causticNight: { value: 0 },
  spotPos: { value: v3() },
  spotT: { value: new THREE.Vector2() },
  spotCos: { value: 1 },
  fishCaustic: { value: 0.35 },
  // The cursor, for plants (driven by `PlantBed`).
  curX: { value: 0 },
  curY: { value: 0 },
  curVX: { value: 0 },
  eyeDist: { value: 1 },
};

// Make three.js fog behave like SceneKit's: distance from the camera, density exponent 1.3.
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = length( mvPosition.xyz );
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogFactor = pow( clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 ), 1.3 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/**
 * Patch a MeshStandardMaterial (and optionally a matching shadow depth material).
 *  - vHead: declarations for the vertex shader; vMain: code at the top of main() that edits
 *    `gPos` / `gNrm` (object-space position and normal) before three.js uses them.
 *  - fHead: fragment declarations; fMap: replaces the map sample; fAfterNormal / fAfterEmissive /
 *    fBeforeOpaque: code inserted at those stages. `vCauWP` (world position) is always available.
 */
export function patchMaterial(mat, cfg) {
  const key = cfg.key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vCauWP;\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNrm = vec3(normal);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = gNrm;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    vs = vs.replace('#include <project_vertex>', '#include <project_vertex>\n  vCauWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    fs = fs.replace('#include <common>', '#include <common>\nvarying vec3 vCauWP;\n' + (cfg.fHead || ''));
    if (cfg.fMap) fs = fs.replace('#include <map_fragment>', cfg.fMap);
    if (cfg.fAfterNormal) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + cfg.fAfterNormal);
    if (cfg.fAfterEmissive) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + cfg.fAfterEmissive);
    if (cfg.fBeforeOpaque) fs = fs.replace('#include <opaque_fragment>', cfg.fBeforeOpaque + '\n#include <opaque_fragment>');
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** A shadow-casting depth material that applies the same vertex deformation. */
export function patchedDepthMaterial(cfg) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cfg.uniforms || {});
    let vs = sh.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + (cfg.vHead || ''));
    vs = vs.replace('void main() {', 'void main() {\n  vec3 gPos = vec3(position);\n  vec3 gNrm = vec3(normal);\n' + (cfg.vMain || ''));
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    sh.vertexShader = vs;
  };
  mat.customProgramCacheKey = () => cfg.key + '-depth';
  return mat;
}

/** Texture sampled as premultiplied alpha, un-premultiplied (no dark fringes on cut-outs). */
export const MAP_UNPREMULTIPLY = `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb /= max( sampledDiffuseColor.a, 0.0001 );
  diffuseColor *= sampledDiffuseColor;
#endif`;

// ---- Caustics: moving light on upward-facing surfaces (sand, rocks, plants, fish backs) ----

export const CAUSTICS_HEAD = quantizer('cauQ') + `
uniform float uTime;
uniform float causticNight;
uniform vec3 spotPos;
uniform vec2 spotT;
uniform float spotCos;
float cauHash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float cauCells(vec2 p, float t, float speed) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      float h1 = cauHash(ip + g);
      float h2 = cauHash(ip + g + 17.17);
      vec2 o = 0.5 + 0.42 * sin(t * cauQ(speed * (0.5 + 0.4 * h2)) + 6.2831 * vec2(h1, h2));
      float d = length(g + o - fp);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return pow(clamp(1.0 - (d2 - d1) * 1.7, 0.0, 1.0), 5.0);
}
// At night, caustics only appear inside the spotlight's cone. The lamp hangs at spotPos and
// aims at (spotT, spotPos.z).
vec3 causticLight(vec3 wp, vec3 wn, vec3 diffuse, float strength) {
  float t = uTime;
  vec2 cp = wp.xz * 1.3 + vec2(wp.y * 0.3, 0.0);
  cp += 0.3 * vec2(sin(cp.y * 1.3 + t * cauQ(0.35)), cos(cp.x * 1.1 - t * cauQ(0.3)));
  float c = cauCells(cp, t, 0.9);
  float up = clamp(wn.y * 0.8 + 0.2, 0.0, 1.0);
  vec3 aim = normalize(vec3(spotT, spotPos.z) - spotPos);
  float cosA = dot(normalize(wp - spotPos), aim);
  float inSpot = smoothstep(spotCos, cos(acos(spotCos) * 0.4), cosA);
  float gain = mix(1.0, inSpot * 1.6, causticNight);
  vec3 tint = mix(vec3(0.55, 0.85, 0.9), vec3(1.0, 0.92, 0.75), causticNight);
  return tint * c * up * strength * gain * (0.2 + diffuse);
}
`;
export const CAUSTICS_APPLY = (strength) =>
  `totalEmissiveRadiance += causticLight(vCauWP, inverseTransformDirection(normal, viewMatrix), diffuseColor.rgb, ${strength});`;

export const causticUniforms = () => ({
  uTime: G.uTime, causticNight: G.causticNight, spotPos: G.spotPos, spotT: G.spotT, spotCos: G.spotCos,
});

// ---- Reef: caustics plus triplanar surface detail (its UVs only index a colour palette) ----

export const REEF_HEAD = CAUSTICS_HEAD + `
uniform sampler2D detailNormal;
uniform float detailScale;
uniform float detailStrength;
uniform float causticStrength;
`;
export const REEF_DETAIL = `{
  vec3 dwp = vCauWP;
  vec3 dwn = inverseTransformDirection(normal, viewMatrix);
  vec3 bw = pow(abs(dwn), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec2 tx = texture2D(detailNormal, dwp.zy * detailScale).xy * 2.0 - 1.0;
  vec2 ty = texture2D(detailNormal, dwp.xz * detailScale).xy * 2.0 - 1.0;
  vec2 tz = texture2D(detailNormal, dwp.xy * detailScale).xy * 2.0 - 1.0;
  vec3 bump = vec3(0.0, tx.y, tx.x) * bw.x + vec3(ty.x, 0.0, ty.y) * bw.y + vec3(tz.x, tz.y, 0.0) * bw.z;
  dwn = normalize(dwn + bump * detailStrength);
  normal = normalize((viewMatrix * vec4(dwn, 0.0)).xyz);
}`;

// ---- Plant sway: per-vertex (height fraction, plant height, phase, amplitude) in aSway ----

export const SWAY_HEAD = quantizer('swayQ') + `
attribute vec4 aSway;
uniform float uTime;
uniform float curX;
uniform float curY;
uniform float curVX;
uniform float eyeDist;
void plantSway(inout vec3 p) {
  float v = aSway.x;
  float h = aSway.y;
  float ph = aSway.z;
  float amp = aSway.w;
  float t = uTime;
  float spd = 0.6 + 0.5 * fract(ph * 7.13);
  float sway = amp * (sin(t * swayQ(spd) + v * 2.2 + ph) + 0.4 * sin(t * swayQ(spd * 1.7) + v * 4.0 + ph * 2.0));
  float w = pow(max(v, 0.0), 1.6);
  // Water pushed by the cursor bends plants that appear near it on screen.
  float f = eyeDist / (eyeDist - p.z);
  float baseY = (p.y - v * h) * f;
  float inRange = step(baseY - 0.2, curY) * step(curY, baseY + h * f + 0.6);
  float prox = clamp(1.0 - abs(p.x * f - curX) / 1.5, 0.0, 1.0) * inRange;
  float bend = clamp(curVX * 0.07, -0.8, 0.8) * prox;
  p.x += (sway + bend) * w;
  p.z += (0.5 * sway * cos(ph) - abs(bend) * 0.3) * w;
}
`;
export const swayUniforms = () => ({ uTime: G.uTime, curX: G.curX, curY: G.curY, curVX: G.curVX, eyeDist: G.eyeDist });

// ---- Fish: the swim wave, shared by body and fins ----

export const SWIM_HEAD = `
uniform float uTime;
uniform float swimFreq;
uniform float swimOffset;
uniform float swimAmp;
uniform float swimBend;
uniform float noseX;
uniform float bodyLen;
// Bends the vertex sideways in a travelling wave that grows toward the tail, and curves the whole
// body into an arc while turning. Must stay in sync with FishRig.lateralOffset.
void swimBody(inout vec3 p, inout vec3 n, float s, float env, float wave) {
  float k = 3.2;
  float off = env * sin(wave) + swimBend * s * s;
  float dOffDs = swimAmp * 2.0 * s * sin(wave) - env * k * cos(wave) + swimBend * 2.0 * s;
  float slope = -dOffDs / bodyLen;
  p.z += off;
  n = normalize(vec3(n.x - slope * n.z, n.y, n.z));
}
`;

/** The body: the swim wave, plus breathing near the head (mouth and gill covers). */
export const FISH_BODY_HEAD = SWIM_HEAD + `
uniform float breathFreq;
uniform float breathPhase;
uniform float mouthAmp;
uniform float gillAmp;
uniform float gillX;
uniform float gulpTime;
void fishBody(inout vec3 p, inout vec3 bn) {
  float t = uTime;
  float swimPhase = t * swimFreq + swimOffset;
  float s = max(0.0, (noseX - p.x) / bodyLen);
  float env = swimAmp * (0.08 + s * s);
  float wave = swimPhase - s * 3.2;
  if (s < gillX + 0.03) {
    float breath = sin(t * breathFreq + breathPhase);
    float sinceGulp = t - gulpTime;
    float gulp = sinceGulp < 0.0 ? 0.0 : smoothstep(0.0, 0.08, sinceGulp) * (1.0 - smoothstep(0.2, 0.65, sinceGulp));
    // Which way round the body the vertex faces: x = up/down, y = sideways.
    vec2 around = normalize(bn.yz + vec2(1e-5, 0.0));
    // Mouth: the lips part at the tip of the snout, the lower jaw dropping further.
    float gape = mouthAmp * bodyLen * (0.25 * max(0.0, breath) + 1.6 * gulp);
    float lip = 1.0 - smoothstep(0.0, 0.08, s);
    p.y += gape * lip * (around.x < 0.0 ? 1.3 * around.x : 0.6 * around.x);
    p.x -= gape * 1.6 * lip * lip * (1.0 - abs(around.x));
    // Gill covers: the rear edge lifts off the flank, lit and shaded as it tilts.
    float flare = gillAmp * bodyLen * (max(0.0, -breath) + gulp * 0.6) * abs(around.y);
    float edge = gillX - 0.045 * around.y * around.y;
    float rise = smoothstep(edge - 0.12, edge - 0.005, s);
    float drop = 1.0 - smoothstep(edge - 0.005, edge + 0.03, s);
    float dRise = (s > edge - 0.12 && s < edge - 0.005) ? 1.0 / 0.115 : 0.0;
    float dDrop = (s > edge - 0.005 && s < edge + 0.03) ? -1.0 / 0.035 : 0.0;
    float side = sign(p.z);
    p.z += side * flare * rise * drop;
    float gSlope = -side * flare * (dRise * drop + rise * dDrop) / bodyLen;
    bn = normalize(vec3(bn.x - gSlope * bn.z, bn.y, bn.z));
  }
  swimBody(p, bn, s, env, wave);
}
`;

/** Fins: each moves on its own before following the body's swim wave. Per-vertex data in aFin
 *  (see FishFins.data) says which fin a vertex belongs to and where on it. */
export const FISH_FINS_HEAD = SWIM_HEAD + quantizer('finQ') + `
attribute vec4 aFin;
uniform float finFreq;
uniform float finSeed;
uniform vec4 finFrom;
uniform vec4 finTo;
uniform float finTime;
void fishFins(inout vec3 fp, inout vec3 fn) {
  vec4 fd = aFin;
  float t = uTime;
  float swimPhase = t * swimFreq + swimOffset;
  float s = max(0.0, (noseX - fp.x) / bodyLen);
  float env = swimAmp * (0.08 + s * s);
  float wave = swimPhase - s * 3.2;
  float sinceFin = t - finTime;
  vec4 fs = mix(finFrom, finTo, sinceFin < 0.0 ? 1.0 : clamp(sinceFin / 0.4, 0.0, 1.0));
  float hover = fs.x;
  float brake = fs.y;
  float kind = floor(fd.x + 0.001);
  float flow = (fd.x - kind) * 2.0;
  float finPh = t * finFreq + finSeed;
  if (kind > 2.5) {
    // Paired fins turn about their root edge: the tip swings between the root-to-tip direction d
    // and the outward face normal.
    float side = sign(fd.y);
    float dist = abs(fd.y);
    vec3 d = vec3(fd.z, fd.w, side * sqrt(max(0.0, 1.0 - fd.z * fd.z - fd.w * fd.w)));
    vec3 outward = side * fn;
    float pelvic = step(3.5, kind);
    float ph = finPh + side * 0.7 + pelvic * 2.1;
    float amp = mix(mix(0.1, 0.45, hover), mix(0.05, 0.2, hover), pelvic);
    // Tucked in at speed, held out when hovering, flared wide when braking.
    float rest = mix(-0.3 * (1.0 - hover) + 0.1 + 0.9 * brake, 0.45 * brake, pelvic);
    float along = dist / bodyLen;
    float theta = rest + amp * sin(ph) + flow * along * 0.4 * sin(t * finQ(finFreq * 0.5) + finSeed - along * 3.5);
    float c = cos(theta) - 1.0;
    float sn = sin(theta);
    fp += dist * (c * d + sn * outward);
    // Rowing: the tip also sweeps forward and back, a quarter beat out of step.
    fp.x += dist * amp * 0.35 * (1.0 - pelvic) * cos(ph);
    fn = fn * cos(theta) - side * d * sn;
  } else if (kind > 1.5) {
    // Tail: long tails trail behind the beat and billow on their own.
    float sp = fd.y;
    float yN = fd.z;
    float len = fd.w;
    float bph = t * finQ(finFreq * 0.55) + finSeed - 3.5 * sp + 1.8 * yN;
    float trail = env * 1.2 * (sin(wave - 1.3 * sp) - sin(wave));
    float billow = bodyLen * (0.005 + 0.05 * flow) * sin(bph);
    float lag = 0.15 + 0.6 * flow;
    float dz = sp * sp * (lag * trail + billow);
    float dzds = 2.0 * sp * (lag * trail + billow) - sp * sp * bodyLen * (0.005 + 0.05 * flow) * 3.5 * cos(bph);
    float dzdy = sp * sp * bodyLen * (0.005 + 0.05 * flow) * 1.8 * cos(bph) / max(len * 0.7, 1e-4);
    fp.z += dz;
    fn = normalize(vec3(fn.x + dzds / len * fn.z, fn.y - dzdy * fn.z, fn.z));
  } else if (kind > 0.5) {
    // Dorsal and anal fins: ripples run from front to back, more when hovering; long fins lag.
    float span = fd.y;
    float along = fd.z;
    float len = fd.w;
    float bend = 0.05 + 0.12 * hover + 0.18 * flow;
    float rph = t * finQ(finFreq * 1.2) + finSeed + 8.0 * along;
    float lag = flow * min(1.0, span / (0.3 * bodyLen));
    fp.z += span * bend * sin(rph) + lag * env * (sin(wave - 1.1) - sin(wave));
    float dzdx = span * bend * 8.0 / len * cos(rph);
    float dzdy = sign(fp.y) * (span > 0.0 ? bend * sin(rph) : 0.0);
    fn = normalize(vec3(fn.x - dzdx * fn.z, fn.y - dzdy * fn.z, fn.z));
  }
  swimBody(fp, fn, s, env, wave);
}
`;

/** Light shining through thin fins: they glow warmly where the sun (by day) or the night lamp
 *  lights them from behind. finGlow = (from, to, since, night). */
export const FIN_GLOW_HEAD = `
uniform float uTime;
uniform vec4 finGlow;
uniform vec3 lampPos;
`;
export const FIN_GLOW = `{
  float sinceGlow = uTime - finGlow.z;
  float glow = mix(finGlow.x, finGlow.y, sinceGlow < 0.0 ? 1.0 : clamp(sinceGlow / 0.5, 0.0, 1.0));
  if (glow > 0.001) {
    vec3 toSun = vec3(0.073, 0.955, 0.287);
    vec3 toLight = normalize(mix(toSun, normalize(lampPos - vCauWP), finGlow.w));
    vec3 L = normalize((viewMatrix * vec4(toLight, 0.0)).xyz);
    vec3 N = normal;
    vec3 V = normalize(vViewPosition);
    float nv = dot(N, V);
    float through = clamp((-dot(N, L) * (nv < 0.0 ? -1.0 : 1.0) + 0.25) / 1.25, 0.0, 1.0);
    float ahead = pow(clamp(dot(-V, L), 0.0, 1.0), 4.0);
    vec3 warm = mix(vec3(1.0, 0.92, 0.75), vec3(1.0, 0.85, 0.62), finGlow.w);
    totalEmissiveRadiance += diffuseColor.rgb * warm * glow * (0.05 + 0.8 * through * through + 1.2 * ahead);
  }
}`;

/** The body's surface: each fish's own colouring and iridescence, then caustics. */
export const FISH_SKIN_HEAD = CAUSTICS_HEAD + `
uniform float fishCaustic;
uniform vec4 fishLook;
uniform vec4 fishMorph;
uniform vec4 fishPale;
uniform vec4 fishSheen;
vec3 fmHue(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
float fmHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
float fmNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fmHash(i), fmHash(i + vec2(1.0, 0.0)), f.x), mix(fmHash(i + vec2(0.0, 1.0)), fmHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fmFbm(vec2 p) {
  return 0.6 * fmNoise(p) + 0.28 * fmNoise(p * 2.13 + 1.7) + 0.12 * fmNoise(p * 4.37 + 4.1);
}
`;
export const FISH_SKIN = `{
  vec3 fc = diffuseColor.rgb;
  float fcLum = dot(fc, vec3(0.2126, 0.7152, 0.0722));
  // Iridescent parts, judged from the painted colour before it is personalised.
  float fBlue = clamp((fc.b - max(fc.r, fc.g * 0.6)) / (fc.b + 0.04), 0.0, 1.0);
  float fMask = fishSheen.x > 1.5 ? 1.0 : smoothstep(0.45, 0.8, fBlue) * step(0.5, fishSheen.x);
  fMask *= fishLook.w;

  // This fish's own colour.
  fc = fmHue(fc, fishLook.x);
  float fcL = dot(fc, vec3(0.2126, 0.7152, 0.0722));
  fc = max(mix(vec3(fcL), fc, fishLook.y), 0.0) * fishLook.z;

  // Colour morphs: soft-edged blotches (paler toward the belly), black saddles, freckles.
  vec2 fuv = vMapUv * vec2(fishPale.w, 1.0) + fishMorph.w;
  if (fishMorph.x > 0.0) {
    float n = fmFbm(fuv * 2.2) + (vMapUv.y - 0.5) * 0.35;
    float cover = fishMorph.x >= 1.0 ? 1.0 : smoothstep(0.02, 0.1, n - (1.0 - fishMorph.x) * 0.75 - 0.12);
    fc = mix(fc, fishPale.rgb * (0.55 + 0.6 * fcLum), cover);
  }
  if (fishMorph.y > 0.0) {
    float n = fmFbm(fuv * 3.1 + 7.3) - (vMapUv.y - 0.5) * 0.3;
    fc = mix(fc, vec3(0.02, 0.018, 0.016), smoothstep(0.02, 0.08, n - (1.0 - fishMorph.y) * 0.75 - 0.1));
  }
  if (fishMorph.z > 0.0) {
    vec2 fp = fuv * 22.0 + 3.1;
    vec2 fcell = floor(fp);
    vec2 fo = vec2(fmHash(fcell + 2.9), fmHash(fcell + 8.3)) * 0.5 + 0.25;
    float fr = 0.12 + 0.14 * fmHash(fcell + 4.7);
    float freckle = smoothstep(fr, fr * 0.6, length(fract(fp) - fo)) * step(0.66, fmHash(fcell));
    fc *= 1.0 - 0.85 * fishMorph.z * freckle;
  }

  vec3 fn = normal;
  vec3 fv = normalize(vViewPosition);
  // Glints: each scale is a small mirror at its own angle.
  if (fishSheen.w > 0.0) {
    vec2 st = vNormalMapUv * vec2(8.0, 10.0);
    float col = floor(st.x);
    vec2 sp = vec2(st.x, st.y - 0.5 * mod(abs(col), 2.0));
    vec2 cell = floor(sp);
    vec2 d = (fract(sp) - 0.5) * vec2(1.0, 0.8);
    float dome = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0) * fMask;
    vec3 tilt = vec3(fmHash(cell), fmHash(cell + 11.7), fmHash(cell + 23.1)) - 0.5;
    fn = normalize(fn + (viewMatrix * vec4(tilt, 0.0)).xyz * fishSheen.w * dome);
    normal = fn;
    float shiny = step(0.6, fmHash(cell + 5.3)) * dome;
    roughnessFactor = mix(roughnessFactor, 0.15, shiny);
  }
  if (fishSheen.x > 0.0) {
    vec3 fl = normalize((viewMatrix * vec4(0.07, 0.95, 0.29, 0.0)).xyz);
    float nv = clamp(dot(fn, fv), 0.0, 1.0);
    float nh = clamp(dot(fn, normalize(fl + fv)), 0.0, 1.0);
    float fres = pow(1.0 - nv, 3.0);
    // Thin-film-like swing: greener face-on, violet toward grazing and away from the light.
    float swing = clamp((nv - 0.55) * 2.2 + (nh - 0.75) * 1.2, -1.0, 1.0);
    vec3 irid = fmHue(fc, -fishSheen.y * swing);
    float boost = 1.0 + fishSheen.z * (0.5 * fres + pow(nh, 12.0));
    fc = mix(fc, irid * boost, fMask);
  }
  diffuseColor.rgb = min(fc, 1.0);
}
` + CAUSTICS_APPLY('fishCaustic');

// ---- The night spotlight's visible beam: an additive cone, brightest seen edge-on through its
// middle, fading in from darkness near the top ----

export function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { beamStrength: { value: 0 }, beamTop: { value: 0 }, beamBottom: { value: 0 } },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float beamStrength;
      uniform float beamTop;
      uniform float beamBottom;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float h = clamp((vW.y - beamBottom) / (beamTop - beamBottom), 0.0, 1.0);
        float a = pow(facing, 3.0) * mix(0.3, 1.0, h) * beamStrength * smoothstep(beamTop + 0.5, beamTop - 1.5, vW.y);
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * a, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// ---- Drifting specks ("marine snow"), lit: they glint in the night lamp and fade in the dark ----

export function snowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: G.uTime, spotPos: G.spotPos, spotT: G.spotT, spotCos: G.spotCos, causticNight: G.causticNight,
      pxScale: { value: 1 }, fogNear: { value: 1 }, fogFar: { value: 2 }, dayLight: { value: 1 },
    },
    vertexShader: `
      attribute vec4 aSeed;   // start offset in the box (xyz), size
      attribute vec4 aMotion; // velocity (xyz), lifespan
      attribute float aBirth;
      uniform float uTime;
      uniform float pxScale;
      uniform vec3 spotPos;
      uniform vec2 spotT;
      uniform float spotCos;
      uniform float causticNight;
      uniform float fogNear;
      uniform float fogFar;
      uniform float dayLight;
      varying float vA;
      void main() {
        float life = aMotion.w;
        float age = mod(uTime + aBirth, life);
        vec3 p = position + aMotion.xyz * age + vec3(0.0, -0.002, 0.0) * age * age;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.0, aSeed.w * pxScale / -mv.z);
        vec3 aim = normalize(vec3(spotT, spotPos.z) - spotPos);
        float inSpot = smoothstep(spotCos, cos(acos(spotCos) * 0.5), dot(normalize(wp.xyz - spotPos), aim));
        float lit = mix(dayLight, inSpot * 1.6 + 0.05, causticNight);
        float fade = smoothstep(0.0, 2.0, age) * (1.0 - smoothstep(life - 2.0, life, age));
        float fog = pow(clamp((length(mv.xyz) - fogNear) / (fogFar - fogNear), 0.0, 1.0), 1.3);
        vA = 0.35 * lit * fade * (1.0 - fog);
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = 1.0 - smoothstep(0.0, 0.5, length(d));
        gl_FragColor = vec4(vec3(0.8, 0.95, 1.0) * r * vA, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
