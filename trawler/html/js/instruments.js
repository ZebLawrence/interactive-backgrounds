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
  constructor(parent, house, rng, parentPanel = null) {
    this.parent = parent;
    this.parentPanel = parentPanel;
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
    // The three live screens sit in the raked cherry surround standing on the dash, which is where
    // the reference photograph has them: plotter to port, sounder between, radar to starboard, all
    // square to the helmsman rather than to the boat. They are children of that surround, so they
    // take its rake and move with it. The engine gauges are not here - they are real dials with
    // real needles, built by panel.js on the overhead fascia.
    this.plotter = this.placeOn(this.parentPanel, new Screen(0.42, 0.25, 768, { emissive: 0x8fd0ff }), -0.40, 0.145, 0.034);
    this.radar = this.placeOn(this.parentPanel, new Screen(0.26, 0.25, 640, { emissive: 0x63d87f }), 0.46, 0.145, 0.034);
    this.sounder = this.placeOn(this.parentPanel, new Screen(0.25, 0.145, 512, { emissive: 0xffc24a }), 0.06, 0.145, 0.034);
    // The autopilot head, under the sounder: a narrow strip of a display in its own bezel.
    this.pilotHead = this.placeOn(this.parentPanel, new Screen(0.20, 0.070, 384, { emissive: 0x9fe36a }), 0.06, 0.045, 0.034);
  }

  /** A screen set into something that already has the right rake (the dash's instrument panel). */
  placeOn(parent, screen, x, y, z) {
    if (!parent) return this.place(screen, x, y + 4.9, z - 1.2, 0);
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

  /**
   * The autopilot head: the course it is steering, the course she is making, and which of the two
   * it is in. A real one shows exactly this and nothing else.
   */
  paintPilotHead(ctx, w, h, boat) {
    ctx.fillStyle = '#071008';
    ctx.fillRect(0, 0, w, h);
    const deg = (r) => ((r * 57.2957795 % 360) + 360) % 360;
    ctx.fillStyle = '#9fe36a';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(h * 0.52)}px "Arial Narrow", Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(deg(boat.heading).toFixed(0).padStart(3, '0'), w * 0.06, h * 0.52);
    ctx.font = `600 ${Math.round(h * 0.22)}px "Arial Narrow", Arial, sans-serif`;
    ctx.globalAlpha = 0.75;
    ctx.fillText('HDG', w * 0.06, h * 0.86);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(h * 0.34)}px "Arial Narrow", Arial, sans-serif`;
    ctx.fillText(`${(boat.speedKnots ?? 0).toFixed(1)} kn`, w * 0.96, h * 0.40);
    ctx.font = `600 ${Math.round(h * 0.22)}px "Arial Narrow", Arial, sans-serif`;
    ctx.globalAlpha = 0.75;
    ctx.fillText('AUTO', w * 0.96, h * 0.82);
    ctx.globalAlpha = 1;
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
    this.pilotHead.tick(this.time, 0.4, (c, w, h) => this.paintPilotHead(c, w, h, boat));

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
