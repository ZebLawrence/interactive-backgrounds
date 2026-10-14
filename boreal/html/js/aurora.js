// Boreal Night — The aurora borealis: curtains of light with rays, folds and a substorm cycle.
//
// The real thing: electrons stream down the Earth's magnetic field lines and make the upper
// atmosphere glow in a thin, tall sheet. Atomic oxygen gives the green line (557.7 nm) from about
// 100 to 200 km up, and the faint red line (630 nm) above that; in bright displays molecular
// nitrogen adds a pink-purple fringe along the sharp lower edge, near 100 km. The sheet is only a
// kilometre or so thick but hundreds of kilometres long, so it looks brightest where we see it
// edge on, in its folds. Rays are the field lines lit up, near vertical at high latitude.
//
// A substorm runs through phases (Akasofu): a quiet arc that slowly brightens and drifts toward
// the equator (growth), a sudden brightening and break-up into rapidly moving, folded, rayed
// curtains with a westward travelling surge (expansion), then a fading into diffuse pulsating
// patches (recovery). Real growth phases last half an hour; here the cycle is compressed to a
// few minutes, and the motion is kept slow enough to be peaceful.
//
// The geometry is built at a tenth of real size (100 km up becomes 10 km) with the Earth's
// curvature, so the arcs bow down toward the horizon at their ends just as real ones do.

import * as THREE from 'three';
import { TAU, rnd, pick, clamp, lerp, approach, v3 } from './util.js';
import { G } from './shaders.js';

const KM = 100;                 // scene metres per real kilometre
const EARTH_R = 6371 * KM;
const NOISE_PERIOD = 1024;      // the 1D noise repeats after this many cells, so phases can wrap

const GLSL = `
float h1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
// Value noise that repeats every ${NOISE_PERIOD}.0, so its phase accumulators can wrap invisibly.
float pn(float x) {
  float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f);
  return mix(h1(mod(i, ${NOISE_PERIOD}.0)), h1(mod(i + 1.0, ${NOISE_PERIOD}.0)), u);
}
`;

/** One curtain: a long vertical sheet whose path folds with time. */
class Curtain {
  constructor(cfg) {
    Object.assign(this, cfg);
    this.uniforms = {
      uZ0: { value: cfg.z0 },
      uLen: { value: cfg.len },
      uBase: { value: cfg.base },
      uHeight: { value: cfg.height },
      uSeed: { value: cfg.seed },
      uGaps: { value: cfg.gaps ?? 0.15 },
      uI: { value: 0.5 },
      uAct: { value: 0.2 },
      uPulse: { value: 0 },
      uFold: { value: new THREE.Vector4() },    // phases of the three fold scales, and the ray drift
      uFlow: { value: new THREE.Vector4() },    // ray noise phases (two scales), patch phase, pulsation phase
      uSurge: { value: new THREE.Vector3(0, 0, 0) }, // x of the surge head (m), amplitude, width (m)
    };
    const geo = new THREE.PlaneGeometry(1, 1, 900, 14);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: `
        uniform float uZ0, uLen, uBase, uHeight, uSeed, uAct;
        uniform vec4 uFold;
        varying float vX, vA, vGraze, vElev, vEnds;
        ${GLSL}
        // The curtain's path in plan, z as a function of x: a broad meander, smaller folds, and
        // tight folds and curls that grow with activity.
        float path(float x) {
          float k = x / ${KM * 10}.0;   // in units of 10 real km
          float z = ${KM * 16}.0 * sin(k * 0.21 + uFold.x + uSeed);
          z += (pn(k * 0.55 + uFold.y + uSeed * 7.0) - 0.5) * ${KM * 12}.0;
          z += (pn(k * 1.9 - uFold.z + uSeed * 3.0) - 0.5) * ${KM * 16}.0 * (0.25 + uAct);
          return uZ0 + z;
        }
        void main() {
          float u = uv.x, v = uv.y;
          float x = (u - 0.5) * uLen;
          float z = path(x);
          float dz = (path(x + 40.0) - path(x - 40.0)) / 80.0;
          // The lower edge wavers a little in height along the curtain.
          float base = uBase + (pn(x / ${KM * 30}.0 + uSeed * 5.0) - 0.5) * ${KM * 5}.0;
          float a = (v - 0.04) * uHeight;
          vec3 p = vec3(x, base + a, -z);
          // The Earth curves away: far parts of the arc sit lower.
          p.y -= (x * x + z * z) / ${2 * EARTH_R}.0;
          vec3 n = normalize(vec3(dz, 0.0, 1.0));
          vec3 view = p - cameraPosition;
          float dist = length(view);
          // Seen edge on, the line of sight runs a long way through the thin sheet.
          float c = abs(dot(n, view / dist));
          vGraze = 1.0 / max(c, 0.09);
          vX = x; vA = a; vEnds = u;
          vElev = view.y / dist;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uHeight, uSeed, uI, uAct, uPulse, uGaps;
        uniform vec4 uFlow;
        uniform vec3 uSurge;
        varying float vX, vA, vGraze, vElev, vEnds;
        ${GLSL}
        void main() {
          float s = vX / ${KM * 10}.0;      // along the curtain, in tens of real km
          // Rays: fine vertical striations a few km wide that drift along the curtain.
          float r1 = pn(s * 3.1 + uFlow.x);
          float r2 = pn(s * 9.7 - uFlow.y + 31.0);
          float r3 = pn(s * 23.0 + uFlow.x * 1.7 + 77.0);
          float rays = r1 * r1 * 0.55 + r2 * r2 * r2 * 0.75 + r3 * r3 * 0.35 * uAct;
          // Each ray reaches its own height; active curtains reach higher.
          float reach = uHeight * (0.25 + 0.5 * pn(s * 2.3 + uFlow.x * 0.5 + 13.0) + 0.2 * r2) * (0.6 + 0.55 * uAct);
          float a = vA;
          float edge = smoothstep(-${KM * 1.5}.0, ${KM * 2.5}.0, a);
          float fall = exp(-max(a, 0.0) / max(reach * 0.42, 1.0));
          float I = edge * fall * (0.35 + 1.4 * rays);
          // The lower border is the brightest part of a curtain: a band a few km deep.
          I += edge * exp(-max(a, 0.0) / ${KM * 9}.0) * (0.45 + 0.55 * r1);
          // Brighter and dimmer stretches along the arc; the far arcs break into pieces.
          float patchy = (0.35 - uGaps * 0.35) + 0.9 * smoothstep(0.15 + uGaps * 0.4, 0.75 + uGaps * 0.2, pn(s * 0.18 + uFlow.z + uSeed * 11.0));
          // Recovery: diffuse patches that pulse on and off every several seconds.
          float cell = floor(s * 0.6 + uSeed);
          float pulse = 0.5 + 0.5 * sin(uFlow.w * (0.6 + h1(cell) * 0.8) + h1(cell + 5.0) * 6.2831);
          patchy *= mix(1.0, 0.25 + 1.1 * smoothstep(0.35, 0.8, pulse), uPulse);
          // The westward travelling surge: a bright, active head moving along the arc.
          float surge = uSurge.y * exp(-pow((vX - uSurge.x) / uSurge.z, 2.0));
          float act = clamp(uAct + surge * 0.6, 0.0, 1.0);
          I *= patchy * (1.0 + surge * 1.1);

          float frac = a / uHeight;
          vec3 green = vec3(0.10, 1.0, 0.36);
          vec3 red = vec3(0.9, 0.08, 0.12);
          vec3 purple = vec3(0.95, 0.22, 0.78);
          vec3 col = green * (1.0 - smoothstep(0.28, 0.75, frac));
          col += red * smoothstep(0.3, 0.85, frac) * 0.22;
          // The nitrogen fringe hugs the lower edge when the aurora is active.
          col += purple * exp(-pow((a - ${KM * 2}.0) / ${KM * 3.5}.0, 2.0)) * act * act * 1.4;
          col *= I * uI;
          // Thin it near the very top of the sheet and at the ends of the arc.
          col *= 1.0 - smoothstep(0.8, 1.0, frac);
          col *= smoothstep(0.0, 0.12, vEnds) * smoothstep(1.0, 0.88, vEnds);
          // Low in the sky the light crosses more air: dimmer and a little warmer.
          float ext = smoothstep(-0.01, 0.16, vElev);
          col *= ext * mix(vec3(1.0, 0.8, 0.7), vec3(1.0), ext);
          col *= min(vGraze, 12.0) * 0.14;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // Phase accumulators (radians or noise cells).
    this.fold = [rnd(0, TAU), rnd(0, 100), rnd(0, 100)];
    this.flow = [rnd(0, 100), rnd(0, 100), rnd(0, 100), 0];
    this.i = 0.4;
    this.act = 0.2;
    this.pulse = 0;
    this.z = cfg.z0;
    this.surge = { x: 0, amp: 0, speed: 0 };
  }

  update(dt, target) {
    // Brightness rises fast at onset and fades slowly; everything else eases gently.
    this.i = approach(this.i, target.i * this.gain, target.i * this.gain > this.i ? target.rise : 14, dt);
    this.act = approach(this.act, target.act, 12, dt);
    this.pulse = approach(this.pulse, target.pulse, 20, dt);
    this.z = approach(this.z, this.z0 * target.zScale, 60, dt);
    // Motion: fold drift and ray flow speed up with activity (km/s real becomes slow arcs on screen).
    const a = this.act;
    const wrap = (x, p) => ((x % p) + p) % p;
    this.fold[0] = wrap(this.fold[0] + dt * (0.004 + 0.01 * a) * this.dir, TAU);
    this.fold[1] = wrap(this.fold[1] + dt * (0.006 + 0.03 * a) * this.dir, NOISE_PERIOD);
    this.fold[2] = wrap(this.fold[2] + dt * (0.01 + 0.08 * a * a), NOISE_PERIOD);
    this.flow[0] = wrap(this.flow[0] + dt * (0.03 + 0.25 * a) * this.dir, NOISE_PERIOD);
    this.flow[1] = wrap(this.flow[1] + dt * (0.05 + 0.4 * a * a), NOISE_PERIOD);
    this.flow[2] = wrap(this.flow[2] + dt * (0.004 + 0.012 * a), NOISE_PERIOD);
    this.flow[3] = wrap(this.flow[3] + dt * 0.7, TAU * 1000);
    // The surge head travels west (toward -x) and fades.
    const s = this.surge;
    if (s.amp > 0.001) {
      s.x -= s.speed * dt;
      s.amp *= Math.exp(-dt / 50);
      if (s.x < -this.len / 2) s.amp = 0;
    }
    const u = this.uniforms;
    u.uZ0.value = this.z;
    u.uI.value = this.i;
    u.uAct.value = this.act;
    u.uPulse.value = this.pulse;
    u.uFold.value.set(this.fold[0], this.fold[1], this.fold[2], 0);
    u.uFlow.value.set(this.flow[0], this.flow[1], this.flow[2], this.flow[3]);
    u.uSurge.value.set(s.x, s.amp, 6 * KM * 10);
  }

  startSurge(x, amp) {
    this.surge.x = x;
    this.surge.amp = Math.max(this.surge.amp, amp);
    // A westward travelling surge moves at a km or two per second; at a tenth scale that is
    // 100-200 m/s here, a slow glide across the sky from 200 km away.
    this.surge.speed = rnd(140, 220);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

const PHASES = {
  quiet: { i: 0.55, act: 0.12, pulse: 0, zScale: 1.0, rise: 20, dur: [150, 280] },
  growth: { i: 0.9, act: 0.28, pulse: 0, zScale: 0.92, rise: 25, dur: [60, 90] },
  expansion: { i: 1.45, act: 1.0, pulse: 0, zScale: 0.85, rise: 4, dur: [80, 120] },
  recovery: { i: 0.75, act: 0.35, pulse: 1, zScale: 0.95, rise: 10, dur: [100, 160] },
};
const NEXT = { quiet: 'growth', growth: 'expansion', expansion: 'recovery', recovery: 'quiet' };

export class Aurora {
  constructor() {
    this.group = new THREE.Group();
    // Three arcs at 180, 320 and 520 km to the north, the nearest the brightest.
    this.curtains = [
      new Curtain({ z0: 180 * KM, len: 1600 * KM, base: 100 * KM, height: 170 * KM, seed: rnd(0, 50), gain: 1.0, dir: 1 }),
      new Curtain({ z0: 330 * KM, len: 2000 * KM, base: 102 * KM, height: 150 * KM, seed: rnd(0, 50), gain: 0.5, dir: -1, gaps: 0.45 }),
      new Curtain({ z0: 520 * KM, len: 2400 * KM, base: 98 * KM, height: 140 * KM, seed: rnd(0, 50), gain: 0.35, dir: 1, gaps: 0.55 }),
    ];
    for (const c of this.curtains) this.group.add(c.mesh);
    this.phase = pick(['quiet', 'quiet', 'growth', 'recovery']);
    this.timer = rnd(...PHASES[this.phase].dur) * rnd(0.3, 0.7);
    this.light = v3();
  }

  get level() { return this.curtains.reduce((s, c) => s + c.i * c.gain, 0); }

  /** Jump to the break-up of a substorm. */
  substorm() {
    if (this.phase === 'expansion') { this.timer += 40; return; }
    this.enter('expansion');
  }

  enter(phase) {
    this.phase = phase;
    this.timer = rnd(...PHASES[phase].dur);
    if (phase === 'expansion') {
      // The break-up starts near local midnight, roughly overhead in front of us, and surges west.
      const c = this.curtains[0];
      c.startSurge(rnd(0, 300) * KM, 1.2);
      this.curtains[1].startSurge(rnd(100, 400) * KM, 0.8);
    }
  }

  /**
   * A click in the sky: a bright surge starts on the nearest arc where the click points, and runs
   * off west along it. `dir` is the world direction of the click.
   */
  flare(dir) {
    if (dir.y < 0.02) return;
    let best = null, bestD = Infinity;
    for (const c of this.curtains) {
      // Where the view ray reaches the curtain's mid height.
      const t = (c.base + c.height * 0.25) / dir.y;
      const p = dir.clone().multiplyScalar(t);
      const d = Math.abs(-p.z - c.z);
      if (d < bestD) { bestD = d; best = { c, x: p.x }; }
    }
    if (!best) return;
    best.c.startSurge(best.x, 1.0);
    best.c.i = Math.max(best.c.i, 0.9);
    if (this.phase === 'quiet') this.timer = Math.min(this.timer, 30);
  }

  update(dt, camera) {
    this.timer -= dt;
    if (this.timer <= 0) this.enter(NEXT[this.phase]);
    const target = PHASES[this.phase];
    for (const c of this.curtains) c.update(dt, target);
    // The light the aurora throws on the snow: mostly green, a hint of purple when it's active.
    const lvl = this.level;
    const act = this.curtains[0].act;
    this.light.set(0.08 + 0.12 * act, 1.0, 0.42 + 0.1 * act).multiplyScalar(Math.min(lvl, 2.5) * 0.024);
    G.uAuroraLight.value.copy(this.light);
  }

  dispose() { for (const c of this.curtains) c.dispose(); }
}

export const AURORA_KM = KM;
