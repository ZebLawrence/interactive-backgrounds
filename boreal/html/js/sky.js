// Boreal Night — The winter sky (stars, a faint Milky Way, airglow), the moon and shooting stars.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, fbm2, v3, unit, Art } from './util.js';
import { G, Q, NOISE_GLSL } from './shaders.js';

// The sky sits beyond the aurora, which is drawn at a tenth of its real size (see aurora.js).
export const SKY_RADIUS = 150000;

// ---------------------------------------------------------------------------------------------
// Sky dome. The Milky Way is painted once onto an equirectangular canvas (the same painter as
// Firefly Meadow's, with its band tilted for a winter evening); the stars are hashed in the
// shader so they stay crisp at any resolution, each with its own colour and size.
// ---------------------------------------------------------------------------------------------

/** The plane of the galaxy, tilted so the band crosses the sky in front of the viewer. */
const MILKY_WAY_NORMAL = v3(-0.55, 0.62, 0.56).normalize();

let milkyWayCache = null;

/** Painted once per page load (it takes a moment) and reused by every new night. */
function milkyWayCanvas(w = 1024, h = 512) {
  if (milkyWayCache) return milkyWayCache;
  milkyWayCache = paintMilkyWay(w, h);
  return milkyWayCache;
}

function paintMilkyWay(w, h) {
  const N = MILKY_WAY_NORMAL;
  // A basis in the plane of the band, to measure position along it.
  const T1 = unit(v3(0, 0, -1).sub(N.clone().multiplyScalar(N.z * -1)));
  const T2 = N.clone().cross(T1);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
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
      // Mottled brightness along the band, big patches and finer knots.
      const patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3);
      const knots = fbm2(along * 3.5, b * 14 + 3, 4);
      let haze = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots);
      // Dust: dark lanes threaded through the core, and the great rift down its middle.
      const lanes = fbm2(along * 6 + 7, b * 26 + 1, 4);
      haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core;
      const riftCentre = 0.04 * Math.sin(along * 2.2 + 1) + 0.02 * Math.sin(along * 5.1);
      const rift = Math.exp(-Math.pow((b - riftCentre) / 0.03, 2)) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3));
      haze *= 1 - 0.7 * rift;
      // Colour: a warm bulge, cooler blue-white arms, with pink and teal nebulae here and there.
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
  return canvas;
}

export class Sky {
  constructor() {
    this.hazeTexture = Art.texture(milkyWayCanvas(), { srgb: false });
    this.hazeTexture.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: G.uTime, uMoon: G.uMoon, uMoonDir: G.uMoonDir, uFogColor: G.uFogColor, uAuroraLight: G.uAuroraLight,
        uHaze: { value: this.hazeTexture },
      },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uMoon; uniform vec3 uMoonDir, uFogColor, uAuroraLight; uniform sampler2D uHaze;
        varying vec3 vDir;
        ${NOISE_GLSL}${Q}
        // One layer of stars on a grid of cells: most faint and white, a few bright, each with its
        // own colour from blue-white through yellow to orange, and a soft halo on the brightest.
        vec3 starLayer(vec2 uv, float cells, float threshold, float gain, float seed) {
          vec2 g = uv * vec2(cells * 2.0, cells);
          vec2 cell = floor(g), f = fract(g);
          float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
          if (r1 < threshold) return vec3(0.0);
          vec2 off = vec2(r2, r3) * 0.7 + 0.15;
          float dist = length(f - off);
          float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
          // Cold air twinkles hard near the horizon and hardly at all overhead.
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
          vec3 zenith = vec3(0.002, 0.003, 0.010);
          vec3 horizon = vec3(0.018, 0.026, 0.055);
          vec3 col = mix(horizon, zenith, pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          // Faint green airglow low on the horizon (oxygen at 557.7 nm, the aurora's own line).
          col += vec3(0.012, 0.03, 0.02) * exp(-max(h, 0.0) * 12.0);
          // The aurora lights the whole sky a little.
          col += uAuroraLight * 0.05 * (0.4 + 0.6 * exp(-max(h, 0.0) * 3.0));

          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
          vec3 haze = texture2D(uHaze, uv).rgb;
          float hazeAmt = dot(haze, vec3(0.33));
          vec3 stars = starLayer(uv, 380.0, 0.75, 1.5, 0.0)
                     + starLayer(uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                     + starLayer(uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt);
          // Moonlight washes out the faint stars and most of the Milky Way.
          col += haze * 0.22 * (1.0 - uMoon * 0.6);
          col += stars * (1.0 - uMoon * 0.35) * smoothstep(-0.02, 0.08, h);

          // The moon's halo, and a hint of the 22-degree ice halo in cold air.
          float cosm = dot(d, uMoonDir);
          float halo = exp((cosm - 1.0) * 90.0) * 0.05 + exp((cosm - 1.0) * 900.0) * 0.25;
          float ring = exp(-pow((acos(clamp(cosm, -1.0, 1.0)) - 0.384) / 0.012, 2.0)) * 0.012;
          col += vec3(0.5, 0.6, 0.85) * (halo + ring) * uMoon;

          // Fade into the fog just above the horizon, so the land meets the sky seamlessly.
          col = mix(col, uFogColor, smoothstep(0.05, -0.01, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.hazeTexture.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The moon: a sphere wrapped in NASA's Lunar Reconnaissance Orbiter colour map, with its height
// map as a bump map, lit by its own sun so the phase and the relief along the terminator are
// real. (Maps: NASA's Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
// ---------------------------------------------------------------------------------------------

export class Moon {
  constructor() {
    this.group = new THREE.Group();
    const dir = G.uMoonDir.value.clone();
    const distance = SKY_RADIUS * 0.9;
    // Drawn about twice its real size, as the eye remembers it low over the trees.
    const radius = distance * Math.tan(0.55 * Math.PI / 180);
    const loader = new THREE.TextureLoader();
    const base = new URL('../assets/', import.meta.url).href;
    this.colorMap = loader.load(base + 'lroc_color_2k.jpg');
    this.colorMap.colorSpace = THREE.SRGBColorSpace;
    this.colorMap.anisotropy = 8;
    this.bumpMap = loader.load(base + 'ldem_3_8bit.jpg');
    const toViewer = dir.clone().negate();
    // The moon's own sun, off to the left and a little toward us: a waning gibbous. It is a uniform
    // of the moon's shader rather than a scene light, so it lights the moon and nothing else.
    const right = unit(dir.clone().cross(v3(0, 1, 0)));
    const sunDir = unit(right.multiplyScalar(-0.9).add(toViewer.clone().multiplyScalar(0.62)).add(v3(0, 0.1, 0)));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.colorMap }, uBump: { value: this.bumpMap }, uSun: { value: sunDir }, uOpacity: { value: 1 } },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vRel;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vRel = wp.xyz - cameraPosition;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D uMap, uBump; uniform vec3 uSun; uniform float uOpacity;
        varying vec2 vUv; varying vec3 vN; varying vec3 vRel;
        void main() {
          vec3 albedo = texture2D(uMap, vUv).rgb;
          // Bump the normal with the height map so craters stand out along the terminator.
          float h = texture2D(uBump, vUv).r;
          vec3 sx = dFdx(vRel), sy = dFdy(vRel), n = normalize(vN);
          vec3 r1 = cross(sy, n), r2 = cross(n, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2) * 1.4;
          n = normalize(abs(det) * n - grad);
          float lit = max(dot(n, uSun), 0.0);
          gl_FragColor = vec4(albedo * (lit * 3.2 + 0.012), uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.material);
    this.mesh.position.copy(dir).multiplyScalar(distance);
    this.mesh.quaternion.setFromUnitVectors(v3(1, 0, 0), toViewer);
    this.mesh.renderOrder = -5;
    this.group.add(this.mesh);
  }

  update(moon) {
    this.material.uniforms.uOpacity.value = clamp(moon, 0, 1);
    this.mesh.visible = moon > 0.01;
  }

  dispose() {
    this.colorMap.dispose();
    this.bumpMap.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Shooting stars: a streak that crosses a few degrees of sky in half a second, now and then
// ---------------------------------------------------------------------------------------------

export class Meteors {
  constructor() {
    const tex = Art.image(256, 16, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.75, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const s = ctx.createLinearGradient(0, 0, 0, h);
      s.addColorStop(0, 'rgba(0,0,0,1)');
      s.addColorStop(0.5, 'rgba(0,0,0,0)');
      s.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, w, h);
    });
    this.texture = Art.texture(tex);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      color: new THREE.Color(1.6, 1.7, 2.0),
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.timer = rnd(10, 30);
    this.active = null;
  }

  update(dt) {
    const R = SKY_RADIUS * 0.8;
    if (this.active) {
      const a = this.active;
      a.t += dt;
      const k = a.t / a.duration;
      if (k >= 1) { this.active = null; this.mesh.visible = false; return; }
      const head = unit(a.start.clone().addScaledVector(a.dir, a.travel * k)).multiplyScalar(R);
      const tangent = unit(a.dir.clone().sub(head.clone().multiplyScalar(a.dir.dot(head) / head.lengthSq())));
      const normal = unit(head.clone().negate());
      const side = unit(tangent.clone().cross(normal));
      this.mesh.matrix.makeBasis(tangent, side, normal);
      this.mesh.matrix.setPosition(head.clone().addScaledVector(tangent, -a.length * R / 2));
      this.mesh.matrix.scale(v3(a.length * R, a.width * R, 1));
      this.material.opacity = Math.sin(k * Math.PI) * 0.9;
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = rnd(12, 40);
    const az = rnd(-0.8, 0.8), el = rnd(0.45, 0.9);
    const start = v3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const dir = v3(rnd(-1, 1), rnd(-0.9, -0.3), rnd(-0.4, 0.4)).normalize();
    // Sizes as fractions of the sky radius (a streak a few degrees long).
    this.active = { start, dir, t: 0, duration: rnd(0.35, 0.6), travel: rnd(0.06, 0.12), length: rnd(0.03, 0.06), width: rnd(0.001, 0.0018) };
    this.mesh.visible = true;
  }

  dispose() { this.texture.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}
