// Trawler — Her wake, her bow wave and the spray she throws.
//
// Two different things, because they behave differently:
//
// The **foam trail** is a texture in world coordinates that follows the boat. Every frame the hull
// stamps itself into it and the whole thing fades a little; when the frame has to move, the old
// contents are copied across at a whole-texel offset so nothing swims. That is what lets the trail
// bend round every turn she makes and still be there two minutes later, which no analytic pattern
// can do.
//
// The **wake waves** are analytic, in her own frame. Kelvin worked out in 1887 that a ship's wake
// is contained in a wedge of 19.47 degrees either side of the track whatever her speed, and that
// inside it are transverse crests a wavelength 2 pi V^2 / g apart with divergent crests running
// out to the edge. Both of those are written straight into the water's vertex shader; they only
// matter within a hundred metres or so of her, which is close enough to the present that a turn
// has not had time to distort them.
//
// The **bow wave** is the wedge of water she pushes up and the white that breaks off it, and the
// **spray** is what comes off that wedge in a sea, thrown up and blown aft by the wind.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ, NOISE_GLSL } from './shaders.js';
import { v3, clamp, clamp01, lerp, smoothstep, TAU, Art } from './util.js';

export const WAKE = {
  size: 1024,
  extent: 900, // m across the whole texture: about three minutes of trail at six knots
  fade: 70, // s for the trail to die away
  maxSpray: 900,
};

const QUAD_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/**
 * One pass: the old trail, shifted to the new frame and faded, plus whatever the hull is laying
 * down this step. The hull's footprint is a capsule from the bow to a little abaft the stern,
 * widened by her beam and by how hard she is being driven.
 */
const WAKE_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}
uniform sampler2D uPrev;
uniform vec2 uShift;      // where the previous frame sits in this one, in uv
uniform float uFade;
uniform vec2 uBoat;       // the boat in this frame's uv
uniform vec2 uHeading;    // her heading as a unit vector in uv space
uniform float uHalfLength;
uniform float uHalfBeam;
uniform float uStrength;  // how hard she is working: nothing at rest, a lot at full ahead
uniform float uTexel;
uniform float uTime;
layout( location = 0 ) out vec4 outWake;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 prevUv = uv + uShift;
  float prev = 0.0;
  if ( prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0 ) {
    prev = texture( uPrev, prevUv ).r * uFade;
  }

  // The hull's footprint, in her own frame.
  vec2 d = uv - uBoat;
  vec2 fwd = uHeading;
  vec2 side = vec2( -fwd.y, fwd.x );
  float along = dot( d, fwd );      // positive ahead of her
  float across = dot( d, side );
  // From the bow back to a couple of lengths astern: the hull itself, then the prop race.
  float inHull = smoothstep( -uHalfLength * 2.6, -uHalfLength * 0.9, along ) * step( along, uHalfLength );
  float width = uHalfBeam * mix( 1.0, 2.1, clamp( -along / ( uHalfLength * 2.6 ), 0.0, 1.0 ) );
  float band = smoothstep( width, width * 0.35, abs( across ) );
  float lay = inHull * band * uStrength * 0.8;
  // The propeller's race is the white part: a narrow, hard boil right behind her.
  float race = smoothstep( -uHalfLength * 1.9, -uHalfLength * 0.95, along ) * step( along, -uHalfLength * 0.8 )
    * smoothstep( uHalfBeam * 0.8, 0.0, abs( across ) ) * uStrength;
  lay = max( lay, race * 1.2 );
  // Broken up a little, or it reads as a painted stripe.
  lay *= 0.55 + 0.45 * vnoise( uv * 900.0 + uTime * 0.4 );

  outWake = vec4( clamp( max( prev, lay ), 0.0, 1.0 ), 0.0, 0.0, 1.0 );
}
`;

/** What the water shader includes to read the trail and to add the Kelvin pattern. */
export const WAKE_GLSL = /* glsl */ `
uniform sampler2D uWakeTex;
uniform vec4 uWakeFrame;   // centre x, z, half extent, 1/half extent
uniform vec4 uWakeBoat;    // boat x, z, heading sin, heading cos
uniform vec2 uWakeDrive;   // speed through the water (m/s), how hard she is driven 0..1

/** The foam she has laid down, at a world point. */
float wakeFoam( vec2 world ) {
  vec2 uv = ( world - uWakeFrame.xy ) * uWakeFrame.w * 0.5 + 0.5;
  if ( uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998 ) return 0.0;
  return texture( uWakeTex, uv ).r;
}

/**
 * The Kelvin pattern: transverse crests across the track and divergent crests along the arms of
 * the wedge, all inside 19.47 degrees of the track whatever her speed. Returns the height in
 * metres; the foam that goes with it comes back in y.
 */
vec2 kelvinWake( vec2 world, float time ) {
  float speed = uWakeDrive.x;
  if ( speed < 0.4 ) return vec2( 0.0 );
  vec2 d = world - uWakeBoat.xy;
  vec2 fwd = vec2( uWakeBoat.z, -uWakeBoat.w );     // her heading as a direction
  vec2 side = vec2( -fwd.y, fwd.x );
  float astern = -dot( d, fwd );
  float across = dot( d, side );
  if ( astern < -14.0 || astern > 160.0 ) return vec2( 0.0 );

  // The wedge. Its half width grows with distance astern at a fixed angle.
  float halfWidth = 0.3536 * max( astern, 0.0 ) + 3.2;
  float edge = abs( across ) - halfWidth;
  float inside = smoothstep( 5.0, -6.0, edge );
  // The transverse crests: wavelength 2 pi V^2 / g, which is why a fast boat's wake is long.
  float lambda = max( 6.2831853 * speed * speed / 9.81, 2.5 );
  float transverse = cos( 6.2831853 * astern / lambda );
  // The divergent crests run out along the arms at about half that wavelength.
  float arm = abs( across ) * 2.83 - astern;
  float divergent = cos( 6.2831853 * arm / ( lambda * 0.62 ) ) * smoothstep( 14.0, 1.0, abs( edge ) );
  float decay = exp( -astern / 52.0 ) * inside;
  float amp = 0.26 * uWakeDrive.y * clamp( speed / 4.5, 0.0, 1.4 );
  float h = ( transverse * 0.55 + divergent * 0.45 ) * decay * amp;

  // The bow wave: a wedge of water she pushes up, highest right at the shoulder.
  float bowAlong = -astern;                 // positive ahead of her
  float bow = 0.0;
  if ( bowAlong > -12.0 && bowAlong < 13.0 ) {
    float shoulder = smoothstep( 13.0, 2.0, abs( bowAlong - 4.0 ) );
    float lateral = smoothstep( 7.5, 2.4, abs( across ) ) * smoothstep( 1.4, 3.0, abs( across ) );
    bow = shoulder * lateral * 0.55 * uWakeDrive.y * clamp( speed / 4.0, 0.0, 1.3 );
  }
  // The white: along the arms, along the bow wave, and everywhere the hull has been.
  // The white along the arms is a soft band, not a painted stripe, and it is gone within a
  // couple of hundred metres: the trail that lasts is the texture, which bends with her turns.
  float foam = smoothstep( 7.0, 1.0, abs( edge ) ) * decay * uWakeDrive.y * 0.55;
  foam = max( foam, bow * 1.1 );
  return vec2( h + bow, clamp( foam, 0.0, 1.0 ) );
}
`;

// =============================================================================================
// WakeField: the trail texture and the pass that keeps it
// =============================================================================================

export class WakeField {
  constructor(renderer) {
    this.renderer = renderer;
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.targets = [
      new THREE.WebGLRenderTarget(WAKE.size, WAKE.size, opts),
      new THREE.WebGLRenderTarget(WAKE.size, WAKE.size, opts),
    ];
    this.index = 0;
    this.centre = new THREE.Vector2(0, 0);
    this.frame = new THREE.Vector4(0, 0, WAKE.extent / 2, 2 / WAKE.extent);
    this.boat = new THREE.Vector4(0, 0, 0, 1);
    this.drive = new THREE.Vector2(0, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: {
        uPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uFade: { value: 0.99 },
        uBoat: { value: new THREE.Vector2(0.5, 0.5) },
        uHeading: { value: new THREE.Vector2(0, 1) },
        uHalfLength: { value: 11.2 / WAKE.extent },
        uHalfBeam: { value: 3.3 / WAKE.extent },
        uStrength: { value: 0 },
        uTexel: { value: 1 / WAKE.size },
        uTime: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.clear();
  }

  get texture() { return this.targets[this.index].texture; }

  clear() {
    const r = this.renderer;
    for (const t of this.targets) {
      r.setRenderTarget(t);
      r.setClearColor(0x000000, 1);
      r.clear();
    }
    r.setRenderTarget(null);
  }

  /**
   * @param {number} dt
   * @param {import('./boat.js').Boat} boat
   */
  step(dt, boat) {
    const texel = WAKE.extent / WAKE.size;
    // The frame only ever moves in whole texels, so the old contents land exactly on the grid.
    const wantX = Math.round(boat.position.x / texel) * texel;
    const wantZ = Math.round(boat.position.z / texel) * texel;
    const shiftX = (wantX - this.centre.x) / WAKE.extent;
    const shiftZ = (wantZ - this.centre.y) / WAKE.extent;
    this.centre.set(wantX, wantZ);
    this.frame.set(wantX, wantZ, WAKE.extent / 2, 2 / WAKE.extent);

    const speed = Math.hypot(boat.velocity.x, boat.velocity.z);
    const drive = clamp01(speed / 3.6) * clamp01(boat.throttle * 1.6);
    this.drive.set(speed, drive);
    const u = this.material.uniforms;
    u.uPrev.value = this.targets[this.index].texture;
    u.uShift.value.set(shiftX, shiftZ);
    u.uFade.value = Math.exp(-dt / WAKE.fade);
    u.uBoat.value.set(
      (boat.position.x - wantX) / WAKE.extent + 0.5,
      (boat.position.z - wantZ) / WAKE.extent + 0.5,
    );
    // Her heading as a direction in the texture's uv (x east, y south, same as the world).
    u.uHeading.value.set(Math.sin(boat.heading), -Math.cos(boat.heading));
    u.uStrength.value = drive;
    u.uTime.value = (u.uTime.value + dt) % 600;

    const next = 1 - this.index;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.targets[next]);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    this.index = next;
    this.boat.set(boat.position.x, boat.position.z, Math.sin(boat.heading), Math.cos(boat.heading));
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

// =============================================================================================
// Spray: what comes off the bow when she is working in a sea
// =============================================================================================

const SPRAY_VERT = /* glsl */ `
attribute vec3 spray;    // age, life, size
uniform float uTime;
uniform float uPixelRatio;
varying float vAge;
void main() {
  vAge = spray.x / max( spray.y, 0.001 );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  // The size is a real one: a drop of spray is a few centimetres, and gl_PointSize has to come
  // out of that and the distance rather than out of a number that happens to look right at ten
  // metres and like a beach ball at two.
  gl_PointSize = spray.z * uPixelRatio * ( 540.0 / max( -mv.z, 0.5 ) ) * ( 0.75 + 0.9 * vAge );
  gl_Position = projectionMatrix * mv;
}
`;

const SPRAY_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying float vAge;
void main() {
  float a = texture2D( uMap, gl_PointCoord ).a;
  // It breaks off bright and white, then thins into mist and goes.
  float fade = smoothstep( 0.0, 0.08, vAge ) * ( 1.0 - smoothstep( 0.45, 1.0, vAge ) );
  gl_FragColor = vec4( uColor, a * fade * 0.85 );
  if ( gl_FragColor.a < 0.004 ) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Spray {
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.count = WAKE.maxSpray;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.data = new Float32Array(this.count * 3); // age, life, size
    this.live = 0;
    this.next = 0;
    for (let i = 0; i < this.count; i++) this.data[i * 3 + 1] = -1;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('spray', new THREE.BufferAttribute(this.data, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: Art.texture(Art.blob(96, 0.1), { srgb: false }) },
        uColor: { value: v3(1.0, 1.05, 1.1) },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 820;
    this.points.layers.set(LAYER.DEFAULT);
    this.points.layers.enable(LAYER.WORLD);
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, size) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.data[i * 3] = 0; this.data[i * 3 + 1] = life; this.data[i * 3 + 2] = size;
  }

  /**
   * @param {number} dt
   * @param {import('./boat.js').Boat} boat
   * @param {object} weather derived weather
   * @param {{x:number,y:number}} wind the wind as a direction vector
   */
  step(dt, boat, weather, wind, pixelRatio = 1) {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
    const speed = Math.hypot(boat.velocity.x, boat.velocity.z);
    // She throws spray when the bow is working: that means driving hard, a sea running, or the
    // forefoot coming out and crashing back.
    const slam = clamp01(1 - (boat.ocean.time - boat.slamT) / 0.7) * boat.slamStrength;
    const base = clamp01((speed - 1.6) / 3.0) * clamp01(weather.sea * 2.4);
    const rate = (base * 90 + slam * 700) * dt;
    const fwdX = Math.sin(boat.heading), fwdZ = -Math.cos(boat.heading);
    let n = Math.floor(rate);
    if (this.rng.next() < rate - n) n++;
    for (let i = 0; i < n; i++) {
      // Off the shoulder of the bow, either side, where the wedge breaks.
      const side = this.rng.coin() ? 1 : -1;
      const p = boat.toWorld(side * this.rng.range(1.6, 3.2), this.rng.range(0.4, 1.8), -this.rng.range(6.5, 10.5));
      const up = this.rng.range(2.0, 6.5) * (0.4 + base + slam * 1.6);
      const out = this.rng.range(1.2, 4.0) * side;
      this.emit(
        p.x, p.y, p.z,
        boat.velocity.x + fwdX * this.rng.range(0.5, 2.5) + out * -fwdZ,
        up,
        boat.velocity.z + fwdZ * this.rng.range(0.5, 2.5) + out * fwdX,
        this.rng.range(0.9, 2.4), this.rng.range(0.10, 0.42),
      );
    }

    // Spindrift: in a real blow the crests themselves come off and blow downwind.
    if (weather.spray > 0.02) {
      const drift = weather.spray * 60 * dt;
      let m = Math.floor(drift);
      if (this.rng.next() < drift - m) m++;
      for (let i = 0; i < m; i++) {
        const a = this.rng.range(0, TAU), r = this.rng.range(8, 70);
        const x = boat.position.x + Math.cos(a) * r;
        const z = boat.position.z + Math.sin(a) * r;
        const h = boat.ocean.sample(x, z).h;
        this.emit(x, h + 0.3, z,
          wind.x * weather.u10 * 0.45 + this.rng.gauss(), this.rng.range(0.3, 2.2),
          wind.y * weather.u10 * 0.45 + this.rng.gauss(),
          this.rng.range(1.4, 3.4), this.rng.range(0.14, 0.52));
      }
    }

    // Move what is in the air: gravity, and the wind getting hold of it.
    const windX = wind.x * weather.u10 * 0.5, windZ = wind.y * weather.u10 * 0.5;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      const d = i * 3;
      if (this.data[d + 1] <= 0) continue;
      this.data[d] += dt;
      if (this.data[d] >= this.data[d + 1]) { this.data[d + 1] = -1; continue; }
      // Small drops have little inertia: the wind takes them almost at once.
      const grip = 1 - Math.exp(-dt / (0.35 + this.data[d + 2] * 0.5));
      this.vel[d] += (windX - this.vel[d]) * grip;
      this.vel[d + 2] += (windZ - this.vel[d + 2]) * grip;
      this.vel[d + 1] -= 9.81 * dt * 0.55;
      this.pos[d] += this.vel[d] * dt;
      this.pos[d + 1] += this.vel[d + 1] * dt;
      this.pos[d + 2] += this.vel[d + 2] * dt;
      // Back into the sea it came from.
      if (this.pos[d + 1] < boat.ocean.sample(this.pos[d], this.pos[d + 2]).h - 0.2) this.data[d + 1] = -1;
      else live++;
    }
    this.live = live;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.spray.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.uniforms.uMap.value.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
