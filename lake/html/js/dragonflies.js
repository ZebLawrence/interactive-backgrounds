// Loon Lake — Dragonflies over the shallows: darners and meadowhawks that patrol in darts and
// hovers, perch on the reed tops, scatter from a fast cursor, and, if you hold your fingertip
// still, come and land on it. Wings are veined membranes drawn in metres; in flight they blur.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, pick, v3, unit, quatAxis, Art, quantize } from './util.js';
import { G, Q, FOG_HEAD, LAYER } from './shaders.js';

const KINDS = [
  { name: 'blue darner', thorax: 0x2a6fd6, abdomen: 0x1b3f8f, bands: 0x0b1020, eyes: 0x1f7fbf, wingTint: [0.85, 0.9, 1.0] },
  { name: 'green darner', thorax: 0x3f9a3a, abdomen: 0x2d62c9, bands: 0x102014, eyes: 0x3a8a3a, wingTint: [0.9, 0.95, 0.85] },
  { name: 'meadowhawk', thorax: 0x8a2a1a, abdomen: 0xc83b1e, bands: 0x3a0f08, eyes: 0x7a2a1a, wingTint: [1.0, 0.9, 0.8] },
  { name: 'skimmer', thorax: 0x6c7fa8, abdomen: 0x9fb2d6, bands: 0x1a2030, eyes: 0x3a4a6a, wingTint: [0.9, 0.9, 0.95] },
];

/** A wing: translucent membrane, longitudinal veins, a net of cross-veins and the dark pterostigma. */
function wingCanvas() {
  return Art.image(1024, 320, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // The outline: a long rounded blade, broader at the base.
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.bezierCurveTo(w * 0.1, h * 0.02, w * 0.75, h * 0.0, w * 0.98, h * 0.3);
    ctx.bezierCurveTo(w * 1.0, h * 0.5, w * 0.9, h * 0.95, w * 0.7, h * 0.98);
    ctx.bezierCurveTo(w * 0.4, h * 1.0, w * 0.1, h * 0.9, 0, h * 0.5);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.fillRect(0, 0, w, h);
    // Cross-veins: a fine irregular mesh.
    ctx.strokeStyle = 'rgba(30,25,20,0.55)';
    ctx.lineWidth = 1.2;
    for (let x = 0; x < w; x += 11) {
      ctx.beginPath();
      for (let y = 0; y <= h; y += 14) ctx.lineTo(x + Math.sin(y * 0.4 + x) * 3, y);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 13) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 12) ctx.lineTo(x, y + Math.sin(x * 0.35 + y) * 3);
      ctx.stroke();
    }
    // Longitudinal veins: heavier, running from the root to the tip.
    ctx.strokeStyle = 'rgba(25,20,15,0.9)';
    for (const [y0, y1, lw] of [[0.5, 0.3, 3.5], [0.5, 0.12, 2.5], [0.5, 0.5, 2.2], [0.5, 0.72, 2.2], [0.5, 0.9, 2.0]]) {
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(0, h * y0);
      ctx.bezierCurveTo(w * 0.3, h * lerp(y0, y1, 0.6), w * 0.7, h * y1, w * 0.98, h * lerp(y1, 0.4, 0.5));
      ctx.stroke();
    }
    // Pterostigma: the dark cell near the tip of the leading edge.
    ctx.fillStyle = 'rgba(40,25,15,0.95)';
    ctx.fillRect(w * 0.82, h * 0.09, w * 0.07, h * 0.06);
    ctx.restore();
    ctx.strokeStyle = 'rgba(25,20,15,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
  });
}

const SHARED = {};

function parts() {
  if (SHARED.wing) return SHARED;
  // Body parts in metres for a 7.5 cm dragonfly, +x forward.
  const thorax = new THREE.SphereGeometry(1, 16, 12);
  thorax.scale(0.009, 0.0065, 0.006);
  const head = new THREE.SphereGeometry(0.0038, 12, 10);
  head.translate(0.011, 0.001, 0);
  const eye = new THREE.SphereGeometry(0.0028, 10, 8);
  // The abdomen: ten tapering segments.
  const segs = [];
  for (let i = 0; i < 10; i++) {
    const t = i / 10;
    const r = 0.0028 * (1 - t * 0.55) + (i === 0 ? 0.0006 : 0);
    const g = new THREE.CylinderGeometry(r * 0.92, r, 0.0046, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(-0.008 - i * 0.0046, 0, 0);
    segs.push(g);
  }
  // The wings: four quads with three ghost copies each for the blur of flight. Attribute aWing
  // holds (side, fore/hind, ghost).
  const pos = [], uv = [], wing = [], idx = [];
  let base = 0;
  const fore = { len: 0.046, w: 0.0105, root: 0.0025, sweep: 0.08 }, hind = { len: 0.044, w: 0.013, root: -0.003, sweep: -0.08 };
  for (const side of [1, -1]) for (const [k, W] of [[0, fore], [1, hind]]) for (let ghost = 0; ghost < 3; ghost++) {
    // Quad from root (along z) to tip; sweep is a slight angle back or forward.
    const cols = 4;
    for (let c = 0; c <= cols; c++) {
      const s = c / cols;
      const x = W.root + Math.sin(W.sweep) * W.len * s, z = side * W.len * s;
      pos.push(x - W.w * 0.5, 0, z, x + W.w * 0.5, 0, z);
      uv.push(s, 0, s, 1);
      wing.push(side, k, ghost, side, k, ghost);
    }
    for (let c = 0; c < cols; c++) {
      const a = base + c * 2, b = a + 1, cc = a + 2, d = a + 3;
      idx.push(a, cc, b, b, cc, d);
    }
    base += (cols + 1) * 2;
  }
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wingGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  wingGeo.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 3));
  wingGeo.setIndex(idx);
  SHARED.thorax = thorax; SHARED.head = head; SHARED.eye = eye; SHARED.segs = segs; SHARED.wing = wingGeo;
  SHARED.wingTex = Art.texture(wingCanvas());
  return SHARED;
}

export class Dragonfly {
  constructor(lake, kind) {
    this.lake = lake;
    this.kind = kind;
    const P = parts();
    this.node = new THREE.Group();
    this.thoraxMat = new THREE.MeshStandardMaterial({ color: kind.thorax, roughness: 0.35, metalness: 0.3 });
    this.abdMat = new THREE.MeshStandardMaterial({ color: kind.abdomen, roughness: 0.3, metalness: 0.35 });
    this.bandMat = new THREE.MeshStandardMaterial({ color: kind.bands, roughness: 0.4, metalness: 0.2 });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: kind.eyes, roughness: 0.15, metalness: 0.4 });
    this.node.add(new THREE.Mesh(P.thorax, this.thoraxMat), new THREE.Mesh(P.head, this.bandMat));
    const eyeL = new THREE.Mesh(P.eye, this.eyeMat), eyeR = new THREE.Mesh(P.eye, this.eyeMat);
    eyeL.position.set(0.0125, 0.0015, 0.0022); eyeR.position.set(0.0125, 0.0015, -0.0022);
    this.node.add(eyeL, eyeR);
    P.segs.forEach((g, i) => this.node.add(new THREE.Mesh(g, i % 2 ? this.bandMat : this.abdMat)));
    this.wingUniforms = { uFlying: { value: 1 }, uBeat: { value: rnd(0, TAU) }, uTint: { value: new THREE.Vector3(...kind.wingTint) } };
    this.wingMat = new THREE.ShaderMaterial({
      uniforms: { ...this.wingUniforms, uMap: { value: P.wingTex }, uTime: G.uTime, uNight: G.uNight, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 aWing; uniform float uFlying, uBeat;
        varying vec2 vUv; varying float vAlpha, vDist; varying vec3 vN;
        void main() {
          float side = aWing.x, hind = aWing.y, ghost = aWing.z;
          // In flight the wings beat about the root: three ghosts at different phases make the
          // blur; perched, only the first is drawn, held flat out.
          float ang = uFlying * sin(uBeat + ghost * 2.1 + hind * 1.6) * 0.75;
          vec3 p = position;
          float c = cos(ang), s = sin(ang);
          p = vec3(p.x, p.y * c + p.z * side * s, p.z * c - p.y * side * s);
          vN = normalize(vec3(0.0, c, -side * s));
          vAlpha = mix(ghost < 0.5 ? 1.0 : 0.0, 0.42, uFlying);
          vUv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, step(0.5, side)));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform vec3 uTint; uniform float uNight;
        varying vec2 vUv; varying float vAlpha, vDist; varying vec3 vN;
        ${FOG_HEAD}
        void main() {
          vec4 t = texture2D(uMap, vUv);
          if (t.a < 0.02) discard;
          vec3 sky = mix(vec3(0.6, 0.5, 0.6), vec3(0.08, 0.09, 0.14), uNight);
          // A thin-film glint across the membrane as it tilts to the light.
          float sheen = pow(abs(vN.y), 3.0) * 0.5;
          vec3 c = mix(t.rgb, uTint, 0.5) * sky * (0.7 + sheen);
          gl_FragColor = vec4(applyFog(c, vDist), t.a * vAlpha);
        }`,
    });
    this.wings = new THREE.Mesh(P.wing, this.wingMat);
    this.wings.position.set(0.001, 0.004, 0);
    this.wings.renderOrder = 2;
    this.node.add(this.wings);
    this.node.traverse((o) => { o.layers.enable(LAYER.ABOVE); o.frustumCulled = false; });

    this.pos = v3();
    this.vel = v3();
    this.heading = rnd(0, TAU);
    this.state = 'hover';
    this.timer = rnd(1, 3);
    this.target = null;
    this.perch = null;
    this.beat = rnd(0, TAU);
    this.flying = 1;
    this.jitter = v3();
  }

  pickWaypoint(lake) {
    const b = lake.dragonflyBounds;
    const z = rnd(b.far, b.near);
    return v3(rnd(-1, 1) * b.halfWidth(-z) * 0.9, rnd(0.15, 1.4), z);
  }

  scatter(from) {
    const away = unit(this.pos.clone().sub(from));
    if (away.lengthSq() < 0.5) away.set(0, 1, 0);
    this.vel.copy(away).multiplyScalar(3.5).add(v3(0, 1.2, 0));
    this.state = 'dart';
    this.target = this.pos.clone().addScaledVector(away, rnd(2, 4)).add(v3(0, rnd(0.3, 1.0), 0));
    this.target.y = clamp(this.target.y, 0.2, 2.0);
    this.perch = null;
    this.timer = 2;
  }

  update(dt, lake) {
    const cursor = lake.cursor;
    this.timer -= dt;

    // A fast cursor close by scatters them (screen space).
    if (cursor.present && cursor.speed > 450) {
      const scr = lake.project(this.pos);
      if (scr.depth > 0.3) {
        const dpx = Math.hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y);
        if (dpx < (170 + Math.min(cursor.speed, 2500) * 0.08) / (1 + scr.depth / 10)) this.scatter(lake.closestPointOnCursorRay(this.pos));
      }
    }
    for (const s of lake.startles) if (Math.hypot(this.pos.x - s.x, this.pos.z - s.z) < s.radius * 0.8 && this.pos.y < 1) this.scatter(v3(s.x, 0, s.z));

    const shelter = lake.rain > 0.5;
    switch (this.state) {
      case 'hover': {
        // Hanging in the air with small corrections, then off to the next spot.
        this.jitter.lerp(v3(rnd(-1, 1), rnd(-0.6, 0.6), rnd(-1, 1)).multiplyScalar(0.06), Math.min(1, dt * 4));
        const goal = this.target ? this.target.clone().add(this.jitter) : this.pos;
        this.vel.lerp(goal.clone().sub(this.pos).multiplyScalar(4), Math.min(1, dt * 6));
        if (this.timer <= 0 || shelter) {
          if (lake.fingerPercher === this && lake.finger.valid && cursor.stillTime > 2.5 && !shelter) {
            this.state = 'toFinger';
            this.timer = 8;
          } else if (shelter || Math.random() < 0.3) {
            const perch = pick(lake.perches);
            if (perch) { this.perch = perch; this.state = 'toPerch'; this.timer = 8; }
          } else {
            this.target = this.pickWaypoint(lake);
            this.state = 'dart';
            this.timer = 6;
          }
        }
        break;
      }
      case 'dart': {
        const to = this.target.clone().sub(this.pos);
        const d = to.length();
        const speed = clamp(d * 2.5, 0.4, 2.8);
        this.vel.lerp(to.normalize().multiplyScalar(speed), Math.min(1, dt * 5));
        if (d < 0.08 || this.timer <= 0) { this.state = 'hover'; this.timer = rnd(1.5, 5); }
        break;
      }
      case 'toPerch': {
        const top = lake.reeds.perchTop(this.perch, G.uTime.value);
        const goal = top.clone().add(v3(0, 0.015, 0));
        const to = goal.clone().sub(this.pos);
        const d = to.length();
        this.vel.lerp(to.normalize().multiplyScalar(clamp(d * 2.5, 0.25, 2.5)), Math.min(1, dt * 5));
        if (d < 0.03) { this.state = 'perched'; this.timer = shelter ? rnd(20, 60) : rnd(6, 25); this.vel.set(0, 0, 0); }
        if (this.timer <= 0) { this.state = 'hover'; this.timer = 2; this.target = this.pos.clone(); }
        break;
      }
      case 'perched': {
        const top = lake.reeds.perchTop(this.perch, G.uTime.value);
        this.pos.copy(top).add(v3(0, 0.015, 0));
        this.vel.set(0, 0, 0);
        if ((this.timer <= 0 && !shelter) || (shelter && this.timer <= 0 && Math.random() < 0.3)) {
          this.timer = 3;
          this.state = 'dart';
          this.target = this.pickWaypoint(lake);
          this.vel.set(0, 0.5, 0);
        }
        break;
      }
      case 'toFinger': {
        const f = lake.finger;
        if (!cursor.present || cursor.stillTime < 0.5 || !f.valid) { this.state = 'hover'; this.timer = rnd(1, 3); this.target = this.pos.clone(); break; }
        const goal = f.point.clone().add(v3(0, 0.012, 0));
        const to = goal.clone().sub(this.pos);
        const d = to.length();
        this.vel.lerp(to.normalize().multiplyScalar(clamp(d * 2.2, 0.2, 2.5)), Math.min(1, dt * 5));
        if (d < 0.025) { this.state = 'onFinger'; this.vel.set(0, 0, 0); this.timer = rnd(15, 60); }
        if (this.timer <= 0) { this.state = 'hover'; this.timer = 2; this.target = this.pos.clone(); }
        break;
      }
      case 'onFinger': {
        const f = lake.finger;
        // Lifts off as soon as the finger moves.
        if (!cursor.present || cursor.speed > 40 || !f.valid || this.timer <= 0) {
          this.state = 'dart';
          this.target = this.pos.clone().add(v3(rnd(-0.6, 0.6), rnd(0.2, 0.5), rnd(-0.6, 0.6)));
          this.vel.set(0, 0.6, 0);
          this.timer = 3;
          break;
        }
        this.pos.copy(f.point).add(v3(0, 0.012, 0));
        this.vel.set(0, 0, 0);
        break;
      }
    }

    const perched = this.state === 'perched' || this.state === 'onFinger';
    if (!perched) {
      this.pos.addScaledVector(this.vel, dt);
      this.pos.y = Math.max(this.pos.y, this.state === 'toFinger' ? 0.005 : 0.05);
      const b = lake.dragonflyBounds;
      const hw = b.halfWidth(-this.pos.z) * 1.1;
      if (Math.abs(this.pos.x) > hw) this.pos.x = Math.sign(this.pos.x) * hw;
      this.pos.z = clamp(this.pos.z, b.far - 2, b.near + 1);
      const hv = Math.hypot(this.vel.x, this.vel.z);
      if (hv > 0.15) this.heading = lerpAngle(this.heading, Math.atan2(-this.vel.z, this.vel.x), Math.min(1, dt * 6));
    } else if (this.state === 'onFinger') {
      this.heading = lerpAngle(this.heading, Math.atan2(-(lake.camera.position.z - this.pos.z), lake.camera.position.x - this.pos.x), Math.min(1, dt * 2));
    }
    this.flying = lerp(this.flying, perched ? 0 : 1, Math.min(1, dt * 8));
    // Wingbeat around 30 Hz: far too fast to resolve, so the ghosts carry the blur; the beat
    // phase just needs to keep moving.
    this.beat += dt * TAU * 30 * this.flying;
    this.wingUniforms.uFlying.value = this.flying;
    this.wingUniforms.uBeat.value = this.beat % TAU;
    this.node.position.copy(this.pos);
    const pitch = perched ? -0.15 : clamp(-this.vel.y * 0.15, -0.4, 0.4);
    this.node.quaternion.copy(quatAxis(this.heading, 0, 1, 0)).multiply(quatAxis(pitch, 0, 0, 1));
  }

  dispose() { for (const m of [this.thoraxMat, this.abdMat, this.bandMat, this.eyeMat, this.wingMat]) m.dispose(); }
}

function lerpAngle(a, b, t) { const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; }

export class Dragonflies {
  constructor(lake, count) {
    this.lake = lake;
    this.group = new THREE.Group();
    this.list = [];
    this.setCount(count);
  }

  setCount(n) {
    while (this.list.length > n) { const d = this.list.pop(); this.group.remove(d.node); d.dispose(); }
    while (this.list.length < n) {
      const d = new Dragonfly(this.lake, pick(KINDS));
      d.pos.copy(d.pickWaypoint(this.lake));
      d.target = d.pos.clone();
      this.list.push(d);
      this.group.add(d.node);
    }
  }

  update(dt, lake) {
    // The nearest free dragonfly is the one that may come to the finger.
    lake.fingerPercher = null;
    const b = lake.dragonflyBounds, fp = lake.finger.point;
    // Only a fingertip held over their own stretch of water draws one in.
    if (lake.finger.valid && fp.z > b.far - 1 && fp.z < b.near + 1 && Math.abs(fp.x) < b.halfWidth(-fp.z) * 1.1 && fp.y < 2.5) {
      let best = null, bd = Infinity;
      for (const d of this.list) {
        if (d.state === 'onFinger') { best = d; break; }
        if (d.state !== 'hover' && d.state !== 'toFinger') continue;
        const dist = d.pos.distanceTo(lake.finger.point);
        if (dist < bd && dist < 12) { bd = dist; best = d; }
      }
      lake.fingerPercher = best;
    }
    for (const d of this.list) d.update(dt, lake);
  }

  dispose() { for (const d of this.list) d.dispose(); }
}
