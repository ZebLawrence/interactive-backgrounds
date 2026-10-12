// Loon Lake — Trout in the shallows: rainbows, brook trout and browns, each with its own painted
// skin, cruising and holding under the surface, rising to sip insects, nosing up to a fingertip
// held still in the water, and bolting from a hand dragged through it or a skipped stone.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, pick, fbm2, hash2, smoothstep, v3, unit, quatAxis, Art, RGBA } from './util.js';
import { patchMaterial, LAYER } from './shaders.js';
import { bedDepth } from './water.js';

// ---------------------------------------------------------------------------------------------
// Species: colours and markings, painted onto a 1024x512 canvas (u along the body from the nose,
// v round the body from the belly over the back and down again, mirrored for the two flanks).
// ---------------------------------------------------------------------------------------------

const SPECIES = {
  rainbow: {
    back: new RGBA(0.34, 0.42, 0.27), side: new RGBA(0.76, 0.78, 0.74), belly: new RGBA(0.95, 0.95, 0.92),
    band: new RGBA(0.92, 0.45, 0.5, 0.55), fin: new RGBA(0.5, 0.45, 0.4), finEdge: null,
    spots: [{ color: 'rgba(10,12,10,0.9)', n: 420, r: [0.5, 1.6], band: [0.26, 0.5], jitter: 1 }],
    metal: 0.35, rough: 0.42,
  },
  brook: {
    back: new RGBA(0.2, 0.3, 0.17), side: new RGBA(0.5, 0.47, 0.3), belly: new RGBA(0.9, 0.5, 0.18),
    band: null, fin: new RGBA(0.85, 0.42, 0.14), finEdge: 'rgba(255,255,255,0.9)', vermiculate: true,
    spots: [
      { color: 'rgba(230,200,90,0.85)', n: 140, r: [1.2, 2.4], band: [0.22, 0.4], jitter: 1 },
      { color: 'rgba(210,50,30,0.95)', n: 55, r: [1.0, 1.8], band: [0.18, 0.32], halo: 'rgba(90,130,230,0.6)' },
    ],
    metal: 0.15, rough: 0.55,
  },
  brown: {
    back: new RGBA(0.36, 0.3, 0.16), side: new RGBA(0.78, 0.66, 0.36), belly: new RGBA(0.92, 0.86, 0.68),
    band: null, fin: new RGBA(0.6, 0.45, 0.25), finEdge: null,
    spots: [
      { color: 'rgba(15,12,8,0.95)', n: 170, r: [1.4, 3.2], band: [0.2, 0.5], halo: 'rgba(240,225,180,0.55)' },
      { color: 'rgba(200,45,30,0.9)', n: 40, r: [1.0, 1.8], band: [0.18, 0.3], halo: 'rgba(240,225,180,0.5)' },
    ],
    metal: 0.25, rough: 0.5,
  },
};

function skinCanvas(sp) {
  const w = 1024, h = 512;
  return Art.image(w, h, (ctx) => {
    // Base gradient over half the height (belly to back), mirrored for the other flank.
    const half = h / 2;
    const paintHalf = (y0, flip) => {
      ctx.save();
      ctx.translate(0, y0);
      if (flip) { ctx.translate(0, half); ctx.scale(1, -1); }
      const g = ctx.createLinearGradient(0, 0, 0, half);
      g.addColorStop(0, sp.belly.css);
      g.addColorStop(0.42, sp.side.css);
      g.addColorStop(0.75, sp.back.mix(sp.side, 0.3).css);
      g.addColorStop(1, sp.back.css);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, half);
      // Scale sheen: fine diagonal rows catching the light.
      ctx.globalAlpha = 0.07;
      for (let x = 0; x < w; x += 7) {
        ctx.fillStyle = (x / 7) % 2 ? '#fff' : '#000';
        ctx.fillRect(x, 0, 3, half);
      }
      ctx.globalAlpha = 1;
      if (sp.band) {
        const bg = ctx.createLinearGradient(0, half * 0.3, 0, half * 0.6);
        bg.addColorStop(0, sp.band.alpha(0).css);
        bg.addColorStop(0.5, sp.band.css);
        bg.addColorStop(1, sp.band.alpha(0).css);
        ctx.fillStyle = bg;
        ctx.fillRect(w * 0.14, half * 0.3, w * 0.86, half * 0.3);
      }
      if (sp.vermiculate) {
        // Worm-tracks of pale marbling across the back.
        ctx.strokeStyle = 'rgba(190,200,150,0.75)';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        for (let k = 0; k < 260; k++) {
          let x = rnd(w * 0.12, w), y = rnd(half * 0.62, half);
          ctx.beginPath();
          ctx.moveTo(x, y);
          for (let s = 0; s < 6; s++) {
            const a = fbm2(x * 0.02, y * 0.02, 2) * TAU * 2;
            x += Math.cos(a) * 6; y += Math.sin(a) * 4;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      for (const S of sp.spots) {
        for (let k = 0; k < S.n; k++) {
          // Spots sit on the upper flank and back: the band is a fraction of the way from belly to back.
          const x = rnd(w * 0.1, w * 0.98);
          const yy = half * (1 - (S.band[0] + (S.band[1] - S.band[0]) * Math.random()));
          const r = rnd(S.r[0], S.r[1]) * (1 + 0.6 * (1 - yy / half));
          if (S.halo) { ctx.fillStyle = S.halo; ctx.beginPath(); ctx.arc(x, yy, r * 1.9, 0, TAU); ctx.fill(); }
          ctx.fillStyle = S.color;
          ctx.beginPath();
          ctx.ellipse(x, yy, r, r * rnd(0.8, 1.1), 0, 0, TAU);
          ctx.fill();
        }
      }
      // Head: the gill cover's curve, a darker cheek, and the eye with its gold ring.
      ctx.strokeStyle = 'rgba(30,30,25,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w * 0.2, half * 0.1);
      ctx.quadraticCurveTo(w * 0.24, half * 0.5, w * 0.19, half * 0.95);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(40,30,25,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, half * 0.42);
      ctx.quadraticCurveTo(w * 0.05, half * 0.4, w * 0.11, half * 0.36);
      ctx.stroke();
      const ex = w * 0.085, ey = half * 0.62;
      ctx.fillStyle = 'rgba(210,170,70,1)';
      ctx.beginPath(); ctx.arc(ex, ey, 15, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0a0a0c';
      ctx.beginPath(); ctx.arc(ex, ey, 9.5, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.arc(ex - 3, ey - 3, 2.2, 0, TAU); ctx.fill();
      ctx.restore();
    };
    paintHalf(0, false);
    paintHalf(half, true);
  });
}

/** A translucent fin membrane with rays. */
function finCanvas(sp) {
  return Art.image(256, 256, (ctx, w, h) => {
    ctx.fillStyle = sp.fin.alpha(0.85).css;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(20,15,10,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const x = (i + 0.5) / 14 * w;
      ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + rnd(-8, 8), 0); ctx.stroke();
    }
    if (sp.finEdge) {
      ctx.fillStyle = sp.finEdge;
      ctx.fillRect(0, 0, w, 22);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 22, w, 10);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry: the body is a tube of elliptical rings along the x axis, nose at +0.5 and tail at
// -0.5 (the fish swims along +x), fins are flat fans. Positions are in units of body length; the
// material scales by the fish's length.
// ---------------------------------------------------------------------------------------------

function bodyGeometry() {
  const rings = 44, around = 18;
  const pos = [], uv = [], idx = [];
  const halfHeight = (t) => 0.105 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.9) * (1 - 0.55 * smoothstep(0.6, 0.9, t)) + 0.022 * smoothstep(0.65, 1, t);
  const halfWidth = (t) => halfHeight(t) * (0.55 - 0.1 * t) + 0.004;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const a = halfHeight(t), b = halfWidth(t);
    for (let k = 0; k <= around; k++) {
      const th = k / around * TAU;
      // Fuller belly than back.
      const y = -Math.cos(th) * a * (Math.cos(th) > 0 ? 1.05 : 0.92);
      const z = Math.sin(th) * b;
      pos.push(0.5 - t, y, z);
      uv.push(t, k / around);
    }
  }
  for (let r = 0; r < rings; r++) for (let k = 0; k < around; k++) {
    const a = r * (around + 1) + k, b = a + 1, c = a + around + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A fin: a fan of quads from a root segment along the body to an outer edge. */
function finGeometry(root0, root1, tip0, tip1) {
  const g = new THREE.BufferGeometry();
  const segs = 6;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const r = root0.clone().lerp(root1, t), tp = tip0.clone().lerp(tip1, t);
    pos.push(r.x, r.y, r.z, tp.x, tp.y, tp.z);
    uv.push(t, 1, t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const SHARED = { body: null, fins: null, skins: {}, finTex: {} };

function shared() {
  if (!SHARED.body) {
    SHARED.body = bodyGeometry();
    // Fin positions are written nose-to-tail in [0, 1.25]; the body runs the other way.
    const V = (x, y, z) => v3(0.5 - x, y, z);
    SHARED.fins = [
      // Tail: forked, flaring from the peduncle.
      { geo: finGeometry(V(0.97, 0.03, 0), V(0.97, -0.03, 0), V(1.2, 0.15, 0), V(1.2, -0.15, 0)), sway: 1 },
      // Dorsal, adipose and anal along the midline.
      { geo: finGeometry(V(0.38, 0.1, 0), V(0.56, 0.085, 0), V(0.46, 0.19, 0), V(0.6, 0.14, 0)), sway: 0.5 },
      { geo: finGeometry(V(0.78, 0.055, 0), V(0.84, 0.05, 0), V(0.83, 0.1, 0), V(0.86, 0.075, 0)), sway: 0.8 },
      { geo: finGeometry(V(0.72, -0.07, 0), V(0.82, -0.05, 0), V(0.8, -0.14, 0), V(0.86, -0.08, 0)), sway: 0.8 },
      // Pectorals and pelvics, paired, angled down and back.
      { geo: finGeometry(V(0.24, -0.06, 0.045), V(0.27, -0.075, 0.04), V(0.36, -0.12, 0.11), V(0.4, -0.13, 0.09)), sway: 0.3, flap: 1 },
      { geo: finGeometry(V(0.24, -0.06, -0.045), V(0.27, -0.075, -0.04), V(0.36, -0.12, -0.11), V(0.4, -0.13, -0.09)), sway: 0.3, flap: -1 },
      { geo: finGeometry(V(0.55, -0.09, 0.03), V(0.6, -0.085, 0.025), V(0.64, -0.15, 0.06), V(0.68, -0.14, 0.05)), sway: 0.5 },
      { geo: finGeometry(V(0.55, -0.09, -0.03), V(0.6, -0.085, -0.025), V(0.64, -0.15, -0.06), V(0.68, -0.14, -0.05)), sway: 0.5 },
    ];
  }
  return SHARED;
}

function skinTexture(name) {
  if (!SHARED.skins[name]) {
    SHARED.skins[name] = Art.texture(skinCanvas(SPECIES[name]));
    SHARED.finTex[name] = Art.texture(finCanvas(SPECIES[name]));
  }
  return { skin: SHARED.skins[name], fin: SHARED.finTex[name] };
}

/** The swimming motion: a wave of lateral bend travelling down the body, bigger toward the tail,
 *  plus a steady bend for turning. Applied in object space where +x runs nose to tail. */
const SWIM_VERTEX = `
uniform float uPhase, uAmp, uTurn, uSway;
vec3 swimOffset(float t) {
  float env = 0.02 + 1.3 * t * t;
  float wave = sin(t * 5.2 - uPhase);
  float bend = uTurn * t * t * 0.9;
  return vec3(0.0, 0.0, uAmp * env * wave + bend);
}
`;
const SWIM_MAIN = `
  float tt = clamp(0.5 - gPos.x, 0.0, 1.25);
  vec3 off = swimOffset(tt);
  vec3 off2 = swimOffset(tt + 0.02);
  gPos += off * uSway;
  // Shear the normal with the local bend so the flank still catches the light correctly.
  float dz = -(off2.z - off.z) / 0.02 * uSway;
  gNormal = normalize(vec3(gNormal.x - dz * gNormal.z, gNormal.y, gNormal.z));
`;

// ---------------------------------------------------------------------------------------------
// One trout
// ---------------------------------------------------------------------------------------------

export class Trout {
  constructor(lake, species) {
    this.lake = lake;
    this.species = species;
    const sp = SPECIES[species];
    this.length = species === 'brook' ? rnd(0.26, 0.36) : rnd(0.32, 0.48);
    const { body, fins } = shared();
    const tex = skinTexture(species);
    this.uniforms = { uPhase: { value: rnd(0, TAU) }, uAmp: { value: 0.03 }, uTurn: { value: 0 }, uSway: { value: 1 } };
    this.bodyMat = patchMaterial(new THREE.MeshStandardMaterial({ map: tex.skin, roughness: sp.rough, metalness: sp.metal, envMapIntensity: 0 }), {
      key: 'trout-body', uniforms: this.uniforms, vHead: SWIM_VERTEX, vMain: SWIM_MAIN,
    });
    this.finMat = patchMaterial(new THREE.MeshStandardMaterial({ map: tex.fin, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }), {
      key: 'trout-fin', uniforms: this.uniforms, vHead: SWIM_VERTEX, vMain: SWIM_MAIN,
    });
    // The shadow pass needs the same swimming deformation.
    this.depthMat = patchMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), {
      key: 'trout-depth', uniforms: this.uniforms, vHead: SWIM_VERTEX, vMain: SWIM_MAIN,
    });
    this.node = new THREE.Group();
    this.body = new THREE.Mesh(body, this.bodyMat);
    this.body.castShadow = true;
    this.body.customDepthMaterial = this.depthMat;
    this.node.add(this.body);
    for (const f of fins) {
      const m = new THREE.Mesh(f.geo, this.finMat);
      m.renderOrder = 1;
      m.castShadow = true;
      m.customDepthMaterial = this.depthMat;
      this.node.add(m);
    }
    this.node.scale.setScalar(this.length);
    this.node.traverse((o) => { o.layers.set(LAYER.BELOW); o.frustumCulled = false; });

    this.pos = v3();
    this.vel = v3();
    this.heading = rnd(0, TAU);
    this.pitch = 0;
    this.roll = 0;
    this.state = 'cruise';
    this.timer = rnd(2, 8);
    this.riseTimer = rnd(30, 120);
    this.wanderPhase = rnd(0, TAU);
    this.target = null;
    this.phase = rnd(0, TAU);
    this.burst = 0;
  }

  /** The point just under the nose. */
  get nose() { return this.pos.clone().add(this.forward().multiplyScalar(this.length * 0.5)); }

  forward() { return v3(Math.cos(this.heading) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.sin(this.heading) * Math.cos(this.pitch)); }

  /** Startle: bolt away from a point, a C-start. */
  startle(from, strength = 1) {
    const away = unit(this.pos.clone().sub(from).setY(0));
    if (away.lengthSq() < 0.5) away.set(Math.cos(this.heading + 1.5), 0, -Math.sin(this.heading + 1.5));
    this.vel.copy(away).multiplyScalar(1.6 * strength).add(v3(0, -0.5 * strength, 0));
    this.heading = Math.atan2(-away.z, away.x);
    this.state = 'flee';
    this.timer = rnd(0.9, 1.6);
    this.burst = 1;
  }

  /** Begin a rise toward the surface at a point. */
  rise(at) {
    this.target = at.clone().setY(-0.03);
    this.state = 'rise';
    this.timer = 6;
    this.rose = false;
  }

  update(dt, lake) {
    const bounds = lake.fishBounds;
    const cursor = lake.cursor;
    const speedNow = this.vel.length();

    // Reactions to the cursor, in screen space so near and far fish feel the same.
    const scr = lake.project(this.pos);
    if (cursor.present && scr.depth > 0.5) {
      const dpx = Math.hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y);
      if (cursor.speed > 450 && this.state !== 'flee') {
        const radius = (150 + Math.min(cursor.speed, 2500) * 0.09) / (1 + scr.depth / 12);
        if (dpx < radius) this.startle(lake.closestPointOnCursorRay(this.pos), 1);
      }
    }
    for (const s of lake.startles) {
      const d = Math.hypot(this.pos.x - s.x, this.pos.z - s.z);
      if (d < s.radius && this.state !== 'flee') this.startle(v3(s.x, 0, s.z), clamp(1.4 - d / s.radius, 0.5, 1.2));
    }

    this.timer -= dt;
    this.riseTimer -= dt;
    const headingBefore = this.heading;
    const acc = v3();
    let want = 0.3; // cruising speed, m/s
    switch (this.state) {
      case 'cruise': {
        // A slow S-path, veering toward the middle of the shallows now and then.
        this.wanderPhase += dt * 0.25;
        this.heading += Math.sin(this.wanderPhase * 1.7 + this.phase) * 0.35 * dt;
        want = 0.22 + 0.12 * Math.sin(this.phase + lake.clock * 0.1);
        if (this.timer <= 0) { this.state = Math.random() < 0.55 ? 'hold' : 'cruise'; this.timer = rnd(4, 12); }
        if (this.riseTimer <= 0) {
          const f = this.forward().setY(0).normalize();
          const at = this.pos.clone().addScaledVector(f, rnd(1.2, 3));
          if (at.z < -1.5 && Math.abs(at.x) < bounds.halfWidth(-at.z)) this.rise(at);
          this.riseTimer = rnd(45, 140) * (lake.rain > 0.5 ? 0.5 : 1);
        }
        break;
      }
      case 'hold': {
        // Holding station, finning gently, facing roughly across the view.
        want = 0.04;
        const faceInto = Math.sign(Math.cos(this.heading)) * 0.08;
        this.heading += faceInto * dt * 0.3;
        if (this.timer <= 0) { this.state = 'cruise'; this.timer = rnd(6, 16); }
        break;
      }
      case 'rise': {
        const to = this.target.clone().sub(this.pos);
        const d = to.length();
        want = clamp(0.25 + d * 0.3, 0.3, 0.7);
        this.heading = lerpAngle(this.heading, Math.atan2(-to.z, to.x), Math.min(1, dt * 3));
        this.pitch = lerp(this.pitch, clamp(Math.atan2(to.y, Math.hypot(to.x, to.z)), -0.9, 0.9), Math.min(1, dt * 3));
        if (!this.rose && d < this.length * 0.35) {
          // The sip: a ring and a flash of flank as the fish rolls at the surface.
          this.rose = true;
          lake.disturb(this.target.x, this.target.z, 0.16, -0.012 * this.length / 0.35, 0.5);
          this.roll = rnd(0.6, 1.1) * (Math.random() < 0.5 ? 1 : -1);
          this.timer = 0.5;
        }
        if (this.rose && this.timer <= 0) { this.state = 'dive'; this.timer = rnd(1.5, 3); this.target = this.pos.clone().add(v3(rnd(-1, 1), -rnd(0.6, 1.0), rnd(-1, 1))); }
        if (!this.rose && this.timer <= 0) { this.state = 'cruise'; this.timer = rnd(4, 10); }
        break;
      }
      case 'dive': {
        const to = this.target.clone().sub(this.pos);
        want = 0.45;
        this.heading = lerpAngle(this.heading, Math.atan2(-to.z, to.x), Math.min(1, dt * 2));
        this.pitch = lerp(this.pitch, clamp(Math.atan2(to.y, Math.hypot(to.x, to.z)), -0.9, 0.9), Math.min(1, dt * 3));
        if (this.timer <= 0 || to.length() < 0.2) { this.state = 'cruise'; this.timer = rnd(4, 10); }
        break;
      }
      case 'investigate': {
        // Come up under the fingertip and hang there, nosing at it.
        const f = lake.finger;
        if (!f.inWater || !cursor.present || cursor.stillTime < 0.4) { this.state = 'cruise'; this.timer = rnd(3, 8); break; }
        const goal = f.point.clone().setY(-0.22);
        const to = goal.clone().sub(this.pos);
        const d = to.length();
        want = clamp(d * 0.35, 0.03, 0.35);
        if (d > 0.15) {
          this.heading = lerpAngle(this.heading, Math.atan2(-to.z, to.x), Math.min(1, dt * 2));
          this.pitch = lerp(this.pitch, clamp(Math.atan2(to.y, Math.hypot(to.x, to.z)), -0.7, 0.7), Math.min(1, dt * 2));
        } else {
          this.pitch = lerp(this.pitch, 0.15, dt * 2);
          // Now and then a nudge at the surface: a tiny ring under the finger.
          if (Math.random() < dt * 0.25) lake.disturb(goal.x, goal.z, 0.1, -0.004, 0.2);
        }
        if (this.timer <= 0) { this.state = 'dive'; this.timer = 2; this.target = this.pos.clone().add(v3(rnd(-2, 2), -0.8, rnd(-2, 2))); }
        break;
      }
      case 'flee': {
        want = 0;
        this.burst = Math.max(0, this.burst - dt * 1.2);
        if (this.timer <= 0) { this.state = 'cruise'; this.timer = rnd(4, 10); }
        break;
      }
    }

    // Steering toward the wanted speed along the heading (fish accelerate gently, brake with drag).
    const fwd = this.forward();
    if (this.state !== 'flee') {
      const desired = fwd.clone().multiplyScalar(want);
      acc.add(desired.sub(this.vel).multiplyScalar(this.state === 'rise' ? 2.5 : 1.2));
    } else {
      acc.addScaledVector(this.vel, -1.8);
    }
    // Stay in the shallows and off the bed, and in the frame.
    const bed = -bedDepth(Math.min(this.pos.z, -0.01));
    const lo = bed + 0.35, hi = -0.25;
    if (this.pos.y < lo) acc.y += (lo - this.pos.y) * 3;
    if (this.pos.y > hi && this.state !== 'rise' && this.state !== 'investigate') acc.y -= (this.pos.y - hi) * 3;
    if (this.pos.z > bounds.near) acc.z -= (this.pos.z - bounds.near) * 1.5;
    if (this.pos.z < bounds.far) acc.z += (bounds.far - this.pos.z) * 1.5;
    const hw = bounds.halfWidth(-this.pos.z) * 0.9;
    if (Math.abs(this.pos.x) > hw) acc.x -= (this.pos.x - Math.sign(this.pos.x) * hw) * 1.5;
    // Turn the heading toward where the walls are pushing, so the fish swims rather than slides.
    if (acc.x !== 0 || acc.z !== 0) {
      const wallTurn = Math.atan2(-acc.z, acc.x);
      const wallMag = Math.hypot(acc.x, acc.z);
      if (wallMag > 0.05 && this.state !== 'flee') this.heading = lerpAngle(this.heading, wallTurn, Math.min(1, dt * wallMag * 0.4));
    }
    this.vel.addScaledVector(acc, dt);
    const sp = this.vel.length();
    if (sp > 2.2) this.vel.multiplyScalar(2.2 / sp);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = Math.min(this.pos.y, -0.02);

    // Orientation follows the velocity when moving, with a slow return of pitch and roll.
    if (sp > 0.08 && this.state !== 'investigate' && this.state !== 'rise' && this.state !== 'dive') {
      const h = Math.atan2(-this.vel.z, this.vel.x);
      this.heading = lerpAngle(this.heading, h, Math.min(1, dt * (this.state === 'flee' ? 8 : 2)));
      this.pitch = lerp(this.pitch, clamp(Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z)), -0.6, 0.6), Math.min(1, dt * 2));
    } else if (this.state !== 'rise' && this.state !== 'dive' && this.state !== 'investigate') {
      this.pitch = lerp(this.pitch, 0, Math.min(1, dt));
    }
    this.roll = lerp(this.roll, 0, Math.min(1, dt * 1.5));

    // Tail: beats faster and wider the harder the fish works, barely at all when holding.
    const effort = clamp(sp / 0.6, 0.08, 1) + this.burst * 1.5;
    this.phase += dt * TAU * (0.9 + 2.2 * effort);
    this.uniforms.uPhase.value = this.phase;
    this.uniforms.uAmp.value = 0.012 + 0.05 * clamp(effort, 0, 1.4);
    // Turning bends the body into the turn.
    const turnRate = dt > 1e-4 ? lerpAngle(0, this.heading - headingBefore, 1) / dt : 0;
    this.uniforms.uTurn.value = lerp(this.uniforms.uTurn.value, clamp(turnRate * 0.25, -0.3, 0.3), Math.min(1, dt * 3));

    this.node.position.copy(this.pos);
    this.node.quaternion.copy(quatAxis(this.heading, 0, 1, 0)).multiply(quatAxis(this.pitch, 0, 0, 1)).multiply(quatAxis(this.roll, 1, 0, 0));
    // Fish are dimmer and bluer the deeper they swim; the water shader handles the view path,
    // this handles the light reaching them from above.
    const depth = -this.pos.y;
    const dim = Math.exp(-depth * 0.22);
    this.bodyMat.color.setRGB(lerp(0.55, 1, dim), lerp(0.75, 1, dim), 1);
  }

  dispose() { this.bodyMat.dispose(); this.finMat.dispose(); this.depthMat.dispose(); }
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

// ---------------------------------------------------------------------------------------------
// The shoal of trout in the shallows
// ---------------------------------------------------------------------------------------------

export class Shoal {
  constructor(lake, count) {
    this.lake = lake;
    this.fish = [];
    this.group = new THREE.Group();
    this.setCount(count);
    this.investigateTimer = 0;
  }

  setCount(n) {
    while (this.fish.length > n) { const f = this.fish.pop(); this.group.remove(f.node); f.dispose(); }
    while (this.fish.length < n) {
      const species = pick(['rainbow', 'rainbow', 'brook', 'brown']);
      const f = new Trout(this.lake, species);
      const b = this.lake.fishBounds;
      const z = rnd(b.far * 0.9, b.near - 1);
      const x = rnd(-0.8, 0.8) * b.halfWidth(-z);
      f.pos.set(x, -rnd(0.3, Math.max(0.4, bedDepth(z) - 0.5)), z);
      f.vel.copy(f.forward().multiplyScalar(0.2));
      this.fish.push(f);
      this.group.add(f.node);
    }
  }

  update(dt, lake) {
    // A resting fingertip in the water draws the nearest fish or two to investigate.
    const c = lake.cursor, f = lake.finger;
    this.investigateTimer -= dt;
    if (c.present && c.stillTime > 1.5 && f.inWater && this.investigateTimer <= 0) {
      this.investigateTimer = 4;
      const sorted = this.fish.filter((t) => t.state === 'cruise' || t.state === 'hold').map((t) => ({ t, d: t.pos.distanceTo(f.point) })).sort((p, q) => p.d - q.d);
      const already = this.fish.filter((t) => t.state === 'investigate').length;
      for (let i = 0; i < Math.min(2 - already, sorted.length); i++) {
        if (sorted[i].d < 14) { sorted[i].t.state = 'investigate'; sorted[i].t.timer = rnd(10, 25); }
      }
    }
    for (const t of this.fish) t.update(dt, lake);
    // Keep the fish from swimming through one another.
    for (let i = 0; i < this.fish.length; i++) for (let j = i + 1; j < this.fish.length; j++) {
      const a = this.fish[i], b = this.fish[j];
      const d = a.pos.distanceTo(b.pos), minD = (a.length + b.length) * 0.6;
      if (d < minD && d > 1e-3) {
        const push = a.pos.clone().sub(b.pos).multiplyScalar((minD - d) / d * 0.5);
        a.pos.add(push.clone().multiplyScalar(0.5)); b.pos.sub(push.multiplyScalar(0.5));
      }
    }
  }

  dispose() { for (const f of this.fish) f.dispose(); }
}
