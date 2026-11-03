// Hangar — Phobos sky: Mars, the sun, the stars, the ground outside and the outside of the base.
//
// new PhobosSky(scene, assets, rng, { level, renderer, edges?, shell? }) adds everything to the THREE.Scene
// (edges and shell: phobos.openEdges / planShell, when the caller already made them); update(dt, camera)
// turns Mars (slowly: the face it shows drifts by a full turn every 11 hours, as it does from Phobos) and keeps
// the stars sized for the pixel ratio; setAsset(kind, name, asset) takes the Mars mosaic, the regolith and
// concrete scans and the boulder models as they stream in. `assets` is the map of items that arrived before
// (app.assetItems); the sky works on stand-ins until each arrives.
//
// The real sky (phobos.skyOrientation turns it so the galactic centre hangs beside Mars, away from the sun):
// the Hipparcos stars as points, the NASA SVS Milky Way on a sphere; opts.data (loadSkyData) brings the
// catalogue and the real ground's heights, and without them the sky and ground fall back to made-up ones.
//
// The sky (stars, the sun's disc, Mars) is drawn first, with no depth test, in a frame that moves with
// whichever camera renders it (main view, probe faces, the slime's mirror): positions are directions times a
// fixed distance, rotated by the camera but never translated, and pushed to the far plane, so it is
// infinitely far for every camera and everything else simply draws over it.
//
// Mars is a sphere 42.4° across (3390 km radius at 9376 km), about 25° up in the direction the windows and the
// courtyard face (phobos.marsDirection), wearing the Viking MDIM2.1 mosaic, lit by the same sun as the ground
// from 100° of azimuth to one side, so a terminator crosses it. Its relief comes from the mosaic's own
// luminance gradient (it brings out craters and canyons near the terminator) and the mosaic is sharpened
// slightly against its next mip, so at fov 15° the surface reads crisp rather than smeared.
//
// The sun: a DirectionalLight (white, 6) 30° up, with one 4096 shadow map fitted to the base and a margin
// round it, rendered only when something in it changes (shadow.autoUpdate off, needsUpdate on demand: the base
// is static; call refreshShadow() when something in it moves), inside the one per-frame shadow update
// scene.render() already does. Boulders beyond that box get a planar shadow: the rock projected onto its
// ground plane along the sun, multiplied in. Near boulders are the two scans; far ones a 320-triangle lump.
// Terrain and boulders use an outdoor shader (sun, shadow, fill, Mars's warm light) instead of the standard
// one, which would make every outdoor pixel pay for the interior's lamps; Emergency Power never reaches them.
//
// Ground: phobos.makeTerrain's heightfield as a 1 m grid round the base (with a skirt) and a polar mesh out to
// 2 km whose rings widen with distance (the inner rings close onto the grid's edge), both cut into chunks that
// share one vertex buffer so every camera culls them. The grid discards
// fragments inside the base's footprint (a 5 cm mask), so the courtyard floor, the pits and the rooms are
// the level's own; the exterior sectors' floors are the terrain itself. With the real ground (phobos.js)
// its de-shaded 0.5 m photograph is the albedo and its 2 m normals light the far mesh's craters (see the
// GROUND parts of the outdoor shader); otherwise: regolith scan, with an albedo
// multiplier per vertex (crater ejecta, groove floors, dust patches) and the scan's own large-scale
// luminance re-sampled at 13x to break its repeat. The base's outside (façades, roofs, parapets) is
// phobos.planShell in the stained concrete scan.

import * as THREE from 'three';
import {
  makeTerrain, marsDirection, sunDirection, openEdges, planShell, scatterBoulders, marsAngularDiameter,
  SUN_INTENSITY, TERRAIN_REACH, decodeGround, decodeStars, skyOrientation,
} from './phobos.js';
import { makeMaterial } from './materials.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// The data files carry this module's own ?v= (from the import map), like the level data.
const VERSION = new URL(import.meta.url).searchParams.get('v');
const versioned = (url) => (VERSION ? `${url}?v=${VERSION}` : url);
let skyData = null;

/**
 * The real ground's heights (data/ground.bin) and the star catalogue (data/stars.bin), fetched once for the
 * page (reseeds reuse them): { ground, stars }. Never rejects: a file that fails is null, and the sky falls
 * back to made-up ground or stars.
 */
export function loadSkyData() {
  const get = (url, decode) => fetch(versioned(url))
    .then((r) => { if (!r.ok) throw new Error(`${r.url} returned HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(decode)
    .catch((err) => { console.warn(`Hangar: ${url} unavailable, using a stand-in`, err); return null; });
  skyData ??= Promise.all([get('./data/ground.bin', decodeGround), get('./data/stars.bin', decodeStars)])
    .then(([ground, stars]) => ({ ground, stars }));
  return skyData;
}

export const SKY_DISTANCE = 100; // m: radius of the camera-relative sky frame (anything inside the far plane)
export const SUN_SHADOW_SIZE = 4096;
export const SHADOW_MARGIN = 15; // m round the base inside the sun's shadow map
const MARS_TURN_S = 11.1 * 3600; // s for Mars to show a full turn from Phobos
const NEAR_STEP = 1; // m, the grid round the base
const NEAR_MARGIN = 60; // m beyond the base on every side
const FAR_RINGS = 120, FAR_SEGMENTS = 720;
const MASK_RES = 0.05; // m per mask pixel
const SHADOW_TINT = 0.08; // what a planar shadow leaves of the sunlit ground (ambient only, airless)
// Phobos is dark (albedo about 0.07): the moon scan, light grey, is scaled down to it on the open ground.
const STAND_IN = new THREE.Color().setRGB(0.07, 0.066, 0.062);
const REGOLITH_TINT = new THREE.Color().setRGB(0.2, 0.19, 0.18);
const ROCK_TINT = new THREE.Color().setRGB(0.32, 0.31, 0.3); // the scanned rocks, darkened to match

const SKY_VERT = /* glsl */ `
// Camera-relative: rotate by the view, never translate, and sit on the far plane.
vec4 skyPosition( vec3 w ) {
  vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * w, 1.0 );
  p.z = p.w * 0.99999;
  return p;
}
`;

const MARS_VERT = /* glsl */ `
${SKY_VERT}
varying vec3 vMarsN;
varying vec3 vMarsW;
varying vec2 vMarsUv;
void main() {
  vec3 w = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vMarsW = w;
  vMarsN = mat3( modelMatrix ) * normal;
  vMarsUv = uv;
  gl_Position = skyPosition( w );
}
`;

const MARS_FRAG = /* glsl */ `
uniform sampler2D marsMap;
uniform float marsHasMap;
uniform vec3 marsSun;
uniform float marsSunI;
uniform vec3 marsPole;
uniform vec2 marsTexel;
varying vec3 vMarsN;
varying vec3 vMarsW;
varying vec2 vMarsUv;
float marsLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
void main() {
  vec3 N = normalize( vMarsN );
  vec3 V = normalize( - vMarsW );
  vec3 albedo = vec3( 0.30, 0.12, 0.05 );
  vec3 Ns = N;
  if ( marsHasMap > 0.5 ) {
    vec3 c = texture2D( marsMap, vMarsUv ).rgb;
    // Gentle unsharp mask against the next mip up: the mosaic is magnified at narrow fields of view.
    vec3 b = texture2D( marsMap, vMarsUv, 1.0 ).rgb;
    albedo = max( c + 0.45 * ( c - b ), vec3( 0.0 ) );
    // Relief from the mosaic's luminance gradient along east (u) and north (v).
    float l0 = marsLum( c );
    float lu = marsLum( texture2D( marsMap, vMarsUv + vec2( marsTexel.x, 0.0 ) ).rgb ) - l0;
    float lv = marsLum( texture2D( marsMap, vMarsUv + vec2( 0.0, marsTexel.y ) ).rgb ) - l0;
    vec3 E = cross( marsPole, N );
    float el = length( E );
    if ( el > 1e-4 ) {
      E /= el;
      vec3 Nn = cross( N, E );
      Ns = normalize( N - 1.2 * ( lu * E + lv * Nn ) );
    }
  }
  float ndl = dot( Ns, marsSun );
  // Relief may tilt a slope into the light just past the terminator, not deep into the night side.
  float lit = max( ndl, 0.0 ) * smoothstep( -0.08, 0.04, dot( N, marsSun ) );
  // Lambert in three's units (radiance = albedo / pi x irradiance), as the ground gets it.
  vec3 col = albedo * marsSunI * lit * 0.31831;
  // A thin dusty limb on the day side.
  float rim = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 );
  col += vec3( 0.9, 0.5, 0.3 ) * rim * smoothstep( -0.15, 0.35, dot( N, marsSun ) ) * 0.35;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Washed out round Mars (its glare and its disc) and the sun: shared by the stars and the Milky Way.
const SKY_WASH = /* glsl */ `
uniform vec3 starMars;
uniform float starMarsCos;
uniform vec3 starSun;
float skyWash( vec3 d ) {
  float m = dot( d, starMars );
  float s = dot( d, starSun );
  return ( 1.0 - smoothstep( starMarsCos - 0.03, starMarsCos, m ) ) * ( 1.0 - smoothstep( 0.55, 0.96, s ) );
}
`;

// Stars: the Hipparcos catalogue (or a made-up stand-in), each at its V magnitude. Brightness steps 1.51x a
// magnitude instead of the true 2.512x (flux to the 0.45), so the naked-eye stars stand out and
// the faint ones down to V 12 still dust the sky, as in a long exposure; the brightest grow a little.
const STAR_VERT = /* glsl */ `
${SKY_VERT}
${SKY_WASH}
attribute float mag;
attribute vec3 starColor;
uniform float starScale;
uniform float starGain;
varying vec3 vStar;
void main() {
  vec3 w = mat3( modelMatrix ) * position;
  float b = starGain * exp2( - 0.6 * mag ) * skyWash( normalize( w ) );
  float big = clamp( ( 2.0 - mag ) / 3.5, 0.0, 1.0 );
  vStar = starColor * min( b, 1.6 );
  gl_PointSize = starScale * ( 1.7 + 2.6 * big );
  gl_Position = b < 0.002 ? vec4( 2.0, 2.0, 2.0, 1.0 ) : skyPosition( w );
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vStar;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = exp( - 3.0 * dot( q, q ) );
  gl_FragColor = vec4( vStar * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// The Milky Way: NASA SVS's Deep Star Maps 2020 (Gaia DR2), without its Hipparcos and Tycho stars (those are
// the points above), on a sphere turned by the same rotation as the stars.
const MW_VERT = /* glsl */ `
${SKY_VERT}
varying vec2 vMwUv;
varying vec3 vMwDir;
void main() {
  vMwUv = uv;
  vMwDir = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  gl_Position = skyPosition( vMwDir );
}
`;

const MW_FRAG = /* glsl */ `
${SKY_WASH}
uniform sampler2D mwMap;
uniform float mwGain;
varying vec2 vMwUv;
varying vec3 vMwDir;
void main() {
  gl_FragColor = vec4( texture2D( mwMap, vMwUv ).rgb * mwGain * skyWash( normalize( vMwDir ) ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SUN_VERT = /* glsl */ `
${SKY_VERT}
varying vec2 vSunQ;
void main() {
  vSunQ = position.xy;
  gl_Position = skyPosition( ( modelMatrix * vec4( position, 1.0 ) ).xyz );
}
`;

const SUN_FRAG = /* glsl */ `
uniform float sunDisc; // the disc's radius in the quad's units
uniform float sunHalf; // the quad's half width: the glow is gone well before its edge
varying vec2 vSunQ;
void main() {
  float r = length( vSunQ );
  float disc = 1.0 - smoothstep( sunDisc * 0.9, sunDisc * 1.1, r );
  float glow = ( exp( - r / ( sunDisc * 3.0 ) ) * 0.6 + exp( - r / ( sunDisc * 12.0 ) ) * 0.08 ) * ( 1.0 - smoothstep( 0.4 * sunHalf, 0.95 * sunHalf, r ) );
  gl_FragColor = vec4( vec3( 1.0, 0.98, 0.94 ) * ( disc * 60.0 + glow ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Outdoor surfaces (terrain and boulders) light themselves: the sun with its shadow map, a dim neutral fill
// and Mars's warm light on whatever faces it. Under MeshStandardMaterial every fragment out there also paid
// for the interior's area lights, lamps and red slots (3 ms of terrain alone at the computer-room window),
// for light that never reaches it. Maps: albedo (sRGB) and a tangent-space normal map on screen-derivative
// frames (three's perturbNormal2Arb), so any uv layout works.
const OUTDOOR_VERT = /* glsl */ `
uniform mat4 sunShadowMatrix;
uniform float sunNormalBias;
varying vec3 vOutW;
varying vec3 vOutN;
varying vec2 vOutUv;
varying vec3 vOutCol;
varying vec4 vOutSh;
#ifdef GROUND
attribute float relief;
varying float vRelief;
#endif
void main() {
#ifdef GROUND
  vRelief = relief;
#endif
  vec4 p = vec4( position, 1.0 );
  vec3 n = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
  n = mat3( instanceMatrix ) * n;
#endif
  vec4 w = modelMatrix * p;
  vOutW = w.xyz;
  n = mat3( modelMatrix ) * n;
  float nl = length( n );
  vOutN = nl > 1e-8 ? n / nl : vec3( 0.0, 1.0, 0.0 );
  vOutUv = uv;
#ifdef USE_COLOR
  vOutCol = color;
#else
  vOutCol = vec3( 1.0 );
#endif
  vOutSh = sunShadowMatrix * vec4( vOutW + vOutN * sunNormalBias, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const OUTDOOR_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D map;
uniform sampler2D normalMap;
uniform float hasMap;
uniform float hasNormal;
uniform vec2 normalScale;
uniform vec3 tint;
uniform vec3 sunDir;
uniform float sunI;
uniform vec3 fill;
uniform vec3 marsDir;
uniform vec3 marsFill;
uniform sampler2D sunShadow;
uniform float hasShadow;
uniform vec2 sunShadowSize;
uniform float sunBias;
#ifdef TERRAIN_MASK
uniform sampler2D terrainMask;
uniform vec2 terrainMaskMin;
uniform vec2 terrainMaskSize;
#endif
#ifdef GROUND
uniform sampler2D groundAlbedo;
uniform sampler2D groundNormal;
uniform float hasGroundAlbedo;
uniform float hasGroundNormal;
uniform vec2 groundCenter;
uniform vec2 groundRot;
uniform float groundSize;
uniform float groundContrast;
varying float vRelief;
#endif
varying vec3 vOutW;
varying vec3 vOutN;
varying vec2 vOutUv;
varying vec3 vOutCol;
varying vec4 vOutSh;
float outdoorShadow( vec4 sc ) {
  if ( hasShadow < 0.5 || sc.w <= 0.0 ) return 1.0;
  vec3 c = sc.xyz / sc.w;
  c.z += sunBias;
  if ( any( lessThan( c, vec3( 0.0 ) ) ) || any( greaterThan( c, vec3( 1.0 ) ) ) ) return 1.0;
  vec2 t = 1.0 / sunShadowSize;
  float s = 0.0;
  for ( int i = - 1; i <= 1; i ++ ) for ( int j = - 1; j <= 1; j ++ )
    s += step( c.z, unpackRGBAToDepth( texture2D( sunShadow, c.xy + vec2( float( i ), float( j ) ) * t ) ) );
  return s / 9.0;
}
void main() {
#ifdef TERRAIN_MASK
  {
    vec2 mq = ( vOutW.xz - terrainMaskMin ) / terrainMaskSize;
    if ( all( greaterThan( mq, vec2( 0.0 ) ) ) && all( lessThan( mq, vec2( 1.0 ) ) ) && texture2D( terrainMask, mq ).r > 0.5 ) discard;
  }
#endif
  vec3 Ng = normalize( vOutN ) * ( gl_FrontFacing ? 1.0 : - 1.0 );
  float detail = 1.0;
#ifdef GROUND
  // The real ground: its scan coordinates (the seed's turn about the base centre), its 2 m normals tilting
  // the smooth base shape's (as far as the relief weight lets them), and the tiling scan kept for the fine
  // grain at the camera's feet, half strength from 60 m so its repeat never shows.
  vec2 gd = vOutW.xz - groundCenter;
  vec2 gq = vec2( groundRot.x * gd.x + groundRot.y * gd.y, - groundRot.y * gd.x + groundRot.x * gd.y ) / groundSize + 0.5;
  if ( hasGroundNormal > 0.5 && vRelief > 0.0 ) {
    vec3 t = texture2D( groundNormal, gq ).xyz * 2.0 - 1.0;
    vec2 wxz = vec2( groundRot.x * t.x - groundRot.y * t.y, groundRot.y * t.x + groundRot.x * t.y );
    Ng = normalize( Ng + vRelief * ( vec3( wxz.x, t.z, wxz.y ) - vec3( 0.0, 1.0, 0.0 ) ) );
  }
  detail = mix( 1.0, 0.5, smoothstep( 8.0, 60.0, distance( vOutW, cameraPosition ) ) );
#endif
  vec3 N = Ng;
  vec3 albedo = tint * vOutCol;
  if ( hasMap > 0.5 ) {
    vec3 c = texture2D( map, vOutUv ).rgb;
#ifdef ANTI_TILE
    // The scan's own large-scale luminance taken again at 13x the scale breaks its 2 m repeat.
    vec3 lw = vec3( 0.2126, 0.7152, 0.0722 );
    float mean = max( dot( textureLod( map, vec2( 0.5 ), 12.0 ).rgb, lw ), 0.01 );
    vec2 q = mat2( 0.8, 0.6, - 0.6, 0.8 ) * vOutW.xz / 26.0 + 0.37;
    c *= clamp( mix( 1.0, dot( texture2D( map, q ).rgb, lw ) / mean, 0.7 ), 0.5, 1.6 );
#endif
#ifdef GROUND
    c = mix( textureLod( map, vec2( 0.5 ), 12.0 ).rgb, c, detail );
#endif
    albedo *= c;
  }
#ifdef GROUND
  // The photograph: albedo x 2 stored (mean 1), its contrast raised a little (the highlands are even-toned).
  if ( hasGroundAlbedo > 0.5 ) albedo *= pow( texture2D( groundAlbedo, gq ).r * 2.0, groundContrast );
#endif
  if ( hasNormal > 0.5 ) {
    vec3 q0 = dFdx( vOutW ), q1 = dFdy( vOutW );
    vec2 st0 = dFdx( vOutUv ), st1 = dFdy( vOutUv );
    vec3 q1perp = cross( q1, Ng ), q0perp = cross( Ng, q0 );
    vec3 T = q1perp * st0.x + q0perp * st1.x;
    vec3 B = q1perp * st0.y + q0perp * st1.y;
    float det = max( dot( T, T ), dot( B, B ) );
    if ( det > 0.0 ) {
      float k = inversesqrt( det );
      vec3 mn = texture2D( normalMap, vOutUv ).xyz * 2.0 - 1.0;
      mn.xy *= normalScale * detail;
      vec3 Np = T * ( mn.x * k ) + B * ( mn.y * k ) + Ng * mn.z;
      float l = length( Np );
      if ( l > 1e-6 ) N = Np / l;
    }
  }
  // The geometric normal gates the mapped one, so relief never lights a face turned from the sun.
  float ndl = max( dot( N, sunDir ), 0.0 ) * smoothstep( - 0.05, 0.1, dot( Ng, sunDir ) );
  vec3 irr = vec3( sunI * ndl * outdoorShadow( vOutSh ) ) + fill + marsFill * max( dot( N, marsDir ), 0.0 );
  gl_FragColor = vec4( albedo * irr * 0.3183099, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GROUND_CONTRAST = 1.8; // exponent on the real ground's albedo multiplier
const STAR_GAIN = 3.0; // linear brightness of a V 0 star's centre pixel
const MW_GAIN = 0.15; // the Milky Way map's stored value (radiance / 0.2) to linear
const OUTDOOR_FILL = new THREE.Color().setRGB(0.1, 0.1, 0.11);
const MARS_FILL = new THREE.Color().setRGB(0.22, 0.11, 0.05); // Mars at half phase, 42° across, albedo 0.25

/** An outdoor material (see above). `opts`: { tint, mask, antiTile, vertexColors, ground (terrain.ground) }. */
function outdoorMaterial(sky, opts = {}) {
  const u = {
    map: { value: null }, normalMap: { value: null }, hasMap: { value: 0 }, hasNormal: { value: 0 },
    normalScale: { value: new THREE.Vector2(1, 1) }, tint: { value: (opts.tint ?? new THREE.Color(1, 1, 1)).clone() },
    sunDir: { value: sky.sunDir }, sunI: { value: SUN_INTENSITY }, fill: { value: OUTDOOR_FILL },
    marsDir: { value: sky.marsDir }, marsFill: { value: MARS_FILL },
    sunShadow: { value: null }, hasShadow: { value: 0 }, sunShadowSize: { value: new THREE.Vector2(SUN_SHADOW_SIZE, SUN_SHADOW_SIZE) },
    sunBias: { value: -0.0003 }, sunShadowMatrix: { value: sky.sun.shadow.matrix }, sunNormalBias: { value: 0.04 },
  };
  if (opts.mask) Object.assign(u, { terrainMask: { value: opts.mask.texture }, terrainMaskMin: { value: opts.mask.min }, terrainMaskSize: { value: opts.mask.size } });
  const g = opts.ground;
  if (g) {
    Object.assign(u, {
      groundAlbedo: { value: null }, groundNormal: { value: null }, hasGroundAlbedo: { value: 0 }, hasGroundNormal: { value: 0 },
      groundCenter: { value: new THREE.Vector2(...g.center) }, groundRot: { value: new THREE.Vector2(g.cos, g.sin) },
      groundSize: { value: g.size }, groundContrast: { value: GROUND_CONTRAST },
    });
  }
  const defines = {};
  if (opts.mask) defines.TERRAIN_MASK = '';
  if (g) defines.GROUND = '';
  if (opts.antiTile) defines.ANTI_TILE = '';
  const m = new THREE.ShaderMaterial({ uniforms: u, defines, vertexShader: OUTDOOR_VERT, fragmentShader: OUTDOOR_FRAG, vertexColors: !!opts.vertexColors });
  m.name = opts.name ?? 'outdoor';
  m.userData.setMaps = (map, normalMap, normalScale) => {
    u.map.value = map ?? null; u.hasMap.value = map ? 1 : 0;
    u.normalMap.value = normalMap ?? null; u.hasNormal.value = normalMap ? 1 : 0;
    if (normalScale) u.normalScale.value.copy(normalScale);
  };
  return m;
}

/**
 * Split an indexed geometry into meshes by `key(x, z)` of each triangle's centroid. Every chunk shares the
 * vertex attributes (uploaded once) and has its own index and bounding sphere, so each can be culled.
 */
function chunked(geo, material, name, key) {
  const pos = geo.attributes.position, idx = geo.index.array;
  const lists = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const k = key(x, z);
    if (!lists.has(k)) lists.set(k, []);
    lists.get(k).push(a, b, c);
  }
  const group = new THREE.Group();
  group.name = name;
  const v = new THREE.Vector3();
  for (const list of lists.values()) {
    const g = new THREE.BufferGeometry();
    for (const [n, attr] of Object.entries(geo.attributes)) g.setAttribute(n, attr);
    g.setIndex(list);
    const box = new THREE.Box3();
    for (const i of list) box.expandByPoint(v.fromBufferAttribute(pos, i));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    const m = new THREE.Mesh(g, material);
    m.name = name;
    group.add(m);
  }
  return group;
}

/** A lumpy rock: an icosphere (320 triangles) pushed in and out by a fixed hash of each vertex, flattened. */
function lowPolyRock() {
  const g = mergeVertices(new THREE.IcosahedronGeometry(0.5, 2).deleteAttribute('normal').deleteAttribute('uv'));
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const k = 0.82 + 0.3 * (h - Math.floor(h)) + 0.12 * Math.sin(x * 7 + z * 5);
    p.setXYZ(i, x * k * 1.1, y * k * 0.7, z * k);
  }
  // Planar uvs from above are enough for a rock this far away.
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) + 0.5; uv[i * 2 + 1] = p.getZ(i) + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  return { geo: g, extent: Math.max(size.x, size.y, size.z), centre: g.boundingBox.getCenter(new THREE.Vector3()), minY: g.boundingBox.min.y };
}

function quadsGeometry(quads) {
  const pos = [], uv = [], nrm = [], idx = [];
  quads.forEach((q, i) => {
    q.corners.forEach((c, k) => { pos.push(...c); uv.push(...q.uv[k]); nrm.push(...q.normal); });
    const o = i * 4;
    idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

function roofGeometry(roofs) {
  const pos = [], uv = [], nrm = [];
  for (const r of roofs) {
    const tris = THREE.ShapeUtils.triangulateShape(r.poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const t of tris) {
      let [a, b, c] = t.map((i) => r.poly[i]);
      const crossY = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      if (crossY <= 0) [b, c] = [c, b];
      for (const [x, z] of [a, b, c]) { pos.push(x, r.y, z); uv.push(x / 2, z / 2); nrm.push(0, 1, 0); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

export class PhobosSky {
  constructor(scene, assets, rng, opts = {}) {
    const level = opts.level;
    this.scene = scene;
    this.renderer = opts.renderer;
    this.level = level;
    this.group = new THREE.Group();
    this.group.name = 'phobos';
    scene.add(this.group);
    this.edges = opts.edges ?? openEdges(level);
    const mars = marsDirection(level, this.edges);
    this.marsDir = new THREE.Vector3(...mars.dir);
    this.sunDir = new THREE.Vector3(...sunDirection(mars.flat, rng.next() < 0.5 ? 1 : -1)).normalize();
    // Exterior objects take the largest courtyard's probe.
    const yards = level.sectors.filter((s) => s.tags.has('courtyard'));
    const area = (p) => Math.abs(p.reduce((a, [x, z], i) => { const [x2, z2] = p[(i + 1) % p.length]; return a + x * z2 - x2 * z; }, 0)) / 2;
    this.envSector = yards.sort((a, b) => area(b.poly) - area(a.poly))[0]?.id ?? level.sectors[0].id;

    this.data = opts.data ?? {};
    this.buildSky(rng.fork('stars'), rng.next());
    this.terrain = makeTerrain(level, rng.fork('terrain'), mars.flat, this.data.ground ?? null);
    this.buildSun();
    this.buildTerrain();
    this.shell = opts.shell ?? planShell(level, this.edges);
    this.buildShell();
    this.boulderPlan = scatterBoulders(this.terrain, rng.fork('boulders'), this.shadowBox);
    this.boulders = new THREE.Group();
    this.boulders.name = 'boulders';
    this.group.add(this.boulders);
    this.models = {};
    this.rockMats = {};
    this.buildBoulders(); // the far ones need no model
    for (const it of assets?.values?.() ?? []) this.setAsset(it.kind, it.name, it.asset);
  }

  // ---- sky ----
  buildSky(rng, phase) {
    const D = SKY_DISTANCE;
    // Mars: local +y is its pole. The pole leans 20° off the sky's vertical through Mars, and the face it
    // shows starts at a seeded longitude.
    const radius = D * Math.sin((marsAngularDiameter() / 2) * Math.PI / 180);
    this.marsMat = new THREE.ShaderMaterial({
      name: 'mars',
      uniforms: {
        marsMap: { value: null }, marsHasMap: { value: 0 }, marsSun: { value: new THREE.Vector3() }, marsSunI: { value: SUN_INTENSITY },
        marsPole: { value: new THREE.Vector3(0, 1, 0) }, marsTexel: { value: new THREE.Vector2(1 / 8192, 1 / 4096) },
      },
      vertexShader: MARS_VERT, fragmentShader: MARS_FRAG, depthTest: false, depthWrite: false,
    });
    this.mars = new THREE.Mesh(new THREE.SphereGeometry(radius, 256, 128), this.marsMat);
    this.mars.name = 'mars';
    this.mars.frustumCulled = false;
    this.mars.renderOrder = -1000;
    this.mars.position.copy(this.marsDir).multiplyScalar(D);
    const up = new THREE.Vector3(0, 1, 0);
    const toward = this.marsDir.clone();
    const skyUp = up.clone().addScaledVector(toward, -up.dot(toward)).normalize();
    this.marsPole = skyUp.clone().applyAxisAngle(toward, (20 * Math.PI) / 180).normalize();
    this.marsSpin = phase * Math.PI * 2;
    // Frame: local +y the pole, +z away from the viewer (pole and view are perpendicular), spun about +y.
    const ex = new THREE.Vector3().crossVectors(this.marsPole, toward).normalize();
    this.marsFrame = new THREE.Matrix4().makeBasis(ex, this.marsPole, new THREE.Vector3().crossVectors(ex, this.marsPole));
    this.marsMat.uniforms.marsPole.value.copy(this.marsPole);
    this.marsMat.uniforms.marsSun.value.copy(this.sunDir ?? up);
    this.group.add(this.mars);
    this.setMarsSpin(this.marsSpin);

    // The celestial sphere's turn (phobos.skyOrientation): the catalogue and the Milky Way are in ICRS.
    const Q = skyOrientation(this.marsDir.toArray(), this.sunDir.toArray());
    this.skyMatrix = new THREE.Matrix4().set(Q[0], Q[1], Q[2], 0, Q[3], Q[4], Q[5], 0, Q[6], Q[7], Q[8], 0, 0, 0, 0, 1);
    const wash = {
      starMars: { value: this.marsDir.clone() }, starSun: { value: this.sunDir.clone() },
      starMarsCos: { value: Math.cos(((marsAngularDiameter() / 2 + 3) * Math.PI) / 180) },
    };

    // Stars: the Hipparcos catalogue (118,000 stars to V 12), or without it a made-up sky of a few thousand.
    const cat = this.data.stars;
    let N, pos, mag, col;
    if (cat) {
      N = cat.count; mag = cat.mag; col = cat.color;
      pos = new Float32Array(N * 3);
      for (let i = 0; i < N * 3; i++) pos[i] = cat.dir[i] * D;
    } else {
      N = 3500; pos = new Float32Array(N * 3); mag = new Float32Array(N); col = new Float32Array(N * 3).fill(0.95);
      for (let i = 0; i < N; i++) {
        const u = rng.range(-1, 1), a = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
        pos[i * 3] = Math.cos(a) * s * D; pos[i * 3 + 1] = u * D; pos[i * 3 + 2] = Math.sin(a) * s * D;
        mag[i] = 1 + 6 * Math.pow(rng.next(), 0.3); // most faint
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    sg.setAttribute('starColor', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.ShaderMaterial({
      name: 'stars',
      uniforms: { starScale: { value: 1 }, starGain: { value: STAR_GAIN }, ...wash },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1002;
    this.stars.matrixAutoUpdate = false;
    if (cat) this.stars.matrix.copy(this.skyMatrix);
    this.group.add(this.stars);

    // The Milky Way, shown once its map arrives. SphereGeometry's uv u runs RA 180 -> -180 (the map's RA 0 is
    // its centre, RA rising to the left) round local +y; P takes that local frame to ICRS (x, z, y).
    this.mwMat = new THREE.ShaderMaterial({
      name: 'milkyway',
      uniforms: { mwMap: { value: null }, mwGain: { value: MW_GAIN }, ...wash },
      vertexShader: MW_VERT, fragmentShader: MW_FRAG, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.milkyWay = new THREE.Mesh(new THREE.SphereGeometry(D, 128, 64), this.mwMat);
    this.milkyWay.name = 'milkyway';
    this.milkyWay.frustumCulled = false;
    // Unlike the rest of the sky it draws after the opaque scene, depth-tested at the far plane, so a room
    // with no view out pays nothing for it. It adds nothing over Mars or the sun (skyWash), so it needs no
    // depth of theirs.
    this.milkyWay.renderOrder = 900;
    this.milkyWay.visible = false;
    this.milkyWay.matrixAutoUpdate = false;
    const P = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.milkyWay.matrix.copy(this.skyMatrix).multiply(P);
    this.group.add(this.milkyWay);
  }

  setMarsSpin(a) {
    this.marsSpin = a;
    const spin = new THREE.Matrix4().makeRotationY(a);
    this.mars.matrixAutoUpdate = false;
    this.mars.matrix.copy(this.marsFrame).multiply(spin).setPosition(this.mars.position);
    this.mars.matrixWorldNeedsUpdate = true;
  }

  // ---- sun ----
  buildSun() {
    const D = SKY_DISTANCE;
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY));
    sun.name = 'sun';
    this.marsMat.uniforms.marsSun.value.copy(this.sunDir);

    // The shadow box: the base and SHADOW_MARGIN round it, from below the façades' feet to above the roofs.
    const b = this.terrain.bounds;
    this.shadowBox = { x0: b.x0 - SHADOW_MARGIN, z0: b.z0 - SHADOW_MARGIN, x1: b.x1 + SHADOW_MARGIN, z1: b.z1 + SHADOW_MARGIN };
    const box = this.shadowBox;
    const c = new THREE.Vector3((box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2);
    sun.position.copy(c).addScaledVector(this.sunDir, 400);
    sun.target.position.copy(c);
    this.group.add(sun, sun.target);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    // Fit the orthographic shadow camera to the box's corners in light space.
    const look = new THREE.Matrix4().lookAt(sun.position, c, new THREE.Vector3(0, 1, 0));
    const inv = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(look)).invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const x of [box.x0, box.x1]) for (const y of [-9, 17]) for (const z of [box.z0, box.z1]) {
      const p = new THREE.Vector3(x, y, z).sub(sun.position).applyMatrix4(inv);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const cam = sun.shadow.camera;
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1; cam.near = Math.max(0.1, -z1 - 1); cam.far = -z0 + 1;
    cam.updateProjectionMatrix();
    sun.castShadow = true;
    sun.shadow.mapSize.set(SUN_SHADOW_SIZE, SUN_SHADOW_SIZE);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.04;
    sun.shadow.autoUpdate = false; // static base: re-rendered only when something in the box changes
    sun.shadow.needsUpdate = true;

    // The sun's disc (0.35° from Mars's distance), with a glow.
    // A quad 12° across; the shader measures the disc (0.18° radius) in the quad's metres.
    const q = 12 * (Math.PI / 180) * D;
    this.sunMat = new THREE.ShaderMaterial({
      name: 'sun-disc', uniforms: { sunDisc: { value: (0.18 * Math.PI / 180) * D }, sunHalf: { value: q / 2 } },
      vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const plane = new THREE.PlaneGeometry(q, q);
    this.sunDisc = new THREE.Mesh(plane, this.sunMat);
    this.sunDisc.position.copy(this.sunDir).multiplyScalar(D);
    this.sunDisc.lookAt(0, 0, 0);
    this.sunDisc.frustumCulled = false;
    this.sunDisc.renderOrder = -1001;
    this.group.add(this.sunDisc);
  }

  /** Ask for one re-render of the sun's shadow map (in the next per-frame shadow update). */
  refreshShadow() { this.sun.shadow.needsUpdate = true; }

  // ---- ground ----
  buildTerrain() {
    const T = this.terrain, b = T.bounds;
    // Footprint mask: 5 cm pixels over the base's box, white where the level draws its own floor.
    const fp = T.footprint;
    const mx0 = b.x0 - 1, mz0 = b.z0 - 1, mw = b.x1 - b.x0 + 2, mh = b.z1 - b.z0 + 2;
    const cw = Math.min(4096, Math.ceil(mw / MASK_RES)), ch = Math.min(4096, Math.ceil(mh / MASK_RES));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#fff';
    for (const s of fp) {
      g.beginPath();
      s.poly.forEach(([x, z], i) => { const px = ((x - mx0) / mw) * cw, py = ((z - mz0) / mh) * ch; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.closePath();
      g.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; // canvas row 0 is z = mz0 (v = 0)
    tex.generateMipmaps = false;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.NoColorSpace;
    this.maskTex = tex;
    const mask = { texture: tex, min: new THREE.Vector2(mx0, mz0), size: new THREE.Vector2(mw, mh) };
    const ground = T.ground;
    this.nearMat = outdoorMaterial(this, { name: 'terrain-near', tint: STAND_IN, mask, antiTile: true, vertexColors: true, ground });
    this.farMat = outdoorMaterial(this, { name: 'terrain-far', tint: STAND_IN, antiTile: true, vertexColors: true, ground });
    // With the real ground, vertex normals are the smooth base shape's (grooves, ridges, pad, basins, the
    // sphere) and the shader tilts them by the scan's own 2 m normals, times the relief weight: the far mesh's
    // rings are tens of metres apart out there, but its craters still catch the light. Without it the normals
    // are the mesh's own.
    const sampleAt = (x, z) => {
      if (!ground) return { y: T.height(x, z), base: 0, w: 0, k: T.shade(x, z) };
      const e = T.sample(x, z);
      return { y: e.base + e.scan * e.weight, base: e.base, w: e.weight, k: 1 };
    };
    const normalsFrom = (geo, baseY, posArr) => {
      if (!ground) { geo.computeVertexNormals(); return; }
      const p = geo.attributes.position.array;
      for (let i = 0; i < baseY.length; i++) p[i * 3 + 1] = baseY[i];
      geo.computeVertexNormals();
      for (let i = 0; i < baseY.length; i++) p[i * 3 + 1] = posArr[i * 3 + 1];
      geo.attributes.position.needsUpdate = true;
    };

    // Near grid.
    const gx0 = Math.floor(b.x0 - NEAR_MARGIN), gz0 = Math.floor(b.z0 - NEAR_MARGIN);
    const gx1 = Math.ceil(b.x1 + NEAR_MARGIN), gz1 = Math.ceil(b.z1 + NEAR_MARGIN);
    const nx = Math.round((gx1 - gx0) / NEAR_STEP) + 1, nz = Math.round((gz1 - gz0) / NEAR_STEP) + 1;
    this.nearRect = { x0: gx0, z0: gz0, x1: gx0 + (nx - 1) * NEAR_STEP, z1: gz0 + (nz - 1) * NEAR_STEP };
    const pos = [], col = [], uv = [], idx = [], rel = [], baseY = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = gx0 + i * NEAR_STEP, z = gz0 + j * NEAR_STEP;
      const s = sampleAt(x, z);
      pos.push(x, s.y, z); col.push(s.k, s.k, s.k); uv.push(x / 2, z / 2); rel.push(s.w); baseY.push(s.base);
    }
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, bb = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, bb, bb, c, d);
    }
    const near = new THREE.BufferGeometry();
    near.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    near.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    near.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    near.setIndex(idx);
    normalsFrom(near, baseY, pos);
    // Skirt: the grid's rim dropped 1.5 m, so the far mesh's differently spaced edge never shows a crack.
    const nrm = Array.from(near.attributes.normal.array);
    const rim = [];
    for (let i = 0; i < nx; i++) rim.push(i);
    for (let j = 1; j < nz; j++) rim.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) rim.push((nz - 1) * nx + i);
    for (let j = nz - 2; j >= 1; j--) rim.push(j * nx);
    rim.push(0);
    const base = pos.length / 3;
    for (const v of rim) {
      pos.push(pos[v * 3], pos[v * 3 + 1] - 1.5, pos[v * 3 + 2]);
      col.push(col[v * 3], col[v * 3], col[v * 3]);
      uv.push(uv[v * 2], uv[v * 2 + 1]);
      nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
      rel.push(rel[v]);
    }
    for (let k = 0; k < rim.length - 1; k++) {
      const a = rim[k], bb = rim[k + 1], c = base + k, d = base + k + 1;
      idx.push(a, bb, c, bb, d, c, a, c, bb, bb, c, d); // both windings: it is seen from outside only, either way
    }
    near.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    near.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    near.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    near.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    if (ground) near.setAttribute('relief', new THREE.Float32BufferAttribute(rel, 1));
    near.setIndex(idx);
    // Tiles of 40 m sharing the one vertex buffer, so the frustum (main view, mirror, probe faces) culls them.
    this.near = chunked(near, this.nearMat, 'terrain-near', (x, z) => `${Math.floor(x / 40)},${Math.floor(z / 40)}`);

    // Far: polar rings from the grid's edge out to TERRAIN_REACH, widening with distance.
    const [cx, cz] = [(this.nearRect.x0 + this.nearRect.x1) / 2, (this.nearRect.z0 + this.nearRect.z1) / 2];
    const hw = (this.nearRect.x1 - this.nearRect.x0) / 2, hh = (this.nearRect.z1 - this.nearRect.z0) / 2;
    const r0 = Math.min(hw, hh) * 0.6;
    const fpos = [], fcol = [], fuv = [], fidx = [], frel = [], fbase = [];
    for (let i = 0; i <= FAR_RINGS; i++) {
      const ri = r0 * Math.pow(TERRAIN_REACH / r0, i / FAR_RINGS);
      for (let j = 0; j < FAR_SEGMENTS; j++) {
        const a = (j / FAR_SEGMENTS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const edge = Math.min(Math.abs(ca) > 1e-9 ? hw / Math.abs(ca) : Infinity, Math.abs(sa) > 1e-9 ? hh / Math.abs(sa) : Infinity);
        const r = Math.max(ri, edge);
        const x = cx + ca * r, z = cz + sa * r;
        const s = sampleAt(x, z);
        fpos.push(x, s.y, z);
        fcol.push(s.k, s.k, s.k);
        fuv.push(x / 2, z / 2);
        frel.push(s.w); fbase.push(s.base);
      }
    }
    for (let i = 0; i < FAR_RINGS; i++) for (let j = 0; j < FAR_SEGMENTS; j++) {
      const j1 = (j + 1) % FAR_SEGMENTS;
      const a = i * FAR_SEGMENTS + j, bb = i * FAR_SEGMENTS + j1, c = a + FAR_SEGMENTS, d = bb + FAR_SEGMENTS;
      fidx.push(a, bb, c, bb, d, c); // counter-clockwise seen from above
    }
    const far = new THREE.BufferGeometry();
    far.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    far.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    far.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
    far.setIndex(fidx);
    normalsFrom(far, fbase, fpos);
    if (ground) far.setAttribute('relief', new THREE.Float32BufferAttribute(frel, 1));
    this.far = chunked(far, this.farMat, 'terrain-far', (x, z) => `${Math.floor(((Math.atan2(z - cz, x - cx) + Math.PI) / (2 * Math.PI)) * 16)}`);
    for (const g of [this.near, this.far]) {
      for (const m of g.children) {
        m.receiveShadow = true;
        m.castShadow = false;
        m.userData.sector = this.envSector;
      }
      this.group.add(g);
    }
  }

  // ---- the base from outside ----
  buildShell() {
    this.shellMat = new THREE.MeshStandardMaterial({ color: 0x6e6c68, roughness: 0.9 });
    const g1 = quadsGeometry(this.shell.quads), g2 = roofGeometry(this.shell.roofs);
    this.shellMeshes = [new THREE.Mesh(g1, this.shellMat), new THREE.Mesh(g2, this.shellMat)];
    for (const m of this.shellMeshes) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.sector = this.envSector;
      m.name = 'shell';
      this.group.add(m);
    }
  }

  // ---- boulders ----
  buildBoulders() {
    for (const c of [...this.boulders.children]) { this.boulders.remove(c); c.dispose?.(); }
    const src = {};
    for (const k of ['a', 'b']) {
      const scene = this.models[k];
      if (!scene) continue;
      let mesh = null;
      scene.updateMatrixWorld(true);
      scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (!mesh) continue;
      const node = mesh.matrixWorld.clone();
      const geo = mesh.geometry;
      geo.userData.shared = true; // the page's (the loaded model's): Scene.dispose must leave it
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox.clone().applyMatrix4(node);
      const size = bb.getSize(new THREE.Vector3());
      const centre = bb.getCenter(new THREE.Vector3());
      // The scan's maps on an outdoor material (one per model, kept across rebuilds).
      const gm = mesh.material;
      this.rockMats[k] ??= outdoorMaterial(this, { name: `boulder-${k}`, tint: ROCK_TINT });
      this.rockMats[k].userData.setMaps(gm.map, gm.normalMap, gm.normalScale);
      const mat = this.rockMats[k];
      src[k] = { geo, node, mat, extent: Math.max(size.x, size.y, size.z), centre, minY: bb.min.y };
    }
    // Far rocks (tens of pixels at most): a lumpy 320-triangle stand-in wearing the scanned rock's material.
    this.loRock ??= lowPolyRock();
    this.rockMats.lo ??= outdoorMaterial(this, { name: 'boulder-lo', tint: ROCK_TINT.clone().multiplyScalar(0.5) });
    const loMat = this.rockMats.lo;
    const scan = this.models.b ?? this.models.a;
    if (scan) {
      let gm = null;
      scan.traverse((o) => { if (!gm && o.isMesh) gm = o.material; });
      if (gm?.map) { loMat.userData.setMaps(gm.map, null); loMat.uniforms.tint.value.copy(ROCK_TINT); }
    }
    src.lo = { geo: this.loRock.geo, node: new THREE.Matrix4(), mat: loMat, extent: this.loRock.extent, centre: this.loRock.centre, minY: this.loRock.minY };
    // Planar shadow: the rock flattened onto its ground plane along the sun, multiplied into the ground once
    // (front faces only, and the depth test stops a second layer at the same depth).
    this.planarMat ??= new THREE.MeshBasicMaterial({
      color: new THREE.Color(SHADOW_TINT, SHADOW_TINT, SHADOW_TINT), blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendEquation: THREE.AddEquation,
      depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false,
    });
    const L = this.sunDir;
    const groups = new Map();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (const r of this.boulderPlan) {
      const model = src[r.model] ? r.model : (r.model === 'lo' ? null : (src.a ? 'a' : (src.b ? 'b' : null)));
      if (!model) continue;
      const S = src[model];
      const k = r.size / S.extent;
      e.set(r.tiltX, r.yaw, r.tiltZ, 'YXZ');
      q.setFromEuler(e);
      s.set(k, k, k);
      // Centre over (x, z); bottom at the planned base height (already sunk a fifth of the size).
      p.set(r.x - S.centre.x * k, r.y - S.minY * k, r.z - S.centre.z * k);
      m4.compose(p, q, s).multiply(S.node);
      // Chunks for culling: near rocks by 40 m tile, far ones by sixth of the compass round the base.
      const quadrant = r.near ? `n${Math.floor(r.x / 40)},${Math.floor(r.z / 40)}` : `${Math.floor(((Math.atan2(r.z - this.terrain.center[1], r.x - this.terrain.center[0]) + Math.PI) / (Math.PI * 2)) * 6)}`;
      const key = `${model}|${quadrant}`;
      if (!groups.has(key)) groups.set(key, { S, near: r.near, list: [] });
      // Ground plane under the rock, from the heightfield's slope.
      const h = (x, z) => this.terrain.height(x, z);
      const d = Math.max(0.5, r.size);
      const n = new THREE.Vector3(h(r.x - d, r.z) - h(r.x + d, r.z), 2 * d, h(r.x, r.z - d) - h(r.x, r.z + d)).normalize();
      const g0 = h(r.x, r.z);
      groups.get(key).list.push({ m: m4.clone(), n, g: new THREE.Vector3(r.x, g0, r.z) });
    }
    for (const [, gr] of groups) {
      const im = new THREE.InstancedMesh(gr.S.geo, gr.S.mat, gr.list.length);
      gr.list.forEach((it, i) => im.setMatrixAt(i, it.m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = gr.near;
      im.receiveShadow = true;
      im.userData.sector = this.envSector;
      im.name = 'boulders';
      this.boulders.add(im);
      if (gr.near) continue;
      // Planar projection along L onto the plane through g with normal n: p' = p - L (n·(p - g)) / (n·L).
      const sh = new THREE.InstancedMesh(gr.S.geo, this.planarMat, gr.list.length);
      gr.list.forEach((it, i) => {
        const nl = Math.max(it.n.dot(L), 0.05), d0 = it.n.dot(it.g);
        const P = new THREE.Matrix4().set(
          nl - L.x * it.n.x, -L.x * it.n.y, -L.x * it.n.z, L.x * d0,
          -L.y * it.n.x, nl - L.y * it.n.y, -L.y * it.n.z, L.y * d0,
          -L.z * it.n.x, -L.z * it.n.y, nl - L.z * it.n.z, L.z * d0,
          0, 0, 0, nl,
        ).multiplyScalar(1 / nl); // w stays 1
        sh.setMatrixAt(i, P.multiply(it.m));
      });
      sh.instanceMatrix.needsUpdate = true;
      sh.frustumCulled = false; // flattened matrices make a poor bounding sphere; there are only a few
      sh.renderOrder = 5; // after the ground it darkens
      sh.castShadow = false;
      sh.name = 'boulder-shadows';
      this.boulders.add(sh);
    }
    this.refreshShadow();
  }

  /** An asset arrived (see the header). Returns true when the probes should be re-baked. */
  setAsset(kind, name, asset) {
    if (kind === 'image' && name === 'mars' && asset && !asset.userData?.fallback) {
      const u = this.marsMat.uniforms;
      u.marsMap.value = asset;
      u.marsHasMap.value = 1;
      const img = asset.image;
      if (img?.width) u.marsTexel.value.set(1 / img.width, 1 / img.height);
      return true;
    }
    if (kind === 'model' && (name === 'boulder-a' || name === 'boulder-b') && asset && !asset.userData?.fallback) {
      this.models[name.slice(-1)] = asset;
      this.buildBoulders();
      return true;
    }
    if (kind === 'image' && name === 'milkyway' && asset && !asset.userData?.fallback) {
      this.mwMat.uniforms.mwMap.value = asset;
      this.milkyWay.visible = true;
      return true;
    }
    if (kind === 'image' && (name === 'ground-albedo' || name === 'ground-normal') && asset && !asset.userData?.fallback && this.terrain.ground) {
      const key = name === 'ground-albedo' ? 'groundAlbedo' : 'groundNormal';
      const has = name === 'ground-albedo' ? 'hasGroundAlbedo' : 'hasGroundNormal';
      for (const m of [this.nearMat, this.farMat]) { m.uniforms[key].value = asset; m.uniforms[has].value = 1; }
      return true;
    }
    if (kind === 'material' && name === 'mat:regolith' && asset?.color && this.renderer) {
      for (const m of [this.nearMat, this.farMat]) {
        m.userData.setMaps(asset.color, asset.normal);
        m.uniforms.tint.value.copy(REGOLITH_TINT);
      }
      return true;
    }
    if (kind === 'material' && name === 'mat:concrete-stained' && asset?.color && this.renderer) {
      const mat = makeMaterial(name, asset, null, this.renderer);
      for (const m of this.shellMeshes) m.material = mat;
      return true;
    }
    return false;
  }

  /** Hand the sun's shadow map to the outdoor materials (it exists once the first shadow pass has run). */
  syncShadow() {
    const map = this.sun.shadow.map?.texture ?? null;
    for (const m of [this.nearMat, this.farMat, ...Object.values(this.rockMats)]) {
      m.uniforms.sunShadow.value = map;
      m.uniforms.hasShadow.value = map ? 1 : 0;
    }
  }

  update(dt, camera) {
    void camera;
    this.syncShadow();
    this.setMarsSpin(this.marsSpin + (dt * Math.PI * 2) / MARS_TURN_S);
    this.starMat.uniforms.starScale.value = this.renderer?.getPixelRatio?.() ?? 1;
  }

  dispose() {
    this.maskTex?.dispose();
    this.nearMat?.dispose();
    this.farMat?.dispose();
    this.marsMat?.dispose();
    this.starMat?.dispose();
    this.stars?.geometry.dispose();
    this.mwMat?.dispose();
    this.milkyWay?.geometry.dispose();
    this.sunMat?.dispose();
    this.planarMat?.dispose();
    this.shellMat?.dispose();
    for (const m of Object.values(this.rockMats)) m.dispose();
    this.loRock?.geo.dispose();
    this.sun?.shadow?.dispose?.();
    for (const c of this.boulders.children) c.dispose?.();
  }
}
