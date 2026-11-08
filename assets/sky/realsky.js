// The real night sky, shared by every background that has one.
//
// Firefly Meadow, Loon Lake, Boreal Night, Aspen Snow, Sandstone Arch and Balloon Dawn each used to paint
// their own Milky Way onto an equirectangular canvas and hash their stars in the sky shader. This module
// replaces both with the real thing, the same two files Hangar's Phobos sky uses:
//
//   the Milky Way   NASA/Goddard SVS's Deep Star Maps 2020 (Gaia DR2), 8192 x 4096 equirectangular, with the
//                   Hipparcos and Tycho stars taken out of it, because they are drawn as points instead
//   the stars       the Hipparcos main catalogue, 118,218 stars to V 12, each at its measured position,
//                   brightness and colour (data/stars.bin, 10 bytes a star)
//
// The map has no stars in it and the catalogue has no nebulosity, so the two belong together: alone, the map
// is a bare glow and the catalogue is a sky with no Milky Way.
//
// Where the files live. Both are committed inside Hangar (hangar/html/assets/images/milkyway.ktx2 and
// hangar/html/data/stars.bin) and are loaded from there, rather than copied here, for two reasons: Hangar's
// manifest test requires every path in its manifest to stay inside its own page, and one URL means the
// browser caches 38 MB once for all seven backgrounds instead of once each. They are resolved against this
// module rather than against the page so that every background asks for the identical URL. If Hangar's assets
// ever move, this is the one place to fix; until then a background whose fetch fails simply keeps the painted
// sky it started with.
//
// How a background uses it:
//
//   const sky = new RealSky({ latitude: 41, north: -Math.PI / 2, matchBand: MILKY_WAY_NORMAL });
//   scene.add(sky.group);                                  // the map's sphere and the star points
//   sky.load(renderer).then(() => { ... });                // progressive: never rejects
//   sky.update(dt);                                        // turns the sky at the sidereal rate
//   uProcedural.value = 1 - sky.ready;                     // fade the painted sky out as the real one arrives
//
// The turn. The whole celestial sphere rotates about the north celestial pole once a sidereal day
// (23h 56m 04s, 15.041 degrees an hour), which is what it does in life and is slow enough that a background
// left running all evening drifts the way the real sky does: the band leans over, the stars rise in the east
// and set in the west. A background says where it is (latitude, and which way is north in its world) and the
// pole follows from that: it stands `latitude` degrees above the northern horizon. The start angle is chosen
// by matchBand so the band crosses the sky where the background's painter used to put it, which keeps every
// scene composed as it was reviewed.

import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Seconds for the sky to come back round: a sidereal day, not a solar one. */
export const SIDEREAL_DAY = 86164.0905;

// Hangar's copies, resolved against this file so every background shares one URL (see above).
const MILKY_WAY_URL = new URL('../../hangar/html/assets/images/milkyway.ktx2', import.meta.url).href;
const STARS_URL = new URL('../../hangar/html/data/stars.bin', import.meta.url).href;
const TRANSCODER = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/';

const radec = (ra, dec) => [
  Math.cos(dec * DEG) * Math.cos(ra * DEG), Math.cos(dec * DEG) * Math.sin(ra * DEG), Math.sin(dec * DEG),
];
/** Sgr A*, at the heart of the bulge: the brightest stretch of the band. */
export const GALACTIC_CENTER = radec(266.405, -28.936);
/** The north galactic pole: the normal of the band's plane. */
export const GALACTIC_POLE = radec(192.8595, 27.1283);

/**
 * The map's stored value to linear radiance (the file holds radiance / 0.2 as sRGB, see
 * hangar/tools/prepare-sky-ground.py), times the exposure these backgrounds are graded at. Hangar renders the
 * same map at 0.15 under its own tone curve; here the sky is the subject rather than a view out of a window,
 * so the band carries a little more.
 */
export const MILKY_WAY_GAIN = 0.42;
/** Linear brightness of a V 0 star's centre pixel. */
export const STAR_GAIN = 2.4;

// ----------------------------------------------------------------------------------------------
// Loading. One fetch per page, shared by every re-seed: the texture and the catalogue are never
// disposed, because a new scene built after a re-seed wants the same two objects.
// ----------------------------------------------------------------------------------------------

let pending = null;

/**
 * The Milky Way map and the star catalogue, fetched once for the page. Never rejects: whichever of the two
 * fails comes back null and the background keeps the painted sky it started with.
 * Resolves to { map: THREE.Texture | null, stars: { count, dir, mag, color } | null }.
 */
export function loadRealSky(renderer) {
  pending ??= Promise.all([loadMap(renderer), loadStars()]).then(([map, stars]) => ({ map, stars }));
  return pending;
}

function loadMap(renderer) {
  const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER).detectSupport(renderer);
  return ktx2.loadAsync(MILKY_WAY_URL)
    .then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      return tex;
    })
    .catch((err) => { console.warn('Real sky: the Milky Way map is unavailable, keeping the painted one', err); return null; })
    .finally(() => ktx2.dispose());
}

function loadStars() {
  return fetch(STARS_URL)
    .then((r) => { if (!r.ok) throw new Error(`${r.url} returned HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(decodeStars)
    .catch((err) => { console.warn('Real sky: the star catalogue is unavailable, keeping the hashed stars', err); return null; });
}

/**
 * data/stars.bin as { count, dir (ICRS unit vectors), mag (V), color (rgb 0..1) }. Ten bytes a star: int16
 * x, y, z of the unit vector x 32767, uint8 (V + 2) x 16, uint8 r, g, b. Brightest star first, which is what
 * lets Low Power draw a prefix of the catalogue and still get the sky's bright stars.
 */
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

// ----------------------------------------------------------------------------------------------
// The celestial frame: where the sky sits, and how it turns.
// ----------------------------------------------------------------------------------------------

/** The angle between the galactic pole and the celestial pole: 90 degrees less the galactic pole's dec. */
export const BAND_TO_POLE = Math.acos(Math.abs(GALACTIC_POLE[2]));

/**
 * The azimuths of true north at which a sky seen from `latitude` can carry the band's plane exactly where
 * `normal` wants it, so a background keeps the composition its painter chose.
 *
 * The galactic pole is a fixed 62.9 degrees from the celestial pole, so as the sky turns it traces a cone of
 * that half-angle about wherever the celestial pole stands. For the band to pass through the painted plane at
 * some hour of the night, the painted normal has to lie on that cone: one equation in the azimuth of north,
 * with two solutions, one, or none (the painted plane is unreachable from this latitude). Returns the
 * solutions, nearest-first to `prefer`, and an empty list if there are none.
 */
export function fitNorth(latitude, normal, prefer = -Math.PI / 2) {
  const n = normal.clone().normalize();
  const lat = latitude * DEG;
  const r = Math.hypot(n.x, n.z);
  if (r < 1e-6) return [];
  const rhs = (Math.cos(BAND_TO_POLE) - Math.sin(lat) * n.y) / (Math.cos(lat) * r);
  // The normal's sign is free (a plane has two), so try the other cone too and keep whichever is reachable.
  const out = [];
  for (const v of [rhs, -rhs]) {
    if (Math.abs(v) > 1) continue;
    const phi = Math.atan2(n.z, n.x), d = Math.acos(v);
    out.push(phi + d, phi - d);
  }
  const wrap = (a) => ((a % TAU) + TAU) % TAU;
  const away = (a) => Math.abs(((wrap(a - prefer) + Math.PI) % TAU) - Math.PI);
  return out.map(wrap).sort((a, b) => away(a) - away(b));
}

/**
 * The rotation taking ICRS directions (x toward RA 0, z toward the north celestial pole) to world directions
 * (y up, azimuth measured as atan2(z, x), the convention every one of these backgrounds uses).
 *
 * `latitude` degrees north and `north` (the azimuth of true north, radians) place the pole; `angle` is the
 * sky's turn about it and advances negatively at the sidereal rate, which is the direction that makes stars
 * rise in the east: the sky's apparent rotation is about the pole by -omega, the Earth's turn reversed.
 */
export class CelestialFrame {
  constructor({ latitude = 45, north = -Math.PI / 2, angle = 0 } = {}) {
    this.latitude = latitude;
    this.north = north;
    const lat = latitude * DEG;
    this.pole = new THREE.Vector3(Math.cos(lat) * Math.cos(north), Math.sin(lat), Math.cos(lat) * Math.sin(north));
    // Any fixed pair of axes perpendicular to the pole will do: `angle` absorbs where they start.
    const seed = Math.abs(this.pole.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.e1 = seed.clone().projectOnPlane(this.pole).normalize();
    this.e2 = new THREE.Vector3().crossVectors(this.pole, this.e1);
    /** ICRS -> world. */
    this.toWorld = new THREE.Matrix4();
    /** world -> ICRS, for a shader that samples the map from a world direction. */
    this.toCelestial = new THREE.Matrix3();
    this.setAngle(angle);
  }

  setAngle(angle) {
    this.angle = angle;
    const c = Math.cos(angle), s = Math.sin(angle);
    // The ICRS axes in world space: x and y turned about the pole by `angle`, z on the pole itself.
    const x = this.e1.clone().multiplyScalar(c).addScaledVector(this.e2, s);
    const y = this.e2.clone().multiplyScalar(c).addScaledVector(this.e1, -s);
    this.toWorld.makeBasis(x, y, this.pole);
    this.toCelestial.setFromMatrix4(this.toWorld).transpose();
    return this;
  }

  /** The sky's turn over `dt` seconds. */
  advance(dt) { return this.setAngle(this.angle - (TAU * dt) / SIDEREAL_DAY); }

  /** An ICRS direction in world space. */
  toWorldDir(d) { return new THREE.Vector3(d[0], d[1], d[2]).applyMatrix4(this.toWorld); }

  /**
   * The start angle that puts the band's plane where `normal` (a world direction: the normal the background's
   * own painter used) had it, with the galactic centre as high as that allows.
   *
   * The plane is what the eye reads, and a plane is unchanged by flipping its normal, so the two turns half a
   * sidereal day apart match it equally well; they differ in whether the bright bulge is above the horizon or
   * below it. So: find the best match to either sign, then among the turns within a couple of degrees of it
   * take the one whose galactic centre stands highest.
   */
  bestAngleFor(normal) {
    const target = normal.clone().normalize();
    const score = (a) => {
      const p = this.setAngle(a).toWorldDir(GALACTIC_POLE);
      return Math.acos(Math.min(1, Math.abs(p.dot(target))));
    };
    const STEP = 0.25 * DEG;
    let best = Infinity;
    for (let a = 0; a < TAU; a += STEP) best = Math.min(best, score(a));
    let chosen = 0, highest = -Infinity;
    for (let a = 0; a < TAU; a += STEP) {
      if (score(a) > best + 2 * DEG) continue;
      const h = this.setAngle(a).toWorldDir(GALACTIC_CENTER).y;
      if (h > highest) { highest = h; chosen = a; }
    }
    return chosen;
  }

  /**
   * The turn that shows the Milky Way at its best: the galactic centre near its highest, which is the hour
   * of the night a photographer would wait for. `before` hours short of culmination, so the band is still
   * climbing when the background is opened and goes on doing so for a while.
   *
   * How high that is, is the place's business and not ours: the core's declination is -29 degrees, so it
   * culminates at 61 degrees less the latitude, and north of 61 degrees it never rises at all. There the
   * best this can do is bring the outer arms over, which is what the sub-arctic sky really looks like.
   */
  bestAngleForCore(before = 1.5) {
    const STEP = 0.25 * DEG;
    let best = 0, highest = -Infinity;
    for (let a = 0; a < TAU; a += STEP) {
      const h = this.setAngle(a).toWorldDir(GALACTIC_CENTER).y;
      if (h > highest) { highest = h; best = a; }
    }
    return best + (TAU * before * 3600) / SIDEREAL_DAY;
  }

  /**
   * The turn that lays the band across the view: of all the hours of the night, the one whose galactic
   * equator tops out closest to `target` degrees of altitude within `spread` either side of `viewAzimuth`.
   *
   * This is for a background whose camera faces away from the galactic centre — one looking north at an
   * aurora, say. The bright bulge is in the southern sky and no hour will bring it round, but the band runs
   * the whole way round the sky, and through Cygnus and Cassiopeia it passes overhead, so some hour will
   * always bring it across the view.
   *
   * `target` is the altitude to aim the top of that arc at, and it matters more than it sounds: a scene
   * whose sky is a strip between the cliffs and the top of the frame wants the band inside that strip, and
   * the highest the band can go is usually straight out of shot. Measure what the camera actually sees
   * (unproject the frame's corners) and aim a little below the top of it.
   */
  bestAngleForView(viewAzimuth, target = 90, spread = 55 * DEG) {
    const g = new THREE.Vector3(...GALACTIC_POLE);
    const e1 = new THREE.Vector3(...GALACTIC_CENTER).projectOnPlane(g).normalize();
    const e2 = new THREE.Vector3().crossVectors(g, e1);
    const ring = [];
    for (let l = 0; l < TAU; l += 3 * DEG) {
      ring.push(e1.clone().multiplyScalar(Math.cos(l)).addScaledVector(e2, Math.sin(l)).toArray());
    }
    const wrap = (a) => Math.abs((((a + Math.PI) % TAU) + TAU) % TAU - Math.PI);
    const want = Math.sin(target * DEG);
    let best = 0, closest = Infinity;
    for (let a = 0; a < TAU; a += 0.5 * DEG) {
      this.setAngle(a);
      let top = -1;
      for (const p of ring) {
        const w = this.toWorldDir(p);
        if (wrap(Math.atan2(w.z, w.x) - viewAzimuth) <= spread) top = Math.max(top, w.y);
      }
      const miss = Math.abs(top - want);
      if (top > -1 && miss < closest) { closest = miss; best = a; }
    }
    return best;
  }
}

// ----------------------------------------------------------------------------------------------
// The two things that get drawn. Both are additive and unfogged, both sit in the celestial frame,
// and both fade out where the background's own sky dome fades into its haze, so nothing shines
// through the ground mist or survives a storm.
// ----------------------------------------------------------------------------------------------

// Camera-relative would be wrong here: these backgrounds have a fixed camera that only pans, so the sky can
// simply be a very large sphere like the dome it sits inside.
const FADE_HEAD = /* glsl */ `
uniform float uSkyFade;    // the background's own night / weather amount
uniform vec2 uSkyHorizon;  // the dome's horizon fade: (end, start) of a smoothstep on the y of the direction
float skyFade( vec3 d ) {
  return uSkyFade * smoothstep( uSkyHorizon.x, uSkyHorizon.y, normalize( d ).y );
}
`;

const MW_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vDir;
void main() {
  vUv = uv;
  vDir = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MW_FRAG = /* glsl */ `
${FADE_HEAD}
uniform sampler2D uMap;
uniform float uGain;
varying vec2 vUv;
varying vec3 vDir;
void main() {
  gl_FragColor = vec4( texture2D( uMap, vUv ).rgb * uGain * skyFade( vDir ), 1.0 );
}
`;

// Brightness steps 1.52x a magnitude rather than the true 2.512x (flux to the 0.45), so the naked-eye stars
// stand out and the faint ones down to V 12 still dust the sky, the way they do in a long exposure.
//
// The brightest also grow, and are allowed well past white: a point one pixel across cannot be brighter than
// one pixel, so without this the first-magnitude stars come out no brighter than the fifth and the sky reads
// as even dust with nothing to pick out. Measured against the painted skies these replace, the catalogue
// puts the same light in the sky overall (within a few per cent of the same mean) but spreads it over far
// more stars, so it is only the bright end that needs the help. Vega and Sirius then carry into the bloom
// pass and read as stars rather than specks.
const STAR_VERT = /* glsl */ `
${FADE_HEAD}
attribute float mag;
attribute vec3 starColor;
uniform float uScale;
uniform float uGain;
varying vec3 vStar;
void main() {
  vec3 w = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float b = uGain * exp2( - 0.6 * mag ) * skyFade( w );
  float big = clamp( ( 2.0 - mag ) / 3.5, 0.0, 1.0 );
  vStar = starColor * min( b, 2.8 );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = uScale * ( 1.7 + 3.6 * big );
  gl_Position = b < 0.002 ? vec4( 2.0, 2.0, 2.0, 1.0 ) : projectionMatrix * mv;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vStar;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  gl_FragColor = vec4( vStar * exp( - 3.0 * dot( q, q ) ), 1.0 );
}
`;

/**
 * The real sky for one background: the Milky Way map on a sphere and the catalogue as points, in a celestial
 * frame that turns at the sidereal rate.
 *
 * opts: { latitude, north, matchBand (a world-space band normal, as the background's painter had it),
 *         radius (the background's SKY_RADIUS), gain, starGain, horizon ([end, start] of the dome's own
 *         horizon fade), fade (the night amount to start at) }.
 *
 * `ready` is 0 until the files arrive and 1 once they have, so a background can cross-fade its painted sky
 * out: the scene is alive and starry from the first frame and the real sky replaces it when it lands.
 */
export class RealSky {
  constructor(opts = {}) {
    const { latitude = 45, radius = 1000, matchBand = null } = opts;
    this.radius = radius;
    this.ready = 0;
    this.group = new THREE.Group();
    this.frame = this.placeSky(latitude, matchBand, opts.north, opts.preferNorth, opts.viewAzimuth, opts);

    const fade = {
      uSkyFade: { value: opts.fade ?? 1 },
      uSkyHorizon: { value: new THREE.Vector2(...(opts.horizon ?? [0, 0.09])) },
    };
    this.fadeUniform = fade.uSkyFade;

    // The map goes on a sphere rather than being sampled from the direction in the dome's own shader: the uv
    // then comes from the geometry, so there is no derivative jump at the seam where the longitude wraps
    // (which picks the smallest mip and draws a blurred line up the sky) and the mip chain works properly.
    this.mapMaterial = new THREE.ShaderMaterial({
      name: 'milkyway',
      uniforms: { uMap: { value: null }, uGain: { value: opts.gain ?? MILKY_WAY_GAIN }, ...fade },
      vertexShader: MW_VERT, fragmentShader: MW_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.map = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.995, 128, 64), this.mapMaterial);
    this.map.frustumCulled = false;
    this.map.visible = false;
    this.map.matrixAutoUpdate = false;
    this.map.renderOrder = -9;
    this.group.add(this.map);

    this.starMaterial = new THREE.ShaderMaterial({
      name: 'stars',
      uniforms: { uScale: { value: 1 }, uGain: { value: opts.starGain ?? STAR_GAIN }, ...fade },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(new THREE.BufferGeometry(), this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.visible = false;
    this.stars.matrixAutoUpdate = false;
    this.stars.renderOrder = -8;
    this.group.add(this.stars);

    this.applyFrame();
  }

  /**
   * Stands the sky up at `latitude`, and picks the hour of the night to start at.
   *
   * With a `matchBand` normal and no `north` given, north is solved for (fitNorth) so the band's plane falls
   * exactly where the painter had it, and of the azimuths that manage that, the one whose galactic centre
   * ends up highest is taken, so the bright bulge is the part on show. Unreachable from this latitude (or
   * `north` given outright): that azimuth, and the closest turn to the painted plane that it allows.
   *
   * With no `matchBand` the hour is chosen for the sky itself: the galactic centre near culmination, or,
   * given a `viewAzimuth`, the band standing as high as it can across that view.
   */
  placeSky(latitude, matchBand, north, preferNorth = -Math.PI / 2, viewAzimuth, opts = {}) {
    const candidates = north !== undefined ? [north]
      : matchBand ? [...fitNorth(latitude, matchBand, preferNorth), preferNorth] : [preferNorth];
    let best = null;
    for (const az of candidates) {
      const frame = new CelestialFrame({ latitude, north: az });
      if (!matchBand) {
        return frame.setAngle(viewAzimuth === undefined
          ? frame.bestAngleForCore()
          : frame.bestAngleForView(viewAzimuth, opts.viewAltitude ?? 90));
      }
      frame.setAngle(frame.bestAngleFor(matchBand));
      const height = frame.toWorldDir(GALACTIC_CENTER).y;
      const tilt = Math.acos(Math.min(1, Math.abs(frame.toWorldDir(GALACTIC_POLE).dot(matchBand.clone().normalize()))));
      // A turn that misses the painted plane is worse than one that shows less of the bulge.
      const score = height - 6 * tilt;
      if (!best || score > best.score) best = { frame, score };
      if (north !== undefined) break;
    }
    return best.frame;
  }

  /**
   * Fetches the sky and shows it. Resolves to true once anything real is up (so the caller can fade its
   * painted sky out), false if neither file arrived.
   */
  load(renderer) {
    return loadRealSky(renderer).then(({ map, stars }) => {
      if (map) {
        this.mapMaterial.uniforms.uMap.value = map;
        this.map.visible = true;
      }
      if (stars) {
        const pos = new Float32Array(stars.count * 3);
        for (let i = 0; i < stars.count * 3; i++) pos[i] = stars.dir[i] * this.radius * 0.99;
        const g = this.stars.geometry;
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('mag', new THREE.BufferAttribute(stars.mag, 1));
        g.setAttribute('starColor', new THREE.BufferAttribute(stars.color, 3));
        this.starCount = stars.count;
        this.stars.visible = true;
      }
      this.ready = map || stars ? 1 : 0;
      return this.ready === 1;
    });
  }

  /** Point sprites are sized in device pixels, so they follow the pixel ratio. */
  setPixelRatio(r) { this.starMaterial.uniforms.uScale.value = r; }

  /** Low Power draws the brightest `fraction` of the catalogue (it is stored brightest first). */
  setStarFraction(fraction) {
    if (this.starCount) this.stars.geometry.setDrawRange(0, Math.max(1, Math.round(this.starCount * fraction)));
  }

  /** The night / weather amount: 0 hides the real sky entirely (daylight, a storm ceiling, overcast). */
  setFade(f) { this.fadeUniform.value = f; }

  /** Turns the sky. Pass the frame's dt in seconds; `speed` multiplies the sidereal rate for testing. */
  update(dt, speed = 1) {
    this.frame.advance(dt * speed);
    this.applyFrame();
  }

  applyFrame() {
    // The map's sphere has its own pole on local +y and its seam at RA 180; P turns that local frame into
    // ICRS (local x, y, z -> ICRS x, z, y), which is the frame the catalogue and the map share.
    const P = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.map.matrix.copy(this.frame.toWorld).multiply(P);
    this.map.matrixWorldNeedsUpdate = true;
    this.stars.matrix.copy(this.frame.toWorld);
    this.stars.matrixWorldNeedsUpdate = true;
  }

  /** The direction a named ICRS point is in now, for tests and for aiming a camera at the band. */
  direction(icrs) { return this.frame.toWorldDir(icrs); }

  dispose() {
    // The map texture and the catalogue are the page's, not this scene's: a re-seed reuses them.
    this.map.geometry.dispose();
    this.mapMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
  }
}
