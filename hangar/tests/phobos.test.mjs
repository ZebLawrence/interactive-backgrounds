import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, insidePoly } from '../html/js/level.js';
import { makeRng } from '../html/js/rng.js';
import {
  marsAngularDiameter, horizonDistance, curvatureDrop, openEdges, marsDirection, sunDirection, planShell,
  makeTerrain, scatterBoulders, sectorClass, sunlitSectors, MARS_ELEVATION, SUN_ELEVATION, PARAPET, TERRAIN_REACH,
  decodeGround, GROUND_N, GROUND_STEP, skyOrientation, applySky, decodeStars, GALACTIC_CENTER, MILKY_WAY,
} from '../html/js/phobos.js';

const level = loadLevel(JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8')));
const edges = openEdges(level);
const mars = marsDirection(level, edges);
const terrain = makeTerrain(level, makeRng(1).fork('terrain'), mars.flat);
const DEG = Math.PI / 180;

test('Phobos numbers: Mars 42° across, horizon ~190 m from eye height, 183 m drop at 2 km', () => {
  assert.ok(Math.abs(marsAngularDiameter() - 42.4) < 0.1);
  assert.ok(Math.abs(horizonDistance(1.7) - 193) < 2);
  assert.ok(Math.abs(curvatureDrop(2000) - 183.3) < 0.5);
  assert.equal(curvatureDrop(0), 0);
});

test('Mars hangs 25° up toward the courtyard side the windows look at (south here)', () => {
  const [x, y, z] = mars.dir;
  assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9);
  assert.ok(Math.abs(Math.asin(y) / DEG - MARS_ELEVATION) < 1e-9);
  assert.ok(z > 0.9, `Mars should face the courtyard's open (south, +z) side, got ${mars.flat}`);
  // The computer-room window's poi looks within 15° of Mars's azimuth.
  const p = level.pois.find((q) => q.id === 'comp-window');
  const look = Math.atan2(p.look[2] - p.z, p.look[0] - p.x), az = Math.atan2(mars.flat[1], mars.flat[0]);
  assert.ok(Math.abs(look - az) < 15 * DEG);
});

test('the sun is 30° up and 100° of azimuth from Mars, either side', () => {
  for (const side of [1, -1]) {
    const s = sunDirection(mars.flat, side);
    assert.ok(Math.abs(Math.asin(s[1]) / DEG - SUN_ELEVATION) < 1e-9);
    const a = Math.atan2(s[2], s[0]) - Math.atan2(mars.flat[1], mars.flat[0]);
    const d = Math.abs(((a / DEG + 540) % 360) - 180);
    assert.ok(Math.abs(d - 100) < 1e-6);
  }
});

test('exterior sectors lose their edge-of-the-world walls; courtyards get parapets; walls in front of buildings stay', () => {
  for (const w of edges.dropped) assert.equal(sectorClass(level.byId.get(w.front)), 'exterior');
  for (const w of edges.parapets) assert.equal(sectorClass(level.byId.get(w.front)), 'courtyard');
  assert.ok([...edges.dropped].some((w) => w.front === 'exit-view'), 'the ground below the exit window opens up');
  assert.ok([...edges.parapets].some((w) => w.front === 'yard-west'), 'the courtyard opens to the south');
  // The exit window's flanking walls stand in front of the exit room: they stay.
  assert.ok([...edges.backed.keys()].some((w) => w.front === 'exit-view'));
  for (const [w, b] of edges.backed) assert.notEqual(b.id, w.front);
});

test('the shell: parapets PARAPET tall, façades face out, every interior sector roofed above its ceiling', () => {
  const shell = planShell(level, edges);
  for (const q of shell.inner) assert.ok(q.corners[2][1] - q.corners[1][1] > 0);
  for (const q of shell.inner.filter((k) => [...edges.parapets].some((w) => w.front === k.sector && w.a[0] === k.corners[0][0] && w.a[1] === k.corners[0][2]))) {
    assert.ok(Math.abs(q.corners[2][1] - q.corners[1][1] - PARAPET) < 1e-9);
  }
  for (const r of shell.roofs) assert.ok(r.y > level.byId.get(r.sector).ceil);
  // A façade's normal points away from its sector: a point 0.5 m along it is outside the sector.
  for (const q of shell.quads) {
    if (q.normal[1] !== 0 || q.corners[0][1] > -7) continue; // façades and parapet outer faces start below ground
    const mx = (q.corners[0][0] + q.corners[1][0]) / 2, mz = (q.corners[0][2] + q.corners[1][2]) / 2;
    assert.ok(!insidePoly(level.byId.get(q.sector).poly, mx + q.normal[0] * 0.5, mz + q.normal[2] * 0.5), `${q.sector} façade faces in`);
  }
});

test('terrain: exactly the floor inside an exterior sector, continuous at its edge, finite out to 2 km', () => {
  const ev = level.byId.get('exit-view');
  const [cx, cz] = ev.poly.reduce((a, [x, z]) => [a[0] + x / ev.poly.length, a[1] + z / ev.poly.length], [0, 0]);
  assert.equal(terrain.height(cx, cz), ev.floor);
  // Step across the far edge in 5 cm steps: no jump bigger than a few cm.
  const [a, b] = [ev.poly.find(([, z]) => z > 150), ev.poly.filter(([, z]) => z > 150)[1]];
  const mx = (a[0] + b[0]) / 2, mz = a[1];
  let prev = terrain.height(mx, mz - 1);
  for (let z = mz - 1; z < mz + 1; z += 0.05) { const h = terrain.height(mx, z); assert.ok(Math.abs(h - prev) < 0.05); prev = h; }
  for (let k = 0; k < 64; k++) {
    const r = TERRAIN_REACH * (k + 1) / 64, t = k * 2.4;
    const h = terrain.height(terrain.center[0] + Math.cos(t) * r, terrain.center[1] + Math.sin(t) * r);
    assert.ok(Number.isFinite(h));
  }
});

test('terrain: the ground drops away with the sphere, and far ridges taper to nothing before the edge', () => {
  const [cx, cz] = terrain.center;
  // Averaged round a ring, the far ground sits near the sphere (relief is zero-mean apart from craters).
  const ring = (r) => { let s = 0; for (let k = 0; k < 360; k++) s += terrain.height(cx + Math.cos(k * DEG) * r, cz + Math.sin(k * DEG) * r); return s / 360; };
  assert.ok(ring(1990) < -150 && ring(1990) > -215, `ring at 1.99 km: ${ring(1990)}`);
  assert.ok(ring(400) < -2 && ring(400) > -20, `ring at 400 m: ${ring(400)}`);
  // Nothing at the mesh edge rises above the line of sight from a 2 m eye at the base (it would show a cut).
  for (let k = 0; k < 720; k++) {
    const t = k * 0.5 * DEG, r = TERRAIN_REACH;
    const h = terrain.height(cx + Math.cos(t) * r, cz + Math.sin(t) * r);
    const sight = 2 - (r - horizonDistance(2)) ** 2 / (2 * 11000) - curvatureDrop(horizonDistance(2));
    assert.ok(h < sight + 1, `edge pokes above the horizon at ${k / 2}°: ${h} vs ${sight}`);
  }
});

test('boulders sit in the ground, off the base, and near ones are inside the shadow box', () => {
  const b = terrain.bounds;
  const box = { x0: b.x0 - 15, z0: b.z0 - 15, x1: b.x1 + 15, z1: b.z1 + 15 };
  const rocks = scatterBoulders(terrain, makeRng(1).fork('boulders'), box);
  assert.ok(rocks.length > 200);
  for (const r of rocks) {
    assert.ok(Math.abs(r.y - (terrain.height(r.x, r.z) - r.size * 0.2)) < 1e-9, 'sunk a fifth of its size');
    assert.ok(!terrain.inFootprint(r.x, r.z), 'not on the base');
    const inBox = r.x >= box.x0 && r.x <= box.x1 && r.z >= box.z0 && r.z <= box.z1;
    assert.equal(r.near, inBox);
    assert.equal(r.model === 'lo', !r.near);
  }
});

test('the plan is deterministic per seed', () => {
  const t2 = makeTerrain(level, makeRng(1).fork('terrain'), mars.flat);
  for (const [x, z] of [[0, 300], [500, -200], [-800, 900]]) assert.equal(t2.height(x, z), terrain.height(x, z));
  const t3 = makeTerrain(level, makeRng(2).fork('terrain'), mars.flat);
  assert.notEqual(t3.height(500, -200), terrain.height(500, -200));
});

test('the courtyard views look up at Mars (Ruling R21)', () => {
  const az = Math.atan2(mars.flat[1], mars.flat[0]);
  for (const id of ['yard-sky', 'yard-pool', 'yard-platform']) {
    const p = level.pois.find((q) => q.id === id);
    const a = Math.atan2(p.look[2] - p.z, p.look[0] - p.x);
    const d = Math.abs(((a - az) / DEG + 540) % 360 - 180);
    assert.ok(d < 20, `${id} looks ${d.toFixed(1)}° off Mars's azimuth`);
    const eye = level.byId.get([...level.sectors].find((s) => insidePoly(s.poly, p.x, p.z)).id).floor + 1.7;
    const pitch = Math.atan2(p.look[1] - eye, Math.hypot(p.look[0] - p.x, p.look[2] - p.z)) / DEG;
    assert.ok(pitch > 10 && pitch < 35, `${id} pitch ${pitch.toFixed(1)}°`);
  }
});

test('sunlit sectors: open sectors, sills and rooms with windows, never corridors or the tunnel (Ruling R22)', () => {
  const lit = sunlitSectors(level);
  for (const s of level.sectors) if (s.tags.has('sky') || s.tags.has('window')) assert.ok(lit.has(s.id), s.id);
  for (const id of ['comp-main', 'start-main', 'armor-alcove', 'exit-room']) assert.ok(lit.has(id), id);
  for (const id of ['cor-w', 'hall-b', 'tunnel-sq', 'dark-room', 'exit-lift']) assert.ok(!lit.has(id), id);
});

// ---- the real ground (LROC NAC terrain model of the Apollo 16 site) ----
const groundBuf = readFileSync(new URL('../html/data/ground.bin', import.meta.url));
const ground = decodeGround(groundBuf.buffer.slice(groundBuf.byteOffset, groundBuf.byteOffset + groundBuf.byteLength));
const real = makeTerrain(level, makeRng(1).fork('terrain'), mars.flat, ground);

test('ground: decodes the 2 m height grid, 4096 m a side, in metres with the tilt removed', () => {
  assert.equal(ground.n, GROUND_N);
  assert.equal(ground.size, GROUND_N * GROUND_STEP);
  let s = 0, lo = Infinity, hi = -Infinity;
  for (const v of ground.h) { s += v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(Math.abs(s / ground.h.length) < 1, `mean ${s / ground.h.length}`);
  assert.ok(hi - lo > 30 && hi - lo < 300, `range ${lo} .. ${hi}`);
});

test('ground: the terrain wears the real heights (no made-up craters), turned by the seed', () => {
  assert.equal(real.craters.length, 0);
  assert.ok(real.ground && Number.isFinite(real.ground.angle));
  const [cx, cz] = real.center;
  // 300 m out the ground is the scan's, plus only the grooves, the sphere and nothing else that varies on a
  // 2 m scale: neighbouring posts differ the way the scan's do.
  let rough = 0;
  for (let k = 0; k < 200; k++) {
    const a = k * 1.7, x = cx + Math.cos(a) * 300, z = cz + Math.sin(a) * 300;
    rough += Math.abs(real.height(x + 2, z) - real.height(x, z));
  }
  assert.ok(rough / 200 > 0.05, `mean 2 m step ${rough / 200}`);
  // The local frame: a point's scan coordinates rotate with the seed's angle.
  const { u, v } = real.ground.uv(cx + 100, cz);
  assert.ok(Math.abs(Math.hypot(u - 0.5, v - 0.5) * ground.size - 100) < 1e-6);
  const other = makeTerrain(level, makeRng(5).fork('terrain'), mars.flat, ground);
  assert.notEqual(other.ground.angle, real.ground.angle);
});

test('ground: flat pad by the walls, exterior floors exact, and the relief weight says where the scan shows', () => {
  for (const s of real.exteriors) {
    const [x, z] = s.poly.reduce(([a, b], [px, pz]) => [a + px / s.poly.length, b + pz / s.poly.length], [0, 0]);
    if (!insidePoly(s.poly, x, z)) continue;
    assert.equal(real.height(x, z), s.floor);
    assert.equal(real.reliefWeight(x, z), 0);
  }
  const [cx, cz] = real.center;
  const far = [cx + real.halfDiag + 200, cz];
  assert.ok(real.reliefWeight(...far) > 0.99);
  // Where the weight is 1, the height is the base shape plus the scan's height exactly.
  const g = real.ground.height(...far);
  assert.ok(Math.abs(real.height(...far) - (real.baseHeight(...far) + g)) < 1e-9);
});

test('ground: still drops away with the sphere and never pokes above the horizon at the edge', () => {
  const [cx, cz] = real.center;
  const ring = (r) => { let s = 0; for (let k = 0; k < 360; k++) s += real.height(cx + Math.cos(k * DEG) * r, cz + Math.sin(k * DEG) * r); return s / 360; };
  assert.ok(ring(1990) < -150 && ring(1990) > -215, `ring at 1.99 km: ${ring(1990)}`);
  for (let k = 0; k < 720; k++) {
    const t = k * 0.5 * DEG, r = TERRAIN_REACH;
    const h = real.height(cx + Math.cos(t) * r, cz + Math.sin(t) * r);
    const sight = 2 - (r - horizonDistance(2)) ** 2 / (2 * 11000) - curvatureDrop(horizonDistance(2));
    assert.ok(h < sight + 1, `edge pokes above the horizon at ${k / 2}°: ${h} vs ${sight}`);
  }
});

// ---- the real sky ----
test('sky orientation: a proper rotation that puts the galactic centre beside Mars, away from the sun', () => {
  for (const side of [1, -1]) {
    const sun = sunDirection(mars.flat, side);
    const Q = skyOrientation(mars.dir, sun);
    const col = (i) => [Q[i], Q[3 + i], Q[6 + i]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(dot(col(i), col(j)) - (i === j ? 1 : 0)) < 1e-9);
    const det = Q[0] * (Q[4] * Q[8] - Q[5] * Q[7]) - Q[1] * (Q[3] * Q[8] - Q[5] * Q[6]) + Q[2] * (Q[3] * Q[7] - Q[4] * Q[6]);
    assert.ok(Math.abs(det - 1) < 1e-9, `det ${det}`);
    const gc = applySky(Q, GALACTIC_CENTER);
    const el = Math.asin(gc[1]) / DEG;
    assert.ok(Math.abs(el - MILKY_WAY.elevation) < 1e-6, `GC elevation ${el}`);
    const az = (v) => Math.atan2(v[2], v[0]);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const fromMars = wrap(az(gc) - az(mars.dir)) / DEG, sunFromMars = wrap(az(sun) - az(mars.dir)) / DEG;
    assert.ok(Math.abs(Math.abs(fromMars) - MILKY_WAY.fromMars) < 1e-6, `GC ${fromMars}° from Mars`);
    assert.ok(Math.sign(fromMars) !== Math.sign(sunFromMars), 'GC on the side away from the sun');
    // Clear of Mars's disc (21° radius) and its glare.
    assert.ok(Math.acos(dot(gc, mars.dir)) / DEG > 30);
  }
});

test('stars: the catalogue decodes to unit directions, magnitudes brightest first, and colours', () => {
  const buf = readFileSync(new URL('../html/data/stars.bin', import.meta.url));
  const s = decodeStars(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.ok(s.count > 100000, `${s.count} stars`);
  for (let i = 0; i < s.count; i += 997) {
    const l = Math.hypot(s.dir[i * 3], s.dir[i * 3 + 1], s.dir[i * 3 + 2]);
    assert.ok(Math.abs(l - 1) < 1e-3);
  }
  assert.ok(s.mag[0] < -1 && s.mag[0] > -1.6, `Sirius ${s.mag[0]}`); // Sirius, V -1.46
  for (let i = 1; i < s.count; i += 101) assert.ok(s.mag[i] >= s.mag[i - 1]);
  assert.ok(s.color.every((c) => c >= 0 && c <= 1));
});
