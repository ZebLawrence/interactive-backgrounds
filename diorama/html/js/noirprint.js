// Diorama — everything in the office that is printed, written, painted on glass or seen as a shadow.
//
// The rule is the computer's: what is flat is a texture. Here that is most of the story. The pinboard is one
// painting per night (cork, photographs, clippings, notes, string and pins), the frosted glass of the door is
// repainted whenever somebody stands behind it, and the building across the street is a painting with a second
// one, of its lit windows and its sign, laid over it.
//
// Every name is invented.

import * as THREE from 'three';
import { makeRand } from './pcboard.js';

const SERIF = 'Georgia, "Times New Roman", serif';
const HAND = '"Bradley Hand", "Segoe Print", "Marker Felt", "Comic Sans MS", cursive';
const TYPE = '"Courier New", Courier, monospace';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function texture(c, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const text = (g, s, x, y, font, colour, align = 'center') => { g.font = font; g.fillStyle = colour; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };

// ---------------------------------------------------------------------------------------------------------
// People, as shapes
// ---------------------------------------------------------------------------------------------------------

const PEOPLE = {
  client: { sh: 0.19, head: 0.092, hat: 'wide', h: 1.7 },
  heavy: { sh: 0.28, head: 0.112, hat: 'bowler', h: 1.88 },
  passer: { sh: 0.22, head: 0.1, hat: 'fedora', h: 1.78 },
  cop: { sh: 0.24, head: 0.1, hat: 'cap', h: 1.83 },
  finch: { sh: 0.2, head: 0.098, hat: null, h: 1.7 },
};

/**
 * Fills the outline of somebody seen from in front: body, head and hat. `cx` and `floor` are canvas pixels,
 * `k` pixels to the metre, `bend` 0..1 stoops them.
 */
export function person(g, kind, cx, floor, k, bend = 0) {
  const P = PEOPLE[kind], X = (m) => cx + m * k, Y = (m) => floor - m * k;
  const top = P.h - bend * 0.6, chin = top - 0.24, sh = chin - 0.07;
  g.beginPath();
  g.moveTo(X(-P.sh * 0.9), Y(0)); g.lineTo(X(-P.sh), Y(sh - 0.28));
  g.quadraticCurveTo(X(-P.sh), Y(sh), X(-0.075), Y(sh + 0.035));
  g.lineTo(X(-0.055), Y(chin)); g.lineTo(X(0.055), Y(chin)); g.lineTo(X(0.075), Y(sh + 0.035));
  g.quadraticCurveTo(X(P.sh), Y(sh), X(P.sh), Y(sh - 0.28)); g.lineTo(X(P.sh * 0.9), Y(0));
  g.closePath(); g.fill();
  g.beginPath(); g.ellipse(X(0), Y(top - 0.125), P.head * 0.84 * k, 0.125 * k, 0, 0, 7); g.fill();
  const el = (x, y, rx, ry) => { g.beginPath(); g.ellipse(X(x), Y(y), rx * k, ry * k, 0, 0, 7); g.fill(); };
  if (P.hat === 'wide') { el(0, chin + 0.04, 0.11, 0.11); el(0, top - 0.045, 0.27, 0.034); el(0, top + 0.005, 0.1, 0.07); }
  else if (P.hat === 'bowler') { el(0, top - 0.05, 0.155, 0.022); g.beginPath(); g.ellipse(X(0), Y(top - 0.05), 0.108 * k, 0.12 * k, 0, Math.PI, 0); g.fill(); }
  else if (P.hat === 'fedora') {
    el(0, top - 0.05, 0.175, 0.026);
    g.beginPath(); g.moveTo(X(-0.1), Y(top - 0.05)); g.lineTo(X(-0.088), Y(top + 0.07)); g.quadraticCurveTo(X(0), Y(top + 0.04), X(0.088), Y(top + 0.07)); g.lineTo(X(0.1), Y(top - 0.05)); g.closePath(); g.fill();
  } else if (P.hat === 'cap') { g.fillRect(X(-0.1), Y(top + 0.01), 0.2 * k, 0.07 * k); el(0, top + 0.02, 0.135, 0.045); el(0, top - 0.055, 0.115, 0.018); }
}

// ---------------------------------------------------------------------------------------------------------
// The door's frosted glass
// ---------------------------------------------------------------------------------------------------------

/** The pane is this big, and its bottom edge is this far above the floor (metres). */
export const PANE = { w: 0.62, h: 0.95, y: 1.0 };

/**
 * The frosted pane as seen from inside the office: the corridor's light, the lettering (painted on the far
 * side, so it reads backwards), and whoever is standing out there, as a shadow that sharpens as they come
 * up to the glass.
 */
export class DoorGlass {
  constructor(renderer) {
    [this.canvas, this.g] = canvas(416, 640);
    this.k = this.canvas.height / PANE.h;
    this.texture = texture(this.canvas, renderer);
    // The frost: a coarse mottle and a fine grain, painted once.
    const [n, ng] = canvas(416, 640), rand = makeRand(11);
    const img = ng.createImageData(416, 640);
    for (let i = 0; i < img.data.length; i += 4) { const v = rand() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 26; }
    ng.putImageData(img, 0, 0);
    ng.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 2600; i++) { ng.fillStyle = `rgba(${rand() < 0.5 ? '255,240,200' : '60,30,0'},${0.015 + rand() * 0.03})`; ng.beginPath(); ng.ellipse(rand() * 416, rand() * 640, 2 + rand() * 7, 2 + rand() * 9, rand() * 3, 0, 7); ng.fill(); }
    this.frost = n;
    this.damage = 0;
    this.light = 1;
    this.draw([]);
  }

  /**
   * `figures`: [{ kind, x (metres from the pane's centre), near (0 far down the corridor .. 1 at the glass),
   * bend, fist (0..1, a hand raised to knock) }]. `damage`: 0 whole, 1 a bullet hole, 2 the hole taped over.
   * `light`: the corridor's lamp, 0..1.
   */
  draw(figures, damage = this.damage, light = this.light) {
    const g = this.g, W = this.canvas.width, H = this.canvas.height, k = this.k;
    this.damage = damage; this.light = light;
    const bg = g.createLinearGradient(0, 0, 0, H);
    const lv = (r, gr, b) => `rgb(${Math.round(r * light)},${Math.round(gr * light)},${Math.round(b * light)})`;
    bg.addColorStop(0, lv(255, 214, 138)); bg.addColorStop(0.55, lv(226, 168, 88)); bg.addColorStop(1, lv(168, 108, 46));
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const floor = H + PANE.y * k;
    for (const f of figures) {
      const blur = 3 + 34 * (1 - f.near), grow = 1 + 0.22 * (1 - f.near);
      g.save();
      g.shadowColor = `rgba(34,18,6,${0.5 + 0.42 * f.near})`; g.shadowBlur = blur; g.shadowOffsetX = 3000; g.fillStyle = '#000';
      person(g, f.kind, W / 2 + f.x * k * grow - 3000, floor + (grow - 1) * 1.3 * k, k * grow, f.bend ?? 0);
      if (f.fist > 0) { g.shadowBlur = 3; g.beginPath(); g.arc(W / 2 + (f.x + 0.2) * k - 3000, floor - (1.36 + 0.14 * f.fist) * k, 0.05 * k, 0, 7); g.fill(); }
      g.restore();
    }
    // The lettering, backwards.
    g.save(); g.translate(W, 0); g.scale(-1, 1);
    const ink = 'rgba(38,22,8,0.9)';
    g.letterSpacing = '5px';
    text(g, 'M. QUILL', W / 2, H * 0.3, `700 62px ${SERIF}`, ink);
    g.fillStyle = ink; g.fillRect(W * 0.2, H * 0.375, W * 0.6, 3);
    g.letterSpacing = '7px';
    text(g, 'PRIVATE', W / 2, H * 0.445, `700 36px ${SERIF}`, ink);
    g.letterSpacing = '2px';
    text(g, 'INVESTIGATIONS', W / 2, H * 0.525, `700 36px ${SERIF}`, ink);
    g.letterSpacing = '4px';
    text(g, 'ROOM 204', W / 2, H * 0.62, `400 24px ${SERIF}`, ink);
    g.restore(); g.letterSpacing = '0px';
    g.drawImage(this.frost, 0, 0);
    if (damage) {
      const hx = W * 0.6, hy = H * 0.36, rand = makeRand(5);
      g.strokeStyle = 'rgba(255,250,235,0.75)'; g.lineWidth = 1.3;
      for (let i = 0; i < 13; i++) {
        const a = i / 13 * Math.PI * 2 + rand() * 0.3; let x = hx, y = hy; g.beginPath(); g.moveTo(x, y);
        for (let s = 0, len = 40 + rand() * 150; s < len; s += 16) { x += Math.cos(a + (rand() - 0.5) * 0.5) * 16; y += Math.sin(a + (rand() - 0.5) * 0.5) * 16; g.lineTo(x, y); }
        g.stroke();
      }
      g.strokeStyle = 'rgba(255,250,235,0.5)';
      for (const r of [22, 46]) { g.beginPath(); for (let i = 0; i <= 13; i++) { const a = i / 13 * Math.PI * 2; g.lineTo(hx + Math.cos(a) * r * (0.8 + rand() * 0.4), hy + Math.sin(a) * r * (0.8 + rand() * 0.4)); } g.stroke(); }
      g.fillStyle = '#fff3d0'; g.beginPath(); g.arc(hx, hy, 6, 0, 7); g.fill();
      if (damage === 2) { // brown paper tape, criss-crossed
        g.fillStyle = 'rgba(122,88,48,0.93)';
        for (const a of [0.5, -0.6, 1.7]) { g.save(); g.translate(hx, hy); g.rotate(a); g.fillRect(-92, -15, 184, 30); g.restore(); }
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose() { this.texture.dispose(); }
}

// ---------------------------------------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------------------------------------

/** Rows of grey strokes that stand for body type. */
function columns(g, x, y, w, h, cols, rand, size = 7) {
  const cw = w / cols;
  g.fillStyle = 'rgba(40,36,30,0.55)';
  for (let c = 0; c < cols; c++) for (let yy = y; yy < y + h; yy += size * 1.5) {
    let xx = x + c * cw + 3; const end = x + (c + 1) * cw - 5;
    while (xx < end) { const len = Math.min(end - xx, size * (1 + rand() * 5)); g.fillRect(xx, yy, len, size * 0.55); xx += len + size * 0.7; }
  }
}

/** A photograph: a grey studio backdrop, somebody (or something) in front of it, and a white border. */
function photograph(g, w, h, what, rand) {
  g.fillStyle = '#e9e6dc'; g.fillRect(0, 0, w, h);
  const m = w * 0.06, iw = w - 2 * m, ih = h - 2 * m - h * 0.06;
  g.save(); g.beginPath(); g.rect(m, m, iw, ih); g.clip();
  const bg = g.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, w * 0.8);
  bg.addColorStop(0, '#c9c5ba'); bg.addColorStop(1, '#6f6c64'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  if (what in PEOPLE) { g.fillStyle = '#211f1c'; person(g, what, w / 2, m + ih + 1.18 * (ih / 0.75), ih / 0.75); }
  else if (what === 'shop') {
    g.fillStyle = '#5b5852'; g.fillRect(m, m + ih * 0.2, iw, ih);
    g.fillStyle = '#23221f'; g.fillRect(m + iw * 0.1, m + ih * 0.42, iw * 0.5, ih * 0.5); g.fillRect(m + iw * 0.68, m + ih * 0.42, iw * 0.2, ih * 0.6);
    g.fillStyle = '#16150f'; g.fillRect(m, m + ih * 0.2, iw, ih * 0.16);
    text(g, 'FINCH & SON', w / 2, m + ih * 0.28, `700 ${ih * 0.1}px ${SERIF}`, '#d8d2bf');
    text(g, 'JEWELLERS', w / 2, m + ih * 0.5, `400 ${ih * 0.05}px ${SERIF}`, '#aaa594');
  } else if (what === 'gem') {
    g.strokeStyle = '#e8e4d6'; g.lineWidth = 2; const cx = w / 2, cy = m + ih * 0.5, r = iw * 0.3;
    g.beginPath(); for (let i = 0; i <= 8; i++) { const a = i * Math.PI / 4 + 0.39; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8); } g.stroke();
    g.beginPath(); for (let i = 0; i <= 8; i++) { const a = i * Math.PI / 4 + 0.39; g.lineTo(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.44); } g.stroke();
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + 0.39; g.beginPath(); g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8); g.lineTo(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.44); g.stroke(); }
  }
  // grain
  for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(${rand() < 0.5 ? 255 : 0},${rand() < 0.5 ? 255 : 0},0,0.035)`; g.fillRect(m + rand() * iw, m + rand() * ih, 2, 2); }
  g.restore();
}

function clipping(g, w, h, head, sub, rand) {
  g.fillStyle = '#d9d0b8'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#1e1b16'; g.fillRect(w * 0.05, h * 0.06, w * 0.9, 2);
  const lines = head.split('\n'), fs = h * (lines.length > 1 ? 0.15 : 0.19);
  lines.forEach((l, i) => text(g, l, w / 2, h * 0.17 + i * fs * 1.05, `900 ${fs}px ${SERIF}`, '#1b1814'));
  const y = h * 0.17 + lines.length * fs * 1.05;
  text(g, sub, w / 2, y, `italic 400 ${h * 0.07}px ${SERIF}`, '#2d2922');
  columns(g, w * 0.05, y + h * 0.08, w * 0.9, h - y - h * 0.14, 3, rand, Math.max(3, h * 0.022));
}

/** The front page, to stand folded against the lamp. */
export function newspaper(renderer, head, sub, who) {
  const [c, g] = canvas(1024, 800), rand = makeRand(head.length);
  g.fillStyle = '#d6cdb4'; g.fillRect(0, 0, 1024, 800);
  text(g, 'The City Ledger', 512, 62, `italic 900 84px ${SERIF}`, '#191612');
  g.fillStyle = '#191612'; g.fillRect(40, 112, 944, 4); g.fillRect(40, 146, 944, 2);
  text(g, 'NOVEMBER 1947', 60, 131, `700 18px ${SERIF}`, '#191612', 'left'); text(g, 'FINAL EDITION  ·  FIVE CENTS', 964, 131, `700 18px ${SERIF}`, '#191612', 'right');
  g.letterSpacing = '-2px';
  head.split('\n').forEach((l, i) => text(g, l, 512, 232 + i * 138, `900 ${l.length > 13 ? 124 : 148}px ${SERIF}`, '#14110d'));
  g.letterSpacing = '0px';
  const y = 232 + head.split('\n').length * 138 - 50;
  text(g, sub, 512, y + 22, `italic 700 38px ${SERIF}`, '#221e18');
  g.fillRect(40, y + 54, 944, 2);
  g.save(); g.translate(60, y + 76); photograph(g, 300, 800 - y - 100, who, rand); g.restore();
  columns(g, 390, y + 76, 594, 800 - y - 100, 3, rand, 9);
  for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(90,70,30,${rand() * 0.05})`; g.fillRect(rand() * 1024, rand() * 800, 3, 3); }
  return texture(c, renderer);
}

/** A note in a heavy hand. */
export function note(renderer, lines, { w = 512, h = 320, paper = '#e6dfc8', ink = '#7c1410', font = HAND, size = 0.3 } = {}) {
  const [c, g] = canvas(w, h);
  g.fillStyle = paper; g.fillRect(0, 0, w, h);
  lines.forEach((l, i) => text(g, l, w / 2, h * (0.5 + (i - (lines.length - 1) / 2) * size * 1.1), `900 ${h * size}px ${font}`, ink));
  return texture(c, renderer);
}

export function calendar(renderer, day, date) {
  const [c, g] = canvas(300, 420);
  g.fillStyle = '#e9e3d0'; g.fillRect(0, 0, 300, 420);
  g.fillStyle = '#8a1c14'; g.fillRect(0, 0, 300, 84);
  text(g, 'NOVEMBER', 150, 44, `700 40px ${SERIF}`, '#f1e9d6');
  text(g, String(date), 150, 220, `900 230px ${SERIF}`, '#1b1814');
  text(g, { MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY' }[day], 150, 366, `700 40px ${SERIF}`, '#1b1814');
  text(g, '1947  ·  HARLAND COAL & ICE', 150, 404, `400 14px ${SERIF}`, '#4a443a');
  return texture(c, renderer);
}

export function clockFace(renderer) {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#ece6d4'; g.beginPath(); g.arc(256, 256, 256, 0, 7); g.fill();
  for (let i = 0; i < 60; i++) { const a = i * Math.PI / 30; g.save(); g.translate(256, 256); g.rotate(a); g.fillStyle = '#1b1814'; g.fillRect(-(i % 5 ? 1.5 : 4), -244, i % 5 ? 3 : 8, i % 5 ? 12 : 26); g.restore(); }
  for (let i = 1; i <= 12; i++) { const a = i * Math.PI / 6; text(g, String(i), 256 + Math.sin(a) * 186, 258 - Math.cos(a) * 186, `700 52px ${SERIF}`, '#1b1814'); }
  text(g, 'REGENT', 256, 180, `700 22px ${SERIF}`, '#3a352c'); text(g, 'ELECTRIC', 256, 346, `400 15px ${SERIF}`, '#5a5346');
  return texture(c, renderer);
}

export function nameplate(renderer) {
  const [c, g] = canvas(512, 96);
  const b = g.createLinearGradient(0, 0, 0, 96); b.addColorStop(0, '#d7b56a'); b.addColorStop(0.5, '#b08a3e'); b.addColorStop(1, '#8a6a2a');
  g.fillStyle = b; g.fillRect(0, 0, 512, 96);
  g.letterSpacing = '10px'; text(g, 'M. QUILL', 262, 50, `700 54px ${SERIF}`, '#1d1608'); g.letterSpacing = '0px';
  return texture(c, renderer);
}

export function licence(renderer) {
  const [c, g] = canvas(512, 400), rand = makeRand(3);
  g.fillStyle = '#e8e0c6'; g.fillRect(0, 0, 512, 400);
  g.strokeStyle = '#5b4a22'; g.lineWidth = 6; g.strokeRect(20, 20, 472, 360); g.lineWidth = 2; g.strokeRect(32, 32, 448, 336);
  text(g, 'State Board of Licence', 256, 84, `italic 700 36px ${SERIF}`, '#2a2416');
  text(g, 'PRIVATE INVESTIGATOR', 256, 142, `900 30px ${SERIF}`, '#2a2416');
  text(g, 'Marian Quill', 256, 206, `italic 700 44px ${SERIF}`, '#15120c');
  columns(g, 80, 250, 350, 60, 1, rand, 8);
  g.fillStyle = '#9c2b1c'; g.beginPath(); g.arc(410, 318, 34, 0, 7); g.fill();
  text(g, 'No. 4471', 120, 330, `700 22px ${TYPE}`, '#2a2416');
  return texture(c, renderer);
}

export function folderStamp(renderer) {
  const [c, g] = canvas(512, 380);
  g.fillStyle = '#c9a868'; g.fillRect(0, 0, 512, 380);
  text(g, 'FINCH, A.  —  No. 212', 40, 50, `700 26px ${TYPE}`, '#2c2414', 'left');
  g.save(); g.translate(256, 210); g.rotate(-0.2);
  g.strokeStyle = 'rgba(160,22,16,0.9)'; g.lineWidth = 9; g.strokeRect(-200, -62, 400, 124);
  text(g, 'CASE CLOSED', 0, 4, `900 58px ${SERIF}`, 'rgba(160,22,16,0.9)');
  g.restore();
  return texture(c, renderer);
}

// ---------------------------------------------------------------------------------------------------------
// The pinboard, one painting per night
// ---------------------------------------------------------------------------------------------------------

/** The board is this big (metres); the painting is 1.2 pixels to the millimetre. */
export const BOARD_SIZE = { w: 1.36, h: 1.0 };

export function pinboard(renderer, chapter) {
  const W = 1632, H = 1200, [c, g] = canvas(W, H), rand = makeRand(77);
  // Cork.
  g.fillStyle = '#9a7146'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 26000; i++) { const v = rand(); g.fillStyle = v < 0.5 ? `rgba(60,36,14,${0.1 + rand() * 0.25})` : `rgba(214,170,112,${0.08 + rand() * 0.2})`; g.fillRect(rand() * W, rand() * H, 1 + rand() * 4, 1 + rand() * 3); }
  const pins = [];
  /** A sheet pinned at its top centre: (x, y) its centre as fractions of the board, w/h in pixels. Returns the pin's place. */
  const sheet = (x, y, w, h, rot, draw, colour = '#c0392b') => {
    g.save(); g.translate(x * W, y * H); g.rotate(rot);
    g.shadowColor = 'rgba(20,10,0,0.5)'; g.shadowBlur = 14; g.shadowOffsetX = 5; g.shadowOffsetY = 8;
    g.fillStyle = '#ddd'; g.fillRect(-w / 2, -h / 2, w, h);
    g.shadowColor = 'transparent'; g.translate(-w / 2, -h / 2);
    g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(g, w, h); g.restore();
    g.restore();
    const p = [x * W + Math.sin(rot) * (h / 2 - 9), y * H - Math.cos(rot) * (h / 2 - 9), colour];
    pins.push(p);
    return p;
  };
  const photo = (x, y, s, rot, what, caption) => sheet(x, y, 190 * s, 240 * s, rot, (gg, w, h) => { photograph(gg, w, h, what, rand); if (caption) text(gg, caption, w / 2, h * 0.93, `700 ${h * 0.075}px ${TYPE}`, '#1c1a16'); });
  const slip = (x, y, w, h, rot, lines, o = {}) => sheet(x, y, w, h, rot, (gg, ww, hh) => {
    gg.fillStyle = o.paper ?? '#e9e2c9'; gg.fillRect(0, 0, ww, hh);
    lines.forEach((l, i) => {
      let px = hh * (o.size ?? 0.22); const font = () => `${o.weight ?? 700} ${px}px ${o.font ?? HAND}`;
      gg.font = font(); px *= Math.min(1, ww * 0.88 / gg.measureText(l).width); // never wider than the slip
      text(gg, l, ww / 2, hh * (0.56 + (i - (lines.length - 1) / 2) * (o.lead ?? 0.3)), font(), o.ink ?? '#1f2a52');
    });
  }, o.pin);
  const strings = [];
  const tie = (a, b) => strings.push([a, b]);

  // What is always on the board: the city, and the leavings of older cases.
  const map = sheet(0.5, 0.47, 620, 470, 0.01, (gg, w, h) => {
    gg.fillStyle = '#dcd6bd'; gg.fillRect(0, 0, w, h);
    gg.fillStyle = '#9db3b8'; gg.beginPath(); gg.moveTo(0, h * 0.78); gg.bezierCurveTo(w * 0.3, h * 0.62, w * 0.55, h * 0.95, w, h * 0.7); gg.lineTo(w, h); gg.lineTo(0, h); gg.fill();
    gg.strokeStyle = '#b9b199'; gg.lineWidth = 5;
    for (let i = 1; i < 12; i++) { gg.beginPath(); gg.moveTo(i * w / 12 + (i % 3) * 6, 0); gg.lineTo(i * w / 12 - 30, h); gg.stroke(); }
    for (let i = 1; i < 9; i++) { gg.beginPath(); gg.moveTo(0, i * h / 9); gg.lineTo(w, i * h / 9 + 24); gg.stroke(); }
    gg.strokeStyle = '#8f8669'; gg.lineWidth = 9; gg.beginPath(); gg.moveTo(0, h * 0.3); gg.lineTo(w, h * 0.52); gg.stroke();
    gg.beginPath(); gg.moveTo(w * 0.42, 0); gg.lineTo(w * 0.36, h); gg.stroke();
    gg.strokeStyle = '#3a342a'; gg.lineWidth = 3; gg.setLineDash([12, 6]); gg.beginPath(); gg.moveTo(0, h * 0.6); gg.lineTo(w, h * 0.44); gg.stroke(); gg.setLineDash([]);
    text(gg, 'CITY OF HARLAND', w * 0.74, h * 0.08, `700 22px ${SERIF}`, '#3a342a'); text(gg, 'Elevated Rly', w * 0.2, h * 0.53, `italic 400 15px ${SERIF}`, '#3a342a');
    text(gg, 'R I V E R   M E R E', w * 0.6, h * 0.92, `italic 400 16px ${SERIF}`, '#4c6066');
  }, '#2c3e50');
  const mapAt = (fx, fy) => [map[0] - 310 + fx * 620, map[1] + 16 + fy * 470, '#f1c40f'];
  slip(0.09, 0.88, 200, 150, -0.07, ['LOST', 'BISCUIT', 'grey tabby · reward'], { font: SERIF, size: 0.2, lead: 0.3, ink: '#2a2418', paper: '#d8c79a', pin: '#27ae60' });
  slip(0.92, 0.9, 170, 96, 0.06, ['rent due', 'the 15th !!'], { size: 0.3, lead: 0.42, ink: '#7c1410', pin: '#2980b9' });
  slip(0.9, 0.09, 190, 110, 0.04, ['M. QUILL', 'Investigations · Rm 204'], { font: SERIF, size: 0.24, lead: 0.4, ink: '#1c1a16', paper: '#efe9d6', pin: '#7f8c8d' });

  if (chapter >= 1) {
    const finch = photo(0.1, 0.2, 1, -0.05, 'finch', 'A. FINCH');
    const shop = photo(0.11, 0.55, 0.95, 0.04, 'shop', 'the shop');
    const clip = sheet(0.33, 0.1, 300, 170, 0.03, (gg, w, h) => clipping(gg, w, h, 'JEWELLER\nVANISHES', 'Harrow Sapphire gone from safe', rand), '#e67e22');
    const ticket = slip(0.3, 0.86, 200, 104, -0.04, ['PAWN  No. 4471', 'one gold watch'], { font: TYPE, size: 0.2, lead: 0.4, ink: '#2a2418', paper: '#e3b9a0' });
    const where = mapAt(0.43, 0.36); pins.push(where);
    if (chapter < 3) { tie(finch, shop); tie(shop, where); tie(clip, finch); tie(ticket, where); }
    slip(0.5, 0.91, 300, 110, 0.03, ['WHO GAINS?'], { size: 0.5, ink: '#7c1410' });

    if (chapter >= 2) {
      const heavy = photo(0.88, 0.33, 1, 0.07, 'heavy', '?? bowler');
      const hotel = slip(0.89, 0.68, 190, 120, -0.05, ['HOTEL', 'ALBION'], { font: SERIF, size: 0.3, lead: 0.36, ink: '#f3e7c2', paper: '#7c1410' });
      const gem = sheet(0.69, 0.1, 190, 150, -0.03, (gg, w, h) => { photograph(gg, w, h * 0.9, 'gem', rand); text(gg, 'HARROW SAPPHIRE · 38 ct', w / 2, h * 0.9, `700 ${h * 0.075}px ${TYPE}`, '#1c1a16'); }, '#2980b9');
      const policy = slip(0.7, 0.9, 250, 130, 0.05, ['INSURED  $40,000', 'policy in V.F.’s name', 'signed 3 wks ago'], { size: 0.2, lead: 0.3, ink: '#1f2a52', paper: '#f0e9a8' });
      const vera = photo(chapter === 3 ? 0.5 : 0.31, chapter === 3 ? 0.2 : 0.33, chapter === 3 ? 1.25 : 0.85, chapter === 3 ? 0 : -0.06, 'client', 'MRS V. FINCH');
      const where2 = mapAt(0.72, 0.5), where3 = mapAt(0.2, 0.2); pins.push(where2, where3);
      if (chapter === 2) { tie(heavy, hotel); tie(hotel, where2); tie(gem, clip); tie(policy, vera); tie(heavy, where3); }
      else {
        // Thursday: every string ends at her.
        for (const p of [finch, shop, clip, ticket, heavy, hotel, gem, policy, where, where2]) tie(p, vera);
        g.strokeStyle = 'rgba(170,20,14,0.9)'; g.lineWidth = 9; g.beginPath(); g.ellipse(vera[0], vera[1] + 150, 170, 190, 0.1, 0.2, 6.6); g.stroke();
        slip(0.5, 0.75, 380, 110, -0.02, ['she hired me to look', 'everywhere else'], { size: 0.3, lead: 0.4, ink: '#7c1410' });
        slip(0.1, 0.36, 180, 60, -0.12, ['ALIVE · Rm 12, Albion'], { size: 0.36, ink: '#7c1410', paper: '#f0e9a8' });
        sheet(0.31, 0.4, 300, 170, -0.04, (gg, w, h) => clipping(gg, w, h, 'FINCH FOUND\nALIVE', 'Wife held in sapphire plot', rand), '#e67e22');
      }
    }
  }
  // String, with the shadow it throws on the cork.
  for (const [a, b] of strings) {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(30,10,0,0.35)'; g.lineWidth = 7; g.beginPath(); g.moveTo(a[0] + 4, a[1] + 7); g.lineTo(b[0] + 4, b[1] + 7); g.stroke();
    g.strokeStyle = '#c21a12'; g.lineWidth = 5; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    g.strokeStyle = 'rgba(255,140,120,0.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(a[0], a[1] - 1); g.lineTo(b[0], b[1] - 1); g.stroke();
  }
  for (const [x, y, colour] of pins) {
    g.fillStyle = 'rgba(20,10,0,0.45)'; g.beginPath(); g.arc(x + 4, y + 6, 8, 0, 7); g.fill();
    g.fillStyle = colour; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.arc(x - 2.5, y - 2.5, 2.5, 0, 7); g.fill();
  }
  return texture(c, renderer);
}

// ---------------------------------------------------------------------------------------------------------
// Across the street
// ---------------------------------------------------------------------------------------------------------

/** The building opposite is this big (metres) and has this many windows. */
export const FACADE = { w: 18, h: 11, cols: 9, rows: 5 };

/** Its brick front and dark window openings, painted once. */
export function facade(renderer) {
  const W = 1440, H = 880, [c, g] = canvas(W, H), rand = makeRand(21);
  g.fillStyle = '#4c3229'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 8) for (let x = (y / 8 % 2) * 10; x < W; x += 20) { g.fillStyle = `rgba(${90 + rand() * 60},${50 + rand() * 30},${38 + rand() * 20},0.55)`; g.fillRect(x, y, 18, 6); }
  const cw = W / FACADE.cols, rh = H / FACADE.rows;
  for (let r = 0; r < FACADE.rows; r++) {
    g.fillStyle = '#6d6252'; g.fillRect(0, r * rh + rh * 0.93, W, rh * 0.07);
    for (let col = 0; col < FACADE.cols; col++) {
      const x = col * cw + cw * 0.24, y = r * rh + rh * 0.2, w = cw * 0.52, h = rh * 0.6;
      g.fillStyle = '#7d7262'; g.fillRect(x - 8, y - 10, w + 16, h + 22);
      g.fillStyle = '#0d0f12'; g.fillRect(x, y, w, h);
      g.fillStyle = '#5c5346'; g.fillRect(x, y + h * 0.48, w, 5); g.fillRect(x + w / 2 - 2, y, 4, h);
    }
  }
  return texture(c, renderer);
}

/** The lights on that front: lit rooms, the hotel's sign, and now and then somebody at a window. */
export class FacadeLights {
  constructor(renderer) {
    [this.canvas, this.g] = canvas(1440, 880);
    this.texture = texture(this.canvas, renderer);
    const rand = makeRand(4);
    this.lit = new Set();
    for (let i = 0; i < FACADE.cols * FACADE.rows; i++) if (rand() < 0.22) this.lit.add(i);
    this.spot = 2 * FACADE.cols + 5; // the window the watcher uses: third floor, facing ours
    this.lit.delete(this.spot);
    this.sign = [1, 1, 1, 1, 1];
    this.draw(false);
  }

  /** `watcher`: is somebody at the window. `sign`: which of the letters H O T E L are alight. */
  draw(watcher, sign = this.sign) {
    const g = this.g, W = 1440, H = 880, cw = W / FACADE.cols, rh = H / FACADE.rows;
    this.sign = sign; this.watcher = watcher;
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const pane = (i) => { const col = i % FACADE.cols, r = Math.floor(i / FACADE.cols); return [col * cw + cw * 0.24, r * rh + rh * 0.2, cw * 0.52, rh * 0.6]; };
    for (const i of this.lit) {
      const [x, y, w, h] = pane(i), b = g.createLinearGradient(0, y, 0, y + h);
      b.addColorStop(0, '#e7b25c'); b.addColorStop(1, '#8f5d22'); g.fillStyle = b; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(40,24,6,0.8)'; g.fillRect(x, y, w, h * (0.15 + (i * 37 % 10) / 22)); // a blind, part way down
      g.fillStyle = '#000'; g.fillRect(x, y + h * 0.48, w, 5); g.fillRect(x + w / 2 - 2, y, 4, h);
    }
    if (watcher) {
      const [x, y, w, h] = pane(this.spot);
      g.fillStyle = '#c9a56a'; g.fillRect(x, y, w, h);
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.fillStyle = '#0b0906'; person(g, 'passer', x + w * 0.5, y + h + 0.95 * (h / 1.1), h / 1.1);
      g.fillStyle = '#fff'; for (const s of [-1, 1]) { g.beginPath(); g.arc(x + w * 0.5 + s * 7, y + h * 0.3, 3.2, 0, 7); g.fill(); } // binoculars, catching the light
      g.restore();
    }
    // The sign: a blade down the corner of the building, one letter to a box.
    const sx = W * 0.5345, sy = H * 0.1, sw = 58, sh = 96; // between two columns of windows, opposite ours
    g.fillStyle = '#0a0506'; g.fillRect(sx - 8, sy - 10, sw + 16, sh * 5 + 20);
    'HOTEL'.split('').forEach((ch, i) => {
      const on = sign[i];
      g.save();
      if (on) { g.shadowColor = '#ff2a3c'; g.shadowBlur = 26; }
      g.strokeStyle = on ? '#ff6a70' : '#2a1416'; g.lineWidth = on ? 7 : 5; g.lineJoin = 'round';
      g.font = `700 70px "Helvetica Neue", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.strokeText(ch, sx + sw / 2, sy + sh * (i + 0.52));
      if (on) { g.shadowBlur = 0; g.strokeStyle = '#ffe1e0'; g.lineWidth = 2; g.strokeText(ch, sx + sw / 2, sy + sh * (i + 0.52)); }
      g.restore();
    });
    this.texture.needsUpdate = true;
  }

  dispose() { this.texture.dispose(); }
}

/** The elevated train's windows, to repeat along its side. */
export function trainWindows(renderer) {
  const [c, g] = canvas(512, 64);
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 8; i++) { if (i === 3) continue; g.fillStyle = '#f2cf8a'; g.fillRect(i * 64 + 8, 10, 48, 44); g.fillStyle = 'rgba(30,18,4,0.75)'; if (i % 3 === 1) { g.beginPath(); g.arc(i * 64 + 30, 44, 11, 0, 7); g.fill(); g.fillRect(i * 64 + 16, 50, 28, 6); } }
  const t = texture(c, renderer);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
