// Trawler — The sky: the atmosphere's lookup tables, the sun and the moon on their real paths, the
// Hipparcos stars, the cloud layers, and the lights the rest of the scene is lit by.
//
// new Sky(scene, renderer, rng, opts) builds it; step(dt, clock) advances the clock and writes the
// shared uniforms (G.uSunDir, G.uSunColor, G.uSkyLight, ...) and the two three.js lights.
//
// The clock. One day is DAY_SECONDS of wall time (24 minutes by default: a minute an hour), and the
// scene is at 62 deg N on the Norwegian coast on a date that reseeds pick from late summer to
// autumn. Early September (day 250) is the default because it gives both a 34 deg noon sun and a
// midnight sun 22 deg below the horizon: a real day *and* a properly dark night, with the long low
// light either side that is the best thing this sky can do. Midsummer there never gets dark, which
// would quietly break "full day and night cycles".
//
// Where the sun and the moon are is not invented: `solarPosition` is the usual low-precision solar
// formula (mean longitude, equation of centre, obliquity) and `lunarPosition` is the
// Astronomical Almanac's low-precision lunar series, both reduced to right ascension and
// declination and then turned into the local horizon frame by the same matrix as the star
// catalogue. The moon therefore rises in the right place relative to the sun and shows the right
// phase, and the stars turn about a pole 62 deg up in the north.
//
// World axes: +x east, +z south (so north is -z), +y up, y = 0 at mean sea level.

import * as THREE from 'three';
import { G, LAYER, ATMOS_COMMON, ATMOS_BAKE, ATMOS_READ, NOISE_GLSL } from './shaders.js';
import { TAU, DEG, clamp, clamp01, smoothstep, v3 } from './util.js';

export const LATITUDE = 62.0; // deg N: the mid-Norwegian coast
export const DAY_SECONDS = 24 * 60; // wall seconds for one full day/night cycle
export const SKY_RADIUS = 9000; // m: where the sun, moon and star frame sit (inside the far plane)

// The sun's spectral irradiance at the top of the atmosphere, normalised to green = 1 and scaled so
// that a clear noon sun lands near 6 on three's physical light scale (as Hangar's sun did).
const SUN_IRRADIANCE = v3(1.474 / 1.8504, 1.0, 1.91198 / 1.8504).multiplyScalar(6.4);
// The moon is 1/400,000 of the sun, but the eye adapts: drawn at 1/2800, which is the ratio that
// makes a full moon read as a moonlit night rather than a black screen.
const MOON_IRRADIANCE = v3(0.92, 0.96, 1.08).multiplyScalar(6.4 / 25000);
const MS_ISO = 0.12; // isotropic stand-in for multiple scattering (tuned: blue hour and twilight)

const TRANS_SIZE = 64;
const SKY_LUT_W = 192, SKY_LUT_H = 108;

// =============================================================================================
// Positions of things in the sky
// =============================================================================================

/** Days since J2000.0 for a day-of-year and a fraction of the day (UT), in 2026. */
export function julianDays(dayOfYear, dayFraction) {
  // 2026-01-01 00:00 UT is JD 2461041.5, i.e. 9497.0 days after J2000.0.
  return 9497 + (dayOfYear - 1) + dayFraction;
}

/** Right ascension and declination of the sun (radians), low precision (0.01 deg is plenty). */
export function solarPosition(n) {
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + 1.915 * DEG * Math.sin(g) + 0.02 * DEG * Math.sin(2 * g);
  const eps = (23.439 - 4e-7 * n) * DEG;
  return {
    ra: Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)),
    dec: Math.asin(Math.sin(eps) * Math.sin(lambda)),
    lambda,
  };
}

/**
 * Ecliptic longitude, latitude and distance of the moon (radians, earth radii): the Astronomical
 * Almanac's low-precision series (about 0.3 deg, well inside what a 0.5 deg disc needs).
 */
export function lunarPosition(n) {
  const T = n / 36525;
  const d = (x) => x * DEG;
  const lambda = d(218.32 + 481267.881 * T
    + 6.29 * Math.sin(d(135.0 + 477198.87 * T))
    - 1.27 * Math.sin(d(259.3 - 413335.36 * T))
    + 0.66 * Math.sin(d(235.7 + 890534.22 * T))
    + 0.21 * Math.sin(d(269.9 + 954397.74 * T))
    - 0.19 * Math.sin(d(357.5 + 35999.05 * T))
    - 0.11 * Math.sin(d(186.5 + 966404.03 * T)));
  const beta = d(5.13 * Math.sin(d(93.3 + 483202.02 * T))
    + 0.28 * Math.sin(d(228.2 + 960400.89 * T))
    - 0.28 * Math.sin(d(318.3 + 6003.15 * T))
    - 0.17 * Math.sin(d(217.6 - 407332.21 * T)));
  const eps = (23.439 - 4e-7 * n) * DEG;
  const cb = Math.cos(beta), sb = Math.sin(beta), cl = Math.cos(lambda), sl = Math.sin(lambda);
  const ra = Math.atan2(sl * cb * Math.cos(eps) - sb * Math.sin(eps), cl * cb);
  const dec = Math.asin(sb * Math.cos(eps) + cb * Math.sin(eps) * sl);
  return { ra, dec, lambda, beta };
}

/**
 * The matrix that takes an ICRS equatorial unit vector to this scene's world frame (x east, y up,
 * z south) for a local sidereal time `lst` and latitude `lat` (radians). The stars, the sun and the
 * moon all go through it, which is why they agree.
 */
export function equatorialToWorld(lst, lat) {
  const c = Math.cos(lat), s = Math.sin(lat);
  // Rz(-lst) puts the meridian on +x, then the rows pick out east, up and south.
  const rz = new THREE.Matrix4();
  rz.set(
    Math.cos(lst), Math.sin(lst), 0, 0,
    -Math.sin(lst), Math.cos(lst), 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
  const horizon = new THREE.Matrix4();
  horizon.set(
    0, 1, 0, 0,
    c, 0, s, 0,
    s, 0, -c, 0,
    0, 0, 0, 1,
  );
  return horizon.multiply(rz);
}

/** An (ra, dec) pair as a unit vector in this scene's world frame. */
export function skyDirection(ra, dec, mat) {
  const u = v3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
  return u.applyMatrix4(mat).normalize();
}

// =============================================================================================
// The atmosphere on the CPU: the same integral as the shader, for the light colours
// =============================================================================================

const R_GROUND = 6360000, R_TOP = 6420000;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
const BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const BETA_M_E = 4.44e-6;
const ZERO3 = [0, 0, 0];

function hitSphere(oy, dy, dxz, r) {
  // Earth-centred: o = (0, oy, 0) with |o| = oy; d = (dxz, dy, 0), unit.
  const b = oy * dy;
  const c = oy * oy - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  const t0 = -b - sd, t1 = -b + sd;
  return t0 >= 0 ? t0 : t1;
}

/**
 * Transmittance from altitude `h` along a direction whose vertical component is `mu`, as [r, g, b].
 * Zero when the ray runs into the earth, which is what puts the sun out at sunset and draws the
 * earth's shadow up through a twilight sky. The same integral the shader's table bakes.
 */
export function cpuTransmittanceAt(h, mu, steps = 16) {
  const oy = R_GROUND + Math.max(h, 2);
  const dy = mu, dxz = Math.sqrt(Math.max(0, 1 - mu * mu));
  if (hitSphere(oy, dy, dxz, R_GROUND) > 0) return [0, 0, 0];
  const top = hitSphere(oy, dy, dxz, R_TOP);
  if (!(top > 0)) return [1, 1, 1];
  let tau = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const x0 = i / steps, x1 = (i + 1) / steps;
    const s0 = top * x0 * x0, s1 = top * x1 * x1;
    const ds = s1 - s0, sm = 0.5 * (s0 + s1);
    const px = dxz * sm, py = oy + dy * sm;
    const h = Math.hypot(px, py) - R_GROUND;
    const dr = Math.exp(-h / 8000), dm = Math.exp(-h / 1200);
    const dz = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    for (let c = 0; c < 3; c++) tau[c] += (BETA_R[c] * dr + BETA_M_E * dm + BETA_O[c] * dz) * ds;
  }
  return tau.map((t) => Math.exp(-t));
}

/** Transmittance from sea level: the sun's or the moon's colour at the boat. */
export const cpuTransmittance = (mu, steps = 24) => cpuTransmittanceAt(2, mu, steps);

// =============================================================================================
// Baking the tables
// =============================================================================================

const BAKE_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const TRANS_FRAG = /* glsl */ `
precision highp float;
${ATMOS_COMMON}
uniform vec2 uSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float mu = uv.x * 2.0 - 1.0;
  float h = uv.y * uv.y * LUT_MAX_ALT;
  vec3 o = vec3( 0.0, R_GROUND + h, 0.0 );
  vec3 d = vec3( sqrt( max( 0.0, 1.0 - mu * mu ) ), mu, 0.0 );
  // A ray that runs into the earth carries no sunlight: that is the earth's shadow at twilight.
  if ( atmosHit( o, d, R_GROUND ) > 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
  float top = atmosHit( o, d, R_TOP );
  vec3 tau = vec3( 0.0 );
  const int N = 40;
  for ( int i = 0; i < N; i++ ) {
    float x0 = float( i ) / float( N ), x1 = float( i + 1 ) / float( N );
    float s0 = top * x0 * x0, s1 = top * x1 * x1;
    float ds = s1 - s0, sm = 0.5 * ( s0 + s1 );
    float hh = length( o + d * sm ) - R_GROUND;
    vec3 dens = atmosDensity( hh );
    tau += ( BETA_R * dens.x + vec3( BETA_M_E ) * dens.y + BETA_O * dens.z ) * ds;
  }
  gl_FragColor = vec4( exp( -tau ), 1.0 );
}
`;

const SKY_LUT_FRAG = /* glsl */ `
precision highp float;
${ATMOS_BAKE}
uniform vec2 uSize;
uniform float uSunY; // the sun's vertical component; in this table the sun is at azimuth 0
uniform vec3 uSunIrradiance;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float az = uv.x * 3.14159265;
  // The inverse of skyUv's v: rows below the horizon repeat the grazing ray.
  float t = uv.y * uv.y * 1.1 - 0.1;
  float y = clamp( t, 0.0, 1.0 );
  float horiz = sqrt( max( 0.0, 1.0 - y * y ) );
  vec3 dir = vec3( horiz * cos( az ), y, horiz * sin( az ) );
  vec3 sun = vec3( sqrt( max( 0.0, 1.0 - uSunY * uSunY ) ), uSunY, 0.0 );
  float cosT = dot( dir, sun );
  float pR = phaseRayleigh( cosT ), pM = phaseMie( cosT );

  vec3 o = vec3( 0.0, R_GROUND + 2.0, 0.0 );
  float top = atmosHit( o, dir, R_TOP );
  vec3 L = vec3( 0.0 );
  vec3 T = vec3( 1.0 );
  const int N = 32;
  for ( int i = 0; i < N; i++ ) {
    float x0 = float( i ) / float( N ), x1 = float( i + 1 ) / float( N );
    float s0 = top * x0 * x0, s1 = top * x1 * x1;
    float ds = s1 - s0, sm = 0.5 * ( s0 + s1 );
    vec3 p = o + dir * sm;
    float h = length( p ) - R_GROUND;
    vec3 dens = atmosDensity( h );
    vec3 ext = BETA_R * dens.x + vec3( BETA_M_E ) * dens.y + BETA_O * dens.z;
    vec3 up = normalize( p );
    // Sunlight reaching this sample: blocked by the earth, else the baked outward transmittance.
    vec3 Tsun = atmosHit( p, sun, R_GROUND ) > 0.0 ? vec3( 0.0 ) : lookupTrans( h, dot( up, sun ) );
    vec3 sR = BETA_R * dens.x, sM = vec3( BETA_M_S ) * dens.y;
    L += T * Tsun * ( sR * pR + sM * pM + ( sR + sM ) * ${MS_ISO} ) * ds;
    T *= exp( -ext * ds );
  }
  gl_FragColor = vec4( L * uSunIrradiance, 1.0 );
}
`;

/** The two tables and the passes that fill them. */
class Atmosphere {
  constructor(renderer) {
    this.renderer = renderer;
    const type = THREE.HalfFloatType;
    const make = (w, h) => new THREE.WebGLRenderTarget(w, h, {
      type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.trans = make(TRANS_SIZE, TRANS_SIZE);
    this.sky = make(SKY_LUT_W, SKY_LUT_H);
    this.quad = new THREE.PlaneGeometry(2, 2);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.transMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(TRANS_SIZE, TRANS_SIZE) } },
      vertexShader: BAKE_VERT, fragmentShader: TRANS_FRAG, depthTest: false, depthWrite: false,
    });
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(SKY_LUT_W, SKY_LUT_H) },
        uSunY: { value: 0.4 },
        uSunIrradiance: { value: SUN_IRRADIANCE.clone() },
        uTransLut: { value: this.trans.texture },
      },
      vertexShader: BAKE_VERT, fragmentShader: SKY_LUT_FRAG, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.quad, this.transMat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    G.uTransLut.value = this.trans.texture;
    G.uSkyLut.value = this.sky.texture;
    this.bakeTransmittance();
  }

  run(material, target) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.mesh.material = material;
    r.setRenderTarget(target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
  }

  bakeTransmittance() { this.run(this.transMat, this.trans); }

  /** Re-bakes the sky table for the sun's current elevation. Cheap: 32 steps and one table read. */
  bakeSky(sunY, irradiance) {
    this.skyMat.uniforms.uSunY.value = sunY;
    this.skyMat.uniforms.uSunIrradiance.value.copy(irradiance);
    this.run(this.skyMat, this.sky);
  }

  dispose() {
    this.trans.dispose();
    this.sky.dispose();
    this.quad.dispose();
    this.transMat.dispose();
    this.skyMat.dispose();
  }
}

// =============================================================================================
// Clouds. Both layers sit on spherical shells, so they come down to the horizon at the right
// distance (a 700 m base meets the sea about 95 km away) rather than running off to infinity on a
// flat plane, and the slab is genuinely marched through: six steps between the base shell and the
// top shell, each one lit by three taps toward the sun. That is what gives a cumulus a dark base,
// a bright crown, a lit rim where the sun is behind it, and an edge you can see into.
//
// The horizontal field is coverage; the vertical profile turns it into a body: a flat base, a
// swelling middle, and a top that rises higher where the coverage is deeper, because that is what
// a convective cloud does. Detail octaves fade out with distance so nothing shimmers at the rim,
// and the marched length is capped so a grazing ray near the horizon does not take six samples
// 18 km apart (its density is scaled instead).
// =============================================================================================

export const CLOUD_GLSL = /* glsl */ `
uniform vec4 uCloud; // cover 0..1, base m, thickness m, darkness 0..1
uniform vec2 uWind;
uniform float uCloudDrift; // metres the cloud field has been carried downwind
uniform vec2 uWorldOrigin;

/** Billowed noise in 0..1: |n| creases give the cauliflower lumps a smooth fbm never has. */
float billow( vec2 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    v += a * abs( vnoise( p ) * 2.0 - 1.0 );
    p = p * 2.17 + 9.3;
    a *= 0.5;
  }
  return v * 1.142857; // three octaves sum to 0.875 at most
}

/** fbm2d normalised to 0..1, so thresholds below mean what they say. */
float fbmN( vec2 p, int octaves ) {
  float norm = octaves == 2 ? 1.333333 : ( octaves == 3 ? 1.142857 : 1.066667 );
  return fbm2d( p, octaves ) * norm;
}

/** The horizontal coverage field, 0..1. 'detail' keeps the fine octaves; 0 at the far horizon. */
float cloudCover( vec2 p, float detail ) {
  vec2 q = ( p + uWorldOrigin - uWind * uCloudDrift ) * 0.00035;
  // One big domain warp curls the cells into fronts instead of a grid of blobs.
  vec2 w = vec2( fbmN( q * 0.4 + 3.1, 2 ), fbmN( q * 0.4 + 8.7, 2 ) ) - 0.5;
  q += w * 1.1;
  float n = fbmN( q, 3 ) * 0.7 + ( 1.0 - billow( q * 2.1 ) ) * 0.3;
  if ( detail > 0.01 ) n = mix( n, n * 0.74 + ( 1.0 - billow( q * 7.4 + 21.0 ) ) * 0.26, detail );
  // The field sits around 0.5, so the threshold runs from a near-clear sky to an overcast one.
  float thr = 0.52 + ( 0.5 - uCloud.x ) * 0.62;
  return smoothstep( thr, thr + 0.17, n );
}

/**
 * Density inside the slab at a horizontal point and a height fraction 'h' (0 at the base, 1 at the
 * top). The profile is the cloud's body; the erosion at the top is what makes a ragged crown.
 */
float cloudDensity( vec2 p, float h, float cov, float detail ) {
  if ( cov < 0.002 ) return 0.0;
  // Deeper coverage builds higher: a fair-weather puff fills a third of the slab, a shower cloud
  // most of it.
  float top = mix( 0.30, 1.0, cov );
  float body = smoothstep( 0.0, 0.10, h ) * ( 1.0 - smoothstep( top * 0.55, top, h ) );
  float d = cov * body;
  if ( detail > 0.01 ) {
    // Erode the edges and the crown, more the higher up and the thinner the cloud.
    vec2 q = ( p + uWorldOrigin - uWind * uCloudDrift ) * 0.0021;
    float e = billow( q + vec2( 0.0, h * 3.0 ) ) * detail * ( 0.25 + 0.5 * h );
    d -= e * ( 1.0 - cov ) * 1.1;
  }
  return max( d, 0.0 );
}

/** Where a ray from sea level meets a shell 'alt' metres up, and how far that is. */
float cloudShellHit( vec3 ro, vec3 rd, float alt ) {
  float oy = R_GROUND + max( ro.y, 0.0 );
  return atmosHit( vec3( 0.0, oy, 0.0 ), rd, R_GROUND + alt );
}

/** Henyey-Greenstein, the phase function clouds are usually given. */
float hg( float c, float g ) {
  float g2 = g * g;
  return 0.0795774715 * ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 );
}

/**
 * The cumulus layer along a ray: (rgb, alpha), premultiplied by nothing (mix with it).
 * 'quality' 1 is the sky's own pass; the water's reflection pays about a third of it.
 */
vec4 cumulus( vec3 ro, vec3 rd, vec3 sunDir, vec3 sunCol, float quality ) {
  if ( rd.y < 0.0015 || uCloud.x < 0.02 ) return vec4( 0.0 );
  float base = uCloud.y, thick = uCloud.z;
  float dB = cloudShellHit( ro, rd, base );
  float dT = cloudShellHit( ro, rd, base + thick );
  if ( dB <= 0.0 || dT <= dB ) return vec4( 0.0 );
  // A grazing ray crosses tens of kilometres of slab; march a capped length and carry the rest as
  // extra density, so the horizon stays thick without paying for samples 18 km apart.
  float full = dT - dB;
  float span = min( full, 26000.0 );
  float pathScale = min( full / span, 5.0 );

  int steps = quality > 0.6 ? 6 : 3;
  float stepLen = span / float( steps ) * pathScale;
  float detail0 = quality * ( 1.0 - smoothstep( 5000.0, 40000.0, dB ) );
  // Extinction per metre at density 1: a 900 m cloud at full density is all but opaque.
  float sigma0 = 0.0055 * mix( 1.0, 2.0, uCloud.w );
  float cosS = dot( rd, sunDir );
  // Two lobes: the strong forward one that makes a silver lining, and a near-isotropic one.
  // Henyey-Greenstein's forward peak is unbounded as the scattering angle goes to zero, and a
  // cloud lit from directly behind would come out at forty times the sun. Real multiple scattering
  // smears that peak out, so it is capped; uncapped it blows a handful of pixels to white wherever
  // a wave happens to reflect a ray straight at the sun through a cloud.
  float phase = min( mix( hg( cosS, 0.74 ), hg( cosS, -0.15 ), 0.42 ), 4.5 );
  vec3 ambientUp = skyRadiance( vec3( 0.0, 1.0, 0.0 ) ) * mix( 1.4, 0.4, uCloud.w );
  vec3 ambientDown = skyRadiance( normalize( vec3( rd.x, 0.06, rd.z ) ) ) * 0.35;

  float transmit = 1.0;
  vec3 scattered = vec3( 0.0 );
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= steps ) break;
    float f = ( float( i ) + 0.5 ) / float( steps );
    float t = dB + span * f;
    vec3 p = ro + rd * t;
    float alt = length( vec3( 0.0, R_GROUND + max( ro.y, 0.0 ), 0.0 ) + rd * t ) - R_GROUND;
    float h = clamp( ( alt - base ) / thick, 0.0, 1.0 );
    float detail = detail0 * ( 1.0 - smoothstep( 5000.0, 40000.0, t ) );
    float cov = cloudCover( p.xz, detail );
    float d = cloudDensity( p.xz, h, cov, detail );
    if ( d < 0.002 ) continue;
    float sigma = d * sigma0;

    // Light: three taps toward the sun through the slab, at a step that keeps them inside it.
    float lightStep = thick * 0.33 / max( abs( sunDir.y ), 0.2 );
    float tau = 0.0;
    for ( int j = 1; j <= 3; j++ ) {
      if ( quality < 0.6 && j > 1 ) break;
      vec3 sp = p + sunDir * ( lightStep * float( j ) );
      float sAlt = alt + sunDir.y * lightStep * float( j );
      float sh = clamp( ( sAlt - base ) / thick, 0.0, 1.0 );
      float sCov = cloudCover( sp.xz, detail * 0.5 );
      tau += cloudDensity( sp.xz, sh, sCov, 0.0 ) * sigma0 * lightStep;
    }
    if ( quality < 0.6 ) tau *= 3.0;
    float sunT = exp( -tau );
    // Beer-powder: the dark core of a cumulus, and the bright scattering just inside its edge.
    float powder = 1.0 - exp( -d * 6.0 );
    vec3 L = sunCol * sunT * phase * 3.1 * mix( 0.35, 1.0, powder )
           + mix( ambientDown, ambientUp, h ) * mix( 0.35, 1.0, 1.0 - d );
    float a = 1.0 - exp( -sigma * stepLen );
    scattered += transmit * a * L;
    transmit *= 1.0 - a;
    if ( transmit < 0.01 ) break;
  }
  float alpha = 1.0 - transmit;
  if ( alpha < 0.004 ) return vec4( 0.0 );
  // Thirty kilometres of air between us and a cloud is as much air as the cloud is cloud: without
  // this the horizon band stays a crisp white frieze instead of fading into the sky behind it.
  return vec4( applyAerial( scattered / alpha, rd, dB ), alpha );
}

/** A thin cirrus veil much higher up: cheap, and it is what makes a fine day look fine. */
vec4 cirrus( vec3 ro, vec3 rd, vec3 sunDir, vec3 sunCol ) {
  if ( rd.y < 0.004 ) return vec4( 0.0 );
  float d = cloudShellHit( ro, rd, 8200.0 );
  if ( d <= 0.0 ) return vec4( 0.0 );
  vec2 p = ( ro.xz + rd.xz * d + uWorldOrigin - uWind * uCloudDrift * 2.2 ) * 0.00009;
  // Stretched along the wind: cirrus comes in streaks, not puffs.
  vec2 q = vec2( p.x * 0.3, p.y * 1.7 );
  float n = fbmN( q + vec2( fbmN( q * 2.1, 2 ), 0.0 ) * 0.7, 3 );
  float cov = smoothstep( 0.50, 0.86, n ) * ( 0.42 - 0.34 * uCloud.w );
  if ( cov < 0.004 ) return vec4( 0.0 );
  float cosS = dot( rd, sunDir );
  // Ice crystals forward-scatter hard, which is why cirrus near the sun glows.
  vec3 color = sunCol * ( 0.42 + 2.2 * min( hg( cosS, 0.62 ), 3.0 ) ) + skyRadiance( vec3( 0.0, 1.0, 0.0 ) ) * 0.7;
  return vec4( applyAerial( color, rd, d ), cov * 0.6 );
}
`;

// =============================================================================================
// The sky pass: one screen-filling triangle pair drawn last, with the depth test on, so it only
// costs the pixels nothing else covered. The view ray is rebuilt from the clip position.
// =============================================================================================

const SKY_VERT = /* glsl */ `
varying vec3 vRay;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
void main() {
  vec4 v = uInvProj * vec4( position.xy, 1.0, 1.0 );
  vRay = uCamRot * ( v.xyz / v.w );
  gl_Position = vec4( position.xy, 1.0, 1.0 ); // the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
${ATMOS_READ}
${NOISE_GLSL}
${CLOUD_GLSL}
uniform vec3 uCamPos;
uniform float uSunAngularR;
uniform float uMoonGlow;
varying vec3 vRay;

void main() {
  vec3 rd = normalize( vRay );
  vec3 sky = skyRadiance( rd );

  // The sun's disc, with a soft limb and the aureole the Mie lobe gives it near the horizon.
  float cs = dot( rd, uSunDir );
  float disc = smoothstep( cos( uSunAngularR * 2.2 ), cos( uSunAngularR * 0.85 ), cs );
  sky += uSunColor * disc * 42.0;
  // A little glare round it, which is what sells a low sun over water.
  sky += uSunColor * pow( max( cs, 0.0 ), 1400.0 ) * 0.7 + uSunColor * pow( max( cs, 0.0 ), 48.0 ) * 0.055;

  // The moon's own glow (the disc itself is a textured sphere, drawn separately).
  float cm = dot( rd, uMoonDir );
  sky += uMoonColor * ( pow( max( cm, 0.0 ), 700.0 ) * 6.0 + pow( max( cm, 0.0 ), 22.0 ) * 0.5 ) * uMoonGlow;

  // Cloud over the top of it, then the air between us and the cloud.
  vec4 ci = cirrus( uCamPos, rd, uSunDir, uSunColor );
  sky = mix( sky, ci.rgb, ci.a );
  vec4 cu = cumulus( uCamPos, rd, uSunDir, uSunColor, 1.0 );
  sky = mix( sky, cu.rgb, cu.a );

  // Haze: the near air in front of the cloud and the sky, thickest at the horizon.
  float horizon = 1.0 - smoothstep( 0.0, 0.16, rd.y );
  vec3 hazeCol = skyRadiance( normalize( vec3( rd.x, 0.02, rd.z ) ) );
  sky = mix( sky, hazeCol, horizon * horizon * clamp( ( uHaze - 1.0 ) * 0.45, 0.0, 0.85 ) );

  gl_FragColor = vec4( sky, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Stars: the Hipparcos catalogue, each at its measured place, V magnitude and B-V colour. The
// brightness step is 1.5x a magnitude rather than the true 2.512x, so the naked-eye stars stand
// out while the faint ones still dust the sky (as Hangar's do).
const STAR_VERT = /* glsl */ `
attribute float mag;
attribute vec3 starColor;
uniform float uStarScale;
uniform float uStarGain;
varying vec3 vStar;
void main() {
  vec3 w = mat3( modelMatrix ) * position;
  // Below the horizon there is sea, not sky.
  float above = smoothstep( -0.02, 0.03, w.y );
  float b = uStarGain * exp2( -0.585 * mag ) * above;
  vStar = starColor * min( b, 2.0 );
  float big = clamp( ( 2.0 - mag ) / 3.5, 0.0, 1.0 );
  gl_PointSize = uStarScale * ( 1.5 + 2.4 * big );
  vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * w, 1.0 );
  p.z = p.w * 0.999995;
  gl_Position = b < 0.0015 ? vec4( 2.0, 2.0, 2.0, 1.0 ) : p;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vStar;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = exp( -3.2 * dot( q, q ) );
  gl_FragColor = vec4( vStar * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** stars.bin: 10 bytes a star, int16 ICRS x/y/z, uint8 V magnitude, uint8 r/g/b. */
export function decodeStars(buffer) {
  const count = Math.floor(buffer.byteLength / 10);
  const dv = new DataView(buffer);
  const dir = new Float32Array(count * 3), mag = new Float32Array(count), color = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * 10;
    const x = dv.getInt16(o, true), y = dv.getInt16(o + 2, true), z = dv.getInt16(o + 4, true);
    const l = Math.hypot(x, y, z) || 1;
    dir[i * 3] = x / l; dir[i * 3 + 1] = y / l; dir[i * 3 + 2] = z / l;
    mag[i] = dv.getUint8(o + 6) / 16 - 2;
    for (let c = 0; c < 3; c++) color[i * 3 + c] = dv.getUint8(o + 7 + c) / 255;
  }
  return { count, dir, mag, color };
}

const VERSION = new URL(import.meta.url).searchParams.get('v');
let starPromise = null;

/** Fetches data/stars.bin once for the page. Never rejects: without it there are no stars. */
export function loadStars() {
  starPromise ??= fetch(VERSION ? `./data/stars.bin?v=${VERSION}` : './data/stars.bin')
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(decodeStars)
    .catch((err) => { console.warn('Trawler: data/stars.bin unavailable, the night sky will be empty', err); return null; });
  return starPromise;
}

/**
 * Points a directional light along `dir` and gives it an irradiance vector: the colour carries the
 * chromaticity and the intensity the magnitude, so colour x intensity is the vector again.
 */
function setLight(light, dir, irradiance, cutoff) {
  const m = Math.max(irradiance.x, irradiance.y, irradiance.z);
  // The sun's own position is set by the scene each frame so its shadow box can follow the boat;
  // here only the colour and the strength are wanted.
  if (!light.userData.placedByScene) light.position.copy(dir).multiplyScalar(600);
  light.intensity = m;
  light.visible = m > cutoff;
  if (m > 1e-8) light.color.setRGB(irradiance.x / m, irradiance.y / m, irradiance.z / m);
}

/** The same for the hemisphere light, with a gain because three's hemisphere light is dim per unit. */
function setHemi(light, irradiance, gain) {
  const m = Math.max(irradiance.x, irradiance.y, irradiance.z);
  light.intensity = Math.max(m * gain, 0.0015);
  if (m > 1e-8) light.color.setRGB(irradiance.x / m, irradiance.y / m, irradiance.z / m);
  // Looking down you see the sea, which is darker and bluer than the sky above it.
  light.groundColor.setRGB(0.26, 0.40, 0.52);
}

// =============================================================================================
// Sky
// =============================================================================================

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./util.js').Rng} rng
   * @param {{ dayOfYear?: number, stars?: object|null, assetBase?: string }} opts
   */
  constructor(scene, renderer, rng, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.atmos = new Atmosphere(renderer);
    // Reseeds pick a date from late summer to mid autumn: early dates give a bright, short night and
    // late ones a long dark one, and both keep the long low light this latitude is worth having.
    this.dayOfYear = opts.dayOfYear ?? rng.int(225, 285);
    this.dayTime = 0; // 0..1 of the day; set by setClock
    this.cycling = true;
    this.buildDome();
    this.buildMoon(opts.assetBase);
    if (opts.stars) this.buildStars(opts.stars);

    // The two lights. The sun's shadow map is fitted to the boat in scene.js.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 0);
    this.sunLight.userData.placedByScene = true;
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.04;
    // The shadow only ever has to cover the boat: she is the only thing in this scene that casts
    // one anybody can see. A 34 m box round her at 2048 is 1.7 cm a texel, which is enough for a
    // stay's shadow across the deck.
    const cam = this.sunLight.shadow.camera;
    cam.left = -19; cam.right = 19; cam.top = 19; cam.bottom = -19;
    cam.near = 1; cam.far = 220;
    cam.updateProjectionMatrix();
    this.moonLight = new THREE.DirectionalLight(0xdbe6ff, 0);
    this.ambient = new THREE.HemisphereLight(0x6f8fbf, 0x16222a, 0);
    // A little flat fill on top of the hemisphere. Inside the wheelhouse there is no sun and no
    // sky above you, only what comes in through the glass and bounces around a painted room; with
    // the hemisphere light alone the deckhead and the window brow go to black, which is not what
    // a real wheelhouse looks like even against a bright sea.
    this.fill = new THREE.AmbientLight(0xffffff, 0);
    for (const l of [this.sunLight, this.moonLight, this.ambient, this.fill]) {
      l.layers.enableAll();
      scene.add(l);
    }
    scene.add(this.sunLight.target);

    this.cloudSeed = rng.range(0, 1000);
    this.cloud = new THREE.Vector4(0.30, 700, 900, 0.22);
    this.setCloud(this.cloud.x, this.cloud.y, this.cloud.z, this.cloud.w);
    this.setClock(opts.dayTime ?? 0.30);
  }

  // --- building ---------------------------------------------------------------------------------

  buildDome() {
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uSkyLut: G.uSkyLut, uTransLut: G.uTransLut,
        uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uSunColor: G.uSunColor, uMoonColor: G.uMoonColor,
        uHaze: G.uHaze, uHazeFar: G.uHazeFar,
        uCloud: G.uCloud, uWind: G.uWind, uCloudDrift: G.uCloudDrift, uWorldOrigin: G.uWorldOrigin,
        uCamPos: { value: v3() },
        uInvProj: { value: new THREE.Matrix4() },
        uCamRot: { value: new THREE.Matrix3() },
        uSunAngularR: { value: 0.00465 },
        uMoonGlow: { value: 1 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this.dome = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 900; // after the opaque world, before the transparent spray
    this.dome.layers.set(LAYER.DEFAULT);
    this.dome.layers.enable(LAYER.WORLD);
    this.dome.layers.enable(LAYER.SKYONLY);
    this.scene.add(this.dome);
  }

  buildStars(cat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(cat.dir, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(cat.mag, 1));
    g.setAttribute('starColor', new THREE.BufferAttribute(cat.color, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uStarScale: { value: 1.6 }, uStarGain: { value: 1 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 901;
    this.stars.matrixAutoUpdate = false;
    this.stars.layers.set(LAYER.DEFAULT);
    this.stars.layers.enable(LAYER.WORLD);
    this.stars.layers.enable(LAYER.SKYONLY);
    this.scene.add(this.stars);
  }

  buildMoon(assetBase) {
    const base = assetBase ?? new URL('../assets/', import.meta.url).href;
    const loader = new THREE.TextureLoader();
    this.moonColorMap = loader.load(base + 'lroc_color_2k.jpg');
    this.moonColorMap.colorSpace = THREE.SRGBColorSpace;
    this.moonColorMap.anisotropy = 8;
    this.moonBumpMap = loader.load(base + 'ldem_3_8bit.jpg');
    const distance = SKY_RADIUS * 0.9;
    const radius = distance * Math.tan(0.259 * DEG); // the moon is about 0.518 deg across
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.moonColorMap }, uBump: { value: this.moonBumpMap },
        uMoonSun: { value: v3(1, 0, 0) }, uGain: { value: 1 },
      },
      depthWrite: false, depthTest: true, transparent: true, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vN; varying vec3 vRel;
        void main() {
          vUv = uv;
          vN = normalize( mat3( modelMatrix ) * normal );
          vec4 wp = modelMatrix * vec4( position, 1.0 );
          vRel = wp.xyz;
          vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * wp.xyz, 1.0 );
          p.z = p.w * 0.99999;
          gl_Position = p;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap, uBump; uniform vec3 uMoonSun; uniform float uGain;
        varying vec2 vUv; varying vec3 vN; varying vec3 vRel;
        void main() {
          vec3 albedo = texture2D( uMap, vUv ).rgb;
          float h = texture2D( uBump, vUv ).r;
          vec3 sx = dFdx( vRel ), sy = dFdy( vRel ), n = normalize( vN );
          vec3 r1 = cross( sy, n ), r2 = cross( n, sx );
          float det = dot( sx, r1 );
          vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 ) * 1.6;
          n = normalize( abs( det ) * n - grad );
          // The lunar surface backscatters: a full moon is nearly flat-lit, not a shaded ball.
          float nl = max( dot( n, uMoonSun ), 0.0 );
          float term = smoothstep( -0.02, 0.10, dot( normalize( vN ), uMoonSun ) );
          float lit = term * mix( nl, pow( nl, 0.45 ), 0.75 );
          gl_FragColor = vec4( albedo * lit * uGain * vec3( 1.0, 0.985, 0.95 ), 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(radius, 72, 48), this.moonMat);
    this.moon.frustumCulled = false;
    this.moon.renderOrder = 902;
    this.moon.layers.set(LAYER.DEFAULT);
    this.moon.layers.enable(LAYER.WORLD);
    this.moon.layers.enable(LAYER.SKYONLY);
    this.moonDistance = distance;
    this.scene.add(this.moon);
  }

  // --- the clock ---------------------------------------------------------------------------------

  /** Puts the clock at `t` in [0, 1) of the day and recomputes everything that follows from it. */
  setClock(t) {
    this.dayTime = t - Math.floor(t);
    const n = julianDays(this.dayOfYear, this.dayTime);
    const lat = LATITUDE * DEG;
    const sun = solarPosition(n);
    // Local sidereal time, defined so that dayTime 0.5 is local solar noon (the sun's hour angle
    // zero). Because the sun's right ascension creeps about a degree a day, the stars drift four
    // minutes a day against the clock on their own, which is exactly what they do.
    const lst = sun.ra + (this.dayTime - 0.5) * TAU;
    const mat = equatorialToWorld(lst, lat);
    this.skyMatrix = mat;

    const moon = lunarPosition(n);
    this.sunDir = skyDirection(sun.ra, sun.dec, mat);
    this.moonDir = skyDirection(moon.ra, moon.dec, mat);
    // Phase: the moon's elongation from the sun along the ecliptic decides which limb is lit.
    this.moonElongation = Math.atan2(Math.sin(moon.lambda - sun.lambda), Math.cos(moon.lambda - sun.lambda));

    G.uSunDir.value.copy(this.sunDir);
    G.uMoonDir.value.copy(this.moonDir);
    G.uDayTime.value = this.dayTime;

    if (this.stars) this.stars.matrix.copy(mat);
    this.applyLights();
  }

  /** The sun and moon colours, the sky's ambient, and the three.js lights, from the two directions. */
  applyLights() {
    const sy = this.sunDir.y, my = this.moonDir.y;
    // Direct sunlight: the real transmittance, faded out through the last degree at the horizon
    // (refraction and the disc's own size make the last of it soft rather than a step).
    const st = cpuTransmittance(Math.max(sy, 0));
    const sunFade = smoothstep(-0.012, 0.025, sy);
    const sun = v3(st[0] * SUN_IRRADIANCE.x, st[1] * SUN_IRRADIANCE.y, st[2] * SUN_IRRADIANCE.z).multiplyScalar(sunFade);
    const mt = cpuTransmittance(Math.max(my, 0));
    const moonFade = smoothstep(-0.012, 0.03, my);
    // The moon's own brightness by phase: a thin crescent gives almost nothing.
    const phase = 0.5 * (1 + Math.cos(this.moonElongation));
    const lit = Math.pow(phase, 1.7) * 0.92 + 0.02;
    const moon = v3(mt[0] * MOON_IRRADIANCE.x, mt[1] * MOON_IRRADIANCE.y, mt[2] * MOON_IRRADIANCE.z).multiplyScalar(moonFade * lit);

    G.uSunColor.value.copy(sun);
    G.uMoonColor.value.copy(moon);
    this.atmos.bakeSky(sy, SUN_IRRADIANCE);

    // Sky light: what the whole hemisphere puts on an upward face. Integrated from the same model
    // over a handful of directions, which is cheap and keeps the ambient honest at twilight.
    const skyIrr = this.skyIrradiance(sy, moon);
    const night = smoothstep(0.02, -0.09, sy); // 0 by day, 1 once the sun is 5 deg down
    G.uNight.value = night;
    G.uSkyLight.value.copy(skyIrr);
    // The sea bounces a little light back up under the bulwarks and into the house.
    G.uSeaBounce.value.set(skyIrr.x * 0.16 + sun.x * 0.02, skyIrr.y * 0.19 + sun.y * 0.02, skyIrr.z * 0.22 + sun.z * 0.02);

    const sunStrong = sun.length() >= moon.length();
    G.uKeyDir.value.copy(sunStrong ? this.sunDir : this.moonDir);
    G.uKeyColor.value.copy(sunStrong ? sun : moon);

    setLight(this.sunLight, this.sunDir, sun, 0.002);
    setLight(this.moonLight, this.moonDir, moon, 0.0004);
    // Three r155+ lights are physical: a hemisphere light of intensity 1 gives about albedo/pi, so
    // the sky's irradiance has to be multiplied up to read as the light it really is.
    setHemi(this.ambient, skyIrr, 3.0);
    const fillM = Math.max(skyIrr.x, skyIrr.y, skyIrr.z);
    this.fill.intensity = Math.max(fillM * 0.9, 0.0008);
    if (fillM > 1e-8) this.fill.color.setRGB(skyIrr.x / fillM, skyIrr.y / fillM, skyIrr.z / fillM);

    // The moon's disc: where it sits, which way it faces, and which limb its sun lights.
    if (this.moon) {
      this.moon.position.copy(this.moonDir).multiplyScalar(this.moonDistance);
      const toViewer = this.moonDir.clone().negate();
      this.moon.quaternion.setFromUnitVectors(v3(1, 0, 0), toViewer);
      // The moon's sun lies at the elongation angle from the direction back to us, in the plane
      // through the moon, the earth and the sun (approximated by the ecliptic's local plane).
      const right = toViewer.clone().cross(v3(0, 1, 0));
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      const e = this.moonElongation;
      this.moon.material.uniforms.uMoonSun.value
        .copy(toViewer).multiplyScalar(Math.cos(e))
        .add(right.multiplyScalar(Math.sin(e))).normalize();
      this.moon.visible = my > -0.05;
    }
    this.skyLuminance = skyIrr.y;
    this.applyExposure();
    this.domeMat.uniforms.uMoonGlow.value = smoothstep(-0.03, 0.05, my);
  }

  /**
   * The sky's irradiance on a horizontal surface, as a linear RGB vector: the same single-scattering
   * integral as the table, summed over nine directions with cosine weights. Three steps each, which
   * is rough but only ever feeds a light's intensity.
   */
  skyIrradiance(sunY, moonIrr) {
    const dirs = [
      [0, 1], [0.5, 0.866], [-0.5, 0.866], [0.87, 0.5], [-0.87, 0.5],
      [0.99, 0.14], [-0.99, 0.14], [0.7, 0.71], [-0.7, 0.71],
    ];
    let r = 0, g = 0, b = 0, wsum = 0;
    const sxz = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    for (const [h, y] of dirs) {
      const w = Math.max(y, 0);
      const cosT = clamp(h * sxz + y * sunY, -1, 1);
      const L = this.scatterAlong(y, cosT, sunY);
      r += L[0] * w; g += L[1] * w; b += L[2] * w;
      wsum += w;
    }
    const k = (Math.PI / Math.max(wsum, 1e-6)) * 0.42;
    const out = v3(r * k, g * k, b * k);
    // The night floor: the moon lights the whole sky, and airglow and starlight light the rest.
    // The airglow figure is tiny on purpose; the camera's adaptation is what makes a moonless
    // night readable, not a fake ambient that would flatten the moonlight when there is one.
    if (moonIrr) out.addScaledVector(moonIrr, 0.5);
    out.x += 1.1e-5; out.y += 1.4e-5; out.z += 2.0e-5;
    return out;
  }

  /**
   * One direction's single-scattered radiance, six steps, with the sun's transmittance taken at
   * each sample's own altitude. That last part is the whole of twilight: once the sun is below the
   * observer's horizon the low samples sit in the earth's shadow and only the high ones are lit,
   * so the glow rises up the sky and dies the way it really does. A sample `h` metres up sees the
   * sun `sqrt(2h/R)` radians higher than the observer does, which is the horizon dip.
   */
  scatterAlong(dirY, cosT, sunY) {
    const oy = R_GROUND + 2;
    const dy = Math.max(dirY, 0.004), dxz = Math.sqrt(Math.max(0, 1 - dy * dy));
    const top = hitSphere(oy, dy, dxz, R_TOP);
    const pR = 0.05968310365 * (1 + cosT * cosT);
    const gm = 0.8, g2 = gm * gm;
    const pM = 0.1193662073 * (1 - g2) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * gm * cosT, 1e-4), 1.5));
    const L = [0, 0, 0];
    const T = [1, 1, 1];
    const N = 6;
    for (let i = 0; i < N; i++) {
      const x0 = i / N, x1 = (i + 1) / N;
      const s0 = top * x0 * x0, s1 = top * x1 * x1;
      const ds = s1 - s0, sm = 0.5 * (s0 + s1);
      const px = dxz * sm, py = oy + dy * sm;
      const h = Math.hypot(px, py) - R_GROUND;
      const dr = Math.exp(-h / 8000), dm = Math.exp(-h / 1200);
      const dz = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
      const muSun = sunY + Math.sqrt(Math.max(2 * h / R_GROUND, 0));
      const ts = muSun > 0 ? cpuTransmittanceAt(h, muSun, 10) : ZERO3;
      for (let c = 0; c < 3; c++) {
        const sR = BETA_R[c] * dr, sM = 3.996e-6 * dm;
        L[c] += T[c] * ts[c] * (sR * pR + sM * pM + (sR + sM) * MS_ISO) * ds * SUN_IRRADIANCE.getComponent(c);
        T[c] *= Math.exp(-(BETA_R[c] * dr + BETA_M_E * dm + BETA_O[c] * dz) * ds);
      }
    }
    return L;
  }

  // --- the frame ---------------------------------------------------------------------------------

  /**
   * Advances the clock (when it is not pinned) and the cloud drift, and keeps the dome's camera
   * uniforms current. `camera` must have its world matrix up to date.
   */
  step(dt, camera, settings) {
    if (this.cycling) this.setClock(this.dayTime + dt / DAY_SECONDS);
    else this.applyLights();
    const u = this.domeMat.uniforms;
    // Cloud drifts downwind at about 60% of the surface wind: a distance, not a clock, so that a
    // rising wind really does push the sky along faster. Wrapped so the field keeps its precision.
    G.uCloudDrift.value = (G.uCloudDrift.value + dt * G.uWindSpeed.value * 0.6) % 2000000;
    u.uCamPos.value.copy(camera.position);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    if (this.starMat) this.starMat.uniforms.uStarScale.value = 1.3 * (settings?.pixelRatio ?? 1);
  }

  /**
   * Tells the sky what exposure the camera has settled on. The stars and the moon are drawn at a
   * fixed screen brightness, so they are divided by it; they also wash out as the sky brightens,
   * which is the real reason you cannot see a star at noon.
   */
  setExposure(exposure) {
    this.exposure = exposure;
    this.applyExposure();
  }

  applyExposure() {
    const e = Math.max(this.exposure ?? 1, 1e-3);
    const lum = this.skyLuminance ?? 0;
    if (this.starMat) {
      const wash = clamp01(1 - smoothstep(0.0012, 0.03, lum));
      this.starMat.uniforms.uStarGain.value = (wash * 1.35) / e;
      this.stars.visible = this.starMat.uniforms.uStarGain.value * e > 0.012;
    }
    if (this.moon) {
      const my = this.moonDir?.y ?? -1;
      // The moon is bright enough to stay visible by day, but it should never bloom at night.
      this.moonMat.uniforms.uGain.value = (18 * smoothstep(-0.03, 0.04, my)) / e;
    }
  }

  /** Sets the cloud state (cover 0..1, base m, thickness m, darkness 0..1) in the shared uniform. */
  setCloud(cover, base, thickness, darkness) {
    this.cloud.set(cover, base, thickness, darkness);
    G.uCloud.value.copy(this.cloud);
  }

  /** Pins the clock to `t` (0..1), or lets it run again with `null`. */
  setTime(t) {
    this.cycling = t === null || t === undefined;
    if (!this.cycling) this.setClock(t);
  }

  dispose() {
    this.atmos.dispose();
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.scene.remove(this.dome);
    if (this.stars) { this.stars.geometry.dispose(); this.starMat.dispose(); this.scene.remove(this.stars); }
    if (this.moon) {
      this.moon.geometry.dispose();
      this.moonMat.dispose();
      this.moonColorMap.dispose();
      this.moonBumpMap.dispose();
      this.scene.remove(this.moon);
    }
    for (const l of [this.sunLight, this.moonLight, this.ambient, this.fill]) this.scene.remove(l);
    this.scene.remove(this.sunLight.target);
  }
}
