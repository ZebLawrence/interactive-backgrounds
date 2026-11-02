// Hangar — Consoles: banks of computer consoles with live screens in the computer rooms.
//
// Each unit (propplan.planConsoles) stands against a wall: a base cabinet on the floor, a sloped key ledge
// with lit keys, an upper cabinet and a bezel holding a 0.9 × 0.45 m screen. Every screen is its own
// 1024 × 512 canvas (about 1140 px per metre) with abstract readouts (a trace, bar meters, a sweep, number
// columns) in amber, green or cyan, redrawn at SCREEN_HZ; uploads are spread over frames (at most
// MAX_UPLOADS a frame) and skipped for screens behind the camera or far away. Mipmaps are rebuilt with each
// upload (4 Hz, never per frame) and anisotropy is at max, so the text stays crisp at walking distance and
// calm further off. A click wakes a screen: it brightens and scrolls a burst of log text, then settles.

import * as THREE from 'three';
import { planConsoles, CONSOLE_W } from './propplan.js';
import { boxGeo } from './doors.js';

export const SCREEN_W = 1024, SCREEN_H = 512;
export const SCREEN_HZ = 4;
const BURST_HZ = 15; // a woken screen scrolls at this rate during its burst
const BURST_TIME = 6; // s
const MAX_UPLOADS = 2; // per frame
const FAR = 22; // m: screens further than this keep their last image
const IDLE_GLOW = 1.15, WAKE_GLOW = 2.6;
const SCR_W = 0.9, SCR_H = 0.45;
const SCREEN_Y = 1.5, SCREEN_TILT = 0.14; // centre height above the floor, lean back (rad)

const PALETTES = [
  { name: 'amber', fg: '#ffb43a', hi: '#ffe2a0', dim: '#5a3a0c', bg: '#0d0702' },
  { name: 'green', fg: '#46ff7a', hi: '#c6ffd6', dim: '#0f4a22', bg: '#020a04' },
  { name: 'cyan', fg: '#3fe4ff', hi: '#c8f6ff', dim: '#0c4250', bg: '#02080b' },
];
const WORDS = ['RELAY', 'COOLANT', 'GRID', 'HANGAR', 'BAY', 'LIFT', 'DOOR', 'SECTOR', 'PUMP', 'VENT', 'SENSOR', 'CORE', 'LINK', 'BUS', 'NODE', 'ARRAY', 'TOXIN', 'FILTER', 'POWER', 'BEACON'];
const VERBS = ['OK', 'SYNC', 'NOMINAL', 'CHECK', 'ACK', 'IDLE', 'PURGE', 'ROUTE', 'HOLD', 'READY', 'CYCLE', 'LOCK'];

/** Contact shade under a base cabinet: a soft dark gradient, darkest at the cabinet. */
function shadeTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)');
  gr.addColorStop(0.35, 'rgba(0,0,0,0.35)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Screen {
  constructor(unit, rng, renderer) {
    this.unit = unit;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H;
    this.g = this.canvas.getContext('2d');
    this.pal = PALETTES[Math.floor(rng.next() * PALETTES.length) % PALETTES.length];
    this.layout = Math.floor(rng.next() * 3) % 3;
    this.rng = rng;
    this.trace = Array.from({ length: 96 }, (_, i) => 0.5 + 0.3 * Math.sin(i * 0.2));
    this.bars = Array.from({ length: 12 }, () => rng.range(0.2, 0.9));
    this.nums = Array.from({ length: 9 }, () => Math.floor(rng.range(0, 65535)));
    this.sweep = rng.range(0, Math.PI * 2);
    this.blips = Array.from({ length: 5 }, () => [rng.range(0, Math.PI * 2), rng.range(0.2, 0.9)]);
    this.title = `${WORDS[Math.floor(rng.next() * WORDS.length) % WORDS.length]} ${String(Math.floor(rng.range(1, 99))).padStart(2, '0')}`;
    this.ticks = Math.floor(rng.range(0, 1e5));
    this.next = rng.range(0, 1 / SCREEN_HZ); // staggered
    this.glow = IDLE_GLOW;
    this.burst = 0; // s left
    this.lines = [];
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, color: new THREE.Color(1, 1, 1) });
    this.mat.toneMapped = true;
    this.draw();
  }

  logLine() {
    const r = this.rng;
    const w = WORDS[Math.floor(r.next() * WORDS.length) % WORDS.length];
    const v = VERBS[Math.floor(r.next() * VERBS.length) % VERBS.length];
    const hex = Math.floor(r.range(0, 0xffffff)).toString(16).toUpperCase().padStart(6, '0');
    return `> ${w.padEnd(8)} ${hex}  ${v}`;
  }

  wake() {
    this.burst = BURST_TIME;
    this.lines = Array.from({ length: 3 }, () => this.logLine());
    this.next = 0;
  }

  /** Advances the readouts one tick and redraws the canvas. */
  draw() {
    const g = this.g, P = this.pal, W = SCREEN_W, H = SCREEN_H, r = this.rng;
    this.ticks++;
    this.trace.shift();
    const last = this.trace[this.trace.length - 1] ?? 0.5;
    this.trace.push(Math.min(0.95, Math.max(0.05, last + r.range(-0.08, 0.08) + (0.5 - last) * 0.08)));
    this.bars = this.bars.map((b) => Math.min(0.98, Math.max(0.05, b + r.range(-0.07, 0.07))));
    if (r.next() < 0.3) this.nums[Math.floor(r.next() * this.nums.length) % this.nums.length] = Math.floor(r.range(0, 65535));
    this.sweep = (this.sweep + 0.35) % (Math.PI * 2);

    g.fillStyle = P.bg;
    g.fillRect(0, 0, W, H);
    g.lineWidth = 2;
    g.strokeStyle = P.dim;
    g.strokeRect(10, 10, W - 20, H - 20);
    // Header.
    g.fillStyle = P.dim;
    g.fillRect(10, 10, W - 20, 46);
    g.fillStyle = P.hi;
    g.font = 'bold 30px "Menlo", "Consolas", "DejaVu Sans Mono", monospace';
    g.textBaseline = 'middle';
    g.fillText(this.title, 26, 34);
    g.textAlign = 'right';
    const t = this.ticks;
    g.fillText(`T+${String(Math.floor(t / 14400)).padStart(2, '0')}:${String(Math.floor(t / 240) % 60).padStart(2, '0')}:${String(Math.floor(t / 4) % 60).padStart(2, '0')}`, W - 26, 34);
    g.textAlign = 'left';

    if (this.burst > 0) { this.drawBurst(); return; }
    const L = this.layout;
    // Left panel: a trace (layout 0, 2) or a sweep (layout 1).
    const lx = 26, ly = 74, lw = 600, lh = 410;
    g.strokeStyle = P.dim;
    g.strokeRect(lx, ly, lw, lh);
    g.lineWidth = 1;
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(lx, ly + (lh * i) / 6); g.lineTo(lx + lw, ly + (lh * i) / 6); g.stroke(); }
    for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(lx + (lw * i) / 8, ly); g.lineTo(lx + (lw * i) / 8, ly + lh); g.stroke(); }
    if (L === 1) {
      const cx = lx + lw / 2, cy = ly + lh / 2, R = lh / 2 - 14;
      g.strokeStyle = P.fg;
      g.lineWidth = 2;
      for (const k of [0.33, 0.66, 1]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }
      const grad = g.createConicGradient ? g.createConicGradient(this.sweep - 0.9, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.14, P.fg + '66');
        grad.addColorStop(0.15, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      }
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(this.sweep) * R, cy + Math.sin(this.sweep) * R); g.stroke();
      g.fillStyle = P.hi;
      for (const [a, d] of this.blips) {
        const age = ((this.sweep - a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        g.globalAlpha = Math.max(0.15, 1 - age / 4);
        g.beginPath(); g.arc(cx + Math.cos(a) * R * d, cy + Math.sin(a) * R * d, 7, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    } else {
      g.strokeStyle = P.fg;
      g.lineWidth = 3;
      g.beginPath();
      this.trace.forEach((v, i) => {
        const x = lx + (lw * i) / (this.trace.length - 1), y = ly + lh * (1 - v);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      if (L === 2) {
        g.strokeStyle = P.hi;
        g.lineWidth = 2;
        g.beginPath();
        this.trace.forEach((v, i) => {
          const x = lx + (lw * i) / (this.trace.length - 1), y = ly + lh * (0.5 + 0.35 * Math.sin(i * 0.31 + t * 0.4) * v);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.stroke();
      }
    }
    // Right panel: bar meters over a number column.
    const rx = 650, ry = 74, rw = 348;
    g.lineWidth = 2;
    g.strokeStyle = P.dim;
    g.strokeRect(rx, ry, rw, 190);
    const n = this.bars.length, bw = (rw - 20) / n;
    this.bars.forEach((b, i) => {
      g.fillStyle = b > 0.85 ? P.hi : P.fg;
      g.fillRect(rx + 10 + i * bw + 3, ry + 180 - 170 * b, bw - 6, 170 * b);
    });
    g.font = '26px "Menlo", "Consolas", "DejaVu Sans Mono", monospace';
    g.fillStyle = P.fg;
    this.nums.forEach((v, i) => {
      const y = ry + 220 + i * 30;
      if (y > H - 30) return;
      g.fillStyle = i % 3 === 0 ? P.hi : P.fg;
      g.fillText(`${(i + 1).toString(16).toUpperCase()}  ${v.toString(16).toUpperCase().padStart(4, '0')}  ${String(v % 1000).padStart(3, '0')}`, rx + 12, y);
    });
    // A blinking cursor block.
    if (t % 2 === 0) { g.fillStyle = P.fg; g.fillRect(lx + 6, H - 26, 16, 6); }
  }

  drawBurst() {
    const g = this.g, P = this.pal, W = SCREEN_W, H = SCREEN_H;
    this.lines.push(this.logLine());
    const rows = 14;
    while (this.lines.length > rows) this.lines.shift();
    g.font = '27px "Menlo", "Consolas", "DejaVu Sans Mono", monospace';
    g.textBaseline = 'middle';
    this.lines.forEach((s, i) => {
      g.fillStyle = i === this.lines.length - 1 ? P.hi : P.fg;
      g.fillText(s, 28, 84 + i * 29);
    });
    // Progress bar along the bottom.
    const k = 1 - this.burst / BURST_TIME;
    g.strokeStyle = P.fg;
    g.strokeRect(28, H - 34, W - 56, 14);
    g.fillStyle = P.fg;
    g.fillRect(30, H - 32, (W - 60) * k, 10);
  }
}

export class Consoles {
  /**
   * `scene` is the THREE.Scene, `rng` the seed's stream (screen content varies per seed). opts: { renderer,
   * assets (PropMaterials), switches (planned switch spots to keep clear of) }.
   */
  constructor(level, scene, rng, opts = {}) {
    this.level = level;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'consoles';
    this.units = planConsoles(level, opts.switches ?? []);
    this.screens = [];
    this.interactive = [];
    this.byId = new Map();
    this.time = 0;
    this.cursor = 0;
    this.uploads = 0; // total, for checks
    const A = opts.assets;
    this.bezelMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.45, metalness: 0.5 });
    this.shadeTex = shadeTexture();
    this.shadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: this.shadeTex, transparent: true, depthWrite: false, opacity: 0.55 });
    this.keyMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const keys = [];
    for (const u of this.units) {
      const sr = rng.fork(u.id);
      const g = new THREE.Group();
      g.position.set(u.x, u.floor, u.z);
      g.rotation.y = u.yaw; // local +z points into the room
      const W = CONSOLE_W - 0.02;
      const part = (geo, tag, x, y, z, rx = 0) => {
        const m = new THREE.Mesh(geo, null);
        m.material = tag ? A.get(tag, m) : this.bezelMat;
        m.position.set(x, y, z);
        m.rotation.x = rx;
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.sector = u.sector;
        m.userData.interactive = { kind: 'console', id: u.id };
        g.add(m);
        this.interactive.push(m);
        return m;
      };
      part(boxGeo(W, 0.86, 0.2), 'mat:computer', 0, 0.43, 0.1);
      part(boxGeo(W, 0.035, 0.24), 'mat:steel-brushed', 0, 0.9, 0.12, 0.2);
      part(boxGeo(W, 1.3, 0.11), 'mat:computer', 0, 0.95 + 0.65, 0.055);
      part(boxGeo(0.96, 0.53, 0.04), null, 0, SCREEN_Y, 0.13, -SCREEN_TILT);
      // Keys: little lit squares in rows on the ledge (one instanced mesh for every console).
      const ledge = new THREE.Object3D();
      ledge.position.set(0, 0.92, 0.12);
      ledge.rotation.x = 0.2;
      g.add(ledge);
      for (let row = 0; row < 2; row++) for (let k = 0; k < 10; k++) {
        if (sr.next() < 0.3) continue;
        const o = new THREE.Object3D();
        o.position.set(-0.36 + k * 0.08, 0.02, -0.05 + row * 0.07);
        ledge.add(o);
        keys.push({ o, color: sr.next() < 0.5 ? PALETTES[Math.floor(sr.next() * 3) % 3].fg : '#d8dde2', lit: sr.next() < 0.6 });
      }
      // The screen, just proud of the bezel.
      const scr = new Screen(u, sr, opts.renderer);
      const sm = new THREE.Mesh(new THREE.PlaneGeometry(SCR_W, SCR_H), scr.mat);
      const tilt = new THREE.Object3D();
      tilt.position.set(0, SCREEN_Y, 0.13);
      tilt.rotation.x = -SCREEN_TILT;
      sm.position.z = 0.021;
      sm.userData.interactive = { kind: 'console', id: u.id };
      sm.userData.sector = u.sector;
      tilt.add(sm);
      g.add(tilt);
      this.interactive.push(sm);
      // Contact shade on the floor in front of the base.
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.08, 0.16), this.shadeMat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(0, 0.003, 0.2 + 0.08);
      sh.renderOrder = 1;
      g.add(sh);
      this.group.add(g);
      scr.mesh = sm;
      scr.world = new THREE.Vector3();
      this.screens.push(scr);
      this.byId.set(u.id, scr);
    }
    // Instanced keys.
    this.group.updateMatrixWorld(true);
    if (keys.length) {
      const geo = new THREE.BoxGeometry(0.05, 0.012, 0.045);
      this.keys = new THREE.InstancedMesh(geo, this.keyMat, keys.length);
      const c = new THREE.Color();
      keys.forEach((k, i) => {
        this.keys.setMatrixAt(i, k.o.matrixWorld);
        c.set(k.color).multiplyScalar(k.lit ? 1.4 : 0.12);
        this.keys.setColorAt(i, c);
      });
      this.keys.instanceMatrix.needsUpdate = true;
      if (this.keys.instanceColor) this.keys.instanceColor.needsUpdate = true;
      this.keys.castShadow = false;
      this.group.add(this.keys);
    }
    for (const s of this.screens) s.mesh.getWorldPosition(s.world);
    this.camDir = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
  }

  /** A click on a console: its screen wakes, brightens and scrolls a burst of text. */
  operate(id) {
    const s = this.byId.get(id);
    if (!s) return false;
    s.wake();
    return true;
  }

  /** Steps the readouts; redraws and uploads at most MAX_UPLOADS due screens in front of `camera`. */
  update(dt, camera) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.time += dt;
    const n = this.screens.length;
    if (!n) return;
    if (camera) camera.getWorldDirection(this.camDir);
    let uploads = 0;
    for (let k = 0; k < n; k++) {
      const s = this.screens[(this.cursor + k) % n];
      if (s.burst > 0) s.burst = Math.max(0, s.burst - dt);
      // Brightness: up fast on a wake, back down slowly after the burst.
      const want = s.burst > 0 ? WAKE_GLOW : IDLE_GLOW;
      s.glow += (want - s.glow) * Math.min(1, dt / (want > s.glow ? 0.25 : 2.5));
      if (!Number.isFinite(s.glow)) s.glow = IDLE_GLOW;
      s.mat.color.setScalar(s.glow);
      if (this.time < s.next || uploads >= MAX_UPLOADS) continue;
      s.next = Math.max(s.next + 1 / (s.burst > 0 ? BURST_HZ : SCREEN_HZ), this.time);
      if (camera) {
        const d = this.tmp.copy(s.world).sub(camera.position);
        const dist = d.length();
        if (dist > FAR || (dist > 1.5 && d.dot(this.camDir) < -0.2 * dist)) continue; // far or behind
      }
      s.draw();
      s.tex.needsUpdate = true;
      uploads++;
      this.uploads++;
    }
    this.cursor = (this.cursor + 1) % n;
  }

  dispose() {
    for (const s of this.screens) { s.tex.dispose(); s.mat.dispose(); }
    this.shadeTex.dispose();
    this.shadeMat.dispose();
    this.bezelMat.dispose();
    this.keyMat.dispose();
    this.keys?.geometry.dispose();
    this.keys?.dispose();
  }
}
