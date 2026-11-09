// Trawler — The glazing: the windscreen and the side windows, and the weather on them.
//
// Hangar's lesson about glass was blunt: a pane that reflects the room draws blurred bands across
// the view out, and the view out is the point. So by day this glass is almost not there — a faint
// green edge-tint and a little sheen at grazing angles, nothing more. What it does carry is the
// weather:
//
//   rain      beads that sit, grow, and then run. On a boat making way they run *up* and
//             outboard, not down: the airflow over a wheelhouse screen beats gravity above about
//             five knots, which is why a working boat's screen clears itself from the bottom.
//   salt      a haze that builds while she is throwing spray and washes off in rain. It is what
//             makes a screen in a gale look like a screen in a gale rather than a clean pane.
//   wipers    two arms on the outer panes, parked until it rains.
//   clear view the spinning disc on the centre pane: a glass circle turned at 1500 rpm that throws
//             off everything that lands on it. Always clear, always there, and the one detail that
//             says "working boat" more than anything else in the house.
//   fogging   the inside misting up, which it does when it is cold out and warm in, and which the
//             demister clears from the bottom of the screen upward.
//
// At night the glass picks up a dim reflection of the instrument lights, which is the real look of
// a wheelhouse after dark; it is deliberately weak, for the reason above.
//
// One material serves every pane. Each mesh sets the handful of per-pane uniforms in its
// onBeforeRender, which works because the panes are drawn one after another.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ, NOISE_GLSL } from './shaders.js';
import { clamp01, lerp, approach, TAU } from './util.js';

export const PANE = { FRONT_CENTRE: 0, FRONT_SIDE: 1, SIDE: 2, DOOR: 3 };

const GLASS_VERT = /* glsl */ `
varying vec2 vPaneUv;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vPaneUv = uv;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
}
`;

const GLASS_FRAG = /* glsl */ `
layout( location = 0 ) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
${ATMOS_READ}
${NOISE_GLSL}
uniform vec2 uPaneSize;    // the pane in metres
uniform float uPaneKind;
uniform float uTime;
uniform float uRain;       // 0..1 how hard it is raining
uniform float uSalt;       // 0..1 how much dried spray is on it
uniform float uFog;        // 0..1 how misted the inside is
uniform float uWiper;      // the wipers phase, 0..1 of a sweep; negative means parked
uniform float uClearView;  // the clear-view screen rotation
uniform float uFlow;       // how hard the air is driving the drops up the screen (0..1)
uniform float uNight;
uniform vec3 uCabinLight;  // what the instruments throw back at the glass
varying vec2 vPaneUv;
varying vec3 vWorld;
varying vec3 vNormalW;

/** The sky straight up: the ambient on the glass's own fittings. */
vec3 skyAbove() { return skyRadiance( vec3( 0.0, 1.0, 0.0 ) ); }

/**
 * One layer of running drops. Each cell of the pane holds a drop that grows where it is, then
 * breaks away and runs, leaving a thinning trail behind it. Returns the amount of water and the
 * slope of the blob, which is what makes it act like a little lens.
 */
vec2 dropLayer( vec2 uv, float t, float scale, float speed ) {
  vec2 g = uv * scale;
  vec2 id = floor( g );
  vec2 f = fract( g );
  vec2 r = hash22( id );
  float phase = fract( r.x + t * speed * ( 0.55 + 0.9 * r.y ) );
  // It sits for the first part of its cycle, then runs the length of the cell.
  float run = smoothstep( 0.25, 1.0, phase );
  float cy = mix( 0.18 + 0.3 * r.y, 1.25, run );
  float cx = 0.5 + ( r.y - 0.5 ) * 0.5 + sin( phase * 9.0 + r.x * 6.0 ) * 0.03 * run;
  float size = ( 0.085 + 0.1 * r.x ) * ( 1.0 - 0.45 * run );
  vec2 d = ( f - vec2( cx, cy ) ) * vec2( 1.0, 0.85 );
  float head = smoothstep( size, size * 0.25, length( d ) );
  float trailW = size * 0.42;
  float below = clamp( ( cy - f.y ) / max( cy - 0.18, 0.001 ), 0.0, 1.0 );
  float trail = smoothstep( trailW, 0.0, abs( f.x - cx ) ) * below * run * 0.5
    * ( 0.4 + 0.6 * hash21( id + floor( f.y * 7.0 ) ) );
  return vec2( max( head, trail ), -( d.x + d.y * 0.4 ) * head * 7.0 );
}

/** The beads that never run: small, dense, and what a screen looks like in drizzle. */
float beads( vec2 uv, float scale, float t ) {
  vec2 g = uv * scale;
  vec2 id = floor( g );
  vec2 f = fract( g ) - 0.5;
  vec2 r = hash22( id ) - 0.5;
  float on = step( 0.35, fract( hash21( id + 3.1 ) + t * 0.04 ) );
  return smoothstep( 0.3, 0.08, length( f - r * 0.6 ) ) * on;
}

void main() {
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 N = normalize( vNormalW );
  float ndv = abs( dot( N, V ) );
  float fres = 0.04 + 0.96 * pow( 1.0 - ndv, 5.0 );
  vec2 uv = vPaneUv;              // in metres, so a drop is the same size on every window
  vec2 m = max( uPaneSize, vec2( 0.05 ) );

  // Above about five knots the airflow over the screen beats gravity and the drops climb.
  vec2 flowUv = vec2( uv.x, uv.y * mix( -1.0, 1.0, uFlow ) );
  float t = uTime;

  float wet = 0.0, lens = 0.0;
  if ( uRain > 0.01 ) {
    vec2 a = dropLayer( flowUv, t, 3.4, 0.10 + 0.22 * uRain );
    vec2 b = dropLayer( flowUv + 0.37, t, 5.9, 0.14 + 0.30 * uRain );
    wet = max( a.x, b.x * 0.8 ) * uRain;
    lens = ( a.y + b.y * 0.7 ) * uRain;
    wet = max( wet, beads( uv, 26.0, t ) * uRain * 0.45 );
  }

  // Dried spray, washed off again by rain.
  float salt = uSalt * ( 0.45 + 0.55 * fbm2d( uv * 9.0, 3 ) );
  salt *= 1.0 - 0.7 * smoothstep( 0.1, 0.6, uRain );

  // Misting on the inside, cleared from the bottom upward by the demister.
  float fog = uFog * smoothstep( 0.0, 0.45, uv.y / m.y ) * ( 0.6 + 0.4 * fbm2d( uv * 4.0 + 11.0, 2 ) );

  // The wipers, on the two outer front panes.
  float armMask = 0.0;
  if ( uPaneKind > 0.5 && uPaneKind < 1.5 && uWiper >= 0.0 ) {
    vec2 pivot = vec2( m.x * 0.5, -0.12 );
    vec2 d = uv - pivot;
    float ang = atan( d.x, d.y );
    float sweep = ( uWiper < 0.5 ? uWiper : 1.0 - uWiper ) * 2.0;
    float arm = mix( -0.62, 0.62, sweep );
    float near = abs( ang - arm );
    float reach = step( length( d ), m.y * 1.3 );
    float cleared = smoothstep( 0.30, 0.0, near ) * reach;
    wet *= 1.0 - cleared * 0.92;
    salt *= 1.0 - cleared * 0.5;
    fog *= 1.0 - cleared * 0.3;
    lens *= 1.0 - cleared;
    armMask = smoothstep( 0.014, 0.005, near ) * reach;
  }

  // The clear-view screen on the centre pane: a glass disc spun fast enough to throw off anything
  // that lands on it. Always clear, and the detail that says "working boat" more than any other.
  float rim = 0.0;
  if ( uPaneKind < 0.5 ) {
    vec2 c = vec2( m.x * 0.5 + 0.08, m.y * 0.52 );
    float r = length( uv - c );
    float disc = smoothstep( 0.195, 0.175, r );
    wet *= 1.0 - disc;
    salt *= 1.0 - disc;
    fog *= 1.0 - disc;
    lens *= 1.0 - disc;
    rim = smoothstep( 0.212, 0.196, r ) * smoothstep( 0.172, 0.19, r );
    // The drive motor behind the hub, a dark blur.
    rim = max( rim, smoothstep( 0.040, 0.030, r ) );
  }

  vec3 sky = skyAbove();
  // The wiper arm, dark against the light. It sits over everything else on its pane.
  if ( armMask > 0.02 ) {
    vec3 arm = vec3( 0.03, 0.033, 0.035 ) * ( uSunColor * 0.12 + sky );
    gl_FragColor = vec4( arm, armMask * 0.92 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  if ( rim > 0.02 ) {
    vec3 brass = vec3( 0.42, 0.30, 0.11 ) * ( uSunColor * 0.22 + sky * 0.7 );
    gl_FragColor = vec4( brass, rim * 0.95 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // What the glass itself adds, which by day is as close to nothing as it can be: a grazing sheen
  // and a green edge tint. The view out is the point (Hangar's lesson about reflective panes).
  // Where the pane is edge-on - the sliver of glass that runs behind a mullion, say - the Fresnel
  // term goes to one and the reflected ray points steeply down into the water. The sky table has
  // nothing below the horizon, so reading it there returns the bottom row and paints a saturated
  // green band down the whole edge of the window. A pane reflecting downward is showing the sea,
  // which is dark: the ray is clamped to the horizon and the sheen fades out under it.
  vec3 R = normalize( reflect( -V, N ) );
  float above = smoothstep( -0.03, 0.05, R.y );
  vec3 sheen = skyRadiance( vec3( R.x, max( R.y, 0.0 ), R.z ) ) * fres * 0.45 * ( 0.12 + 0.88 * above );
  vec3 cabin = uCabinLight * ( 0.10 + 0.5 * fres ) * uNight;
  // A drop is bright against a dark sea and dark against a bright sky, because it is a lens.
  vec3 lit = skyRadiance( normalize( vec3( V.x, abs( V.y ) + 0.25, V.z ) ) );
  vec3 wetColor = lit * clamp( 0.55 + 0.9 * lens, 0.0, 2.5 );
  vec3 saltColor = lit * 0.5 + uSunColor * 0.02;
  vec3 fogColor2 = lit * 0.45 + uCabinLight * 0.25;

  float alpha = clamp( wet * 0.72 + salt * 0.30 + fog * 0.5 + fres * 0.08 + 0.03, 0.0, 0.96 );
  vec3 color = sheen + cabin
    + wetColor * wet * 0.72
    + saltColor * salt * 0.30
    + fogColor2 * fog * 0.5;
  gl_FragColor = vec4( color, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Glazing {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSkyLut: G.uSkyLut, uTransLut: G.uTransLut,
        uSunDir: G.uSunDir, uMoonDir: G.uMoonDir, uSunColor: G.uSunColor, uMoonColor: G.uMoonColor,
        uHaze: G.uHaze, uHazeFar: G.uHazeFar,
        uPaneSize: { value: new THREE.Vector2(1, 1) },
        uPaneKind: { value: 1 },
        uTime: { value: 0 },
        uRain: { value: 0 },
        uSalt: { value: 0 },
        uFog: { value: 0 },
        uWiper: { value: -1 },
        uClearView: { value: 0 },
        uFlow: { value: 0.5 },
        uNight: G.uNight,
        uCabinLight: { value: new THREE.Vector3(0.1, 0.08, 0.05) },
      },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.wiperPhase = -1;
    this.wipersOn = false;
    this.salt = 0;
    this.fog = 0;
  }

  /** Tells a pane mesh what shape and kind it is; the uniforms are set as it is drawn. */
  register(mesh, kind, width, height) {
    mesh.userData.pane = { kind, width, height };
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material) => {
      // A pass with an override material (the occlusion pass's normals) hands that material in.
      if (!material.uniforms) return;
      material.uniforms.uPaneSize.value.set(width, height);
      material.uniforms.uPaneKind.value = kind;
    };
    mesh.renderOrder = 800;
    // The default layer only: the glass is not part of the room the occlusion pass measures, and
    // nothing else keys on the interior layer.
    mesh.layers.set(LAYER.DEFAULT);
  }

  /**
   * @param {number} dt
   * @param {{ rain: number, spray: number, speedKnots: number, night: number, cabin: THREE.Vector3 }} state
   */
  update(dt, state) {
    const u = this.material.uniforms;
    u.uTime.value = (u.uTime.value + dt) % 3600;
    const rain = clamp01(state.rain);
    u.uRain.value = rain;
    // Spray dries to salt; rain washes it off. A working screen is never quite clean.
    const dep = state.spray * 0.06 + 0.004;
    this.salt = clamp01(this.salt + (dep - this.salt * (0.02 + rain * 0.55)) * dt);
    u.uSalt.value = this.salt;
    // Misting: warm wheelhouse, cold night, and the demister only just keeping up.
    const want = clamp01(state.night * 0.5 + rain * 0.35) * 0.5;
    this.fog = approach(this.fog, want, 14, dt);
    u.uFog.value = this.fog;
    // The airflow beats gravity above about five knots, and the drops start climbing.
    u.uFlow.value = clamp01((state.speedKnots - 2.5) / 5);
    u.uCabinLight.value.copy(state.cabin);

    // The wipers run while it rains, and park when it stops: one more sweep, then still. The
    // switch on the overhead panel starts them whatever the weather, the way you do when the
    // screen has gone salty and you want a look at what is ahead.
    const wantWipers = rain > 0.12 || !!state.wipers;
    if (wantWipers) this.wipersOn = true;
    if (this.wipersOn) {
      this.wiperPhase = (this.wiperPhase < 0 ? 0 : this.wiperPhase) + dt / 2.4;
      if (this.wiperPhase >= 1) {
        this.wiperPhase -= 1;
        if (!wantWipers) { this.wipersOn = false; this.wiperPhase = -1; }
      }
    }
    u.uWiper.value = this.wiperPhase;
    u.uClearView.value = (u.uClearView.value + dt * 25) % TAU;
  }

  dispose() { this.material.dispose(); }
}
