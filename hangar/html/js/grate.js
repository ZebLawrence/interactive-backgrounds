// Hangar — Walkway: real bar grating, its frame, columns and railings over the slime (Ruling R15).
//
// Geometry comes from grateplan.walkwayPlan. Everything is merged into a few meshes (bars per sector, one
// for the frame and columns, one for the railings) wearing the scanned brushed steel (materials.partMaterial,
// so no parallax: the relief is the mesh). Bars, frame and rails cast shadows, so the nearest shadowed lamp
// throws the grid onto the slime below.
//
// Thin bars alias once a 5 mm bar is under a pixel, so the grating has two levels of detail crossfaded by
// distance from the camera (GRATE_NEAR to GRATE_FAR):
//   - near: the bar meshes. Past GRATE_NEAR their pixels drop out in a screen-space dither;
//   - far: the walkway's own floor polygon (the nav collider) wears a transparent "grating coverage" material:
//     the fraction of each pixel covered by bars, integrated analytically over the pixel's footprint (a
//     box-filtered pulse train, so it never shimmers), with the bars' depth seen at the view angle (looking
//     across the bearing bars at a low angle, their sides close the gaps, as on a real grating). It fades in
//     as the bars fade out and shows the slime through the gaps at any distance.
// The scanned grate texture (mat:grate and its parallax stopgap) is no longer drawn on the walkway: its
// pattern would not line up with the bars. scene.js keeps it off these floors.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { edit, partMaterial } from './materials.js';
import { walkwayPlan, barSegments, postPoints, GRATE, RAIL } from './grateplan.js';

// The bars are on their own layer: the main camera and the probes see them, the slime's mirror does not (its
// view of the walkway is from below and at least 2 m off, where the far grating stands in at full strength:
// setMirrorPass). That saves the mirror the bars' 90 000 triangles of overdraw.
export const BAR_LAYER = 2;
export const GRATE_NEAR = 4.5;
export const GRATE_FAR = 6.5;
const STEEL_GREY = 0x8a9097;

const fadeUniforms = { grateNear: { value: GRATE_NEAR }, grateFar: { value: GRATE_FAR } };

/** Arrays for a merged mesh of boxes. */
class Boxes {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
  quad(a, b, c, d, n, uvs) {
    // Wind counter-clockwise seen from the side the normal points to, whatever order the corners came in.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) { [b, d] = [d, b]; uvs = [uvs[0], uvs[3], uvs[2], uvs[1]]; }
    const o = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.pos.push(p[0], p[1], p[2]);
    for (let k = 0; k < 4; k++) this.nrm.push(n[0], n[1], n[2]);
    for (const t of uvs) this.uv.push(t[0], t[1]);
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  /**
   * A box along the horizontal segment (x0, z0) -> (x1, z1), `w` wide across it, from y0 to y1, shifted
   * `off` across (positive to the left of the direction). `ends`: draw the end caps. `bottom`: draw the base.
   */
  box(x0, z0, x1, z1, w, y0, y1, { off = 0, ends = true, bottom = true } = {}) {
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1e-5) return;
    const dx = (x1 - x0) / L, dz = (z1 - z0) / L;
    const lx = dz, lz = -dx; // left of the direction seen from above (y up, z south)
    const h = w / 2;
    const P = (t, s, y) => [x0 + dx * t + lx * (off + s), y, z0 + dz * t + lz * (off + s)];
    const u = L / 2, v = w / 2, hh = (y1 - y0) / 2;
    // top (+y), sides, bottom, ends. Corners wound counter-clockwise seen from outside.
    this.quad(P(0, -h, y1), P(0, h, y1), P(L, h, y1), P(L, -h, y1), [0, 1, 0], [[0, 0], [0, v], [u, v], [u, 0]]);
    this.quad(P(0, h, y0), P(L, h, y0), P(L, h, y1), P(0, h, y1), [lx, 0, lz], [[0, 0], [u, 0], [u, hh], [0, hh]]);
    this.quad(P(L, -h, y0), P(0, -h, y0), P(0, -h, y1), P(L, -h, y1), [-lx, 0, -lz], [[0, 0], [u, 0], [u, hh], [0, hh]]);
    if (bottom) this.quad(P(0, -h, y0), P(L, -h, y0), P(L, h, y0), P(0, h, y0), [0, -1, 0], [[0, 0], [u, 0], [u, v], [0, v]]);
    if (ends) {
      this.quad(P(0, -h, y0), P(0, h, y0), P(0, h, y1), P(0, -h, y1), [-dx, 0, -dz], [[0, 0], [v, 0], [v, hh], [0, hh]]);
      this.quad(P(L, h, y0), P(L, -h, y0), P(L, -h, y1), P(L, h, y1), [dx, 0, dz], [[0, 0], [v, 0], [v, hh], [0, hh]]);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Bars: dither out beyond GRATE_NEAR (interleaved gradient noise, fixed to the screen).
const BAR_FADE_V = ['varying vec3 vGrateW;', '\tvGrateW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'];
const BAR_FADE_F = /* glsl */ `
  {
    float gd = length( vGrateW - cameraPosition );
    float gfade = smoothstep( grateNear, grateFar, gd );
    float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( ign < gfade ) discard;
  }
`;

// Far grating: coverage of a pixel by bars, filtered over its footprint.
const COVER_PARS = /* glsl */ `
uniform float grateNear;
uniform float grateFar;
uniform vec2 grateDir;
uniform vec2 grateOrigin;
varying vec3 vGrateW;
// Fraction of [u - fw/2, u + fw/2] covered by pulses [kP, kP + w]: the pulse train's integral, differenced.
float grateCover( float u, float fw, float P, float w ) {
  float a = u - 0.5 * fw, b = u + 0.5 * fw;
  float Fa = floor( a / P ) * w + min( mod( a, P ), w );
  float Fb = floor( b / P ) * w + min( mod( b, P ), w );
  return clamp( ( Fb - Fa ) / fw, 0.0, 1.0 );
}
`;
const COVER_MAIN = /* glsl */ `
  {
    vec2 gq = vGrateW.xz - grateOrigin;
    vec2 gp = vec2( - grateDir.y, grateDir.x ); // across the bearing bars
    // Pattern coordinates, shifted so bar k spans [kP, kP + w].
    float uB = dot( gq, gp ) + ${(GRATE.pitch / 2 + GRATE.barT / 2).toFixed(4)};
    float uC = dot( gq, - grateDir ) + ${(GRATE.crossPitch / 2 + GRATE.crossW / 2).toFixed(4)};
    float fwB = max( fwidth( uB ), 1e-4 );
    float fwC = max( fwidth( uC ), 1e-4 );
    vec3 gV = normalize( cameraPosition - vGrateW );
    float gvy = max( abs( gV.y ), 0.03 );
    // Seen at an angle, a bar hides its depth's worth of gap on one side.
    float wB = min( ${GRATE.barT.toFixed(4)} + ${GRATE.barD.toFixed(4)} * abs( dot( gV.xz, gp ) ) / gvy, ${GRATE.pitch.toFixed(4)} );
    float wC = min( ${GRATE.crossW.toFixed(4)} + ${GRATE.crossW.toFixed(4)} * abs( dot( gV.xz, grateDir ) ) / gvy, ${GRATE.crossPitch.toFixed(4)} );
    float cB = grateCover( uB, fwB, ${GRATE.pitch.toFixed(4)}, wB );
    float cC = grateCover( uC, fwC, ${GRATE.crossPitch.toFixed(4)}, wC );
    float cover = 1.0 - ( 1.0 - cB ) * ( 1.0 - cC );
    // The part of the cover that is bar side, not bar top, is in the bars' own shade.
    float sideShare = clamp( 1.0 - ${GRATE.barT.toFixed(4)} / wB, 0.0, 1.0 ) * cB / max( cover, 1e-3 );
    diffuseColor.rgb *= mix( 1.0, 0.45, sideShare );
    float gd = length( vGrateW - cameraPosition );
    diffuseColor.a = cover * smoothstep( grateNear, grateFar, gd );
    if ( diffuseColor.a < 0.004 ) discard;
  }
`;

function patchVertexWorld(shader) {
  shader.vertexShader = edit(edit(shader.vertexShader, 'void main() {', `${BAR_FADE_V[0]}\nvoid main() {`, 'the grate vertex shader'),
    '#include <project_vertex>', `#include <project_vertex>\n${BAR_FADE_V[1]}`, 'the grate vertex shader');
}

export class Walkway {
  constructor(level) {
    this.plan = walkwayPlan(level);
    this.group = new THREE.Group();
    this.group.name = 'walkway';

    this.barMat = partMaterial(STEEL_GREY);
    this.barMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, fadeUniforms);
      patchVertexWorld(shader);
      shader.fragmentShader = edit(edit(shader.fragmentShader, 'void main() {', 'uniform float grateNear;\nuniform float grateFar;\nvarying vec3 vGrateW;\nvoid main() {', 'the bar fragment shader'),
        '#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${BAR_FADE_F}`, 'the bar fragment shader');
    };
    this.barMat.customProgramCacheKey = () => 'hangar-bars-1';
    this.frameMat = partMaterial(STEEL_GREY);
    this.railMat = partMaterial(STEEL_GREY);
    this.floorMats = new Map(); // sectorId -> coverage material
    // All of the walkway is in one room, so its materials take that room's probe directly (scene.assignProbes).
    for (const m of [this.barMat, this.frameMat, this.railMat]) m.userData.envDirect = true;

    const frame = new Boxes();
    for (const s of this.plan.sectors) {
      const bars = new Boxes();
      const top = s.y, P = [-s.dir[1], s.dir[0]];
      for (const [x0, z0, x1, z1] of barSegments(s.poly, s.dir, GRATE.pitch, 0.01)) bars.box(x0, z0, x1, z1, GRATE.barT, top - GRATE.barD, top, { ends: false });
      for (const [x0, z0, x1, z1] of barSegments(s.poly, P, GRATE.crossPitch, 0.01)) bars.box(x0, z0, x1, z1, GRATE.crossW, top - 0.001 - GRATE.crossW, top - 0.001, { ends: false });
      // Banding bar round the panel, just inside every edge.
      for (const e of s.edges) {
        const n = this.inward(s, e);
        bars.box(e.a[0], e.a[1], e.b[0], e.b[1], GRATE.band, top - GRATE.barD, top - 0.0005, { off: n * GRATE.band / 2 + n * 0.0005 });
      }
      const mesh = new THREE.Mesh(bars.geometry(), this.barMat);
      mesh.layers.set(BAR_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.sector = s.id;
      this.group.add(mesh);
      this.floorMats.set(s.id, this.coverMaterial(s));
    }
    // Stringers under drop edges (C channels: web at the edge, flanges inward), beams under the rest.
    const inwardOf = (b) => b.inward;
    for (const b of this.plan.beams) {
      const [ax, az] = b.a, [bx, bz] = b.b;
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const lx = (bz - az) / L, lz = -(bx - ax) / L; // left of a->b
      const nIn = lx * inwardOf(b)[0] + lz * inwardOf(b)[1] > 0 ? 1 : -1;
      const top = b.y;
      if (b.kind === 'drop') {
        frame.box(ax, az, bx, bz, 0.008, top - b.depth, top, { off: nIn * 0.004 });
        frame.box(ax, az, bx, bz, 0.06, top - GRATE.barD - 0.008, top - GRATE.barD, { off: nIn * 0.03 });
        frame.box(ax, az, bx, bz, 0.075, top - b.depth, top - b.depth + 0.009, { off: nIn * 0.0375 });
      } else {
        frame.box(ax, az, bx, bz, 0.1, top - GRATE.barD - b.depth, top - GRATE.barD - 0.0005, { off: b.kind === 'open' ? 0 : nIn * 0.05 });
      }
    }
    for (const c of this.plan.supports) frame.box(c.x - 0.075, c.z, c.x + 0.075, c.z, 0.15, c.bottom, c.top);
    const fm = new THREE.Mesh(frame.geometry(), this.frameMat);
    fm.castShadow = fm.receiveShadow = true;
    fm.userData.sector = this.plan.sectors[0]?.id;
    this.group.add(fm);

    this.group.add(this.buildRails());
  }

  inward(s, e) {
    const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1;
    const lx = (e.b[1] - e.a[1]) / L, lz = -(e.b[0] - e.a[0]) / L;
    const mx = (e.a[0] + e.b[0]) / 2 + lx * 0.05, mz = (e.a[1] + e.b[1]) / 2 + lz * 0.05;
    // Inside test against the sector polygon (even-odd).
    let c = false;
    for (let i = 0, j = s.poly.length - 1; i < s.poly.length; j = i++) {
      const [xi, zi] = s.poly[i], [xj, zj] = s.poly[j];
      if ((zi > mz) !== (zj > mz) && mx < ((xj - xi) * (mz - zi)) / (zj - zi) + xi) c = !c;
    }
    return c ? 1 : -1;
  }

  /** Posts, top and mid rails (48 mm tube), toe plate, along each railing polyline. */
  buildRails() {
    const geos = [];
    const tube = (a, b, r) => {
      const d = new THREE.Vector3().subVectors(b, a), L = d.length();
      const g = new THREE.CylinderGeometry(r, r, L, 14, 1, false);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 2 * Math.PI * r) / 2, (uv.getY(i) * L) / 2);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      geos.push(g);
    };
    const knuckle = (p, r) => { const g = new THREE.SphereGeometry(r, 12, 8); g.translate(p.x, p.y, p.z); geos.push(g); };
    const toe = new Boxes();
    for (const r of this.plan.rails) {
      const y = r.y, pts = r.points;
      for (const h of [RAIL.top - RAIL.pipeR, RAIL.mid]) {
        for (let i = 1; i < pts.length; i++) tube(new THREE.Vector3(pts[i - 1][0], y + h, pts[i - 1][1]), new THREE.Vector3(pts[i][0], y + h, pts[i][1]), RAIL.pipeR);
        for (let i = 1; i < pts.length - 1; i++) knuckle(new THREE.Vector3(pts[i][0], y + h, pts[i][1]), RAIL.pipeR);
      }
      for (const [x, z] of postPoints(pts)) {
        tube(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + RAIL.top - RAIL.pipeR, z), RAIL.pipeR + 0.003);
        // Base plate bolted to the grating.
        toe.box(x - 0.06, z, x + 0.06, z, 0.12, y, y + 0.008);
      }
      for (let i = 1; i < pts.length; i++) toe.box(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 0.006, y, y + RAIL.toe);
    }
    for (const g of geos) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    geos.push(toe.geometry().toNonIndexed());
    const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, this.railMat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.sector = this.plan.sectors[0]?.id;
    return mesh;
  }

  /** The far grating for one sector's floor polygon (see the header). */
  coverMaterial(s) {
    const m = partMaterial(STEEL_GREY, { side: THREE.DoubleSide });
    m.transparent = true;
    m.depthWrite = false;
    m.userData.envDirect = true;
    const own = { grateDir: { value: new THREE.Vector2(s.dir[0], s.dir[1]) }, grateOrigin: { value: new THREE.Vector2(s.poly[0][0], s.poly[0][1]) } };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, fadeUniforms, own);
      patchVertexWorld(shader);
      shader.fragmentShader = edit(edit(shader.fragmentShader, 'void main() {', `${COVER_PARS}\nvoid main() {`, 'the grating fragment shader'),
        '#include <map_fragment>', `#include <map_fragment>\n${COVER_MAIN}`, 'the grating fragment shader');
    };
    m.customProgramCacheKey = () => 'hangar-grating-1';
    return m;
  }

  /** During the slime's mirror pass the far grating is drawn at every distance (the bars are not there). */
  setMirrorPass(on) {
    fadeUniforms.grateNear.value = on ? -2 : GRATE_NEAR;
    fadeUniforms.grateFar.value = on ? -1 : GRATE_FAR;
  }

  /** Scanned steel arrives: every walkway material wears it. */
  setMaps(maps) {
    for (const m of [this.barMat, this.frameMat, this.railMat, ...this.floorMats.values()]) m.userData.setMaps(maps);
  }

  /** Every material, for the probe assignment. */
  get materials() { return [this.barMat, this.frameMat, this.railMat, ...this.floorMats.values()]; }

  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
  }
}
