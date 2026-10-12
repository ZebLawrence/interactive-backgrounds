// Loon Lake — The water: a GPU wave simulation over the near lake, the surface that reflects the
// shore and refracts the bed and the fish beneath, and the pebbled lake bed itself.

import * as THREE from 'three';
import { clamp, lerp, v3 } from './util.js';
import { G, Q, NOISE_GLSL, FOG_HEAD, LAYER, patchMaterial } from './shaders.js';

// The simulated patch of water: 64 m square in front of the viewer. Beyond it, ripples are drawn
// analytically (they are only a few pixels tall out there anyway).
export const SIM_ORIGIN = { x: -32, z: -64 };
export const SIM_EXTENT = 64;
export const MAX_SPLATS = 48;
export const MAX_RINGS = 24;
// The patch of bed the contact-occlusion map covers, in metres.
export const AO_REGION = { x0: -30, z0: -32, w: 60, d: 34 };

/** Is a world point inside the simulated patch (with a margin inside the edge)? */
export function inSim(x, z, margin = 0.5) {
  return x > SIM_ORIGIN.x + margin && x < SIM_ORIGIN.x + SIM_EXTENT - margin && z > SIM_ORIGIN.z + margin && z < SIM_ORIGIN.z + SIM_EXTENT - margin;
}

// ---------------------------------------------------------------------------------------------
// WaveSim: the 2D wave equation on a float texture, ping-ponged each frame. Disturbances are
// "splats": soft dents pressed into the surface (a fingertip, a stone, a raindrop, a trout's
// nose) that the equation then spreads into rings. Wave speed is fixed at about 0.6 m/s, close
// to the group speed of the centimetre ripples a stone makes on a pond, and the surface is
// damped so a ring fades over ten seconds or so, as it would.
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
    // The surface reads a filtered, mipmapped map of (slope x, slope z, height) so far water
    // averages many cells instead of sparkling.
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
          // The wave equation, with a little velocity damping and a touch of diffusion: the
          // finest ripples (a raindrop's) die within a second, the broad rings of a stone last.
          float h = c.r + (c.r - c.g) * (1.0 - uDamp) + uK * lap + uSmooth * lap * 0.25;
          // Dents pressed in this frame.
          for (int i = 0; i < ${MAX_SPLATS}; i++) {
            if (i >= uSplatCount) break;
            vec4 s = uSplats[i];
            vec2 dv = (vUv - s.xy);
            float q2 = dot(dv, dv) / (s.z * s.z);
            if (q2 < 4.0) h += s.w * exp(-q2 * 2.0) * (1.0 - q2 * 0.25);
          }
          // Soak up waves near the edge of the patch so they do not reflect back from it.
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
      // Splats land on the first sub-step only.
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
// Rings beyond the simulated patch: a few analytic wave packets, each spreading from a point
// (a stone's last skip far out, a loon surfacing, a trout rising across the lake).
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
uniform float uTime, uNight, uRain, uNear, uFar;
uniform vec3 uWind, uSunDir, uMoonDir;
varying vec3 vWPos; varying vec4 vMirror; varying float vViewZ;
${NOISE_GLSL}${Q}${FOG_HEAD}

float viewZ(float d) { float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / ((uFar - uNear) * z - (uFar + uNear)); }

// One analytic ring: a packet whose leading edge moves out at the group speed, widening and
// fading as it goes. Returns the slope along the radius.
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

// Rain: a hashed field of little expanding rings, each lasting well under a second and
// reaching a few hand-widths across before it dies, as a raindrop's capillary ring does. (The
// wave simulation cannot do this: it has one wave speed and no dispersion, so its rings grow
// into stone-sized ones.)
vec2 rainSlope(vec2 p, float scale, float density) {
  vec2 g = p * scale;
  vec2 cell = floor(g), f = fract(g) - 0.5;
  vec2 acc = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = hash22(cell + o);
    // Each cell gets a drop every cycle, at its own moment; the cycle count re-seeds the spot.
    float cyc = uTime * 1.4 + h.x;
    float t = fract(cyc);
    vec2 h2 = hash22(cell + o + floor(cyc) * 0.37);
    if (h2.x > density) continue;
    vec2 c = o + h2 - 0.5;
    float r = length(f - c);
    float R = t * 0.45;
    float w = 0.05 + 0.04 * t;
    float x = (r - R) / w;
    if (abs(x) < 3.0) {
      float env = exp(-x * x) * (1.0 - t) * (1.0 - t) * 0.5;
      float ph = (r - R) * 40.0;
      float s = env * (-2.0 * x / w) * cos(ph) - env * sin(ph) * 40.0;
      acc += s * (f - c) / max(r, 1e-3);
    }
  }
  return acc / scale;
}

void main() {
  vec3 toEye = cameraPosition - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  vec2 p = vWPos.xz;

  // Slope of the surface, from every source.
  vec2 slope = vec2(0.0);
  vec2 suv = (p - uSimOrigin) / uSimExtent;
  float h = 0.0;
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
    vec2 e = min(suv, 1.0 - suv);
    float inside = smoothstep(0.0, 0.03, min(e.x, e.y));
    vec4 w = texture2D(uWaves, suv);
    slope += w.xy * inside;
    h = w.z * inside;
  }
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRingCount) break;
    vec4 rg = uRings[i];
    vec2 d = p - rg.xy;
    float r = length(d);
    float s = ringSlope(r, uTime - rg.z, rg.w);
    if (s != 0.0) slope += s * d / max(r, 1e-3);
  }
  // The breeze: fine capillary ripples running downwind, strongest where a cat's paw crosses the
  // water, fading into a gentle large-scale unevenness far out where the detail would alias.
  vec2 wdir = normalize(uWind.xy + vec2(1e-4, 0.0));
  float along = dot(p, wdir), across = dot(p, vec2(-wdir.y, wdir.x));
  float paw = pow(fbm(vec2(along * 0.05 - uTime * q(0.08) * 1.0, across * 0.07) + 3.1), 2.0) * 1.8 + 0.25;
  float detail = 1.0 / (1.0 + dist * 0.06);
  float fineAmp = uWind.z * paw * detail * 0.045;
  float t1 = uTime * q(1.4), t2 = uTime * q(0.9);
  vec2 r1 = vec2(vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0) - vnoise(vec2(along * 9.0 - t1 * 2.6 + 0.07, across * 5.0) + 7.0),
                 vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0) - vnoise(vec2(along * 9.0 - t1 * 2.6, across * 5.0 + 0.07) + 7.0)) / 0.07;
  vec2 r2 = vec2(vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0) - vnoise(vec2(along * 3.5 - t2 * 1.4 + 0.1, across * 2.4) + 19.0),
                 vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0) - vnoise(vec2(along * 3.5 - t2 * 1.4, across * 2.4 + 0.1) + 19.0)) / 0.1;
  vec2 wind = (r1 * 0.6 + r2) * fineAmp;
  slope += vec2(wind.x * wdir.x - wind.y * wdir.y, wind.x * wdir.y + wind.y * wdir.x);
  // A broad, slow swell so the far water is never glassy-flat.
  slope += vec2(vnoise(p * 0.12 + uTime * q(0.05)) - 0.5, vnoise(p.yx * 0.12 - uTime * q(0.04) + 5.0) - 0.5) * 0.012 * uWind.z;
  if (uRain > 0.001) {
    float near = 1.0 / (1.0 + dist * 0.02);
    slope += rainSlope(p, 4.0, 0.6) * uRain * near * 1.2 + rainSlope(p + 31.0, 1.6, 0.5) * uRain * near * 0.5;
  }
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // Reflection of the shore and sky, bent by the ripples.
  vec2 muv = vMirror.xy / vMirror.w;
  // The offset shrinks with distance: the same slope moves a far reflection fewer pixels.
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
  // Along the view ray: view-space depth scaled by the ray's length per unit depth (computed
  // per fragment; a length is not linear across a triangle, so it cannot be a varying).
  float column = max(dRefr - vViewZ, 0.0) * (dist / vViewZ);
  vec3 under = texture2D(uRefraction, fuv).rgb;
  // Clear lake water: red goes first, blue-green lingers.
  vec3 absorb = vec3(0.42, 0.26, 0.18);
  vec3 trans = exp(-absorb * column);
  vec3 skyLight = mix(vec3(0.36, 0.3, 0.38), vec3(0.03, 0.035, 0.06), uNight);
  // Light scattered back out of the water itself: a veil of skylight that hides the bed beyond a few metres.
  vec3 deep = mix(vec3(0.03, 0.075, 0.075), vec3(0.003, 0.006, 0.009), uNight) * (0.6 + 0.4 * skyLight.g / 0.3);
  vec3 refr = under * trans + deep * (1.0 - trans);

  // Fresnel for water: glassy at a grazing angle, nearly see-through looking down.
  float cosT = clamp(dot(V, N), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 col = mix(refr, refl, F);

  // Glitter: the moon's image broken up by the ripples, and the last of the afterglow.
  vec3 R = reflect(-V, N);
  float moonSpec = pow(max(dot(R, uMoonDir), 0.0), 1400.0);
  col += vec3(0.9, 0.92, 1.0) * moonSpec * 6.0 * uNight * F * 3.0;
  // The sun's glitter path: a sharp core on each ripple facet, a soft spread around it.
  float sunSpec = pow(max(dot(R, uSunDir), 0.0), 900.0) * 4.0 + pow(max(dot(R, uSunDir), 0.0), 60.0) * 0.5;
  col += vec3(1.0, 0.6, 0.3) * sunSpec * (1.0 - uNight) * (1.0 - uRain) * F * 1.6;

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
      uTime: G.uTime, uNight: G.uNight, uRain: G.uRain, uNear: { value: 0.1 }, uFar: { value: 1000 },
      uWind: G.uWind, uSunDir: G.uSunDir, uMoonDir: G.uMoonDir,
      uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT });
    // Denser toward the viewer so the perspective-correct interpolation stays accurate near by.
    const geo = new THREE.PlaneGeometry(9000, 9000, 64, 64);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.z = -4000;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.MAIN);
    this.mesh.renderOrder = 5;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The lake bed: pebbles and sand sloping away from the shore, seen through the water near by,
// with caustics from the ripples playing over it.
// ---------------------------------------------------------------------------------------------

/** Depth of the bed below the surface at distance -z out from the shore. */
export function bedDepth(z) {
  const d = -z;
  // Shallows sloping gently for fifteen metres, then the drop-off.
  return 0.4 + 0.08 * Math.min(d, 15) + 0.3 * Math.max(Math.min(d, 40) - 15, 0);
}

export class LakeBed {
  constructor(sim, aoTexture) {
    const w = 120, d = 80, segs = 64;
    const geo = new THREE.PlaneGeometry(w, d, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i) - d / 2 + 2;
      pos.setZ(i, z);
      pos.setY(i, -bedDepth(Math.min(z, -0.01)));
    }
    geo.computeVertexNormals();
    // A standard material so the bed takes the key light's shadows; the pebbles, the contact
    // occlusion and the caustics are painted into its albedo.
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }), {
      key: 'lakebed',
      uniforms: {
        uWaves: { value: sim.texture }, uSimOrigin: { value: new THREE.Vector2(SIM_ORIGIN.x, SIM_ORIGIN.z) }, uSimExtent: { value: SIM_EXTENT },
        uTexel: { value: 1 / sim.size }, uAO: { value: aoTexture }, uAOOrigin: { value: new THREE.Vector2(AO_REGION.x0, AO_REGION.z0) }, uAOSize: { value: new THREE.Vector2(AO_REGION.w, AO_REGION.d) },
      },
      fHead: `
        uniform float uSimExtent, uTexel; uniform sampler2D uWaves, uAO; uniform vec2 uSimOrigin, uAOOrigin, uAOSize;
        ${NOISE_GLSL}
        // Pebbles: a jittered grid of rounded stones, each with its own size, colour and dome.
        vec4 pebbles(vec2 p, float scale) {
          vec2 g = p * scale;
          vec2 cell = floor(g), f = fract(g);
          float best = 10.0; vec2 bo = vec2(0.0); vec2 bc = vec2(0.0); float br = 0.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            vec2 hh = hash22(cell + o);
            vec2 c = o + 0.2 + hh * 0.6;
            float rad = 0.28 + 0.2 * hash21(cell + o + 3.7);
            float d = length(f - c) / rad;
            if (d < best) { best = d; bo = f - c; bc = cell + o; br = rad; }
          }
          float stone = smoothstep(1.0, 0.9, best);
          // Shade the dome: the slope faces the light on one side and away on the other.
          vec2 slope = bo / max(br, 1e-3);
          float dome = clamp(0.55 + 0.45 * sqrt(max(1.0 - best * best, 0.0)) - 0.35 * dot(slope, vec2(0.6, 0.8)), 0.1, 1.3);
          float tone = hash21(bc + 1.3);
          return vec4(stone, dome, tone, hash21(bc + 9.1));
        }
        vec3 bedColor(vec2 p) {
          float sandN = fbm(p * 1.5) * 0.5 + fbm(p * 7.0) * 0.5;
          float grain = hash21(floor(p * 400.0)) * 0.35 + 0.825;
          vec3 sand = mix(vec3(0.5, 0.44, 0.32), vec3(0.36, 0.32, 0.24), sandN) * grain;
          vec4 big = pebbles(p, 7.0);
          vec4 small = pebbles(p + 13.0, 18.0);
          // Granite greys, warm sandstone, the odd dark basalt and a pale quartz, each speckled.
          vec3 stoneCol = mix(mix(vec3(0.4, 0.38, 0.34), vec3(0.58, 0.5, 0.4), big.z), vec3(0.33, 0.34, 0.36), step(0.7, big.w));
          stoneCol = mix(stoneCol, vec3(0.22, 0.2, 0.19), step(0.88, big.w));
          stoneCol = mix(stoneCol, vec3(0.72, 0.68, 0.6), step(0.95, big.w));
          stoneCol *= 0.85 + 0.3 * fbm(p * 60.0 + big.z * 10.0);
          vec3 smallCol = mix(vec3(0.36, 0.33, 0.28), vec3(0.55, 0.5, 0.42), small.z) * (0.85 + 0.3 * fbm(p * 90.0));
          vec3 col = sand;
          col = mix(col, smallCol * small.y, small.x * 0.85);
          col = mix(col, stoneCol * big.y, big.x);
          // A film of algae in the hollows, greener farther out.
          float algae = smoothstep(0.45, 0.7, fbm(p * 0.6 + 7.0)) * (1.0 - big.x * 0.7);
          return mix(col, vec3(0.2, 0.3, 0.14), algae * 0.6);
        }`,
      fAfterMap: `
        {
          vec2 p = vWPos.xz;
          vec3 col = bedColor(p);
          // Caustics: the ripples focus the light where the surface is concave.
          vec2 suv = (p - uSimOrigin) / uSimExtent;
          float caustic = 1.0;
          if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float hc = texture2D(uWaves, suv).z;
            float hl = texture2D(uWaves, suv - vec2(uTexel * 2.0, 0.0)).z, hr = texture2D(uWaves, suv + vec2(uTexel * 2.0, 0.0)).z;
            float hd = texture2D(uWaves, suv - vec2(0.0, uTexel * 2.0)).z, hu = texture2D(uWaves, suv + vec2(0.0, uTexel * 2.0)).z;
            caustic = clamp(1.0 - (hl + hr + hd + hu - 4.0 * hc) * 220.0, 0.75, 1.5);
          }
          // Contact shadow: the bed is darker where rocks, logs and reed stems sit on it.
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
