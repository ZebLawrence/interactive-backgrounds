// Trawler — The land: an archipelago of granite islands and the sounds between them, generated
// rather than modelled, and unbounded in every direction.
//
// How it is put together, and why:
//
// The height is a function of position written once, in GLSL. It is baked into two textures that
// follow the boat — a near field 4 km across at 4 m posts, and a far field 48 km across at 47 m —
// and the terrain, the water's depth, the trees and the navigation all read those. One source of
// truth, and no chance of the sea thinking there is water where the land says there is rock
// (which is exactly what a JavaScript mirror of the same function would eventually do).
//
// The shape: a domain-warped field decides where land is at all, ridged noise gives it mountains,
// and two narrow "cuts" carve the sounds. A sound is the zero set of a third field, widened a
// little: that is what produces long, branching, steep-sided channels rather than a scatter of
// round islands, and it is the closest thing to a glacier this can afford. Above the waterline the
// profile is steep — a fjord wall drops straight into deep water — and below it the ground falls
// away to about 200 m, with a shelf close in.
//
// The cover follows the land rather than being painted on it: bare rock on anything steep, scree
// under the cliffs, heather and moss on the gentle lower ground, and snow above a line that moves
// with the season and sits lower on the north face. Conifers stand on the lower slopes out to the
// treeline, thinning as they climb, thickest in the gullies.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ, NOISE_GLSL } from './shaders.js';
import { EARTH_R } from './ocean.js';
import { v3, lerp } from './util.js';

export const LAND = {
  // The two baked fields: half-extent in metres and the texture size.
  near: { half: 2048, size: 1024 },
  far: { half: 24000, size: 1024 },
  nav: { half: 16000, size: 256 },
  // How far the boat moves before each is re-baked.
  nearStep: 384,
  farStep: 3000,
  navStep: 2200,
  // The clipmap the land is drawn on.
  grid: 192,
  centreHalf: 256,
  rings: 8,
  // Where the water line sits in the height function's own units, and how high the land goes.
  treeline: 310,
  snowline: 560,
};

// =============================================================================================
// The height function. This is the only place the shape of the world is written down.
// =============================================================================================

export const LAND_GLSL = /* glsl */ `
uniform vec2 uWorldOrigin;

/** fbm normalised to 0..1. */
float lfbm( vec2 p, int octaves ) {
  float v = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 7; i++ ) {
    if ( i >= octaves ) break;
    v += a * vnoise( p );
    n += a;
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v / n;
}

/** Ridged noise: the creases are where mountain ridges go. */
float lridge( vec2 p, int octaves ) {
  float v = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 7; i++ ) {
    if ( i >= octaves ) break;
    float r = 1.0 - abs( vnoise( p ) * 2.0 - 1.0 );
    v += a * r * r;
    n += a;
    p = p * 2.11 + 7.3;
    a *= 0.5;
  }
  return v / n;
}

/**
 * How much land there is at a point, before the water line is subtracted. Around 0.52 is the
 * shore; higher is hill, lower is sea.
 */
float landField( vec2 p ) {
  vec2 q = p * 0.00017;                       // about 5.9 km to the unit
  vec2 w = vec2( lfbm( q * 0.5 + 3.1, 3 ), lfbm( q * 0.5 + 8.7, 3 ) ) - 0.5;
  q += w * 1.3;                               // the warp is what stops the islands looking round
  float broad = lfbm( q, 4 );
  float ridges = lridge( q * 2.1 + 11.0, 4 );
  float f = broad * 0.62 + ridges * 0.38;
  // The sounds: narrow, deep cuts along the zero set of two more fields, one fine and one broad.
  // This is what makes long branching channels with steep sides instead of a scatter of islands.
  float c1 = lfbm( q * 1.45 + 23.0, 3 );
  f -= ( 1.0 - smoothstep( 0.0, 0.085, abs( c1 - 0.5 ) ) ) * 0.46;
  float c2 = lfbm( q * 0.78 + 51.0, 3 );
  f -= ( 1.0 - smoothstep( 0.0, 0.055, abs( c2 - 0.5 ) ) ) * 0.50;
  return f;
}

const float SEA_FIELD = 0.52;

/** The height of the land at a world point, in metres above the waterline. Negative is sea bed. */
float landHeight( vec2 world ) {
  vec2 p = world + uWorldOrigin;
  float f = landField( p );
  float d = f - SEA_FIELD;
  float height;
  if ( d > 0.0 ) {
    // A fjord wall comes out of deep water steeply and then eases back into the hills behind it.
    // The exponent under one is what does that: the first fifty metres are nearly vertical.
    float t = d / ( 1.0 - SEA_FIELD );
    float h = pow( t, 0.72 ) * 1150.0;
    // Rock structure, fading in above the first few metres so the shore itself stays clean.
    h += ( lridge( p * 0.00115, 4 ) - 0.35 ) * 300.0 * smoothstep( 2.0, 110.0, h );
    h += ( lridge( p * 0.0042, 3 ) - 0.4 ) * 70.0 * smoothstep( 20.0, 160.0, h );
    h += ( lfbm( p * 0.0075, 3 ) - 0.5 ) * 11.0;
    h += ( lfbm( p * 0.034, 2 ) - 0.5 ) * 1.8;
    height = max( h, 0.15 );
  } else {
    // Below the waterline: a shelf close in and then away to the deep. The exponent above one is
    // what gives the shelf: without it the bottom is at forty metres a few boat lengths off the
    // rock, there is nothing for a wave to feel, and the shore has no surf on it at all.
    float t = -d / SEA_FIELD;
    height = -( pow( t, 1.55 ) * 320.0 + 0.6 ) + ( lfbm( p * 0.0032, 3 ) - 0.5 ) * 7.0;
  }
  return height;
}
`;

const BAKE_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/** Bakes height and the surface normal into one texture: R height, GB normal xz, A unused. */
const BAKE_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}
${LAND_GLSL}
uniform vec2 uCentre;
uniform float uHalf;
uniform float uSize;
layout( location = 0 ) out vec4 outLand;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 p = uCentre + ( uv * 2.0 - 1.0 ) * uHalf;
  float e = ( 2.0 * uHalf ) / uSize;
  float h = landHeight( p );
  float hx = landHeight( p + vec2( e, 0.0 ) );
  float hz = landHeight( p + vec2( 0.0, e ) );
  // The normal of the heightfield, from the posts the map actually carries, so it never shows
  // detail the geometry does not have.
  vec3 n = normalize( vec3( -( hx - h ) / e, 1.0, -( hz - h ) / e ) );
  outLand = vec4( h, n.x, n.z, 1.0 );
}
`;

// =============================================================================================
// Reading the baked fields: shared by the terrain, the water and the trees.
// =============================================================================================

export const LAND_READ = /* glsl */ `
uniform sampler2D uLandNear;
uniform sampler2D uLandFar;
uniform vec4 uLandNearFrame; // centre x, z, half extent, 1/half
uniform vec4 uLandFarFrame;

/** The baked land at a world point: height in x, normal xz in yz. Near field where it reaches. */
vec3 landAt( vec2 world ) {
  vec2 dn = ( world - uLandNearFrame.xy ) * uLandNearFrame.w;
  vec4 v = texture( uLandFar, ( world - uLandFarFrame.xy ) * uLandFarFrame.w * 0.5 + 0.5 );
  float inside = step( max( abs( dn.x ), abs( dn.y ) ), 0.985 );
  if ( inside > 0.5 ) {
    // Cross-fade at the edge of the near field so the join never shows as a step.
    float edge = smoothstep( 0.90, 0.985, max( abs( dn.x ), abs( dn.y ) ) );
    v = mix( texture( uLandNear, dn * 0.5 + 0.5 ), v, edge );
  }
  return v.xyz;
}

/** Just the height, which is all the water needs. */
float landHeightAt( vec2 world ) { return landAt( world ).x; }
`;

// =============================================================================================
// The land's own shaders
// =============================================================================================

const TERRAIN_VERT = /* glsl */ `
${LAND_READ}
uniform vec2 uPatchCentre;
uniform float uPatchScale;
uniform float uCell;
uniform vec3 uCamPos;
uniform float uEarthR;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDistance;
varying float vHeight;

void main() {
  vec2 p = uPatchCentre + position.xz * uPatchScale;
  // Morph onto the next coarser grid at the outer edge, which closes the seam with the ring
  // outside it, exactly as the sea's clipmap does.
  float edge = max( abs( position.x ), abs( position.z ) );
  float morph = smoothstep( 0.78, 0.97, edge );
  vec2 coarse = floor( p / ( 2.0 * uCell ) + 0.5 ) * ( 2.0 * uCell );
  p = mix( p, coarse, morph );

  vec3 land = landAt( p );
  vHeight = land.x;
  vNormalW = normalize( vec3( land.y, 1.0, land.z ) );
  // The land is carried down to eight metres under and no further. Flattening it there rather
  // than dropping the deep vertices to the sea bed matters: a triangle with one corner at the
  // shore and two at sixty metres down is a long thin sliver, and a sliver that crosses a clipmap
  // ring boundary shows through the water as a hard diagonal line. Flat is hidden; stretched is
  // not. The sea is opaque and drawn after, so none of this is ever seen.
  float y = max( land.x, -8.0 );
  vec3 world = vec3( p.x, y, p.y );
  float horiz = length( world.xz - uCamPos.xz );
  world.y -= horiz * horiz / ( 2.0 * uEarthR );
  vWorld = world;
  vDistance = length( world - uCamPos );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const TERRAIN_FRAG = /* glsl */ `
layout( location = 0 ) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
${ATMOS_READ}
${NOISE_GLSL}
uniform sampler2D uRock;
uniform sampler2D uRockN;
uniform sampler2D uCliff;
uniform sampler2D uScree;
uniform sampler2D uHeath;
uniform sampler2D uSnowTex;
uniform sampler2D uShore;
uniform vec3 uSkyLight;
uniform float uSnowline;
uniform float uTreeline;
uniform float uTreeDensity;
uniform vec3 uTreeColor;
uniform float uWet;
uniform float uRockGain;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDistance;
varying float vHeight;

/** Triplanar sample: a cliff has no sensible flat UV, so it is blended from three projections. */
vec3 triplanar( sampler2D tex, vec3 p, vec3 n, float scale ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= ( w.x + w.y + w.z );
  vec3 a = texture( tex, p.zy * scale ).rgb;
  vec3 b = texture( tex, p.xz * scale ).rgb;
  vec3 c = texture( tex, p.xy * scale ).rgb;
  return a * w.x + b * w.y + c * w.z;
}

void main() {
  vec3 N = normalize( vNormalW );
  float slope = 1.0 - clamp( N.y, 0.0, 1.0 );
  float h = vHeight;

  // Detail fades out with distance: at five kilometres a one-metre feature is well under a pixel,
  // and sampling it is how a far hillside starts to crawl.
  float detail = 1.0 - smoothstep( 600.0, 4000.0, vDistance );

  vec3 rock = triplanar( uRock, vWorld, N, 0.33 );
  vec3 cliff = triplanar( uCliff, vWorld, N, 0.25 );
  vec3 scree = texture( uScree, vWorld.xz * 0.5 ).rgb;
  vec3 heath = texture( uHeath, vWorld.xz * 0.5 ).rgb;
  vec3 snow = texture( uSnowTex, vWorld.xz * 0.5 ).rgb;
  vec3 shore = triplanar( uShore, vWorld, N, 0.5 );

  // Bare rock where it is steep, scree under the cliffs, heather on the gentle lower ground.
  float steep = smoothstep( 0.35, 0.68, slope );
  vec3 albedo = mix( rock, cliff, steep );
  // Heather and moss only get a hold where it is gentle enough to hold soil, and only in
  // patches. A fjord wall is mostly bare rock, which is the whole point of it.
  float gentle = smoothstep( 0.30, 0.10, slope );
  float green = gentle * smoothstep( 2.0, 40.0, h ) * ( 1.0 - smoothstep( uTreeline * 1.3, uTreeline * 2.0, h ) );
  green *= smoothstep( 0.30, 0.68, vnoise( vWorld.xz * 0.003 ) * 0.65 + vnoise( vWorld.xz * 0.014 ) * 0.35 );
  albedo = mix( albedo, heath, green * 0.8 );
  float screeMask = smoothstep( 0.58, 0.34, slope ) * smoothstep( 0.0, 1.0, vnoise( vWorld.xz * 0.0016 ) * 1.4 - 0.2 );
  albedo = mix( albedo, scree, screeMask * ( 1.0 - green ) * 0.5 );

  // The trees, as colour at this range: the instanced ones only stand near the boat.
  float treeBand = smoothstep( 8.0, 45.0, h ) * ( 1.0 - smoothstep( uTreeline * 0.75, uTreeline * 1.2, h ) );
  float treeMask = treeBand * smoothstep( 0.46, 0.16, slope ) * uTreeDensity;
  // Trees gather in the gullies and thin out on the shoulders, which is what gives a wooded
  // hillside its grain. Below the threshold there are none at all rather than a green wash.
  treeMask *= smoothstep( 0.46, 0.78, vnoise( vWorld.xz * 0.0024 ) * 0.55 + vnoise( vWorld.xz * 0.0095 ) * 0.45 );
  albedo = mix( albedo, uTreeColor * ( 0.7 + 0.6 * vnoise( vWorld.xz * 0.07 ) ), clamp( treeMask, 0.0, 0.88 ) );

  // Snow: above a line that is lower on a north face, and never on anything near vertical.
  float aspect = clamp( -N.z, -1.0, 1.0 );           // north is -z
  float line = uSnowline - aspect * 70.0;
  float snowMask = smoothstep( line, line + 120.0, h ) * smoothstep( 0.72, 0.42, slope );
  snowMask *= 0.55 + 0.45 * vnoise( vWorld.xz * 0.006 );
  albedo = mix( albedo, snow, clamp( snowMask, 0.0, 0.96 ) );

  // The shore: everything the sea reaches is dark, wet and bare, with a weed line above it.
  float tide = smoothstep( 4.5, 0.2, h );
  albedo = mix( albedo, shore * 0.8, tide * 0.85 );
  float wetBand = smoothstep( 2.2, 0.0, h );
  albedo *= mix( 1.0, 0.45, wetBand * ( 0.5 + 0.5 * uWet ) );

  // Light. A face standing up out of the sea sees half the sky and half the water, and the water
  // is a long way from black: without its share a backlit cliff three hundred metres off goes to
  // a flat silhouette, which is not what one looks like.
  float ndl = max( dot( N, uSunDir ), 0.0 );
  float ndlm = max( dot( N, uMoonDir ), 0.0 );
  float up = clamp( N.y, 0.0, 1.0 );
  vec3 seaRadiance = uSkyLight * 0.085 + uSunColor * 0.018 * max( uSunDir.y, 0.0 );
  vec3 light = uSunColor * ndl + uMoonColor * ndlm
    + uSkyLight * ( 0.5 + 0.5 * up )
    + seaRadiance * 3.14159265 * ( 0.5 - 0.5 * up );
  vec3 color = albedo * uRockGain * light * 0.3183;
  // Wet rock at the waterline is shiny: a little specular off the sun and the sky.
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 H = normalize( uSunDir + V );
  float spec = pow( max( dot( N, H ), 0.0 ), 48.0 ) * wetBand * 0.25;
  color += uSunColor * spec;

  color = applyAerial( color, normalize( vWorld - cameraPosition ), vDistance );
  gl_FragColor = vec4( color, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// =============================================================================================
// Terrain
// =============================================================================================

export class Terrain {
  constructor(scene, renderer, materials, rng) {
    this.scene = scene;
    this.renderer = renderer;
    this.materials = materials;
    this.rng = rng;
    this.nearCentre = new THREE.Vector2(1e9, 1e9);
    this.farCentre = new THREE.Vector2(1e9, 1e9);
    this.navCentre = new THREE.Vector2(1e9, 1e9);
    this.navData = null;

    const make = (size) => new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.nearTarget = make(LAND.near.size);
    this.farTarget = make(LAND.far.size);
    this.navTarget = make(LAND.nav.size);

    this.bakeScene = new THREE.Scene();
    this.bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bakeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      uniforms: {
        uCentre: { value: new THREE.Vector2() },
        uHalf: { value: 1 },
        uSize: { value: 1 },
        uWorldOrigin: G.uWorldOrigin,
      },
      depthTest: false, depthWrite: false,
    });
    this.bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMaterial);
    this.bakeQuad.frustumCulled = false;
    this.bakeScene.add(this.bakeQuad);

    this.nearFrame = new THREE.Vector4(0, 0, LAND.near.half, 1 / LAND.near.half);
    this.farFrame = new THREE.Vector4(0, 0, LAND.far.half, 1 / LAND.far.half);
    this.buildMesh();
  }

  // --- baking ----------------------------------------------------------------------------------

  bake(target, centre, half, size) {
    const u = this.bakeMaterial.uniforms;
    u.uCentre.value.copy(centre);
    u.uHalf.value = half;
    u.uSize.value = size;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.bakeScene, this.bakeCamera);
    this.renderer.setRenderTarget(prev);
  }

  /** Re-bakes whichever fields the boat has moved out of. Cheap: one pass each, rarely. */
  follow(pos) {
    const p = new THREE.Vector2(pos.x, pos.z);
    if (p.distanceTo(this.nearCentre) > LAND.nearStep) {
      this.nearCentre.copy(p);
      this.bake(this.nearTarget, p, LAND.near.half, LAND.near.size);
      this.nearFrame.set(p.x, p.y, LAND.near.half, 1 / LAND.near.half);
    }
    if (p.distanceTo(this.farCentre) > LAND.farStep) {
      this.farCentre.copy(p);
      this.bake(this.farTarget, p, LAND.far.half, LAND.far.size);
      this.farFrame.set(p.x, p.y, LAND.far.half, 1 / LAND.far.half);
    }
    if (p.distanceTo(this.navCentre) > LAND.navStep) {
      this.navCentre.copy(p);
      this.bake(this.navTarget, p, LAND.nav.half, LAND.nav.size);
      this.readNav();
      return true; // the chart changed: whoever is steering should look again
    }
    return false;
  }

  /**
   * Pulls the coarse field back off the GPU so the autopilot has a chart. 256 x 256 floats is a
   * megabyte and it stalls the pipeline, so it happens only when the boat has run two kilometres,
   * which is once every ten minutes or so.
   */
  readNav() {
    const n = LAND.nav.size;
    this.navData ??= new Float32Array(n * n * 4);
    this.renderer.readRenderTargetPixels(this.navTarget, 0, 0, n, n, this.navData);
    this.renderer.setRenderTarget(null);
  }

  /** The sea bed (or the hill) at a world point, from the chart. Positive is land. */
  heightAt(x, z) {
    if (!this.navData) return -100;
    const n = LAND.nav.size, half = LAND.nav.half;
    const u = ((x - this.navCentre.x) / half) * 0.5 + 0.5;
    const v = ((z - this.navCentre.y) / half) * 0.5 + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return -100;
    // Bilinear, because the autopilot steers on the gradient of this and a stepped chart makes
    // it hunt.
    const fx = u * (n - 1), fz = v * (n - 1);
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1);
    const tx = fx - x0, tz = fz - z0;
    const at = (xi, zi) => this.navData[(zi * n + xi) * 4];
    return lerp(lerp(at(x0, z0), at(x1, z0), tx), lerp(at(x0, z1), at(x1, z1), tx), tz);
  }

  /** How deep the water is at a point, in metres; zero or less means aground. */
  depthAt(x, z) { return -this.heightAt(x, z); }

  // --- the mesh ----------------------------------------------------------------------------------

  buildMesh() {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.scene.add(this.group);
    this.materialsList = [];
    this.levels = [];
    const centreGeo = gridGeometry(LAND.grid, false);
    const ringGeo = gridGeometry(LAND.grid, true);
    this.geometries = [centreGeo, ringGeo];

    const make = (geo, half) => {
      const cell = (2 * half) / LAND.grid;
      const material = this.makeMaterial(cell);
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 5;
      mesh.layers.set(LAYER.DEFAULT);
      mesh.layers.enable(LAYER.WORLD);
      this.group.add(mesh);
      this.materialsList.push(material);
      this.levels.push({ mesh, material, half, cell });
    };
    make(centreGeo, LAND.centreHalf);
    for (let i = 0; i < LAND.rings; i++) make(ringGeo, LAND.centreHalf * Math.pow(2, i + 1));
  }

  makeMaterial(cell) {
    const white = new THREE.DataTexture(new Uint8Array([160, 160, 160, 255]), 1, 1, THREE.RGBAFormat);
    white.needsUpdate = true;
    const tex = (tag) => ({ value: white });
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSkyLut: G.uSkyLut, uTransLut: G.uTransLut,
        uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uSunColor: G.uSunColor, uMoonColor: G.uMoonColor,
        uHaze: G.uHaze, uHazeFar: G.uHazeFar, uSkyLight: G.uSkyLight,
        uLandNear: { value: this.nearTarget.texture },
        uLandFar: { value: this.farTarget.texture },
        uLandNearFrame: { value: this.nearFrame },
        uLandFarFrame: { value: this.farFrame },
        uPatchCentre: { value: new THREE.Vector2() },
        uPatchScale: { value: 1 },
        uCell: { value: cell },
        uCamPos: { value: v3() },
        uEarthR: { value: EARTH_R },
        uRock: tex('mat:rock'), uRockN: tex('mat:rock'), uCliff: tex('mat:rock-cliff'),
        uScree: tex('mat:scree'), uHeath: tex('mat:heath'), uSnowTex: tex('mat:snow'),
        uShore: tex('mat:shore'),
        uSnowline: { value: LAND.snowline },
        uTreeline: { value: LAND.treeline },
        uTreeDensity: { value: 0.85 },
        uTreeColor: { value: v3(0.045, 0.072, 0.045) },
        // The scanned granite is very dark indeed (it is a scan of dark rock), and a fjord wall
        // is a mid grey. The gain is applied to the albedo rather than to the light, so the
        // shading still behaves.
        uRockGain: { value: 2.7 },
        uWet: { value: 0.4 },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      side: THREE.DoubleSide,
    });
    return m;
  }

  /** The scanned ground materials, as they arrive. */
  setAsset(tag, asset) {
    const slot = {
      'mat:rock': 'uRock', 'mat:rock-cliff': 'uCliff', 'mat:scree': 'uScree',
      'mat:heath': 'uHeath', 'mat:snow': 'uSnowTex', 'mat:shore': 'uShore',
    }[tag];
    if (!slot || !asset?.color) return;
    for (const m of this.materialsList) m.uniforms[slot].value = asset.color;
  }

  // --- the frame ------------------------------------------------------------------------------

  step(dt, camera, settings) {
    const cam = camera.position;
    const chartMoved = this.follow(cam);
    for (const lvl of this.levels) {
      const u = lvl.material.uniforms;
      const snap = 2 * lvl.cell;
      u.uPatchCentre.value.set(Math.round(cam.x / snap) * snap, Math.round(cam.z / snap) * snap);
      u.uPatchScale.value = lvl.half;
      u.uCamPos.value.copy(cam);
    }
    return chartMoved;
  }

  /** The snow line and how wet the rock is follow the weather. */
  setSeason(snowline, wet, treeDensity) {
    for (const m of this.materialsList) {
      m.uniforms.uSnowline.value = snowline;
      m.uniforms.uWet.value = wet;
      m.uniforms.uTreeDensity.value = treeDensity;
    }
  }

  dispose() {
    this.nearTarget.dispose();
    this.farTarget.dispose();
    this.navTarget.dispose();
    this.bakeQuad.geometry.dispose();
    this.bakeMaterial.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materialsList) m.dispose();
    this.scene.remove(this.group);
  }
}

/** The same grid the sea uses: a square of cells over [-1, 1], hollow for the rings. */
export function gridGeometry(n, hollow) {
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      const i = (z * (n + 1) + x) * 3;
      pos[i] = (x / n) * 2 - 1;
      pos[i + 2] = (z / n) * 2 - 1;
    }
  }
  const lo = n / 4, hi = (3 * n) / 4;
  const idx = [];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      if (hollow && x >= lo && x < hi && z >= lo && z < hi) continue;
      const a = z * (n + 1) + x;
      idx.push(a, a + (n + 1), a + 1, a + 1, a + (n + 1), a + n + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  return g;
}
