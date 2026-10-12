// Loon Lake — The sky (dusk afterglow, thin cloud, Venus; stars, the Milky Way and the moon at
// night; a low grey ceiling in the rain), the far shore's pines and the ridges behind them, the
// mist lying on the water, and the rain itself.

import * as THREE from 'three';
import { TAU, rnd, randInt, clamp, lerp, smoothstep, fbm2, v3, unit, Art } from './util.js';
import { G, Q, NOISE_GLSL, FOG_HEAD, LAYER } from './shaders.js';

export const SKY_RADIUS = 7000;

// ---------------------------------------------------------------------------------------------
// The Milky Way, painted once onto an equirectangular canvas: a glowing core, cooler arms,
// dust lanes and the great rift (the same approach as Firefly Meadow's sky).
// ---------------------------------------------------------------------------------------------

const MILKY_WAY_NORMAL = v3(0.75, 0.6, 0.19).normalize();

function milkyWayCanvas(w = 1536, h = 768) {
  const N = MILKY_WAY_NORMAL;
  const T1 = unit(v3(0, 0, -1).sub(N.clone().multiplyScalar(-N.z)));
  const T2 = N.clone().cross(T1);
  return Art.image(w, h, (ctx) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const sat = (x) => clamp(x, 0, 1);
    for (let y = 0; y < h; y++) {
      const lat = (0.5 - (y + 0.5) / h) * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < w; x++) {
        const lon = ((x + 0.5) / w - 0.5) * TAU;
        const dx = cl * Math.cos(lon), dy = sl, dz = cl * Math.sin(lon);
        const b = dx * N.x + dy * N.y + dz * N.z;
        const along = Math.atan2(dx * T2.x + dy * T2.y + dz * T2.z, dx * T1.x + dy * T1.y + dz * T1.z);
        const core = Math.exp(-(b * b) / 0.012);
        const wide = Math.exp(-(b * b) / 0.09);
        const patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3);
        const knots = fbm2(along * 3.5, b * 14 + 3, 4);
        let haze = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots);
        const lanes = fbm2(along * 6 + 7, b * 26 + 1, 4);
        haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core;
        const riftCentre = 0.04 * Math.sin(along * 2.2 + 1) + 0.02 * Math.sin(along * 5.1);
        const rift = Math.exp(-Math.pow((b - riftCentre) / 0.03, 2)) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3));
        haze *= 1 - 0.7 * rift;
        const warmth = core * (0.35 + 0.65 * patches);
        let r = lerp(0.62, 1.0, warmth), g = lerp(0.72, 0.9, warmth), bl = lerp(1.0, 0.72, warmth);
        const pink = smoothstep(0.62, 0.8, fbm2(along * 3 + 11, b * 12 + 5, 3)) * core;
        const teal = smoothstep(0.64, 0.82, fbm2(along * 2.6 + 23, b * 10 + 17, 3)) * wide;
        r += pink * 0.5; g -= pink * 0.15; bl += pink * 0.1;
        g += teal * 0.35; bl += teal * 0.3; r -= teal * 0.15;
        const i = (y * w + x) * 4;
        d[i] = sat(r * haze * 0.9) * 255;
        d[i + 1] = sat(g * haze * 0.9) * 255;
        d[i + 2] = sat(bl * haze * 0.9) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

// ---------------------------------------------------------------------------------------------
// The sky dome
// ---------------------------------------------------------------------------------------------

export class Sky {
  constructor() {
    this.hazeTexture = Art.texture(milkyWayCanvas(), { srgb: false });
    this.hazeTexture.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uNight: G.uNight, uRain: G.uRain, uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uFogColor: G.uFogColor, uHaze: { value: this.hazeTexture } },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uNight, uRain; uniform vec3 uSunDir, uMoonDir, uFogColor; uniform sampler2D uHaze;
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
          float star = smoothstep(size, 0.0, dist) * bright * tw;
          star += exp(-dist * dist / 0.03) * bright * 0.12 * step(0.985, r1);
          return tint * star;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
          // How close in azimuth to where the sun went down.
          vec2 sa = normalize(uSunDir.xz), da = normalize(d.xz + vec2(1e-5, 0.0));
          float toSun = dot(sa, da) * 0.5 + 0.5;

          // Dusk, twenty minutes after sunset: an orange band where the sun went, pink and mauve
          // above it, violet-grey round the rest of the horizon, deep blue overhead.
          vec3 glowH = vec3(1.0, 0.52, 0.2), glowM = vec3(0.95, 0.5, 0.42), farH = vec3(0.5, 0.4, 0.52);
          vec3 horizon = mix(farH, glowH, pow(toSun, 2.5));
          vec3 mid = mix(vec3(0.4, 0.32, 0.5), glowM, pow(toSun, 3.0) * 0.85);
          vec3 zenith = vec3(0.05, 0.08, 0.2);
          vec3 dusk = mix(horizon, mid, smoothstep(0.0, 0.12, h));
          dusk = mix(dusk, zenith, smoothstep(0.06, 0.5, h));
          float sunGlow = exp(-max(h + 0.08, 0.0) * 7.0) * pow(toSun, 5.0);
          dusk += vec3(1.0, 0.55, 0.2) * sunGlow * 0.6;
          // The sun itself, low and swollen in the haze, with its glow around it.
          float cosS = dot(d, uSunDir);
          float glow = exp((cosS - 1.0) * 160.0) * 0.3 + exp((cosS - 1.0) * 1400.0) * 0.6 + pow(max(cosS, 0.0), 12.0) * 0.12;
          dusk += vec3(1.0, 0.6, 0.3) * glow;
          float disc = smoothstep(0.99982, 0.99993, cosS);
          dusk += vec3(2.0, 1.3, 0.75) * disc;
          // A yellow seam right on the horizon under the glow.
          dusk += vec3(1.0, 0.8, 0.35) * exp(-max(h, 0.0) * 40.0) * pow(toSun, 8.0) * 0.5;
          // Venus, the evening star, low over the glow.
          vec3 venusDir = normalize(vec3(uSunDir.x * 0.8 + 0.25, 0.2, uSunDir.z));
          float cosV = dot(d, venusDir);
          float venus = smoothstep(0.9999975, 0.9999995, cosV) * 2.5 + exp((cosV - 1.0) * 400000.0) * 0.5;
          dusk += vec3(1.0, 1.0, 0.95) * venus;
          // Thin bands of altostratus, lit underneath from the sunset side.
          vec2 cp = d.xz / max(h, 0.05);
          float band = fbm(vec2(cp.x * 0.22 + uTime * q(0.0025), cp.y * 1.6) * 1.1);
          float cloud = smoothstep(0.5, 0.74, band) * smoothstep(0.02, 0.14, h) * smoothstep(0.75, 0.25, h);
          vec3 cloudCol = mix(vec3(0.3, 0.26, 0.36), vec3(1.0, 0.62, 0.42), pow(toSun, 2.5) * smoothstep(0.35, 0.05, h)) + vec3(1.0, 0.5, 0.2) * glow * 0.4;
          dusk = mix(dusk, cloudCol, cloud * 0.7);
          // The first stars show at the zenith even at dusk.
          dusk += starLayer(uv, 380.0, 0.75, 1.5, 0.0) * smoothstep(0.2, 0.7, h) * 0.3;

          // Night: a dark vault, the Milky Way, three layers of stars, the moon's halo.
          vec3 night = mix(vec3(0.035, 0.045, 0.09), vec3(0.003, 0.005, 0.016), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          night += vec3(0.02, 0.045, 0.035) * exp(-max(h, 0.0) * 14.0) * 0.6;
          vec3 haze = texture2D(uHaze, uv).rgb;
          float hazeAmt = dot(haze, vec3(0.33));
          vec3 stars = starLayer(uv, 380.0, 0.75, 1.5, 0.0) + starLayer(uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                     + starLayer(uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt);
          night += haze * 0.3 + stars;
          float cosm = dot(d, uMoonDir);
          night += vec3(0.5, 0.6, 0.85) * (exp((cosm - 1.0) * 90.0) * 0.14 + exp((cosm - 1.0) * 600.0) * 0.35);

          vec3 col = mix(dusk, night, uNight);

          // Rain: a low grey ceiling scrolling over, darker where it is thick.
          vec2 rp = d.xz / max(h, 0.06) * 0.7 + vec2(uTime * q(0.012), uTime * q(0.004));
          float rc = fbm(rp);
          vec3 rainCol = mix(vec3(0.3, 0.32, 0.36), vec3(0.14, 0.15, 0.18), rc) * mix(1.0, 0.12, uNight);
          col = mix(col, rainCol, uRain * smoothstep(-0.02, 0.1, h));

          col = mix(col, uFogColor, smoothstep(0.1, -0.01, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 40), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.layers.enable(LAYER.ABOVE);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.hazeTexture.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The moon: NASA's Lunar Reconnaissance Orbiter colour map on a sphere, with the LRO height map
// shading the relief, lit by its own sun in the shader for a waxing gibbous. The maps are the
// ones Firefly Meadow uses (NASA Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720).
// ---------------------------------------------------------------------------------------------

export class Moon {
  constructor() {
    const dir = G.uMoonDir.value.clone();
    const distance = SKY_RADIUS * 0.97;
    const radius = distance * Math.tan(1.6 * Math.PI / 180);
    const loader = new THREE.TextureLoader();
    const base = new URL('../../../meadow/html/assets/', import.meta.url).href;
    this.colorMap = loader.load(base + 'lroc_color_2k.jpg');
    this.colorMap.colorSpace = THREE.SRGBColorSpace;
    this.colorMap.anisotropy = 8;
    this.bumpMap = loader.load(base + 'ldem_3_8bit.jpg');
    const toViewer = dir.clone().negate();
    const right = unit(dir.clone().cross(v3(0, 1, 0)));
    const sunDir = unit(right.multiplyScalar(0.9).add(toViewer.clone().multiplyScalar(0.5)).add(v3(0, 0.1, 0)));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.colorMap }, uBump: { value: this.bumpMap }, uSun: { value: sunDir }, uNight: G.uNight, uRain: G.uRain },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        varying vec2 vUv; varying vec3 vN, vT, vB;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          // Tangent frame for the bump: along u, along v.
          vec3 t = normalize(mat3(modelMatrix) * vec3(-sin(uv.x * 6.2831853), 0.0, cos(uv.x * 6.2831853)));
          vT = t; vB = normalize(cross(vN, t));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap, uBump; uniform vec3 uSun; uniform float uNight, uRain;
        varying vec2 vUv; varying vec3 vN, vT, vB;
        void main() {
          vec3 albedo = texture2D(uMap, vUv).rgb;
          float e = 1.0 / 2048.0;
          float hx = texture2D(uBump, vUv + vec2(e, 0.0)).r - texture2D(uBump, vUv - vec2(e, 0.0)).r;
          float hy = texture2D(uBump, vUv + vec2(0.0, e)).r - texture2D(uBump, vUv - vec2(0.0, e)).r;
          vec3 n = normalize(vN - vT * hx * 6.0 - vB * hy * 6.0);
          float lit = max(dot(n, uSun), 0.0);
          // Soft terminator and a whisper of earthshine on the dark side.
          float l = smoothstep(-0.02, 0.12, dot(normalize(vN), uSun)) * lit;
          vec3 col = albedo * (l * 2.4 + 0.03) * vec3(1.0, 0.98, 0.94);
          gl_FragColor = vec4(col, uNight * (1.0 - uRain * 0.95));
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.material);
    this.mesh.position.copy(dir).multiplyScalar(distance);
    this.mesh.quaternion.setFromUnitVectors(v3(1, 0, 0), toViewer);
    this.mesh.renderOrder = -5;
    this.mesh.layers.enable(LAYER.ABOVE);
  }

  update(night, rain) { this.mesh.visible = night * (1 - rain * 0.95) > 0.01; }

  dispose() { this.colorMap.dispose(); this.bumpMap.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Silhouettes: alpha-tested masks on planes, standing in the fog
// ---------------------------------------------------------------------------------------------

/** A single-channel mask texture from a canvas's alpha, flipped so row 0 is the bottom. */
function maskTexture(canvas) {
  const w = canvas.width, h = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) mask[dst + x] = rgba[(src + x) * 4 + 3];
  }
  const tex = new THREE.DataTexture(mask, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function silhouetteMaterial(tex, tint, nightTint, maxFog) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: tex }, uTint: { value: tint }, uNightTint: { value: nightTint }, uNight: G.uNight, uRain: G.uRain, uMaxFog: { value: maxFog }, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
    vertexShader: `varying vec2 vUv; varying float vDist; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uTint, uNightTint, uFogColor; uniform float uNight, uRain, uMaxFog, uFogNear, uFogFar;
      varying vec2 vUv; varying float vDist;
      void main() {
        if (texture2D(uMap, vUv).r < 0.5) discard;
        float f = min(pow(clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3), uMaxFog);
        f = max(f, uRain * 0.35 * clamp(vDist / 400.0, 0.0, 1.0));
        vec3 tint = mix(uTint, uNightTint, uNight);
        gl_FragColor = vec4(mix(tint, uFogColor, f), 1.0);
      }`,
  });
}

/**
 * A shore of conifers drawn in metres: trunks, drooping branches with needle tufts, the odd
 * broadleaf and dead snag, over a rocky bank. `px` pixels per metre.
 */
function pineShoreCanvas(widthM, heightM, px, dense = 1, taper = false) {
  const w = Math.round(widthM * px), h = Math.round(heightM * px);
  return Art.image(w, h, (ctx) => {
    ctx.setTransform(px, 0, 0, px, 0, 0);
    const W = widthM, H = heightM;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const line = (x0, y0, x1, y1, width) => { ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };
    // How much of the shore stands at x: 1 along its length, falling to nothing over the last
    // fifth when the shore is a point running out into the lake.
    const standing = (x) => (taper ? Math.pow(Math.max(0, Math.min(1, (W * 0.96 - x) / (W * 0.22))), 0.8) : 1);
    // The bank: boulders and a low shelf of rock at the waterline.
    const groundAt = (x) => H - (0.6 + fbm2(x / 30, 3.3, 3) * 1.6) * standing(x);
    ctx.beginPath();
    ctx.moveTo(0, H + 1);
    for (let x = 0; x <= W; x += 0.5) ctx.lineTo(x, groundAt(x));
    ctx.lineTo(W, H + 1);
    ctx.fill();
    for (let x = 0; x < W; x += rnd(1.5, 5)) {
      if (standing(x) < 0.05) continue;
      const g = groundAt(x), r = rnd(0.3, 1.1) * (0.4 + 0.6 * standing(x));
      ctx.beginPath(); ctx.ellipse(x, g + r * 0.3, r * rnd(1, 1.8), r, 0, 0, TAU); ctx.fill();
    }
    const conifer = (x, base, height) => {
      const fir = Math.random() < 0.35;
      const widest = fir ? 0.3 : 0.2;
      const tilt = rnd(-0.03, 0.03);
      const top = base - height;
      line(x, base, x + tilt * height, top, 0.1 + height * 0.014);
      for (let y = top + height * 0.05; y < base - height * 0.1; y += rnd(0.22, 0.4)) {
        const f = (y - top) / height;
        const cx = x + tilt * (base - y);
        for (const side of [-1, 1]) {
          if (Math.random() < 0.1) continue;
          const len = Math.pow(f, fir ? 0.85 : 1.1) * widest * height * rnd(0.7, 1.15) * (Math.random() < 0.05 ? 1.3 : 1);
          const droop = rnd(0.12, 0.5) * (0.4 + f);
          const ex = cx + side * Math.cos(droop) * len, ey = y + Math.sin(droop) * len;
          line(cx, y, ex, ey, 0.03 + len * 0.03);
          for (let s = 0.15; s < len; s += rnd(0.1, 0.22)) {
            const bx = cx + side * Math.cos(droop) * s, by = y + Math.sin(droop) * s;
            const tl = rnd(0.12, 0.32) * (0.5 + s / len);
            line(bx, by, bx + side * rnd(-0.05, 0.1), by + tl, 0.03);
            if (Math.random() < 0.5) line(bx, by, bx + side * rnd(0.05, 0.15), by + tl * 0.6, 0.025);
          }
        }
      }
      for (let k = 0; k < 4; k++) line(x + tilt * height, top + k * 0.12, x + tilt * height + rnd(-0.15, 0.15), top + k * 0.12 + rnd(0.05, 0.2), 0.025);
    };
    const snag = (x, base, height) => {
      const branch = (bx, by, a, len, width, depth) => {
        const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
        line(bx, by, ex, ey, width);
        if (depth === 0) return;
        for (let i = randInt(1, 3); i > 0; i--) branch(ex, ey, a + rnd(-0.8, 0.8), len * rnd(0.5, 0.7), Math.max(0.02, width * 0.6), depth - 1);
      };
      branch(x, base, -Math.PI / 2 + rnd(-0.1, 0.1), height * 0.4, 0.12 + height * 0.012, 5);
    };
    const birch = (x, base, height) => {
      const trunkH = height * rnd(0.35, 0.5);
      const ends = [];
      const limb = (bx, by, a, len, width, depth) => {
        const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
        line(bx, by, ex, ey, width);
        if (depth === 0) { ends.push([ex, ey, len]); return; }
        for (let i = randInt(2, 3); i > 0; i--) limb(ex, ey, a + rnd(-0.6, 0.6), len * rnd(0.5, 0.7), width * 0.6, depth - 1);
      };
      line(x, base, x + rnd(-0.1, 0.1), base - trunkH, 0.12 + height * 0.02);
      for (let i = randInt(3, 4); i > 0; i--) limb(x, base - trunkH, -Math.PI / 2 + rnd(-0.8, 0.8), height * rnd(0.2, 0.3), 0.06 + height * 0.008, 2);
      for (const [lx, ly, len] of ends) {
        const r = len * rnd(1.0, 1.6);
        for (let k = Math.round(r * r * 50); k > 0; k--) {
          const a = rnd(0, TAU), dd = Math.pow(Math.random(), 0.6) * r;
          dot(lx + Math.cos(a) * dd, ly + Math.sin(a) * dd * 0.85, rnd(0.06, 0.2) * (1.1 - 0.5 * dd / r));
        }
      }
    };
    for (let x = -4; x < W + 4; x += rnd(0.7, 1.8) / dense) {
      const k = standing(x);
      // Toward the tip the trees thin out and shrink: a few small ones, then bare rock.
      if (k < 0.12 || Math.random() > 0.3 + 0.7 * k) continue;
      const base = groundAt(x) + rnd(0, 0.5);
      const height = rnd(9, 20) * (0.85 + 0.3 * fbm2(x / 60, 0.7, 2)) * (Math.random() < 0.06 ? 1.35 : 1) * (0.25 + 0.75 * k);
      const roll = Math.random();
      if (roll < 0.78) conifer(x, base, height);
      else if (roll < 0.86) snag(x, base, height * 0.8);
      else birch(x, base, height * 0.75);
    }
    // Young trees and brush at the waterline.
    for (let x = -2; x < W + 2; x += rnd(1, 3)) if (standing(x) > 0.1) conifer(x, groundAt(x) + 0.4, rnd(1.5, 4) * (0.3 + 0.7 * standing(x)));
  });
}

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
      ctx.lineTo(x, h * (0.8 - big * 0.6 - fine * roughness));
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
}

export class Shore {
  /** @param {(d: number) => number} halfWidth  visible half-width `d` metres out. */
  constructor(halfWidth) {
    this.group = new THREE.Group();
    this.textures = [];
    this.materials = [];
    const add = (tex, tint, nightTint, maxFog, w, h, x, z) => {
      this.textures.push(tex);
      const mat = silhouetteMaterial(tex, tint, nightTint, maxFog);
      this.materials.push(mat);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.position.set(x, h / 2 - 0.02, z);
      mesh.layers.enable(LAYER.ABOVE);
      this.group.add(mesh);
    };
    // The far shore: a wall of pines 260 m across the water.
    const farZ = -260, farW = Math.max(300, halfWidth(-farZ) * 2.4), farH = 26;
    add(maskTexture(pineShoreCanvas(farW, farH, 8192 / farW)), v3(0.012, 0.022, 0.02), v3(0.002, 0.004, 0.006), 0.55, farW, farH, 0, farZ);
    // A wooded point running in from the left, nearer, so the shore has depth.
    const ptZ = -120, ptW = halfWidth(-ptZ) * 1.1, ptH = 22;
    add(maskTexture(pineShoreCanvas(ptW, ptH, 8192 / ptW, 1.2, true)), v3(0.008, 0.016, 0.014), v3(0.0015, 0.003, 0.005), 0.3, ptW, ptH, -halfWidth(-ptZ) * 0.95 - ptW * 0.5 + ptW * 0.55, ptZ);
    // Ridges beyond, dissolving into the haze.
    const ridges = [
      { z: -1800, w: 7000, h: 520, seed: 2.3, rough: 0.12, tint: v3(0.14, 0.13, 0.2), night: v3(0.004, 0.005, 0.01), maxFog: 0.5 },
      { z: -3000, w: 11000, h: 900, seed: 5.1, rough: 0.08, tint: v3(0.2, 0.17, 0.26), night: v3(0.006, 0.007, 0.014), maxFog: 0.68 },
      { z: -4600, w: 16000, h: 1500, seed: 9.7, rough: 0.05, tint: v3(0.26, 0.21, 0.3), night: v3(0.008, 0.009, 0.018), maxFog: 0.8 },
    ];
    for (const R of ridges) {
      const tex = Art.texture(ridgeCanvas(R.seed, R.rough));
      this.textures.push(tex);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: tex }, uTint: { value: R.tint }, uNightTint: { value: R.night }, uNight: G.uNight, uRain: G.uRain, uMaxFog: { value: R.maxFog }, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
        vertexShader: `varying vec2 vUv; varying float vDist; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform vec3 uTint, uNightTint, uFogColor; uniform float uNight, uRain, uMaxFog, uFogNear, uFogFar;
          varying vec2 vUv; varying float vDist;
          void main() {
            if (texture2D(uMap, vUv).a < 0.5) discard;
            float f = min(pow(clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3), uMaxFog);
            f = max(f, uRain * 0.85);
            gl_FragColor = vec4(mix(mix(uTint, uNightTint, uNight), uFogColor, f), 1.0);
          }`,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(R.w, R.h), mat);
      mesh.position.set(0, R.h / 2 - R.h * 0.2, R.z);
      mesh.layers.enable(LAYER.ABOVE);
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
// Mist lying on the far water, drifting with the breeze
// ---------------------------------------------------------------------------------------------

export class Mist {
  constructor(halfWidth) {
    this.group = new THREE.Group();
    this.texture = Art.texture(Art.blob(256));
    this.sprites = [];
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: true, opacity: rnd(0.05, 0.14) });
      const s = new THREE.Sprite(mat);
      const z = -rnd(60, 240);
      const x = rnd(-1, 1) * halfWidth(-z) * 1.2;
      const size = rnd(20, 70);
      s.position.set(x, size * 0.06, z);
      s.scale.set(size, size * rnd(0.12, 0.2), 1);
      s.userData.base = mat.opacity;
      s.userData.rate = rnd(0.3, 0.8);
      s.layers.enable(LAYER.ABOVE);
      this.group.add(s);
      this.sprites.push(s);
    }
    this.halfWidth = halfWidth;
  }

  update(dt, night, rain) {
    const col = G.uFogColor.value;
    const w = G.uWind.value;
    for (const s of this.sprites) {
      s.position.x += w.x * w.z * s.userData.rate * 0.6 * dt;
      s.position.z += w.y * w.z * s.userData.rate * 0.2 * dt;
      const lim = this.halfWidth(-s.position.z) * 1.3;
      if (s.position.x > lim) s.position.x = -lim;
      if (s.position.x < -lim) s.position.x = lim;
      if (s.position.z > -50) s.position.z = -240;
      if (s.position.z < -250) s.position.z = -60;
      s.material.opacity = s.userData.base * (1 - night * 0.5) * (1 + rain * 0.8);
      s.material.color.setRGB(col.x * 1.15 + 0.03, col.y * 1.15 + 0.03, col.z * 1.15 + 0.03);
    }
  }

  dispose() { this.texture.dispose(); for (const s of this.sprites) s.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Rain: streaks falling through a box around the viewer, wrapping as they go; each frame the
// lake is told where drops land so the near water dimples.
// ---------------------------------------------------------------------------------------------

export class Rain {
  constructor() {
    const n = 2200;
    this.box = { w: 36, h: 14, d: 40 };
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set([rnd(-this.box.w, this.box.w), rnd(0, this.box.h), rnd(-this.box.d, 2)], i * 3);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    this.texture = Art.texture(Art.streak(128));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uRain: G.uRain, uNight: G.uNight, uMap: { value: this.texture }, uBoxH: { value: this.box.h }, uWind: G.uWind, uFogColor: G.uFogColor },
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      vertexShader: `
        attribute float aSeed; uniform float uTime, uBoxH; uniform vec3 uWind;
        varying float vAlpha;
        void main() {
          // Each drop falls at about 6 m/s and wraps to the top of the box; the breeze slants it.
          float fall = 6.0 + aSeed * 2.0;
          float y = mod(position.y - uTime * fall, uBoxH);
          vec3 p = vec3(position.x + uWind.x * uWind.z * (uBoxH - y) * 0.15, y, position.z + uWind.y * uWind.z * (uBoxH - y) * 0.15);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = length(mv.xyz);
          gl_PointSize = clamp(260.0 / dist, 2.0, 40.0);
          vAlpha = clamp(1.6 - dist / 30.0, 0.15, 0.7);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uRain, uNight; uniform vec3 uFogColor; varying float vAlpha;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha * uRain;
          vec3 c = mix(vec3(0.75, 0.78, 0.85), vec3(0.2, 0.22, 0.3), uNight);
          gl_FragColor = vec4(c, a * 0.5);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  update(rain) { this.points.visible = rain > 0.005; }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); this.texture.dispose(); }
}
