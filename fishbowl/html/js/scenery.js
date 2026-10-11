// Fishbowl — The reef and the plant bed, each merged into one mesh.

import * as THREE from 'three';
import { TAU, clamp, rnd, randInt, smoothstep, v3, unit, quatAxis, RGBA, Art, Detail, Mesh, mat4Translate, mat4Rotate, Occlusion, occluder } from './util.js';
import { G, patchMaterial, patchedDepthMaterial, CAUSTICS_HEAD, CAUSTICS_APPLY, causticUniforms, REEF_HEAD, REEF_DETAIL, SWAY_HEAD, swayUniforms } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// The reef (Coral.swift): brain, branching, table and finger corals, polyps and live rock, merged
// into one mesh and coloured from a shaded palette (each row a colour, dark u = 0 to pale u = 1)
// ---------------------------------------------------------------------------------------------

export const ReefTone = { pink: 0, orange: 1, purple: 2, tan: 3, teal: 4, bone: 5, red: 6, green: 7, rock: 8, coralline: 9, rockPurple: 10 };
export const REEF_COLORS = [
  new RGBA(0.92, 0.46, 0.52), new RGBA(0.95, 0.52, 0.22), new RGBA(0.56, 0.32, 0.68), new RGBA(0.82, 0.70, 0.42),
  new RGBA(0.30, 0.62, 0.55), new RGBA(0.88, 0.84, 0.76), new RGBA(0.78, 0.18, 0.18), new RGBA(0.35, 0.78, 0.45),
  new RGBA(0.40, 0.37, 0.33), new RGBA(0.62, 0.42, 0.50), new RGBA(0.42, 0.33, 0.40),
];

export class CoralReef {
  constructor() {
    this.mesh = new Mesh();
    this.pieceOfVertex = [];
    this.occluders = [];
  }

  /** `shade` 0...1 runs dark to pale within the palette's normal range (occlusion can go darker). */
  uv(tone, shade) {
    return [0.05 + (0.15 + 0.85 * clamp(shade, 0, 1)) * 0.9, (tone + 0.5) / REEF_COLORS.length];
  }

  /** A domed brain coral with meandering grooves. */
  addBrain(base, radius, tone) {
    const m = Mesh.icosphere(radius > 0.35 ? 5 : 4);
    const s = [rnd(0, TAU), rnd(0, TAU), rnd(0, TAU)];
    const f = rnd(11, 14);
    for (let i = 0; i < m.count; i++) {
      const p = m.pos(i);
      // Contours of a warped noise field make winding valleys between rounded ridges.
      const g = Math.sin(f * p.x + 2.5 * Math.sin(9 * p.y + s[0])) + Math.sin(f * p.y + 2.5 * Math.sin(9 * p.z + s[1]))
        + Math.sin(f * p.z + 2.5 * Math.sin(9 * p.x + s[2]));
      const ridge = Math.abs(Math.sin(g * 1.6));
      const q = p.multiplyScalar(1 + 0.045 * (ridge - 0.5));
      q.y = Math.max(q.y * 0.72, -0.08);
      m.setPos(i, q.multiplyScalar(radius));
      m.addUV(this.uv(tone, 0.25 + 0.65 * ridge));
    }
    this.add(m, base, v3(0, radius * 0.3, 0), radius * 0.85);
  }

  /** A staghorn-style coral: tapering branches that split, with pale growing tips. */
  addBranching(base, height, tone) {
    const m = new Mesh();
    const maxDepth = 4;
    const grow = (p, dir, len, radius, depth) => {
      const bend = v3(rnd(-0.3, 0.3), rnd(-0.1, 0.2), rnd(-0.3, 0.3));
      const mid = p.clone().add(unit(dir.clone().addScaledVector(bend, 0.4)).multiplyScalar(len * 0.5));
      const end = mid.clone().add(unit(dir.clone().add(bend)).multiplyScalar(len * 0.5));
      const last = depth === maxDepth;
      const t0 = depth / (maxDepth + 1), t1 = (depth + 1) / (maxDepth + 1);
      const tipR = last ? radius * 0.35 : radius * 0.75;
      m.append(PlantBed.tube([p, mid, end], [radius, radius * 0.88, tipR], 7, (t) => this.uv(tone, 0.2 + 0.75 * (t0 + (t1 - t0) * t))));
      if (last) {
        m.append(this.cap(end, tipR, tone));
        return;
      }
      for (let k = randInt(2, 3); k > 0; k--) {
        const d = unit(dir.clone().multiplyScalar(0.6).add(unit(v3(rnd(-1, 1), rnd(0.3, 1), rnd(-1, 1))).multiplyScalar(0.7)));
        grow(end, d, len * rnd(0.7, 0.85), radius * 0.75, depth + 1);
      }
    };
    grow(v3(), v3(0, 1, 0), height * 0.32, height * 0.07, 0);
    this.add(m, base, v3(0, height * 0.4, 0), height * 0.3);
  }

  /** A table coral: a wavy plate on a short stalk, paler toward the rim. */
  addTable(base, radius, tone) {
    const m = PlantBed.tube([v3(0, 0, 0), v3(0, radius * 0.25, 0), v3(0, radius * 0.45, 0)],
      [radius * 0.22, radius * 0.14, radius * 0.18], 10, () => this.uv(tone, 0.3));
    const rings = 8, segs = 40;
    const phase = rnd(0, TAU);
    const plate = (offset) => {
      const p = new Mesh();
      for (let r = 0; r <= rings; r++) {
        const t = r / rings;
        for (let s = 0; s <= segs; s++) {
          const a = s / segs * TAU;
          const rr = radius * t * (1 + 0.08 * Math.sin(a * 5 + phase));
          const y = radius * 0.45 + radius * (0.12 * t * t + 0.05 * t * Math.sin(a * 3 + phase)) + offset;
          p.p.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
          p.addUV(this.uv(tone, 0.3 + 0.65 * t));
        }
      }
      for (let r = 0; r < rings; r++) {
        for (let s = 0; s < segs; s++) {
          const a = r * (segs + 1) + s, b = a + segs + 1;
          if (offset >= 0) p.quad(a, a + 1, b, b + 1); else p.quad(a + 1, a, b + 1, b);
        }
      }
      return p;
    };
    m.append(plate(0));
    m.append(plate(-radius * 0.05));
    this.add(m, base, v3(0, radius * 0.5, 0), radius * 0.8);
  }

  /** A porous lump of live rock, for building reef mounds. */
  addRock(base, size, tone) {
    const m = Mesh.icosphere(3);
    const s = Array.from({ length: 5 }, () => rnd(0, TAU));
    const shades = [];
    for (let i = 0; i < m.count; i++) {
      const p = m.pos(i);
      const bump = 1 + 0.14 * Math.sin(p.x * 3 + s[0]) * Math.cos(p.z * 2.5 + s[1]) + 0.08 * Math.sin(p.y * 5 + s[2]);
      // Small pits and nodules give it a rough, porous look.
      const pits = Math.sin(p.x * 17 + s[3]) * Math.sin(p.y * 19 + s[4]) * Math.sin(p.z * 15);
      const k = bump + 0.05 * pits;
      const q = v3(p.x * k * size.x, p.y * k * size.y, p.z * k * size.z);
      q.y = Math.max(q.y, -size.y * 0.35);
      m.setPos(i, q);
      shades.push(0.35 + 0.35 * (pits * 0.5 + 0.5) + 0.2 * Math.max(0, p.y));
    }
    // Blotches of pink coralline algae on the upper surfaces.
    const blotch = [rnd(0, TAU), rnd(0, TAU), rnd(0, TAU)];
    for (let i = 0; i < m.count; i++) {
      const p = m.pos(i);
      const x = p.x / size.x, y = p.y / size.y, z = p.z / size.z;
      const n = Math.sin(x * 7 + blotch[0]) * Math.sin(z * 7 + blotch[1]) + 0.6 * Math.sin(y * 9 + x * 3 + blotch[2]);
      const coralline = n > 0.55 && y > 0;
      m.addUV(this.uv(coralline ? ReefTone.coralline : tone, shades[i]));
    }
    this.add(m, base, v3(), (size.x + size.y + size.z) / 3 * 0.95);
  }

  /** A clump of finger (pillar) coral: upright rounded columns. */
  addFingers(base, size, tone) {
    const m = new Mesh();
    for (let k = randInt(5, 9); k > 0; k--) {
      const off = v3(rnd(-1, 1), 0, rnd(-1, 1)).multiplyScalar(size * 0.35);
      const h = size * rnd(0.5, 1.0), r = size * rnd(0.07, 0.11);
      const lean = v3(rnd(-0.15, 0.15), 0, rnd(-0.15, 0.15)).multiplyScalar(h);
      const pts = [off, off.clone().add(v3(0, h * 0.5, 0)).addScaledVector(lean, 0.3), off.clone().add(v3(0, h, 0)).add(lean)];
      m.append(PlantBed.tube(pts, [r * 1.1, r, r * 0.95], 8, (t) => this.uv(tone, 0.35 + 0.5 * t)));
      m.append(this.cap(pts[2], r * 0.95, tone));
    }
    this.add(m, base, v3(0, size * 0.35, 0), size * 0.45);
  }

  /** A cluster of button polyps (zoanthids): little stalked discs with pale centres. */
  addPolyps(base, radius, tone) {
    const m = new Mesh();
    for (let n = randInt(8, 14); n > 0; n--) {
      const a = rnd(0, TAU), d = radius * Math.sqrt(rnd(0, 1));
      const p = v3(Math.cos(a) * d, 0, Math.sin(a) * d);
      const r = radius * rnd(0.16, 0.24), h = radius * rnd(0.15, 0.35);
      m.append(PlantBed.tube([p, p.clone().add(v3(0, h, 0))], [r * 0.6, r * 0.7], 7, () => this.uv(tone, 0.3)));
      // The disc: a flat fan from a bright centre to a darker rim.
      const top = p.clone().add(v3(0, h, 0));
      const c = m.count;
      m.addPos(top.clone().add(v3(0, r * 0.15, 0)));
      m.addUV(this.uv(tone, 1.0));
      for (let k = 0; k <= 10; k++) {
        const ang = k / 10 * TAU;
        m.addPos(top.clone().add(v3(Math.cos(ang) * r, 0, Math.sin(ang) * r)));
        m.addUV(this.uv(tone, 0.5));
      }
      for (let k = 0; k < 10; k++) m.triangle(c, c + 2 + k, c + 1 + k);
    }
    this.add(m, base, v3(0, radius * 0.2, 0), radius * 0.7);
  }

  /** A small smooth pebble. */
  addPebble(base, radius, tone) {
    const m = Mesh.icosphere(1);
    const sq = v3(rnd(0.8, 1.3), rnd(0.45, 0.7), rnd(0.8, 1.2)).multiplyScalar(radius);
    m.mapPositions((p) => p.multiply(sq));
    const uv = this.uv(tone, rnd(0.4, 0.8));
    for (let i = 0; i < m.count; i++) m.addUV(uv);
    this.add(m, base, v3(0, radius * 0.4, 0), radius * 1.1);
  }

  /** Build the merged geometry, baking contact shadows: darker where pieces meet the floor, face
   *  downward, or press against their neighbours. */
  finish(floor) {
    const mesh = this.mesh;
    mesh.computeNormals();
    for (let i = 0; i < mesh.count; i++) {
      const px = mesh.p[i * 3], py = mesh.p[i * 3 + 1], pz = mesh.p[i * 3 + 2];
      const nx = mesh.n[i * 3], ny = mesh.n[i * 3 + 1], nz = mesh.n[i * 3 + 2];
      let vis = 0.3 + 0.7 * smoothstep(-0.05, 0.5, py - floor(px, pz));
      vis *= 0.8 + 0.2 * clamp(ny * 0.5 + 0.5, 0, 1);
      vis *= Occlusion.visibility(px, py, pz, nx, ny, nz, this.occluders, this.pieceOfVertex[i], 1);
      // Shade runs along u in the palette (dark → pale), so occlusion just darkens it.
      const shade = (mesh.uv[i * 2] - 0.05) / 0.9;
      mesh.uv[i * 2] = 0.05 + clamp(shade * vis, 0, 1) * 0.9;
    }
    const geo = mesh.geometry();
    const tex = Art.texture(CoralReef.palette(), { mipmaps: false });
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0 });
    this.causticStrength = { value: 0.7 };
    patchMaterial(mat, {
      key: 'reef',
      uniforms: { ...causticUniforms(), detailNormal: { value: Detail.rock() }, detailScale: { value: 1.1 },
        detailStrength: { value: 0.7 }, causticStrength: this.causticStrength },
      fHead: REEF_HEAD,
      fAfterNormal: REEF_DETAIL,
      fAfterEmissive: CAUSTICS_APPLY('causticStrength'),
    });
    this.material = mat;
    this.node = new THREE.Mesh(geo, mat);
    this.node.castShadow = true;
    this.node.receiveShadow = true;
    this.mesh = null;
    this.pieceOfVertex = null;
  }

  add(piece, base, occOffset, occRadius, rotation = rnd(0, TAU)) {
    piece.n = [];
    const id = this.occluders.length;
    this.occluders.push(occluder(base.clone().add(occOffset), occRadius, id));
    for (let i = 0; i < piece.count; i++) this.pieceOfVertex.push(id);
    this.mesh.append(piece, mat4Translate(base).multiply(mat4Rotate(quatAxis(rotation, 0, 1, 0))));
  }

  cap(p, radius, tone) {
    const m = Mesh.icosphere(1);
    m.mapPositions((q) => q.multiplyScalar(radius).add(p));
    const uv = this.uv(tone, 0.97);
    for (let i = 0; i < m.count; i++) m.addUV(uv);
    m.n = [];
    return m;
  }

  /** Rows of colours, each shading from a deep shadow tone to a pale, sun-bleached tip. */
  static palette() {
    const count = REEF_COLORS.length;
    return Art.image(32, count, 1, (ctx) => {
      REEF_COLORS.forEach((c, raw) => {
        const y = count - 1 - raw;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, y, 32, 1); ctx.clip();
        // Shades 0.15...1 are the normal range; below that is extra depth for baked contact shadows.
        Art.linear(ctx, [c.darker(0.85), c.darker(0.55), c, c.lighter(0.45)], [0, 0.15, 0.62, 1], [0, y], [32, y]);
        ctx.restore();
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Everything that sways (Plants.swift), merged into one mesh: ribbon seaweed, sword plants, stem
// plants, sea anemones and sea fans. Per-vertex sway data travels in the aSway attribute.
// ---------------------------------------------------------------------------------------------

export const PlantTone = { green: 0, brightGreen: 1, darkGreen: 2, olive: 3, lime: 4, red: 5, maroon: 6, rotala: 7, anemone: 8, fanPurple: 9, fanRed: 10 };
export const PLANT_GRADIENTS = [
  [new RGBA(0.06, 0.26, 0.11), new RGBA(0.16, 0.52, 0.22), new RGBA(0.30, 0.66, 0.30)],
  [new RGBA(0.10, 0.32, 0.10), new RGBA(0.24, 0.62, 0.18), new RGBA(0.50, 0.80, 0.30)],
  [new RGBA(0.03, 0.16, 0.10), new RGBA(0.08, 0.36, 0.22), new RGBA(0.16, 0.48, 0.30)],
  [new RGBA(0.18, 0.24, 0.08), new RGBA(0.36, 0.50, 0.16), new RGBA(0.55, 0.64, 0.26)],
  [new RGBA(0.20, 0.40, 0.08), new RGBA(0.48, 0.74, 0.20), new RGBA(0.72, 0.88, 0.38)],
  [new RGBA(0.25, 0.10, 0.06), new RGBA(0.55, 0.20, 0.16), new RGBA(0.75, 0.32, 0.20)],
  [new RGBA(0.18, 0.05, 0.08), new RGBA(0.40, 0.12, 0.18), new RGBA(0.58, 0.22, 0.28)],
  [new RGBA(0.14, 0.38, 0.14), new RGBA(0.62, 0.52, 0.18), new RGBA(0.92, 0.36, 0.22)],
  [new RGBA(0.45, 0.28, 0.40), new RGBA(0.78, 0.45, 0.62), new RGBA(0.98, 0.82, 0.88)],
  [new RGBA(0.30, 0.12, 0.38), new RGBA(0.52, 0.24, 0.62), new RGBA(0.70, 0.42, 0.80)],
  [new RGBA(0.40, 0.08, 0.10), new RGBA(0.72, 0.18, 0.20), new RGBA(0.92, 0.40, 0.34)],
];
export const plantVeined = (tone) => tone < PlantTone.anemone;

export class PlantBed {
  constructor() {
    this.mesh = new Mesh();
    this.occluders = [];
    this.smoothedVX = 0;
  }

  uv(tone, u, v) {
    const n = PLANT_GRADIENTS.length;
    return [(tone + 0.08 + clamp(u, 0, 1) * 0.84) / n, 1 - clamp(v, 0.01, 0.99)];
  }

  /** A tall ribbon of seaweed (eelgrass). */
  addBlade(base, height, width, tone) {
    const rows = 14;
    const seed = rnd(0, 10);
    const lean = rnd(-0.12, 0.12) * height;
    const b = new Mesh();
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const half = width / 2 * (1 - Math.pow(v, 3) * 0.95) * (0.85 + 0.15 * Math.sin(v * 9 + seed));
      const cx = width * 0.3 * Math.sin(v * 5 + seed);
      const z = lean * v * v;
      b.p.push(cx - half, v * height, z, cx + half, v * height, z);
      b.addUV(this.uv(tone, 0.1, v));
      b.addUV(this.uv(tone, 0.9, v));
    }
    for (let r = 0; r < rows; r++) b.quad(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 3);
    this.emit(b, base, height, rnd(0.06, 0.14) * height / 2.5, 0.12, 0.1);
  }

  /** A rosette of broad, arching leaves (Amazon sword; short and wide for an Anubias look). */
  addSword(base, size, leaves, width, tone) {
    const plant = new Mesh();
    let top = 0.01;
    for (let i = 0; i < leaves; i++) {
      const az = i / leaves * TAU + rnd(-0.3, 0.3);
      const rise = rnd(0.55, 1.25);
      const len = size * rnd(0.6, 1.0);
      const leaf = PlantBed.leafMesh(len, width * rnd(0.8, 1.2), rise, len * 0.35, tone, 10, (t, u, v) => this.uv(t, u, v));
      for (let k = 1; k < leaf.p.length; k += 3) top = Math.max(top, leaf.p[k]);
      plant.append(leaf, mat4Rotate(quatAxis(az, 0, 1, 0)));
    }
    this.emit(plant, base, top, 0.04 * top, top * 0.35, size * 0.45);
  }

  /** A tall stem with whorls of small leaves all the way up (Rotala / Ludwigia). */
  addStem(base, height, tone) {
    const plant = new Mesh();
    const seed = rnd(0, 10);
    const lean = v3(rnd(-0.15, 0.15), 0, rnd(-0.15, 0.15)).multiplyScalar(height);
    const stemPoint = (v) => v3(Math.sin(v * 3 + seed) * 0.04, v * height, Math.cos(v * 2.5 + seed) * 0.04).addScaledVector(lean, v * v);
    // Stem: two crossed thin ribbons.
    const rows = 12;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const s = new Mesh();
      for (let r = 0; r <= rows; r++) {
        const v = r / rows;
        const p = stemPoint(v), w = 0.012;
        s.addPos(p.clone().add(v3(-dx * w, 0, -dz * w)));
        s.addPos(p.clone().add(v3(dx * w, 0, dz * w)));
        s.addUV(this.uv(tone, 0.45, v * 0.8));
        s.addUV(this.uv(tone, 0.55, v * 0.8));
      }
      for (let r = 0; r < rows; r++) s.quad(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 3);
      plant.append(s);
    }
    // Whorls of three leaves, rotating up the stem, smaller near the top.
    let y = 0.1;
    let az = rnd(0, TAU);
    while (y < height * 0.97) {
      const v = y / height;
      for (const side of [0, TAU / 3, 2 * TAU / 3]) {
        const len = (0.22 + 0.08 * Math.sin(v * Math.PI)) * (1 - v * 0.35);
        // Colour follows the plant's height, so red species turn red toward the top.
        const leaf = PlantBed.leafMesh(len, len * 0.34, 0.45, len * 0.25, tone, 5, (t, u) => this.uv(t, u, v));
        plant.append(leaf, mat4Translate(stemPoint(v)).multiply(mat4Rotate(quatAxis(az + side, 0, 1, 0))));
      }
      az += Math.PI / 3 + rnd(-0.2, 0.2);
      y += rnd(0.08, 0.11);
    }
    this.emit(plant, base, height, rnd(0.04, 0.08) * height / 2, 0.15, 0.14);
  }

  /** A sea anemone: a short column with a crown of swaying, tapering tentacles. */
  addAnemone(base, radius) {
    const a = new Mesh();
    const column = radius * 0.5;
    a.append(PlantBed.tube([v3(0, 0, 0), v3(0, column * 0.6, 0), v3(0, column, 0)],
      [radius * 0.55, radius * 0.6, radius * 0.75], 14, (t, u) => this.uv(PlantTone.anemone, u, 0.05 + 0.15 * t)));
    let top = column;
    for (let n = 0; n < 90; n++) {
      const ang = rnd(0, TAU), r = radius * Math.sqrt(rnd(0.05, 1));
      const out = v3(Math.cos(ang), 0, Math.sin(ang));
      const len = radius * rnd(0.8, 1.4);
      const root = v3(0, column, 0).addScaledVector(out, r);
      const dir = unit(out.clone().multiplyScalar(0.25 + r / radius * 0.8).add(v3(0, 1, 0)));
      const pts = [], radii = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        pts.push(root.clone().addScaledVector(dir, len * t).addScaledVector(out, len * 0.3 * t * t).add(v3(0, -len * 0.15 * t * t, 0)));
        radii.push(radius * 0.085 * (1 - t * 0.8));
      }
      top = Math.max(top, ...pts.map((p) => p.y));
      a.append(PlantBed.tube(pts, radii, 5, (t, u) => this.uv(PlantTone.anemone, u, 0.3 + 0.7 * t)));
    }
    this.emit(a, base, top, 0.05 * top, top * 0.4, radius * 1.1);
  }

  /** A sea fan (gorgonian): a flat, lacy lattice of thin branches that sways gently. */
  addSeaFan(base, height, angle, tone) {
    const fan = new Mesh();
    const grow = (p, dir, len, radius, depth) => {
      const bend = v3(rnd(-0.25, 0.25), rnd(-0.05, 0.1), 0);
      const mid = p.clone().add(unit(dir.clone().addScaledVector(bend, 0.5)).multiplyScalar(len * 0.5));
      const end = mid.clone().add(unit(dir.clone().add(bend)).multiplyScalar(len * 0.5));
      const t0 = depth / 6, t1 = (depth + 1) / 6;
      fan.append(PlantBed.tube([p, mid, end], [radius, radius * 0.9, radius * 0.8], 4, (t, u) => this.uv(tone, u, t0 + (t1 - t0) * t)));
      if (depth >= 5) return;
      for (const side of [-1, 1]) {
        const spread = rnd(0.25, 0.55) * side;
        const dx = dir.x * Math.cos(spread) - dir.y * Math.sin(spread);
        const dy = dir.x * Math.sin(spread) + dir.y * Math.cos(spread);
        grow(end, unit(v3(dx, Math.max(dy, 0.15), 0)), len * rnd(0.72, 0.85), radius * 0.8, depth + 1);
      }
    };
    grow(v3(), v3(0, 1, 0), height * 0.3, 0.025, 0);
    let top = 0;
    for (let k = 1; k < fan.p.length; k += 3) top = Math.max(top, fan.p[k]);
    for (let k = 0; k < fan.p.length; k++) fan.p[k] *= height / top;
    this.emit(fan, base, height, 0.015 * height, 0.1, 0.1, angle);
  }

  /** Build the merged geometry once all plants have been added. */
  finish() {
    this.mesh.computeNormals();
    const geo = this.mesh.geometry('aSway');
    const mat = new THREE.MeshStandardMaterial({ map: Art.texture(PlantBed.atlas()), roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
    const cfg = {
      key: 'plants',
      uniforms: { ...causticUniforms(), ...swayUniforms() },
      vHead: SWAY_HEAD,
      vMain: 'plantSway(gPos);',
      fHead: CAUSTICS_HEAD,
      fAfterEmissive: CAUSTICS_APPLY('0.4'),
    };
    patchMaterial(mat, cfg);
    this.material = mat;
    this.node = new THREE.Mesh(geo, mat);
    this.node.customDepthMaterial = patchedDepthMaterial(cfg);
    this.node.customDepthMaterial.side = THREE.DoubleSide;
    this.node.castShadow = true;
    this.node.receiveShadow = true;
    this.node.frustumCulled = false;
    this.mesh = null;
  }

  update(dt, tank) {
    const c = tank.cursor;
    const vx = c.present ? c.vel.dx / 100 : 0;
    // Ease the current in and out so plants swing back smoothly after the cursor passes.
    this.smoothedVX += (vx - this.smoothedVX) * Math.min(1, dt * (Math.abs(vx) > Math.abs(this.smoothedVX) ? 10 : 2.5));
    const g = tank.cursorGlassPoint;
    G.curX.value = g.x;
    G.curY.value = g.y;
    G.curVX.value = this.smoothedVX;
    G.eyeDist.value = tank.eyeDistance;
  }

  /** Append a plant built in local space (base at the origin, y up), tagging each vertex with the
   *  data the sway shader needs. */
  emit(plant, base, height, amp, occHeight, occRadius, rotation = rnd(0, TAU)) {
    this.occluders.push(occluder(base.clone().add(v3(0, occHeight, 0)), occRadius, -2));
    const phase = rnd(0, TAU);
    plant.c = [];
    for (let i = 0; i < plant.count; i++) plant.c.push(clamp(plant.p[i * 3 + 1] / height, 0, 1), height, phase, amp);
    plant.n = [];
    this.mesh.append(plant, mat4Translate(base).multiply(mat4Rotate(quatAxis(rotation, 0, 1, 0))));
  }

  /** A lanceolate leaf growing along +x: rises at `rise` radians, then droops; slightly folded. */
  static leafMesh(length, width, rise, droop, tone, rows, uvFn) {
    const m = new Mesh();
    for (let r = 0; r <= rows; r++) {
      const s = r / rows;
      const x = length * s * Math.cos(rise);
      const y = length * s * Math.sin(rise) - droop * s * s;
      const half = width / 2 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.05 + 0.02)), 0.8);
      const fold = half * 0.3;
      m.p.push(x, y + fold, -half, x, y, 0, x, y + fold, half);
      m.addUV(uvFn(tone, 0, s));
      m.addUV(uvFn(tone, 0.5, s));
      m.addUV(uvFn(tone, 1, s));
    }
    for (let r = 0; r < rows; r++) {
      const a = r * 3;
      m.quad(a, a + 1, a + 3, a + 4);
      m.quad(a + 1, a + 2, a + 4, a + 5);
    }
    return m;
  }

  /** A tube through `points` with the given radii; `uv(t, u)` maps along (t) and around (u). */
  static tube(points, radii, sides, uv) {
    const m = new Mesh();
    points.forEach((p, k) => {
      const fwd = unit(k + 1 < points.length ? points[k + 1].clone().sub(p) : p.clone().sub(points[k - 1]));
      const side = Math.abs(fwd.y) < 0.9 ? unit(fwd.clone().cross(v3(0, 1, 0))) : unit(fwd.clone().cross(v3(1, 0, 0)));
      const up = side.clone().cross(fwd);
      const t = k / (points.length - 1);
      for (let j = 0; j <= sides; j++) {
        const a = j / sides * TAU;
        const ca = Math.cos(a) * radii[k], sa = Math.sin(a) * radii[k];
        m.p.push(p.x + side.x * ca + up.x * sa, p.y + side.y * ca + up.y * sa, p.z + side.z * ca + up.z * sa);
        m.addUV(uv(t, j / sides));
      }
    });
    for (let k = 0; k < points.length - 1; k++) {
      for (let j = 0; j < sides; j++) {
        const a = k * (sides + 1) + j, b = a + sides + 1;
        m.quad(a, a + 1, b, b + 1);
      }
    }
    return m;
  }

  /** One column per tone: a vertical gradient, with a midrib and side veins for leafy tones. */
  static atlas() {
    const w = 16, h = 128;
    return Art.image(w * PLANT_GRADIENTS.length, h, 2, (ctx) => {
      PLANT_GRADIENTS.forEach(([bottom, mid, top], tone) => {
        const x0 = tone * w;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, 0, w, h); ctx.clip();
        Art.linear(ctx, [bottom, mid, top], [0, 0.55, 1], [0, 0], [0, h]);
        if (plantVeined(tone)) {
          ctx.strokeStyle = mid.lighter(0.45).alpha(0.4).css;
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(x0 + w / 2, 0); ctx.lineTo(x0 + w / 2, h); ctx.stroke();
          ctx.strokeStyle = mid.lighter(0.3).alpha(0.18).css;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let j = 0; j < 14; j++) {
            const y = j * 9 + 4;
            ctx.moveTo(x0 + w / 2, y); ctx.lineTo(x0 + 1, y + 6);
            ctx.moveTo(x0 + w / 2, y); ctx.lineTo(x0 + w - 1, y + 6);
          }
          ctx.stroke();
        }
        ctx.restore();
      });
    });
  }
}
