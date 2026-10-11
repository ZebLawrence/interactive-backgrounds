// Fishbowl — Species data, the fish body loft and the painted fish images.

import * as THREE from 'three';
import { TAU, clamp, lerp, v3, RGBA, Art, Mesh } from './util.js';

// ---------------------------------------------------------------------------------------------
// Species data (Species.swift) — numbers ported verbatim
// ---------------------------------------------------------------------------------------------

/** One half of the body's side-view outline (the back or the belly) and the shape of that half of
 *  every cross-section. Heights are fractions of half the species' height; positions are fractions
 *  of body length from the tail joint (0) to the nose (1). */
export const BodyProfile = (o) => Object.assign({ depth: 1, peak: 0.5, peduncle: 0.36, head: 2, snout: 0.6, rear: 2, pinch: 0.4, roundness: 2 }, o);
BodyProfile.back = BodyProfile({ depth: 1, peak: 0.5, peduncle: 0.36, roundness: 1.7 });
BodyProfile.belly = BodyProfile({ depth: 1, peak: 0.45, peduncle: 0.34, roundness: 2.4 });

/** Height of this half of the outline at t along the body (0 = tail joint, 1 = nose). */
export function profileHeight(p, t) {
  t = clamp(t, 0, 1);
  if (t < p.peak) {
    // Rising from the peduncle: a smooth swell, or pinched flat just ahead of the tail.
    const u = t / p.peak;
    const swell = 1 - Math.pow(1 - u, p.rear), pinched = u * u * (3 - 2 * u);
    return p.peduncle + (p.depth - p.peduncle) * lerp(swell, pinched, p.pinch);
  }
  const v = (t - p.peak) / (1 - p.peak);
  return p.depth * Math.pow(Math.max(0, 1 - Math.pow(v, p.head)), p.snout);
}

export const Fin = (start, end, height, sweep) => ({ start, end, height, sweep });

export function makeSpecies(o) {
  return Object.assign({
    shape: 'fish', pectoralScale: 1, eyeScale: 1, flex: 1, roughness: null,
    backProfile: BodyProfile.back, bellyProfile: BodyProfile.belly,
  }, o);
}

export const Species = {};
Species.neonTetra = makeSpecies({
  id: 'tetra', name: 'Neon Tetra',
  length: 34, height: 11, thickness: 0.5, tailLength: 13, tailSpread: 6.5, tailStyle: 'forked',
  dorsal: Fin(0.36, 0.52, 5, 0.06), anal: Fin(0.22, 0.45, 4.5, 0.05),
  top: new RGBA(0.26, 0.30, 0.29), mid: new RGBA(0.60, 0.64, 0.64), belly: new RGBA(0.90, 0.92, 0.92),
  fin: new RGBA(0.85, 0.92, 0.97, 0.45), finEdge: null, eye: new RGBA(0.70, 0.85, 0.95),
  pattern: 'neon', cruise: 75, burst: 440, schooling: true, band: [0.25, 0.75], population: 11,
  // Slender torpedo: a fairly straight back over a slightly deeper belly.
  backProfile: BodyProfile({ depth: 0.88, peak: 0.55, peduncle: 0.34, head: 1.5, snout: 0.75, pinch: 0.5, roundness: 1.6 }),
  bellyProfile: BodyProfile({ depth: 1.05, peak: 0.45, peduncle: 0.32, head: 1.8, pinch: 0.6, roundness: 2.3 }),
});
Species.goldfish = makeSpecies({
  id: 'goldfish', name: 'Goldfish',
  length: 58, height: 35, thickness: 0.72, tailLength: 46, tailSpread: 30, tailStyle: 'flowing',
  dorsal: Fin(0.34, 0.72, 16, 0.14), anal: Fin(0.16, 0.32, 10, 0.08),
  top: new RGBA(0.93, 0.36, 0.02), mid: new RGBA(1.0, 0.54, 0.08), belly: new RGBA(1.0, 0.84, 0.48),
  fin: new RGBA(1.0, 0.56, 0.16, 0.78), finEdge: null, eye: new RGBA(0.95, 0.78, 0.40),
  pattern: 'metallic', cruise: 42, burst: 300, schooling: false, band: [0.2, 0.8], population: 3,
  // Short and deep, with a bulbous head and a round belly.
  backProfile: BodyProfile({ depth: 0.95, peak: 0.52, peduncle: 0.3, head: 2.4, snout: 0.55, rear: 2.6, pinch: 0.5, roundness: 1.8 }),
  bellyProfile: BodyProfile({ depth: 1.1, peak: 0.45, peduncle: 0.28, head: 2.2, rear: 2.8, pinch: 0.5, roundness: 2.7 }),
});
Species.angelfish = makeSpecies({
  id: 'angelfish', name: 'Angelfish',
  length: 44, height: 44, thickness: 0.26, tailLength: 30, tailSpread: 21, tailStyle: 'forked',
  dorsal: Fin(0.25, 0.70, 30, 0.22), anal: Fin(0.25, 0.66, 32, 0.2),
  top: new RGBA(0.62, 0.64, 0.60), mid: new RGBA(0.86, 0.87, 0.83), belly: new RGBA(0.96, 0.95, 0.90),
  fin: new RGBA(0.86, 0.90, 0.88, 0.5), finEdge: null, eye: new RGBA(0.85, 0.25, 0.15),
  pattern: 'angel', cruise: 32, burst: 260, schooling: false, band: [0.35, 0.85], population: 2,
  // A tall, flat disc with a small pointed snout.
  backProfile: BodyProfile({ depth: 1, peak: 0.45, peduncle: 0.22, head: 1.7, snout: 0.8, rear: 3, pinch: 0.35, roundness: 1.5 }),
  bellyProfile: BodyProfile({ depth: 1, peak: 0.45, peduncle: 0.22, head: 1.8, snout: 0.75, rear: 3, pinch: 0.35, roundness: 1.8 }),
});
Species.clownfish = makeSpecies({
  id: 'clownfish', name: 'Clownfish',
  length: 46, height: 24, thickness: 0.55, tailLength: 18, tailSpread: 12, tailStyle: 'fan',
  dorsal: Fin(0.30, 0.80, 10, 0.05), anal: Fin(0.20, 0.42, 9, 0.05),
  top: new RGBA(0.95, 0.36, 0.0), mid: new RGBA(1.0, 0.50, 0.05), belly: new RGBA(1.0, 0.62, 0.22),
  fin: new RGBA(1.0, 0.48, 0.05, 0.92), finEdge: new RGBA(0.05, 0.04, 0.04, 0.9), eye: new RGBA(0.95, 0.55, 0.10),
  pattern: 'clown', cruise: 48, burst: 330, schooling: false, band: [0.05, 0.4], population: 2,
  // A chunky oval with a thick tail stock.
  backProfile: BodyProfile({ depth: 0.97, peak: 0.52, peduncle: 0.36, head: 2.1, pinch: 0.45, roundness: 1.9 }),
  bellyProfile: BodyProfile({ depth: 0.98, peak: 0.5, peduncle: 0.34, pinch: 0.45, roundness: 2.5 }),
});
Species.betta = makeSpecies({
  id: 'betta', name: 'Betta',
  length: 40, height: 16, thickness: 0.5, tailLength: 52, tailSpread: 36, tailStyle: 'flowing',
  dorsal: Fin(0.18, 0.50, 22, 0.38), anal: Fin(0.06, 0.62, 26, 0.32),
  top: new RGBA(0.10, 0.13, 0.52), mid: new RGBA(0.18, 0.30, 0.82), belly: new RGBA(0.34, 0.40, 0.86),
  fin: new RGBA(0.56, 0.16, 0.74, 0.78), finEdge: null, eye: new RGBA(0.30, 0.35, 0.60),
  pattern: 'metallic', cruise: 28, burst: 240, schooling: false, band: [0.5, 0.9], population: 1,
  // Slim and elongated, with a deep tail stock to carry its long fins.
  backProfile: BodyProfile({ depth: 0.88, peak: 0.5, peduncle: 0.42, head: 1.6, snout: 0.65, pinch: 0.3, roundness: 1.8 }),
  bellyProfile: BodyProfile({ depth: 1.05, peak: 0.45, peduncle: 0.4, head: 1.8, pinch: 0.3, roundness: 2.3 }),
});
/** The optional predator: not part of the regular population (see `Shark`). */
Species.shark = makeSpecies({
  id: 'shark', name: 'Shark',
  // Great white proportions: a heavy spindle about four times as long as it is deep, a tall
  // crescent tail, a big triangular first dorsal and long, swept-back pectoral fins.
  length: 440, height: 140, thickness: 0.92, tailLength: 115, tailSpread: 112, tailStyle: 'shark',
  dorsal: Fin(0.43, 0.62, 96, 0.1), anal: Fin(0.09, 0.14, 14, 0.04),
  top: new RGBA(0.20, 0.24, 0.29), mid: new RGBA(0.40, 0.45, 0.50), belly: new RGBA(0.50, 0.54, 0.58),
  fin: new RGBA(0.34, 0.38, 0.43, 0.97), finEdge: null, eye: new RGBA(0.04, 0.04, 0.05),
  pattern: 'shark', cruise: 30, burst: 540, schooling: false, band: [0.3, 0.7], population: 0,
  shape: 'shark', pectoralScale: 1.05, eyeScale: 0.26, flex: 2.5, roughness: 0.85,
  // The belly must stay elliptical (roundness 2) for `SharkJaw` to fit.
  backProfile: BodyProfile({ depth: 1.0, peak: 0.58, peduncle: 0.13, head: 1.35, snout: 0.88, rear: 1.7, pinch: 0.3, roundness: 1.85 }),
  bellyProfile: BodyProfile({ depth: 0.94, peak: 0.55, peduncle: 0.11, head: 1.7, snout: 0.72, rear: 1.9, pinch: 0.3, roundness: 2 }),
});
Species.all = [Species.neonTetra, Species.goldfish, Species.angelfish, Species.clownfish, Species.betta];
Species.named = (id) => Species.all.find((s) => s.id === id);

// ---------------------------------------------------------------------------------------------
// The 3D body (FishBody.swift): a loft of cross-sections along the side-view outline, with the
// painted skin wrapped round it
// ---------------------------------------------------------------------------------------------

export const FishBody = {
  /** Vertices round each cross-section (a multiple of 4). */
  ring: 28,
  arcSteps: 4,

  /** Cross-section at x (species points): back height, belly depth and half-width. */
  section(s, x) {
    const t = clamp((x + s.length / 2) / s.length, 0, 1);
    const b = s.height / 2;
    const top = profileHeight(s.backProfile, t) * b, bottom = profileHeight(s.bellyProfile, t) * b;
    // Thin toward the tail (the peduncle is flattened side to side), rounder through the head.
    const taper = 0.45 + 0.55 * Math.min(1, t / 0.4);
    return { top, bottom, halfWidth: (top + bottom) / 2 * s.thickness * taper };
  },

  /** The point (y, z) on a cross-section at `angle` round it: 0 is the dorsal midline, π/2 the
   *  middle of the +z flank, π the ventral midline. Each half is a superellipse. */
  ringPoint(c, s, th) {
    const up = Math.cos(th), side = Math.sin(th);
    const e = 2 / (up >= 0 ? s.backProfile.roundness : s.bellyProfile.roundness);
    const y = Math.pow(Math.abs(up), e) * (up >= 0 ? c.top : -c.bottom);
    const z = Math.pow(Math.abs(side), e) * c.halfWidth * (side >= 0 ? 1 : -1);
    return [y, z];
  },

  /** Distance over the skin from the dorsal midline to evenly spaced angles down one flank. */
  arcs(c, s) {
    const n = FishBody.ring / 2 * FishBody.arcSteps;
    const out = [0];
    let prev = FishBody.ringPoint(c, s, 0);
    for (let k = 1; k <= n; k++) {
      const p = FishBody.ringPoint(c, s, k / n * Math.PI);
      out.push(out[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
      prev = p;
    }
    return out;
  },

  /** How much of the skin image the body wraps at x: up to the back, down to the belly. */
  girth(s, x) {
    const arcs = FishBody.arcs(FishBody.section(s, x), s);
    const equator = arcs[arcs.length >> 1];
    return { up: equator, down: arcs[arcs.length - 1] - equator };
  },

  /** The body mesh in species points, UV-mapped to the skin image. */
  mesh(s, art) {
    const count = 36, ring = FishBody.ring;
    const a = s.length / 2;
    const rect = art.skinRect;
    const uv = (x, arc) => [(x - rect.x) / rect.w, 1 - (arc - rect.y) / rect.h];
    const m = new Mesh();
    for (let i = 0; i <= count; i++) {
      // Denser toward both ends, where the outline curves fastest.
      const t = i / count;
      const f = 0.5 * t + 0.25 * (1 - Math.cos(Math.PI * t));
      const x = -a + 2 * a * f;
      const section = FishBody.section(s, x);
      const arcs = FishBody.arcs(section, s);
      const equator = arcs[arcs.length >> 1];
      for (let j = 0; j < ring; j++) {
        const th = j / ring * TAU;
        const p = FishBody.ringPoint(section, s, th);
        m.p.push(x, p[0], p[1]);
        // Both flanks share the image, mirrored, so it meets itself along the midlines.
        const k = (j <= ring / 2 ? j : ring - j) * FishBody.arcSteps;
        m.addUV(uv(x, equator - arcs[k]));
      }
    }
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < ring; j++) {
        const q = i * ring + j, b = i * ring + (j + 1) % ring;
        m.quad(q, b, q + ring, b + ring);
      }
    }
    // Round off the tail end with a short cone, tucked into the root of the tail fin.
    const end = FishBody.section(s, -a);
    const tip = v3(-a - (end.top + end.bottom) * 0.25, (end.top - end.bottom) / 2, 0);
    const center = m.count;
    m.addPos(tip);
    m.addUV(uv(tip.x, tip.y));
    for (let j = 0; j < ring; j++) m.triangle(center, (j + 1) % ring, j);
    return m;
  },
};

// ---------------------------------------------------------------------------------------------
// Painted fish images (FishArt.swift), in "fish space": points, body centred on the origin,
// nose toward +x
// ---------------------------------------------------------------------------------------------

export const FishArt = {
  cache: {},
  forSpecies(s) {
    return FishArt.cache[s.id] ??= FishArt.make(s);
  },

  make(s) {
    const [skin, skinRect] = FishArt.makeSkin(s);
    const [fins, finsRect] = FishArt.makeFins(s);
    const [tail, tailRect] = FishArt.makeTail(s);
    const [pectoral, pectoralSize] = FishArt.makePectoral(s);
    return { skin, skinRect, fins, finsRect, tail, tailRect, pectoral, pectoralSize };
  },

  outline(s, x) {
    const c = FishBody.section(s, x);
    return { top: c.top, bottom: c.bottom };
  },

  extent(s) {
    let top = 0, bottom = 0;
    for (let i = 0; i <= 64; i++) {
      const o = FishArt.outline(s, s.length * (i / 64 - 0.5));
      top = Math.max(top, o.top);
      bottom = Math.max(bottom, o.bottom);
    }
    return { top, bottom };
  },

  /** A dorsal (`top`) or anal fin. Its base runs inside the body along the back or belly line. */
  finPath(f, s, top) {
    const a = s.length / 2, L = s.length;
    const sign = top ? 1 : -1;
    const edge = (x) => { const o = FishArt.outline(s, x); return top ? o.top : o.bottom; };
    const back = -a + f.start * L, front = -a + f.end * L;
    const tip = [back + (front - back) * 0.15 - f.sweep * L, edge(back + (front - back) * 0.4) + f.height];
    const rear = edge(back);
    const path = new Path2D();
    path.moveTo(front, edge(front) * 0.5 * sign);
    path.quadraticCurveTo(front - 0.15 * (front - back), tip[1] * sign, tip[0], tip[1] * sign);
    path.quadraticCurveTo(tip[0] + (back - tip[0]) * 0.7, (rear + (tip[1] - rear) * 0.35) * sign, back, rear * 0.5 * sign);
    for (let i = 1; i <= 8; i++) {
      const x = back + (front - back) * i / 8;
      path.lineTo(x, edge(x) * 0.5 * sign);
    }
    path.closePath();
    return path;
  },

  paintFin(ctx, path, s, from, to) {
    if (s.shape === 'shark') {
      // Solid, like the body, painted a little lighter than the back to read as the same slate grey.
      ctx.save();
      ctx.clip(path);
      Art.linear(ctx, [s.top.mix(s.mid, 0.45), s.top.mix(s.mid, 0.6)], null, from, to);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.clip(path);
    Art.linear(ctx, [s.fin, s.fin.lighter(0.25).alpha(s.fin.a * 0.55)], null, from, to);
    // Fin rays.
    ctx.strokeStyle = s.fin.darker(0.35).alpha(0.3).css;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      ctx.moveTo(lerp(from[0] - s.length * 0.4, from[0] + s.length * 0.4, t), from[1]);
      ctx.lineTo(lerp(to[0] - s.length * 0.6, to[0] + s.length * 0.2, t), to[1]);
    }
    ctx.stroke();
    ctx.restore();
    if (s.finEdge) {
      ctx.strokeStyle = s.finEdge.css;
      ctx.lineWidth = 1.4;
      ctx.stroke(path);
    }
  },

  /** The skin, unwrapped: x runs along the body as in the side view, y is the distance over the
   *  skin from the flank's centre line. */
  makeSkin(s) {
    const a = s.length / 2, L = s.length;
    const columns = Math.ceil((L + 4) * Art.scale);
    const girths = [];
    for (let i = 0; i < columns; i++) girths.push(FishBody.girth(s, -a - 2 + (i + 0.5) / Art.scale));
    const up = Math.max(...girths.map((g) => g.up)), down = Math.max(...girths.map((g) => g.down));
    const rect = { x: -a - 2, y: -down - 2, w: L + 4, h: up + down + 4 };
    const maxY = rect.y + rect.h;
    const img = Art.image(rect.w, rect.h, Art.scale, (ctx) => {
      ctx.translate(-rect.x, -rect.y);
      // Countershading, a pixel column at a time so it follows the body: darkest along the back,
      // palest along the belly. Real lighting adds the shape on top.
      const dorsal = s.top.darker(0.3), ventral = s.belly.lighter(0.2);
      girths.forEach((g, i) => {
        const x = rect.x + i / Art.scale, w = 1 / Art.scale;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, 0, w, maxY); ctx.clip();
        Art.linear(ctx, [dorsal, s.top, s.mid], [0, 0.25, 1], [x, g.up], [x, 0]);
        ctx.restore();
        ctx.save();
        ctx.beginPath(); ctx.rect(x, rect.y, w, -rect.y); ctx.clip();
        Art.linear(ctx, [s.mid, s.belly, ventral], [0, 0.8, 1], [x, 0], [x, -g.down]);
        ctx.restore();
      });
      FishArt.paintPattern(ctx, s, rect);
      // Gill cover (sharks have gill slits instead, drawn with their pattern).
      if (s.shape !== 'shark') {
        const gx = a - 0.3 * L, o = FishArt.outline(s, gx);
        ctx.strokeStyle = s.top.darker(0.4).alpha(0.35).css;
        ctx.lineWidth = Math.max(0.6, L * 0.015);
        ctx.beginPath();
        ctx.moveTo(gx, o.top * 0.7);
        ctx.quadraticCurveTo(gx + L * 0.09, 0, gx, -o.bottom * 0.65);
        ctx.stroke();
      }
      // Mouth.
      const b = s.height / 2;
      ctx.strokeStyle = new RGBA(0, 0, 0, 0.4).css;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(a, -b * 0.08);
      ctx.lineTo(a - L * 0.07, -b * 0.16);
      ctx.stroke();
    });
    return [img, rect];
  },

  makeFins(s) {
    const L = s.length, a = L / 2;
    const { top: up, bottom: down } = FishArt.extent(s);
    const sweep = Math.max(s.dorsal.sweep, s.anal.sweep);
    const finH = Math.max(s.dorsal.height, s.anal.height);
    const rect = { x: -a - L * sweep - 4, y: -(down + finH + 4), w: L * (1 + sweep) + 8, h: up + down + 2 * (finH + 4) };
    const img = Art.image(rect.w, rect.h, Art.scale, (ctx) => {
      ctx.translate(-rect.x, -rect.y);
      FishArt.paintFin(ctx, FishArt.finPath(s.dorsal, s, true), s, [0, up * 0.5], [0, up + s.dorsal.height]);
      FishArt.paintFin(ctx, FishArt.finPath(s.anal, s, false), s, [0, -down * 0.5], [0, -down - s.anal.height]);
      if (s.shape === 'shark') {
        // The small second dorsal fin, just ahead of the tail.
        const second = Fin(0.07, 0.12, 16, 0.03);
        FishArt.paintFin(ctx, FishArt.finPath(second, s, true), s, [0, up * 0.2], [0, up * 0.2 + second.height]);
      }
    });
    return [img, rect];
  },

  /** `rect` is the whole skin image; patterns that wrap round the body span all of it. */
  paintPattern(ctx, s, rect) {
    const L = s.length, a = L / 2, b = s.height / 2;
    const maxY = rect.y + rect.h;
    switch (s.pattern) {
      case 'neon': {
        // Red lower rear half.
        ctx.save();
        ctx.beginPath(); ctx.rect(-a, rect.y, 0.62 * L, -rect.y - b * 0.05); ctx.clip();
        const red = new RGBA(0.95, 0.08, 0.14, 0.95);
        Art.linear(ctx, [red, red, red.alpha(0)], [0, 0.7, 1], [-a, 0], [-a + 0.62 * L, 0]);
        ctx.restore();
        // Glowing blue stripe.
        const st = { x: -a + 0.1 * L, y: b * 0.02, w: 0.76 * L, h: b * 0.36 };
        const r = st.h / 2;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(st.x + r, st.y);
        ctx.lineTo(st.x + st.w - r, st.y);
        ctx.arc(st.x + st.w - r, st.y + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(st.x + r, st.y + st.h);
        ctx.arc(st.x + r, st.y + r, r, Math.PI / 2, Math.PI * 1.5);
        ctx.closePath();
        ctx.clip();
        Art.linear(ctx, [new RGBA(0.1, 0.5, 1.0), new RGBA(0.35, 0.98, 1.0), new RGBA(0.15, 0.65, 1.0)], null, [st.x, 0], [st.x + st.w, 0]);
        ctx.restore();
        break;
      }
      case 'metallic':
        // Scales come from the body's normal map (see `Detail.scales`).
        break;
      case 'shark': {
        // Crisp white underside along the lower flank, with a softly feathered, slightly wavy edge.
        const belly = new Path2D();
        belly.moveTo(-a - 4, rect.y - 1);
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const x = -a - 4 + (L + 8) * t;
          // The line rises toward the head, like a real shark's countershading.
          belly.lineTo(x, -b * 0.22 + b * 0.2 * t + b * 0.05 * Math.sin(t * 19));
        }
        belly.lineTo(a + 4, rect.y - 1);
        belly.closePath();
        ctx.save();
        const white = new RGBA(0.95, 0.95, 0.93).css;
        ctx.shadowBlur = b * 0.12;
        ctx.shadowColor = white;
        ctx.fillStyle = white;
        ctx.fill(belly);
        ctx.restore();
        // Five long gill slits ahead of the pectoral fins, curving back at the bottom.
        ctx.strokeStyle = s.top.darker(0.55).alpha(0.6).css;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const x = a - 0.2 * L - k * 0.024 * L;
          const reach = 1 + k * 0.05;
          ctx.moveTo(x + 0.004 * L, b * 0.42 * reach);
          ctx.quadraticCurveTo(x + 0.016 * L, 0, x - 0.016 * L, -b * 0.38 * reach);
        }
        ctx.stroke();
        break;
      }
      case 'angel':
        for (const [c, w] of [[0.84, 0.05], [0.58, 0.07], [0.30, 0.06]]) {
          const x = -a + c * L;
          ctx.fillStyle = new RGBA(0.08, 0.08, 0.08, 0.72).css;
          ctx.fillRect(x - w * L / 2, rect.y, w * L, rect.h);
        }
        break;
      case 'clown': {
        // The bands wrap right over the back and under the belly.
        const reach = Math.max(maxY, -rect.y) + 1;
        for (const [c, w] of [[0.08, 0.07], [0.47, 0.13], [0.78, 0.11]]) {
          const x = -a + c * L;
          const half = w * L / 2, bow = w * L * 0.7;
          const band = new Path2D();
          band.moveTo(x - half, -reach);
          band.quadraticCurveTo(x - half + bow, 0, x - half, reach);
          band.lineTo(x + half, reach);
          band.quadraticCurveTo(x + half + bow, 0, x + half, -reach);
          band.closePath();
          ctx.strokeStyle = new RGBA(0.05, 0.04, 0.04).css;
          ctx.lineWidth = 2.2;
          ctx.stroke(band);
          ctx.fillStyle = new RGBA(0.98, 0.98, 0.96).css;
          ctx.fill(band);
        }
        break;
      }
    }
  },

  makeTail(s) {
    const T = s.tailLength, S = s.tailSpread;
    // The root is a little deeper than the peduncle it grows from.
    const root = FishArt.outline(s, -s.length / 2);
    const p = root.top * 1.25, q = root.bottom * 1.25;
    const overlap = 4;
    const size = { w: T * 1.1 + overlap + 4, h: 2 * S * 1.15 + 6 };
    const origin = [size.w - overlap - 1, size.h / 2];

    const path = new Path2D();
    switch (s.tailStyle) {
      case 'forked':
        path.moveTo(overlap, p);
        path.quadraticCurveTo(-T * 0.45, p + S * 0.25, -T, S);
        path.quadraticCurveTo(-T * 0.72, S * 0.3, -T * 0.55, 0);
        path.quadraticCurveTo(-T * 0.72, -S * 0.3, -T, -S);
        path.quadraticCurveTo(-T * 0.45, -q - S * 0.25, overlap, -q);
        break;
      case 'fan':
        path.moveTo(overlap, p);
        path.quadraticCurveTo(-T * 0.4, S * 0.85, -T * 0.8, S);
        path.bezierCurveTo(-T * 1.1, S * 0.6, -T * 1.1, -S * 0.6, -T * 0.8, -S);
        path.quadraticCurveTo(-T * 0.4, -S * 0.85, overlap, -q);
        break;
      case 'shark':
        // A great white's crescent (lunate) tail.
        path.moveTo(overlap, p);
        path.quadraticCurveTo(-T * 0.3, p + S * 0.55, -T, S);
        path.quadraticCurveTo(-T * 0.5, S * 0.3, -T * 0.42, 0);
        path.quadraticCurveTo(-T * 0.5, -S * 0.28, -T * 0.9, -S * 0.85);
        path.quadraticCurveTo(-T * 0.28, -q - S * 0.45, overlap, -q);
        break;
      case 'flowing': {
        path.moveTo(overlap, p);
        path.bezierCurveTo(-T * 0.3, S * 1.1, -T * 0.7, S * 1.12, -T * 0.95, S * 0.9);
        // Scalloped trailing edge.
        const n = 5;
        for (let i = 1; i <= n; i++) {
          const y = S * 0.9 - i * (1.9 * S / n);
          const prevY = y + 1.9 * S / n;
          path.quadraticCurveTo(-T * 1.08, (y + prevY) / 2, -T * (i % 2 === 0 ? 1.0 : 0.9), y);
        }
        path.bezierCurveTo(-T * 0.7, -S * 1.15, -T * 0.3, -S * 1.0, overlap, -q);
        break;
      }
    }
    path.closePath();

    const img = Art.image(size.w, size.h, Art.scale, (ctx) => {
      ctx.translate(origin[0], origin[1]);
      ctx.save();
      ctx.clip(path);
      if (s.shape === 'shark') {
        Art.linear(ctx, [s.top.mix(s.mid, 0.45), s.top.mix(s.mid, 0.6)], null, [0, 0], [-T, 0]);
        ctx.restore();
        return;
      }
      const tipAlpha = s.tailStyle === 'flowing' ? 0.4 : 0.6;
      Art.linear(ctx, [s.fin.darker(0.08), s.fin.lighter(0.2).alpha(s.fin.a * tipAlpha)], null, [0, 0], [-T, 0]);
      ctx.strokeStyle = s.fin.darker(0.35).alpha(0.3).css;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      for (let k = -6; k <= 6; k++) {
        const f = k / 6;
        ctx.moveTo(overlap, f * (f > 0 ? p : q) * 0.8);
        ctx.quadraticCurveTo(-T * 0.5, f * S * 0.55, -T * 1.05, f * S * 1.05);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = (s.finEdge ?? new RGBA(1, 1, 1, 0.18)).css;
      ctx.lineWidth = s.finEdge ? 1.4 : 0.6;
      ctx.stroke(path);
    });
    // Place the image so its attach point sits just inside the back of the body.
    const attachX = -s.length / 2 + 1;
    return [img, { x: attachX - origin[0], y: -origin[1], w: size.w, h: size.h }];
  },

  makePectoral(s) {
    const size = { w: Math.max(6, s.length * 0.26 * s.pectoralScale), h: Math.max(4, s.length * 0.16 * s.pectoralScale) };
    const img = Art.image(size.w, size.h, Art.scale, (ctx) => {
      const w = size.w, h = size.h;
      const path = new Path2D();
      if (s.shape === 'shark') {
        // Long and sickle-shaped: broad root (right), convex leading edge, pointed tip.
        path.moveTo(w, h * 0.95);
        path.quadraticCurveTo(w * 0.35, h * 0.92, 1, h * 0.04);
        path.quadraticCurveTo(w * 0.6, h * 0.42, w, h * 0.18);
        path.closePath();
      } else {
        path.moveTo(w, h / 2);
        path.quadraticCurveTo(w * 0.4, h, 1, h * 0.35);
        path.quadraticCurveTo(w * 0.35, 0, w, h / 2);
      }
      ctx.clip(path);
      if (s.shape === 'shark') {
        Art.linear(ctx, [s.top, s.mid], null, [0, h], [0, 0]);
        return;
      }
      Art.linear(ctx, [s.fin.lighter(0.1), s.fin.lighter(0.3).alpha(s.fin.a * 0.4)], null, [w, 0], [0, 0]);
    });
    return [img, size];
  },
};
