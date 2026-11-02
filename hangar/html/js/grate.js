// Hangar — Walkway: real bar grating, its frame, columns and railings over the slime (Ruling R15).
//
// Geometry comes from grateplan.walkwayPlan. Everything is merged into a few meshes (bars per sector, one
// for the frame and columns, one for the railings) wearing the scanned brushed steel (materials.partMaterial,
// so no parallax: the relief is the mesh). Bars, frame and rails cast shadows, so the nearest shadowed lamp
// throws the grid onto the slime below.
//
// Thin bars alias once a 5 mm bar is under a pixel, so the grating has two levels of detail crossfaded by
// distance from the camera (GRATE_NEAR to GRATE_FAR), with no discard and no screen-space noise anywhere:
//   - near: the bar meshes (opaque close by; alpha to coverage, a per-pixel MSAA sample mask, from where the
//     widening starts). A bar never gets thinner on screen than BAR_MIN_PX pixels: its
//     vertex shader widens it to that, and the alpha of its top and bottom drops by the same factor (true
//     width / drawn width; its sides keep their full strength, as their screen size is the bar's depth),
//     so it covers the right share of each pixel (a coverage-preserving prefilter: a wide faint line, not
//     a thin one flickering in and out of samples). Over the band's second half its alpha eases to 0;
//   - far: the walkway's own floor polygon (the nav collider) wears a transparent "grating coverage" material:
//     the fraction of each pixel covered by bars, integrated analytically over the pixel's footprint (a
//     box-filtered pulse train, so it never shimmers), with the bars' depth seen at the view angle (looking
//     across the bearing bars at a low angle, their sides close the gaps, as on a real grating). It fades in
//     as the bars fade out (drawn after them, pulled forward in depth) and shows the slime through the gaps at
//     any distance. At every distance the two together cover what the real grating covers.
// The scanned grate texture (mat:grate and its parallax stopgap) is no longer drawn on the walkway: its
// pattern would not line up with the bars. scene.js keeps it off these floors.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { edit, partMaterial } from './materials.js';
import { walkwayPlan, barSegments, postPoints, GRATE, RAIL } from './grateplan.js';
import { insidePoly } from './wetplan.js';

// The bars are on their own layer: the main camera and the probes see them, the slime's mirror does not (its
// view of the walkway is from below and at least 2 m off, where the far grating stands in at full strength:
// setMirrorPass). That saves the mirror the bars' 90 000 triangles of overdraw.
export const BAR_LAYER = 2;
export const GRATE_NEAR = 4;
export const GRATE_FAR = 6;
export const BAR_MIN_PX = 1.2;
const BAR_PIECE = 1.5; // m: bars are built in pieces this long, so each piece can drop out on its own
// (Bar bottoms are not built: the mirror never sees the bars and the deck is only walked from above.)
const STEEL_GREY = 0x8a9097;

// gratePx: metres per pixel per metre of distance (2 tan(fov / 2) / drawing-buffer height), set each frame.
const fadeUniforms = { grateNear: { value: GRATE_NEAR }, grateFar: { value: GRATE_FAR }, gratePx: { value: 0.0016 }, grateSplit: { value: 2.5 } };

/** Arrays for a merged mesh of boxes. */
class Boxes {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; this.side = []; this.mid = []; }
  quad(a, b, c, d, n, uvs) {
    // Wind counter-clockwise seen from the side the normal points to, whatever order the corners came in.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) { [b, d] = [d, b]; uvs = [uvs[0], uvs[3], uvs[2], uvs[1]]; }
    const o = this.pos.length / 3;
    for (const p of [a, b, c, d]) { this.pos.push(p[0], p[1], p[2]); this.side.push(p[3], p[4], p[5]); this.mid.push(p[6], p[7]); }
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
    // Each corner also carries (direction from the box's centre line out to it, half width): barSide.
    const mx = (x0 + x1) / 2 + lx * off, mz = (z0 + z1) / 2 + lz * off; // and the box's centre: barMid
    const P = (t, s, y) => [x0 + dx * t + lx * (off + s), y, z0 + dz * t + lz * (off + s), Math.sign(s) * lx, Math.sign(s) * lz, h, mx, mz];
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
  geometry(withSide = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withSide) {
      g.setAttribute('barSide', new THREE.Float32BufferAttribute(this.side, 3));
      g.setAttribute('barMid', new THREE.Float32BufferAttribute(this.mid, 2));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Bars: widened to at least BAR_MIN_PX on screen with alpha scaled to keep their coverage, eased out
// across the band. Bar meshes are merged in world space (identity model matrix), so the widening is in x/z.
const BAR_V_PARS = /* glsl */ `
attribute vec3 barSide;
attribute vec2 barMid;
uniform float gratePx;
uniform float grateFar;
uniform float grateSplit;
varying vec3 vGrateW;
varying float vBarAlpha;
`;
const BAR_V_MAIN = /* glsl */ `
#define BAR_PIECE ${BAR_PIECE.toFixed(2)}
  {
    vec3 bw = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    float hw = barSide.z;
    float hv = max( hw, 0.5 * ${BAR_MIN_PX.toFixed(2)} * gratePx * length( bw - cameraPosition ) );
    // Tops and bottoms get wider and fainter; the sides (whose normal runs along barSide) keep their full
    // strength: their size on screen is the bar's depth, which the widening does not change.
    float side = abs( dot( normal.xz, barSide.xy ) );
    vBarAlpha = hw > 0.0 ? mix( hw / hv, 1.0, side ) : 1.0;
    transformed.xz += barSide.xy * ( hv - hw );
    // Past the band the far grating has taken over: a whole piece of bar collapses to its centre, so it is
    // never rasterised (an alpha-0 bar would still be shaded and blended, layer on layer, at a distance
    // where the widened bars overlap).
    // Each piece is drawn by exactly one of the two bar materials, by its centre's distance: the opaque one
    // (BAR_NEAR) up to grateSplit, where no widening has begun (so both draw a piece there the same way),
    // and the blended one from there to the end of the band. Near pieces stay opaque: early depth test,
    // no blending, no overdraw cost where the deck fills the screen.
    float dm = length( vec3( barMid.x, bw.y, barMid.y ) - cameraPosition );
    #ifdef BAR_NEAR
    bool drop = dm > grateSplit;
    #else
    bool drop = dm <= grateSplit || dm > grateFar + BAR_PIECE;
    #endif
    if ( drop ) transformed = vec3( barMid.x, transformed.y, barMid.y );
  }
`;
const BAR_F = /* glsl */ `
  diffuseColor.a = vBarAlpha * ( 1.0 - smoothstep( 0.5 * ( grateNear + grateFar ), grateFar, length( vGrateW - cameraPosition ) ) );
  #ifdef BAR_DITHER
    // Low Power has no MSAA, so alpha to coverage has no samples to share out: an ordered 4x4 dither stands in
    // (a fixed screen pattern, no shimmer from noise), and the bar is opaque where it is drawn.
    ivec2 bp = ivec2( gl_FragCoord.xy ) & 3;
    int bi = bp.x + 4 * bp.y;
    float bt = ( float( ( bi == 0 ? 0 : bi == 1 ? 8 : bi == 2 ? 2 : bi == 3 ? 10 : bi == 4 ? 12 : bi == 5 ? 4 : bi == 6 ? 14 : bi == 7 ? 6
      : bi == 8 ? 3 : bi == 9 ? 11 : bi == 10 ? 1 : bi == 11 ? 9 : bi == 12 ? 15 : bi == 13 ? 7 : bi == 14 ? 13 : 5 ) ) + 0.5 ) / 16.0;
    if ( diffuseColor.a < bt ) discard;
    diffuseColor.a = 1.0;
  #endif
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
    // In over the band's first half, while the bars only leave over its second half: through the band the
    // two overlap (a little too solid at worst) and never leave a see-through gap between them.
    diffuseColor.a = cover * smoothstep( grateNear, 0.5 * ( grateNear + grateFar ), gd );
  }
`;

/** Segments [x0, z0, x1, z1] cut into pieces at most BAR_PIECE long. */
function pieces(segs) {
  const out = [];
  for (const [x0, z0, x1, z1] of segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / BAR_PIECE));
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n, x0 + ((x1 - x0) * (k + 1)) / n, z0 + ((z1 - z0) * (k + 1)) / n]);
  }
  return out;
}

function patchVertexWorld(shader) {
  shader.vertexShader = edit(edit(shader.vertexShader, 'void main() {', 'varying vec3 vGrateW;\nvoid main() {', 'the grate vertex shader'),
    '#include <project_vertex>', '#include <project_vertex>\n\tvGrateW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;', 'the grate vertex shader');
}

export class Walkway {
  constructor(level) {
    this.plan = walkwayPlan(level);
    this.group = new THREE.Group();
    this.group.name = 'walkway';

    this.fade = fadeUniforms; // the shared band uniforms (for inspection from the console)
    this.barMat = this.barMaterial(true);
    this.barMatFar = this.barMaterial(false);
    this.frameMat = partMaterial(STEEL_GREY);
    this.railMat = partMaterial(STEEL_GREY);
    this.floorMats = new Map(); // sectorId -> coverage material
    // All of the walkway is in one room, so its materials take that room's probe directly (scene.assignProbes).
    for (const m of [this.barMat, this.barMatFar, this.frameMat, this.railMat]) m.userData.envDirect = true;
    this.buildBars();
  }

  /**
   * The bars' material: `near` plain opaque (pieces up to grateSplit), else the band's: alpha to coverage,
   * so the alpha (coverage) becomes the share of the pixel's 4 MSAA samples the bar writes. That is a
   * per-pixel hardware coverage mask (no discard, no noise texture), it keeps the bars in the opaque pass
   * with early depth test, and costs a third of blending them (measured 25 vs 33 ms a frame at the landing:
   * blended bars shade every side behind the front one).
   */
  barMaterial(near) {
    const m = partMaterial(STEEL_GREY);
    if (near) m.defines = { ...(m.defines ?? {}), BAR_NEAR: '' };
    else m.alphaToCoverage = true;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, fadeUniforms);
      let vs = shader.vertexShader;
      vs = edit(vs, 'void main() {', `${BAR_V_PARS}\nvoid main() {`, 'the bar vertex shader');
      vs = edit(vs, '#include <begin_vertex>', `#include <begin_vertex>\n${BAR_V_MAIN}`, 'the bar vertex shader');
      vs = edit(vs, '#include <project_vertex>', '#include <project_vertex>\n\tvGrateW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;', 'the bar vertex shader');
      shader.vertexShader = vs;
      shader.fragmentShader = edit(edit(shader.fragmentShader, 'void main() {', 'uniform float grateNear;\nuniform float grateFar;\nvarying vec3 vGrateW;\nvarying float vBarAlpha;\nvoid main() {', 'the bar fragment shader'),
        '#include <map_fragment>', `#include <map_fragment>\n${BAR_F}`, 'the bar fragment shader');
    };
    m.customProgramCacheKey = () => `hangar-bars-3${near ? '-near' : ''}`;
    return m;
  }

  buildBars() {
    const frame = new Boxes();
    for (const s of this.plan.sectors) {
      const bars = new Boxes();
      const top = s.y, P = [-s.dir[1], s.dir[0]];
      for (const [x0, z0, x1, z1] of pieces(barSegments(s.poly, s.dir, GRATE.pitch, 0.01))) bars.box(x0, z0, x1, z1, GRATE.barT, top - GRATE.barD, top, { ends: false, bottom: false });
      for (const [x0, z0, x1, z1] of pieces(barSegments(s.poly, P, GRATE.crossPitch, 0.01))) bars.box(x0, z0, x1, z1, GRATE.crossW, top - 0.001 - GRATE.crossW, top - 0.001, { ends: false, bottom: false });
      // Banding bar round the panel, just inside every edge.
      for (const e of s.edges) {
        const n = this.inward(s, e);
        for (const [x0, z0, x1, z1] of pieces([[e.a[0], e.a[1], e.b[0], e.b[1]]])) bars.box(x0, z0, x1, z1, GRATE.band, top - GRATE.barD, top - 0.0005, { off: n * GRATE.band / 2 + n * 0.0005 });
      }
      const geo = bars.geometry(true);
      for (const near of [true, false]) {
        const mesh = new THREE.Mesh(geo, near ? this.barMat : this.barMatFar);
        mesh.layers.set(BAR_LAYER);

        mesh.castShadow = near; // the depth pass draws every piece in full: one caster is enough
        mesh.receiveShadow = true;
        mesh.userData.sector = s.id;
        this.group.add(mesh);
      }
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
    return insidePoly(s.poly, mx, mz) ? 1 : -1;
  }

  /** Posts (49 mm tube), top and mid rails (43 mm tube, RAIL.pipeR), toe plate, along each railing polyline. */
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
    // Transparent, so drawn after the (opaque) bars, and pulled forward a little in depth,
    // so it lies over the bar tops it shares a plane with.
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -4;
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

  /** Each frame before rendering: the screen's pixel size for the bars' minimum width. */
  update(camera, renderer) {
    const h = renderer.getDrawingBufferSize(this.tmpSize ??= new THREE.Vector2()).y || 1;
    fadeUniforms.gratePx.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
    // Where a bearing bar starts to need widening (the narrowest bar), less a piece, and never past the band.
    const widen = Math.min(GRATE.barT, GRATE.crossW) / (BAR_MIN_PX * fadeUniforms.gratePx.value);
    fadeUniforms.grateSplit.value = Math.min(widen - BAR_PIECE, GRATE_NEAR);
  }

  /**
   * Low Power (no MSAA): the far bars dither instead of using alpha to coverage, which needs samples to work and
   * would otherwise draw them solid out to the end of the band, where they'd stop at a hard line.
   */
  setDither(on) {
    const m = this.barMatFar;
    if ('BAR_DITHER' in (m.defines ?? {}) === !!on) return;
    m.defines = { ...(m.defines ?? {}) };
    if (on) m.defines.BAR_DITHER = ''; else delete m.defines.BAR_DITHER;
    m.alphaToCoverage = !on;
    m.needsUpdate = true;
  }

  /** During the slime's mirror pass the far grating is drawn at every distance (the bars are not there). */
  setMirrorPass(on) {
    fadeUniforms.grateNear.value = on ? -2 : GRATE_NEAR;
    fadeUniforms.grateFar.value = on ? -1 : GRATE_FAR;
  }

  /** Scanned steel arrives: every walkway material wears it. */
  setMaps(maps) {
    for (const m of this.materials) m.userData.setMaps(maps);
  }

  /** Every material, for the probe assignment. */
  get materials() { return [this.barMat, this.barMatFar, this.frameMat, this.railMat, ...this.floorMats.values()]; }

  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
  }
}
