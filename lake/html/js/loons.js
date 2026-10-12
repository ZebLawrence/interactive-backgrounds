// Loon Lake — Common loons out on the water: paddling slowly, turning to look at a resting
// cursor, diving when startled and on their own, and surfacing again somewhere else with a ring.
// Built from a lathe body, a tube neck, a head and a dagger bill, painted on canvases: black
// head and neck with the white necklace, a chequered back, white breast, red eye.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, v3, unit, quatAxis, Art, quantize } from './util.js';
import { LAYER } from './shaders.js';

function bodyCanvas() {
  return Art.image(1024, 512, (ctx, w, h) => {
    // u (x) runs round the body: 0 and 1 are the belly, 0.5 the back. v (y) runs tail to breast.
    ctx.fillStyle = '#f2f2f0';
    ctx.fillRect(0, 0, w, h);
    // The dark back: a broad saddle, black with rows of white chequers along the shoulders.
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0.0, 'rgba(10,10,12,0)');
    g.addColorStop(0.24, 'rgba(10,10,12,0)');
    g.addColorStop(0.3, 'rgba(10,10,12,1)');
    g.addColorStop(0.7, 'rgba(10,10,12,1)');
    g.addColorStop(0.76, 'rgba(10,10,12,0)');
    g.addColorStop(1, 'rgba(10,10,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.06, w, h * 0.9);
    // Chequers: rows of white rectangles across the back, large in the middle, fine at the edges.
    for (let row = 0; row < 7; row++) {
      const u = 0.33 + row * 0.057;
      const x = u * w;
      const big = Math.abs(u - 0.5) < 0.1;
      const cw = big ? 14 : 8, ch = big ? 9 : 6, step = big ? 22 : 14;
      for (let y = h * 0.14; y < h * 0.86; y += step) {
        if (Math.random() < 0.12) continue;
        ctx.fillStyle = `rgba(245,245,245,${big ? 1 : 0.85})`;
        ctx.fillRect(x - cw / 2 + rnd(-1, 1), y + (row % 2) * step * 0.5, cw, ch);
      }
    }
    // Flanks: fine dark streaks on white toward the waterline.
    ctx.fillStyle = 'rgba(20,20,22,0.5)';
    for (let k = 0; k < 400; k++) {
      const side = Math.random() < 0.5 ? rnd(0.2, 0.28) : rnd(0.72, 0.8);
      ctx.fillRect(side * w + rnd(-6, 6), rnd(h * 0.15, h * 0.85), 2, rnd(3, 9));
    }
    // The tail end darkens; the breast is pure white.
    const t = ctx.createLinearGradient(0, 0, 0, h * 0.14);
    t.addColorStop(0, 'rgba(15,15,18,0.9)');
    t.addColorStop(1, 'rgba(15,15,18,0)');
    ctx.fillStyle = t;
    ctx.fillRect(0, 0, w, h * 0.14);
  });
}

function neckCanvas() {
  return Art.image(512, 256, (ctx, w, h) => {
    // u runs up the neck from the shoulders (0) to the head (1); v runs round it.
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, w, h);
    // A faint green-purple sheen band.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(20,60,40,0.25)');
    g.addColorStop(0.5, 'rgba(60,30,70,0.2)');
    g.addColorStop(1, 'rgba(20,60,40,0.25)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // The necklace: a band of vertical white stripes round the middle of the neck, broken at the back.
    ctx.fillStyle = '#f4f4f2';
    for (let v = 0.08; v < 0.92; v += 0.075) ctx.fillRect(w * 0.42, v * h, w * 0.14, h * 0.038);
    // A lower half-collar of fine stripes where the neck meets the chest.
    for (let v = 0.25; v < 0.75; v += 0.05) ctx.fillRect(w * 0.1, v * h, w * 0.12, h * 0.022);
  });
}

const SHARED = {};

function parts() {
  if (SHARED.body) return SHARED;
  // Body: a lathe along +x, tail at x = 0, breast at x = 0.78. The hull sits low in the water.
  const pts = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = 0.145 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.75) + 0.004;
    pts.push(new THREE.Vector2(r, t * 0.78));
  }
  const body = new THREE.LatheGeometry(pts, 36);
  body.rotateZ(-Math.PI / 2);
  // Flatten the hull a little and raise the tail.
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setY(i, y * 0.85 + Math.pow(1 - x / 0.78, 3) * 0.06);
    p.setZ(i, z * 1.1);
  }
  body.computeVertexNormals();
  // Neck: a tube curving up from the shoulders, with the head and bill on top.
  const neckCurve = new THREE.CatmullRomCurve3([v3(0.6, 0.06, 0), v3(0.7, 0.15, 0), v3(0.73, 0.27, 0), v3(0.73, 0.36, 0)]);
  const neck = new THREE.TubeGeometry(neckCurve, 16, 0.045, 14, false);
  const head = new THREE.SphereGeometry(1, 24, 16);
  head.scale(0.075, 0.062, 0.058);
  head.translate(0.76, 0.4, 0);
  const bill = new THREE.ConeGeometry(0.019, 0.13, 12);
  bill.rotateZ(-Math.PI / 2);
  bill.translate(0.88, 0.395, 0);
  const eye = new THREE.SphereGeometry(0.009, 10, 8);
  SHARED.body = body; SHARED.neck = neck; SHARED.head = head; SHARED.bill = bill; SHARED.eye = eye;
  SHARED.bodyTex = Art.texture(bodyCanvas(), { repeat: true });
  // The lathe's seam runs along the flank: shift the painting so the back sits on top.
  SHARED.bodyTex.offset.x = -0.25;
  SHARED.neckTex = Art.texture(neckCanvas());
  return SHARED;
}

export class Loon {
  constructor(lake) {
    this.lake = lake;
    const P = parts();
    this.bodyMat = new THREE.MeshStandardMaterial({ map: P.bodyTex, roughness: 0.6, metalness: 0.05 });
    this.neckMat = new THREE.MeshStandardMaterial({ map: P.neckTex, roughness: 0.5, metalness: 0.15 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.45, metalness: 0.2 });
    this.billMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.35, metalness: 0.3 });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x8a0f0f, roughness: 0.3, emissive: 0x300000 });
    this.node = new THREE.Group();
    this.body = new THREE.Mesh(P.body, this.bodyMat);
    // The head group pivots at the base of the neck so the loon can look about.
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0.6, 0.06, 0);
    const neck = new THREE.Mesh(P.neck, this.neckMat);
    const head = new THREE.Mesh(P.head, this.headMat);
    const bill = new THREE.Mesh(P.bill, this.billMat);
    const eyeL = new THREE.Mesh(P.eye, this.eyeMat), eyeR = new THREE.Mesh(P.eye, this.eyeMat);
    eyeL.position.set(0.785, 0.41, 0.05); eyeR.position.set(0.785, 0.41, -0.05);
    for (const m of [neck, head, bill, eyeL, eyeR]) { m.position.sub(this.headGroup.position); this.headGroup.add(m); }
    this.node.add(this.body, this.headGroup);
    this.node.traverse((o) => { o.layers.enable(LAYER.ABOVE); o.frustumCulled = false; });

    this.pos = v3();
    this.heading = rnd(0, TAU);
    this.speed = 0.2;
    this.lookYaw = 0;
    this.lookTarget = 0;
    this.state = 'paddle';
    this.timer = rnd(5, 20);
    this.diveTimer = rnd(40, 120);
    this.submerged = 0; // 0 afloat, 1 fully under
    this.bobPhase = rnd(0, TAU);
    this.wanderPhase = rnd(0, TAU);
    this.scanTimer = rnd(2, 6);
  }

  dive() {
    if (this.state === 'dive' || this.state === 'under' || this.state === 'surface') return;
    this.state = 'dive';
    this.timer = 0.7;
    this.lake.disturb(this.pos.x, this.pos.z, 0.5, -0.02, 0.8);
  }

  update(dt, lake) {
    const cursor = lake.cursor;
    this.timer -= dt;
    this.diveTimer -= dt;
    const bounds = lake.loonBounds;

    // Startles: a fast cursor sweeping close, or a stone landing near by.
    if (this.state === 'paddle' || this.state === 'approach') {
      const scr = lake.project(this.pos);
      if (cursor.present && cursor.speed > 600 && scr.depth > 1) {
        const dpx = Math.hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y);
        if (dpx < (120 + Math.min(cursor.speed, 2500) * 0.06) / (1 + scr.depth / 40)) this.dive();
      }
      for (const s of lake.startles) if (Math.hypot(this.pos.x - s.x, this.pos.z - s.z) < s.radius * 1.5) this.dive();
    }

    switch (this.state) {
      case 'paddle': {
        this.wanderPhase += dt * 0.2;
        this.heading += Math.sin(this.wanderPhase + this.bobPhase) * 0.12 * dt;
        this.speed = lerp(this.speed, 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(this.wanderPhase * 0.7)), dt * 0.5);
        if (this.diveTimer <= 0) { this.dive(); this.diveTimer = rnd(60, 180); }
        // A fingertip held still for a while draws the nearest loon in, slowly, to have a look.
        if (cursor.present && cursor.stillTime > 5 && lake.finger.inWater && this.pos.distanceTo(lake.finger.point) < 45 && lake.loonApproacher === this) {
          this.state = 'approach';
        }
        break;
      }
      case 'approach': {
        const f = lake.finger;
        if (!cursor.present || cursor.stillTime < 1 || !f.inWater) { this.state = 'paddle'; break; }
        const to = f.point.clone().sub(this.pos);
        const d = Math.hypot(to.x, to.z);
        const goal = Math.atan2(-to.z, to.x);
        this.heading = lerpAngle(this.heading, goal, Math.min(1, dt * 0.4));
        this.speed = lerp(this.speed, d > 7 ? 0.3 : 0.0, dt * 0.6);
        break;
      }
      case 'dive': {
        // Nose down and slip under.
        this.submerged = Math.min(1, this.submerged + dt / 0.7);
        this.speed = lerp(this.speed, 0.6, dt * 3);
        if (this.timer <= 0) { this.state = 'under'; this.timer = rnd(20, 45); this.submerged = 1; }
        break;
      }
      case 'under': {
        if (this.timer <= 0) {
          // Surface somewhere else, within the loons' water.
          for (let tries = 0; tries < 30; tries++) {
            const a = rnd(0, TAU), r = rnd(8, 30);
            const x = this.pos.x + Math.cos(a) * r, z = this.pos.z + Math.sin(a) * r;
            if (z < bounds.near && z > bounds.far && Math.abs(x) < bounds.halfWidth(-z) * 0.85) { this.pos.set(x, 0, z); break; }
          }
          this.heading = rnd(0, TAU);
          this.state = 'surface';
          this.timer = 1.0;
          this.speed = 0.05;
          lake.disturb(this.pos.x, this.pos.z, 0.6, -0.02, 1.0);
        }
        break;
      }
      case 'surface': {
        this.submerged = Math.max(0, this.submerged - dt / 1.0);
        if (this.timer <= 0) { this.state = 'paddle'; this.submerged = 0; this.timer = rnd(5, 20); }
        break;
      }
    }

    // Move, and keep to the loons' water with gentle turns.
    const fwd = v3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    if (this.state !== 'under') this.pos.addScaledVector(fwd, this.speed * dt);
    const hw = bounds.halfWidth(-this.pos.z) * 0.85;
    if (Math.abs(this.pos.x) > hw || this.pos.z > bounds.near || this.pos.z < bounds.far) {
      // Out of the loons' water: turn back toward the middle of it.
      const home = Math.atan2(-((bounds.near + bounds.far) / 2 - this.pos.z), -this.pos.x);
      if (this.state === 'paddle') this.heading = lerpAngle(this.heading, home, Math.min(1, dt * 0.5));
    }
    // The wake: a shallow moving dent under the hull.
    if (this.state !== 'under' && this.speed > 0.05) lake.disturb(this.pos.x + fwd.x * 0.25, this.pos.z + fwd.z * 0.25, 0.45, -0.00025 * this.speed / 0.25 * dt * 60, 0);

    // Looking about: toward a resting fingertip if it is near, otherwise an idle scan.
    this.scanTimer -= dt;
    if (cursor.present && cursor.stillTime > 1.2 && lake.finger.valid && this.pos.distanceTo(lake.finger.point) < 40) {
      const to = lake.finger.point.clone().sub(this.pos);
      this.lookTarget = clamp(angleDiff(Math.atan2(-to.z, to.x), this.heading), -1.6, 1.6);
    } else if (this.scanTimer <= 0) {
      this.scanTimer = rnd(3, 9);
      this.lookTarget = rnd(-0.9, 0.9);
    }
    this.lookYaw = lerp(this.lookYaw, this.lookTarget, Math.min(1, dt * 1.5));
    this.headGroup.rotation.y = this.lookYaw;

    // Riding the water: a slow bob and roll; nose down when diving.
    const t = lake.clock;
    const bob = 0.012 * Math.sin(t * quantize(0.6) + this.bobPhase) + 0.006 * Math.sin(t * quantize(1.3) + this.bobPhase * 2);
    const rollA = 0.03 * Math.sin(t * quantize(0.45) + this.bobPhase);
    const pitch = this.state === 'dive' ? -this.submerged * 0.9 : (this.state === 'surface' ? -this.submerged * 0.4 : 0.02 * Math.sin(t * quantize(0.5) + this.bobPhase));
    this.node.position.set(this.pos.x, -0.04 + bob - this.submerged * 0.7, this.pos.z);
    this.node.quaternion.copy(quatAxis(this.heading, 0, 1, 0)).multiply(quatAxis(pitch, 0, 0, 1)).multiply(quatAxis(rollA, 1, 0, 0));
    this.node.visible = this.state !== 'under';
  }

  dispose() { for (const m of [this.bodyMat, this.neckMat, this.headMat, this.billMat, this.eyeMat]) m.dispose(); }
}

function angleDiff(a, b) { return ((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI; }
function lerpAngle(a, b, t) { return a + angleDiff(b, a) * t; }

export class Loons {
  constructor(lake, count) {
    this.lake = lake;
    this.group = new THREE.Group();
    this.list = [];
    this.setCount(count);
  }

  setCount(n) {
    while (this.list.length > n) { const l = this.list.pop(); this.group.remove(l.node); l.dispose(); }
    while (this.list.length < n) {
      const l = new Loon(this.lake);
      const b = this.lake.loonBounds;
      for (let tries = 0; tries < 40; tries++) {
        const z = rnd(b.far * 0.9, b.near - 4), x = rnd(-0.75, 0.75) * b.halfWidth(-z);
        if (this.list.every((o) => Math.hypot(o.pos.x - x, o.pos.z - z) > 8)) { l.pos.set(x, 0, z); break; }
      }
      this.list.push(l);
      this.group.add(l.node);
    }
  }

  update(dt, lake) {
    // Only the nearest loon to a resting fingertip comes over.
    const f = lake.finger;
    lake.loonApproacher = null;
    if (f.inWater) {
      let best = null, bd = Infinity;
      for (const l of this.list) { const d = l.pos.distanceTo(f.point); if (d < bd) { bd = d; best = l; } }
      lake.loonApproacher = best;
    }
    for (const l of this.list) l.update(dt, lake);
    // Loons keep their distance from one another.
    for (let i = 0; i < this.list.length; i++) for (let j = i + 1; j < this.list.length; j++) {
      const a = this.list[i], b = this.list[j];
      const d = a.pos.distanceTo(b.pos);
      if (d < 3 && d > 1e-3) { const push = a.pos.clone().sub(b.pos).multiplyScalar((3 - d) / d * 0.5 * dt); a.pos.add(push); b.pos.sub(push); }
    }
  }

  dispose() { for (const l of this.list) l.dispose(); }
}
