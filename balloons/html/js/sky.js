// Balloon Dawn — The sky (dawn gradient, sun, cirrus; stars at night), the mountain ridges on the
// horizon, and the mist banks lying over the valley.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, fbm2, v3, Art } from './util.js';
import { G, Q, NOISE_GLSL, FOG_HEAD } from './shaders.js';

export const SKY_RADIUS = 7000;

export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uNight: G.uNight, uSunDir: G.uSunDir, uFogColor: G.uFogColor },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uNight; uniform vec3 uSunDir, uFogColor;
        varying vec3 vDir;
        ${NOISE_GLSL}${Q}
        vec3 starLayer(vec2 uv, float cells, float threshold, float gain, float seed) {
          vec2 g = uv * vec2(cells * 2.0, cells);
          vec2 cell = floor(g), f = fract(g);
          float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
          if (r1 < threshold) return vec3(0.0);
          float dist = length(f - (vec2(r2, r3) * 0.7 + 0.15));
          float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
          float tw = 0.75 + 0.25 * sin(uTime * q(0.8 + r3 * 2.5) + r2 * 6.2831);
          vec3 tint = r4 < 0.22 ? vec3(0.72, 0.82, 1.0) : r4 < 0.6 ? vec3(0.95, 0.96, 1.0) : r4 < 0.86 ? vec3(1.0, 0.9, 0.72) : vec3(1.0, 0.72, 0.5);
          float size = 0.07 + 0.12 * pow(bright / (gain + 0.03), 0.5);
          return tint * smoothstep(size, 0.0, dist) * bright * tw;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float cosS = dot(d, uSunDir);

          // Dawn: warm at the horizon, violet through the middle, deep blue overhead, with the sun's glow.
          vec3 horizon = uFogColor * 1.15, mid = vec3(0.45, 0.38, 0.58), zenith = vec3(0.07, 0.15, 0.4);
          vec3 dawn = mix(horizon, mid, smoothstep(0.0, 0.14, h));
          dawn = mix(dawn, zenith, smoothstep(0.08, 0.45, h));
          float glow = exp((cosS - 1.0) * 90.0) * 0.55 + exp((cosS - 1.0) * 900.0) * 0.9 + pow(max(cosS, 0.0), 10.0) * 0.18;
          dawn += vec3(1.0, 0.7, 0.4) * glow;
          float disc = smoothstep(0.99985, 0.99994, cosS);
          dawn += vec3(3.2, 2.4, 1.6) * disc;
          // Cirrus: streaks blown across the upper sky, lit from the sun's side.
          vec2 cp = d.xz / max(h, 0.04);
          float c = fbm(vec2(cp.x * 0.35 + uTime * q(0.003), cp.y * 1.4) * 1.2);
          float cir = smoothstep(0.48, 0.78, c) * smoothstep(0.03, 0.18, h) * smoothstep(0.9, 0.3, h) * 0.65;
          vec3 cirCol = mix(vec3(0.72, 0.5, 0.52), vec3(1.0, 0.88, 0.72), clamp(glow * 1.5, 0.0, 1.0));
          dawn = mix(dawn, cirCol, cir);

          // Night: a dark blue vault full of stars.
          vec3 night = mix(vec3(0.05, 0.07, 0.14), vec3(0.008, 0.012, 0.04), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
          night += starLayer(uv, 380.0, 0.75, 1.5, 0.0) + starLayer(uv, 760.0, 0.84, 0.8, 5.0);

          vec3 col = mix(dawn, night, uNight);
          col = mix(col, uFogColor, smoothstep(0.1, -0.01, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 40), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Mountains: three ridges, each a silhouette dissolving into the haze
// ---------------------------------------------------------------------------------------------

function ridgeCanvas(seed, roughness) {
  const w = 4096, h = 512;
  return Art.image(w, h, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) {
      const t = x / w;
      const big = fbm2(t * 5 + seed, seed * 1.7, 4);
      const fine = fbm2(t * 60 + seed * 3, seed, 4) - 0.5;
      const y = h * (0.78 - big * 0.55 - fine * roughness);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
}

export class Mountains {
  constructor() {
    this.group = new THREE.Group();
    this.textures = [];
    this.materials = [];
    const layers = [
      { z: -2600, w: 9000, h: 800, seed: 1.3, rough: 0.14, tint: v3(0.07, 0.08, 0.15), maxFog: 0.3 },
      { z: -3900, w: 13000, h: 1300, seed: 4.1, rough: 0.09, tint: v3(0.09, 0.1, 0.19), maxFog: 0.5 },
      { z: -5400, w: 17000, h: 2000, seed: 8.7, rough: 0.05, tint: v3(0.11, 0.12, 0.22), maxFog: 0.66 },
    ];
    for (const L of layers) {
      const tex = Art.texture(ridgeCanvas(L.seed, L.rough));
      this.textures.push(tex);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: tex }, uTint: { value: L.tint }, uNight: G.uNight, uMaxFog: { value: L.maxFog }, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
        vertexShader: `varying vec2 vUv; varying float vDist; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform vec3 uTint; uniform float uNight, uMaxFog; varying vec2 vUv; varying float vDist;
          ${FOG_HEAD}
          void main() {
            if (texture2D(uMap, vUv).a < 0.5) discard;
            float f = min(pow(clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3), uMaxFog);
            vec3 tint = mix(uTint, vec3(0.006, 0.008, 0.016), uNight);
            gl_FragColor = vec4(mix(tint, uFogColor, f), 1.0);
          }`,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(L.w, L.h), mat);
      mesh.position.set(0, L.h / 2 - L.h * 0.22, L.z);
      this.group.add(mesh);
    }
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.group.children.forEach((c) => c.geometry.dispose());
  }
}

// ---------------------------------------------------------------------------------------------
// Mist banks over the valley floor
// ---------------------------------------------------------------------------------------------

export class Mist {
  constructor(groundHeight) {
    this.group = new THREE.Group();
    this.texture = Art.texture(Art.blob(256));
    this.sprites = [];
    for (let i = 0; i < 34; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: true, opacity: rnd(0.14, 0.3) });
      const s = new THREE.Sprite(mat);
      const z = -rnd(260, 2400), x = rnd(-1, 1) * (300 + -z * 0.6);
      s.position.set(x, groundHeight(x, z) + rnd(15, 45), z);
      const size = rnd(220, 620);
      s.scale.set(size, size * rnd(0.12, 0.22), 1);
      s.userData.base = mat.opacity;
      s.userData.rate = rnd(0.4, 1.2);
      this.group.add(s);
      this.sprites.push(s);
    }
  }

  update(dt, night) {
    const col = G.uFogColor.value;
    for (const s of this.sprites) {
      s.position.x += s.userData.rate * dt;
      const limit = 300 + -s.position.z * 0.6;
      if (s.position.x > limit + 300) s.position.x = -limit - 300;
      s.material.opacity = s.userData.base * (1 - night * 0.55);
      s.material.color.setRGB(col.x * 1.1 + 0.05, col.y * 1.1 + 0.05, col.z * 1.1 + 0.05);
    }
  }

  dispose() {
    this.texture.dispose();
    for (const s of this.sprites) s.material.dispose();
  }
}
