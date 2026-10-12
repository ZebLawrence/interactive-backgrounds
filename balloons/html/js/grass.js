// Balloon Dawn — Long grass on the knoll in the foreground: instanced blades with a veined surface,
// bending in the prevailing wind and easing into the cursor's gusts, lit low and warm by the
// rising sun, casting and receiving its shadows.

import * as THREE from 'three';
import { TAU, rnd, fbm2, Art } from './util.js';
import { G, Q, FOG_HEAD } from './shaders.js';

function bladeGeometry(rows = 4) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    pos.push(-0.5, t, 0, 0.5, t, 0);
    uv.push(0, t, 1, t);
  }
  for (let r = 0; r < rows; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** The surface of a blade: a grooved midrib with raised edges, wandering veins and fine streaks. */
function bladeSurface() {
  const w = 128, h = 512;
  return Art.image(w, h, (ctx) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ang = y / h * TAU;
        const streak = fbm2(x * 0.09, Math.cos(ang) * 1.5, 3) * 0.6 + fbm2(x * 0.25 + 9, Math.sin(ang) * 1.5 + 4, 2) * 0.4;
        const v = 0.42 + 0.3 * streak;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.lineCap = 'round';
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const x0 = w / 2 + k * w * 0.1;
      ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.3 * (Math.abs(k) % 2)})`;
      ctx.lineWidth = Math.abs(k) % 2 ? 2.2 : 3.0;
      ctx.beginPath();
      for (let y = 0; y <= h; y += 8) ctx.lineTo(x0 + 1.5 * Math.sin(y / h * TAU * 2 + k), y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let y = 0; y <= h; y += 8) ctx.lineTo(x0 + 2.4 + 1.5 * Math.sin(y / h * TAU * 2 + k), y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(w / 2 - 3.5, 0, 7, h);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(w / 2 - 6, 0, 2.5, h);
    ctx.fillRect(w / 2 + 3.5, 0, 2.5, h);
  });
}

/** Bends a blade by wind and gust and returns its world position, normal and across vector. */
const BEND_VERTEX = `
attribute vec4 aInst; attribute vec4 aInst2;
uniform float uTime; uniform vec4 uGust;
${Q}
void bendBlade(out vec3 p, out vec3 n, out vec3 acrossOut, out float t, out float h, out float var) {
  t = position.y;
  vec3 base = aInst.xyz; h = aInst.w;
  float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z; var = aInst2.w;
  // Wind: slow waves rolling over the knoll, the cursor's gust (eased on the CPU), and a lean of its own.
  vec2 wdir = normalize(vec2(0.8, 0.4));
  float along = dot(base.xz, wdir);
  float wv = 0.5 + 0.4 * sin(uTime * q(0.45) - along * 0.3 + phase) + 0.25 * sin(uTime * q(1.1) - along * 0.8 + phase * 1.7);
  vec2 push = wdir * wv * 0.45 + uGust.xy * uGust.z * 0.55;
  push += vec2(cos(phase * 3.7), sin(phase * 2.9)) * 0.12;
  float mag = length(push);
  float ang = min(mag * (1.0 + 0.8 * var), 1.45);
  vec2 dir = mag > 1e-4 ? push / mag : vec2(1.0, 0.0);
  float a = ang * t;
  float along2, up;
  if (ang < 1e-3) { along2 = 0.0; up = h * t; } else { along2 = h * (1.0 - cos(a)) / ang; up = h * sin(a) / ang; }
  p = base + vec3(dir.x * along2, up, dir.y * along2);
  vec3 tangent = vec3(dir.x * sin(a), cos(a), dir.y * sin(a));
  vec3 across = vec3(cos(yaw), 0.0, sin(yaw));
  p += across * position.x * w * (1.0 - t * t * 0.9);
  // A blade bent flat along its own width has no face: fall back to pointing up rather than NaN.
  vec3 raw = cross(across, tangent);
  n = length(raw) > 1e-4 ? normalize(raw) : vec3(0.0, 1.0, 0.0);
  if (dot(n, cameraPosition - p) < 0.0) { n = -n; across = -across; }
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.3));
  acrossOut = across;
}
`;

export class Grass {
  /** @param {object} layout  { halfWidth(d), groundHeight(x, z) } */
  constructor(layout) {
    this.uGust = { value: new THREE.Vector4(0, 0, 0, 0) }; // (dir.x, dir.z, strength, unused)
    // Burners lighting the grass from afar: (x, y, z, intensity) for each of the valley's burner lights.
    this.uBurners = { value: Array.from({ length: 6 }, () => new THREE.Vector4()) };
    this.gustDir = new THREE.Vector2();
    this.gustStrength = 0;
    const near = 0.8, far = 80;
    const samples = [];
    let sum = 0;
    for (let d = near; d < far; d += 0.25) {
      const density = 170 / (1 + (d / 7) ** 2);
      const n = density * 2 * layout.halfWidth(d) * 0.25;
      samples.push({ d, n });
      sum += n;
    }
    const total = Math.min(70000, Math.round(sum));
    const inst = new Float32Array(total * 4), inst2 = new Float32Array(total * 4);
    let i = 0;
    for (const s of samples) {
      for (let k = Math.round(s.n * total / sum); k > 0 && i < total; k--, i++) {
        const d = s.d + rnd(0, 0.25);
        const hw = layout.halfWidth(d) * 1.3 + 2;
        const x = rnd(-hw, hw), z = -d;
        const clump = 0.5 + 0.5 * Math.sin(x * 0.7 + z * 0.5) * Math.cos(x * 0.3 - z * 0.6);
        const h = rnd(0.35, 0.8) * (0.75 + 0.5 * clump) * (1 + d / 45);
        inst.set([x, layout.groundHeight(x, z) - 0.03, z, h], i * 4);
        inst2.set([rnd(0.018, 0.036) * (1 + d / 35), rnd(0, TAU), rnd(0, TAU), Math.random()], i * 4);
      }
    }
    const geo = bladeGeometry(4);
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    geo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    geo.instanceCount = i;
    this.count = i;

    this.surface = Art.texture(bladeSurface(), { repeat: true, srgb: false });
    this.material = new THREE.ShaderMaterial({
      lights: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {
        uTime: G.uTime, uNight: G.uNight, uSunDir: G.uSunDir, uGust: this.uGust, uSurface: { value: null },
        uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
      }]),
      side: THREE.DoubleSide,
      vertexShader: `
        #include <common>
        #include <shadowmap_pars_vertex>
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vAcross; varying vec2 vUv; varying float vVar; varying float vLen;
        ${BEND_VERTEX}
        void main() {
          vec3 p, n, across; float t, h, var;
          bendBlade(p, n, across, t, h, var);
          vWorld = p; vNormal = n; vAcross = across; vUv = vec2(position.x + 0.5, t); vVar = var; vLen = h;
          vec4 worldPosition = vec4(p, 1.0);
          vec4 mvPosition = viewMatrix * worldPosition;
          vec3 transformedNormal = (viewMatrix * vec4(n, 0.0)).xyz;
          #include <shadowmap_vertex>
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: `
        #include <common>
        #include <packing>
        #include <shadowmap_pars_fragment>
        uniform float uNight; uniform vec3 uSunDir; uniform sampler2D uSurface; uniform vec4 uBurners[6];
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vAcross; varying vec2 vUv; varying float vVar; varying float vLen;
        ${FOG_HEAD}
        void main() {
          float t = vUv.y;
          vec3 root = vec3(0.03, 0.06, 0.025);
          vec3 tip = mix(vec3(0.16, 0.3, 0.1), vec3(0.3, 0.34, 0.12), vVar);
          tip = mix(tip, vec3(0.42, 0.34, 0.14), step(0.85, vVar) * 0.7);
          vec3 albedo = mix(root, tip, t * t);
          // Veins and midrib from the surface map; its slope tilts the normal across the blade.
          vec2 suv = vec2(vUv.x, t * vLen * 2.5 + vVar * 3.0);
          float hgt = texture2D(uSurface, suv).r;
          float slope = texture2D(uSurface, suv + vec2(0.03, 0.0)).r - texture2D(uSurface, suv - vec2(0.03, 0.0)).r;
          albedo *= 0.3 + 1.3 * hgt;
          vec3 n = normalize(vNormal + vAcross * slope * 4.0);
          // The sun's shadow map.
          float shadow = 1.0;
          #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
            DirectionalLightShadow s = directionalLightShadows[0];
            shadow = getShadow(directionalShadowMap[0], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[0]);
          #endif
          float ndl = max(dot(n, uSunDir), 0.0);
          vec3 sunCol = vec3(1.0, 0.72, 0.45) * (1.0 - uNight);
          // Low sun: a warm key light, backlight glowing through the thin tips, cool sky fill.
          vec3 sun = sunCol * (ndl * 1.7 + pow(max(-dot(n, uSunDir), 0.0), 2.0) * t * 1.2) * shadow;
          vec3 sky = mix(vec3(0.4, 0.45, 0.65) * 0.45, vec3(0.05, 0.06, 0.12), uNight);
          float ao = 0.3 + 0.7 * t;
          vec3 c = albedo * (sun + sky) * ao;
          // A glint of sunlight along the ridges of the veins.
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 hv = normalize(uSunDir + viewDir);
          c += sunCol * pow(max(dot(n, hv), 0.0), 18.0) * 0.22 * shadow * t * (0.5 + hgt);
          // Burners across the valley catch the blades: a warm highlight where the burner's light
          // reflects off a blade toward the eye, plus a gentle glow on faces turned toward it.
          vec3 burnerCol = vec3(1.0, 0.62, 0.28);
          for (int i = 0; i < 6; i++) {
            vec4 L = uBurners[i];
            if (L.w <= 0.0) continue;
            vec3 toL = L.xyz - vWorld;
            float d = length(toL);
            vec3 l = toL / max(d, 0.1);
            float fall = L.w / (1.0 + d * d / 12000.0);
            vec3 hb = normalize(l + viewDir);
            float spec = pow(max(dot(n, hb), 0.0), 28.0) * (0.6 + hgt);
            float diff = max(dot(n, l), 0.0);
            c += burnerCol * (spec * 1.5 + diff * 0.12 * albedo.g * 4.0) * fall * (0.3 + 0.7 * t) * mix(0.5, 1.3, uNight);
          }
          c = applyFog(c, length(vWorld - cameraPosition));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    // UniformsUtils.merge clones its inputs, so re-point the shared uniforms at the live objects.
    Object.assign(this.material.uniforms, {
      uTime: G.uTime, uNight: G.uNight, uSunDir: G.uSunDir, uGust: this.uGust, uSurface: { value: this.surface }, uBurners: this.uBurners,
      uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // The same bending for the sun's shadow pass.
    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uGust: this.uGust },
      side: THREE.DoubleSide,
      vertexShader: `
        #include <common>
        ${BEND_VERTEX}
        void main() {
          vec3 p, n, across; float t, h, var;
          bendBlade(p, n, across, t, h, var);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        #include <packing>
        void main() { gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }`,
    });
    this.mesh.customDepthMaterial = this.depthMaterial;
  }

  /** Ease toward the cursor's gust: it builds over a second or so and dies away more slowly. */
  update(dt, dir, strength) {
    const target = new THREE.Vector2(dir.x, dir.z).multiplyScalar(strength);
    const rate = target.length() > this.gustStrength ? 1.6 : 0.6;
    const k = 1 - Math.exp(-dt * rate);
    this.gustDir.lerp(target, k);
    this.gustStrength = this.gustDir.length();
    const d = this.gustStrength > 1e-4 ? this.gustDir.clone().divideScalar(this.gustStrength) : new THREE.Vector2(1, 0);
    this.uGust.value.set(d.x, d.y, this.gustStrength, 0);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.depthMaterial.dispose(); this.surface.dispose(); }
}
