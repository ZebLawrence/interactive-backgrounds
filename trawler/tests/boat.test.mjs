// A boat whose motion is wrong is the one thing in this scene nobody would be able to put a finger
// on but everybody would feel. These tests float her on a still sea and on a real one and measure
// what she actually does: does she float at her marks, how long is her roll, how fast does it die,
// how fast does she go, how tightly does she turn, and does a gale throw her about the way a gale
// should. Every figure is checked against what a 22 m trawler really does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Boat, HULL, RHO, GRAVITY, hullProperties, hullColumns, rollDecay } from '../html/js/boat.js';
import { Rng, DEG, toKnots } from '../html/js/mathutil.js';
import { buildSea, longWaveComponents, CASCADES, FFT_N, seaToWind, seaToFetch } from '../html/js/oceanspec.js';

/** A flat, motionless sea. */
const flatSea = () => ({ time: 0, sample: () => ({ h: 0, sx: 0, sz: 0 }), weather: null });

/** A real sea at a given state, built from the same spectrum the scene uses. */
function realSea(sea, seed = 3) {
  const rng = new Rng(seed);
  const u10 = seaToWind(sea), fetch = seaToFetch(sea);
  const built = buildSea({ u10, fetch, dirRad: 0.0 },
    { height: 0.6, dirRad: 1.6, periodS: 11, spread: 24 }, () => rng.normal());
  const comps = [
    ...longWaveComponents(built.cascades[0].data, CASCADES[0].size, FFT_N, 10, 300, 0.94),
    ...longWaveComponents(built.cascades[1].data, CASCADES[1].size, FFT_N, 6, 160, 0.9),
  ];
  return {
    time: 0,
    hs: built.hs,
    weather: { derived: { sea }, windDir: 0 },
    sample(x, z, t = this.time) {
      let h = 0, sx = 0, sz = 0;
      for (const w of comps) {
        const ph = w.kx * x + w.kz * z + w.dir * w.omega * t + w.phase;
        h += w.amp * Math.cos(ph);
        const s = -w.amp * Math.sin(ph);
        sx += s * w.kx;
        sz += s * w.kz;
      }
      return { h, sx, sz };
    },
  };
}

test('the station table describes a real 22 m trawler', () => {
  const p = hullProperties();
  // Displacement: a 22.4 x 6.6 x 2.8 m fishing boat displaces 180-230 tonnes.
  assert.ok(p.displacement > 170e3 && p.displacement < 240e3, `displacement ${p.displacement / 1000} t`);
  // Block coefficient: full, as a working hull is, but not a barge.
  const cb = p.volume / (HULL.length * HULL.beam * HULL.draught);
  assert.ok(cb > 0.38 && cb < 0.62, `block coefficient ${cb}`);
  // Waterplane coefficient.
  const cwp = p.waterplaneArea / (HULL.length * HULL.beam);
  assert.ok(cwp > 0.6 && cwp < 0.9, `waterplane coefficient ${cwp}`);
  // The centre of buoyancy sits a little over half the draught up from the keel.
  assert.ok(p.kb > 0.4 * HULL.draught && p.kb < 0.75 * HULL.draught, `KB ${p.kb}`);
  // Metacentric height: a fishing vessel wants 0.5-1.0 m. Less and she is dangerous; more and she
  // snaps back so hard nobody can work on deck.
  assert.ok(p.gm > 0.45 && p.gm < 1.1, `GM ${p.gm}`);
  // The boat's mass and the hull's displacement have to agree, or she floats high or low.
  assert.ok(Math.abs(p.displacement - HULL.mass) / HULL.mass < 0.05,
    `mass ${HULL.mass} against displacement ${p.displacement}`);
});

test('the columns reproduce the waterplane exactly', () => {
  const p = hullProperties();
  const cols = hullColumns();
  const area = cols.reduce((s, c) => s + c.area, 0);
  const iTrans = cols.reduce((s, c) => s + c.area * c.x * c.x, 0);
  const iLong = cols.reduce((s, c) => s + c.area * c.z * c.z, 0);
  assert.ok(Math.abs(area - p.waterplaneArea) / p.waterplaneArea < 1e-6, 'area');
  assert.ok(Math.abs(iTrans - p.iTrans) / p.iTrans < 1e-9, 'transverse second moment');
  assert.ok(Math.abs(iLong - p.iLong) / p.iLong < 1e-6, 'longitudinal second moment');
});

test('she floats at her marks in still water', () => {
  const b = new Boat(flatSea(), new Rng(1));
  for (let i = 0; i < 3000; i++) b.integrate(1 / 120, true);
  // The design waterline should end up at the sea surface, give or take a few centimetres.
  assert.ok(Math.abs(b.position.y) < 0.06, `she settles at ${b.position.y.toFixed(3)} m`);
  assert.ok(Math.abs(b.roll) < 1e-3 && Math.abs(b.pitch) < 1e-3, 'and upright');
});

test('her roll period and decay are a trawler\'s', () => {
  const b = new Boat(flatSea(), new Rng(1));
  const r = rollDecay(b, 90);
  // A 6.6 m beam vessel with this GM rolls with a period near 2 * 0.8 * B / sqrt(GM) seconds,
  // the old rule of thumb, which here is about 6 to 8 s. Under 5 s is a stiff, dangerous boat;
  // over 10 s and she is nearly unstable.
  assert.ok(r.period > 5 && r.period < 9.5, `roll period ${r.period} s`);
  // Bilge keels: a full roll cycle should take a good bite out of the amplitude, but she should
  // still swing several times rather than stopping dead.
  assert.ok(r.decay > 0.25 && r.decay < 0.8, `two cycles leave ${r.decay} of the roll`);
  assert.ok(r.peaks >= 6, `only ${r.peaks} swings in 90 s`);
});

test('the roll period follows the metacentric height the way the textbook says', () => {
  // T = 2 pi k / sqrt(g GM): make her stiffer and the period must come down as 1/sqrt(GM).
  const measure = (kg) => {
    const hull = { ...HULL, kg };
    const b = new Boat(flatSea(), new Rng(1));
    b.hull = hull;
    b.props = hullProperties(hull);
    b.columns = hullColumns(hull);
    return { gm: b.props.gm, period: rollDecay(b, 90).period };
  };
  const soft = measure(2.84);
  const stiff = measure(2.35);
  assert.ok(stiff.gm > soft.gm, 'lowering the weight raises GM');
  const ratio = soft.period / stiff.period;
  const want = Math.sqrt(stiff.gm / soft.gm);
  assert.ok(Math.abs(ratio - want) / want < 0.14, `period ratio ${ratio} against sqrt(GM) ratio ${want}`);
});

test('she makes her service speed and takes a while about it', () => {
  const b = new Boat(flatSea(), new Rng(1));
  b.orderThrottle(1);
  b.velocity.set(0, 0, 0);
  let timeTo90 = null;
  for (let i = 0; i < 120 * 300; i++) {
    b.integrate(1 / 120, false);
    if (timeTo90 === null && b.speedKnots > 7.8) timeTo90 = i / 120;
  }
  assert.ok(b.speedKnots > 8 && b.speedKnots < 10, `full speed ${b.speedKnots.toFixed(2)} kn`);
  // Two hundred tonnes does not accelerate quickly: it should take the best part of a minute.
  assert.ok(timeTo90 > 20 && timeTo90 < 180, `took ${timeTo90} s to reach 7.8 kn`);
  // And she must be going where she is pointing, not crabbing sideways.
  // A bearing B points along (sin B, -cos B).
  const fwdX = Math.sin(b.heading), fwdZ = -Math.cos(b.heading);
  const along = b.velocity.x * fwdX + b.velocity.z * fwdZ;
  const sideways = b.velocity.x * fwdZ - b.velocity.z * fwdX;
  assert.ok(Math.abs(sideways) < 0.05 * Math.abs(along), `crabbing: ${sideways.toFixed(3)} m/s sideways`);
});

test('she turns in a few boat lengths', () => {
  const b = new Boat(flatSea(), new Rng(1));
  b.orderThrottle(1);
  for (let i = 0; i < 120 * 200; i++) b.integrate(1 / 120, false);
  const speed = Math.hypot(b.velocity.x, b.velocity.z);
  b.orderRudder(HULL.maxRudder);
  for (let i = 0; i < 120 * 60; i++) b.integrate(1 / 120, false);
  const rate = Math.abs(b.rate.z); // rad/s in a steady turn
  const radius = speed / Math.max(rate, 1e-6);
  assert.ok(rate > 0.04 && rate < 0.3, `steady turn rate ${(rate * 180 / Math.PI).toFixed(1)} deg/s`);
  assert.ok(radius > 1.2 * HULL.length && radius < 8 * HULL.length,
    `turning radius ${radius.toFixed(0)} m, ${(radius / HULL.length).toFixed(1)} boat lengths`);
});

test('the sea moves her, and a gale moves her a great deal more', () => {
  // The sea runs along +x. Heading 0 (north, along -z) puts the sea on the beam, the worst case
  // for rolling; heading 90 (east, along +x) points her into it, the worst case for pitching.
  const measure = (sea, heading = 0) => {
    const ocean = realSea(sea);
    const b = new Boat(ocean, new Rng(2));
    b.orderThrottle(0.5);
    b.heading = heading;
    let maxRoll = 0, maxPitch = 0, minY = 1e9, maxY = -1e9, slams = 0, lastSlam = -99;
    for (let i = 0; i < 120 * 180; i++) {
      ocean.time = i / 120;
      b.integrate(1 / 120, false);
      if (i > 120 * 20) {
        maxRoll = Math.max(maxRoll, Math.abs(b.roll));
        maxPitch = Math.max(maxPitch, Math.abs(b.pitch));
        minY = Math.min(minY, b.position.y);
        maxY = Math.max(maxY, b.position.y);
        if (b.slamT > lastSlam) { slams++; lastSlam = b.slamT; }
      }
    }
    return { hs: ocean.hs, roll: maxRoll / DEG, pitch: maxPitch / DEG, heave: maxY - minY, slams,
      speed: b.speedKnots };
  };
  const calm = measure(0.04);
  const gale = measure(0.95);
  const galeHead = measure(0.95, Math.PI / 2);
  // Calm: she breathes. Anything over about five degrees in a flat calm is wrong.
  assert.ok(calm.roll < 6, `calm roll ${calm.roll.toFixed(1)} deg (Hs ${calm.hs.toFixed(2)} m)`);
  assert.ok(calm.heave < 1.2, `calm heave ${calm.heave.toFixed(2)} m`);
  // Gale: she is thrown about, but she does not capsize and she does not go mad.
  assert.ok(gale.roll > 9 && gale.roll < 55, `gale roll ${gale.roll.toFixed(1)} deg (Hs ${gale.hs.toFixed(2)} m)`);
  // Beam on she hardly pitches at all; head on she pitches to the slope of the sea, which for a
  // 5 m swell on a 135 m wavelength is something like seven degrees.
  assert.ok(gale.pitch < 5, `beam-on pitch ${gale.pitch.toFixed(1)} deg should be small`);
  assert.ok(galeHead.pitch > 3 && galeHead.pitch < 28, `head sea pitch ${galeHead.pitch.toFixed(1)} deg`);
  assert.ok(galeHead.roll < gale.roll, 'head on she rolls less than beam on');
  // Heave should be of the order of the wave height itself.
  assert.ok(gale.heave > gale.hs * 0.4 && gale.heave < gale.hs * 3.5,
    `gale heave ${gale.heave.toFixed(2)} m against Hs ${gale.hs.toFixed(2)} m`);
  assert.ok(gale.roll > calm.roll * 3, 'a gale must roll her far harder than a calm');
  // And she slows down in it.
  assert.ok(gale.speed < calm.speed, `gale ${gale.speed.toFixed(1)} kn against calm ${calm.speed.toFixed(1)} kn`);
});

test('nothing ever goes to NaN, however hard she is driven', () => {
  const ocean = realSea(1.0);
  const b = new Boat(ocean, new Rng(9));
  b.orderThrottle(1);
  for (let i = 0; i < 120 * 240; i++) {
    ocean.time = i / 120;
    b.orderRudder(Math.sin(i / 900) * HULL.maxRudder);
    b.integrate(1 / 120, false);
  }
  for (const v of [b.position.x, b.position.y, b.position.z, b.velocity.x, b.velocity.y, b.velocity.z,
    b.roll, b.pitch, b.heading, b.rate.x, b.rate.y, b.rate.z]) {
    assert.ok(Number.isFinite(v), 'a state variable went non-finite');
  }
  assert.ok(Math.abs(b.position.y) < 6, `she is at ${b.position.y.toFixed(2)} m: she has left the sea`);
});
