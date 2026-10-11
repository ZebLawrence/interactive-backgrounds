// Firefly Meadow — Storm mode: rain, and lightning that forks down behind the trees.

import * as THREE from 'three';
import { rnd, randInt, clamp, v3, Art } from './util.js';
import { G } from './shaders.js';

export class Rain {
  constructor(groundHeight) {
    this.groundHeight = groundHeight;
    const n = 2200;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.box = { x: 16, yTop: 9, zNear: 1, zFar: -26 };
    for (let i = 0; i < n; i++) this.pos.set([rnd(-this.box.x, this.box.x), rnd(-1, this.box.yTop), rnd(this.box.zFar, this.box.zNear)], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.texture = Art.texture(Art.streak(128));
    this.material = new THREE.PointsMaterial({
      map: this.texture, size: 0.3, sizeAttenuation: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, color: new THREE.Color(0.55, 0.62, 0.8), opacity: 0, fog: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  update(dt, storm, wind) {
    this.material.opacity = storm * 0.4;
    this.points.visible = storm > 0.01;
    if (!this.points.visible) return;
    const p = this.pos, b = this.box;
    const dir = G.uWindDir.value;
    const fall = 9 * dt, driftX = dir.x * wind * 0.5 * dt, driftZ = dir.y * wind * 0.5 * dt;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      p[k] += driftX;
      p[k + 1] -= fall;
      p[k + 2] += driftZ;
      if (p[k + 1] < this.groundHeight(p[k], p[k + 2]) - 0.5) {
        p[k] = rnd(-b.x, b.x);
        p[k + 1] = b.yTop + rnd(0, 2);
        p[k + 2] = rnd(b.zFar, b.zNear);
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); this.texture.dispose(); }
}

/** Draws a forked bolt down a tall canvas. */
function boltCanvas() {
  const w = 512, h = 1024;
  return Art.image(w, h, (ctx) => {
    const paths = [];
    const walk = (x, y, len, spread, depth) => {
      const pts = [[x, y]];
      let a = Math.PI / 2 + rnd(-0.3, 0.3);
      while (y < h * (0.78 + depth * 0.05) && len-- > 0) {
        a += rnd(-spread, spread);
        a = clamp(a, Math.PI / 2 - 1.1, Math.PI / 2 + 1.1);
        const step = rnd(14, 34);
        x += Math.cos(a) * step;
        y += Math.sin(a) * step;
        pts.push([x, y]);
        if (depth < 2 && Math.random() < 0.1) walk(x, y, randInt(6, 18), spread * 1.3, depth + 1);
      }
      paths.push({ pts, depth });
    };
    walk(rnd(w * 0.3, w * 0.7), 0, 80, 0.5, 0);
    for (const pass of [[18, 'rgba(150,170,255,0.35)', 28], [6, 'rgba(200,215,255,0.8)', 10], [2.2, '#ffffff', 0]]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = pass[2];
      ctx.shadowColor = 'rgba(160,180,255,1)';
      for (const { pts, depth } of paths) {
        ctx.lineWidth = pass[0] / (1 + depth * 0.8);
        ctx.strokeStyle = pass[1];
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
    }
  });
}

export class Lightning {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      map: null, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      color: new THREE.Color(2.2, 2.3, 2.8), opacity: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 120), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.timer = rnd(2, 5);
    this.strike = null;
    this.flash = 0;
  }

  update(dt, storm) {
    if (this.strike) {
      const s = this.strike;
      s.t += dt;
      let f = 0;
      for (const [t0, peak] of s.bursts) if (s.t >= t0) f += peak * Math.exp(-(s.t - t0) / 0.07);
      this.flash = Math.min(1, f);
      this.material.opacity = s.t < 0.4 ? Math.min(1, f * 1.6) : 0;
      this.mesh.visible = this.material.opacity > 0.01;
      if (s.t > 1.2) { this.strike = null; this.flash = 0; }
    }
    G.uFlash.value = this.flash;
    if (storm < 0.4) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = rnd(4, 15);
    this.material.map?.dispose();
    this.material.map = Art.texture(boltCanvas());
    this.material.needsUpdate = true;
    this.mesh.position.set(rnd(-80, 80), 60, -140);
    this.strike = { t: 0, bursts: [[0, 1], [0.1 + rnd(0, 0.08), rnd(0.5, 0.9)], [0.25 + rnd(0, 0.15), rnd(0.2, 0.6)]] };
  }

  dispose() { this.material.map?.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}
