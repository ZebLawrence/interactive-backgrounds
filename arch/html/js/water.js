// Sandstone Arch — The water: a GPU wave simulation over the near lake, the surface that reflects
// the walls, the arch and the sky and refracts the sand and the fish beneath, lit and shadowed by
// the sun (the arch's shadow lies across it), and the canyon floor under it.
//
// Lake Powell's water in a side canyon is still and clear: turquoise over sand a few metres
// down, deep blue-green where the floor drops away. Red light is gone within a couple of metres,
// green lingers, and what comes back out of the depth is a blue-green glow.

import * as THREE from 'three';
import { clamp, lerp, smoothstep, fbm2, v3 } from './util.js';
import { G, Q, NOISE_GLSL, FOG_HEAD, SHADOW_GLSL, LAYER, patchMaterial } from './shaders.js';
import { groundHeight } from './terrain.js';

// The simulated patch of water: 48 m square in front of the viewer. Beyond it, ripples are drawn
// analytically (they are only a few pixels tall out there anyway).
export const SIM_ORIGIN = { x: -24, z: -50 };
export const SIM_EXTENT = 48;
export const MAX_SPLATS = 48;
export const MAX_RINGS = 24;
// The patch of floor the contact-occlusion map covers, in metres.
export const AO_REGION = { x0: -26, z0: -36, w: 52, d: 56 };

/** Is a world point inside the simulated patch (with a margin inside the edge)? */
export function inSim(x, z, margin = 0.5) {
  return x > SIM_ORIGIN.x + margin && x < SIM_ORIGIN.x + SIM_EXTENT - margin && z > SIM_ORIGIN.z + margin && z < SIM_ORIGIN.z + SIM_EXTENT - margin;
}

// ---------------------------------------------------------------------------------------------
// WaveSim: the 2D wave equation on a float texture, ping-ponged each frame (as in Loon Lake).
// Disturbances are "splats": soft dents the equation spreads into rings. Wave speed about
// 0.6 m/s, close to the group speed of centimetre ripples; damped so a ring fades in ten seconds.
// ---------------------------------------------------------------------------------------------

export class WaveSim {
  constructor(renderer, size = 2048) {
    this.renderer = renderer;
    this.size = size;
    this.dx = SIM_EXTENT / size;
    this.c = 0.6;
    this.dtFixed = 1 / 60;
    const linearFloat = renderer.extensions.has('OES_texture_float_linear');
    const makeSim = () => new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.targets = [makeSim(), makeSim()];
    this.cur = 0;
    this.normalTarget = new THREE.WebGLRenderTarget(size, size, {
      type: linearFloat ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
      depthBuffer: false, stencilBuffer: false,
    });
    this.normalTarget.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    this.splats = [];
    this.splatArray = Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4());
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(2, 2);
    const k = (this.c * this.dtFixed / this.dx) ** 2;
    this.stepMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null }, uTexel: { value: 1 / size }, uK: { value: k }, uDamp: { value: 0.006 }, uSmooth: { value: 0.06 },
        uSplats: { value: this.splatArray }, uSplatCount: { value: 0 },
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uPrev; uniform float uTexel, uK, uDamp, uSmooth; uniform vec4 uSplats[${MAX_SPLATS}]; uniform int uSplatCount;
        varying vec2 vUv;
        void main() {
          vec2 c = texture2D(uPrev, vUv).rg;
          float l = texture2D(uPrev, vUv - vec2(uTexel, 0.0)).r, r = texture2D(uPrev, vUv + vec2(uTexel, 0.0)).r;
          float d = texture2D(uPrev, vUv - vec2(0.0, uTexel)).r, u = texture2D(uPrev, vUv + vec2(0.0, uTexel)).r;
          float lap = l + r + d + u - 4.0 * c.r;
          float h = c.r + (c.r - c.g) * (1.0 - uDamp) + uK * lap + uSmooth * lap * 0.25;
          for (int i = 0; i < ${MAX_SPLATS}; i++) {
            if (i >= uSplatCount) break;
            vec4 s = uSplats[i];
            vec2 dv = (vUv - s.xy);
            float q2 = dot(dv, dv) / (s.z * s.z);
            if (q2 < 4.0) h += s.w * exp(-q2 * 2.0) * (1.0 - q2 * 0.25);
          }
          vec2 e = min(vUv, 1.0 - vUv);
          float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
          h *= mix(0.9, 1.0, edge);
          gl_FragColor = vec4(h, c.r * mix(0.9, 1.0, edge), 0.0, 1.0);
        }`,
    });
    this.normalMaterial = new THREE.ShaderMaterial({
      uniforms: { uHeight: { value: null }, uTexel: { value: 1 / size }, uInvDx: { value: 1 / (2 * this.dx) } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uHeight; uniform float uTexel, uInvDx; varying vec2 vUv;
        void main() {
          float l = texture2D(uHeight, vUv - vec2(uTexel, 0.0)).r, r = texture2D(uHeight, vUv + vec2(uTexel, 0.0)).r;
          float d = texture2D(uHeight, vUv - vec2(0.0, uTexel)).r, u = texture2D(uHeight, vUv + vec2(0.0, uTexel)).r;
          float h = texture2D(uHeight, vUv).r;
          gl_FragColor = vec4((r - l) * uInvDx, (u - d) * uInvDx, h, 1.0);
        }`,
    });
    this.stepMesh = new THREE.Mesh(quad, this.stepMaterial);
    this.stepMesh.frustumCulled = false;
    this.scene.add(this.stepMesh);
    this.clear();
  }

  get texture() { return this.normalTarget.texture; }

  clear() {
    const r = this.renderer;
    for (const t of this.targets) { r.setRenderTarget(t); r.setClearColor(0x000000, 1); r.clear(); }
    r.setRenderTarget(null);
  }

  /** Press a dent into the water at world (x, z): `radius` in metres, `amount` in metres (negative is down). */
  splat(x, z, radius, amount) {
    if (!inSim(x, z, 0.2)) return false;
    if (this.splats.length < MAX_SPLATS) this.splats.push({ x, z, radius, amount });
    return true;
  }

  /** Advance the water by `dt`, in fixed sub-steps so the scheme stays stable. */
  step(dt) {
    const steps = clamp(Math.round(dt / this.dtFixed), 1, 4);
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    for (let s = 0; s < steps; s++) {
      const src = this.targets[this.cur], dst = this.targets[1 - this.cur];
      this.stepMaterial.uniforms.uPrev.value = src.texture;
      const n = s === 0 ? this.splats.length : 0;
      for (let i = 0; i < n; i++) {
        const sp = this.splats[i];
        this.splatArray[i].set((sp.x - SIM_ORIGIN.x) / SIM_EXTENT, (sp.z - SIM_ORIGIN.z) / SIM_EXTENT, sp.radius / SIM_EXTENT, sp.amount);
      }
      this.stepMaterial.uniforms.uSplatCount.value = n;
      this.stepMesh.material = this.stepMaterial;
      r.setRenderTarget(dst);
      r.render(this.scene, this.camera);
      this.cur = 1 - this.cur;
    }
    this.splats.length = 0;
    this.normalMaterial.uniforms.uHeight.value = this.targets[this.cur].texture;
    this.stepMesh.material = this.normalMaterial;
    r.setRenderTarget(this.normalTarget);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.normalTarget.dispose();
    this.stepMaterial.dispose();
    this.normalMaterial.dispose();
    this.stepMesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Rings beyond the simulated patch: analytic wave packets spreading from a point.
// ---------------------------------------------------------------------------------------------

export class Rings {
  constructor() {
    this.list = [];
    this.array = Array.from({ length: MAX_RINGS }, () => new THREE.Vector4(0, 0, -1000, 0));
  }

  add(x, z, amp, time) {
    this.list.push({ x, z, amp, t0: time });
    if (this.list.length > MAX_RINGS) this.list.shift();
  }

  update(time) {
    this.list = this.list.filter((r) => time - r.t0 < 30);
    this.list.forEach((r, i) => this.array[i].set(r.x, r.z, r.t0, r.amp));
    for (let i = this.list.length; i < MAX_RINGS; i++) this.array[i].set(0, 0, -1000, 0);
    return this.list.length;
  }
}

// ---------------------------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------------------------

const WATER_VERTEX = `
uniform mat4 uMirrorMatrix;
varying vec3 vWPos; varying vec4 vMirror; varying float vViewZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vMirror = uMirrorMatrix * wp;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const WATER_FRAGMENT = `
precision highp float;
uniform sampler2D uReflection, uRefraction, uRefrDepth, uWaves;
uniform vec2 uResolution, uSimOrigin; uniform float uSimExtent;
uniform vec4 uRings[${MAX_RINGS}]; uniform int uRingCount;
uniform float uTime, uNight, uDusk, uNear, uFar, uKeyI;
uniform vec3 uWind, uSunDir, uMoonDir, uKeyDir, uKeyColor, uSkyLight;
varying vec3 vWPos; varying vec4 vMirror; varying float vViewZ;
${NOISE_GLSL}${Q}${FOG_HEAD}${SHADOW_GLSL}

float viewZ(float d) { float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / ((uFar - uNear) * z - (uFar + uNear)); }

float ringSlope(float r, float age, float amp) {
  if (age < 0.0 || age > 30.0) return 0.0;
  float R = 0.55 * age;
  float w = 0.3 + 0.1 * R;
  float lam = 0.22 + 0.05 * R;
  float x = (r - R) / w;
  if (abs(x) > 3.0) return 0.0;
  float env = amp * exp(-x * x) / (1.0 + R * 0.6) * exp(-age * 0.08);
  float ph = (r - R) * 6.2831853 / lam;
  float dEnv = env * (-2.0 * x / w);
  return dEnv * cos(ph) - env * sin(ph) * 6.2831853 / lam;
}

void main() {
  vec3 toEye = cameraPosition - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  vec2 p = vWPos.xz;

  // Slope of the surface, from every source.
  vec2 slope = vec2(0.0);
  vec2 suv = (p - uSimOrigin) / uSimExtent;
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
    vec2 e = min(suv, 1.0 - suv);
    float inside = smoothstep(0.0, 0.03, min(e.x, e.y));
    vec4 w = texture2D(uWaves, suv);
    slope += w.xy * inside;
  }
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRingCount) break;
    vec4 rg = uRings[i];
    vec2 d = p - rg.xy;
    float r = length(d);
    float s = ringSlope(r, uTime - rg.z, rg.w);
    if (s != 0.0) slope += s * d / max(r, 1e-3);
  }
  // The breeze: a canyon's air moves in slow puffs, so the water is glassy with cat's-paws
  // drifting over it; the fine ripples fade out with distance where they would alias.
  vec2 wdir = normalize(uWind.xy + vec2(1e-4, 0.0));
  float along = dot(p, wdir), across = dot(p, vec2(-wdir.y, wdir.x));
  float paw = pow(fbm(vec2(along * 0.04 - uTime * q(0.06), across * 0.06) + 3.1), 2.5) * 2.2;
  float detail = 1.0 / (1.0 + dist * 0.05);
  float fineAmp = uWind.z * paw * detail * 0.04;
  float t1 = uTime * q(1.3), t2 = uTime * q(0.8);
  vec2 r1 = vec2(vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0) - vnoise(vec2(along * 9.0 - t1 * 2.6 + 0.07, across * 5.0) + 7.0),
                 vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0) - vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0 + 0.07) + 7.0)) / 0.07;
  vec2 r2 = vec2(vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0) - vnoise(vec2(along * 3.5 - t2 * 1.4 + 0.1, across * 2.4) + 19.0),
                 vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0) - vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4 + 0.1) + 19.0)) / 0.1;
  vec2 wind = (r1 * 0.6 + r2) * fineAmp;
  slope += vec2(wind.x * wdir.x - wind.y * wdir.y, wind.x * wdir.y + wind.y * wdir.x);
  // A broad, very slow unevenness so the far water is never a perfect plane.
  slope += vec2(vnoise(p * 0.1 + uTime * q(0.03)) - 0.5, vnoise(p.yx * 0.1 - uTime * q(0.025) + 5.0) - 0.5) * 0.008 * (0.3 + uWind.z);
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Reflection of the canyon and the sky, bent by the ripples.
  vec2 muv = vMirror.xy / vMirror.w;
  float bend = clamp(1.0 / (1.0 + dist * 0.015), 0.05, 1.0);
  vec2 ruv = muv + N.xz * vec2(0.35, 0.8) * bend;
  ruv = clamp(ruv, vec2(0.001), vec2(0.999));
  vec3 refl = texture2D(uReflection, ruv).rgb;

  // What is under the surface, refracted, and how much water it is seen through.
  vec2 suvScreen = gl_FragCoord.xy / uResolution;
  vec2 fuv = suvScreen - N.xz * vec2(0.25, 0.5) * bend;
  fuv = clamp(fuv, vec2(0.001), vec2(0.999));
  float dRefr = -viewZ(texture2D(uRefrDepth, fuv).r);
  if (dRefr < vViewZ) { fuv = suvScreen; dRefr = -viewZ(texture2D(uRefrDepth, fuv).r); }
  float column = max(dRefr - vViewZ, 0.0) * (dist / vViewZ);
  vec3 under = texture2D(uRefraction, fuv).rgb;
  // Clear reservoir water over pale sand: red goes within a couple of metres, green lingers.
  // The light reaching the floor came down through the water too (the floor is drawn as if in
  // air), so the path counted is the way down at the sun's slant plus the way back up to the eye.
  // By day clear turquoise; by night the lake is opaque within a metre or two.
  vec3 absorb = mix(vec3(0.5, 0.12, 0.06), vec3(1.8, 1.4, 1.1), uNight);
  float depthV = column * max(V.y, 0.05);
  vec3 trans = exp(-absorb * (column + depthV / max(uKeyDir.y, 0.3)));
  // What the water itself gives back: a turquoise glow by day, nothing much at night.
  float sunlit = shadowAt(vWPos);
  float dayLight = (1.0 - uNight) * (1.0 - 0.6 * uDusk);
  vec3 deep = vec3(0.02, 0.16, 0.19) * (0.35 + 0.65 * sunlit) * dayLight + vec3(0.006, 0.012, 0.016) * uNight;
  vec3 refr = under * trans + deep * (1.0 - trans);

  // Fresnel: glassy at a grazing angle, see-through looking down.
  float cosT = clamp(dot(V, N), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 col = mix(refr, refl, F);

  // Glitter: the key light's image broken up by the ripples (the sun hides behind the arch,
  // so its glitter is the glare round the arch's reflection; the moon lays a path).
  vec3 R = reflect(-V, N);
  float moonSpec = pow(max(dot(R, uMoonDir), 0.0), 1400.0);
  col += vec3(0.9, 0.92, 1.0) * moonSpec * 14.0 * uNight * F;
  float sunSpec = pow(max(dot(R, uSunDir), 0.0), 700.0) * 3.0 + pow(max(dot(R, uSunDir), 0.0), 40.0) * 0.25;
  col += uKeyColor * sunSpec * (1.0 - uNight) * F * 1.2 * sunlit;

  col = applyFog(col, dist);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Water {
  constructor(renderer, sim, rings) {
    this.sim = sim;
    this.rings = rings;
    this.uniforms = {
      uReflection: { value: null }, uRefraction: { value: null }, uRefrDepth: { value: null }, uWaves: { value: sim.texture },
      uResolution: { value: new THREE.Vector2(1, 1) }, uSimOrigin: { value: new THREE.Vector2(SIM_ORIGIN.x, SIM_ORIGIN.z) }, uSimExtent: { value: SIM_EXTENT },
      uRings: { value: rings.array }, uRingCount: { value: 0 },
      uMirrorMatrix: { value: new THREE.Matrix4() },
      uTime: G.uTime, uNight: G.uNight, uDusk: G.uDusk, uNear: { value: 0.1 }, uFar: { value: 1000 },
      uWind: G.uWind, uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uKeyDir: G.uKeyDir, uKeyColor: G.uKeyColor, uKeyI: G.uKeyI, uSkyLight: G.uSkyLight,
      uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
      uShadowMap: G.uShadowMap, uShadowMatrix: G.uShadowMatrix, uShadowOn: G.uShadowOn,
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT });
    // The lake fills the canyon: a long strip down it, wider than the canyon ever gets, and a
    // patch under the bar so the shoreline is where the sand rises through it.
    const geo = new THREE.PlaneGeometry(900, 1400, 24, 96);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.set(60, 0, -560);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.MAIN);
    this.mesh.renderOrder = 5;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The canyon floor: sand sloping away from the bar into the deep, between the walls, with the
// fallen blocks half buried in it (those are placed by shore.js). Seen only through the water.
// ---------------------------------------------------------------------------------------------

/** Height of the floor (negative below the water) at (x, z): the land's own surface. */
export function floorHeightRaw(x, z) {
  return groundHeight(x, z);
}
function floorHeightOld(x, z) {
  // From the shoreline the sand slopes down gently for ten metres, then the floor drops away.
  const d = Math.max(-(z + 3), 0);
  let y = -0.05 - 0.09 * Math.min(d, 10) - 0.32 * Math.max(Math.min(d, 40) - 10, 0) - 0.08 * Math.max(d - 40, 0);
  // The floor is a trough: it rises again toward the foot of each wall.
  const cx = centreX(Math.min(z, -1)), hw = halfWidth(Math.min(z, -1));
  const u = clamp(Math.abs(x - cx) / Math.max(hw, 1), 0, 1.4);
  y += smoothstep(0.55, 1.0, u) * (2.5 + 0.35 * d);
  y += (fbm2(x * 0.08 + 3, z * 0.08 + 1, 3) - 0.5) * 0.8;
  y += (fbm2(x * 0.5 + 9, z * 0.5 + 4, 2) - 0.5) * 0.12;
  return y;
}

/** The floor proper: never above the water (the bar handles the shore). */
export const floorHeight = (x, z) => Math.min(floorHeightRaw(x, z), -0.02);

export class Floor {
  constructor(sim, aoTexture) {
    const w = 260, d = 300, sx = 130, sz = 150;
    const geo = new THREE.PlaneGeometry(w, d, sx, sz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + 40, z = pos.getZ(i) - 130;
      pos.setX(i, x);
      pos.setZ(i, z);
      pos.setY(i, Math.min(floorHeight(x, z), -0.05));
    }
    geo.computeVertexNormals();
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), {
      key: 'canyonfloor',
      uniforms: {
        uWaves: { value: sim.texture }, uSimOrigin: { value: new THREE.Vector2(SIM_ORIGIN.x, SIM_ORIGIN.z) }, uSimExtent: { value: SIM_EXTENT },
        uTexel: { value: 1 / sim.size }, uAO: { value: aoTexture }, uAOOrigin: { value: new THREE.Vector2(AO_REGION.x0, AO_REGION.z0) }, uAOSize: { value: new THREE.Vector2(AO_REGION.w, AO_REGION.d) },
        uNight: G.uNight,
      },
      fHead: `
        uniform float uSimExtent, uTexel, uNight; uniform sampler2D uWaves, uAO; uniform vec2 uSimOrigin, uAOOrigin, uAOSize;
        ${NOISE_GLSL}
        vec3 floorColor(vec2 p, float depth) {
          // Pale sand with ripple marks, darker and finer where it is deeper.
          float n = fbm(p * 0.9) * 0.6 + fbm(p * 5.0) * 0.4;
          float ripple = sin(p.x * 6.0 + fbm(p * 0.4) * 6.0) * 0.5 + 0.5;
          float grain = hash21(floor(p * 300.0)) * 0.25 + 0.875;
          vec3 sand = mix(vec3(0.42, 0.36, 0.27), vec3(0.32, 0.27, 0.2), n) * (0.92 + 0.12 * ripple) * grain;
          // Sand sliding off the walls' feet carries red grit; silt greys the deep floor.
          sand = mix(sand, vec3(0.46, 0.4, 0.33), smoothstep(3.0, 12.0, depth));
          // Mats of filamentous algae in the warm shallows, bright green, in drifting clumps.
          float alg = smoothstep(0.52, 0.66, fbm(p * 0.35 + 7.0)) * smoothstep(0.4, 0.62, fbm(p * 2.2 + 3.0));
          alg *= smoothstep(9.0, 2.0, depth) * smoothstep(0.2, 1.0, depth);
          sand = mix(sand, vec3(0.22, 0.4, 0.14) * (0.8 + 0.4 * fbm(p * 9.0)), alg * 0.85);
          // Scattered pebbles of darker rock.
          vec2 g = p * 4.0; vec2 cell = floor(g); vec2 f = fract(g) - 0.5;
          vec2 o = hash22(cell) - 0.5;
          float pb = smoothstep(0.22, 0.16, length(f - o * 0.6)) * step(0.6, hash21(cell + 3.0));
          sand = mix(sand, vec3(0.38, 0.3, 0.24) * (0.7 + 0.6 * hash21(cell + 9.0)), pb * 0.8);
          return sand;
        }`,
      fColor: `
        {
          vec2 p = vWPos.xz;
          float depth = -vWPos.y;
          vec3 col = floorColor(p, depth);
          // Caustics: the ripples focus the light where the surface is concave.
          vec2 suv = (p - uSimOrigin) / uSimExtent;
          float caustic = 1.0;
          if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float hc = texture2D(uWaves, suv).z;
            float hl = texture2D(uWaves, suv - vec2(uTexel * 2.0, 0.0)).z, hr = texture2D(uWaves, suv + vec2(uTexel * 2.0, 0.0)).z;
            float hd = texture2D(uWaves, suv - vec2(0.0, uTexel * 2.0)).z, hu = texture2D(uWaves, suv + vec2(0.0, uTexel * 2.0)).z;
            caustic = clamp(1.0 - (hl + hr + hd + hu - 4.0 * hc) * 220.0, 0.75, 1.5);
          }
          vec2 auv = (p - uAOOrigin) / uAOSize;
          float ao = 1.0;
          if (auv.x > 0.0 && auv.x < 1.0 && auv.y > 0.0 && auv.y < 1.0) ao = texture2D(uAO, auv).r;
          diffuseColor.rgb = col * caustic * ao;
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER.BELOW);
    this.mesh.frustumCulled = false;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
