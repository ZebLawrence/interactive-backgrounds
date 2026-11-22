// Diorama — the motherboard's printed circuit board, painted once at load, and the printed labels.
//
// The rule (Trawler's): what is PRINTED is a texture, because printing is flat; what catches the light is
// geometry. A circuit board is the limiting case of printing: solder mask over etched copper, 35 microns of
// relief, with white silkscreen on top. So the board is three maps painted in millimetres at ten pixels to
// the millimetre (0.1 mm a pixel, which is finer than a 4K screen can show at arm's length):
//
//   colour      matte black solder mask, the faintly lighter copper under it, tinned pads and vias, silkscreen
//   normal      from a height map painted alongside: traces stand 35 microns proud, pads and passives more,
//               so a light raking across the board picks every trace out
//   roughness   mask is satin, copper under mask a little glossier, tin bright, silkscreen chalky
//   + metalness (same image, blue channel): only the bare tin
//
// Everything is decided from one seeded random stream, so a board is the same every time for a seed.

import * as THREE from 'three';

/** The board: full-size ATX, 305 x 244 mm, origin at its bottom-left as seen through the side panel. */
export const BOARD = {
  w: 0.305, h: 0.244, thick: 0.0016, standoff: 0.0065,
  cpu: { x: 0.105, y: 0.172, size: 0.046 },
  ramX: [0.168, 0.1776, 0.1872, 0.1968], ramY: [0.098, 0.2395],
  atx24: { x: 0.294, y: 0.1775, w: 0.0105, h: 0.052 },
  eps: { x: 0.047, y: 0.2375, w: 0.021, h: 0.0105 },
  pcieY: [0.0885, 0.0682, 0.0479, 0.0276], pcieX: [0.0345, 0.124],
  m2: [{ x: 0.17, y: 0.0725, w: 0.092, h: 0.024 }, { x: 0.17, y: 0.031, w: 0.092, h: 0.024 }],
  chipset: { x: 0.256, y: 0.066, w: 0.058, h: 0.062 },
  vrmLeft: { x: 0.0445, y: 0.168, w: 0.026, h: 0.108 },
  vrmTop: { x: 0.107, y: 0.2265, w: 0.094, h: 0.021 },
  io: { x: 0.0165, y: 0.172, w: 0.033, h: 0.144 },
  sata: { x: 0.2985, y: 0.07, w: 0.013, h: 0.056 },
  battery: { x: 0.232, y: 0.112, r: 0.01 },
  holes: [[0.0064, 0.2377], [0.1397, 0.2377], [0.2985, 0.2377], [0.0064, 0.0825], [0.1397, 0.0825], [0.2985, 0.0825], [0.0064, 0.0064], [0.1397, 0.0064], [0.2985, 0.0064]],
};

const PX = 10; // pixels per millimetre
const MM_PER_LEVEL = 0.6 / 255; // the height map's scale: 255 levels are 0.6 mm

/** A small seeded generator (mulberry32). */
export function makeRand(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

/** The polyline `pts` moved sideways by `d`, with mitred corners, so parallel traces stay parallel round bends. */
function offsetPath(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
    const n1 = norm(b[0] - a[0], b[1] - a[1]), n2 = norm(c[0] - b[0], c[1] - b[1]);
    const u = i === 0 ? n2 : n1, v = i === pts.length - 1 ? n1 : n2;
    const k = d / Math.max(0.35, 1 + u[0] * v[0] + u[1] * v[1]);
    out.push([b[0] + (u[0] + v[0]) * k, b[1] + (u[1] + v[1]) * k]);
  }
  return out;
}
function norm(dx, dy) { const l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; }

/**
 * Paints the board. Returns { map, normalMap, roughnessMap } (the last doubles as the metalness map), sized
 * for BOARD and laid so that u runs along its width and v up its height.
 */
export function paintBoard(renderer, seed = 1) {
  const rand = makeRand(seed);
  const W = Math.round(BOARD.w * 1000 * PX), H = Math.round(BOARD.h * 1000 * PX);
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const col = mk(), hgt = mk(), rm = mk();
  const C = col.getContext('2d'), Hc = hgt.getContext('2d'), R = rm.getContext('2d');
  // Work in millimetres with y up, as the board is described.
  for (const g of [C, Hc, R]) { g.setTransform(PX, 0, 0, -PX, 0, H); g.lineJoin = 'miter'; g.lineCap = 'butt'; }
  const grey = (v) => `rgb(${v},${v},${v})`;
  const rmc = (rough, metal = 0) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  const BW = BOARD.w * 1000, BH = BOARD.h * 1000;

  // --- Solder mask: matte black with a breath of blue; a satin 0.5 roughness ---
  C.fillStyle = '#0c0e11'; C.fillRect(0, 0, BW, BH);
  Hc.fillStyle = grey(96); Hc.fillRect(0, 0, BW, BH);
  R.fillStyle = rmc(0.5); R.fillRect(0, 0, BW, BH);

  // Copper pours: big flat areas of copper under the mask, a shade lighter and a hair proud.
  const pour = (x, y, w, h) => {
    C.fillStyle = '#10141a'; C.fillRect(x, y, w, h);
    Hc.fillStyle = grey(102); Hc.fillRect(x, y, w, h);
    R.fillStyle = rmc(0.44); R.fillRect(x, y, w, h);
  };
  for (let i = 0; i < 26; i++) pour(rand.range(4, BW - 60), rand.range(4, BH - 40), rand.range(14, 70), rand.range(8, 44));

  // --- Traces ---
  // A bundle is a route of 45-degree segments carrying k parallel traces. Under the mask copper is only a
  // shade lighter than the board; what shows it is its relief and its slightly glossier mask.
  const bundle = (pts, k, pitch = 0.36, width = 0.16) => {
    for (let i = 0; i < k; i++) {
      const p = offsetPath(pts, (i - (k - 1) / 2) * pitch);
      for (const [g, style] of [[C, '#161b22'], [Hc, grey(112)], [R, rmc(0.4)]]) {
        g.strokeStyle = style; g.lineWidth = width;
        g.beginPath(); p.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      }
      if (rand() < 0.5) via(p[p.length - 1][0], p[p.length - 1][1]);
      if (rand() < 0.3) via(p[0][0], p[0][1]);
    }
  };
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([x, y]) => { const l = Math.hypot(x, y); return [x / l, y / l]; });
  /** A route that wanders from (x, y) roughly toward heading `d` (0..7), turning 45 degrees at a time. */
  const route = (x, y, d, steps, lenLo, lenHi) => {
    const pts = [[x, y]];
    for (let i = 0; i < steps; i++) {
      const len = rand.range(lenLo, lenHi);
      x = Math.min(BW - 3, Math.max(3, x + DIRS[d][0] * len)); y = Math.min(BH - 3, Math.max(3, y + DIRS[d][1] * len));
      pts.push([x, y]);
      d = (d + rand.pick([-1, 1, 0, 1, -1]) + 8) % 8;
    }
    return pts;
  };
  const vias = [];
  const via = (x, y) => vias.push([x, y]);

  const cpu = BOARD.cpu, cx = cpu.x * 1000, cy = cpu.y * 1000;
  // The memory bus: wide, length-matched bundles from the socket's right side to the four DIMM slots.
  for (let i = 0; i < 9; i++) {
    const y0 = cy - 20 + i * 5;
    bundle([[cx + 24, y0], [cx + 32 + i * 1.2, y0], [cx + 40 + i * 1.2, y0 + (i - 4) * 3.2], [BOARD.ramX[0] * 1000 - 4, y0 + (i - 4) * 3.2]], 10, 0.3, 0.13);
  }
  // Serpentine length matching between the slots.
  for (let s = 0; s < 3; s++) {
    for (let j = 0; j < 14; j++) {
      const x0 = BOARD.ramX[s] * 1000 + 3.2, y0 = 104 + j * 9.6, pts = [];
      for (let m = 0; m <= 8; m++) pts.push([x0 + (m % 2) * 3.0, y0 + m * 0.9]);
      bundle(pts, 1, 0.3, 0.13);
    }
  }
  // PCIe lanes: from under the socket down to the slots, as paired differential traces.
  for (let i = 0; i < 16; i++) {
    const x0 = cx - 18 + i * 2.4;
    bundle([[x0, cy - 26], [x0, cy - 40 - i * 0.6], [x0 - 14 + i * 0.4, cy - 54 - i * 0.2], [x0 - 14 + i * 0.4, BOARD.pcieY[0] * 1000 + 6]], 2, 0.34, 0.14);
  }
  // Power: fat traces from the VRMs to the socket.
  for (let i = 0; i < 10; i++) bundle([[58, cy - 34 + i * 7.4], [cx - 26, cy - 34 + i * 7.4]], 1, 1, 2.4);
  for (let i = 0; i < 9; i++) bundle([[cx - 34 + i * 8.2, 216], [cx - 34 + i * 8.2, cy + 26]], 1, 1, 2.4);
  // Chipset fan-out and everything else: wandering bundles.
  const ch = BOARD.chipset;
  for (let i = 0; i < 46; i++) bundle(route(ch.x * 1000 + rand.range(-30, 30), ch.y * 1000 + rand.range(-30, 30), rand.int(0, 7), rand.int(2, 5), 6, 30), rand.int(2, 9));
  for (let i = 0; i < 150; i++) bundle(route(rand.range(6, BW - 6), rand.range(6, BH - 6), rand.int(0, 7), rand.int(2, 6), 4, 34), rand.int(1, 7));

  // --- Vias: a tinned ring round a drilled hole ---
  for (let i = 0; i < 1400; i++) via(rand.range(3, BW - 3), rand.range(3, BH - 3));
  for (const [x, y] of vias) {
    const r = 0.32;
    C.fillStyle = '#7d858c'; C.beginPath(); C.arc(x, y, r, 0, 7); C.fill();
    C.fillStyle = '#050607'; C.beginPath(); C.arc(x, y, r * 0.45, 0, 7); C.fill();
    Hc.fillStyle = grey(116); Hc.beginPath(); Hc.arc(x, y, r, 0, 7); Hc.fill();
    Hc.fillStyle = grey(70); Hc.beginPath(); Hc.arc(x, y, r * 0.45, 0, 7); Hc.fill();
    R.fillStyle = rmc(0.3, 1); R.beginPath(); R.arc(x, y, r, 0, 7); R.fill();
  }

  // --- Surface-mount parts too small to model: painted, with their height ---
  const tin = (x, y, w, h, lift = 150) => {
    C.fillStyle = '#9aa1a7'; C.fillRect(x, y, w, h);
    Hc.fillStyle = grey(lift); Hc.fillRect(x, y, w, h);
    R.fillStyle = rmc(0.28, 1); R.fillRect(x, y, w, h);
  };
  const body = (x, y, w, h, colour, lift = 200, rough = 0.6) => {
    C.fillStyle = colour; C.fillRect(x, y, w, h);
    Hc.fillStyle = grey(lift); Hc.fillRect(x, y, w, h);
    R.fillStyle = rmc(rough); R.fillRect(x, y, w, h);
  };
  /** A chip resistor or capacitor (0402 to 0805), lying along x or y. */
  const passive = (x, y, len, wid, vertical, colour) => {
    const [w, h] = vertical ? [wid, len] : [len, wid];
    tin(x - w / 2, y - h / 2, w, h, 190);
    if (vertical) body(x - w / 2, y - h * 0.26, w, h * 0.52, colour, 215);
    else body(x - w * 0.26, y - h / 2, w * 0.52, h, colour, 215);
  };
  const passiveRow = (x, y, n, vertical, step = 1.5) => {
    const big = rand() < 0.3, len = big ? 2.0 : 1.0, wid = big ? 1.25 : 0.5;
    const colour = rand() < 0.55 ? '#b08a5a' : '#17181a'; // ceramic capacitors are tan, resistors black
    for (let i = 0; i < n; i++) passive(x + (vertical ? i * step : 0), y + (vertical ? 0 : i * step), len, wid, vertical, colour);
  };
  for (let i = 0; i < 230; i++) passiveRow(rand.range(6, BW - 12), rand.range(6, BH - 12), rand.int(1, 8), rand() < 0.5, rand.range(1.2, 2.2));
  // Decoupling capacitors crowd the back of the socket and the DIMM slots.
  for (let i = 0; i < 60; i++) passiveRow(cx + rand.range(-34, 34), cy + rand.range(-34, 34), rand.int(2, 6), rand() < 0.5, 1.4);
  /** A small IC (SOIC / QFN): a black body, legs on two or four sides, laser marking. */
  const chip = (x, y, w, h, quad) => {
    const n = Math.max(3, Math.round(w / 0.65));
    for (let i = 0; i < n; i++) {
      const px = x - w / 2 + (i + 0.5) * w / n;
      tin(px - 0.15, y - h / 2 - 0.55, 0.3, 0.6, 160); tin(px - 0.15, y + h / 2 - 0.05, 0.3, 0.6, 160);
    }
    if (quad) {
      const m = Math.max(3, Math.round(h / 0.65));
      for (let i = 0; i < m; i++) {
        const py = y - h / 2 + (i + 0.5) * h / m;
        tin(x - w / 2 - 0.55, py - 0.15, 0.6, 0.3, 160); tin(x + w / 2 - 0.05, py - 0.15, 0.6, 0.3, 160);
      }
    }
    body(x - w / 2, y - h / 2, w, h, '#141516', 255, 0.55);
    C.fillStyle = '#5d6166'; C.beginPath(); C.arc(x - w / 2 + 0.5, y + h / 2 - 0.5, 0.18, 0, 7); C.fill();
    C.save(); C.translate(x, y); C.scale(1, -1); C.fillStyle = 'rgba(150,156,162,0.75)';
    C.font = `${Math.min(0.9, h * 0.22)}px ui-monospace, Menlo, monospace`; C.textAlign = 'center'; C.textBaseline = 'middle';
    C.fillText(rand.pick(['RT8894', 'ASM1074', 'NCT6798', 'ALC4080', 'IT8795', 'PI3EQX', 'TPS5143', 'UP9642']), 0, -h * 0.12);
    C.fillText(`${rand.int(2140, 2552)}`, 0, h * 0.18);
    C.restore();
  };
  for (let i = 0; i < 44; i++) { const q = rand() < 0.4, w = rand.range(3, 7); chip(rand.range(10, BW - 10), rand.range(10, BH - 10), w, q ? w : rand.range(2.5, 4.5), q); }

  // --- Mounting holes: a drilled hole in a ring of tinned ground vias ---
  for (const [hx, hy] of BOARD.holes) {
    const x = hx * 1000, y = hy * 1000;
    C.fillStyle = '#9aa1a7'; C.beginPath(); C.arc(x, y, 4.2, 0, 7); C.fill();
    Hc.fillStyle = grey(124); Hc.beginPath(); Hc.arc(x, y, 4.2, 0, 7); Hc.fill();
    R.fillStyle = rmc(0.32, 1); R.beginPath(); R.arc(x, y, 4.2, 0, 7); R.fill();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      C.fillStyle = '#0a0b0c'; C.beginPath(); C.arc(x + Math.cos(a) * 3.2, y + Math.sin(a) * 3.2, 0.3, 0, 7); C.fill();
    }
  }

  // --- Silkscreen: chalk-white ink, slightly proud ---
  const ink = '#cfd4d8';
  const silk = (fn) => {
    for (const [g, style] of [[C, ink], [Hc, grey(128)], [R, rmc(0.85)]]) { g.save(); g.fillStyle = style; g.strokeStyle = style; fn(g); g.restore(); }
  };
  const text = (str, x, y, size = 1.5, rot = 0, align = 'left', weight = 600) => silk((g) => {
    g.translate(x, y); g.rotate(rot); g.scale(1, -1);
    g.font = `${weight} ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`; g.textAlign = align; g.textBaseline = 'alphabetic';
    g.fillText(str, 0, 0);
  });
  const outline = (x, y, w, h, lw = 0.18) => silk((g) => { g.lineWidth = lw; g.strokeRect(x - w / 2, y - h / 2, w, h); });
  const mm = (o) => [o.x * 1000, o.y * 1000, o.w * 1000, o.h * 1000];

  // The styling every gaming board carries: long diagonal hairlines across the open areas, in a dim grey.
  for (const [g, style] of [[C, 'rgba(120,128,136,0.5)'], [R, rmc(0.8)]]) {
    g.save(); g.strokeStyle = style; g.lineWidth = 0.16;
    for (let i = 0; i < 46; i++) { const x = 150 + i * 2.6; g.beginPath(); g.moveTo(x, 4); g.lineTo(x + 92, 96); g.stroke(); }
    for (let i = 0; i < 22; i++) { const x = 205 + i * 2.6; g.beginPath(); g.moveTo(x, 232); g.lineTo(x + 40, 192); g.stroke(); }
    g.restore();
  }
  text('DIORAMA', 204, 213, 9.5, 0, 'left', 800);
  text('Z-SERIES  ·  ATX  ·  REV 1.02', 205, 207.5, 2.1);
  text('PCB-D790A', 262, 8, 1.8);
  text('MADE WITH LIGHT', 262, 5, 1.2);
  BOARD.ramX.forEach((x, i) => text(`DIMM_${'AABB'[i]}${[1, 2, 1, 2][i]}`, x * 1000 - 1.6, 96, 1.5, Math.PI / 2, 'right'));
  outline(cx, cy, 56, 56, 0.22); text('CPU_SOCKET', cx - 27, cy + 29.5, 1.5);
  text('CPU_FAN', cx + 20, 240.2, 1.4); text('CPU_OPT', cx + 36, 240.2, 1.4); text('AIO_PUMP', cx + 52, 240.2, 1.4);
  text('ATX_PWR', 283, 150, 1.4, Math.PI / 2); text('EPS_12V', 36, 242, 1.3, 0);
  BOARD.pcieY.forEach((y, i) => text(`PCIE_X${[16, 1, 16, 4][i]}_${i + 1}`, 126, y * 1000 - 0.6, 1.4));
  BOARD.m2.forEach((m, i) => { outline(...mm(m)); text(`M2_${i + 1}  (SOCKET 3)  2280`, m.x * 1000 - 44, m.y * 1000 - 14.5, 1.2); });
  text('SATA6G_1-4', 289, 100, 1.3, Math.PI / 2); text('BAT1  CR2032', 222, 99, 1.2);
  text('F_PANEL', 262, 12.5, 1.3); text('F_USB3', 224, 12.5, 1.3); text('F_AUDIO', 18, 3, 1.3); text('ARGB_1', 198, 3, 1.3); text('SYS_FAN1', 150, 3, 1.3);
  text('PWR', 268, 3.2, 1.1); text('RST', 276, 3.2, 1.1); text('CLR_CMOS', 244, 3.2, 1.1);
  // Reference designators beside random parts.
  for (let i = 0; i < 260; i++) text(`${rand.pick(['C', 'R', 'U', 'L', 'Q', 'D', 'FB'])}${rand.int(1, 980)}`, rand.range(6, BW - 12), rand.range(6, BH - 6), 0.85, rand() < 0.3 ? Math.PI / 2 : 0);
  // Pin-1 marks and polarity bars.
  for (let i = 0; i < 90; i++) silk((g) => { g.beginPath(); g.arc(rand.range(6, BW - 6), rand.range(6, BH - 6), 0.2, 0, 7); g.fill(); });

  // --- Textures ---
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: tex(col, true), normalMap: tex(normalFromHeight(hgt, MM_PER_LEVEL, 1 / PX), false), roughnessMap: tex(rm, false) };
}

/**
 * A tangent-space normal map from a height canvas. `mmPerLevel` is what one grey level is worth in height and
 * `mmPerPixel` the map's scale, so the slopes are the real ones. The height is softened by a pixel first: a
 * printed edge is not a cliff, and a one-pixel step would alias.
 */
export function normalFromHeight(height, mmPerLevel, mmPerPixel) {
  const w = height.width, h = height.height;
  const soft = document.createElement('canvas'); soft.width = w; soft.height = h;
  const sg = soft.getContext('2d', { willReadFrequently: true });
  sg.filter = 'blur(0.8px)'; sg.drawImage(height, 0, 0);
  const src = sg.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const og = out.getContext('2d'), img = og.createImageData(w, h), d = img.data;
  const k = mmPerLevel / (2 * mmPerPixel);
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - 1) * w, yd = Math.min(h - 1, y + 1) * w, row = y * w;
    for (let x = 0; x < w; x++) {
      const dx = (src[(row + Math.min(w - 1, x + 1)) * 4] - src[(row + Math.max(0, x - 1)) * 4]) * k;
      const dy = (src[(yu + x) * 4] - src[(yd + x) * 4]) * k; // canvas y runs down, the texture's v runs up
      const l = 1 / Math.hypot(dx, dy, 1), o = (row + x) * 4;
      d[o] = (-dx * l * 0.5 + 0.5) * 255; d[o + 1] = (-dy * l * 0.5 + 0.5) * 255; d[o + 2] = (l * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

/**
 * A printed label or a lit legend: lines of text on a canvas, as a texture.
 * @param lines [{ text, size (fraction of height), y (0 top..1 bottom), x?, align?, weight?, colour? }]
 * @param opts { w, h (pixels), bg (css colour or null for transparent), colour, draw?(g, w, h) }
 */
export function label(renderer, lines, { w = 1024, h = 256, bg = null, colour = '#e8ecef', draw = null } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  draw?.(g, w, h);
  for (const l of lines) {
    g.fillStyle = l.colour ?? colour;
    g.font = `${l.weight ?? 700} ${Math.round((l.size ?? 0.5) * h)}px ${l.font ?? '"Helvetica Neue", Helvetica, Arial, sans-serif'}`;
    g.textAlign = l.align ?? 'center'; g.textBaseline = 'middle';
    if (l.spacing) g.letterSpacing = `${l.spacing * h}px`;
    g.fillText(l.text, (l.x ?? 0.5) * w, (l.y ?? 0.5) * h);
    g.letterSpacing = '0px';
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
