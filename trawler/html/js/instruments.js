// Trawler — The console: the screens and dials, and what they are reading.
//
// Every one of them is showing the real thing. The radar paints the islands that are actually
// there, found by walking out along two hundred and fifty-six bearings from the boat until the
// chart says rock; the plotter draws the same coast and the track she has really run; the sounder
// reads the water under her keel; the clinometer swings with the hull's own roll; the tachometer
// follows the throttle. That is the difference between an instrument and a picture of one, and it
// is what the owner will check first.
//
// They are drawn with Canvas 2D into textures sized in world units — a 0.22 m radar on a 512 px
// canvas is 2300 pixels per metre, well past the project's rule — and repainted at a few hertz,
// because nothing on a console changes faster than that.

import * as THREE from 'three';
import { G, LAYER } from './shaders.js';
import { paint } from './materials.js';
import { Art, clamp, clamp01, lerp, TAU, DEG, toKnots } from './util.js';

const GREEN = '#7dff9a';
const AMBER = '#ffc24a';

/** A screen: a canvas, its texture, and the plane it lives on. */
class Screen {
  constructor(width, height, pixels, { emissive = 0x9fe8b4, frame = 0x16191c } = {}) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = pixels;
    this.canvas.height = Math.round((pixels * height) / width);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: new THREE.Color(emissive),
      emissiveIntensity: 1.0,
      roughness: 0.28,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.bezel = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.022, height + 0.022, 0.03),
      paint(frame, 0.55, 0.15),
    );
    this.bezel.position.z = -0.018;
    this.group = new THREE.Group();
    this.group.add(this.bezel);
    this.group.add(this.mesh);
    this.at = 0;
  }

  /** Repaints no more often than `every` seconds. */
  tick(time, every, draw) {
    if (time - this.at < every) return false;
    this.at = time;
    draw(this.ctx, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    return true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.bezel.geometry.dispose();
    this.bezel.material.dispose();
  }
}

export class Instruments {
  /**
   * @param {THREE.Object3D} parent the pilot house's group
   * @param {object} house the HOUSE constants
   */
  constructor(parent, house, rng, overheadParent = null) {
    this.parent = parent;
    this.overheadParent = overheadParent;
    this.house = house;
    this.rng = rng;
    this.time = 0;
    this.sweep = 0;
    this.track = [];
    this.trackAt = 0;
    this.ranges = [740, 1500, 3000, 6000];
    this.rangeIndex = 1;
    this.screens = [];
    this.build();
  }

  place(screen, x, y, z, rake) {
    screen.group.position.set(x, y, z);
    screen.group.rotation.x = rake;
    this.parent.add(screen.group);
    screen.group.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); });
    this.screens.push(screen);
    return screen;
  }

  build() {
    const H = this.house;
    // The radar and the plotter hang overhead, on the raked face of the console above the window.
    // They are children of it, so they inherit the rake and stay square to it.
    this.radar = this.placeOn(this.overheadParent, new Screen(0.26, 0.26, 576, { emissive: 0x63d87f }), 0.42, 0.035, 0.012);
    this.plotter = this.placeOn(this.overheadParent, new Screen(0.33, 0.24, 576, { emissive: 0x8fd0ff }), -0.38, 0.035, 0.012);
    // The dash strip between the console top and the window sill carries the rest.
    const rake = 14 * DEG;
    const y = (H.consoleTop + H.dashTop) / 2 + 0.01;
    const z = H.consoleFront + 0.145;
    this.sounder = this.place(new Screen(0.23, 0.115, 448, { emissive: 0xffc24a }), 0.0, y, z, rake);
    this.tacho = this.place(new Screen(0.15, 0.15, 320, { emissive: 0xffd9a0 }), 0.52, y, z, rake);
    this.clino = this.place(new Screen(0.30, 0.10, 448, { emissive: 0xffd9a0 }), -0.54, y, z, rake);
  }

  /** A screen set into something that already has the right rake (the overhead console). */
  placeOn(parent, screen, x, y, z) {
    if (!parent) return this.place(screen, x, y + 5.9, z - 0.96, 0);
    screen.group.position.set(x, y, z);
    parent.add(screen.group);
    screen.group.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); });
    this.screens.push(screen);
    return screen;
  }

  /**
   * Walks out along 256 bearings until the chart says rock: that is what a radar actually does,
   * and it is why an island's near shore paints and the ground behind it does not.
   */
  paintRadar(ctx, w, h, boat, depthAt) {
    const range = this.ranges[this.rangeIndex];
    const cx = w / 2, cy = h / 2, R = w / 2 - 6;
    ctx.fillStyle = '#04150a';
    ctx.fillRect(0, 0, w, h);

    // The echoes.
    ctx.save();
    ctx.translate(cx, cy);
    const step = range / 96;
    for (let i = 0; i < 256; i++) {
      const bearing = (i / 256) * TAU;
      const sx = Math.sin(bearing), sz = -Math.cos(bearing);
      for (let r = step; r < range; r += step) {
        const d = depthAt(boat.position.x + sx * r, boat.position.z + sz * r);
        if (d > 1.5) continue;
        // Relative bearing: the display is head up, as a small-boat set is.
        const rel = bearing - boat.heading;
        const px = Math.sin(rel) * (r / range) * R;
        const py = -Math.cos(rel) * (r / range) * R;
        // The echo fades with range, as a real one does.
        const age = ((this.sweep - rel) / TAU + 1) % 1;
        const bright = 0.35 + 0.65 * (1 - age);
        ctx.fillStyle = `rgba(125, 255, 154, ${(0.22 + 0.7 * bright).toFixed(3)})`;
        const size = Math.max(1.6, (R / 96) * 1.6);
        ctx.fillRect(px - size / 2, py - size / 2, size, size * 1.6);
        break; // the first land along this bearing is the only thing that paints
      }
    }

    // Range rings, the heading line and the sweep.
    ctx.strokeStyle = 'rgba(125,255,154,0.26)';
    ctx.lineWidth = 1.4;
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, (R * k) / 4, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(125,255,154,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -R);
    ctx.stroke();
    const g = ctx.createConicGradient ? null : null;
    ctx.save();
    ctx.rotate(this.sweep);
    const grad = ctx.createLinearGradient(0, 0, 0, -R);
    grad.addColorStop(0, 'rgba(125,255,154,0.55)');
    grad.addColorStop(1, 'rgba(125,255,154,0.05)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -R);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    ctx.fillStyle = GREEN;
    ctx.font = `${Math.round(w * 0.065)}px ui-monospace, monospace`;
    ctx.fillText(range >= 1852 ? `${(range / 1852).toFixed(1)} NM` : `${Math.round(range)} M`, 8, w * 0.085);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round((boat.heading * 180 / Math.PI + 360) % 360).toString().padStart(3, '0')}`, w - 8, w * 0.085);
    ctx.textAlign = 'left';
  }

  /** The plotter: the same coast, north up, with the track she has run across it. */
  paintPlotter(ctx, w, h, boat, depthAt, origin) {
    const span = 5200;
    ctx.fillStyle = '#0a1826';
    ctx.fillRect(0, 0, w, h);
    const sx = w / span, sy = h / (span * (h / w));
    const cx = w / 2, cy = h / 2;
    // The land, as a coarse raster: a plotter's chart is coarse too.
    const cells = 54;
    const cell = span / cells;
    for (let j = 0; j < Math.round(cells * (h / w)); j++) {
      for (let i = 0; i < cells; i++) {
        const x = boat.position.x + (i - cells / 2 + 0.5) * cell;
        const z = boat.position.z + (j - (cells * (h / w)) / 2 + 0.5) * cell;
        const d = depthAt(x, z);
        if (d > 22) continue;
        ctx.fillStyle = d <= 0 ? '#c9b887' : (d < 8 ? '#3c6f86' : '#1d3f55');
        ctx.fillRect(i * (w / cells), j * (w / cells), w / cells + 1, w / cells + 1);
      }
    }
    // Her track.
    ctx.strokeStyle = 'rgba(255,120,120,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.track.forEach((p, i) => {
      const px = cx + (p.x - boat.position.x) * sx;
      const py = cy + (p.z - boat.position.z) * sx;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    // The boat.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(boat.heading);
    ctx.fillStyle = '#ffe9a0';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(5, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(200,225,245,0.85)';
    ctx.font = `${Math.round(h * 0.11)}px ui-monospace, monospace`;
    ctx.fillText(`${(span / 1852).toFixed(1)} NM`, 6, h - 6);
    const pos = { x: boat.position.x + origin.x, z: boat.position.z + origin.z };
    ctx.textAlign = 'right';
    ctx.fillText(`${toKnots(Math.hypot(boat.velocity.x, boat.velocity.z)).toFixed(1)} kn`, w - 6, h - 6);
    ctx.textAlign = 'left';
  }

  /** The sounder: the depth under the keel, and the last minute of the bottom. */
  paintSounder(ctx, w, h, depth) {
    ctx.fillStyle = '#140d02';
    ctx.fillRect(0, 0, w, h);
    this.trace ??= [];
    this.trace.push(depth);
    if (this.trace.length > 120) this.trace.shift();
    const maxD = Math.max(30, Math.ceil(Math.max(...this.trace) / 25) * 25);
    ctx.fillStyle = 'rgba(255,170,60,0.55)';
    this.trace.forEach((d, i) => {
      const x = (i / 120) * w;
      const y = (clamp(d, 0, maxD) / maxD) * h;
      ctx.fillRect(x, y, w / 120 + 1, h - y);
    });
    ctx.fillStyle = AMBER;
    ctx.font = `bold ${Math.round(h * 0.52)}px ui-monospace, monospace`;
    ctx.fillText(depth > 999 ? '---' : depth.toFixed(1), 8, h * 0.58);
    ctx.font = `${Math.round(h * 0.2)}px ui-monospace, monospace`;
    ctx.fillText('m', 8 + ctx.measureText('  ').width * 4.2, h * 0.58);
    ctx.textAlign = 'right';
    ctx.fillText(`0-${maxD}`, w - 6, h - 5);
    ctx.textAlign = 'left';
  }

  paintTacho(ctx, w, h, throttle) {
    const cx = w / 2, cy = h / 2, R = w / 2 - 5;
    ctx.fillStyle = '#121010';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,230,190,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = (-220 + i * 26) * DEG;
      const r0 = R * (i % 2 ? 0.84 : 0.76);
      ctx.strokeStyle = i >= 8 ? '#ff6a4a' : 'rgba(255,230,190,0.8)';
      ctx.lineWidth = i % 2 ? 1.5 : 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * R * 0.95, cy + Math.sin(a) * R * 0.95);
      ctx.stroke();
    }
    // Idle is about a fifth of the scale; full ahead is eight tenths of it.
    const rpm = lerp(0.18, 0.80, clamp01(throttle));
    const a = (-220 + rpm * 260) * DEG;
    ctx.strokeStyle = '#ffd9a0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,217,160,0.8)';
    ctx.font = `${Math.round(w * 0.12)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(rpm * 2200)}`, cx, cy + R * 0.55);
    ctx.textAlign = 'left';
  }

  /** The clinometer: a bubble on a scale, swinging with the hull, which it really does. */
  paintClino(ctx, w, h, roll) {
    ctx.fillStyle = '#17120b';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h * 1.55, R = h * 1.2;
    ctx.strokeStyle = 'rgba(255,217,160,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI * 1.22, Math.PI * 1.78);
    ctx.stroke();
    for (let d = -30; d <= 30; d += 5) {
      const a = Math.PI * 1.5 + d * DEG * 1.0;
      const big = d % 10 === 0;
      ctx.strokeStyle = Math.abs(d) >= 25 ? '#ff7a5a' : 'rgba(255,217,160,0.85)';
      ctx.lineWidth = big ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R - (big ? h * 0.3 : h * 0.18)), cy + Math.sin(a) * (R - (big ? h * 0.3 : h * 0.18)));
      ctx.stroke();
    }
    const a = Math.PI * 1.5 + clamp(roll, -34 * DEG, 34 * DEG) * 1.0;
    ctx.fillStyle = '#ffe9b0';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (R - h * 0.42), cy + Math.sin(a) * (R - h * 0.42), h * 0.17, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,217,160,0.7)';
    ctx.font = `${Math.round(h * 0.26)}px ui-monospace, monospace`;
    ctx.fillText(`${Math.abs(roll * 180 / Math.PI).toFixed(0)}° ${roll > 0 ? 'P' : 'S'}`, 6, h - 5);
  }

  /** Cycles the radar's range: what a click on the screen does. */
  nextRange() { this.rangeIndex = (this.rangeIndex + 1) % this.ranges.length; }

  /**
   * @param {number} dt
   * @param {import('./boat.js').Boat} boat
   * @param {(x: number, z: number) => number} depthAt
   * @param {{x: number, z: number}} origin the render origin, so the plotter can show real places
   */
  step(dt, boat, depthAt, origin, night, emissiveScale = 1) {
    this.emissiveScale = emissiveScale;
    this.time += dt;
    this.sweep = (this.sweep + dt * 2.5) % TAU;
    // The track: a point every few seconds, an hour of it kept.
    if (this.time - this.trackAt > 6) {
      this.trackAt = this.time;
      this.track.push({ x: boat.position.x, z: boat.position.z });
      if (this.track.length > 600) this.track.shift();
    }
    const depth = Math.max(depthAt(boat.position.x, boat.position.z) - boat.hull.draught, 0);

    this.radar.tick(this.time, 0.12, (c, w, h) => this.paintRadar(c, w, h, boat, depthAt));
    this.plotter.tick(this.time, 1.1, (c, w, h) => this.paintPlotter(c, w, h, boat, depthAt, origin));
    this.sounder.tick(this.time, 0.5, (c, w, h) => this.paintSounder(c, w, h, depth));
    this.tacho.tick(this.time, 0.2, (c, w, h) => this.paintTacho(c, w, h, boat.throttle));
    this.clino.tick(this.time, 1 / 20, (c, w, h) => this.paintClino(c, w, h, boat.roll));

    // A screen is drawn at a chosen brightness on the glass, not at a radiance, so it is divided
    // by the camera's exposure: a set that is readable in daylight and comfortable at night, and
    // never the one thing in the frame that is blown out.
    const gain = lerp(0.16, 0.42, night) * (this.emissiveScale ?? 1);
    for (const s of this.screens) s.material.emissiveIntensity = gain;
    this.lastDepth = depth;
  }

  dispose() {
    for (const s of this.screens) {
      s.dispose();
      s.group.parent?.remove(s.group);
    }
  }
}
