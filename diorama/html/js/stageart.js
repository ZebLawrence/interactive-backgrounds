// Diorama — the paper theatre's scenery and players: each a piece of card, cut to an outline and painted.
//
// A toy theatre's pieces are printed sheets pasted to card and cut out. Here the same outline does both jobs:
// a Pen records it once (in millimetres, x from the piece's middle, y up from its foot), and it is replayed
// as the card's geometry (extruded 1.2 mm, so it has an edge and throws a shadow) and as the clip the paint
// is laid inside. The painting is done with canvas strokes in the same millimetres, then given the grain of
// paper and the darker line a blade leaves along a cut edge.
//
// A player made of several cards (the ship: hull, masts, sails) is a few of these a fraction of a millimetre apart.

import * as THREE from 'three';
import { makeRand } from './pcboard.js';

const MM = 0.001, TAU = Math.PI * 2;
const SERIF = 'Georgia, "Times New Roman", serif';

/** An outline, recorded. Each M starts a new closed piece. */
export class Pen {
  constructor() { this.c = []; }
  M(x, y) { this.c.push(['M', x, y]); return this; }
  L(x, y) { this.c.push(['L', x, y]); return this; }
  Q(a, b, x, y) { this.c.push(['Q', a, b, x, y]); return this; }
  C(a, b, c, d, x, y) { this.c.push(['C', a, b, c, d, x, y]); return this; }
  poly(pts) { pts.forEach(([x, y], i) => (i ? this.L(x, y) : this.M(x, y))); return this; }
  rect(x, y, w, h) { return this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
  circle(cx, cy, r, n = 28) { for (let i = 0; i < n; i++) { const a = i / n * TAU; this[i ? 'L' : 'M'](cx + Math.cos(a) * r, cy + Math.sin(a) * r); } return this; }
  /** As three.js shapes, in metres. */
  shapes() {
    const out = []; let s = null;
    for (const [k, ...v] of this.c) {
      const m = v.map((n) => n * MM);
      if (k === 'M') { s = new THREE.Shape(); out.push(s); s.moveTo(...m); } else if (k === 'L') s.lineTo(...m); else if (k === 'Q') s.quadraticCurveTo(...m); else s.bezierCurveTo(...m);
    }
    return out;
  }
  /** Onto a canvas whose units are millimetres. */
  trace(g) {
    g.beginPath();
    let open = false;
    for (const [k, ...v] of this.c) {
      if (k === 'M') { if (open) g.closePath(); g.moveTo(...v); open = true; } else if (k === 'L') g.lineTo(...v); else if (k === 'Q') g.quadraticCurveTo(...v); else g.bezierCurveTo(...v);
    }
    if (open) g.closePath();
  }
}

let grain = null;
function paperGrain() {
  if (grain) return grain;
  grain = document.createElement('canvas'); grain.width = grain.height = 256;
  const g = grain.getContext('2d'), rand = makeRand(9), img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) { const v = rand() < 0.5 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = rand() * 22; }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 160; i++) { g.strokeStyle = `rgba(${rand() < 0.5 ? 255 : 60},${rand() < 0.5 ? 250 : 40},230,0.05)`; g.lineWidth = 1; g.beginPath(); const x = rand() * 256, y = rand() * 256; g.moveTo(x, y); g.lineTo(x + rand() * 40 - 20, y + rand() * 8 - 4); g.stroke(); }
  return grain;
}

/**
 * A piece of painted card. `w`, `h`: its box in mm (x from -w/2 to w/2, y from 0 to h); `pen`: its outline;
 * `holes`: a Pen of openings; `paint(g)`: draws inside it, in mm with y up; `base`: the ground colour.
 * Returns { geo, map }.
 */
export function card(renderer, { w, h, pen, holes = null, paint, base = '#d8d2c0', ppm = 4, thick = 1.2 }) {
  ppm = Math.min(ppm, 2048 / w, 2048 / h);
  const c = document.createElement('canvas'); c.width = Math.ceil(w * ppm); c.height = Math.ceil(h * ppm);
  const g = c.getContext('2d');
  g.setTransform(ppm, 0, 0, -ppm, c.width / 2, c.height);
  g.save();
  pen.trace(g); g.clip();
  g.fillStyle = base; g.fillRect(-w, -h, 3 * w, 3 * h);
  paint?.(g);
  // The blade's line along the cut edge, and a lighter one just inside it.
  g.lineJoin = 'round';
  pen.trace(g); g.strokeStyle = 'rgba(30,20,10,0.5)'; g.lineWidth = 1.1; g.stroke();
  if (holes) { holes.trace(g); g.stroke(); }
  g.restore();
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop';
  g.fillStyle = g.createPattern(paperGrain(), 'repeat'); g.fillRect(0, 0, c.width, c.height);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const shapes = pen.shapes();
  if (holes) for (const hole of holes.shapes()) shapes[0].holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: thick * MM, bevelEnabled: false, curveSegments: 10 }).translate(0, 0, -thick * MM / 2);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) / MM + w / 2) / w, p.getY(i) / MM / h);
  return { geo, map };
}

// Painting helpers: all in mm with y up.
const fill = (g, colour, pen) => { pen.trace(g); g.fillStyle = colour; g.fill(); };
const line = (g, colour, width, pts) => { g.strokeStyle = colour; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
const wash = (g, x, y, w, h, stops, across = false) => { const b = across ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + h); stops.forEach((s, i) => b.addColorStop(i / (stops.length - 1), s)); g.fillStyle = b; g.fillRect(x, y, w, h); };
const dot = (g, colour, x, y, r) => { g.fillStyle = colour; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); };
/** Text, the right way up (the canvas's y is flipped). */
const text = (g, s, x, y, size, colour, weight = 700, style = '') => { g.save(); g.translate(x, y); g.scale(1, -1); g.font = `${style} ${weight} ${size}px ${SERIF}`; g.fillStyle = colour; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, 0, 0); g.restore(); };
/** Loose brush marks, to keep a flat colour from looking printed. */
const brush = (g, rand, x, y, w, h, colour, n) => { g.strokeStyle = colour; g.lineCap = 'round'; for (let i = 0; i < n; i++) { g.lineWidth = 0.3 + rand() * 0.9; const bx = x + rand() * w, by = y + rand() * h, len = 4 + rand() * 14; g.beginPath(); g.moveTo(bx, by); g.quadraticCurveTo(bx + len / 2, by + rand() * 2 - 1, bx + len, by + rand() * 1.6 - 0.8); g.stroke(); } };

// ---------------------------------------------------------------------------------------------------------
// The sea
// ---------------------------------------------------------------------------------------------------------

/** A row of cut waves `w` mm long: crests `amp` high every `step` mm, on a body `body` deep. */
export function waves(renderer, { w = 700, amp = 14, step = 46, body = 30, deep = '#16465e', top = '#3f8fa6', seed = 1 }) {
  const pen = new Pen(), crest = [], rand = makeRand(seed);
  pen.M(-w / 2, 0).L(-w / 2, body);
  for (let x = -w / 2; x < w / 2 - 1; x += step) {
    const a = amp * (0.8 + rand() * 0.4), b = body;
    pen.C(x + step * 0.3, b, x + step * 0.42, b + a, x + step * 0.68, b + a).Q(x + step * 0.92, b + a * 0.98, x + step * 0.86, b + a * 0.5).Q(x + step * 0.82, b + a * 0.15, x + step, b);
    crest.push([x, a]);
  }
  pen.L(w / 2, 0);
  return card(renderer, {
    w, h: body + amp * 1.3, pen, base: deep, paint: (g) => {
      wash(g, -w / 2, 0, w, body + amp * 1.3, [deep, deep, top, top]);
      brush(g, rand, -w / 2, 2, w, body, 'rgba(255,255,255,0.1)', w / 3); brush(g, rand, -w / 2, 2, w, body * 0.8, 'rgba(0,20,40,0.2)', w / 3);
      for (const [x, a] of crest) {
        // Foam along the crest and down its curl, and the scroll inside the hollow.
        line(g, 'rgba(244,250,248,0.95)', 2.2, [[x + step * 0.36, body + a * 0.72], [x + step * 0.52, body + a * 0.93], [x + step * 0.7, body + a - 1.2], [x + step * 0.86, body + a * 0.82], [x + step * 0.84, body + a * 0.5]]);
        line(g, 'rgba(244,250,248,0.55)', 1, [[x + step * 0.2, body + a * 0.12], [x + step * 0.42, body + a * 0.42], [x + step * 0.62, body + a * 0.62]]);
        g.strokeStyle = 'rgba(8,36,56,0.55)'; g.lineWidth = 1; g.beginPath(); g.arc(x + step * 0.74, body + a * 0.42, a * 0.22, 0.4, 5); g.stroke();
        line(g, 'rgba(244,250,248,0.4)', 0.8, [[x + step * 0.05, body - 6 - rand() * 8], [x + step * 0.3, body - 4 - rand() * 8], [x + step * 0.55, body - 7 - rand() * 8]]);
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------------------
// The Petrel
// ---------------------------------------------------------------------------------------------------------

/** The ship, as layers back to front: [{ geo, map, z (mm) }]. About 150 mm from bowsprit to stern, 125 tall. */
export function ship(renderer) {
  const parts = [];
  const add = (z, o) => parts.push({ ...card(renderer, { w: 170, h: 130, ...o }), z });
  // Masts, yards and the bowsprit.
  const spars = new Pen().rect(-27.2, 22, 2.4, 96).rect(13.8, 22, 2.4, 104).poly([[40, 27], [78, 37], [78, 38.6], [40, 30]]);
  for (const [mx, ys] of [[-26, [52, 78, 100]], [15, [50, 78, 104]]]) ys.forEach((y, i) => spars.rect(mx - 21 + i * 3.5, y, 42 - i * 7, 1.5));
  add(-0.5, { pen: spars, base: '#5a3d24', paint: (g) => { wash(g, -85, 0, 170, 130, ['#3e2a18', '#6b4a2c', '#3e2a18'], true); } });
  // Sails: three on each mast, bellied to starboard, and two jibs.
  const sails = new Pen(), seams = [];
  for (const [mx, ys] of [[-26, [52, 78, 100]], [15, [50, 78, 104]]]) ys.forEach((y, i) => {
    const hw = 20 - i * 3.5, top = (ys[i + 1] ?? y + 15) - 2.5, tw = hw - 3;
    sails.M(mx - hw, y + 1).Q(mx + 6, y - 3.5, mx + hw, y + 1).Q(mx + hw + 4, (y + top) / 2, mx + tw, top).L(mx - tw, top).Q(mx - hw + 3.5, (y + top) / 2, mx - hw, y + 1);
    seams.push([mx, y, top, hw]);
  });
  // The jibs are their own card: where two pieces of one outline overlap, the paint has nothing to lie on.
  add(0.0, { pen: new Pen().M(32, 100).Q(50, 66, 76, 38).L(40, 44).L(32, 100), base: '#e9dfc4', paint: (g) => { wash(g, -85, 0, 170, 130, ['#d9c9a4', '#f6eedb', '#e6d9b8'], true); line(g, 'rgba(120,96,60,0.35)', 0.4, [[36, 92], [66, 44]]); } });
  add(0.15, { pen: new Pen().M(22, 122).Q(44, 84, 60, 47).L(27, 54).L(22, 122), base: '#efe6cf', paint: (g) => { wash(g, -85, 0, 170, 130, ['#e0d2b0', '#fbf6e8', '#e6d9b8'], true); line(g, 'rgba(120,96,60,0.35)', 0.4, [[26, 110], [50, 52]]); } });
  add(0.3, {
    pen: sails, base: '#efe6cf', paint: (g) => {
      wash(g, -85, 0, 170, 130, ['#d9c9a4', '#f6eedb', '#fbf6e8', '#e6d9b8'], true);
      for (const [mx, y, top, hw] of seams) { for (let k = -2; k <= 2; k++) line(g, 'rgba(120,96,60,0.35)', 0.4, [[mx + k * hw * 0.38, y], [mx + k * hw * 0.36 + 1.5, top]]); line(g, 'rgba(120,96,60,0.3)', 0.4, [[mx - hw, (y + top) / 2 - 2], [mx + hw + 2, (y + top) / 2 - 2]]); }
    },
  });
  // The hull: a dark side with an ochre strake, a row of ports, the stern's windows and the figurehead's curl.
  const hull = new Pen().M(-56, 34).L(-58, 20).Q(-54, 9, -40, 7).L(34, 7).Q(50, 9, 58, 22).Q(62, 28, 68, 31).L(60, 31).L(46, 25).L(-34, 25).L(-34, 34).L(-56, 34);
  add(0.9, {
    pen: hull, base: '#2c211a', paint: (g) => {
      wash(g, -85, 0, 170, 40, ['#5b1f18', '#5b1f18', '#231a15', '#2c211a']);                       // red below the waterline
      fill(g, '#c69a3c', new Pen().poly([[-58, 19.5], [58, 21.5], [58, 24], [-58, 22]]));
      for (let i = 0; i < 7; i++) { fill(g, '#0b0908', new Pen().rect(-36 + i * 11, 14.5, 4.2, 4)); line(g, '#8d6a2a', 0.4, [[-36 + i * 11, 18.9], [-31.8 + i * 11, 18.9]]); }
      for (let i = 0; i < 3; i++) fill(g, '#e9c56a', new Pen().rect(-54 + i * 5.2, 26.5, 3.4, 4.6));
      line(g, '#c69a3c', 0.7, [[-56, 33.2], [-34.5, 33.2]]); line(g, '#c69a3c', 1, [[58, 23], [63, 27], [66, 30.5]]);
      for (let y = 9; y < 20; y += 2.6) line(g, 'rgba(0,0,0,0.3)', 0.3, [[-56, y], [56, y + 1]]);
    },
  });
  // The pennant and the ensign.
  const flags = new Pen().poly([[16.2, 126.5], [-6, 124], [-1, 122.6], [-6, 121.4], [16.2, 119.5]]).poly([[-58.5, 34], [-58.5, 47], [-72, 46], [-72, 38]]).rect(-59, 34, 1, 14);
  add(1.2, { pen: flags, base: '#b3261c', paint: (g) => { fill(g, '#f3ead3', new Pen().poly([[-72, 41], [-58.5, 41.6], [-58.5, 43.6], [-72, 43]])); fill(g, '#3e2a18', new Pen().rect(-59, 34, 1, 14)); } });
  return parts;
}

// ---------------------------------------------------------------------------------------------------------
// Sky pieces
// ---------------------------------------------------------------------------------------------------------

export function sun(renderer) {
  const pen = new Pen(), n = 16;
  for (let i = 0; i < n * 2; i++) { const a = i / (n * 2) * TAU, r = i % 2 ? 24 : (i % 4 ? 37 : 43); pen[i ? 'L' : 'M'](Math.cos(a) * r, 45 + Math.sin(a) * r); }
  return card(renderer, {
    w: 90, h: 90, pen, base: '#e6ae2e', paint: (g) => {
      const b = g.createRadialGradient(0, 45, 4, 0, 45, 44); b.addColorStop(0, '#fff2b0'); b.addColorStop(0.5, '#f1c13f'); b.addColorStop(1, '#c9781c'); g.fillStyle = b; g.fillRect(-45, 0, 90, 90);
      g.strokeStyle = '#a65a12'; g.lineWidth = 0.8; g.beginPath(); g.arc(0, 45, 23, 0, TAU); g.stroke();
      // A face, as the old woodcuts gave it one.
      for (const s of [-1, 1]) { line(g, '#7a3f0c', 0.9, [[s * 13, 52], [s * 9, 54], [s * 5, 52]]); dot(g, '#7a3f0c', s * 9, 50.3, 1.5); dot(g, 'rgba(214,96,40,0.5)', s * 13, 41, 3.6); }
      line(g, '#7a3f0c', 0.9, [[0, 49], [-2, 43], [1.5, 42.5]]); g.strokeStyle = '#7a3f0c'; g.lineWidth = 1; g.beginPath(); g.arc(0, 43, 10, Math.PI * 1.2, Math.PI * 1.8); g.stroke();
    },
  });
}

export function moon(renderer) {
  const pen = new Pen().M(4, 2).C(-26, 2, -40, 40, -18, 66).C(-30, 40, -18, 14, 12, 6).Q(10, 3, 4, 2);
  pen.c = []; pen.M(8, 4).C(-34, 0, -40, 62, 6, 70).C(-18, 56, -18, 20, 8, 4);
  return card(renderer, {
    w: 70, h: 74, pen, base: '#f3ecd2', paint: (g) => {
      wash(g, -35, 0, 70, 74, ['#d8cfae', '#fbf7e6', '#e9e1c2'], true);
      dot(g, '#6b6248', -13, 42, 1.3); line(g, '#6b6248', 0.7, [[-17, 46.5], [-13, 47.5], [-9.5, 46]]); line(g, '#6b6248', 0.7, [[-14, 28], [-9, 26], [-5.5, 27.5]]);
      for (const [x, y, r] of [[-22, 30, 2.4], [-20, 54, 1.8], [-12, 16, 1.5]]) dot(g, 'rgba(120,110,80,0.2)', x, y, r);
    },
  });
}

export function star(renderer) {
  const pen = new Pen();
  for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + Math.PI / 2, r = i % 2 ? 2.6 : 6.5; pen[i ? 'L' : 'M'](Math.cos(a) * r, 6.5 + Math.sin(a) * r); }
  return card(renderer, { w: 14, h: 14, pen, base: '#f4dc8a', ppm: 8, thick: 0.6, paint: (g) => { dot(g, '#fffbe0', 0, 6.5, 2.4); } });
}

/** A cloud `w` mm long. `dark` makes it a storm cloud. */
export function cloud(renderer, w, seed, dark = false) {
  const rand = makeRand(seed), pen = new Pen(), h = w * 0.36, bumps = [];
  pen.M(-w / 2 + 6, 3).Q(-w / 2 - 2, 4, -w / 2 + 3, h * 0.3);
  let x = -w / 2 + 3;
  while (x < w / 2 - 12) { const bw = w * (0.16 + rand() * 0.14), bh = h * (0.55 + rand() * 0.45) * (1 - Math.abs((x + bw / 2) / w) * 0.9); pen.C(x - 2, h * 0.3 + bh, x + bw + 2, h * 0.3 + bh * 1.05, x + bw, h * 0.3 + bh * 0.1); bumps.push([x + bw / 2, h * 0.3 + bh * 0.5, bw * 0.5]); x += bw; }
  pen.Q(w / 2 + 3, 5, w / 2 - 6, 3);
  if (dark) for (let i = 0; i < 5; i++) pen.Q(w / 2 - 6 - (i + 0.5) * (w - 12) / 5, -3 * (i % 2) + 1, w / 2 - 6 - (i + 1) * (w - 12) / 5, 3);
  return card(renderer, {
    w: w + 8, h: h * 1.4, pen, base: dark ? '#3b4250' : '#f4f1ea', paint: (g) => {
      wash(g, -w, -4, 2 * w, h * 1.5, dark ? ['#1c2029', '#3a414f', '#6a7180'] : ['#b9c6d6', '#f1f0ec', '#ffffff']);
      for (const [bx, by, r] of bumps) { g.strokeStyle = dark ? 'rgba(170,180,196,0.5)' : 'rgba(150,168,190,0.6)'; g.lineWidth = 0.7; g.beginPath(); g.arc(bx, by - r * 0.5, r * 0.8, 0.5, 2.5); g.stroke(); }
    },
  });
}

/** A gull, wings up. */
export function gull(renderer) {
  const pen = new Pen().M(0, 3).Q(-7, 10, -15, 7.5).Q(-8, 7.5, -2, 1.5).L(0, 0).L(2, 1.5).Q(8, 7.5, 15, 7.5).Q(7, 10, 0, 3);
  return card(renderer, { w: 32, h: 11, pen, base: '#f6f4ee', ppm: 8, thick: 0.6, paint: (g) => { fill(g, '#3c4048', new Pen().poly([[-15, 7.5], [-11, 8.6], [-10, 7.4]])); fill(g, '#3c4048', new Pen().poly([[15, 7.5], [11, 8.6], [10, 7.4]])); } });
}

/** A fork of lightning, to be dropped in from the flies. */
export function bolt(renderer) {
  const pen = new Pen().poly([[2, 190], [14, 190], [-2, 128], [12, 132], [-10, 64], [4, 70], [-14, 0], [-8, 84], [-20, 78], [-6, 146], [-16, 142]]);
  return card(renderer, { w: 44, h: 190, pen, base: '#fff6c4', paint: (g) => { wash(g, -22, 0, 44, 190, ['#ffffff', '#ffe98a', '#fff9d8'], true); } });
}

// ---------------------------------------------------------------------------------------------------------
// The harbour
// ---------------------------------------------------------------------------------------------------------

/** The town: a row of gabled houses with a church among them, as one flat. Returns the card and where its windows are (mm). */
export function town(renderer) {
  const rand = makeRand(31), pen = new Pen(), houses = [], windows = [];
  let x = -150;
  pen.M(x, 0);
  const colours = ['#d9b98a', '#c9785a', '#e6d9b0', '#9fb3a6', '#d8a24a', '#b9c7d6', '#c98f8f', '#e8e0c8'];
  for (let i = 0; i < 9; i++) {
    const church = i === 4, w = church ? 30 : 26 + rand() * 12, h = church ? 62 : 38 + rand() * 30, roof = church ? 58 : 12 + rand() * 12;
    pen.L(x, h);
    if (church) pen.L(x + w * 0.3, h).L(x + w * 0.3, h + 14).L(x + w / 2, h + roof).L(x + w * 0.7, h + 14).L(x + w * 0.7, h);
    else if (i % 3 === 1) pen.L(x, h + 2).L(x + w * 0.25, h + roof * 0.5).L(x + w * 0.25, h + roof).L(x + w * 0.75, h + roof).L(x + w * 0.75, h + roof * 0.5).L(x + w, h + 2); // a stepped gable
    else pen.L(x + w / 2, h + roof);
    pen.L(x + w, h);
    houses.push({ x, w, h, roof, church, colour: colours[i % colours.length], stepped: i % 3 === 1 });
    x += w;
  }
  pen.L(x, 0);
  const c = card(renderer, {
    w: 320, h: 130, pen, base: '#d8c9a8', paint: (g) => {
      for (const b of houses) {
        wash(g, b.x, 0, b.w, b.h, [b.colour, b.colour, '#f2ead6']);
        fill(g, b.church ? '#4f6672' : '#8a3f2e', b.stepped ? new Pen().poly([[b.x, b.h], [b.x, b.h + 2], [b.x + b.w * 0.25, b.h + b.roof * 0.5], [b.x + b.w * 0.25, b.h + b.roof], [b.x + b.w * 0.75, b.h + b.roof], [b.x + b.w * 0.75, b.h + b.roof * 0.5], [b.x + b.w, b.h + 2], [b.x + b.w, b.h]])
          : b.church ? new Pen().poly([[b.x + b.w * 0.3, b.h + 14], [b.x + b.w / 2, b.h + b.roof], [b.x + b.w * 0.7, b.h + 14]]) : new Pen().poly([[b.x, b.h], [b.x + b.w / 2, b.h + b.roof], [b.x + b.w, b.h]]));
        if (b.church) { fill(g, '#cfc8b4', new Pen().rect(b.x + b.w * 0.3, b.h, b.w * 0.4, 14)); dot(g, '#f4ead0', b.x + b.w / 2, b.h + 7, 3.4); line(g, '#3b3226', 0.5, [[b.x + b.w / 2, b.h + 7], [b.x + b.w / 2, b.h + 9.4]]); line(g, '#3b3226', 0.5, [[b.x + b.w / 2, b.h + 7], [b.x + b.w / 2 + 1.8, b.h + 7]]); }
        line(g, 'rgba(60,40,20,0.55)', 0.5, [[b.x, 0], [b.x, b.h]]);
        const cols = Math.max(2, Math.round(b.w / 11)), rows = Math.max(2, Math.floor((b.h - 16) / 13));
        for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
          const wx = b.x + (k + 0.5) * b.w / cols - 2.3, wy = 15 + r * 13;
          if (r === 0 && k === Math.floor(cols / 2)) { fill(g, '#4a2f1c', new Pen().rect(wx - 0.6, 0, 5.8, 12)); dot(g, '#d8b060', wx + 4, 6, 0.5); continue; }
          fill(g, '#22303c', new Pen().rect(wx, wy, 4.6, 7)); line(g, '#efe6cf', 0.4, [[wx + 2.3, wy], [wx + 2.3, wy + 7]]); line(g, '#efe6cf', 0.4, [[wx, wy + 3.5], [wx + 4.6, wy + 3.5]]);
          fill(g, '#efe6cf', new Pen().rect(wx - 0.6, wy - 1, 5.8, 0.9));
          if (rand() < 0.55) windows.push([wx + 2.3, wy + 3.5]);
        }
        brush(g, rand, b.x, 2, b.w, b.h - 4, 'rgba(90,60,30,0.12)', 8);
      }
    },
  });
  return { ...c, windows };
}

export function lighthouse(renderer) {
  const pen = new Pen().M(-34, 0).Q(-30, 14, -17, 18).L(-10, 122).L(-13, 122).L(-13, 127).L(-8, 127).L(-8, 142).Q(0, 156, 8, 142).L(8, 127).L(13, 127).L(13, 122).L(10, 122).L(17, 18).Q(32, 13, 40, 0);
  return card(renderer, {
    w: 84, h: 156, pen, base: '#f1ebdc', paint: (g) => {
      wash(g, -20, 18, 40, 106, ['#cfc8b6', '#fbf7ea', '#fbf7ea', '#bdb6a4'], true);
      for (let i = 0; i < 3; i++) { const y = 30 + i * 34; fill(g, '#b3261c', new Pen().poly([[-16.3 + (y - 18) * 0.067, y], [16.3 - (y - 18) * 0.067, y], [15.2 - (y - 18) * 0.067, y + 17], [-15.2 + (y - 18) * 0.067, y + 17]])); }
      wash(g, -20, 18, 40, 106, ['rgba(0,0,0,0.25)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.3)'], true);
      fill(g, '#2b2f36', new Pen().rect(-13, 122, 26, 5)); fill(g, '#f6dc7a', new Pen().rect(-8, 127, 16, 15)); fill(g, '#2b2f36', new Pen().M(-8, 142).Q(0, 156, 8, 142).L(-8, 142));
      for (const x of [-8, -2.7, 2.7, 7.4]) line(g, '#2b2f36', 0.7, [[x, 127], [x, 142]]);
      fill(g, '#3b2a1c', new Pen().M(-3, 18).L(-3, 28).Q(0, 31, 3, 28).L(3, 18).L(-3, 18)); for (const y of [56, 92]) fill(g, '#22303c', new Pen().rect(-2, y, 4, 6));
      // The rock it stands on.
      fill(g, '#5c5a58', new Pen().M(-34, 0).Q(-30, 14, -17, 18).L(17, 18).Q(32, 13, 40, 0).L(-34, 0)); brush(g, makeRand(2), -32, 1, 68, 14, 'rgba(20,20,24,0.45)', 26); brush(g, makeRand(3), -30, 4, 60, 12, 'rgba(210,210,200,0.3)', 14);
    },
  });
}

/** The quay wall, 340 mm of it, with bollards and mooring rings. */
export function quay(renderer) {
  const pen = new Pen().M(-170, 0).L(-170, 30);
  for (let x = -150; x < 160; x += 62) pen.L(x - 4, 30).L(x - 4, 36).Q(x, 39, x + 4, 36).L(x + 4, 30);
  pen.L(170, 30).L(170, 0);
  const rand = makeRand(8);
  return card(renderer, {
    w: 340, h: 40, pen, base: '#9a9182', paint: (g) => {
      wash(g, -170, 0, 340, 30, ['#4c4a44', '#8d8474', '#aaa08c']);
      for (let r = 0; r < 4; r++) { line(g, 'rgba(40,36,30,0.5)', 0.4, [[-170, r * 7.4 + 1], [170, r * 7.4 + 1]]); for (let x = -170 + (r % 2) * 9; x < 170; x += 18) line(g, 'rgba(40,36,30,0.5)', 0.4, [[x, r * 7.4 + 1], [x, r * 7.4 + 8.4]]); }
      fill(g, '#c9bfa6', new Pen().rect(-170, 27, 340, 3)); brush(g, rand, -170, 1, 340, 10, 'rgba(60,90,70,0.35)', 60);
      for (let x = -150; x < 160; x += 62) { fill(g, '#2b2a28', new Pen().M(x - 4, 30).L(x - 4, 36).Q(x, 39, x + 4, 36).L(x + 4, 30).L(x - 4, 30)); g.strokeStyle = '#3a2f20'; g.lineWidth = 0.9; g.beginPath(); g.arc(x + 31, 15, 2.6, 0, TAU); g.stroke(); }
    },
  });
}

/** The painted panorama that is wound past behind the sea: 1.3 m of islands. */
export function panorama(renderer) {
  const rand = makeRand(12), pen = new Pen().M(-650, 0);
  const peaks = [];
  for (let x = -650; x < 650;) {
    const gap = 40 + rand() * 90, w = 90 + rand() * 150, h = 22 + rand() * 44;
    pen.L(x + gap, 0).L(x + gap, 2).C(x + gap + w * 0.2, 4, x + gap + w * 0.3, h, x + gap + w * 0.48, h).C(x + gap + w * 0.62, h, x + gap + w * 0.8, 6, x + gap + w, 2).L(x + gap + w, 0);
    peaks.push([x + gap, w, h]); x += gap + w;
  }
  pen.L(650, 0);
  return card(renderer, {
    w: 1300, h: 72, pen, base: '#7f9c9a', paint: (g) => {
      wash(g, -650, 0, 1300, 72, ['#52757a', '#8fae9e', '#c9c79a']);
      for (const [x, w, h] of peaks) {
        brush(g, rand, x, 2, w, h * 0.7, 'rgba(40,80,60,0.4)', w / 4);
        for (let i = 0; i < 3 && h > 30; i++) { const px = x + w * (0.2 + rand() * 0.6); line(g, '#4b3a26', 0.6, [[px, 2], [px + 1, 10]]); for (let k = 0; k < 5; k++) line(g, '#2f5a3a', 0.7, [[px + 1, 10], [px + 1 + Math.cos(k * 1.2 + 0.4) * 5, 10 + Math.sin(k * 1.2 + 0.4) * 3.4]]); }
        fill(g, 'rgba(236,224,180,0.8)', new Pen().poly([[x + 4, 0], [x + w - 4, 0], [x + w - 10, 2.4], [x + 10, 2.4]]));
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------------------
// What comes up out of the sea
// ---------------------------------------------------------------------------------------------------------

/** The serpent's pieces: { head, hump, tail }. */
export function serpent(renderer) {
  const scales = (g, rand, x0, y0, w, h) => { g.strokeStyle = 'rgba(12,50,36,0.6)'; g.lineWidth = 0.5; for (let y = y0; y < y0 + h; y += 3.2) for (let x = x0 + ((y / 3.2) % 2) * 2.2; x < x0 + w; x += 4.4) { g.beginPath(); g.arc(x, y, 2.3, Math.PI, TAU); g.stroke(); } };
  const skin = ['#1d5a40', '#3f9a62', '#bfd88a'];
  const hump = new Pen().M(-44, 0).C(-40, 44, -18, 58, 0, 58).C(18, 58, 40, 44, 44, 0).L(26, 0).C(22, 28, 12, 36, 0, 36).C(-12, 36, -22, 28, -26, 0);
  for (let i = -3; i <= 3; i++) { const a = Math.PI / 2 - i * 0.33, r = 57; hump.M(Math.cos(a - 0.12) * r, Math.sin(a - 0.12) * r).L(Math.cos(a) * (r + 9), Math.sin(a) * (r + 9) + 1).L(Math.cos(a + 0.12) * r, Math.sin(a + 0.12) * r); }
  const head = new Pen().M(-16, 0).C(-22, 50, -30, 80, -8, 104).C(4, 118, 30, 122, 52, 112).Q(62, 108, 60, 102).L(34, 98).L(58, 94).Q(60, 88, 50, 86).C(30, 84, 18, 80, 14, 64).C(10, 44, 12, 20, 12, 0);
  head.M(-10, 104).L(-22, 122).L(-2, 112).M(4, 114).L(2, 132).L(16, 118).M(-22, 84).L(-36, 96).L(-22, 96);
  const tail = new Pen().M(-10, 0).C(-12, 30, -4, 52, 14, 60).L(34, 76).L(26, 56).L(44, 54).C(22, 46, 12, 28, 10, 0);
  const paint = (w, h, extra) => (g) => { wash(g, -w / 2, 0, w, h, skin, false); scales(g, makeRand(4), -w / 2, 0, w, h); wash(g, -w / 2, 0, w, h, ['rgba(0,20,10,0.35)', 'rgba(0,0,0,0)', 'rgba(255,255,220,0.12)'], true); extra?.(g); };
  return {
    hump: card(renderer, { w: 100, h: 70, pen: hump, base: skin[1], paint: paint(100, 70) }),
    head: card(renderer, {
      w: 130, h: 134, pen: head, base: skin[1], paint: paint(130, 134, (g) => {
        dot(g, '#f6e27a', 28, 106, 4.6); fill(g, '#141008', new Pen().poly([[28, 110], [29.2, 106], [28, 102], [26.8, 106]])); line(g, '#0d2a1c', 0.9, [[20, 111], [28, 113.5], [36, 111]]);
        fill(g, '#7a1410', new Pen().poly([[34, 98], [58, 94], [50, 86.5], [30, 90]])); for (let i = 0; i < 5; i++) fill(g, '#f6f0dc', new Pen().poly([[36 + i * 4.4, 97.6 - i * 0.7], [38 + i * 4.4, 93.4 - i * 0.6], [40 + i * 4.4, 96.9 - i * 0.7]]));
        dot(g, '#0d2a1c', 54, 108, 0.9); fill(g, '#c7422c', new Pen().poly([[-10, 104], [-22, 122], [-2, 112]])); fill(g, '#c7422c', new Pen().poly([[4, 114], [2, 132], [16, 118]])); fill(g, '#c7422c', new Pen().poly([[-22, 84], [-36, 96], [-22, 96]]));
        fill(g, 'rgba(230,236,170,0.6)', new Pen().M(6, 0).C(6, 30, 6, 60, 12, 78).L(14, 64).C(10, 44, 12, 20, 12, 0).L(6, 0));
      }),
    }),
    tail: card(renderer, { w: 100, h: 80, pen: tail, base: skin[1], paint: paint(100, 80, (g) => { fill(g, '#c7422c', new Pen().poly([[14, 60], [34, 76], [26, 56], [44, 54], [22, 48]])); }) }),
  };
}

/** The whale: { body, fluke, spout }. */
export function whale(renderer) {
  const body = new Pen().M(-120, 0).C(-118, 40, -84, 62, -30, 64).C(30, 66, 96, 52, 122, 0);
  const fluke = new Pen().M(-7, 0).C(-9, 24, -4, 36, 0, 44).C(-10, 58, -30, 66, -44, 60).C(-28, 50, -22, 40, 0, 52).C(22, 40, 28, 50, 44, 60).C(30, 66, 10, 58, 0, 44).C(4, 36, 9, 24, 7, 0);
  fluke.c = []; fluke.M(-7, 0).C(-9, 24, -5, 36, -2, 46).C(-12, 60, -30, 68, -46, 62).C(-34, 56, -22, 50, 0, 58).C(22, 50, 34, 56, 46, 62).C(30, 68, 12, 60, 2, 46).C(5, 36, 9, 24, 7, 0);
  const spout = new Pen().M(-3, 0).C(-4, 30, -10, 46, -26, 58).C(-30, 66, -20, 68, -16, 62).C(-12, 72, -2, 72, 0, 62).C(2, 72, 12, 72, 16, 62).C(20, 68, 30, 66, 26, 58).C(10, 46, 4, 30, 3, 0);
  const rand = makeRand(6);
  return {
    body: card(renderer, {
      w: 250, h: 68, pen: body, base: '#3d4f63', paint: (g) => {
        wash(g, -125, 0, 250, 68, ['#1f2c3c', '#3d4f63', '#6f8296']);
        fill(g, '#c9cfc9', new Pen().M(-120, 0).C(-110, 16, -60, 20, -10, 0).L(-120, 0));
        for (let i = 0; i < 9; i++) line(g, 'rgba(210,216,210,0.5)', 0.5, [[-112 + i * 9, 1], [-96 + i * 9, 13 - i]]);
        dot(g, '#0c1016', -84, 26, 2.2); dot(g, '#e8e8e0', -84.6, 26.7, 0.6); line(g, '#141c26', 0.9, [[-118, 16], [-100, 18], [-80, 15]]);
        for (let i = 0; i < 16; i++) dot(g, 'rgba(214,214,200,0.55)', -60 + rand() * 150, 30 + rand() * 26, 0.6 + rand() * 1.2);
        brush(g, rand, -110, 20, 220, 40, 'rgba(160,180,200,0.18)', 60);
      },
    }),
    fluke: card(renderer, { w: 96, h: 70, pen: fluke, base: '#34455a', paint: (g) => { wash(g, -48, 0, 96, 70, ['#1f2c3c', '#3d4f63', '#5d7088']); for (let i = -3; i <= 3; i++) line(g, 'rgba(20,28,38,0.5)', 0.4, [[i * 1.6, 44], [i * 12, 60]]); } }),
    spout: card(renderer, { w: 64, h: 74, pen: spout, base: '#e8f2f4', thick: 0.6, paint: (g) => { wash(g, -32, 0, 64, 74, ['#9fc4d0', '#e8f2f4', '#ffffff']); for (let i = -4; i <= 4; i++) line(g, 'rgba(120,170,190,0.5)', 0.4, [[i * 0.5, 4], [i * 5, 56]]); } }),
  };
}

export function dolphin(renderer) {
  const pen = new Pen().M(-27, 6).C(-18, 18, 6, 22, 22, 12).L(30, 10).L(23, 8).C(14, 2, -6, 2, -18, 6).L(-25, 0).L(-24, 6).L(-30, 10).L(-27, 6).M(-2, 18).L(-6, 28).L(6, 18);
  return card(renderer, { w: 64, h: 30, pen, base: '#51708a', ppm: 6, thick: 0.8, paint: (g) => { wash(g, -32, 0, 64, 30, ['#d6dcd8', '#51708a', '#31485c']); dot(g, '#0d1218', 17, 12.6, 0.8); line(g, '#1c2a38', 0.5, [[21, 10], [27, 10]]); } });
}

/** A firework's burst, in one of three colours. */
export function burst(renderer, colour) {
  const pen = new Pen(), n = 14;
  for (let i = 0; i < n * 2; i++) { const a = i / (n * 2) * TAU, r = i % 2 ? 9 : (i % 4 ? 34 : 44); pen[i ? 'L' : 'M'](Math.cos(a) * r, 46 + Math.sin(a) * r); }
  for (let i = 0; i < n; i++) { const a = (i + 0.5) / n * TAU; pen.circle(Math.cos(a) * 42, 46 + Math.sin(a) * 42, 2.2, 8); }
  return card(renderer, { w: 96, h: 96, pen, base: colour, thick: 0.6, paint: (g) => { const b = g.createRadialGradient(0, 46, 2, 0, 46, 46); b.addColorStop(0, '#ffffff'); b.addColorStop(0.35, colour); b.addColorStop(1, '#fff3c0'); g.fillStyle = b; g.fillRect(-48, 0, 96, 96); } });
}

// ---------------------------------------------------------------------------------------------------------
// The house: proscenium, wings, borders, placards
// ---------------------------------------------------------------------------------------------------------

/**
 * The proscenium: the painted front, `w` x `h` mm, with the stage opening cut out of it. `open` is
 * { w, y0, y1 } (mm): the opening's width and its bottom and top edges.
 */
export function proscenium(renderer, w, h, open) {
  const pen = new Pen().rect(-w / 2, 0, w, h), a = open.w / 2, r = 34;
  const holes = new Pen().M(-a, open.y0).L(-a, open.y1 - r).Q(-a, open.y1, -a + r, open.y1).L(a - r, open.y1).Q(a, open.y1, a, open.y1 - r).L(a, open.y0);
  const gold = '#c9a04a', deepGold = '#8a6524', red = '#7c1f1c', cream = '#e9dfc4';
  return card(renderer, {
    w, h, pen, holes, base: cream, ppm: 3.4, thick: 3, paint: (g) => {
      wash(g, -w / 2, 0, w, h, ['#d8cba8', cream, '#f3ecd8']);
      // The base under the stage: a red dado with gilt panels.
      wash(g, -w / 2, 0, w, open.y0 - 6, ['#4a1210', red, '#93302a']);
      fill(g, gold, new Pen().rect(-w / 2, open.y0 - 6, w, 3)); fill(g, deepGold, new Pen().rect(-w / 2, open.y0 - 3.4, w, 0.8));
      for (let x = -w / 2 + 12; x < w / 2 - 40; x += 66) { g.strokeStyle = gold; g.lineWidth = 0.9; g.strokeRect(x, 6, 54, open.y0 - 18); g.strokeStyle = deepGold; g.lineWidth = 0.4; g.strokeRect(x + 2, 8, 50, open.y0 - 22); }
      // A column either side of the opening: fluted shaft, base and capital.
      for (const s of [-1, 1]) {
        const cx = s * (a + (w / 2 - a) / 2), cw = Math.min(30, (w / 2 - a) * 0.62);
        wash(g, cx - cw / 2, open.y0, cw, open.y1 - open.y0 - 26, ['#a89872', '#f6f0dc', '#fffaf0', '#cfc3a0', '#9a8a66'], true);
        for (let k = -3; k <= 3; k++) line(g, 'rgba(110,92,58,0.45)', 0.5, [[cx + k * cw / 8, open.y0 + 8], [cx + k * cw / 8, open.y1 - 30]]);
        fill(g, gold, new Pen().rect(cx - cw / 2 - 3, open.y0, cw + 6, 7)); fill(g, deepGold, new Pen().rect(cx - cw / 2 - 3, open.y0 + 6.2, cw + 6, 0.9));
        fill(g, gold, new Pen().poly([[cx - cw / 2 - 1, open.y1 - 26], [cx + cw / 2 + 1, open.y1 - 26], [cx + cw / 2 + 6, open.y1 - 12], [cx - cw / 2 - 6, open.y1 - 12]]));
        for (const t of [-1, 1]) { g.strokeStyle = deepGold; g.lineWidth = 0.8; g.beginPath(); g.arc(cx + t * (cw / 2 + 1.5), open.y1 - 17, 3.4, 0, TAU * 0.8); g.stroke(); }
        for (let k = -2; k <= 2; k++) line(g, deepGold, 0.5, [[cx + k * cw / 6, open.y1 - 25], [cx + k * cw / 5, open.y1 - 14]]);
      }
      // The frame round the opening.
      const frame = (off, width, colour) => { g.strokeStyle = colour; g.lineWidth = width; g.beginPath(); g.moveTo(-a - off, open.y0); g.lineTo(-a - off, open.y1 - r); g.quadraticCurveTo(-a - off, open.y1 + off, -a + r, open.y1 + off); g.lineTo(a - r, open.y1 + off); g.quadraticCurveTo(a + off, open.y1 + off, a + off, open.y1 - r); g.lineTo(a + off, open.y0); g.stroke(); };
      frame(2.2, 4.4, gold); frame(0.5, 0.7, deepGold); frame(4.6, 0.6, deepGold); frame(6.6, 1.6, red);
      // The entablature: a red frieze with gilt swags, and the cartouche with the piece's name.
      const top = open.y1 + 9;
      wash(g, -w / 2, top, w, h - top, ['#93302a', red, '#4a1210']);
      fill(g, gold, new Pen().rect(-w / 2, top, w, 2.4)); fill(g, gold, new Pen().rect(-w / 2, h - 4, w, 4));
      for (let x = -w / 2 + 6; x < w / 2 - 20; x += 44) { if (Math.abs(x + 22) < 108) continue; g.strokeStyle = gold; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, h - 6); g.quadraticCurveTo(x + 22, top + 2, x + 44, h - 6); g.stroke(); dot(g, gold, x, h - 7, 1.6); g.strokeStyle = deepGold; g.lineWidth = 0.4; g.beginPath(); g.moveTo(x + 3, h - 8); g.quadraticCurveTo(x + 22, top + 6, x + 41, h - 8); g.stroke(); }
      const cy = (top + h) / 2 - 0.5, ch = (h - top) / 2 - 2.5;
      g.fillStyle = cream; g.beginPath(); g.ellipse(0, cy, 84, ch, 0, 0, TAU); g.fill(); g.strokeStyle = gold; g.lineWidth = 1.6; g.stroke();
      g.strokeStyle = deepGold; g.lineWidth = 0.4; g.beginPath(); g.ellipse(0, cy, 80.5, ch - 2.6, 0, 0, TAU); g.stroke();
      text(g, 'THE VOYAGE OF THE PETREL', 0, cy + ch * 0.2, ch * 0.46, '#3a1512', 700); text(g, 'a spectacle in five scenes', 0, cy - ch * 0.46, ch * 0.34, '#6b3a22', 400, 'italic');
      for (const s of [-1, 1]) { dot(g, gold, s * 90, cy, 2.6); g.strokeStyle = gold; g.lineWidth = 1; g.beginPath(); g.arc(s * 98, cy, 5, s > 0 ? -1.8 : 1.3, s > 0 ? 1.8 : 4.9); g.stroke(); }
    },
  });
}

/** A wing flat: a dark blue tormentor with gilt stars, `w` x `h` mm, its onstage edge cut in scallops. `side` is -1 or 1. */
export function wing(renderer, w, h, side) {
  const pen = new Pen().M(-side * w / 2, 0).L(-side * w / 2, h);
  pen.L(side * w / 2, h);
  for (let y = h; y > 0.5; y -= h / 9) pen.Q(side * (w / 2 - 9), y - h / 18, side * w / 2, Math.max(0, y - h / 9));
  const rand = makeRand(side + 5);
  return card(renderer, { w: w + 2, h, pen, base: '#1c2a4a', paint: (g) => { wash(g, -w / 2, 0, w, h, ['#101a30', '#22345c', '#16223e'], true); for (let i = 0; i < 26; i++) { const x = -w / 2 + rand() * w * 0.85 + (side > 0 ? 0 : w * 0.1), y = rand() * h; dot(g, '#d7b45a', x, y, 0.5 + rand() * 0.9); } for (let y = h / 18; y < h; y += h / 9) line(g, 'rgba(215,180,90,0.6)', 0.6, [[side * (w / 2 - 12), y - 10], [side * (w / 2 - 14), y], [side * (w / 2 - 12), y + 10]]); } });
}

/** A border: a strip of painted cloth hung across the top, scalloped along its foot. */
export function border(renderer, w, h) {
  const pen = new Pen().M(-w / 2, h).L(w / 2, h).L(w / 2, 8);
  for (let x = w / 2; x > -w / 2 + 1; x -= w / 12) pen.Q(x - w / 24, -6, Math.max(-w / 2, x - w / 12), 8);
  return card(renderer, { w, h: h + 2, pen, base: '#22345c', paint: (g) => { wash(g, -w / 2, 0, w, h, ['#16223e', '#22345c', '#101a30']); fill(g, '#c9a04a', new Pen().rect(-w / 2, h - 3, w, 1)); for (let x = -w / 2 + w / 24; x < w / 2; x += w / 12) { dot(g, '#c9a04a', x, 6, 1.5); line(g, '#c9a04a', 0.5, [[x, 4.5], [x, 0.5]]); } } });
}

/** The placard that stands at the foot of the stage and names the scene. */
export function placard(renderer, numeral, title) {
  const pen = new Pen().M(-34, 0).L(-34, 30).Q(0, 37, 34, 30).L(34, 0);
  return card(renderer, {
    w: 70, h: 38, pen, base: '#efe6cf', ppm: 8, paint: (g) => {
      g.strokeStyle = '#7c1f1c'; g.lineWidth = 0.9; g.strokeRect(-31, 3, 62, 25); g.strokeStyle = '#c9a04a'; g.lineWidth = 0.4; g.strokeRect(-29.6, 4.4, 59.2, 22.2);
      text(g, `SCENE ${numeral}`, 0, 21.5, 5.2, '#7c1f1c', 700); text(g, title, 0, 12, title.length > 10 ? 7 : 8.4, '#2a1c14', 700, 'italic');
    },
  });
}
