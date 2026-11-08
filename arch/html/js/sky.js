// Sandstone Arch — The night sky over Glen Canyon: a Bortle-1 vault with the Milky Way and
// thousands of stars, airglow at the horizon, a moon low behind the viewer's left shoulder that
// lights the bridge, and the aurora's curtains (aurora.js) standing over it to the north; and the
// light state that sets the shared uniforms from the moon and the aurora.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, fbm2, v3, unit, approach, Art } from './util.js';
import { G, Q, NOISE_GLSL, LAYER } from './shaders.js';
import { RealSky } from 'realsky';

export const SKY_RADIUS = 8000;

export const MILKY_WAY_NORMAL = v3(0.62, 0.55, 0.56).normalize();

/**
 * Where the canyon is, for the real sky's turn: Glen Canyon, 37 degrees north, with north toward -z, where
 * the aurora's curtains stand (aurora.js). North is fixed by the aurora rather than solved for from the
 * painted band, so the sky wheels about a pole 37 degrees up in the north, as it does over Utah.
 *
 * That leaves the band where Utah really has it rather than where the painter put it. The galactic core sits
 * at declination -29, so from 37 north it culminates 24 degrees above the southern horizon and no higher:
 * the painted band, steep and overhead, was never a sky this canyon could have. So the start is chosen by
 * the hour instead (realsky.js, bestAngleForView): the core stays in the south behind the viewer, where Utah
 * keeps it, and the hour chosen is the one that stands the band at its highest across the view north, so
 * the Milky Way arches over the bridge through Cygnus and Cassiopeia. The frame only shows the sky from
 * the cliff tops to about 30 degrees up, so the arc is aimed at 24, inside that strip, not at the zenith
 * where it would be out of shot.
 */
export const CELESTIAL = { latitude: 37, north: -Math.PI / 2, bandAltitude: 24 };

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
        const bulge = Math.exp(-Math.pow((along - 0.9) / 0.9, 2));
        haze *= 1 + 1.4 * bulge;
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

export class Sky {
  constructor() {
    this.hazeTexture = Art.texture(milkyWayCanvas(), { srgb: false });
    this.hazeTexture.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uAurora: G.uAurora, uMoonDir: G.uMoonDir, uMoonI: { value: 1 }, uFogColor: G.uFogColor, uHaze: { value: this.hazeTexture }, uAuroraLight: G.uAuroraLight, uRain: G.uRain, uFlash: G.uFlash, uProcedural: { value: 1 } },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uAurora, uMoonI, uRain, uProcedural; uniform vec3 uMoonDir, uFogColor, uAuroraLight; uniform vec4 uFlash; uniform sampler2D uHaze;
        varying vec3 vDir;
        ${NOISE_GLSL}${Q}
        vec3 starLayer(vec2 uv, float cells, float threshold, float gain, float seed) {
          vec2 g = uv * vec2(cells * 2.0, cells);
          vec2 cell = floor(g), f = fract(g);
          float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
          if (r1 < threshold) return vec3(0.0);
          float dist = length(f - (vec2(r2, r3) * 0.7 + 0.15));
          float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
          float tw = 0.78 + 0.22 * sin(uTime * q(0.8 + r3 * 2.5) + r2 * 6.2831);
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
          // The vault: a deep blue-black, greener low down where the aurora's light scatters.
          vec3 night = mix(vec3(0.02, 0.035, 0.07), vec3(0.003, 0.005, 0.014), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          night += vec3(0.02, 0.035, 0.03) * exp(-max(h, 0.0) * 12.0) * 0.6;
          night += uAuroraLight * 0.5 * exp(-max(h, 0.0) * 3.0);
          // The painted band and the hashed stars stand in until the real sky arrives (realsky.js draws
          // that one); once it has, uProcedural is 0 and none of this is paid for.
          if (uProcedural > 0.001) {
            vec3 haze = texture2D(uHaze, uv).rgb;
            float hazeAmt = dot(haze, vec3(0.33));
            vec3 stars = starLayer(uv, 380.0, 0.75, 1.5, 0.0) + starLayer(uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                       + starLayer(uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt) + starLayer(uv, 2600.0, 0.93, 0.15, 23.0) * (0.3 + 2.5 * hazeAmt);
            // Under a bright aurora the fainter stars and the Milky Way wash out.
            float wash = 1.0 - 0.6 * clamp(uAurora, 0.0, 1.0);
            night += (haze * 0.3 * wash + stars * (0.6 + 0.4 * wash)) * uProcedural;
          }
          float cosm = dot(d, uMoonDir);
          night += vec3(0.6, 0.6, 0.75) * (exp((cosm - 1.0) * 90.0) * 0.12 + exp((cosm - 1.0) * 600.0) * 0.3) * uMoonI;
          vec3 col = night;
          // Rain: a lid of grey cloud slides over the vault, drifting on the wind, lit from
          // within where the lightning is and faintly everywhere by each flash.
          if (uRain > 0.001) {
            vec2 cp = d.xz / max(h, 0.08) * 0.9 + vec2(uTime * 0.01, 0.0);
            float cloud = fbm(cp);
            vec3 grey = vec3(0.025, 0.03, 0.045) * (0.5 + 1.1 * cloud);
            // Lit from within by the lightning, hardest round the bolt.
            float near = exp((dot(d, uFlash.xyz) - 1.0) * 6.0);
            grey += vec3(0.6, 0.66, 0.9) * uFlash.w * (0.15 + 0.6 * cloud) * (0.35 + 0.65 * near);
            float lid = uRain * smoothstep(-0.02, 0.15, h);
            col = mix(col, grey, lid);
          }
          col = mix(col, uFogColor, smoothstep(0.04, -0.01, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 40), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.layers.enable(LAYER.ABOVE);

    // The real sky, turning at the sidereal rate, inside the painted dome. Both of its parts go in the
    // reflection's layer too, so the band and the stars lie on the water under the bridge.
    this.real = new RealSky({
      latitude: CELESTIAL.latitude, north: CELESTIAL.north,
      viewAzimuth: CELESTIAL.north, viewAltitude: CELESTIAL.bandAltitude,
      radius: SKY_RADIUS, horizon: [-0.01, 0.06],
    });
    for (const o of [this.real.map, this.real.stars]) o.layers.enable(LAYER.ABOVE);
    this.reveal = 0;
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.real.group);
  }

  /** Starts fetching the real Milky Way and star catalogue; the painted sky stands in until they land. */
  load(renderer) { return this.real.load(renderer); }

  /**
   * Turns the real sky and cross-fades it in as it arrives. A bright aurora washes the faint stars and the
   * band out, as it did before, and the storm's lid of cloud takes the sky away entirely.
   */
  update(dt, aurora, rain) {
    this.reveal += clamp(this.real.ready - this.reveal, -dt * 0.5, dt * 0.5);
    this.material.uniforms.uProcedural.value = 1 - this.reveal;
    this.real.setFade(this.reveal * (1 - 0.45 * clamp(aurora, 0, 1)) * (1 - rain * 0.95));
    this.real.update(dt);
  }

  /** Point sprites are in device pixels; Low Power keeps the brightest quarter of the catalogue. */
  setPixelRatio(ratio, lowPower = false) {
    this.real.setPixelRatio(ratio);
    this.real.setStarFraction(lowPower ? 0.25 : 1);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.hazeTexture.dispose(); this.real.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The moon: NASA's LRO colour map on a sphere with the LRO height map for relief, lit by its own
// sun for a waxing gibbous. (NASA Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
// ---------------------------------------------------------------------------------------------

export class Moon {
  constructor() {
    const dir = G.uMoonDir.value.clone();
    const distance = SKY_RADIUS * 0.95;
    const radius = distance * Math.tan(0.6 * Math.PI / 180);
    const loader = new THREE.TextureLoader();
    const base = new URL('../assets/', import.meta.url).href;
    this.colorMap = loader.load(base + 'lroc_color_2k.jpg');
    this.colorMap.colorSpace = THREE.SRGBColorSpace;
    this.colorMap.anisotropy = 8;
    this.bumpMap = loader.load(base + 'ldem_3_8bit.jpg');
    const toViewer = dir.clone().negate();
    const right = unit(dir.clone().cross(v3(0, 1, 0)));
    const sunDir = unit(right.multiplyScalar(0.9).add(toViewer.clone().multiplyScalar(0.55)).add(v3(0, 0.1, 0)));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.colorMap }, uBump: { value: this.bumpMap }, uSun: { value: sunDir }, uOpacity: { value: 1 } },
      transparent: true, depthWrite: false,
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
          float l = smoothstep(-0.02, 0.12, dot(normalize(vN), uSun)) * lit;
          gl_FragColor = vec4(albedo * (l * 3.0 + 0.02) * vec3(1.0, 0.98, 0.94), uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.material);
    this.mesh.position.copy(dir).multiplyScalar(distance);
    this.mesh.quaternion.setFromUnitVectors(v3(1, 0, 0), toViewer);
    this.mesh.renderOrder = -5;
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(LAYER.ABOVE);
  }

  update(on) {
    this.material.uniforms.uOpacity.value = on;
    this.mesh.visible = on > 0.01;
  }

  dispose() { this.colorMap.dispose(); this.bumpMap.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The light: eases the moon and the aurora toward the settings and sets the shared uniforms.
// The moon is drawn stronger and warmer than a real one, as the reference image has it: a
// low gibbous moon behind the viewer's left shoulder, raking the bridge and the cliffs.
// ---------------------------------------------------------------------------------------------

const mix3 = (a, b, t) => v3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

export class Light {
  /** Starts where the settings have it, so nothing shows at load that was switched off. */
  constructor(settings = null) {
    this.moon = settings && !settings.moonlight ? 0 : 1;
    this.aurora = settings && !settings.aurora ? 0 : 1;
  }

  update(dt, settings, out, auroraLevel) {
    this.moon = approach(this.moon, settings.moonlight ? 1 : 0, 2.5, dt);
    this.aurora = approach(this.aurora, settings.aurora ? 1 : 0, 3, dt);
    G.uAurora.value = this.aurora;
    const aur = this.aurora * clamp(auroraLevel, 0, 2.5) / 2.5;
    out.sky = mix3(v3(0.07, 0.085, 0.15), v3(0.08, 0.2, 0.12), aur * 0.7);
    out.ground = v3(0.04, 0.03, 0.03);
    out.hemi = 1.7 + 0.8 * aur;
    out.key = v3(1.0, 0.72, 0.46);
    out.keyI = 1.3 * this.moon;
    out.bounce = v3(0.9, 0.55, 0.3);
    out.bounceI = 0.12 * this.moon;
    out.fog = mix3(v3(0.006, 0.009, 0.018), v3(0.01, 0.03, 0.02), aur * 0.6);
    out.fogNear = 120;
    out.fogFar = 900;
    G.uKeyDir.value.copy(G.uMoonDir.value);
    G.uKeyColor.value.copy(out.key);
    G.uKeyI.value = out.keyI;
    G.uSkyLight.value.copy(out.sky).multiplyScalar(out.hemi / Math.PI);
    G.uBounceLight.value.copy(out.bounce).multiplyScalar(out.bounceI);
    G.uFogColor.value.copy(out.fog);
    G.uFogNear.value = out.fogNear;
    G.uFogFar.value = out.fogFar;
    return out;
  }
}
