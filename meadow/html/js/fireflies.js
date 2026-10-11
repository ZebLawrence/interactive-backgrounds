// Firefly Meadow — Four species of firefly, each with its own flash and way of flying; their
// behaviour (wander, flee a fast cursor, gather round a resting one, fall into step, hide from
// rain) and the point sprites that draw them.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, pick, smoothstep, v3, unit, RGBA } from './util.js';
import { G, LIGHT_N } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Species. Flash patterns follow the real insects: the Big Dipper's slow rising "J", the Smokies'
// synchronous firefly's burst of quick flashes then darkness, Photuris's fast double flicker,
// and the blue ghost's faint steady glow low in the grass.
// ---------------------------------------------------------------------------------------------

export const FireflySpecies = {
  dipper: {
    id: 'dipper', name: 'Big Dipper', color: new RGBA(0.88, 1.0, 0.40),
    count: 48, speed: 0.28, agility: 1.1, height: [0.3, 1.6], period: [5.2, 7.0],
    light: 0.7, curious: 0.4, sync: false, zone: [1.5, 20],
  },
  synchronous: {
    id: 'synchronous', name: 'Synchronous', color: new RGBA(0.98, 1.0, 0.50),
    count: 64, speed: 0.33, agility: 1.4, height: [0.4, 2.0], period: [8.5, 9.5],
    light: 0.55, curious: 0.85, sync: true, zone: [1.5, 22],
  },
  photuris: {
    id: 'photuris', name: 'Photuris', color: new RGBA(0.62, 1.0, 0.62),
    count: 20, speed: 0.6, agility: 2.0, height: [1.0, 3.2], period: [2.6, 3.6],
    light: 0.45, curious: 0.25, sync: false, zone: [2, 28],
  },
  ghost: {
    id: 'ghost', name: 'Blue ghost', color: new RGBA(0.66, 0.78, 1.0),
    count: 16, speed: 0.12, agility: 0.7, height: [0.08, 0.45], period: [18, 30],
    light: 0.7, curious: 0.15, sync: false, zone: [1.2, 14],
  },
};
FireflySpecies.all = [FireflySpecies.dipper, FireflySpecies.synchronous, FireflySpecies.photuris, FireflySpecies.ghost];

/** Brightness 0..1 of a species' lantern at `phase` (0..1 through its cycle). */
export function flashPattern(species, phase) {
  switch (species.id) {
    case 'dipper': {
      // One long flash, ~0.6 s of a 6 s cycle, swelling then fading.
      const u = phase / 0.1;
      return u < 1 ? Math.pow(Math.sin(u * Math.PI), 1.3) : 0;
    }
    case 'synchronous': {
      // Six quick flashes half a second apart, then dark for the rest of the cycle.
      const burst = phase / 0.34;
      if (burst >= 1) return 0;
      const u = (burst * 6) % 1;
      return u < 0.3 ? Math.sin(u / 0.3 * Math.PI) : 0;
    }
    case 'photuris': {
      const p1 = phase / 0.04, p2 = (phase - 0.08) / 0.04;
      if (p1 >= 0 && p1 < 1) return Math.sin(p1 * Math.PI);
      if (p2 >= 0 && p2 < 1) return Math.sin(p2 * Math.PI) * 0.8;
      return 0;
    }
    case 'ghost':
      return 0.26 + 0.12 * Math.sin(phase * TAU);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// One firefly
// ---------------------------------------------------------------------------------------------

export class Firefly {
  constructor(species, meadow) {
    this.species = species;
    this.pos = v3();
    this.vel = v3();
    this.goal = v3();
    this.goalTimer = 0;
    this.phase = Math.random();
    this.period = rnd(...species.period);
    this.mode = 'wander';
    this.fleeDir = v3();
    this.fleeTimer = 0;
    this.dark = 0;
    this.clapFlash = 0;
    this.gatherRolled = false;
    this.gatherOffset = v3();
    this.gatherTimer = 0;
    this.gatherDepth = 0;
    this.bobPhase = rnd(0, TAU);
    this.bobRate = rnd(0.8, 1.6);
    this.brightness = 0;
    this.coupling = 0;
    this.sumSin = 0;
    this.neighbours = 0;
    // Each firefly keeps to its own stretch of the meadow.
    const [near, far] = species.zone;
    const mid = rnd(near + 1, far - 1);
    this.zMin = -Math.min(far, mid + rnd(3, 8));
    this.zMax = -Math.max(near, mid - rnd(3, 8));
    this.pos.copy(this.randomPoint(meadow));
    this.goal.copy(this.randomPoint(meadow));
  }

  randomPoint(meadow) {
    const z = rnd(this.zMin, this.zMax);
    const hw = meadow.halfWidth(-z) * 0.9;
    const x = rnd(-hw, hw);
    const [lo, hi] = this.species.height;
    return v3(x, meadow.groundHeight(x, z) + rnd(lo, hi), z);
  }

  /** Lantern on: the pattern unless it's been scared dark, or a clap set it off. */
  updateLantern(dt, storm) {
    this.dark = Math.max(0, this.dark - dt);
    this.clapFlash = Math.max(0, this.clapFlash - dt);
    let b = this.dark > 0 ? 0 : flashPattern(this.species, this.phase);
    if (this.clapFlash > 0) b = Math.max(b, Math.sin(Math.min(1, this.clapFlash / 0.35) * Math.PI));
    // In the rain they shelter in the grass and barely glow.
    b *= 1 - storm * 0.92;
    this.brightness = b;
  }

  update(dt, meadow, swarm) {
    const sp = this.species;
    const cursor = meadow.cursor;
    const storm = meadow.storm;
    const scr = meadow.project(this.pos);
    const distPx = cursor.present ? Math.hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y) : Infinity;

    // A fast cursor nearby: dart away from its line of sight and go dark for a while.
    if (cursor.present && cursor.speed > 350 && this.mode !== 'flee') {
      const radius = (90 + Math.min(cursor.speed, 2500) * 0.08) / (1 + scr.depth / 14);
      if (distPx < radius) this.startle(meadow.closestPointOnCursorRay(this.pos), 1.0 + rnd(0, 0.8), 2.5);
    }
    if (cursor.speed > 120) this.gatherRolled = false;

    if (storm > 0.5 && this.mode !== 'flee') this.mode = 'hide';
    else if (this.mode === 'hide' && storm <= 0.5) this.mode = 'wander';

    // A resting cursor: curious ones drift over to hover around it.
    if (this.mode === 'wander' && cursor.present && cursor.stillTime > 0.8 && !this.gatherRolled) {
      this.gatherRolled = true;
      const near = distPx < meadow.screenW * 0.45 ? 1 : 0.15;
      if (swarm.gathered < swarm.gatherCap && Math.random() < sp.curious * near) {
        this.mode = 'gather';
        this.gatherDepth = clamp(this.pos.z, -12, -1.8);
        this.gatherTimer = 0;
      }
    }
    if (this.mode === 'gather' && !cursor.present) this.mode = 'wander';

    // Where to head.
    let speed = sp.speed, agility = sp.agility;
    switch (this.mode) {
      case 'wander':
        this.goalTimer -= dt;
        if (this.goalTimer <= 0 || this.pos.distanceTo(this.goal) < 0.3) {
          this.goal.copy(this.randomPoint(meadow));
          this.goalTimer = rnd(5, 12);
        }
        break;
      case 'gather': {
        this.gatherTimer -= dt;
        if (this.gatherTimer <= 0) {
          this.gatherTimer = rnd(1.5, 4);
          const r = rnd(0.3, 1.1);
          const a = rnd(0, TAU), e = rnd(-0.6, 0.6);
          this.gatherOffset.set(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
        }
        const c = meadow.cursorPointAtDepth(this.gatherDepth);
        this.goal.copy(c).add(this.gatherOffset);
        const minY = meadow.groundHeight(this.goal.x, this.goal.z) + 0.2;
        if (this.goal.y < minY) this.goal.y = minY;
        speed = Math.max(sp.speed, 0.55);
        agility = sp.agility + 0.6;
        break;
      }
      case 'flee':
        this.fleeTimer -= dt;
        this.goal.copy(this.pos).addScaledVector(this.fleeDir, 3);
        speed = 1.8;
        agility = 4;
        if (this.fleeTimer <= 0) { this.mode = 'wander'; this.goalTimer = 0; }
        break;
      case 'hide':
        this.goal.set(this.pos.x, meadow.groundHeight(this.pos.x, this.pos.z) + 0.1, this.pos.z);
        speed = 0.35;
        break;
    }

    // Steer: ease the velocity toward where we want to go, slowing on arrival.
    const toGoal = this.goal.clone().sub(this.pos);
    const dist = toGoal.length();
    const desired = dist > 1e-4 ? toGoal.multiplyScalar(Math.min(speed, dist * 1.5) / dist) : v3();
    // Soft walls: the meadow's visible edges and the ground.
    const hw = meadow.halfWidth(-this.pos.z) * 0.95;
    if (this.pos.x > hw) desired.x -= (this.pos.x - hw) * 2;
    if (this.pos.x < -hw) desired.x += (-hw - this.pos.x) * 2;
    if (this.pos.z > this.zMax) desired.z -= (this.pos.z - this.zMax) * 2;
    if (this.pos.z < this.zMin) desired.z += (this.zMin - this.pos.z) * 2;
    const floor = meadow.groundHeight(this.pos.x, this.pos.z) + 0.06;
    if (this.pos.y < floor) desired.y += (floor - this.pos.y) * 6;
    this.vel.lerp(desired, Math.min(1, dt * agility));

    // The lantern.
    if (sp.sync) {
      // Kuramoto coupling with neighbours, worked out by the swarm; stronger when gathered.
      const k = (0.35 + (this.mode === 'gather' ? 1.4 : 0)) / TAU;
      this.phase += dt * (1 / this.period + (this.neighbours ? k * this.sumSin / this.neighbours : 0));
    } else {
      this.phase += dt / this.period;
    }
    this.phase -= Math.floor(this.phase);
    this.updateLantern(dt, storm);
    // The Big Dipper climbs as it flashes, drawing its "J" in the air.
    if (sp.id === 'dipper' && this.brightness > 0 && this.dark <= 0) this.vel.y += dt * 1.0;

    this.pos.addScaledVector(this.vel, dt);
    this.bobPhase += dt * this.bobRate;
  }

  /** Dart away from `from`, going dark for `darkFor` seconds. */
  startle(from, fleeFor, darkFor) {
    const away = unit(this.pos.clone().sub(from));
    this.fleeDir.copy(away).add(v3(rnd(-0.4, 0.4), rnd(-0.2, 0.3), rnd(-0.4, 0.4))).normalize();
    if (this.fleeDir.y < -0.1) this.fleeDir.y = -0.1;
    this.mode = 'flee';
    this.fleeTimer = fleeFor;
    this.dark = Math.max(this.dark, darkFor);
  }

  /** The point to draw: the position plus a little hover. */
  drawPosition() {
    return v3(this.pos.x, this.pos.y + Math.sin(this.bobPhase) * 0.03, this.pos.z);
  }
}

// ---------------------------------------------------------------------------------------------
// The swarm: owns the fireflies, draws them as glowing point sprites and feeds the brightest
// ones to the grass shaders as lights.
// ---------------------------------------------------------------------------------------------

export class Swarm {
  constructor(meadow, density) {
    this.meadow = meadow;
    this.flies = [];
    this.gathered = 0;
    this.gatherCap = 40;
    const scale = density * clamp(meadow.area, 0.6, 2.0);
    for (const sp of FireflySpecies.all) {
      for (let i = Math.round(sp.count * scale); i > 0; i--) this.flies.push(new Firefly(sp, meadow));
    }
    this.buildPoints();
  }

  buildPoints() {
    const n = this.flies.length;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(n * 3);
    this.bright = new Float32Array(n);
    const colors = new Float32Array(n * 3), sizes = new Float32Array(n);
    this.flies.forEach((f, i) => {
      const c = f.species.color.vec;
      colors.set([c.x, c.y, c.z], i * 3);
      sizes[i] = f.species.id === 'ghost' ? 0.14 : 0.2;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aBright', new THREE.BufferAttribute(this.bright, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 1000 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aBright; attribute vec3 aColor; attribute float aSize;
        uniform float uPx;
        varying float vB; varying vec3 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPx / max(-mv.z, 0.1), 3.0, 220.0);
          vB = aBright; vC = aColor;
        }`,
      fragmentShader: `
        varying float vB; varying vec3 vC;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r = length(q) * 2.0;
          if (r > 1.0) discard;
          float core = smoothstep(0.16, 0.0, r);
          float halo = exp(-r * r * 7.0) * 0.4;
          vec3 c = vC * (core * 2.4 + halo) * vB;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /** Point size scale: pixels per world unit at one metre. */
  setPixelScale(px) { this.material.uniforms.uPx.value = px; }

  /** Everyone near `point` flashes at once and bolts. */
  clap(point, radius) {
    for (const f of this.flies) {
      const d = f.pos.distanceTo(point);
      if (d > radius) continue;
      f.clapFlash = 0.35 + rnd(0, 0.1);
      f.startle(point, 1.2 + rnd(0, 0.6), 3 + rnd(0, 1.5));
      f.fleeTimer += 0.3;
    }
  }

  update(dt) {
    const meadow = this.meadow;
    // Phase coupling for the synchronous species: each sees its neighbours' lanterns.
    const sync = this.flies.filter((f) => f.species.sync);
    for (const f of sync) { f.sumSin = 0; f.neighbours = 0; }
    for (let i = 0; i < sync.length; i++) {
      const a = sync[i];
      for (let j = i + 1; j < sync.length; j++) {
        const b = sync[j];
        if (a.pos.distanceToSquared(b.pos) > 16) continue;
        const s = Math.sin((b.phase - a.phase) * TAU);
        a.sumSin += s; a.neighbours++;
        b.sumSin -= s; b.neighbours++;
      }
    }

    this.gathered = 0;
    for (const f of this.flies) if (f.mode === 'gather') this.gathered++;
    for (const f of this.flies) f.update(dt, meadow, this);

    // Upload positions and brightness; pick the brightest as lights for the grass.
    const lights = [];
    this.flies.forEach((f, i) => {
      const p = f.drawPosition();
      this.positions.set([p.x, p.y, p.z], i * 3);
      this.bright[i] = f.brightness;
      const light = f.brightness * f.species.light;
      if (light > 0.02) lights.push({ p, w: light, c: f.species.color.vec, score: light / (1 + p.distanceToSquared(meadow.camera.position) / 60) });
    });
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aBright.needsUpdate = true;
    lights.sort((a, b) => b.score - a.score);
    const u = G.uLights.value, uc = G.uLightCol.value;
    for (let i = 0; i < LIGHT_N; i++) {
      const l = lights[i];
      if (l) { u[i].set(l.p.x, l.p.y, l.p.z, l.w); uc[i].copy(l.c); } else u[i].set(0, 0, 0, 0);
    }
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
