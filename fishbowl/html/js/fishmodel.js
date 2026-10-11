// Fishbowl — Per-species fish models: fins, eyes, the shark jaw and body materials.

import * as THREE from 'three';
import { TAU, clamp, rnd, randInt, coin, v3, quatAxis, quatFromTo, RGBA, Art, Detail, Mesh, mat4Translate, mat4Rotate, sharedGeometry } from './util.js';
import { G, patchMaterial, patchedDepthMaterial, MAP_UNPREMULTIPLY, causticUniforms, FISH_BODY_HEAD, FISH_FINS_HEAD, FIN_GLOW_HEAD, FIN_GLOW, FISH_SKIN_HEAD, FISH_SKIN } from './shaders.js';
import { Species, FishBody, FishArt } from './species.js';

// ---------------------------------------------------------------------------------------------
// Fins (FishFins.swift): dorsal, anal, tail, pectoral and pelvic pairs (plus the tetra's adipose
// fin) share one mesh and one atlas texture. Each vertex carries its fin kind and its distance
// from where the fin joins the body, so the fin shader can move every fin on its own.
// ---------------------------------------------------------------------------------------------

export const FinKind = { rigid: 0, median: 1, tail: 2, pectoral: 3, pelvic: 4 };

export const FishFins = {
  build(s, art, u) {
    const shark = s.shape === 'shark';
    const flow = FishFins.flowiness(s);
    const L = s.length, a = L / 2;
    const pelvic = FishFins.pelvicImage(s);
    const adipose = s.id === Species.neonTetra.id ? FishFins.adiposeImage(s) : null;
    const [atlas, uv] = FishFins.pack([art.fins, art.tail, art.pectoral, pelvic.image, ...(adipose ? [adipose] : [])]);
    const m = new Mesh();
    const data = FishFins.data;

    // Dorsal and anal fins: the painted sheet through the middle of the body, split at the centre
    // line so each half follows the body's back or belly.
    const fr = art.finsRect;
    for (const top of [true, false]) {
      const half = { x: fr.x, y: top ? 0 : fr.y, w: fr.w, h: top ? fr.y + fr.h : -fr.y };
      const sheet = FishFins.grid(half, fr, uv[0], 18, 8);
      for (let i = 0; i < sheet.count; i++) {
        const p = sheet.pos(i);
        const section = FishBody.section(s, p.x);
        const outline = FishArt.outline(s, p.x);
        const artEdge = top ? outline.top : outline.bottom;
        const shift = top ? section.top - artEdge : artEdge - section.bottom;
        sheet.p[i * 3 + 1] += shift;
        const span = Math.max(0, Math.abs(p.y) - artEdge * 0.95) * u;
        const along = (p.x - fr.x) / fr.w;
        sheet.c.push(...data(shark ? FinKind.rigid : FinKind.median, flow, span, along, fr.w * u));
      }
      m.append(sheet.scaled(u));
    }

    // Tail (the art already fits its root to the tail joint's back and belly heights).
    const tr = art.tailRect;
    const attachX = -a + 1;
    const tail = FishFins.grid(tr, tr, uv[1], 12, 8);
    const spread = Math.max(tr.y + tr.h, -tr.y);
    for (let i = 0; i < tail.count; i++) {
      const p = tail.pos(i);
      const span = clamp((attachX - p.x) / s.tailLength, 0, 1);
      tail.c.push(...data(shark ? FinKind.rigid : FinKind.tail, flow, span, p.y / spread, s.tailLength * u));
    }
    m.append(tail.scaled(u));

    // Pectoral fins: splayed out from the flank and angled down, low on the side of the head.
    const px = L * 0.12;
    const pSec = FishBody.section(s, px);
    const pMid = (pSec.top - pSec.bottom) / 2, pHalf = (pSec.top + pSec.bottom) / 2;
    // A shark's are stiff wings: laid nearly flat, swept back, low on the flank.
    m.append(FishFins.pair(art.pectoralSize, uv[2], shark ? FinKind.rigid : FinKind.pectoral, 0,
      v3(px, pMid - pHalf * (shark ? 0.5 : 0.24), pSec.halfWidth * (shark ? 0.8 : 0.9)),
      shark ? 1.15 : 0.55, shark ? 0.4 : 0.35, shark ? 1.35 : 0, u));

    // Pelvic fins, on the belly.
    const vx = a - pelvic.fromNose * L;
    const vSec = FishBody.section(s, vx);
    m.append(FishFins.pair(pelvic.size, uv[3], shark ? FinKind.rigid : FinKind.pelvic, pelvic.flow,
      v3(vx, -vSec.bottom * 0.88, vSec.halfWidth * 0.42), pelvic.splay, pelvic.droop, 0, u));

    // The neon tetra's adipose fin: a little fleshy lobe on the back, behind the dorsal fin.
    if (adipose) {
      const w = adipose.width / Art.scale, h = adipose.height / Art.scale;
      const x = -a + 0.15 * L;
      const base = FishBody.section(s, x).top - h * 0.3;
      const r = { x: x - w / 2, y: base, w, h };
      const lobe = FishFins.grid(r, r, uv[4], 3, 2);
      for (let i = 0; i < lobe.count; i++) {
        const p = lobe.pos(i);
        lobe.c.push(...data(FinKind.median, 0.3, Math.max(0, p.y - base - h * 0.3) * u, (p.x - r.x) / w, w * u));
      }
      m.append(lobe.scaled(u));
    }

    const texture = Art.texture(atlas, { premultiplied: true });
    return { geometry: m.geometry('aFin'), texture, solid: shark };
  },

  /** How loosely a species' fins flow (0 = stiff ... 1 = long and billowing, like a betta's). */
  flowiness(s) {
    if (s.shape === 'shark') return 0;
    const finHeight = Math.max(s.dorsal.height, s.anal.height) / s.length;
    const tail = s.tailStyle === 'flowing' ? s.tailLength / s.length : 0;
    return Math.min(1, 0.1 + finHeight * 0.55 + tail * 0.7);
  },

  /** Pelvic fins: where they sit (fraction of body length behind the nose), how they hang, and
   *  how they look. Angelfish trail long threads; a betta's hang like ribbons. */
  pelvicImage(s) {
    const L = s.length;
    if (s.id === Species.angelfish.id) {
      const size = { w: L * 1.05, h: 3.2 };
      const image = Art.image(size.w, size.h, Art.scale, (ctx) => {
        const path = new Path2D();
        path.moveTo(size.w, 0.2);
        path.quadraticCurveTo(size.w * 0.4, 0.6, 0, 1.3);
        path.quadraticCurveTo(size.w * 0.4, 2.2, size.w, 3.0);
        path.closePath();
        ctx.clip(path);
        // Pale threads with a dark band near the root, like the body's stripes.
        Art.linear(ctx, [new RGBA(0.1, 0.1, 0.1, 0.8), new RGBA(0.1, 0.1, 0.1, 0.8), s.fin.lighter(0.3).alpha(0.7),
          s.fin.lighter(0.5).alpha(0.35)], [0, 0.12, 0.2, 1], [size.w, 0], [0, 0]);
      });
      return { image, size, fromNose: 0.34, splay: 0.12, droop: 1.0, flow: 0.9 };
    }
    if (s.id === Species.betta.id) {
      const size = { w: L * 0.62, h: L * 0.15 };
      const image = Art.image(size.w, size.h, Art.scale, (ctx) => {
        const w = size.w, h = size.h;
        const path = new Path2D();
        path.moveTo(w, h * 0.25);
        path.quadraticCurveTo(w * 0.35, -h * 0.1, 0, h * 0.3);
        path.quadraticCurveTo(w * 0.45, h * 1.1, w, h * 0.8);
        path.closePath();
        FishFins.paint(ctx, path, s, size);
      });
      return { image, size, fromNose: 0.32, splay: 0.2, droop: 0.95, flow: 1 };
    }
    const shark = s.shape === 'shark';
    const size = { w: Math.max(5, L * (shark ? 0.13 : 0.17)), h: Math.max(3, L * (shark ? 0.08 : 0.075)) };
    const image = Art.image(size.w, size.h, Art.scale, (ctx) => {
      const w = size.w, h = size.h;
      const path = new Path2D();
      path.moveTo(w, h * 0.15);
      path.quadraticCurveTo(w * 0.45, 0, 1, h * 0.3);
      path.quadraticCurveTo(w * 0.4, h, w, h * 0.9);
      path.closePath();
      FishFins.paint(ctx, path, s, size);
    });
    const fromNose = shark ? 0.64 : (s.id === Species.clownfish.id ? 0.38 : 0.5);
    return { image, size, fromNose, splay: shark ? 0.6 : 0.3, droop: shark ? 0.45 : 0.6, flow: 0.15 };
  },

  adiposeImage(s) {
    const w = s.length * 0.12, h = s.height * 0.3;
    return Art.image(w, h, Art.scale, (ctx) => {
      const path = new Path2D();
      path.moveTo(w, 0);
      path.quadraticCurveTo(w * 0.8, h * 1.05, w * 0.25, h * 0.9);
      path.quadraticCurveTo(0, h * 0.6, 0, 0);
      path.closePath();
      ctx.clip(path);
      Art.linear(ctx, [s.fin.alpha(0.7), s.fin.lighter(0.3).alpha(0.4)], null, [0, 0], [0, h]);
    });
  },

  /** Fill a paired fin shape: solid like the body for the shark, else translucent with rays. */
  paint(ctx, path, s, size) {
    ctx.clip(path);
    const w = size.w, h = size.h;
    if (s.shape === 'shark') {
      Art.linear(ctx, [s.top, s.mid], null, [0, h], [0, 0]);
      return;
    }
    Art.linear(ctx, [s.fin.lighter(0.05), s.fin.lighter(0.3).alpha(s.fin.a * 0.45)], null, [w, 0], [0, 0]);
    ctx.strokeStyle = s.fin.darker(0.35).alpha(0.3).css;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    for (let k = 0; k <= 5; k++) {
      const f = k / 5;
      ctx.moveTo(w, h * (0.2 + 0.6 * f));
      ctx.lineTo(0, h * (0.1 + 0.8 * f));
    }
    ctx.stroke();
  },

  /** A paired fin on both sides. The image's right edge is the root; the fin is swung back and out
   *  by `splay`, then angled down by `droop`. `root` is the right-hand root in species points. */
  pair(size, uv, kind, flow, root, splay, droop, roll, u) {
    const r = { x: -size.w, y: -size.h / 2, w: size.w, h: size.h };
    const fin = FishFins.grid(r, r, uv, kind === FinKind.pelvic && flow > 0.5 ? 12 : 4, 1);
    const both = new Mesh();
    for (const side of [1, -1]) {
      // `roll` turns the fin about its own span first, laying it flat like a wing.
      const q = quatAxis(side * splay, 0, 1, 0).multiply(quatAxis(droop, 0, 0, 1)).multiply(quatAxis(side * roll, 1, 0, 0));
      const tip = v3(-1, 0, 0).applyQuaternion(q);
      const piece = fin.scaled(u);
      piece.c = [];
      for (let i = 0; i < fin.count; i++) piece.c.push(...FishFins.data(kind, flow, side * (-fin.p[i * 3] * u + 1e-6), tip.x, tip.y));
      both.append(piece, mat4Translate(v3(root.x, root.y, root.z * side).multiplyScalar(u)).multiply(mat4Rotate(q)));
    }
    return both;
  },

  /** A flat grid over `r` (species points, normal +z) textured from the part of the atlas at `uv`,
   *  where `image` is the rectangle the whole image covers. */
  grid(r, image, uv, columns, rows) {
    const m = new Mesh();
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= columns; i++) {
        const x = r.x + r.w * i / columns;
        const y = r.y + r.h * j / rows;
        m.p.push(x, y, 0);
        m.n.push(0, 0, 1);
        const fu = (x - image.x) / image.w, fv = (y - image.y) / image.h;
        m.uv.push(uv.x + fu * uv.w, uv.y + (1 - fv) * uv.h);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const q = j * (columns + 1) + i, c = q + columns + 1;
        m.triangle(q, q + 1, c);
        m.triangle(q + 1, c + 1, c);
      }
    }
    return m;
  },

  /** Per-vertex fin data for the shader: (kind + flow / 2, span, a, b). */
  data(kind, flow, span, a, b) {
    return [kind + clamp(flow, 0, 0.999) / 2, span, a, b];
  },

  /** Stack images vertically (2px gaps) into one atlas; returns each one's UV rect (top-left origin). */
  pack(parts) {
    const w = Math.max(...parts.map((p) => p.width));
    const h = parts.reduce((t, p) => t + p.height, 0) + 2 * parts.length;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const rects = [];
    let top = 0;
    for (const img of parts) {
      ctx.drawImage(img, 0, top);
      rects.push({ x: 0, y: top / h, w: img.width / w, h: img.height / h });
      top += img.height + 2;
    }
    return [c, rects];
  },
};

// ---------------------------------------------------------------------------------------------
// Eyes (FishEyes.swift EyeModel): one eyeball mesh looking along +z with a slight corneal bulge,
// a painted iris, and where each eye sits on the head
// ---------------------------------------------------------------------------------------------

export const EyeModel = {
  make(s, u) {
    const isShark = s.shape === 'shark';
    const ex = s.length / 2 - 0.17 * s.length;
    const section = FishBody.section(s, ex);
    const er = Math.max(1.9, Math.min(s.length * 0.075, s.height / 2 * 0.34)) * s.eyeScale;
    // A little above the middle of the head, sunk into the flank so a domed cap shows.
    const mid = (section.top - section.bottom) / 2;
    const half = (section.top + section.bottom) / 2;
    const ey = mid + 0.3 * half;
    const rel = (ey - mid) / Math.max(half, 1e-3);
    const surface = section.halfWidth * Math.sqrt(1 - rel * rel);
    const ez = Math.max(surface - 0.4 * er, 0.5 * er);

    const sockets = [1, -1].map((side) => {
      const n = v3(0.3, 0.08, side).normalize();
      const fore = v3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize();
      const c = n.clone().cross(fore);
      const up = c.multiplyScalar(c.y >= 0 ? 1 : -1);
      return { center: v3(ex, ey, ez * side).multiplyScalar(u), neutral: n, fore, up, base: quatFromTo(v3(0, 0, 1), n) };
    });

    // Unit eyeball looking along +z. The iris is projected straight on from the front.
    const sphere = Mesh.icosphere(3);
    for (let i = 0; i < sphere.count; i++) {
      const p = sphere.pos(i);
      let x = p.x, y = p.y;
      if (p.z <= 0) { const l = Math.hypot(x + 1e-4, y) || 1; x = (x + 1e-4) / l; y = y / l; }
      sphere.uv.push(0.5 + x * 0.5, 0.5 - y * 0.5);
    }
    // The cornea bulges a little over the iris.
    sphere.mapPositions((p) => {
      const t = clamp((p.z - 0.55) / 0.45, 0, 1);
      return p.multiplyScalar(1 + 0.14 * t * t * (3 - 2 * t));
    });
    sphere.computeNormals();

    const material = new THREE.MeshPhysicalMaterial({
      map: Art.texture(EyeModel.iris(s)),
      roughness: isShark ? 0.25 : 0.4,
      metalness: 0,
      // A wet, glassy cornea over the matte iris.
      clearcoat: 1,
      clearcoatRoughness: 0.03,
    });
    return { geometry: sphere.geometry(), material, x: ex * u, radius: er * u, sockets, reach: isShark ? 0.3 : 0.55 };
  },

  /** The front of the eye: black pupil, coloured iris with radial fibres, bright rings. */
  iris(s) {
    const isShark = s.shape === 'shark';
    const size = 64, c = [32, 32], r = 32;
    const iris = r * 0.8, pupil = r * (isShark ? 0.5 : 0.42);
    const warm = s.eye.r >= s.eye.b;
    const ring = isShark ? new RGBA(0.16, 0.18, 0.17) : (warm ? new RGBA(0.95, 0.78, 0.38) : new RGBA(0.86, 0.90, 0.92));
    // Beyond the iris the eyeball is mostly hidden in the head; tint it like the skin around it.
    const rim = isShark ? s.top.darker(0.5) : s.mid.darker(0.55);
    return Art.image(size, size, 1, (ctx) => {
      ctx.fillStyle = rim.css;
      ctx.fillRect(0, 0, size, size);
      const base = isShark ? new RGBA(0.07, 0.08, 0.08) : s.eye;
      Art.radial(ctx, [base.lighter(0.1), base.darker(0.25), base.darker(0.65)], [0.45, 0.7, 1], c, iris);
      ctx.save();
      ctx.beginPath(); ctx.arc(c[0], c[1], iris, 0, TAU); ctx.clip();
      ctx.lineCap = 'round';
      for (let i = 0; i < 70; i++) {
        const a = i / 70 * TAU + rnd(-0.03, 0.03);
        const r0 = pupil + rnd(0, 2), r1 = iris * rnd(0.7, 1);
        const light = coin();
        ctx.strokeStyle = (light ? base.lighter(0.45) : base.darker(0.55)).alpha(rnd(0.15, 0.45)).css;
        ctx.lineWidth = rnd(0.6, 1.4);
        ctx.beginPath();
        ctx.moveTo(c[0] + Math.cos(a) * r0, c[1] + Math.sin(a) * r0);
        ctx.lineTo(c[0] + Math.cos(a) * r1, c[1] + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
      // Limbal ring and pupillary ring.
      ctx.strokeStyle = ring.alpha(isShark ? 0.6 : 0.9).css;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(c[0], c[1], iris - 1, 0, TAU); ctx.stroke();
      if (!isShark) {
        ctx.strokeStyle = ring.lighter(0.3).css;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c[0], c[1], pupil + 1.2, 0, TAU); ctx.stroke();
      }
      Art.radial(ctx, [new RGBA(0.02, 0.03, 0.05), new RGBA(0.005, 0.005, 0.01)], null, c, pupil);
    });
  },
};

// ---------------------------------------------------------------------------------------------
// The shark's articulated mouth (SharkJaw.swift): a lower jaw cut from the underside of the head
// that swings open on a hinge, a dark mouth interior, and rows of teeth on both jaws
// ---------------------------------------------------------------------------------------------

export const SharkJaw = {
  backFraction: 0.27,
  frontFraction: 0.045,
  spread: 1.05,
  palette: [new RGBA(0.94, 0.94, 0.92), new RGBA(0.28, 0.05, 0.07), new RGBA(0.55, 0.20, 0.22),
    new RGBA(0.97, 0.96, 0.91), new RGBA(0.42, 0.45, 0.49)],

  /** `section(x)` gives the body's belly depth (hy) and half-width (hz) at x (species points). */
  make(s, u, section) {
    const Tone = { skin: 0, mouth: 1, gum: 2, tooth: 3, lip: 4 };
    const a = s.length / 2, L = s.length;
    const xh = a - SharkJaw.backFraction * L, xf = a - SharkJaw.frontFraction * L;
    const phi = SharkJaw.spread;
    const nx = 12, na = 14;
    const uv = (t) => Art.paletteUV(t, SharkJaw.palette.length);
    const point = (x, th, scale) => {
      const { hy, hz } = section(x);
      return v3(x, hy * Math.cos(th) * scale, hz * Math.sin(th) * scale);
    };
    const xAt = (i) => xh + (xf - xh) * i / nx;
    const thAt = (j) => Math.PI - phi + 2 * phi * j / na;

    // Jaw shell: outer skin just outside the body, dark inner surface, lips joining them.
    let shell = new Mesh();
    const grid = (scale, tone, flip) => {
      const base = shell.count;
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= na; j++) {
          shell.addPos(point(xAt(i), thAt(j), scale));
          shell.addUV(uv(tone));
        }
      }
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < na; j++) {
          const a0 = base + i * (na + 1) + j, b0 = a0 + 1, c0 = a0 + na + 1, d0 = c0 + 1;
          if (flip) shell.quad(b0, a0, d0, c0); else shell.quad(a0, b0, c0, d0);
        }
      }
    };
    grid(1.02, Tone.skin, false);
    grid(0.95, Tone.mouth, true);
    const jawShell = shell;
    shell = new Mesh();
    grid(1.008, Tone.mouth, false);
    const palate = shell;
    shell = jawShell;
    const lip = (edge) => {
      const base = shell.count;
      for (const [x, th] of edge) {
        shell.addPos(point(x, th, 1.02)); shell.addPos(point(x, th, 0.95));
        shell.addUV(uv(Tone.lip)); shell.addUV(uv(Tone.gum));
      }
      for (let k = 0; k < edge.length - 1; k++) shell.quad(base + k * 2, base + k * 2 + 1, base + k * 2 + 2, base + k * 2 + 3);
    };
    const range = (n) => Array.from({ length: n + 1 }, (_, i) => i);
    lip(range(nx).map((i) => [xAt(i), thAt(0)]));
    lip(range(nx).map((i) => [xAt(i), thAt(na)]));
    lip(range(na).map((j) => [xf, thAt(j)]));

    // Teeth along the rims: upward on the lower jaw, downward from the upper jaw line.
    const lower = new Mesh(), upper = new Mesh();
    const toothLength = L * 0.03, toothWidth = L * 0.0075;
    const rim = [];
    const sideCount = 9, frontCount = 8;
    for (let k = 0; k < sideCount; k++) {
      const x = xh + (xf - xh) * (0.25 + 0.75 * k / (sideCount - 1));
      rim.push([x, thAt(0)], [x, thAt(na)]);
    }
    for (let k = 1; k < frontCount; k++) rim.push([xf - L * 0.004, thAt(0) + (thAt(na) - thAt(0)) * k / frontCount]);
    for (const [x, th] of rim) {
      const inward = v3(0, -Math.cos(th), -Math.sin(th));
      const jitter = rnd(0.8, 1.15);
      lower.append(SharkJaw.tooth(point(x, th, 0.97), v3(0, 0.8, 0).add(inward.clone().multiplyScalar(0.4)).normalize(),
        toothLength * jitter, toothWidth, uv(Tone.tooth)));
      upper.append(SharkJaw.tooth(point(x - L * 0.006, th, 0.99), v3(0, -0.85, 0).add(inward.clone().multiplyScalar(0.3)).normalize(),
        toothLength * 1.1 * jitter, toothWidth, uv(Tone.tooth)));
    }

    const tex = Art.texture(Art.palette(SharkJaw.palette), { nearest: true, mipmaps: false });
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
    const finish = (m) => {
      const g = m.scaled(u);
      g.computeNormals();
      return g.geometry();
    };
    return {
      shell: finish(shell), lowerTeeth: finish(lower), upperTeeth: finish(upper), palate: finish(palate), material,
      hinge: v3(xh, -section(xh).hy * 0.2, 0).multiplyScalar(u),
      midX: (xh + xf) / 2 * u,
    };
  },

  /** A small triangular pyramid. */
  tooth(p, dir, length, width, uv) {
    const side = Math.abs(dir.x) < 0.9 ? dir.clone().cross(v3(1, 0, 0)).normalize() : dir.clone().cross(v3(0, 1, 0)).normalize();
    const up = side.clone().cross(dir);
    const m = new Mesh();
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * TAU;
      m.addPos(p.clone().add(side.clone().multiplyScalar(Math.cos(a) * width)).add(up.clone().multiplyScalar(Math.sin(a) * width)));
    }
    m.addPos(p.clone().add(dir.clone().multiplyScalar(length)));
    for (let k = 0; k < 4; k++) m.addUV(uv);
    m.triangle(0, 1, 3);
    m.triangle(1, 2, 3);
    m.triangle(2, 0, 3);
    return m;
  },
};

// ---------------------------------------------------------------------------------------------
// Body materials (FishMaterials.swift): the painted skin plus each fish's own colour and the
// angle-dependent sheen of real scales
// ---------------------------------------------------------------------------------------------

export const FishMaterials = {
  /** How a species' scales play with the light: (mask, swing, glow, sparkle). */
  sheen(s) {
    switch (s.id) {
      case Species.neonTetra.id: return [1, 0.7, 0.6, 0];
      case Species.betta.id: return [2, 0.55, 0.35, 0.12];
      case Species.goldfish.id: return [2, 0.06, 0.1, 0.3];
      case Species.angelfish.id: return [2, 0.04, 0.05, 0.12];
      default: return [0, 0, 0, 0];
    }
  },

  /** A body material for one fish, with its own uniforms `u`. */
  body(model, u) {
    const s = model.species;
    const mat = new THREE.MeshStandardMaterial({
      map: model.skinTexture,
      roughness: s.roughness ?? (s.pattern === 'metallic' ? 0.3 : 0.4),
      metalness: s.shape === 'shark' ? 0 : (s.pattern === 'metallic' ? 0.35 : 0.08),
      normalMap: model.scalesTexture,
    });
    const k = s.pattern === 'metallic' ? 0.8 : (s.shape === 'shark' ? 0.12 : 0.5);
    mat.normalScale.set(k, -k);
    return patchMaterial(mat, {
      key: 'fish-body',
      uniforms: { ...causticUniforms(), fishCaustic: G.fishCaustic, ...u },
      vHead: FISH_BODY_HEAD,
      vMain: 'fishBody(gPos, gNrm);',
      fHead: FISH_SKIN_HEAD,
      fAfterEmissive: FISH_SKIN,
    });
  },

  bodyDepth(u) {
    return patchedDepthMaterial({ key: 'fish-body', uniforms: { uTime: G.uTime, ...u }, vHead: FISH_BODY_HEAD, vMain: 'fishBody(gPos, gNrm);' });
  },

  /** Fins are translucent, glowing where light shines through them, except a shark's, which are
   *  solid and matte (cut out and drawn opaque). */
  fins(model, u) {
    const solid = model.fins.solid;
    const mat = new THREE.MeshStandardMaterial({
      map: model.fins.texture,
      roughness: solid ? 0.85 : 0.5,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: !solid,
      depthWrite: solid,
      alphaTest: solid ? 0.5 : 0,
    });
    return patchMaterial(mat, {
      key: solid ? 'fish-fins-solid' : 'fish-fins',
      uniforms: { uTime: G.uTime, ...u },
      vHead: FISH_FINS_HEAD,
      vMain: 'fishFins(gPos, gNrm);',
      fHead: solid ? '' : FIN_GLOW_HEAD,
      fMap: MAP_UNPREMULTIPLY,
      fAfterEmissive: solid ? '' : FIN_GLOW,
    });
  },

  /** Per-fish touches: a slight shift of hue, saturation and brightness for every fish, plus
   *  colour morphs for goldfish and bettas. Returns the uniform values. */
  personalize(s, skinRect) {
    let look = { hue: rnd(-0.05, 0.05), saturation: rnd(0.9, 1.1), value: rnd(0.9, 1.08), sheen: 1, pale: 0, dark: 0, speckle: 0,
      paleColor: [0.97, 0.94, 0.88] };
    switch (s.id) {
      case Species.goldfish.id: look = FishMaterials.goldfishMorph(look); break;
      case Species.betta.id: look = FishMaterials.bettaMorph(look); break;
      case Species.clownfish.id:
        // From pale tangerine to deep red-orange.
        look.hue = rnd(-0.1, 0.04);
        look.saturation = rnd(0.95, 1.15);
        look.value = rnd(0.82, 1.05);
        break;
      case Species.neonTetra.id:
        look.hue = rnd(-0.03, 0.03);
        look.value = rnd(0.94, 1.05);
        break;
      case Species.shark.id:
        look = { ...look, hue: 0, saturation: rnd(0.9, 1.1), value: rnd(0.95, 1.04) };
        break;
    }
    return {
      fishLook: new THREE.Vector4(look.hue, look.saturation, look.value, look.sheen),
      fishMorph: new THREE.Vector4(look.pale, look.dark, look.speckle, rnd(0, 50)),
      fishPale: new THREE.Vector4(...look.paleColor, skinRect.w / skinRect.h),
    };
  },

  /** Fancy goldfish come in a handful of classic colourings; plain orange is the most common. */
  goldfishMorph(l) {
    const r = Math.random();
    if (r < 0.38) { /* orange */ }
    else if (r < 0.58) { // red and white
      l.hue = rnd(-0.1, -0.05); l.saturation = rnd(1.05, 1.15); l.value = rnd(0.8, 0.9); l.pale = rnd(0.4, 0.6);
    } else if (r < 0.74) { // calico: orange, pearly blue-white and black, freckled
      l.saturation = rnd(0.8, 0.95); l.pale = rnd(0.35, 0.5); l.dark = rnd(0.3, 0.45); l.speckle = 1; l.paleColor = [0.84, 0.88, 0.92];
    } else if (r < 0.87) { // lemon
      l.hue = rnd(0.1, 0.15); l.saturation = rnd(0.85, 0.95); l.value = rnd(1.12, 1.2);
    } else if (r < 0.94) { // black and orange
      l.dark = rnd(0.45, 0.6);
    } else { // all white
      l.pale = 1; l.sheen = 1.2;
    }
    return l;
  },

  /** The painted betta is royal blue; others are turned to red, turquoise or purple. */
  bettaMorph(l) {
    switch (randInt(0, 3)) {
      case 0: break; // royal blue
      case 1: l.hue = rnd(2.55, 2.7); l.saturation = rnd(1.1, 1.25); l.sheen = 0.35; break; // red
      case 2: l.hue = rnd(-0.75, -0.6); l.value = rnd(1.0, 1.1); break; // turquoise
      default: l.hue = rnd(0.7, 0.85); l.sheen = 0.7; // purple
    }
    return l;
  },
};

// ---------------------------------------------------------------------------------------------
// The 3D model for a species (FishModel.swift), built once and shared by every fish of it
// ---------------------------------------------------------------------------------------------

/** World units per species point: 1 world unit = 100 screen points, and fish are drawn 1.3x. */
export const FISH_UNIT = 1.3 / 100;

export const FishModel = {
  cache: {},
  forSpecies(s) {
    return FishModel.cache[s.id] ??= FishModel.make(s);
  },

  make(s) {
    const art = FishArt.forSpecies(s);
    const u = FISH_UNIT;
    const bodyMesh = FishBody.mesh(s, art).scaled(u);
    bodyMesh.computeNormals();
    const skinTexture = Art.texture(art.skin);
    // Overlapping scales: about 24 along the body whatever the species' size.
    const scaleSize = s.length / 24;
    const scalesTexture = Detail.scales().clone();
    scalesTexture.repeat.set(art.skinRect.w / (scaleSize * 8), art.skinRect.h / (scaleSize * 0.8 * 10));
    scalesTexture.needsUpdate = true;
    const model = {
      species: s,
      art,
      length: s.length * u,
      noseX: s.length / 2 * u,
      body: bodyMesh.geometry(),
      skinTexture,
      scalesTexture,
      fins: FishFins.build(s, art, u),
      eyes: EyeModel.make(s, u),
      jaw: s.shape === 'shark'
        ? SharkJaw.make(s, u, (x) => { const c = FishBody.section(s, x); return { hy: c.bottom, hz: c.halfWidth }; })
        : null,
    };
    for (const g of [model.body, model.fins.geometry, model.eyes.geometry]) sharedGeometry.add(g);
    if (model.jaw) {
      for (const g of [model.jaw.shell, model.jaw.lowerTeeth, model.jaw.upperTeeth, model.jaw.palate]) sharedGeometry.add(g);
      model.jaw.material.userData.shared = true;
    }
    return model;
  },
};
