// Aspen Snow — The sky: a snowing overcast by default, the cloud breaking for a low winter sun
// in Sunlight mode, and a starry night with a moon in Night mode; and the weather state that
// drives the shared light uniforms.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, v3, unit, approach, Art } from './util.js';
import { G, Q, NOISE_GLSL } from './shaders.js';

export const SKY_RADIUS = 8000;

// ---------------------------------------------------------------------------------------------
// Sky dome. Overcast: a pale grey stratus, brighter toward the hidden sun and the horizon, its
// mottling drifting slowly. Sun: the cloud thins into broken cumulus over blue, with the sun's
// disc and glare. Night: a deep blue, stars hashed in the shader, and the moon's halo.
// ---------------------------------------------------------------------------------------------

export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: G.uTime, uSun: G.uSun, uNight: G.uNight, uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uFogColor: G.uFogColor, uSnowing: G.uSnowing,
      },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uSun, uNight, uSnowing; uniform vec3 uSunDir, uMoonDir, uFogColor;
        varying vec3 vDir;
        ${NOISE_GLSL}${Q}
        vec3 starLayer(vec2 uv, float cells, float threshold, float gain, float seed) {
          vec2 g = uv * vec2(cells * 2.0, cells);
          vec2 cell = floor(g), f = fract(g);
          float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
          if (r1 < threshold) return vec3(0.0);
          vec2 off = vec2(r2, r3) * 0.7 + 0.15;
          float dist = length(f - off);
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
          // Cloud texture: slow-drifting stratus mottling, in a sky-centred projection.
          vec2 cuv = d.xz / (abs(h) + 0.25);
          float drift = uTime * q(0.004);
          float strat = fbm(cuv * 1.6 + vec2(drift, drift * 0.4)) * 0.6 + fbm(cuv * 5.0 - vec2(drift * 0.7, 0.0)) * 0.4;
          float cosS = dot(d, uSunDir);

          // --- Overcast: flat pale grey, a little darker overhead, brightest low and toward the sun.
          vec3 ovHorizon = vec3(0.56, 0.58, 0.62);
          vec3 ovZenith = vec3(0.30, 0.33, 0.39);
          vec3 overcast = mix(ovHorizon, ovZenith, pow(clamp(h * 1.2, 0.0, 1.0), 0.6));
          overcast *= 0.9 + 0.22 * (strat - 0.5);
          overcast += vec3(0.16, 0.15, 0.13) * exp((cosS - 1.0) * 6.0) * (0.5 + 0.5 * strat);
          // Falling snow: the sky goes to a flat, very light grey, the cloud lost in the flakes.
          overcast = mix(overcast, vec3(0.70, 0.71, 0.74) * (0.96 + 0.08 * strat), uSnowing * 0.85);

          // --- Broken cloud and sun: blue sky with cumulus, sunlit on their sunward edges.
          vec3 blue = mix(vec3(0.42, 0.55, 0.78), vec3(0.14, 0.26, 0.58), pow(clamp(h * 1.3, 0.0, 1.0), 0.7));
          float cum = smoothstep(0.42, 0.6, fbm(cuv * 2.2 + vec2(drift * 1.5, 7.0)) + 0.15 * strat - 0.1 * uSun);
          vec3 cloudCol = mix(vec3(0.5, 0.52, 0.58), vec3(1.05, 1.0, 0.95), 0.4 + 0.6 * clamp(cosS, 0.0, 1.0));
          vec3 sunny = mix(blue, cloudCol, cum * 0.85);
          float disc = exp((cosS - 1.0) * 2200.0) * 12.0 + exp((cosS - 1.0) * 60.0) * 0.5 + exp((cosS - 1.0) * 8.0) * 0.25;
          sunny += vec3(1.0, 0.95, 0.85) * disc * (1.0 - cum * 0.85);
          // Haze near the horizon.
          sunny = mix(sunny, vec3(0.7, 0.72, 0.76), smoothstep(0.3, -0.02, h) * 0.75);

          vec3 day = mix(overcast, sunny, uSun);

          // --- Night: deep blue, stars, the moon's halo and a hint of the 22-degree ice halo.
          vec3 night = mix(vec3(0.012, 0.018, 0.04), vec3(0.002, 0.004, 0.012), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
          vec3 stars = starLayer(uv, 380.0, 0.75, 1.2, 0.0) + starLayer(uv, 760.0, 0.84, 0.6, 5.0) + starLayer(uv, 1400.0, 0.9, 0.3, 11.0);
          night += stars * smoothstep(-0.02, 0.08, h) * (1.0 - cum * 0.9 * (1.0 - uSun) * 0.0);
          float cosM = dot(d, uMoonDir);
          float halo = exp((cosM - 1.0) * 90.0) * 0.05 + exp((cosM - 1.0) * 900.0) * 0.25;
          float ring = exp(-pow((acos(clamp(cosM, -1.0, 1.0)) - 0.384) / 0.012, 2.0)) * 0.012;
          night += vec3(0.5, 0.6, 0.85) * (halo + ring);
          // Snow cloud at night: the stars dim behind the overcast, the cloud faintly moonlit.
          vec3 nightCloud = vec3(0.02, 0.025, 0.04) * (0.7 + 0.6 * strat) + vec3(0.06, 0.07, 0.1) * exp((cosM - 1.0) * 6.0);
          night = mix(nightCloud, night, uSun);

          vec3 col = mix(day, night, uNight);
          // Fade into the haze just above the horizon, so the far grove meets the sky seamlessly.
          col = mix(col, uFogColor, smoothstep(0.06, -0.01, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
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
    // Drawn about twice its real size, as the eye remembers it over the trees.
    const radius = distance * Math.tan(0.55 * Math.PI / 180);
    const loader = new THREE.TextureLoader();
    const base = new URL('../assets/', import.meta.url).href;
    this.colorMap = loader.load(base + 'lroc_color_2k.jpg');
    this.colorMap.colorSpace = THREE.SRGBColorSpace;
    this.colorMap.anisotropy = 8;
    this.bumpMap = loader.load(base + 'ldem_3_8bit.jpg');
    const toViewer = dir.clone().negate();
    // The moon's own sun, off to the right and a little toward us: a waxing gibbous.
    const right = unit(dir.clone().cross(v3(0, 1, 0)));
    const sunDir = unit(right.multiplyScalar(0.9).add(toViewer.clone().multiplyScalar(0.62)).add(v3(0, 0.1, 0)));
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

  update(night, sun) {
    // The moon shows at night when the cloud has broken (Sunlight mode doubles as a clear sky).
    const a = clamp(night, 0, 1) * clamp(sun, 0, 1);
    this.material.uniforms.uOpacity.value = a;
    this.mesh.visible = a > 0.01;
  }

  dispose() {
    this.colorMap.dispose();
    this.bumpMap.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Weather: eases the sun and night amounts toward the settings, with the overcast thinning and
// thickening on its own, and sets the shared light and fog uniforms from them.
// ---------------------------------------------------------------------------------------------

export class Weather {
  constructor() {
    this.t = rnd(0, 1000);
    this.sun = 0;
    this.night = 0;
    this.thin = 0;            // 0..1, the overcast thinning a little now and then
  }

  /** Linear colours of the light in each state. */
  static LIGHT = {
    overcast: { sky: v3(0.70, 0.73, 0.80), ground: v3(0.62, 0.64, 0.68), hemi: 2.6, key: v3(0.9, 0.9, 0.92), keyI: 0.3, fog: v3(0.56, 0.58, 0.62) },
    sunny: { sky: v3(0.46, 0.58, 0.82), ground: v3(0.72, 0.74, 0.78), hemi: 2.0, key: v3(1.0, 0.92, 0.80), keyI: 3.2, fog: v3(0.66, 0.70, 0.78) },
    night: { sky: v3(0.05, 0.065, 0.12), ground: v3(0.045, 0.05, 0.07), hemi: 0.9, key: v3(0.7, 0.78, 1.0), keyI: 0.75, fog: v3(0.006, 0.008, 0.014) },
  };

  update(dt, settings, out, snowing = 0) {
    this.t += dt;
    // The cloud thins and thickens over minutes; in Sunlight mode the sun comes and goes a little too.
    const wobble = Math.sin(this.t * 0.011) * Math.sin(this.t * 0.0073 + 1.1);
    this.thin = approach(this.thin, 0.5 + 0.5 * wobble, 20, dt);
    const sunTarget = settings.sunlight ? 0.8 + 0.2 * this.thin : 0.08 * this.thin;
    this.sun = approach(this.sun, sunTarget, 5, dt);
    this.night = approach(this.night, settings.night ? 1 : 0, 2.5, dt);
    G.uSun.value = this.sun;
    G.uNight.value = this.night;
    const L = Weather.LIGHT;
    const mix3 = (a, b, t) => v3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
    const day = {
      sky: mix3(L.overcast.sky, L.sunny.sky, this.sun), ground: mix3(L.overcast.ground, L.sunny.ground, this.sun),
      hemi: lerp(L.overcast.hemi, L.sunny.hemi, this.sun), key: mix3(L.overcast.key, L.sunny.key, this.sun),
      keyI: lerp(L.overcast.keyI, L.sunny.keyI, this.sun), fog: mix3(L.overcast.fog, L.sunny.fog, this.sun),
    };
    // At night the moon is the key light; under cloud it is only a glow.
    const nightKeyI = L.night.keyI * (0.03 + 0.97 * this.sun);
    const nightHemi = L.night.hemi * (0.6 + 0.4 * this.sun);
    out.sky = mix3(day.sky, L.night.sky, this.night);
    out.ground = mix3(day.ground, L.night.ground, this.night);
    out.hemi = lerp(day.hemi, nightHemi, this.night);
    out.sunColor = day.key; out.sunI = day.keyI * (1 - this.night);
    out.moonColor = L.night.key; out.moonI = nightKeyI * this.night;
    // Falling snow lightens and thickens the haze by day, and greys the dark at night a little.
    const snowFog = v3(0.70, 0.71, 0.74), snowNightFog = v3(0.02, 0.023, 0.03);
    const dayFog = mix3(day.fog, snowFog, snowing * (1 - this.sun * 0.5));
    const nightFog = mix3(L.night.fog, snowNightFog, snowing);
    out.fog = mix3(dayFog, nightFog, this.night);
    G.uSnowing.value = snowing;
    G.uSkyLight.value.copy(out.sky).multiplyScalar(out.hemi / Math.PI);
    G.uFogColor.value.copy(out.fog);
    G.uKeyDir.value.copy(this.night > 0.5 ? G.uMoonDir.value : G.uSunDir.value);
    return out;
  }
}
