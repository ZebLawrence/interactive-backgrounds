// Trawler — The sea: three spectral cascades inverse-transformed on the GPU every frame, drawn on
// a clipmap centred on the boat, and shaded against the same atmosphere as the sky.
//
// The maths is in oceanspec.js (the spectrum, checked against the Douglas scale and Cox-Munk) and
// fft.js (the transform, checked against a direct one). What is here is the plumbing and the look.
//
// Per frame, for each of the three cascades:
//   spectrum   h0(k) and its partner evolve by e^{i w(k) t} into four complex fields, written to
//              two RGBA32F targets at once (multiple render targets, so one pass does all four)
//   transform  eight butterfly passes along x, eight along y, ping-ponging between two pairs
//   assemble   the eight real fields become a displacement map (Dx, Dy, Dz, Jacobian) and a
//              derivative map (dDy/dx, dDy/dz, folding), both mipmapped so distance filters them
//   foam       the folding feeds a buffer that decays over about twelve seconds and drifts
//              downwind, so a whitecap leaves a trail behind it instead of blinking
//
// The clipmap is a centre patch of 0.25 m cells and ten rings, each twice the last, out to 16 km.
// Each ring samples each cascade's displacement at the mip level that matches its own cell size,
// so a ring with 8 m cells gets the swell and none of the chop, and nothing aliases. Vertices morph
// onto the next coarser grid at the outer edge of each ring, which closes the seams.
//
// The sea is drawn on a curved earth: every vertex drops by d^2/2R. From a 5.6 m eye that puts the
// horizon 8.4 km away, which is what lets an island rise over it instead of standing on it.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ, NOISE_GLSL, BRDF_GLSL } from './shaders.js';
import { CLOUD_GLSL } from './sky.js';
import { LAND_READ } from './terrain.js';
import { WAKE_GLSL } from './wake.js';
import { CASCADES, FFT_N, buildSea, longWaveComponents, coxMunkSlopeVariance } from './oceanspec.js';
import { butterflyData, log2i } from './fft.js';
import { clamp01, lerp, v3, srgbVec } from './util.js';

export const EARTH_R = 6371000;
export const CLIP_LEVELS = 10; // rings beyond the centre patch
export const CLIP_GRID = 128; // cells across a patch or a ring
export const CENTRE_HALF = 16; // m: half-width of the finest patch (0.25 m cells)

// =============================================================================================
// The simulation
// =============================================================================================

const QUAD_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/** Evolves h0 into the four complex fields the transform needs. */
const SPECTRUM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uH0;
uniform float uTime;
uniform float uSize;   // the patch size in metres
uniform float uN;
uniform float uChop;
layout( location = 0 ) out vec4 fieldA;
layout( location = 1 ) out vec4 fieldB;

vec2 cmul( vec2 a, vec2 b ) { return vec2( a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x ); }

void main() {
  ivec2 c = ivec2( gl_FragCoord.xy );
  vec4 h0 = texelFetch( uH0, c, 0 );
  float mx = c.x < int( uN ) / 2 ? float( c.x ) : float( c.x ) - uN;
  float mz = c.y < int( uN ) / 2 ? float( c.y ) : float( c.y ) - uN;
  float dk = 6.28318530718 / uSize;
  vec2 k = vec2( mx, mz ) * dk;
  float kl = length( k );
  if ( kl < 1e-6 ) { fieldA = vec4( 0.0 ); fieldB = vec4( 0.0 ); return; }
  // Deep water with the capillary term: below a couple of centimetres surface tension rules.
  float w = sqrt( 9.81 * kl * ( 1.0 + ( kl / 370.0 ) * ( kl / 370.0 ) ) );
  // The hourly wrap: quantising w to a whole number of cycles per wrap would need a per-k rounding,
  // so the clock is simply kept small and the phase taken modulo 2 pi.
  float phase = mod( w * uTime, 6.28318530718 );
  vec2 e = vec2( cos( phase ), sin( phase ) );
  vec2 ec = vec2( e.x, -e.y );
  // h(k, t) = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
  vec2 h = cmul( h0.xy, e ) + cmul( h0.zw, ec );
  vec2 ih = vec2( -h.y, h.x ); // i * h
  vec2 kn = k / kl;

  // Four complex fields, each one Hermitian on its own, so each transform's real and imaginary
  // parts come out as two independent real fields:
  //   A.rg -> ( Dy, Dx )      A.ba -> ( Dz, dDy/dx )
  //   B.rg -> ( dDy/dz, dDx/dx )   B.ba -> ( dDz/dz, dDx/dz )
  vec2 sDy = h;
  vec2 sDx = -ih * kn.x * uChop;
  vec2 sDz = -ih * kn.y * uChop;
  vec2 sDyDx = ih * k.x;
  vec2 sDyDz = ih * k.y;
  vec2 sDxDx = -h * k.x * kn.x * uChop;
  vec2 sDzDz = -h * k.y * kn.y * uChop;
  vec2 sDxDz = -h * k.y * kn.x * uChop;

  fieldA = vec4( sDy + vec2( -sDx.y, sDx.x ), sDz + vec2( -sDyDx.y, sDyDx.x ) );
  fieldB = vec4( sDyDz + vec2( -sDxDx.y, sDxDx.x ), sDzDz + vec2( -sDxDz.y, sDxDz.x ) );
}
`;

/** One butterfly pass, the exact counterpart of fft.js butterflyPass. */
const BUTTERFLY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrcA;
uniform sampler2D uSrcB;
uniform sampler2D uButterfly;
uniform int uStage;
uniform int uVertical;
layout( location = 0 ) out vec4 outA;
layout( location = 1 ) out vec4 outB;

vec2 cmul( vec2 a, vec2 b ) { return vec2( a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x ); }

void main() {
  ivec2 c = ivec2( gl_FragCoord.xy );
  int idx = uVertical == 0 ? c.x : c.y;
  vec4 bf = texelFetch( uButterfly, ivec2( uStage, idx ), 0 );
  ivec2 top = uVertical == 0 ? ivec2( int( bf.z ), c.y ) : ivec2( c.x, int( bf.z ) );
  ivec2 bot = uVertical == 0 ? ivec2( int( bf.w ), c.y ) : ivec2( c.x, int( bf.w ) );
  vec2 w = bf.xy;
  vec4 pa = texelFetch( uSrcA, top, 0 ), qa = texelFetch( uSrcA, bot, 0 );
  vec4 pb = texelFetch( uSrcB, top, 0 ), qb = texelFetch( uSrcB, bot, 0 );
  outA = vec4( pa.rg + cmul( w, qa.rg ), pa.ba + cmul( w, qa.ba ) );
  outB = vec4( pb.rg + cmul( w, qb.rg ), pb.ba + cmul( w, qb.ba ) );
}
`;

/** Turns the transformed fields into the two maps the water shader reads. */
const ASSEMBLE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
layout( location = 0 ) out vec4 outDisp;  // Dx, Dy, Dz, Jacobian
layout( location = 1 ) out vec4 outDeriv; // dDy/dx, dDy/dz, folding, unused

void main() {
  ivec2 c = ivec2( gl_FragCoord.xy );
  vec4 a = texelFetch( uA, c, 0 );
  vec4 b = texelFetch( uB, c, 0 );
  float Dy = a.r, Dx = a.g, Dz = a.b, dYdX = a.a;
  float dYdZ = b.r, dXdX = b.g, dZdZ = b.b, dXdZ = b.a;
  // The Jacobian of the horizontal displacement. Under one the surface is being squeezed toward a
  // crest; under zero it has folded through itself, which is a breaking wave.
  float jxx = 1.0 + dXdX;
  float jzz = 1.0 + dZdZ;
  float jac = jxx * jzz - dXdZ * dXdZ;
  outDisp = vec4( Dx, Dy, Dz, jac );
  // Folding, not steepness: only where the Jacobian really collapses is the surface turning over
  // on itself. A plain 1 - J marks every steep crest and paints solid white ribbons along them.
  outDeriv = vec4( dYdX, dYdZ, smoothstep( 0.5, 0.0, jac ), 0.0 );
}
`;

/**
 * Foam. Folding puts it there, it fades over about twelve seconds, and it drifts downwind at the
 * Stokes rate, so a whitecap leaves a wake rather than flickering on and off in place.
 */
const FOAM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uDeriv;
uniform vec2 uDrift;   // uv the field has moved since the last step
uniform float uDecay;
uniform float uBirth;
uniform float uThreshold;
layout( location = 0 ) out vec4 outFoam;

void main() {
  vec2 uv = gl_FragCoord.xy / vec2( textureSize( uDeriv, 0 ) );
  float prev = texture( uPrev, uv - uDrift ).r * uDecay;
  float fold = texture( uDeriv, uv ).b;
  float born = smoothstep( uThreshold, uThreshold + 0.45, fold ) * uBirth;
  outFoam = vec4( max( prev, born ), 0.0, 0.0, 1.0 );
}
`;

/** One cascade's worth of GPU state. */
class Cascade {
  constructor(renderer, spec, n) {
    this.renderer = renderer;
    this.spec = spec;
    this.n = n;
    const rt = (opts) => new THREE.WebGLRenderTarget(n, n, {
      type: THREE.FloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false, count: 2, ...opts,
    });
    this.ping = rt();
    this.pong = rt();
    // The maps the water reads: half float, linear, mipmapped, and wrapping with the tile.
    this.maps = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: true, count: 2,
    });
    const foamOpts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
    };
    this.foam = [new THREE.WebGLRenderTarget(n, n, foamOpts), new THREE.WebGLRenderTarget(n, n, foamOpts)];
    this.foamIndex = 0;
    this.h0 = new THREE.DataTexture(new Float32Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.FloatType);
    this.h0.minFilter = this.h0.magFilter = THREE.NearestFilter;
    this.h0.needsUpdate = true;
    this.meanSquareSlope = 0;
    this.variance = 0;
    this.driftUv = new THREE.Vector2();
  }

  get displacement() { return this.maps.textures[0]; }
  get derivatives() { return this.maps.textures[1]; }
  get foamTexture() { return this.foam[this.foamIndex].texture; }

  setSpectrum(data, variance, mss) {
    this.h0.image.data.set(data);
    this.h0.needsUpdate = true;
    this.variance = variance;
    this.meanSquareSlope = mss;
  }

  dispose() {
    this.ping.dispose();
    this.pong.dispose();
    this.maps.dispose();
    for (const f of this.foam) f.dispose();
    this.h0.dispose();
  }
}

/** Runs the passes. One full-screen triangle pair, re-pointed at each target in turn. */
class SimPasses {
  constructor(renderer, n) {
    this.renderer = renderer;
    this.n = n;
    this.stages = log2i(n);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(this.geometry, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    const bf = butterflyData(n);
    this.butterfly = new THREE.DataTexture(bf, this.stages, n, THREE.RGBAFormat, THREE.FloatType);
    this.butterfly.minFilter = this.butterfly.magFilter = THREE.NearestFilter;
    this.butterfly.needsUpdate = true;

    const mat = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: frag,
      uniforms, depthTest: false, depthWrite: false,
    });
    this.spectrum = mat(SPECTRUM_FRAG, {
      uH0: { value: null }, uTime: { value: 0 }, uSize: { value: 1 }, uN: { value: n }, uChop: { value: 1 },
    });
    this.butterflyMat = mat(BUTTERFLY_FRAG, {
      uSrcA: { value: null }, uSrcB: { value: null }, uButterfly: { value: this.butterfly },
      uStage: { value: 0 }, uVertical: { value: 0 },
    });
    this.assemble = mat(ASSEMBLE_FRAG, { uA: { value: null }, uB: { value: null } });
    this.foam = mat(FOAM_FRAG, {
      uPrev: { value: null }, uDeriv: { value: null }, uDrift: { value: new THREE.Vector2() },
      uDecay: { value: 0.99 }, uBirth: { value: 1 }, uThreshold: { value: 0.35 },
    });
  }

  run(material, target) {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Everything for one cascade, from h0 to the maps the water reads. */
  step(c, time, chop, driftUv, foamDecay, foamBirth, foamThreshold) {
    this.spectrum.uniforms.uH0.value = c.h0;
    this.spectrum.uniforms.uTime.value = time;
    this.spectrum.uniforms.uSize.value = c.spec.size;
    this.spectrum.uniforms.uChop.value = chop;
    this.run(this.spectrum, c.ping);

    let src = c.ping, dst = c.pong;
    for (let dir = 0; dir < 2; dir++) {
      for (let s = 0; s < this.stages; s++) {
        this.butterflyMat.uniforms.uSrcA.value = src.textures[0];
        this.butterflyMat.uniforms.uSrcB.value = src.textures[1];
        this.butterflyMat.uniforms.uStage.value = s;
        this.butterflyMat.uniforms.uVertical.value = dir;
        this.run(this.butterflyMat, dst);
        [src, dst] = [dst, src];
      }
    }
    this.assemble.uniforms.uA.value = src.textures[0];
    this.assemble.uniforms.uB.value = src.textures[1];
    this.run(this.assemble, c.maps);

    const next = 1 - c.foamIndex;
    this.foam.uniforms.uPrev.value = c.foam[c.foamIndex].texture;
    this.foam.uniforms.uDeriv.value = c.maps.textures[1];
    this.foam.uniforms.uDrift.value.copy(driftUv);
    this.foam.uniforms.uDecay.value = foamDecay;
    this.foam.uniforms.uBirth.value = foamBirth;
    this.foam.uniforms.uThreshold.value = foamThreshold;
    this.run(this.foam, c.foam[next]);
    c.foamIndex = next;
  }

  dispose() {
    this.geometry.dispose();
    this.butterfly.dispose();
    for (const m of [this.spectrum, this.butterflyMat, this.assemble, this.foam]) m.dispose();
  }
}

// =============================================================================================
// The water's own shaders
// =============================================================================================

const OCEAN_COMMON = /* glsl */ `
uniform sampler2D uDisp0, uDisp1, uDisp2;
uniform sampler2D uDeriv0, uDeriv1, uDeriv2;
uniform sampler2D uFoam0, uFoam1, uFoam2;
uniform vec3 uCascadeSize;   // the three patch sizes, metres
uniform float uFftN;         // texels across a cascade
uniform float uCell;         // this clipmap level's cell size, metres
uniform vec2 uPatchCentre;
uniform float uPatchScale;
uniform vec3 uCamPos;

/**
 * The mip level at which a cascade's texels are the size of this level's cells. A ring of 8 m
 * cells reading a 1024 m cascade whose texels are 4 m across wants level 1: anything finer it
 * could not draw anyway, and sampling it would only alias.
 */
float cascadeLod( float size ) {
  return max( 0.0, log2( max( uCell * uFftN / size, 1e-4 ) ) );
}

/** How much of a cascade still means anything at this cell size: 1 resolved, 0 fully averaged. */
float cascadeWeight( float lod ) {
  return 1.0 - smoothstep( 5.0, 7.0, lod );
}

vec3 oceanDisplacement( vec2 p ) {
  vec3 d = vec3( 0.0 );
  float l0 = cascadeLod( uCascadeSize.x );
  float l1 = cascadeLod( uCascadeSize.y );
  float l2 = cascadeLod( uCascadeSize.z );
  d += textureLod( uDisp0, p / uCascadeSize.x, l0 ).xyz * cascadeWeight( l0 );
  d += textureLod( uDisp1, p / uCascadeSize.y, l1 ).xyz * cascadeWeight( l1 );
  d += textureLod( uDisp2, p / uCascadeSize.z, l2 ).xyz * cascadeWeight( l2 );
  return d;
}
`;

const OCEAN_VERT = /* glsl */ `
${OCEAN_COMMON}
${WAKE_GLSL}
uniform float uEarthR;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vView;
varying vec2 vFlat;      // the undisplaced horizontal position: the maps are indexed by it
varying float vDistance;

void main() {
  // The patch is built in [-1, 1]; its own snapped centre and scale put it in the world.
  vec2 p = uPatchCentre + position.xz * uPatchScale;
  // Morph onto the next coarser grid toward the outer edge, which closes the seam with the ring
  // outside: the extra vertices along the shared edge collapse onto their coarse neighbours.
  float edge = max( abs( position.x ), abs( position.z ) );
  float morph = smoothstep( 0.78, 0.97, edge );
  vec2 coarse = floor( p / ( 2.0 * uCell ) + 0.5 ) * ( 2.0 * uCell );
  p = mix( p, coarse, morph );

  vec3 d = oceanDisplacement( p );
  vec3 world = vec3( p.x + d.x, d.y, p.y + d.z );
  // Her own wake lifts the water here; the white that goes with it is worked out per pixel in the
  // fragment shader, because a clipmap cell out here is eight metres across and a foam edge
  // interpolated across one comes out as a staircase.
  world.y += kelvinWake( world.xz, uTime ).x;
  vFlat = p;
  float horiz = length( world.xz - uCamPos.xz );
  // A curved earth: the sea falls away as the square of the distance, which is what puts the
  // horizon 8.4 km off a 5.6 m eye and lets an island rise over it.
  world.y -= horiz * horiz / ( 2.0 * uEarthR );
  vWorld = world;
  vDistance = length( world - uCamPos );
  vec4 mv = viewMatrix * vec4( world, 1.0 );
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const OCEAN_FRAG = /* glsl */ `
// A GLSL3 ShaderMaterial has to declare its own fragment output; three only supplies the
// gl_FragColor stand-in for shaders it upgrades from GLSL ES 1.00. The define is what lets the
// tone-mapping and colour-space chunks below keep working unchanged.
layout( location = 0 ) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
${ATMOS_READ}
${LAND_READ}
${WAKE_GLSL}
${NOISE_GLSL}
${BRDF_GLSL}
${CLOUD_GLSL}
${OCEAN_COMMON}
uniform vec3 uSeaDeep;
uniform vec3 uSeaShallow;
uniform vec3 uFoamColor;
uniform vec3 uSkyLight;
uniform vec3 uCascadeMss;    // mean square slope held by each cascade
uniform vec3 uCascadeFine;   // the shortest wavelength each cascade carries
uniform float uPixelAngle;   // radians a pixel subtends: how big a footprint is at a distance
uniform float uUnresolvedMss;
uniform float uFoamAmount;
uniform float uWhitecap;
uniform float uSpray;
uniform float uWindSpeed;
uniform float uSea;
uniform float uTime;
uniform float uEarthR;
varying vec3 vWorld;
varying vec3 vView;
varying vec2 vFlat;
varying float vDistance;

/** The three cascades' slopes and foam at this point, each at whatever mip the pixel deserves. */
void sampleSurface( out vec2 slope, out float fold, out float foam ) {
  vec2 u0 = vFlat / uCascadeSize.x, u1 = vFlat / uCascadeSize.y, u2 = vFlat / uCascadeSize.z;
  vec4 d0 = texture( uDeriv0, u0 );
  vec4 d1 = texture( uDeriv1, u1 );
  vec4 d2 = texture( uDeriv2, u2 );
  slope = d0.xy + d1.xy + d2.xy;
  fold = max( max( d0.z, d1.z ), d2.z );
  foam = max( max( texture( uFoam0, u0 ).r, texture( uFoam1, u1 ).r ), texture( uFoam2, u2 ).r );
}

void main() {
  vec3 V = normalize( cameraPosition - vWorld );
  vec2 slope;
  float fold, foam;
  sampleSurface( slope, fold, foam );
  // Past a few hundred metres a wave is smaller than a pixel, so the surface stops being geometry
  // and becomes a statistic: the slopes average to nothing, the folding is unreadable, and the
  // whitecaps are just the coverage the wind implies. Keeping the maps out there instead reads a
  // texture through its coarsest mip levels, which is where the bright blocks along the horizon
  // come from, and it crawls as the boat moves (guidelines section 4).
  float farOff = smoothstep( 400.0, 2600.0, vDistance );
  slope = mix( slope, vec2( 0.0 ), farOff );
  fold = mix( fold, 0.0, farOff );
  foam = mix( foam, uWhitecap * 0.75, farOff );
  vec3 N = normalize( vec3( -slope.x, 1.0, -slope.y ) );

  // What the pixel cannot resolve becomes roughness instead of detail. Without this the sun's
  // glitter path turns into a field of crawling white dots at the horizon.
  float footprint = vDistance * uPixelAngle;
  float mss = 0.0;
  mss += uCascadeMss.x * smoothstep( uCascadeFine.x, uCascadeSize.x * 0.1, footprint );
  mss += uCascadeMss.y * smoothstep( uCascadeFine.y, uCascadeSize.y * 0.1, footprint );
  mss += uCascadeMss.z * smoothstep( uCascadeFine.z, uCascadeSize.z * 0.1, footprint );
  // Everything finer than 25 cm, which no map here resolves: the difference between what the
  // cascades carry and what Cox and Munk measured for this wind. It is what turns a pin-sharp
  // glint into the soft sparkle of real water; without it every facet is a mirror.
  mss += uUnresolvedMss;
  vec2 rms = sqrt( vec2( max( mss, 1e-6 ) ) );

  float ndvRaw = dot( N, V );
  // A microfacet model divides by n.v, and at the horizon n.v goes to zero: the Smith term cancels
  // most of it but not all, and what is left is a handful of blown-out blobs strung along the
  // horizon wherever the half vector lands near a likely facet. Real water does not do that,
  // because at those angles every facet is shadowed by the wave in front of it. So the denominator
  // is floored and the sun's lobe is faded out over the last few degrees; the sky's own reflection,
  // which is what really lights the horizon, is left alone.
  float ndv = max( ndvRaw, 0.018 );
  float horizonFade = smoothstep( 0.0, 0.07, ndvRaw );
  float fres = fresnelWater( max( ndvRaw, 1e-3 ) );

  // --- what comes down: the sky, and the sun as a rough specular lobe -------------------------
  vec3 R = reflect( -V, N );
  // A reflected ray that dips below the horizon would be looking at more water, not sky; bend it
  // back up along the horizon, which is what the far sea does to a grazing reflection anyway.
  R.y = abs( R.y ) * 0.5 + R.y * 0.5 + 0.004;
  R = normalize( R );
  vec3 sky = skyRadiance( R );
  // The reflected cloud, softened: a rough surface reflects a cone of sky, not a mirror image.
  vec4 refl = cumulus( vWorld, R, uSunDir, uSunColor, 0.3 );
  sky = mix( sky, refl.rgb, refl.a * 0.8 );

  // Cook-Torrance: the outgoing radiance from an irradiance measured normal to the sun is
  // D * G * F / (4 n.v); the cosine at the surface is already inside G's other half.
  vec3 H = normalize( uSunDir + V );
  float ndl = max( dot( N, uSunDir ), 1e-3 );
  float g = smithG1( ndv, rms.x ) * smithG1( ndl, rms.x );
  vec3 glitter = uSunColor * ( ggxAniso( H, rms ) * g * fres / ( 4.0 * ndv ) ) * horizonFade * step( 0.0, uSunDir.y );
  vec3 Hm = normalize( uMoonDir + V );
  float ndlm = max( dot( N, uMoonDir ), 1e-3 );
  glitter += uMoonColor * ( ggxAniso( Hm, rms ) * smithG1( ndv, rms.x ) * smithG1( ndlm, rms.x ) * fres / ( 4.0 * ndv ) )
           * horizonFade * step( 0.0, uMoonDir.y );

  // --- what comes up: the water's own colour ---------------------------------------------------
  // Red light is gone within a couple of metres and green within ten, so what comes back out of
  // deep water is the blue-green of what is left. Over a shelf the bottom returns some of it.
  // Deep water returns about six per cent of what falls on it, and only in the blue-green: that
  // is the whole of the sea's own colour. The downwelling irradiance is the sky plus the sun (and
  // the moon) on a horizontal surface, so the sea darkens honestly as the sun goes down.
  vec3 E = uSkyLight + uSunColor * max( uSunDir.y, 0.0 ) + uMoonColor * max( uMoonDir.y, 0.0 );
  // How deep it is here. Over a shelf some of the light comes back off the bottom, which is why
  // the water inshore is green and the water in the fairway is slate blue.
  float bed = landHeightAt( vWorld.xz );
  float depth = max( -bed, 0.0 );
  float shelf = 1.0 - smoothstep( 1.0, 16.0 , depth );
  vec3 body = mix( uSeaDeep, uSeaShallow, shelf * 0.85 );
  vec3 upwelling = body * E * 0.31830989;
  // The classic backlit crest: where the sun is beyond a wave, light comes through its shoulder.
  float through = pow( clamp( dot( normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) ), -V ) * 0.5 + 0.5, 0.0, 1.0 ), 3.0 );
  float crest = clamp( ( N.y - 0.92 ) * -6.0 + max( -slope.y, 0.0 ) * 1.4, 0.0, 1.0 );
  upwelling += uSeaShallow * uSunColor * through * crest * ( 1.0 - farOff ) * 0.5 * max( uSunDir.y, 0.0 );

  vec3 color = mix( upwelling, sky + glitter, fres );

  // --- foam -------------------------------------------------------------------------------------
  float coverage = clamp( foam * uFoamAmount + fold * 0.22, 0.0, 1.0 );
  coverage *= smoothstep( 0.0, 0.10, uWhitecap + 0.004 );
  // Her own wake does not need a wind to be white: the trail she has laid down and the white
  // along the arms of the Kelvin wedge, both worked out here rather than at the vertices.
  float wake = max( kelvinWake( vWorld.xz, uTime ).y, wakeFoam( vWorld.xz ) );
  coverage = max( coverage, clamp( wake * 0.85 * ( 1.0 - farOff * 0.8 ), 0.0, 1.0 ) );
  // Surf. In shoal water a wave feels the bottom, steepens and breaks, so there is white along
  // every rock whatever the sea is doing offshore. The band travels in at the shallow-water
  // celerity, sqrt(g h), which is what makes it look like it is running at the shore.
  if ( depth < 24.0 ) {
    float shoal = smoothstep( 22.0, 1.5, depth );
    float celerity = sqrt( 9.81 * max( depth, 0.4 ) );
    float phase = ( depth * 0.22 - uTime * celerity * 0.1 );
    float band = 0.5 + 0.5 * sin( phase * 6.2831853 );
    float surf = shoal * ( 0.35 + 0.65 * pow( band, 3.0 ) ) * ( 0.55 + 0.45 * uSea );
    surf *= 0.55 + 0.45 * vnoise( vFlat * 0.35 + uTime * 0.05 );
    // Right at the rock it is all white water.
    surf = max( surf, smoothstep( 2.4, 0.1, depth ) );
    coverage = max( coverage, clamp( surf, 0.0, 1.0 ) );
  }
  // Foam is not paint: it is a layer of bubbles, bright, rough and a little see-through. The grain
  // is high-frequency noise, so it has to fade out before a pixel covers more than one bubble.
  float grainFade = 1.0 - smoothstep( 25.0, 180.0, vDistance );
  float grain = ( vnoise( vFlat * 2.6 ) * 0.5 + vnoise( vFlat * 9.0 ) * 0.3 + 0.2 ) * grainFade + ( 1.0 - grainFade ) * 0.5;
  float f = clamp( coverage * ( 0.5 + grain * 0.8 ), 0.0, 1.0 );
  f *= smoothstep( 0.03, 0.26, coverage );
  vec3 foamLit = uFoamColor * E * 0.30;
  color = mix( color, foamLit, f );

  // --- the air in between -------------------------------------------------------------------------
  vec3 dir = normalize( vWorld - cameraPosition );
  color = applyAerial( color, dir, vDistance );

  gl_FragColor = vec4( color, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// =============================================================================================
// Ocean
// =============================================================================================

export class Ocean {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./util.js').Rng} rng
   * @param {import('./seastate.js').Weather} weather
   */
  constructor(scene, renderer, rng, weather) {
    this.scene = scene;
    this.renderer = renderer;
    this.rng = rng;
    this.weather = weather;
    this.time = 0;
    this.centre = new THREE.Vector2();
    this.foamDrift = new THREE.Vector2();

    this.passes = new SimPasses(renderer, FFT_N);
    this.cascades = CASCADES.map((spec) => new Cascade(renderer, spec, FFT_N));
    this.components = [];
    this.builtSea = -1;
    this.builtSwell = -1;
    this.rebuildSpectrum();

    this.buildMesh();
  }

  // --- the spectrum -------------------------------------------------------------------------------

  /** Rebuilds h0 for the current weather. A few milliseconds, so it is done rarely and eased into. */
  rebuildSpectrum() {
    const w = this.weather;
    const d = w.derived;
    const rng = this.rng.fork(`sea:${Math.round(w.time)}`);
    const normal = () => rng.normal();
    const built = buildSea(
      { u10: d.u10, fetch: d.fetch, dirRad: w.windDir },
      { ...w.swell },
      normal,
    );
    built.cascades.forEach((b, i) => this.cascades[i].setSpectrum(b.data, b.variance, b.meanSquareSlope));
    this.hs = built.hs;
    this.variance = built.variance;
    this.meanSquareSlope = built.meanSquareSlope;
    // The waves the hull feels: the same realisation, summed on the CPU.
    // What the hull feels. Cascade 0 carries everything over 16 m; a 22 m boat also answers to the
    // 6-16 m chop, so the long end of cascade 1 comes too. Both are the same realisation the GPU
    // draws, so the hull rides the waves on the screen (ocean.verify checks exactly that).
    this.components = [
      ...longWaveComponents(built.cascades[0].data, CASCADES[0].size, FFT_N, 10, 300, 0.94),
      ...longWaveComponents(built.cascades[1].data, CASCADES[1].size, FFT_N, 6, 160, 0.9),
    ];
    this.cascadeData0 = built.cascades[0].data; // kept for verify()
    this.builtSea = w.sea;
    this.builtSwell = w.swell.height;
    this.compPhase = new Float32Array(this.components.length);
    if (this.materials) this.applySpectrumUniforms();
  }

  applySpectrumUniforms() {
    if (!this.materials) return;
    const mss = this.cascades.map((c) => c.meanSquareSlope);
    const resolved = mss[0] + mss[1] + mss[2];
    const unresolved = Math.max(coxMunkSlopeVariance(this.weather.derived.u10) - resolved, 0.0008);
    for (const m of this.materials) {
      m.uniforms.uCascadeMss.value.set(mss[0], mss[1], mss[2]);
      m.uniforms.uUnresolvedMss.value = unresolved;
    }
  }

  // --- the surface, on the CPU ----------------------------------------------------------------

  /**
   * The sea's elevation at a world point, summed from the long components of the same realisation
   * the GPU is drawing. This is what the hull floats on.
   */
  heightAt(x, z, t = this.time) {
    let h = 0;
    const c = this.components;
    for (let i = 0; i < c.length; i++) {
      const w = c[i];
      h += w.amp * Math.cos(w.kx * x + w.kz * z + w.dir * w.omega * t + w.phase);
    }
    return h;
  }

  /** The surface slope (dy/dx, dy/dz) at a world point: what the hull's trim lines up with. */
  slopeAt(x, z, t = this.time) {
    let sx = 0, sz = 0;
    const c = this.components;
    for (let i = 0; i < c.length; i++) {
      const w = c[i];
      const s = -w.amp * Math.sin(w.kx * x + w.kz * z + w.dir * w.omega * t + w.phase);
      sx += s * w.kx;
      sz += s * w.kz;
    }
    return { sx, sz };
  }

  /** Elevation and slope in one pass, which is what boat.js actually wants. */
  sample(x, z, t = this.time) {
    let h = 0, sx = 0, sz = 0;
    const c = this.components;
    for (let i = 0; i < c.length; i++) {
      const w = c[i];
      const ph = w.kx * x + w.kz * z + w.dir * w.omega * t + w.phase;
      h += w.amp * Math.cos(ph);
      const s = -w.amp * Math.sin(ph);
      sx += s * w.kx;
      sz += s * w.kz;
    }
    return { h, sx, sz };
  }

  // --- the mesh -------------------------------------------------------------------------------

  buildMesh() {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    this.scene.add(this.group);
    this.materials = [];
    this.levels = [];

    const centreGeo = gridGeometry(CLIP_GRID, false);
    const ringGeo = gridGeometry(CLIP_GRID, true);
    this.geometries = [centreGeo, ringGeo];

    const make = (geo, half, cell) => {
      const material = this.makeMaterial(cell);
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false; // the patch moves with the camera every frame
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 10;
      mesh.layers.set(LAYER.DEFAULT);
      mesh.layers.enable(LAYER.WORLD);
      this.group.add(mesh);
      this.materials.push(material);
      this.levels.push({ mesh, material, half, cell });
    };

    make(centreGeo, CENTRE_HALF, (2 * CENTRE_HALF) / CLIP_GRID);
    for (let i = 0; i < CLIP_LEVELS; i++) {
      const half = CENTRE_HALF * Math.pow(2, i + 1);
      make(ringGeo, half, (2 * half) / CLIP_GRID);
    }
    this.applySpectrumUniforms();
  }

  makeMaterial(cell) {
    const c = this.cascades;
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uSkyLut: G.uSkyLut, uTransLut: G.uTransLut,
        uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uSunColor: G.uSunColor, uMoonColor: G.uMoonColor,
        uHaze: G.uHaze, uHazeFar: G.uHazeFar,
        uCloud: G.uCloud, uWind: G.uWind, uCloudDrift: G.uCloudDrift, uWorldOrigin: G.uWorldOrigin,
        uSkyLight: G.uSkyLight,
        uDisp0: { value: c[0].displacement }, uDisp1: { value: c[1].displacement }, uDisp2: { value: c[2].displacement },
        uDeriv0: { value: c[0].derivatives }, uDeriv1: { value: c[1].derivatives }, uDeriv2: { value: c[2].derivatives },
        uFoam0: { value: c[0].foamTexture }, uFoam1: { value: c[1].foamTexture }, uFoam2: { value: c[2].foamTexture },
        uCascadeSize: { value: v3(CASCADES[0].size, CASCADES[1].size, CASCADES[2].size) },
        uCascadeMss: { value: v3() },
        uCascadeFine: { value: v3(
          (2 * CASCADES[0].size) / FFT_N, (2 * CASCADES[1].size) / FFT_N, (2 * CASCADES[2].size) / FFT_N) },
        uFftN: { value: FFT_N },
        uCell: { value: cell },
        uPatchCentre: { value: new THREE.Vector2() },
        uPatchScale: { value: 1 },
        uCamPos: { value: v3() },
        uEarthR: { value: EARTH_R },
        // Diffuse reflectances, linear, not sRGB: what deep water actually sends back up is a
        // few per cent, and only in the blue-green. Over a sand or kelp shelf more of it comes
        // back and the balance shifts to green, which is the colour of the water close inshore.
        uSeaDeep: { value: v3(0.0055, 0.030, 0.042) },
        uSeaShallow: { value: v3(0.030, 0.098, 0.088) },
        uFoamColor: { value: srgbVec(0.86, 0.91, 0.94) },
        uPixelAngle: { value: 0.0005 },
        uUnresolvedMss: { value: 0.01 },
        uFoamAmount: { value: 1 },
        uWhitecap: { value: 0 },
        uSpray: { value: 0 },
        uTime: { value: 0 },
        uWindSpeed: G.uWindSpeed,
        uSea: G.uSea,
        uWakeTex: { value: null },
        uWakeFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
        uWakeBoat: { value: new THREE.Vector4(0, 0, 0, 1) },
        uWakeDrive: { value: new THREE.Vector2(0, 0) },
        uLandNear: { value: null },
        uLandFar: { value: null },
        uLandNearFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
        uLandFarFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      side: THREE.FrontSide,
      // GLSL ES 3.00 so the shader can ask for a mip level by hand (textureLod) in both stages;
      // three's prefix keeps `varying`, `attribute` and `gl_FragColor` working as usual.
      glslVersion: THREE.GLSL3,
    });
    return m;
  }

  // --- the frame ------------------------------------------------------------------------------

  step(dt, camera, settings) {
    const w = this.weather;
    const d = w.derived;
    this.time += dt;
    // The spectrum is a few milliseconds of work, so it is rebuilt only when the weather has
    // really moved: an eighth of the scale, or a change of swell.
    if (Math.abs(w.sea - this.builtSea) > 0.045 || Math.abs(w.swell.height - this.builtSwell) > 0.25) {
      this.rebuildSpectrum();
    }

    // Foam drifts downwind at roughly 3% of the wind, the Stokes rate for a wind sea.
    const drift = d.u10 * 0.03 * dt;
    const chop = d.choppiness;
    const decay = Math.exp(-dt / 12);
    const birth = clamp01(0.25 + d.whitecap * 3.6);
    const threshold = lerp(0.55, 0.18, clamp01(d.sea * 1.3));
    for (const c of this.cascades) {
      this.foamDrift.set(
        (G.uWind.value.x * drift) / c.spec.size,
        (G.uWind.value.y * drift) / c.spec.size,
      );
      this.passes.step(c, this.time, chop, this.foamDrift, decay, birth, threshold);
    }
    this.renderer.setRenderTarget(null);

    this.place(camera, settings);
  }

  /** Snaps each clipmap level to its own grid under the camera and updates the shared uniforms. */
  place(camera, settings) {
    const cam = camera.position;
    const d = this.weather.derived;
    const fovRad = (camera.fov * Math.PI) / 180;
    const pixelAngle = fovRad / Math.max(settings?.pixelHeight ?? 1080, 1);
    for (const lvl of this.levels) {
      const u = lvl.material.uniforms;
      const snap = 2 * lvl.cell;
      u.uPatchCentre.value.set(
        Math.round(cam.x / snap) * snap,
        Math.round(cam.z / snap) * snap,
      );
      u.uPatchScale.value = lvl.half;
      u.uCamPos.value.copy(cam);
      u.uPixelAngle.value = pixelAngle;
      u.uFoam0.value = this.cascades[0].foamTexture;
      u.uFoam1.value = this.cascades[1].foamTexture;
      u.uFoam2.value = this.cascades[2].foamTexture;
      u.uWhitecap.value = d.whitecap;
      u.uSpray.value = d.spray;
      u.uTime.value = this.time % 3600;
      u.uWakeTex.value = this.wakeTexture ?? u.uWakeTex.value;
    }
  }

  /**
   * Reads one cascade's displacement map back off the GPU as floats. Half-float targets are not
   * reliably readable, so the map is copied into a float target first. Only ever called by hand
   * from the console: it drains the pipeline.
   */
  readDisplacement(index = 0) {
    const c = this.cascades[index];
    const n = this.n ?? FFT_N;
    this.readTarget ??= new THREE.WebGLRenderTarget(n, n, {
      type: THREE.FloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.copyMat ??= new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: `precision highp float;
uniform sampler2D uSrc;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch( uSrc, ivec2( gl_FragCoord.xy ), 0 ); }`,
      uniforms: { uSrc: { value: null } }, depthTest: false, depthWrite: false,
    });
    this.copyMat.uniforms.uSrc.value = c.displacement;
    const mesh = this.passes.mesh;
    const prevMat = mesh.material;
    mesh.material = this.copyMat;
    this.renderer.setRenderTarget(this.readTarget);
    this.renderer.render(this.passes.scene, this.passes.camera);
    mesh.material = prevMat;
    const out = new Float32Array(n * n * 4);
    this.renderer.readRenderTargetPixels(this.readTarget, 0, 0, n, n, out);
    this.renderer.setRenderTarget(null);
    return out;
  }

  /**
   * Checks that the surface the GPU draws is the surface the hull rides. Sums every component of
   * cascade 0 on the CPU at a handful of grid points and compares with what came back off the GPU.
   * Returns the worst disagreement in metres and the surface's RMS height for scale: a sign error
   * or a wrong normalisation shows up as a mismatch the size of the waves themselves.
   */
  verify(points = 24) {
    const data = this.readDisplacement(0);
    const size = CASCADES[0].size, n = FFT_N;
    const all = longWaveComponents(this.cascadeData0, size, n, 0.001, 1e9, 1);
    let worst = 0, sum = 0, count = 0, rms = 0;
    for (let i = 0; i < n * n; i++) rms += data[i * 4 + 1] ** 2;
    rms = Math.sqrt(rms / (n * n));
    for (let p = 0; p < points; p++) {
      const m = (p * 37) % n, q = (p * 61) % n;
      const x = (m * size) / n, z = (q * size) / n;
      let h = 0;
      for (const w of all) h += w.amp * Math.cos(w.kx * x + w.kz * z + w.dir * w.omega * this.time + w.phase);
      const gpu = data[(q * n + m) * 4 + 1];
      const e = Math.abs(gpu - h);
      worst = Math.max(worst, e);
      sum += e;
      count++;
    }
    return { worstError: worst, meanError: sum / count, rmsHeight: rms, components: all.length, time: this.time };
  }

  /** Hands the sea her wake: the trail texture and where she is in it. */
  useWake(wake) {
    for (const m of this.materials) {
      m.uniforms.uWakeTex.value = wake.texture;
      m.uniforms.uWakeFrame.value = wake.frame;
      m.uniforms.uWakeBoat.value = wake.boat;
      m.uniforms.uWakeDrive.value = wake.drive;
    }
  }

  /** Hands the sea the land's baked height fields, so it knows how deep it is everywhere. */
  useTerrain(terrain) {
    for (const m of this.materials) {
      m.uniforms.uLandNear.value = terrain.nearTarget.texture;
      m.uniforms.uLandFar.value = terrain.farTarget.texture;
      m.uniforms.uLandNearFrame.value = terrain.nearFrame;
      m.uniforms.uLandFarFrame.value = terrain.farFrame;
    }
  }

  /** The sea's state in one line, for the ?perf overlay. */
  describe() {
    const d = this.weather.derived;
    return `sea ${d.sea.toFixed(2)} · U10 ${d.u10.toFixed(1)} m/s · Hs ${this.hs.toFixed(2)} m · ${this.components.length} wave components`;
  }

  dispose() {
    for (const c of this.cascades) c.dispose();
    this.passes.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.scene.remove(this.group);
  }
}

/**
 * A grid of `n` x `n` cells over [-1, 1], as positions in the xz plane. With `hollow`, the central
 * quarter is left out, which makes the ring that surrounds the next finer level.
 */
export function gridGeometry(n, hollow) {
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3);
  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      const i = (z * (n + 1) + x) * 3;
      pos[i] = (x / n) * 2 - 1;
      pos[i + 1] = 0;
      pos[i + 2] = (z / n) * 2 - 1;
    }
  }
  const lo = n / 4, hi = (3 * n) / 4;
  const idx = [];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      if (hollow && x >= lo && x < hi && z >= lo && z < hi) continue;
      const a = z * (n + 1) + x;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  return g;
}
