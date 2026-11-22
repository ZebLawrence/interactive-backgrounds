// Trawler — The console: the screens, and what they are reading.
//
// Every one of them is showing the real thing. The radar paints the islands that are actually
// there, found by walking out along two hundred and fifty-six bearings from the boat until the
// chart says rock; the chart beside it draws the same coast and the track she has really run; the
// fishfinder reads the water under her keel; the autopilot head shows the heading she is making;
// the stabiliser display reads the hull's own roll. That is the difference between an instrument
// and a picture of one, and it is what the owner will check first.
//
// They are drawn with Canvas 2D into textures sized in world units - the 0.40 m nav display on a
// 1024 px canvas is 2560 pixels per metre, well past the project's rule - and repainted at a few
// hertz, because nothing on a console changes faster than that. The bezels, keys and glass round
// each one are panel.js's Display; this module only paints what is behind the glass. Where each
// display hangs is the house's business: pilot.js publishes a mount for every screen and this
// module fills it.

import * as THREE from 'three';
import { G, LAYER } from './shaders.js';
import { Display, AutopilotHead } from './panel.js';
import { Art, clamp, clamp01, lerp, TAU, DEG, toKnots } from './util.js';

const GREEN = '#7dff9a';
const MONO = 'ui-monospace, Consolas, monospace';
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CONDENSED = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * A screen: a canvas, its texture, and the material a Display puts behind its glass. `backlight`
 * is how much of the console's emissive gain this one takes: a colour TFT is a lamp, a grey
 * segment LCD is mostly a reflective surface with a faint glow behind it.
 */
class Screen {
  constructor(width, height, pixels, { emissive = 0xffffff, backlight = 1, roughness = 0.28 } = {}) {
    this.width = width;
    this.height = height;
    this.backlight = backlight;
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
      roughness,
      metalness: 0,
    });
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
  }
}

/** A grey segment-LCD's ground: the glass's own colour, with its faint pixel grid. */
function lcdGround(ctx, w, h, colour = '#a9b3a4') {
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#1a2416';
  for (let x = 0; x < w; x += 3) ctx.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  ctx.globalAlpha = 1;
}

export class Instruments {
  /**
   * @param {THREE.Object3D} parent the pilot house's group
   * @param {object} house the HOUSE constants
   * @param {import('./util.js').Rng} rng
   * @param {import('./pilot.js').PilotHouse|null} pilot the house, for where its screens go
   */
  constructor(parent, house, rng, pilot = null) {
    this.parent = parent;
    this.pilot = pilot;
    this.house = house;
    this.rng = rng;
    this.time = 0;
    this.sweep = 0;
    this.track = [];
    this.trackAt = 0;
    this.ranges = [740, 1500, 3000, 6000];
    this.rangeIndex = 1;
    this.screens = [];
    this.displays = [];
    this.build();
  }

  /** Hangs a built display on the house's mount for it, or on the house itself if there is none. */
  mount(key, object, fallback) {
    const m = this.pilot?.mounts?.[key];
    if (m) {
      object.position.copy(m.position);
      m.parent.add(object);
    } else {
      object.position.set(...fallback);
      this.parent.add(object);
    }
    object.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); });
    return object;
  }

  /** A Display round a Screen, sized from the mount. */
  display(key, screen, fallback) {
    const m = this.pilot?.mounts?.[key] ?? {};
    const d = new Display(screen.material, {
      width: screen.width, height: screen.height, keys: m.keys, brand: m.brand, keysRight: m.keysRight,
    });
    this.mount(key, d.group, fallback);
    this.displays.push(d);
    this.screens.push(screen);
    return screen;
  }

  build() {
    const M = this.pilot?.mounts ?? {};
    const size = (key, dflt) => M[key]?.size ?? dflt;
    // On the pod: the nav display - radar and chart side by side - the fishfinder, and the
    // autopilot head.
    this.nav = this.display('nav', new Screen(...size('nav', [0.40, 0.20]), 1024), [-0.4, 5.1, -1.0]);
    this.fish = this.display('fish', new Screen(...size('fish', [0.26, 0.20]), 768), [0.1, 5.1, -1.0]);
    this.pilotHead = new Screen(0.125 * 0.62, 0.098 * 0.34, 320, { emissive: 0xdfe8ef });
    const head = new AutopilotHead(this.pilotHead.material);
    this.mount('pilotHead', head.group, [0.5, 5.1, -1.0]);
    this.displays.push(head);
    this.screens.push(this.pilotHead);
    // Overhead: the AIS, the stabiliser display and the nav data page, all reflective LCDs.
    this.ais = this.display('ais', new Screen(...size('ais', [0.13, 0.085]), 416, { backlight: 0.3, roughness: 0.4 }), [-1.0, 5.9, -1.1]);
    this.trac = this.display('trac', new Screen(...size('trac', [0.17, 0.11]), 512, { backlight: 0.3, roughness: 0.4 }), [-0.7, 5.9, -1.1]);
    this.navData = this.display('navData', new Screen(...size('navData', [0.19, 0.15]), 512, { backlight: 0.3, roughness: 0.4 }), [1.2, 5.9, -1.1]);
    // The two big screens light what is in front of them: a point light a hand in front of each,
    // in the screen's colour, as bright as the screen is (step). At night it is the glow on the
    // counter under the display; by day it is nothing against the window light, as it should be.
    this.glows = [];
    for (const [key, colour] of [['nav', 0xbfd6c8], ['fish', 0x5c9bff]]) {
      const m = this.pilot?.mounts?.[key];
      if (!m) continue;
      const light = new THREE.PointLight(colour, 0, 1.2, 2);
      light.position.copy(m.position).add(new THREE.Vector3(0, 0, 0.12));
      m.parent.add(light);
      this.glows.push(light);
    }
  }

  // --- the painters -------------------------------------------------------------------------------

  /**
   * Walks out along 256 bearings until the chart says rock: that is what a radar actually does,
   * and it is why an island's near shore paints and the ground behind it does not.
   */
  paintRadar(ctx, w, h, boat, depthAt) {
    const range = this.ranges[this.rangeIndex];
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
    ctx.fillStyle = '#04150a';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cx, cy);
    const step = range / 96;
    for (let i = 0; i < 256; i++) {
      const bearing = (i / 256) * TAU;
      const sx = Math.sin(bearing), sz = -Math.cos(bearing);
      for (let r = step; r < range; r += step) {
        const d = depthAt(boat.position.x + sx * r, boat.position.z + sz * r);
        if (d > 1.5) continue;
        const rel = bearing - boat.heading;
        const px = Math.sin(rel) * (r / range) * R;
        const py = -Math.cos(rel) * (r / range) * R;
        const age = ((this.sweep - rel) / TAU + 1) % 1;
        const bright = 0.35 + 0.65 * (1 - age);
        ctx.fillStyle = `rgba(125, 255, 154, ${(0.22 + 0.7 * bright).toFixed(3)})`;
        const size = Math.max(1.6, (R / 96) * 1.6);
        ctx.fillRect(px - size / 2, py - size / 2, size, size * 1.6);
        break;
      }
    }
    ctx.strokeStyle = 'rgba(125,255,154,0.26)';
    ctx.lineWidth = 1.4;
    for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(0, 0, (R * k) / 4, 0, TAU); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(125,255,154,0.55)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -R); ctx.stroke();
    ctx.save();
    ctx.rotate(this.sweep);
    const grad = ctx.createLinearGradient(0, 0, 0, -R);
    grad.addColorStop(0, 'rgba(125,255,154,0.55)');
    grad.addColorStop(1, 'rgba(125,255,154,0.05)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -R); ctx.stroke();
    ctx.restore();
    ctx.restore();
    ctx.fillStyle = GREEN;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(h * 0.065)}px ${MONO}`;
    ctx.fillText(range >= 1852 ? `${(range / 1852).toFixed(1)} NM` : `${Math.round(range)} M`, 8, h * 0.085);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round((boat.heading * 180 / Math.PI + 360) % 360).toString().padStart(3, '0')}`, w - 8, h * 0.085);
    ctx.textAlign = 'left';
  }

  /** The chart: the same coast, north up, with the track she has run across it. */
  paintChart(ctx, w, h, boat, depthAt, origin) {
    const span = 7400; // four miles across: enough for the fjord's sides to be on the chart
    ctx.fillStyle = '#dfe6ea';
    ctx.fillRect(0, 0, w, h);
    const sx = w / span;
    const cx = w / 2, cy = h / 2;
    // The land and the shallows, as a coarse raster: a plotter's chart is coarse too.
    const cells = 54;
    const cell = span / cells;
    const rows = Math.round(cells * (h / w));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cells; i++) {
        const x = boat.position.x + (i - cells / 2 + 0.5) * cell;
        const z = boat.position.z + (j - rows / 2 + 0.5) * cell;
        const d = depthAt(x, z);
        if (d > 22) continue;
        ctx.fillStyle = d <= 0 ? '#d9cf9c' : (d < 8 ? '#9ec9e8' : '#bcd9ee');
        ctx.fillRect(i * (w / cells), j * (w / cells), w / cells + 1, w / cells + 1);
      }
    }
    // A lat/long graticule, faint.
    ctx.strokeStyle = 'rgba(60,80,100,0.18)';
    ctx.lineWidth = 1;
    for (let k = 1; k < 6; k++) {
      ctx.beginPath(); ctx.moveTo((w * k) / 6, 0); ctx.lineTo((w * k) / 6, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (h * k) / 4); ctx.lineTo(w, (h * k) / 4); ctx.stroke();
    }
    // Her track, and her.
    ctx.strokeStyle = 'rgba(200,40,40,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.track.forEach((p, i) => {
      const px = cx + (p.x - boat.position.x) * sx;
      const py = cy + (p.z - boat.position.z) * sx;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(boat.heading);
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    // The COG vector.
    ctx.strokeStyle = '#1a7a2a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(0, -h * 0.3); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#243040';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.round(h * 0.075)}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText(`${(span / 1852).toFixed(1)} NM`, 6, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`${toKnots(Math.hypot(boat.velocity.x, boat.velocity.z)).toFixed(1)} kn`, w - 6, h - 6);
    ctx.textAlign = 'left';
  }

  /**
   * The nav display: radar left, chart right, as the reference's split screen has it, with a status
   * bar across the top and the soft keys down the right.
   */
  paintNav(ctx, w, h, boat, depthAt, origin) {
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, w, h);
    const bar = Math.round(h * 0.10);
    const keyW = Math.round(w * 0.11);
    const radarW = Math.round((w - keyW) * 0.44);
    const chartW = w - keyW - radarW - 3;
    // The two panes.
    ctx.save(); ctx.translate(0, bar); ctx.beginPath(); ctx.rect(0, 0, radarW, h - bar); ctx.clip();
    this.paintRadar(ctx, radarW, h - bar, boat, depthAt);
    ctx.restore();
    ctx.save(); ctx.translate(radarW + 3, bar); ctx.beginPath(); ctx.rect(0, 0, chartW, h - bar); ctx.clip();
    this.paintChart(ctx, chartW, h - bar, boat, depthAt, origin);
    ctx.restore();
    // The status bar.
    ctx.fillStyle = '#141b22';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillStyle = '#cfd8e0';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(bar * 0.55)}px ${CONDENSED}`;
    ctx.textAlign = 'left';
    const range = this.ranges[this.rangeIndex];
    ctx.fillText(`RADAR  ${range >= 1852 ? `${(range / 1852).toFixed(1)} NM` : `${range} M`}  HEAD UP`, 8, bar / 2);
    ctx.fillText('CHART  NORTH UP', radarW + 12, bar / 2);
    ctx.textAlign = 'right';
    const hrs = Math.floor((G.uDayTime.value * 24) % 24), mins = Math.floor(((G.uDayTime.value * 24) % 1) * 60);
    ctx.fillText(`${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`, w - keyW - 8, bar / 2);
    // The soft keys.
    ctx.fillStyle = '#10161c';
    ctx.fillRect(w - keyW, bar, keyW, h - bar);
    const labels = ['RANGE', 'GAIN', 'TARGETS', 'ROUTE', 'LAYERS'];
    const kh = (h - bar) / labels.length;
    labels.forEach((t, i) => {
      const y = bar + i * kh;
      ctx.fillStyle = '#1c242c';
      ctx.fillRect(w - keyW + 4, y + 4, keyW - 8, kh - 8);
      ctx.fillStyle = '#d7dee5';
      ctx.font = `600 ${Math.round(kh * 0.22)}px ${CONDENSED}`;
      ctx.textAlign = 'center';
      ctx.fillText(t, w - keyW / 2, y + kh / 2);
    });
    ctx.textAlign = 'left';
  }

  /**
   * The fishfinder: the water under her in blue, the bottom as the hard red-and-yellow return a
   * colour sounder paints it, the last minute scrolling by, the depth large at the top left.
   */
  paintFish(ctx, w, h, depth) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1d5fc0');
    g.addColorStop(1, '#0a2a66');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    this.trace ??= [];
    this.trace.push(depth);
    if (this.trace.length > 160) this.trace.shift();
    const maxD = Math.max(30, Math.ceil(Math.max(...this.trace) / 25) * 25);
    const n = 160, colW = w / n;
    // The scatter in the water column: thermocline clutter, faint.
    ctx.fillStyle = 'rgba(120,190,255,0.10)';
    for (let i = 0; i < n; i++) {
      const x = w - (this.trace.length - i) * colW;
      const d = this.trace[i] ?? depth;
      const y = (clamp(d * 0.55, 0, maxD) / maxD) * h;
      ctx.fillRect(x, y, colW + 1, 2);
    }
    // The bottom: a hard return in yellow over red, shading to brown below.
    for (let i = 0; i < this.trace.length; i++) {
      const x = w - (this.trace.length - i) * colW;
      const d = this.trace[i];
      const y = (clamp(d, 0, maxD) / maxD) * h;
      const bg = ctx.createLinearGradient(0, y, 0, h);
      bg.addColorStop(0, '#fff26a');
      bg.addColorStop(0.08, '#ff7a1a');
      bg.addColorStop(0.3, '#b8321a');
      bg.addColorStop(1, '#4a1a0e');
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, colW + 1, h - y);
    }
    // A few fish arches, where the sounder would put them.
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const x = ((this.time * 3 + k * 97) % 160) / 160 * w;
      const y = h * (0.35 + 0.18 * Math.sin(k * 2.1));
      ctx.beginPath(); ctx.arc(x, y + 6, 8, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    }
    // The range scale down the right, and the depth.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `${Math.round(h * 0.07)}px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 1; k <= 4; k++) ctx.fillText(String(Math.round((maxD * k) / 4)), w - 4, (h * k) / 4 - (k === 4 ? h * 0.05 : 0));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(h * 0.30)}px ${SANS}`;
    const txt = depth > 999 ? '---' : depth.toFixed(1);
    ctx.fillText(txt, 10, h * 0.30);
    ctx.font = `600 ${Math.round(h * 0.11)}px ${SANS}`;
    ctx.fillText('m', 14 + ctx.measureText(txt).width * 2.7, h * 0.30);
    ctx.font = `600 ${Math.round(h * 0.075)}px ${CONDENSED}`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('200 kHz  AUTO GAIN', 10, h * 0.40);
    ctx.textAlign = 'right';
    ctx.fillText(`0 - ${maxD} m`, w - 6, h - 6);
    ctx.textAlign = 'left';
  }

  /**
   * The autopilot head: the course it is steering, the course she is making, and which of the two
   * it is in. A real one shows exactly this and nothing else.
   */
  paintPilotHead(ctx, w, h, boat) {
    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(0, 0, w, h);
    const deg = (r) => ((r * 57.2957795 % 360) + 360) % 360;
    ctx.fillStyle = '#dfe8ef';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(h * 0.62)}px ${CONDENSED}`;
    ctx.textAlign = 'left';
    ctx.fillText(deg(boat.heading).toFixed(0).padStart(3, '0') + '°', w * 0.04, h * 0.48);
    ctx.font = `600 ${Math.round(h * 0.22)}px ${CONDENSED}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText('HDG', w * 0.05, h * 0.86);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#6cff40';
    ctx.font = `700 ${Math.round(h * 0.30)}px ${CONDENSED}`;
    ctx.fillText('AUTO', w * 0.96, h * 0.30);
    ctx.fillStyle = '#dfe8ef';
    ctx.font = `600 ${Math.round(h * 0.26)}px ${CONDENSED}`;
    ctx.fillText(`${(boat.speedKnots ?? 0).toFixed(1)} kn`, w * 0.96, h * 0.72);
    ctx.textAlign = 'left';
  }

  /** The AIS: the three nearest targets, as a small set lists them. */
  paintAis(ctx, w, h, boat) {
    lcdGround(ctx, w, h, '#a9b3a4');
    const ink = '#1c2418';
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(h * 0.13)}px ${CONDENSED}`;
    ctx.fillText('AIS   TARGETS 3', w * 0.05, h * 0.12);
    ctx.fillRect(w * 0.05, h * 0.21, w * 0.90, 2);
    ctx.font = `600 ${Math.round(h * 0.115)}px ${MONO}`;
    const t = this.time;
    const rows = [
      ['NORDLYS', (1.2 + 0.05 * Math.sin(t * 0.05)).toFixed(1), '14'],
      ['FJORDBUSS 2', (2.8 - 0.01 * (t % 60)).toFixed(1), '31'],
      ['STAVNES', '4.1', '--'],
    ];
    rows.forEach(([name, cpa, tcpa], i) => {
      const y = h * (0.34 + i * 0.19);
      ctx.fillText(name, w * 0.05, y);
      ctx.textAlign = 'right';
      ctx.fillText(`CPA ${cpa}  T ${tcpa}`, w * 0.95, y);
      ctx.textAlign = 'left';
    });
    ctx.font = `600 ${Math.round(h * 0.10)}px ${CONDENSED}`;
    ctx.globalAlpha = 0.7;
    ctx.fillText('RX  CLASS A', w * 0.05, h * 0.92);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(((boat.heading * 57.2957795) % 360 + 360) % 360).toString().padStart(3, '0')}°`, w * 0.95, h * 0.92);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** The stabiliser display: the roll she is making, and what the fins are doing about it. */
  paintTrac(ctx, w, h, boat) {
    lcdGround(ctx, w, h, '#a3ad9c');
    const ink = '#18221a';
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(h * 0.11)}px ${CONDENSED}`;
    ctx.fillText('TRAC  STABILIZERS', w * 0.05, h * 0.10);
    ctx.textAlign = 'right';
    ctx.fillText('ACTIVE', w * 0.95, h * 0.10);
    ctx.textAlign = 'left';
    ctx.fillRect(w * 0.05, h * 0.18, w * 0.90, 2);
    // The roll bar: zero in the middle, the hull's roll as a bar either side.
    const roll = boat.roll * 57.2957795;
    ctx.font = `600 ${Math.round(h * 0.10)}px ${CONDENSED}`;
    ctx.fillText('ROLL', w * 0.05, h * 0.30);
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(h * 0.13)}px ${MONO}`;
    ctx.fillText(`${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°`, w * 0.95, h * 0.30);
    ctx.textAlign = 'left';
    const bx = w * 0.05, by = h * 0.40, bw = w * 0.90, bh = h * 0.12;
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillRect(bx + bw / 2 - 1, by - 4, 2, bh + 8);
    const frac = clamp(roll / 15, -1, 1);
    ctx.fillRect(bx + bw / 2, by + 3, (bw / 2) * frac, bh - 6);
    // The fins.
    const port = 50 + clamp(-roll * 4, -45, 45), stbd = 50 + clamp(roll * 4, -45, 45);
    ctx.font = `600 ${Math.round(h * 0.10)}px ${CONDENSED}`;
    ctx.fillText(`FIN PORT  ${port.toFixed(0)}%`, w * 0.05, h * 0.66);
    ctx.textAlign = 'right';
    ctx.fillText(`FIN STBD  ${stbd.toFixed(0)}%`, w * 0.95, h * 0.66);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.7;
    ctx.fillText(`UNDERWAY   ${(boat.speedKnots ?? 0).toFixed(1)} KN`, w * 0.05, h * 0.86);
    ctx.textAlign = 'right';
    ctx.fillText('GAIN AUTO', w * 0.95, h * 0.86);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** The nav data page: the six numbers a helmsman glances up at. */
  paintNavData(ctx, w, h, boat) {
    lcdGround(ctx, w, h, '#aab3a8');
    const ink = '#1a2420';
    const deg = ((boat.heading * 57.2957795) % 360 + 360) % 360;
    const sog = boat.speedKnots ?? toKnots(Math.hypot(boat.velocity.x, boat.velocity.z));
    const xte = 0.02 * Math.sin(this.time * 0.07);
    const cells = [
      ['COG', `${deg.toFixed(0).padStart(3, '0')}°`], ['SOG', `${sog.toFixed(1)} kn`],
      ['XTE', `${xte >= 0 ? 'R' : 'L'} ${Math.abs(xte).toFixed(2)} nm`], ['BRG', `${((deg + 4) % 360).toFixed(0).padStart(3, '0')}°`],
      ['DST', `${(3.4 - (this.time * sog) / 3600 % 3.4).toFixed(2)} nm`], ['TTG', `${Math.max(1, Math.round((3.4 / Math.max(sog, 0.5)) * 60))} min`],
    ];
    const cw = w / 2, ch = h / 3;
    cells.forEach(([k, v], i) => {
      const x = (i % 2) * cw, y = Math.floor(i / 2) * ch;
      ctx.strokeStyle = 'rgba(26,36,32,0.5)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 3, y + 3, cw - 6, ch - 6);
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `600 ${Math.round(ch * 0.22)}px ${CONDENSED}`;
      ctx.fillText(k, x + 10, y + ch * 0.25);
      ctx.textAlign = 'right';
      ctx.font = `700 ${Math.round(ch * 0.40)}px ${MONO}`;
      ctx.fillText(v, x + cw - 10, y + ch * 0.64);
    });
    ctx.textAlign = 'left';
  }

  /** Cycles the radar's range: what a click on the pod does. */
  nextRange() { this.rangeIndex = (this.rangeIndex + 1) % this.ranges.length; }

  /**
   * @param {number} dt
   * @param {import('./boat.js').Boat} boat
   * @param {(x: number, z: number) => number} depthAt
   * @param {{x: number, z: number}} origin the render origin, so the chart can show real places
   */
  step(dt, boat, depthAt, origin, night, emissiveScale = 1) {
    this.emissiveScale = emissiveScale;
    this.time += dt;
    this.sweep = (this.sweep + dt * 2.5) % TAU;
    if (this.time - this.trackAt > 6) {
      this.trackAt = this.time;
      this.track.push({ x: boat.position.x, z: boat.position.z });
      if (this.track.length > 600) this.track.shift();
    }
    const depth = Math.max(depthAt(boat.position.x, boat.position.z) - boat.hull.draught, 0);

    this.nav.tick(this.time, 0.12, (c, w, h) => this.paintNav(c, w, h, boat, depthAt, origin));
    this.fish.tick(this.time, 0.5, (c, w, h) => this.paintFish(c, w, h, depth));
    this.pilotHead.tick(this.time, 0.4, (c, w, h) => this.paintPilotHead(c, w, h, boat));
    this.ais.tick(this.time, 2.0, (c, w, h) => this.paintAis(c, w, h, boat));
    this.trac.tick(this.time, 0.3, (c, w, h) => this.paintTrac(c, w, h, boat));
    this.navData.tick(this.time, 0.5, (c, w, h) => this.paintNavData(c, w, h, boat));

    // A screen is drawn at a chosen brightness on the glass, not at a radiance, so it is divided
    // by the camera's exposure: a set that is readable in daylight and comfortable at night, and
    // never the one thing in the frame that is blown out. The grey LCDs are mostly lit by the
    // room and take only a little of this as their backlight.
    const gain = lerp(0.16, 0.42, night) * (this.emissiveScale ?? 1);
    for (const s of this.screens) s.material.emissiveIntensity = gain * s.backlight;
    // A screen of a twelfth of a square metre radiating at `gain` is a source of about gain/30 cd.
    for (const l of this.glows ?? []) l.intensity = gain * 0.035;
    this.lastDepth = depth;
  }

  dispose() {
    for (const d of this.displays) { d.dispose(); d.group.parent?.remove(d.group); }
    for (const s of this.screens) s.dispose();
  }
}
