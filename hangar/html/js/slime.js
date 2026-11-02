// Hangar — Slime: the glowing toxic pools, their mirror pass and the green light they throw.
//
// One flat surface per `slime` sector, SLIME_DROP below its floor (the sector's own floor is hidden; scene.js
// hangs a skirt of wall below every pool edge so nothing shows under the rim). The surface is a standard
// material patched three ways:
//   - slow analytic ripples (six travelling waves, wavelengths 0.3 to 1.5 m, phase speeds 0.04 to 0.08 m/s)
//     bend the shading normal. Time wraps hourly and every wave's frequency is a whole number of cycles per
//     hour, so the wrap is seamless; a wave fades out where a pixel covers more than a sixth of it;
//   - murk: two layers of a tileable fBm field drifting a whole number of tiles per hour set where the liquid
//     is deep and dark (dim, blue-green glow), where it glows through brightly (yellow-green, above the base
//     value) and where a film of scum floats (the only lit, diffuse part; it dims the glow under it). The
//     glow's base value is #5fe23a at 2.5 (the brief's), modulated 0.3x to 1.45x by the murk and +-15% by two
//     slow swells; none of it changes under Emergency Power. Open liquid is near-black and glossy;
//   - a planar mirror: the scene rendered from the camera reflected in the plane, with the projection's near
//     plane made oblique at the surface (as three's Reflector does) so nothing under the slime reflects.
//     Everything the surface gives off (glow, scum, specular) gives way to the reflection by a Schlick
//     Fresnel term (F0 0.65: the glow sits under an oily film; at water's 0.04 a 1.9-bright glow drowned every
//     reflection but a lamp's), distorted by the ripple normal. So the walkway, rails and columns show as a
//     dark band in the pool and lamps as bright ripples.
// Pools at different heights would each need their own mirror; one render target (half the drawing buffer
// per side: it is rippled) serves the nearest pool in view each frame that is in the camera's room or within
// MIRROR_REACH, scissored to the pool's box on screen. Other pools fall back to their room probe (mirrorMix 0);
// changing pools, the mirror fades out of the old one and into the new one over MIRROR_FADE s each.
// The green light: the plan is one point light per SLIME_LIGHT_SPACING m square of pool, under the walkway
// too (wetplan.slimeLightPoints); pooled like the lamps, the SLIME_SLOTS nearest are live and fade in and
// out, unshadowed, range 8 m, 0.8 m above the surface, so walls, columns and the walkway's underside glow
// from below. The open liquid is near-black, so they barely light the surface they float over.

import * as THREE from 'three';
import { edit, macroTexture } from './materials.js';
import { slimeLightPoints, slimeUnder, SLIME_DROP } from './wetplan.js';
import { pickNearest, updateSlots, lightRooms } from './lightplan.js';
import { sectorAt } from './level.js';

export const SLIME_LAYER = 1; // the slime surfaces: seen by the main camera and probes, never by the mirror
export const SLIME_COLOR = 0x5fe23a;
export const SLIME_GLOW = 2.5;
export const SLIME_SLOTS = 3;
const SLIME_CD = 9; // candela per glow light (the pool lights its walls strongly; the walls are the bright backdrop the walkway reflects dark against)
const PROBE_GLOW = 0.25; // the slime's glow as the room probes see it (see setProbeMode)
const SLIME_RANGE = 8;
export const MIRROR_SCALE = 0.5; // mirror target per side, relative to the drawing buffer (it is rippled)
const CLIP_BIAS = 0.003;
const MIRROR_REACH = 8; // m
const MIRROR_FADE = 0.5; // s
const MIN_SCREEN_SHARE = 0.004; // pools smaller than this share of the screen are not mirrored
const MIRROR_MARGIN = 0.04; // screen fraction added round a pool's box for the ripples' distortion

// [direction x, z (normalised in the shader), wavelength m, amplitude m, cycles per hour]. Speed = L * c / 3600.
const WAVES = [
  [1.0, 0.31, 1.5, 0.0085, 173], // 0.072 m/s
  [-0.42, 1.0, 1.13, 0.0062, 166], // 0.052
  [0.77, -0.64, 0.82, 0.0042, 290], // 0.066
  [-0.95, -0.3, 0.57, 0.0027, 290], // 0.046
  [0.2, -1.0, 0.41, 0.0019, 650], // 0.074
  [0.66, 0.75, 0.3, 0.0013, 528], // 0.044
];

const PARS_V = /* glsl */ `
uniform mat4 mirrorMatrix;
varying vec3 vSlimeW;
varying vec4 vMirror;
`;
const PARS_F = /* glsl */ `
#define SLIME_F0 0.65
uniform float slimeTime;
uniform sampler2D mirrorMap;
uniform float mirrorMix;
uniform sampler2D slimeMurkMap;
varying vec3 vSlimeW;
varying vec4 vMirror;
vec3 slimeNW;
float slimeMurk; // 0 deep, dark murk .. 1 a bright glowing patch
float slimeFilm; // 0 open liquid .. 1 under a floating film of scum
// Adds one travelling wave's slope to g. fp is the pixel footprint in metres: a wave a pixel cannot resolve
// fades out instead of aliasing.
void slimeWave( inout vec2 g, vec2 p, vec2 d, float L, float A, float cyc, float fp ) {
  float k = 6.2831853 / L;
  float fade = clamp( 1.5 - fp * 6.0 / L, 0.0, 1.0 );
  float ph = k * dot( d, p ) - 6.2831853 * cyc * slimeTime / 3600.0;
  g += d * ( cos( ph ) * k * A * fade );
}
`;
const waveCalls = WAVES.map(([x, z, L, A, c]) => {
  const n = Math.hypot(x, z);
  return `  slimeWave( sg, vSlimeW.xz, vec2( ${(x / n).toFixed(5)}, ${(z / n).toFixed(5)} ), ${L.toFixed(3)}, ${A.toFixed(5)}, ${c.toFixed(1)}, sfp );`;
}).join('\n');
const NORMAL = /* glsl */ `
  {
    vec2 sg = vec2( 0.0 );
    float sfp = max( length( dFdx( vSlimeW.xz ) ), length( dFdy( vSlimeW.xz ) ) );
${waveCalls}
    slimeNW = normalize( vec3( - sg.x, 1.0, - sg.y ) );
    normal = normalize( ( viewMatrix * vec4( slimeNW, 0.0 ) ).xyz );
  }
`;
// Murk: two layers of the page's tileable fBm field (materials.macroTexture, mipmapped, so nothing
// shimmers), 11 m and 4.3 m across, drifting by a whole number of tiles per hour (0.007 and 0.004 m/s),
// so the hourly wrap is seamless. They set where the liquid is deep and dark, where it glows through
// brightly, and where a film of scum floats on it. The film is the only lit, diffuse part; open liquid is
// near-black glossy (it takes the lamps only as specular and mirror).
const MURK = /* glsl */ `
  {
    float tH = slimeTime / 3600.0;
    vec4 ma = texture2D( slimeMurkMap, vSlimeW.xz / 11.0 + vec2( 1.0, 2.0 ) * tH );
    vec4 mb = texture2D( slimeMurkMap, mat2( 0.8, 0.6, - 0.6, 0.8 ) * vSlimeW.xz / 4.3 + vec2( - 3.0, 1.0 ) * tH );
    slimeMurk = smoothstep( 0.22, 0.78, 0.65 * ma.r + 0.35 * mb.r );
    slimeFilm = smoothstep( 0.6, 0.8, 0.55 * ma.g + 0.45 * mb.g );
    diffuseColor.rgb = mix( vec3( 0.012, 0.02, 0.008 ), vec3( 0.075, 0.085, 0.04 ), slimeFilm );
  }
`;
// Glow: deep murk is dim and blue-green, bright patches are yellow-green and above the base value; a
// film dims what is under it. Plus two slow crossing swells of +-15%, whole cycles per hour.
const GLOW = /* glsl */ `
  {
    float sw = sin( dot( vSlimeW.xz, vec2( 0.53, 0.21 ) ) + 6.2831853 * 7.0 * slimeTime / 3600.0 )
             * sin( dot( vSlimeW.xz, vec2( -0.17, 0.61 ) ) - 6.2831853 * 5.0 * slimeTime / 3600.0 );
    vec3 deep = totalEmissiveRadiance * vec3( 0.35, 0.75, 0.65 );
    vec3 bright = totalEmissiveRadiance * vec3( 1.3, 1.05, 0.6 );
    totalEmissiveRadiance = mix( deep, bright, slimeMurk ) * mix( 0.3, 1.45, slimeMurk ) * ( 1.0 - 0.75 * slimeFilm );
    totalEmissiveRadiance *= 1.0 + 0.15 * sw;
  }
`;
const MIRROR = /* glsl */ `
  {
    vec3 sV = normalize( cameraPosition - vSlimeW );
    float sc = clamp( dot( slimeNW, sV ), 0.0, 1.0 );
    float sF = SLIME_F0 + ( 1.0 - SLIME_F0 ) * pow( 1.0 - sc, 5.0 );
    vec4 mc = vMirror;
    mc.xy += slimeNW.xz * 0.05 * mc.w;
    vec3 refl = max( texture2DProj( mirrorMap, mc ).rgb, vec3( 0.0 ) );
    if ( any( isnan( refl ) ) || any( isinf( refl ) ) ) refl = vec3( 0.0 );
    // Everything the surface gives off (scum, glow, its own specular) gives way to the mirror by Fresnel,
    // so the walkway, rails and columns over it show as a dark band.
    outgoingLight = mix( totalDiffuse + totalSpecular + totalEmissiveRadiance, refl, sF * mirrorMix );
  }
`;

function flatGeometry(poly, y) {
  const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
  const pos = [], nrm = [], uv = [];
  for (const t of tris) {
    let [a, b, c] = t.map((i) => poly[i]);
    if ((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) <= 0) [b, c] = [c, b]; // face up
    for (const [x, z] of [a, b, c]) { pos.push(x, y, z); nrm.push(0, 1, 0); uv.push(x / 2, z / 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export class Slime {
  constructor(level, renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'slime';
    scene.add(this.group);
    this.shared = { slimeTime: { value: 0 }, mirrorMap: { value: null }, mirrorMatrix: { value: new THREE.Matrix4() }, slimeMurkMap: { value: macroTexture() } };
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(buf.x * MIRROR_SCALE)), Math.max(1, Math.round(buf.y * MIRROR_SCALE)), {
      type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace, generateMipmaps: false,
    });
    this.target.texture.name = 'slime-mirror';
    this.shared.mirrorMap.value = this.target.texture;

    // One plane per distinct surface height (pools at the same level share a material and a mirror).
    const byY = new Map();
    const under = slimeUnder(level); // the slime also runs on under the walkway's open grating
    for (const s of level.sectors.filter((t) => t.tags.has('slime') || under.has(t.id))) {
      const y = +(s.tags.has('slime') ? s.floor - SLIME_DROP : under.get(s.id)).toFixed(4);
      if (!byY.has(y)) byY.set(y, { y, meshes: [], box: new THREE.Box3(), material: this.makeMaterial() });
      const p = byY.get(y);
      const mesh = new THREE.Mesh(flatGeometry(s.poly, y), p.material);
      mesh.layers.set(SLIME_LAYER);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.sector = s.id;
      mesh.userData.slime = true;
      this.group.add(mesh);
      p.meshes.push(mesh);
      p.box.union(mesh.geometry.boundingBox);
    }
    this.planes = [...byY.values()];
    this.level = level;
    this.rooms = lightRooms(level);
    for (const p of this.planes) p.roomSet = new Set(p.meshes.map((m) => this.rooms.get(m.userData.sector)));
    this.active = null;

    this.points = slimeLightPoints(level);
    this.slots = Array.from({ length: SLIME_SLOTS }, () => {
      const l = new THREE.PointLight(SLIME_COLOR, 0, SLIME_RANGE, 2);
      l.castShadow = false;
      scene.add(l);
      return { light: l, id: null, w: 0 };
    });

    this.mirrorCam = new THREE.PerspectiveCamera();
    this.mirrorCam.layers.set(0); // not SLIME_LAYER: the slime never reflects itself
    this.frustum = new THREE.Frustum();
    this.tmp = { m: new THREE.Matrix4(), v: new THREE.Vector3(), w: new THREE.Vector3(), t: new THREE.Vector3(), plane: new THREE.Plane(), clip: new THREE.Vector4(), q: new THREE.Vector4() };
  }

  makeMaterial() {
    const m = new THREE.MeshStandardMaterial({
      name: 'slime', color: 0xffffff, roughness: 0.14, metalness: 0,
      emissive: SLIME_COLOR, emissiveIntensity: SLIME_GLOW,
    });
    const own = { mirrorMix: { value: 0 } };
    m.userData.slime = own;
    m.userData.envDirect = true;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.shared, own); // by reference: one clock and one mirror for all pools
      let vs = shader.vertexShader, fs = shader.fragmentShader;
      vs = edit(vs, 'void main() {', `${PARS_V}\nvoid main() {`, 'the slime vertex shader');
      vs = edit(vs, '#include <project_vertex>', '#include <project_vertex>\n\tvSlimeW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvMirror = mirrorMatrix * vec4( vSlimeW, 1.0 );', 'the slime vertex shader');
      fs = edit(fs, 'void main() {', `${PARS_F}\nvoid main() {`, 'the slime fragment shader');
      fs = edit(fs, '#include <color_fragment>', `#include <color_fragment>\n${MURK}`, 'the slime fragment shader');
      fs = edit(fs, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${NORMAL}`, 'the slime fragment shader');
      fs = edit(fs, '#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLOW}`, 'the slime fragment shader');
      fs = edit(fs, 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', `vec3 outgoingLight;\n${MIRROR}`, 'the slime fragment shader');
      shader.vertexShader = vs;
      shader.fragmentShader = fs; // written back (guidelines section 4)
    };
    m.customProgramCacheKey = () => 'hangar-slime-2';
    return m;
  }

  /** Every slime material (scene.js gives each its room probe). */
  get materials() { return this.planes.map((p) => p.material); }

  /**
   * Probe bakes. The mirror is set up for the main camera only, so cube faces see plain slime; and the glow
   * is dimmed to PROBE_GLOW of itself there. A probe is one point per room, so a pool at full glow in it lit
   * every wall of the hall the same flat green up to the ceiling (its diffuse term); the glow's light on the
   * walls comes from the point lights instead, which fall off with height and distance as it should.
   */
  setProbeMode(on) {
    if (on) {
      this.saved = this.planes.map((p) => p.material.userData.slime.mirrorMix.value);
      for (const p of this.planes) { p.material.userData.slime.mirrorMix.value = 0; p.material.emissiveIntensity = SLIME_GLOW * PROBE_GLOW; }
    } else if (this.saved) {
      this.planes.forEach((p, i) => { p.material.userData.slime.mirrorMix.value = this.saved[i]; p.material.emissiveIntensity = SLIME_GLOW; });
      this.saved = null;
    }
  }

  /** dt in s; camera the main camera (picks the pool to mirror and the live glow lights). */
  update(dt, camera) {
    this.time = (this.time + dt) % 3600; // hourly wrap; every frequency is whole cycles per hour
    this.shared.slimeTime.value = this.time;
    const cp = camera.position;
    updateSlots(this.slots, pickNearest(this.points, cp, SLIME_SLOTS), dt, 0.8);
    for (const s of this.slots) {
      if (s.id === null) { s.light.intensity = 0; continue; }
      const p = this.points[s.id];
      s.light.position.set(p.x, p.y, p.z);
      s.light.intensity = SLIME_CD * (p.power ?? 1) * s.w * s.w * (3 - 2 * s.w);
    }
    // The pool to mirror: in view, below the eye, nearest.
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.tmp.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let best = null, bd = Infinity;
    const cs = sectorAt(this.level, cp.x, cp.z), camRoom = cs ? this.rooms.get(cs.id) : null;
    for (const p of this.planes) {
      if (cp.y < p.y + 0.02 || !this.frustum.intersectsBox(p.box)) continue;
      // Mirror a pool from its own room or from close by; seen through a far window, the probe will do.
      const d = p.box.distanceToPoint(cp);
      if (d > MIRROR_REACH && !p.roomSet.has(camRoom)) continue;
      const rect = this.screenRect(p, camera);
      p.rect = rect;
      if (rect.area < MIN_SCREEN_SHARE) continue; // a sliver through a far window: the probe will do
      if (d < bd) { bd = d; best = p; }
    }
    // The mirror serves one pool at a time. Changing pools, the one it serves fades out first (still mirrored),
    // then the new one fades in, MIRROR_FADE s each way, so no pool's reflection pops on or off.
    const step = dt / MIRROR_FADE;
    const mix = (p) => p.material.userData.slime.mirrorMix;
    if (this.active && this.active !== best) {
      mix(this.active).value = Math.max(0, mix(this.active).value - step);
      if (mix(this.active).value === 0) this.active = null;
    }
    if (!this.active && best) this.active = best;
    if (this.active && this.active === best) mix(this.active).value = Math.min(1, mix(this.active).value + step);
    for (const p of this.planes) if (p !== this.active) mix(p).value = 0;
  }

  /**
   * The pool's bounding box on screen, as fractions of the screen { x0, y0, x1, y1, area }, widened by
   * MIRROR_MARGIN for the ripple's distortion. A box reaching behind the camera counts as the whole screen.
   */
  screenRect(p, camera) {
    const b = p.box, v = this.tmp.v;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(camera.matrixWorldInverse);
      if (v.z > -camera.near) return { x0: 0, y0: 0, x1: 1, y1: 1, area: 1 };
      v.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const c = (t) => Math.min(1, Math.max(0, t));
    const r = { x0: c((x0 + 1) / 2 - MIRROR_MARGIN), y0: c((y0 + 1) / 2 - MIRROR_MARGIN), x1: c((x1 + 1) / 2 + MIRROR_MARGIN), y1: c((y1 + 1) / 2 + MIRROR_MARGIN) };
    r.area = Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
    return r;
  }

  /** Renders the mirror for the active pool (call before the main pass; it never re-renders shadow maps). */
  render(camera) {
    const p = this.active;
    if (!p || p.material.userData.slime.mirrorMix.value <= 0) return;
    const r = this.renderer, t = this.tmp, vc = this.mirrorCam;
    const buf = r.getDrawingBufferSize(t.v);
    const w = Math.max(1, Math.round(buf.x * MIRROR_SCALE)), h = Math.max(1, Math.round(buf.y * MIRROR_SCALE));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    // Reflect the camera in the plane y = p.y (three's Reflector, for a horizontal mirror).
    const cp = t.w.setFromMatrixPosition(camera.matrixWorld);
    vc.position.set(cp.x, 2 * p.y - cp.y, cp.z);
    const look = t.t.set(0, 0, -1).applyMatrix4(t.m.extractRotation(camera.matrixWorld)).add(cp);
    look.y = 2 * p.y - look.y;
    const up = t.v.set(0, 1, 0).applyMatrix4(t.m).reflect(new THREE.Vector3(0, 1, 0));
    vc.up.copy(up);
    vc.lookAt(look);
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    this.shared.mirrorMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // Oblique near plane at the slime surface (Lengyel), so geometry below it is clipped.
    t.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, p.y, 0)).applyMatrix4(vc.matrixWorldInverse);
    const clip = t.clip.set(t.plane.normal.x, t.plane.normal.y, t.plane.normal.z, t.plane.constant);
    const e = vc.projectionMatrix.elements;
    t.q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(t.q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - CLIP_BIAS; e[14] = clip.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

    // Only the pool's part of the screen: the mirror texture is screen-aligned, so nothing outside it is read.
    const rc = p.rect ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.target.scissor.set(Math.floor(rc.x0 * w), Math.floor(rc.y0 * h), Math.ceil((rc.x1 - rc.x0) * w) + 1, Math.ceil((rc.y1 - rc.y0) * h) + 1);
    this.target.scissorTest = true;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.state.buffers.depth.setMask(true);
    r.clear();
    r.render(this.scene, vc);
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.target.dispose();
    for (const p of this.planes) { p.material.dispose(); for (const m of p.meshes) m.geometry.dispose(); }
    for (const s of this.slots) s.light.dispose?.();
  }
}
