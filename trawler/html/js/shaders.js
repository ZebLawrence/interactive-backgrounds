// Trawler — The uniforms every material shares, the atmosphere, the haze, the render layers and
// the GLSL helpers.
//
// The atmosphere is the spine of this scene: the sky dome, the sea's reflection, the haze on the
// islands and the colour of the sun on the hull all come out of the same scattering code, so they
// can never disagree. sky.js bakes two lookup tables with it:
//
//   uTransLut   64 x 64, baked once: transmittance from a point at altitude r (0..60 km) toward
//               the top of the atmosphere along cos(zenith) mu. Independent of the sun.
//   uSkyLut     192 x 108, re-baked every frame: single-scattered sun radiance for a viewer at sea
//               level, indexed by the azimuth away from the sun (u) and a sqrt-warped elevation (v)
//               so the horizon gets most of the rows. Clear sky only — cloud is drawn over it, and
//               approximated for reflections.
//
// Parameters are Bruneton's (2017): Rayleigh 5.802/13.558/33.1 um^-1 at 8 km scale height, Mie
// 3.996 um^-1 scattering and 4.44 um^-1 extinction at 1.2 km with g = 0.8, and an ozone tent
// 25 km up, 30 km wide, which is what makes a twilight sky blue overhead and orange at the rim.

import * as THREE from 'three';
import { v3, quantizer, srgbVec } from './util.js';

// ---------------------------------------------------------------------------------------------
// Layers. Several passes render subsets of the scene (guidelines section 3): put every object in
// the layers of the passes that should see it.
// ---------------------------------------------------------------------------------------------

export const LAYER = {
  DEFAULT: 0, // everything the main camera draws
  WORLD: 1, // sea, sky, land, wake: what a reflection or a radar pass may want
  INTERIOR: 2, // the pilot house: never in an outside pass
  SKYONLY: 3, // the sky frame: drawn by every camera, never shadowed
  REFLECT: 4, // what the sea's mirror camera draws: the land
};

/** Uniforms shared by every material in the scene. Objects are shared by reference, never cloned. */
export const G = {
  // The land's reflection for the sea: the terrain rendered from the camera's mirror image below
  // the surface (scene.js), the matrix that projects a world point into it, and whether it is on.
  uReflection: { value: null },
  uReflectVP: { value: new THREE.Matrix4() },
  uReflectOn: { value: 0 },
  uTime: { value: 0 }, // s, wraps hourly (TIME_WRAP)
  uDayTime: { value: 0.3 }, // 0..1 of the 24 h clock; 0 = midnight, 0.5 = noon

  // --- the two lights -------------------------------------------------------------------------
  uSunDir: { value: v3(0, 0.4, -1).normalize() },
  uMoonDir: { value: v3(0, 0.5, 1).normalize() },
  // Linear RGB irradiance of each light at the boat, already through the atmosphere.
  uSunColor: { value: v3(1, 1, 1) },
  uMoonColor: { value: v3(0, 0, 0) },
  // Whichever is the key light now, for glints and for the custom shaders that light themselves.
  uKeyDir: { value: v3(0, 0.4, -1).normalize() },
  uKeyColor: { value: v3(1, 1, 1) },
  // Hemispheric sky light (up) and the bounce off the sea (down), linear RGB.
  uSkyLight: { value: v3(0.4, 0.5, 0.7) },
  uSeaBounce: { value: v3(0.05, 0.08, 0.1) },
  uNight: { value: 0 }, // 0 by day, 1 when the sun is well down: for mood, not for light

  // --- the atmosphere -------------------------------------------------------------------------
  uSkyLut: { value: null },
  uTransLut: { value: null },
  uSkyLutSize: { value: new THREE.Vector2(192, 108) },
  // Haze beyond the clear-air scattering: sea haze and rain, as a per-metre extinction multiplier
  // and a scale distance. Sea state drives both.
  uHaze: { value: 1 },
  uHazeFar: { value: 14000 },

  // --- the weather ----------------------------------------------------------------------------
  uSea: { value: 0.25 }, // 0..1 sea state (Douglas 1 -> 7)
  uWind: { value: new THREE.Vector2(1, 0) }, // unit, the direction the wind blows toward
  uWindSpeed: { value: 6 }, // m/s at 10 m
  uCloud: { value: new THREE.Vector4(0.45, 900, 1, 0.3) }, // cover 0..1, base m, thickness scale, darkness
  uCloudDrift: { value: 0 }, // metres the cloud field has been carried downwind
  // The scene renders about a floating origin so a day of steaming never eats the precision of a
  // 32-bit position. Anything procedural that must stay anchored to the real world (the cloud
  // field, the land) adds this back; the sea does not need to, because the origin only ever moves
  // by a whole number of its patch sizes.
  uWorldOrigin: { value: new THREE.Vector2() },
  uRain: { value: 0 }, // 0..1
  uSpray: { value: 0 }, // 0..1 airborne spray over the sea

  // --- the boat -------------------------------------------------------------------------------
  uBoatPos: { value: v3() }, // world position of the hull origin (waterline, amidships)
  uBoatYaw: { value: 0 },
  uWakeTex: { value: null }, // foam trail, in the wake atlas's own frame
  uWakeFrame: { value: new THREE.Vector4(0, 0, 1 / 600, 0) }, // origin x, z, 1/extent, unused

  // --- the key light's shadow, for shaders that cannot use three's chunks ----------------------
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowOn: { value: 0 },
  uShadowTexel: { value: 1 / 2048 },
};

export const Q = quantizer('q');

// ---------------------------------------------------------------------------------------------
// The atmosphere, as GLSL. ATMOS_LUT is what bakes the tables; ATMOS_READ is what everything else
// includes to read them.
// ---------------------------------------------------------------------------------------------

/** Constants and the ray/sphere maths both halves need. */
export const ATMOS_COMMON = /* glsl */ `
const float R_GROUND = 6360000.0;
const float R_TOP = 6420000.0;
const float H_RAYLEIGH = 8000.0;
const float H_MIE = 1200.0;
const vec3 BETA_R = vec3( 5.802e-6, 13.558e-6, 33.1e-6 );
const float BETA_M_S = 3.996e-6;
const float BETA_M_E = 4.44e-6;
const vec3 BETA_O = vec3( 0.650e-6, 1.881e-6, 0.085e-6 );
const float MIE_G = 0.8;
const float LUT_MAX_ALT = 60000.0;

/** Distance along a ray from 'o' (earth-centred) in direction 'd' to the sphere of radius 'r'; -1 if it misses. */
float atmosHit( vec3 o, vec3 d, float r ) {
  float b = dot( o, d );
  float c = dot( o, o ) - r * r;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  disc = sqrt( disc );
  float t0 = -b - disc, t1 = -b + disc;
  return t0 >= 0.0 ? t0 : t1;
}

/** Densities at altitude h: Rayleigh, Mie, ozone (a tent 25 km up, 30 km wide). */
vec3 atmosDensity( float h ) {
  return vec3(
    exp( -h / H_RAYLEIGH ),
    exp( -h / H_MIE ),
    max( 0.0, 1.0 - abs( h - 25000.0 ) / 15000.0 ) );
}

/** Extinction per metre at altitude h. */
vec3 atmosExtinction( float h ) {
  vec3 d = atmosDensity( h );
  return BETA_R * d.x + vec3( BETA_M_E ) * d.y + BETA_O * d.z;
}

float phaseRayleigh( float c ) { return 0.05968310365 * ( 1.0 + c * c ); } // 3/(16pi) (1+c^2)
float phaseMie( float c ) {
  float g = MIE_G, g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return 0.1193662073 * ( 1.0 - g2 ) / ( ( 2.0 + g2 ) * pow( max( d, 1e-4 ), 1.5 ) ); // 3/(8pi) ...
}

/** The transmittance table's (u, v) for altitude h and cos(zenith) mu. */
vec2 transUv( float h, float mu ) {
  return vec2( 0.5 + 0.5 * mu, sqrt( clamp( h / LUT_MAX_ALT, 0.0, 1.0 ) ) );
}

/** The sky table's (u, v) for a view direction and the sun's direction (y up, world axes). */
vec2 skyUv( vec3 dir, vec3 sun ) {
  vec2 dh = dir.xz;
  vec2 sh = sun.xz;
  float lh = length( dh ), ls = length( sh );
  float cosAz = ( lh > 1e-5 && ls > 1e-5 ) ? clamp( dot( dh, sh ) / ( lh * ls ), -1.0, 1.0 ) : 1.0;
  float u = acos( cosAz ) * 0.31830989; // /pi
  float v = sqrt( clamp( ( dir.y + 0.1 ) / 1.1, 0.0, 1.0 ) );
  return vec2( u, v );
}
`;

/**
 * The baking shaders' body: the transmittance integral and the single-scattering raymarch.
 * 'atmosTransmittance' is used by the sky pass through uTransLut once that is baked.
 */
export const ATMOS_BAKE = /* glsl */ `
${ATMOS_COMMON}
uniform sampler2D uTransLut;

/** Transmittance from a point at altitude h along cos(zenith) mu out to the top, read from the table. */
vec3 lookupTrans( float h, float mu ) {
  return texture2D( uTransLut, transUv( h, mu ) ).rgb;
}

/** Transmittance between two altitudes on the same ray: the ratio of the two outward values. */
vec3 transSegment( vec3 p0, vec3 p1, vec3 d ) {
  float h0 = length( p0 ) - R_GROUND, h1 = length( p1 ) - R_GROUND;
  float mu0 = dot( normalize( p0 ), d ), mu1 = dot( normalize( p1 ), d );
  vec3 t0 = lookupTrans( h0, mu0 ), t1 = lookupTrans( h1, mu1 );
  return clamp( t0 / max( t1, vec3( 1e-7 ) ), vec3( 0.0 ), vec3( 1.0 ) );
}
`;

/** What the sky dome, the sea and the land include to read the baked tables. */
export const ATMOS_READ = /* glsl */ `
${ATMOS_COMMON}
uniform sampler2D uSkyLut;
uniform sampler2D uTransLut;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform float uHaze;
uniform float uHazeFar;

/**
 * Clear-sky radiance looking along 'dir' from sea level: the baked single scattering, plus the
 * moon's own Rayleigh glow and an airglow floor so a moonless night is dark blue, never black.
 */
vec3 skyRadiance( vec3 dir ) {
  vec3 L = texture2D( uSkyLut, skyUv( dir, uSunDir ) ).rgb;
  // The moon scatters the same way, 400,000 times fainter: one Rayleigh lobe is plenty.
  float cm = dot( dir, uMoonDir );
  float airMass = 1.0 / max( dir.y * 0.98 + 0.02, 0.02 );
  L += uMoonColor * phaseRayleigh( cm ) * ( 1.0 - exp( -airMass * 0.14 ) ) * 9.0;
  // Airglow and starlight: the floor a moonless sky never goes below. The figure has to agree
  // with the one sky.js adds to its irradiance (a radiance of about E/pi), or the camera's
  // adaptation, which can reach a thousand on a dark night, turns a "faint" glow into a white
  // screen. A few parts in a million of the daytime sky is what it really is.
  L += vec3( 0.0000030, 0.0000042, 0.0000060 ) * ( 1.0 - exp( -airMass * 0.1 ) ) * 3.0;
  return L;
}

/** Sea-level transmittance toward 'dir' (the sun's or moon's colour at the boat). */
vec3 skyTransmittance( vec3 dir ) {
  return texture2D( uTransLut, transUv( 0.0, dir.y ) ).rgb;
}

/**
 * Aerial perspective: 'color' seen through 'dist' metres of air along 'dir'. The clear-air part is
 * the sea-level extinction (no need for the altitude profile over a 30 km sight line at sea level);
 * 'uHaze' adds the sea haze and rain on top, and the in-scattered light is the sky in that very
 * direction, which is why distant land goes exactly the colour of the sky behind it.
 */
vec3 applyAerial( vec3 color, vec3 dir, float dist ) {
  vec3 beta = ( BETA_R + vec3( BETA_M_E ) ) * uHaze;
  // Haze is a surface layer: a sight line that climbs leaves it, so shorten the path with height.
  float climb = max( dir.y, 0.0 );
  float path = dist / ( 1.0 + climb * dist / uHazeFar );
  vec3 t = exp( -beta * path );
  vec3 inscatter = skyRadiance( dir ) * ( 1.0 - t );
  return color * t + inscatter;
}
`;

// ---------------------------------------------------------------------------------------------
// Three's own fog, replaced by the same aerial perspective so standard materials match. Distance
// is computed per fragment: a view-space *length* is not linear across a big triangle
// (guidelines section 4), and this scene has 2 km triangles.
// ---------------------------------------------------------------------------------------------

// The varying is the *view-space position*, which is an affine map of the world position and so
// interpolates correctly across a 2 km triangle; a view-space distance would not. The world-space
// view direction comes back from it per fragment with the view rotation's transpose, which also
// keeps instanced and skinned meshes right (they modify mvPosition, not modelMatrix).
THREE.ShaderChunk.fog_vertex = /* glsl */ `#ifdef USE_FOG
  vFogView = mvPosition.xyz;
#endif`;

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `#ifdef USE_FOG
  varying vec3 vFogView;
#endif`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3 vFogView;
#endif`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `#ifdef USE_FOG
  {
    float fogDist = length( vFogView );
    vec3 fogDir = normalize( vFogView * mat3( viewMatrix ) );
    gl_FragColor.rgb = applyAerial( gl_FragColor.rgb, fogDir, fogDist );
  }
#endif`;

/** Standard materials need the reader in scope before the fog chunk runs. */
export function patchStandardFog(material) {
  material.fog = true;
  material.onBeforeCompile = chain(material.onBeforeCompile, (shader) => {
    shader.uniforms.uSkyLut = G.uSkyLut;
    shader.uniforms.uTransLut = G.uTransLut;
    shader.uniforms.uSunDir = G.uSunDir;
    shader.uniforms.uMoonDir = G.uMoonDir;
    shader.uniforms.uSunColor = G.uSunColor;
    shader.uniforms.uMoonColor = G.uMoonColor;
    shader.uniforms.uHaze = G.uHaze;
    shader.uniforms.uHazeFar = G.uHazeFar;
    shader.fragmentShader = `${ATMOS_READ}\n${shader.fragmentShader}`;
  });
  return material;
}

/** Runs `extra` after any existing onBeforeCompile. */
export function chain(first, extra) {
  if (!first) return extra;
  return function (...args) { first.apply(this, args); extra.apply(this, args); };
}

// ---------------------------------------------------------------------------------------------
// GLSL helpers
// ---------------------------------------------------------------------------------------------

export const NOISE_GLSL = /* glsl */ `
float hash11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
float hash21( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
vec2 hash22( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.xx + q.yz ) * q.zy ); }
float hash31( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }

float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

float vnoise3( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  vec3 u = f * f * ( 3.0 - 2.0 * f );
  float a = mix( mix( hash31( i + vec3( 0, 0, 0 ) ), hash31( i + vec3( 1, 0, 0 ) ), u.x ),
                 mix( hash31( i + vec3( 0, 1, 0 ) ), hash31( i + vec3( 1, 1, 0 ) ), u.x ), u.y );
  float b = mix( mix( hash31( i + vec3( 0, 0, 1 ) ), hash31( i + vec3( 1, 0, 1 ) ), u.x ),
                 mix( hash31( i + vec3( 0, 1, 1 ) ), hash31( i + vec3( 1, 1, 1 ) ), u.x ), u.y );
  return mix( a, b, u.z );
}

float fbm2d( vec2 p, int octaves ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= octaves ) break;
    v += a * vnoise( p );
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

float fbm3d( vec3 p, int octaves ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= octaves ) break;
    v += a * vnoise3( p );
    p = p * 2.03 + 7.3;
    a *= 0.5;
  }
  return v;
}

/** Ridged noise: creases where the noise crosses its mean, which is what rock ridges look like. */
float ridged( vec2 p ) { float n = vnoise( p ); n = 1.0 - abs( n * 2.0 - 1.0 ); return n * n; }
`;

/**
 * A manual lookup into the key light's shadow map (three packs depth into RGBA), for shaders that
 * cannot use three's lighting chunks: 1 in the light, 0 in shadow, with a 3x3 PCF.
 */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform float uShadowTexel;
float unpackShadowDepth( vec4 v ) {
  return dot( v, vec4( 1.0 / ( 256.0 * 256.0 * 256.0 ), 1.0 / ( 256.0 * 256.0 ), 1.0 / 256.0, 1.0 ) );
}
float shadowAt( vec3 wpos, float bias ) {
  if ( uShadowOn < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( wpos, 1.0 );
  sc.xyz /= sc.w;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
  float lit = 0.0;
  for ( int j = -1; j <= 1; j++ ) {
    for ( int i = -1; i <= 1; i++ ) {
      vec2 uv = sc.xy + vec2( float( i ), float( j ) ) * uShadowTexel;
      lit += unpackShadowDepth( texture2D( uShadowMap, uv ) ) + bias < sc.z ? 0.0 : 1.0;
    }
  }
  return lit / 9.0;
}
`;

/** Schlick Fresnel for water, and the GGX lobe both the sea and wet rock use for the sun. */
export const BRDF_GLSL = /* glsl */ `
float fresnelWater( float cosTheta ) {
  float f = 0.0204; // (1.333-1)^2/(1.333+1)^2
  float m = clamp( 1.0 - cosTheta, 0.0, 1.0 );
  return f + ( 1.0 - f ) * m * m * m * m * m;
}

/** GGX normal distribution for an anisotropic slope variance (sx, sy are RMS slopes). */
float ggxAniso( vec3 h, vec2 s ) {
  vec2 a = max( s, vec2( 1e-3 ) );
  float hx = h.x / a.x, hz = h.z / a.y;
  float d = hx * hx + hz * hz + h.y * h.y;
  return 1.0 / ( 3.14159265 * a.x * a.y * d * d );
}

float smithG1( float ndv, float a ) {
  float a2 = a * a;
  return 2.0 * ndv / max( ndv + sqrt( a2 + ( 1.0 - a2 ) * ndv * ndv ), 1e-5 );
}
`;

/** Encodes a direction-independent "how rough does this surface look from here" from slope variance. */
export const VARIANCE_GLSL = /* glsl */ `
/** RMS slope seen through a pixel: the surface's own slope variance plus what the footprint adds. */
vec2 filteredSlope( vec2 rms, float footprint, float cutoff ) {
  float extra = clamp( footprint / max( cutoff, 1e-3 ), 0.0, 24.0 );
  return sqrt( rms * rms + vec2( 0.0016 ) * extra );
}
`;

/** The colours the UI and the stand-in materials start from. */
export const PALETTE = {
  seaDeep: srgbVec(0.031, 0.075, 0.098),
  seaShallow: srgbVec(0.10, 0.27, 0.27),
  foam: srgbVec(0.86, 0.90, 0.92),
  granite: srgbVec(0.33, 0.32, 0.31),
  moss: srgbVec(0.21, 0.24, 0.14),
  conifer: srgbVec(0.10, 0.15, 0.11),
  snow: srgbVec(0.86, 0.89, 0.95),
  teak: srgbVec(0.36, 0.22, 0.12),
  paint: srgbVec(0.78, 0.78, 0.76),
  deckGrey: srgbVec(0.30, 0.33, 0.33),
};
