// Trawler — The hull: a body with six degrees of freedom floating on the wave field the GPU is
// drawing, steered by a rudder and a propeller.
//
// She is a west-coast steel trawler: 22.4 m overall, 6.6 m beam, 2.8 m draught, about 95 tonnes.
// Nothing about her motion is animated. The hull is cut into nine stations, each three columns
// wide; every frame each column is asked how deep it is under the sea surface at that very point,
// and the pressure on it is integrated. Heave, pitch and roll fall out of that, and so does the
// difference between a long swell (she follows it) and a short sea (she punches through it).
//
// Body axes: +x to starboard, +y up, +z aft, origin at the waterline amidships. The camera looks
// down -z, so the boat's forward is the camera's forward with no yaw offset.
//
// The numbers to check it against:
//   roll period      about 6.5 s, from the metacentric height a loaded trawler carries
//   pitch period     about 4 s
//   service speed    8.5 knots, half that in a head sea
//   roll amplitude   2-3 degrees in a calm, 20-30 degrees beam-on in a gale
// `trawler.boatReport()` measures all of them from the simulation itself.

import { clamp, clamp01, approach, Vec3, vec3, TAU, DEG, toKnots } from './mathutil.js';

export const RHO = 1025; // kg/m^3, seawater
export const GRAVITY = 9.81;

export const HULL = {
  length: 22.4,
  beam: 6.6,
  draught: 2.8,
  mass: 200000, // kg loaded: a 22 m steel trawler displaces about 200 tonnes, not the 95 a
  //              deadweight figure might suggest
  // Where the mass sits above the keel. Raising it lowers the metacentric height, which is what
  // makes a trawler tender: she rolls slowly and far rather than snapping back.
  kg: 2.84,
  // Radii of gyration as fractions of beam and length: the usual naval-architecture rules of thumb.
  kxx: 0.37,
  kyy: 0.25,
  kzz: 0.26,
  // Nine stations from the bow (-11.2 m) to the transom (+11.2 m). `halfBeam` is the half width at
  // the waterline; `depth` is the *effective* depth, the sectional area divided by the waterline
  // beam, so a station is modelled as a rectangle of the same area as the real section. That is
  // what makes the displacement, the centre of buoyancy and the righting moment come out right
  // without carrying a hull offset table.
  //
  // `freeboard` is how far the sheer stands above the waterline there. It matters as much as the
  // depth does: a hull pushed under keeps gaining buoyancy only while there is still topside to
  // immerse, and without it the columns saturate the moment she is pressed down and she has no
  // restoring left at all. A trawler's sheer rises sharply forward, which is what keeps her dry.
  stations: [
    { z: -11.2, halfBeam: 0.35, depth: 0.55, freeboard: 3.0 },
    { z: -8.4, halfBeam: 1.35, depth: 1.15, freeboard: 2.7 },
    { z: -5.6, halfBeam: 2.35, depth: 1.60, freeboard: 2.3 },
    { z: -2.8, halfBeam: 3.05, depth: 1.80, freeboard: 1.9 },
    { z: 0.0, halfBeam: 3.30, depth: 1.86, freeboard: 1.7 },
    { z: 2.8, halfBeam: 3.28, depth: 1.86, freeboard: 1.6 },
    { z: 5.6, halfBeam: 3.10, depth: 1.80, freeboard: 1.55 },
    { z: 8.4, halfBeam: 2.80, depth: 1.62, freeboard: 1.55 },
    { z: 11.2, halfBeam: 2.45, depth: 1.30, freeboard: 1.6 },
  ],
  // Added mass and added inertia, as fractions of the real ones. A hull drags a slab of water with
  // it; in heave that slab is about as heavy as the boat.
  addedHeave: 1.0,
  addedSway: 0.9,
  addedSurge: 0.08,
  addedRoll: 0.28,
  addedPitch: 0.8,
  addedYaw: 0.7,
  // Damping. Roll is the interesting one: a bare hull would roll for a minute, bilge keels and the
  // skeg bring it down to a few cycles.
  heaveDamp: 0.30, // fraction of critical
  pitchDamp: 0.30,
  rollDampLinear: 0.055,
  rollDampQuad: 0.42, // bilge keels: the term that grows with the square of the roll rate
  yawDamp: 2.0e6, // N m per rad/s
  swayDrag: 9000, // N per (m/s)^2
  swayLinear: 9000, // N per m/s
  surgeDrag: 3900, // N per (m/s)^2: 78 kN of thrust gives 8.7 knots
  // Propulsion and steering.
  maxThrust: 78000, // N
  rudderArea: 2.1, // m^2
  rudderLiftSlope: 2.1,
  rudderArm: 10.4, // m abaft the centre of gravity
  maxRudder: 32 * DEG,
  rudderRate: 3.4 * DEG, // per second: a hydraulic ram, not a gaming wheel
  // How hard a following sea shoves the stern round. Tuned so that running before a gale she
  // yaws a few degrees either side and needs the wheel, which is what broaching feels like.
  broachTorque: 1.9e6,
  // The wheelhouse eye, in body coordinates.
  eye: { x: 0, y: 5.62, z: 0.55 },
};

/**
 * What the station table adds up to: the displacement, the waterplane's second moments, and the
 * heights the stability depends on. Every one of these is a number a reader can check against a
 * real boat, which is why they are computed rather than typed in.
 */
export function hullProperties(hull = HULL) {
  const st = hull.stations;
  let area = 0, iLong = 0, iTrans = 0, volume = 0, momentY = 0, momentZ = 0;
  for (let i = 0; i < st.length; i++) {
    const dz = i === 0 || i === st.length - 1
      ? (st[1].z - st[0].z) * 0.5
      : (st[i + 1].z - st[i - 1].z) * 0.5;
    const w = 2 * st[i].halfBeam;
    const a = w * dz;
    area += a;
    iLong += a * st[i].z * st[i].z;
    iTrans += (w * w * w / 12) * dz;
    volume += a * st[i].depth;
    // The centroid of a rectangular section sits half its depth under the waterline.
    momentY += a * st[i].depth * (-st[i].depth * 0.5);
    momentZ += a * st[i].depth * st[i].z;
  }
  const bm = iTrans / Math.max(volume, 1e-6);
  const yb = momentY / Math.max(volume, 1e-6); // centre of buoyancy, metres above the waterline (negative)
  const yg = hull.kg - hull.draught; // centre of gravity, metres above the waterline
  // Where the buoyancy acts along her length. The weight has to sit at the same place or she
  // floats down by the head; this is the trim condition, and it is read off the hull rather than
  // guessed, so changing a station cannot quietly put her out of trim.
  const lcb = momentZ / Math.max(volume, 1e-6);
  return {
    waterplaneArea: area,
    iLong,
    iTrans,
    volume,
    displacement: volume * RHO,
    bm,
    yb,
    yg,
    lcb,
    kb: hull.draught + yb,
    gm: bm + yb - yg,
  };
}

/** The columns the pressure is integrated over: three across each station. */
export function hullColumns(hull = HULL) {
  const st = hull.stations;
  const cols = [];
  for (let i = 0; i < st.length; i++) {
    const dz = i === 0 || i === st.length - 1
      ? (st[1].z - st[0].z) * 0.5
      : (st[i + 1].z - st[i - 1].z) * 0.5;
    const b = st[i].halfBeam;
    // Three columns per station, at 0 and +/- b/sqrt(2), each a third of the strip's area. That
    // placement reproduces the strip's second moment about the centreline exactly, which is what
    // sets the righting moment and so the roll period.
    const area = (2 * b * dz) / 3;
    const off = b * Math.SQRT1_2;
    for (const x of [-off, 0, off]) {
      cols.push({ x, z: st[i].z, area, depth: st[i].depth, top: st[i].depth + st[i].freeboard, bow: st[i].z < -7 });
    }
  }
  return cols;
}

export class Boat {
  /**
   * @param {object} ocean anything with sample(x, z) -> { h, sx, sz }
   * @param {import('./util.js').Rng} rng
   */
  constructor(ocean, rng) {
    this.ocean = ocean;
    this.rng = rng;
    this.hull = HULL;
    this.props = hullProperties(HULL);
    this.columns = hullColumns(HULL);

    // The state. Position is in render space (the scene's floating origin); `worldOffset` carries
    // however many origin steps have gone by, so navigation still knows where she really is.
    this.position = vec3(0, 0, 0);
    this.velocity = vec3();
    this.heading = rng.range(0, TAU); // yaw: 0 is north (-z), positive turns to starboard
    this.pitch = 0;
    this.roll = 0;
    this.rate = vec3(); // roll, pitch, yaw rates (rad/s) about the body axes

    this.rudder = 0;
    this.rudderOrder = 0;
    this.throttle = 0.62;
    this.throttleOrder = 0.62;

    // The body-to-world rotation, row major. scene.js hangs a three.js matrix off it; keeping it
    // as nine numbers is what lets this module (and the tests) run without three.
    this.R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.slamT = -99;
    this.slamStrength = 0;
    this.lastHeaveAccel = 0;
    this.accel = vec3();
    this.sinceStep = 0;

    const m = HULL.mass;
    this.inertia = {
      roll: m * (HULL.kxx * HULL.beam) ** 2,
      pitch: m * (HULL.kyy * HULL.length) ** 2,
      yaw: m * (HULL.kzz * HULL.length) ** 2,
    };
    this.settle();
  }

  /** Puts her at rest in the water she is floating on, so the first frame is not a splash. */
  settle() {
    for (let i = 0; i < 240; i++) this.integrate(1 / 60, true);
    this.velocity.set(0, 0, 0);
    this.rate.set(0, 0, 0);
  }

  // --- orders ---------------------------------------------------------------------------------

  /** Orders a heading (radians). The autopilot works the rudder to get there. */
  steerTo(heading) { this.headingOrder = heading; }
  /** Orders a rudder angle directly, for a hand steer. */
  orderRudder(a) { this.rudderOrder = clamp(a, -HULL.maxRudder, HULL.maxRudder); }
  orderThrottle(t) { this.throttleOrder = clamp01(t); }

  /** Speed through the water, in knots. */
  get speedKnots() { return toKnots(Math.hypot(this.velocity.x, this.velocity.z)); }
  /** The direction she is actually making good, which is not her heading in a cross sea. */
  get course() { return Math.atan2(this.velocity.x, -this.velocity.z); }

  // --- the simulation --------------------------------------------------------------------------

  /**
   * Advances her. The physics runs at a fixed 1/120 s however long the frame was: a buoyancy
   * integrator stepped with a frame's dt goes unstable the first time a frame stalls
   * (guidelines section 3).
   */
  step(dt) {
    const h = 1 / 120;
    this.sinceStep += dt;
    let steps = Math.floor(this.sinceStep / h);
    this.sinceStep -= steps * h;
    steps = Math.min(steps, 8); // after a long stall, catch up a little and let the rest go
    for (let i = 0; i < steps; i++) this.integrate(h, false);
    this.updateMatrix();
  }

  integrate(h, settling) {
    const hull = this.hull;
    const P = this.props;
    const cy = Math.cos(this.heading), sy = Math.sin(this.heading);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);

    // Body to world, R = Ry(heading) Rx(pitch) Rz(roll), written out so the hot loop over
    // twenty-seven columns does not go through a matrix class. Forward is -z, starboard +x, up +y.
    const m00 = cy * cr + sy * sp * sr, m02 = sy * cp;
    const m10 = cp * sr, m11 = cp * cr, m12 = -sp;
    const m20 = -sy * cr + cy * sp * sr, m22 = cy * cp;

    // A world-vertical unit force, expressed in the body frame: the middle row of R.
    const uyx = m10, uyy = m11, uyz = m12;

    let fy = 0, tRoll = 0, tPitch = 0, tYaw = 0;
    let wetArea = 0, slopeX = 0, slopeZ = 0, bowSub = 99;
    const t = this.ocean.time;
    for (const c of this.columns) {
      // The column's top (the design waterline at that station), in world space.
      const wx = this.position.x + m00 * c.x + m02 * c.z;
      const wy = this.position.y + m10 * c.x + m12 * c.z;
      const wz = this.position.z + m20 * c.x + m22 * c.z;
      const s = this.ocean.sample(wx, wz, t);
      // How much of the column is under water. Its foot is `depth` below its top, so a column
      // sitting exactly at its design waterline is fully immersed: that is what makes her float at
      // her marks rather than settling until the deck is awash.
      const sub = clamp(s.h - wy + c.depth, 0, c.top);
      if (c.bow) bowSub = Math.min(bowSub, sub);
      if (sub <= 1e-5) continue;
      const f = RHO * GRAVITY * c.area * sub;
      fy += f;
      // The force acts at the centroid of the immersed part of the column, which is below the
      // waterline. That depth is not a detail: it is the whole of the KB term in the metacentric
      // height, and leaving it out makes her a great deal stiffer than she should be.
      const ry = -c.depth + sub * 0.5;
      // torque = r x (f * uy), in the body frame.
      tRoll += f * (c.x * uyy - ry * uyx);
      tPitch += f * (ry * uyz - c.z * uyy);
      tYaw += f * (c.z * uyx - c.x * uyz);
      wetArea += c.area;
      slopeX += s.sx * c.area;
      slopeZ += s.sz * c.area;
    }
    if (wetArea > 1e-6) { slopeX /= wetArea; slopeZ /= wetArea; }

    // Gravity at the centre of mass: above the waterline (the moment that makes her tender) and
    // over the centre of buoyancy along her length (so she floats on her marks, not by the head).
    const weight = hull.mass * GRAVITY;
    tRoll -= weight * (0 * uyy - P.yg * uyx);
    tPitch -= weight * (P.yg * uyz - P.lcb * uyy);
    tYaw -= weight * (P.lcb * uyx - 0 * uyz);

    // --- heave ---------------------------------------------------------------------------------
    const mEff = hull.mass * (1 + hull.addedHeave);
    const kHeave = RHO * GRAVITY * P.waterplaneArea;
    const cHeave = 2 * hull.heaveDamp * Math.sqrt(kHeave * mEff);
    const ay = (fy - weight - cHeave * this.velocity.y) / mEff;
    this.velocity.y += ay * h;
    this.position.y += this.velocity.y * h;
    this.accel.y = ay;

    // --- roll ----------------------------------------------------------------------------------
    const iRoll = this.inertia.roll * (1 + hull.addedRoll);
    const kRoll = RHO * GRAVITY * P.volume * Math.max(P.gm, 0.12);
    const cRoll = 2 * hull.rollDampLinear * Math.sqrt(kRoll * iRoll);
    const rollDamp = -cRoll * this.rate.x
      - hull.rollDampQuad * Math.sqrt(kRoll * iRoll) * this.rate.x * Math.abs(this.rate.x);
    this.rate.x += ((tRoll + rollDamp + this.rudderHeelMoment()) / iRoll) * h;
    this.roll = clamp(this.roll + this.rate.x * h, -1.2, 1.2);

    // --- pitch ---------------------------------------------------------------------------------
    const iPitch = this.inertia.pitch * (1 + hull.addedPitch);
    const kPitch = RHO * GRAVITY * P.iLong;
    const cPitch = 2 * hull.pitchDamp * Math.sqrt(kPitch * iPitch);
    this.rate.y += ((tPitch - cPitch * this.rate.y) / iPitch) * h;
    this.pitch = clamp(this.pitch + this.rate.y * h, -0.5, 0.5);

    if (settling) { this.updateMatrix(); return; }

    // --- the engine, the rudder and the way she goes ---------------------------------------------
    this.throttle = approach(this.throttle, this.throttleOrder, 4.5, h);
    const want = clamp(this.rudderOrder, -hull.maxRudder, hull.maxRudder);
    this.rudder += clamp(want - this.rudder, -hull.rudderRate * h, hull.rudderRate * h);

    const fwdX = -m02, fwdZ = -m22;   // the way she is pointing
    const sideX = m00, sideZ = m20;   // to starboard
    const along = this.velocity.x * fwdX + this.velocity.z * fwdZ;
    const sideways = this.velocity.x * sideX + this.velocity.z * sideZ;
    // Resistance rises steeply punching into a sea, which is why she slows down in a gale.
    const seaDrag = 1 + 2.2 * clamp01(this.ocean.weather?.derived?.sea ?? 0) * this.headSeaFactor(fwdX, fwdZ);
    const alongAccel = (this.throttle * hull.maxThrust - hull.surgeDrag * seaDrag * along * Math.abs(along))
      / (hull.mass * (1 + hull.addedSurge));
    const sideAccel = -(hull.swayDrag * sideways * Math.abs(sideways) + hull.swayLinear * sideways)
      / (hull.mass * (1 + hull.addedSway));
    this.velocity.x += (alongAccel * fwdX + sideAccel * sideX) * h;
    this.velocity.z += (alongAccel * fwdZ + sideAccel * sideZ) * h;
    // The slope of the water she is sitting on gives her a shove downhill: that is what makes her
    // surge on the back of a swell and get thrown about in a steep sea.
    this.velocity.x -= GRAVITY * slopeX * 0.16 * h;
    this.velocity.z -= GRAVITY * slopeZ * 0.16 * h;
    this.position.x += this.velocity.x * h;
    this.position.z += this.velocity.z * h;

    // --- yaw -----------------------------------------------------------------------------------
    const iYaw = this.inertia.yaw * (1 + hull.addedYaw);
    // A rudder only bites when there is water going past it; the propeller's race keeps a little
    // of that even at dead slow, which is how a boat can be steered while barely moving.
    const flow = Math.abs(along) + 1.1 * this.throttle;
    const lift = 0.5 * RHO * hull.rudderArea * flow * flow * hull.rudderLiftSlope * Math.sin(this.rudder);
    let yawTorque = -lift * hull.rudderArm * (along >= 0 ? 1 : -1);
    // The sea's own slope under her pushes the stern round: broaching, running before a gale.
    yawTorque += (slopeX * fwdZ - slopeZ * fwdX) * hull.broachTorque;
    yawTorque += tYaw;
    yawTorque -= hull.yawDamp * this.rate.z;
    this.rate.z += (yawTorque / iYaw) * h;
    this.heading += this.rate.z * h;
    if (this.heading > Math.PI) this.heading -= TAU;
    if (this.heading < -Math.PI) this.heading += TAU;

    // --- slamming -------------------------------------------------------------------------------
    // The forefoot comes out of the water and crashes back in: a big upward acceleration the moment
    // it re-enters. The threshold is in g, so it is a figure that can be checked against the real
    // thing (a working boat slams at about 1 g).
    if (ay > 9.0 && this.lastHeaveAccel <= 9.0 && this.bowDry) {
      this.slamT = this.ocean.time;
      this.slamStrength = clamp01((ay - 9) / 20);
    }
    this.lastHeaveAccel = ay;
    this.bowDry = bowSub < 0.18;
    this.updateMatrix();
  }

  /** A rudder hard over heels her outward; it is small, but it is there and you feel it. */
  rudderHeelMoment() {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    return -Math.sin(this.rudder) * speed * speed * 9000;
  }

  /** 1 when the sea is on the nose, 0 when it is astern: how much harder she has to push. */
  headSeaFactor(fwdX, fwdZ) {
    const w = this.ocean.weather;
    if (!w) return 0.5;
    const wx = Math.cos(w.windDir), wz = Math.sin(w.windDir);
    return clamp01(0.5 - 0.5 * (fwdX * wx + fwdZ * wz));
  }

  /** Rebuilds the body-to-world rotation: R = Ry(heading) Rx(pitch) Rz(roll). */
  updateMatrix() {
    const cy = Math.cos(this.heading), sy = Math.sin(this.heading);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const R = this.R;
    R[0] = cy * cr + sy * sp * sr; R[1] = -cy * sr + sy * sp * cr; R[2] = sy * cp;
    R[3] = cp * sr;                R[4] = cp * cr;                 R[5] = -sp;
    R[6] = -sy * cr + cy * sp * sr; R[7] = sy * sr + cy * sp * cr; R[8] = cy * cp;
  }

  /** A body point in world (render) space. */
  toWorld(x, y, z, out = new Vec3()) {
    const R = this.R, p = this.position;
    return out.set(
      p.x + R[0] * x + R[1] * y + R[2] * z,
      p.y + R[3] * x + R[4] * y + R[5] * z,
      p.z + R[6] * x + R[7] * y + R[8] * z,
    );
  }

  /** A body direction in world space (no translation). */
  toWorldDir(x, y, z, out = new Vec3()) {
    const R = this.R;
    return out.set(R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z);
  }

  /** Seconds since the last slam, and how hard it was. */
  slamAge(now) { return now - this.slamT; }

  /** A line for the ?perf overlay. */
  describe() {
    return `${this.speedKnots.toFixed(1)} kn · heading ${((this.heading * 180 / Math.PI + 360) % 360).toFixed(0)} deg`
      + ` · roll ${(this.roll * 180 / Math.PI).toFixed(1)} deg · pitch ${(this.pitch * 180 / Math.PI).toFixed(1)} deg`
      + ` · rudder ${(this.rudder * 180 / Math.PI).toFixed(0)} deg · GM ${this.props.gm.toFixed(2)} m`;
  }
}

/**
 * Lets go of her in still water with a 20 degree list and measures what she does: the roll period
 * and how fast it dies away. Pure enough to run in a node test against a flat sea.
 */
export function rollDecay(boat, seconds = 60, dt = 1 / 120) {
  const samples = [];
  boat.roll = 20 * DEG;
  boat.rate.set(0, 0, 0);
  boat.velocity.set(0, 0, 0);
  for (let i = 0; i < seconds / dt; i++) {
    boat.integrate(dt, true);
    samples.push({ t: i * dt, roll: boat.roll });
  }
  // Zero crossings give the period; successive peaks give the decay.
  const peaks = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1].roll, b = samples[i].roll, c = samples[i + 1].roll;
    if (Math.abs(b) > Math.abs(a) && Math.abs(b) > Math.abs(c)) peaks.push(samples[i]);
  }
  const period = peaks.length > 2 ? (peaks[peaks.length - 1].t - peaks[0].t) / (peaks.length - 1) * 2 : NaN;
  const decay = peaks.length > 2 ? Math.abs(peaks[2].roll / peaks[0].roll) : NaN;
  return { period, decay, peaks: peaks.length, samples };
}
