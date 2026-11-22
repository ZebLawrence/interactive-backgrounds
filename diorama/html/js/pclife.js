// Diorama — what goes on inside the computer when nobody is doing anything to it.
//
// Always there:
//   Dust         motes drifting on the fans' air from the front intake to the rear, lit by whichever lamps
//                they pass. They hang at every depth of the chamber, which is what a moving head reads best.
//   The display  the motherboard's two-digit debug display, showing the processor's temperature.
//   The light    the drive-activity light, flickering as a drive's does.
//
// Now and then (each on its own random timer; trigger() starts one by name):
//   crawl        a black widow comes out of the lower cable grommet, walks about the tray, and goes back in
//   descend      she lets herself down on a thread just behind the glass, hangs there, and climbs back up
//   eyes         something in the grommet opens its eyes and watches the viewer's head
//   sag          the power sags: the lights stutter and go out, the fans coast down, and it all comes back
//   code         the debug display stops showing a temperature and says something else
//   morse        the drive light stops flickering and starts spelling
//
// The head is the cursor here, so the three verbs are the head's: move fast and the spider freezes and the
// eyes shut; lean in close and the eyes will not open; click (a knock on the glass) and whatever is out bolts.
//
// Everything is in the chamber's design metres, under the skin's scaled root.

import * as THREE from 'three';

const MM = 0.001, TAU = Math.PI * 2;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------------------------------------

// Every rate is a whole number of cycles an hour, so the hourly wrap of `time` cannot be seen.
const DUST_VERT = /* glsl */ `
uniform float time;      // seconds, wrapped hourly
uniform vec3 box;        // the chamber
uniform float size;      // a mote's width, world metres
uniform float eps;       // softens the inverse square near a lamp
uniform vec3 lampPos[4]; // world
uniform vec3 lampCol[4]; // colour x candela
uniform vec3 ambient;
attribute vec4 seed;
attribute vec4 rate;
varying vec2 vQ;
varying vec3 vLight;
void main() {
  float ph = time / 3600.0;
  vec3 p = seed.xyz;
  p.x = fract( p.x - ph * rate.x ); // front intake to rear exhaust
  p.y = fract( p.y + ph * rate.y ); // and slowly up, toward the top fans
  vec3 w = vec3( sin( 6.2831853 * ( ph * rate.z + seed.w ) ), sin( 6.2831853 * ( ph * rate.w + seed.w * 3.7 ) ), cos( 6.2831853 * ( ph * rate.w + seed.w * 1.3 ) ) );
  float edge = smoothstep( 0.0, 0.07, p.x ) * smoothstep( 1.0, 0.93, p.x ) * smoothstep( 0.0, 0.07, p.y ) * smoothstep( 1.0, 0.93, p.y );
  vec4 world = modelMatrix * vec4( p * box + w * 0.007, 1.0 );
  vec3 light = ambient;
  for ( int i = 0; i < 4; i++ ) { vec3 d = lampPos[ i ] - world.xyz; light += lampCol[ i ] / ( dot( d, d ) + eps ); }
  vec4 mv = viewMatrix * world;
  mv.xy += position.xy * size * ( 0.5 + seed.w );
  gl_Position = projectionMatrix * mv;
  vQ = position.xy * 2.0;
  vLight = light * edge * ( 0.4 + 0.6 * fract( seed.w * 7.3 ) );
}
`;
const DUST_FRAG = /* glsl */ `
varying vec2 vQ;
varying vec3 vLight;
void main() {
  float a = smoothstep( 1.0, 0.15, length( vQ ) );
  gl_FragColor = vec4( vLight * a, 1.0 );
}
`;

export function makeDust(L, count, s) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const seed = new Float32Array(count * 4), rate = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = Math.random();
    rate.set([Math.round(rnd(18, 70)), Math.round(rnd(-6, 26)), Math.round(rnd(240, 800)), Math.round(rnd(240, 800))], i * 4);
  }
  geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.setAttribute('rate', new THREE.InstancedBufferAttribute(rate, 4));
  geo.instanceCount = count;
  const uniforms = {
    time: { value: 0 }, box: { value: new THREE.Vector3(L.w, L.h, L.d) }, size: { value: 0.00078 * s }, eps: { value: (0.035 * s) ** 2 },
    lampPos: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) }, lampCol: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    ambient: { value: new THREE.Vector3() },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return { mesh, uniforms, dispose() { geo.dispose(); quad.dispose(); material.dispose(); } };
}

// ---------------------------------------------------------------------------------------------------------
// The spider
// ---------------------------------------------------------------------------------------------------------

// A female black widow, near enough: a globe of an abdomen about 8 mm across, a small head end, long thin
// legs with the first and last pairs the longest, and the red hourglass underneath, which is the side she
// shows when she hangs. Per side, front to back: where the leg joins, the angle it rests at from straight
// ahead, how far out the foot rests, and the two segments' lengths.
const LEGS = [
  { hy: 1.4, ang: 28, reach: 15, a: 9, b: 11 },
  { hy: 0.5, ang: 64, reach: 11.5, a: 7, b: 8.5 },
  { hy: -0.4, ang: 110, reach: 10.5, a: 6.5, b: 8 },
  { hy: -1.3, ang: 152, reach: 15, a: 9, b: 11 },
];
const CLEAR = 3.2 * MM;   // how high she carries her body
const STRIDE = 9 * MM;
const SINK = 15 * MM;     // how far under the surface she is while still inside the grommet
const UP = new THREE.Vector3(0, 1, 0);

class Spider {
  constructor(skin, mark) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.geos = [];
    const own = (g) => { this.geos.push(g); return g; };
    const ball = own(new THREE.SphereGeometry(1, 24, 16));
    const part = (geo, mat, sx, sy, sz, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); this.group.add(m); return m; };
    part(ball, skin, 1.9 * MM, 2.4 * MM, 1.4 * MM, 0, 0, CLEAR);
    part(ball, skin, 3.6 * MM, 4.3 * MM, 3.6 * MM, 0, -5.8 * MM, CLEAR + 1 * MM);
    const glass = new THREE.Shape();
    [[-0.8, 1.15], [0.8, 1.15], [0.16, 0], [0.8, -1.15], [-0.8, -1.15], [-0.16, 0]].forEach(([x, y], i) => (i ? glass.lineTo(x * MM, y * MM) : glass.moveTo(x * MM, y * MM)));
    part(own(new THREE.ShapeGeometry(glass).rotateX(Math.PI)), mark, 1, 1, 1, 0, -5.8 * MM, CLEAR + 1 * MM - 3.63 * MM);
    const femur = own(new THREE.CylinderGeometry(0.2 * MM, 0.3 * MM, 1, 6).translate(0, 0.5, 0));
    const tibia = own(new THREE.CylinderGeometry(0.07 * MM, 0.2 * MM, 1, 6).translate(0, 0.5, 0));
    this.legs = [];
    for (const side of [-1, 1]) LEGS.forEach((l, i) => {
      const a = l.ang * Math.PI / 180;
      const leg = {
        index: i, side, a: l.a * MM, b: l.b * MM, group: (i + (side > 0 ? 1 : 0)) % 2,
        hip: new THREE.Vector3(side * 1.5 * MM, l.hy * MM, CLEAR),
        rest: new THREE.Vector2(side * Math.sin(a) * l.reach * MM, Math.cos(a) * l.reach * MM),
        foot: new THREE.Vector3(), lift: 0, swing: null,
        femur: new THREE.Mesh(femur, skin), tibia: new THREE.Mesh(tibia, skin),
      };
      this.group.add(leg.femur, leg.tibia);
      this.legs.push(leg);
    });
    this.u = 0; this.v = 0; this.theta = 0; this.sink = 0; this.tuck = 1; this.base = 0; this.travel = 0;
    this.f = new THREE.Vector3(); this.knee = new THREE.Vector3(); this.dir = new THREE.Vector3(); this.rp = new THREE.Vector2();
  }

  /** One leg from its hip to a foot, both in the body's frame: two bones, the knee uppermost. */
  placeLeg(leg, f) {
    const h = leg.hip, dx = f.x - h.x, dy = f.y - h.y, dz = f.z - h.z;
    const dh = Math.hypot(dx, dy) || 1e-6, d = clamp(Math.hypot(dh, dz), Math.abs(leg.a - leg.b) + 1e-5, leg.a + leg.b - 1e-5);
    const lift = Math.atan2(dz, dh) + Math.acos(clamp((leg.a * leg.a + d * d - leg.b * leg.b) / (2 * leg.a * d), -1, 1));
    const c = Math.cos(lift) * leg.a / dh;
    this.knee.set(h.x + dx * c, h.y + dy * c, h.z + Math.sin(lift) * leg.a);
    leg.femur.position.copy(h);
    leg.femur.quaternion.setFromUnitVectors(UP, this.dir.subVectors(this.knee, h).normalize());
    leg.femur.scale.set(1, leg.a, 1);
    this.dir.subVectors(f, this.knee);
    const len = this.dir.length() || 1e-6;
    leg.tibia.position.copy(this.knee);
    leg.tibia.quaternion.setFromUnitVectors(UP, this.dir.divideScalar(len));
    leg.tibia.scale.set(1, len, 1);
  }

  /** Where a leg's foot wants to be on the surface, `lead` ahead of its resting place. */
  restPoint(leg, lead) {
    const c = Math.cos(this.theta), s = Math.sin(this.theta), rx = leg.rest.x * this.tuck, ry = leg.rest.y * this.tuck + lead;
    return this.rp.set(this.u + rx * s + ry * c, this.v - rx * c + ry * s);
  }

  /** Stand her at (u, v) on the surface, facing theta, every foot at rest. */
  plant(u, v, theta, height) {
    this.u = u; this.v = v; this.theta = theta; this.travel = 0;
    for (const leg of this.legs) { const r = this.restPoint(leg, 0); leg.foot.set(r.x, r.y, 0); leg.swing = null; leg.lift = 0; }
    this.base = height(u, v);
    this.group.visible = true;
  }

  turnToward(u, v, dt, rate = 5) {
    let d = Math.atan2(v - this.v, u - this.u) - this.theta;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.theta += clamp(d, -rate * dt, rate * dt);
    return Math.abs(d);
  }

  /** Walk forward at `speed` for dt. Feet stay where they are planted until they are left behind; then they step, four at a time. */
  walk(dt, speed, height) {
    const c = Math.cos(this.theta), s = Math.sin(this.theta);
    this.u += c * speed * dt; this.v += s * speed * dt; this.travel += speed * dt;
    const turn = Math.floor(this.travel / (STRIDE / 2)) % 2;
    let sum = 0;
    for (const leg of this.legs) {
      const r = this.restPoint(leg, speed > 0 ? STRIDE * 0.45 : 0);
      if (leg.swing) {
        const w = leg.swing;
        w.t += dt / w.dur;
        const k = smooth(w.t);
        leg.foot.x = w.x + (r.x - w.x) * k; leg.foot.y = w.y + (r.y - w.y) * k;
        leg.lift = Math.sin(Math.PI * Math.min(1, w.t)) * 2.5 * MM;
        if (w.t >= 1) { leg.swing = null; leg.lift = 0; }
      } else {
        const d = Math.hypot(leg.foot.x - r.x, leg.foot.y - r.y);
        if ((d > STRIDE * 0.8 && leg.group === turn) || d > STRIDE * 1.7) leg.swing = { t: 0, x: leg.foot.x, y: leg.foot.y, dur: clamp(STRIDE * 0.5 / Math.max(speed, 0.01), 0.05, 0.18) };
      }
      const ground = height(leg.foot.x, leg.foot.y);
      leg.foot.z = ground + leg.lift - this.sink * SINK;
      sum += ground;
    }
    this.base += (sum / 8 - this.base) * Math.min(1, dt * 12);
    const z = this.base - this.sink * SINK;
    this.group.position.set(this.u, this.v, z);
    this.group.rotation.set(0, 0, this.theta - Math.PI / 2);
    for (const leg of this.legs) {
      const dx = leg.foot.x - this.u, dy = leg.foot.y - this.v;
      this.placeLeg(leg, this.f.set(dx * s - dy * c, dx * c + dy * s, leg.foot.z - z));
    }
  }

  /** Hanging head-down at (x, y, z), her underside to the glass, turned by `twist` about the thread. `curl` 0..1 draws the legs in. */
  hang(x, y, z, twist, t, curl) {
    this.group.visible = true;
    this.group.position.set(x, y, z);
    this.group.rotation.set(Math.PI, 0, 0);
    this.group.quaternion.premultiply(Q.setFromAxisAngle(UP, twist));
    for (const leg of this.legs) {
      if (leg.index === 3) { this.placeLeg(leg, this.f.set(leg.side * 0.5 * MM, -11.5 * MM, CLEAR + 1 * MM)); continue; } // the last pair hold the thread
      const k = (0.66 + 0.09 * Math.sin(t * 1.1 + leg.index * 1.7 + leg.side)) * (1 - 0.4 * curl);
      this.placeLeg(leg, this.f.set(leg.rest.x * k, leg.rest.y * k + 1 * MM, CLEAR - (1 + 3 * curl) * MM));
    }
  }

  /** Where the thread leaves her, in the parent's frame. */
  spinneret(out) { return out.set(0, -10.1 * MM, CLEAR + 1 * MM).applyQuaternion(this.group.quaternion).add(this.group.position); }

  dispose() { for (const g of this.geos) g.dispose(); }
}
const Q = new THREE.Quaternion();

// ---------------------------------------------------------------------------------------------------------
// The debug display and the drive light
// ---------------------------------------------------------------------------------------------------------

// Seven segments, a to g, for every character the display is asked for.
const SEG = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  A: 'abcefg', b: 'cdefg', C: 'adef', d: 'bcdeg', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', P: 'abefg', U: 'bcdef',
  r: 'eg', n: 'ceg', o: 'cdeg', '-': 'g', ' ': '',
};

class Display {
  constructor(w, h) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 264; this.canvas.height = Math.round(264 * h / w);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    // Brighter than white where a segment is lit, so it glows as an LED does.
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, color: new THREE.Color(2.4, 2.4, 2.4) });
    this.text = null;
    this.show('  ');
  }

  show(text) {
    if (text === this.text) return;
    this.text = text;
    const c = this.canvas, g = c.getContext('2d'), W = c.width, H = c.height;
    g.fillStyle = '#060303'; g.fillRect(0, 0, W, H);
    const dw = W * 0.3, dh = H * 0.7, t = dw * 0.17, y0 = (H - dh) / 2;
    [...text.padEnd(2)].slice(0, 2).forEach((ch, i) => {
      const x0 = W * (i ? 0.56 : 0.14), lit = SEG[ch] ?? '';
      g.save();
      g.transform(1, 0, -0.08, 1, x0 + dh * 0.04, y0); // the lean every seven-segment digit has
      const bar = (id, x, y, w, h) => { g.fillStyle = lit.includes(id) ? '#ff2a1c' : '#1c0606'; g.beginPath(); g.roundRect(x, y, w, h, t * 0.45); g.fill(); };
      const v = dh / 2 - t * 1.25;
      bar('a', t, 0, dw - 2 * t, t); bar('g', t, dh / 2 - t / 2, dw - 2 * t, t); bar('d', t, dh - t, dw - 2 * t, t);
      bar('f', 0, t * 0.8, t, v); bar('b', dw - t, t * 0.8, t, v);
      bar('e', 0, dh / 2 + t * 0.45, t, v); bar('c', dw - t, dh / 2 + t * 0.45, t, v);
      g.restore();
    });
    this.texture.needsUpdate = true;
  }

  dispose() { this.texture.dispose(); this.material.dispose(); }
}

const MORSE = { A: '.-', D: '-..', E: '.', H: '....', I: '..', L: '.-..', O: '---', P: '.--.', S: '...', U: '..-', Y: '-.--' };
/** A message as [on, seconds] steps: a dot is one unit, a dash three, with the standard gaps. */
function morse(message, unit = 0.13) {
  const out = [[false, unit * 10]];
  for (const word of message.split(' ')) {
    for (const ch of word) {
      for (const mark of MORSE[ch]) out.push([true, unit * (mark === '-' ? 3 : 1)], [false, unit]);
      out[out.length - 1][1] = unit * 3;
    }
    out[out.length - 1][1] = unit * 7;
  }
  out[out.length - 1][1] = unit * 12;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// All of it together
// ---------------------------------------------------------------------------------------------------------

const EVENTS = {
  // name: [first appearance (s), then every (s)]
  crawl: [[25, 70], [100, 260]],
  eyes: [[50, 120], [110, 280]],
  descend: [[80, 170], [160, 420]],
  code: [[40, 100], [130, 320]],
  morse: [[30, 90], [100, 220]],
  sag: [[130, 280], [260, 560]],
};
const CREATURES = ['crawl', 'eyes', 'descend'];
const CODES = [['HE', 'LP'], ['HE', 'LP'], ['dE', 'Ad'], ['rU', 'n '], ['bE', 'EF']];
const MESSAGES = ['SOS', 'I SEE YOU', 'HELP'];
const BOOT = ['15', '19', '2b', '34', '4F', '55', '62', '99', 'A2', 'b4', 'AA'];

export class Life {
  /**
   * `root` is the skin's scaled group, `L` the chamber, `parts` what buildComputer returned, `std` the skin's
   * material maker (so these are lit like everything else), `layer` the layer the light probes do not draw.
   */
  constructor({ root, L, s, parts, std, layer, lowPower = false }) {
    this.root = root; this.L = L; this.parts = parts;
    this.disposables = [];
    const add = (mesh, on = layer) => { mesh.layers.set(on); root.add(mesh); return mesh; };

    this.dust = makeDust(L, lowPower ? 250 : 520, s);
    add(this.dust.mesh);

    const chitin = std({ color: 0x0a0909, roughness: 0.3 });
    this.spider = new Spider(chitin, std({ color: 0xc2160f, roughness: 0.4 }));
    this.spider.group.traverse((o) => o.layers.set(layer));
    root.add(this.spider.group);
    const threadGeo = new THREE.CylinderGeometry(0.05 * MM, 0.05 * MM, 1, 5).translate(0, 0.5, 0);
    this.thread = add(new THREE.Mesh(threadGeo, std({ color: 0xd4d8dc, roughness: 0.25 })));
    this.thread.visible = false;
    this.disposables.push(threadGeo);

    // The hole things come out of: the lower grommet, which no cable uses.
    const [gx, gy] = parts.grommets[1];
    this.hole = { x: gx, y: gy, mouth: gy + 0.012 };
    /** The height of the tray, and of what lies on it, under a point. */
    this.height = (x, y) => {
      for (const d of parts.ssds ?? []) if (Math.abs(x - d.x) < d.w / 2 && Math.abs(y - d.y) < d.h / 2) return d.top;
      for (const [hx, hy] of parts.grommets) if (Math.abs(x - hx) < 0.012 && Math.abs(y - hy) < 0.039) return 0.0037;
      return 0;
    };

    // Eyes: two discs with slit pupils, in the mouth of the grommet.
    const disc = new THREE.CircleGeometry(1.15 * MM, 24), slit = new THREE.PlaneGeometry(0.3 * MM, 1.9 * MM);
    this.eyeGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 0.95, 0.1) });
    const dark = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.disposables.push(disc, slit, this.eyeGlow, dark);
    this.eyes = new THREE.Group();
    this.pupils = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(disc, this.eyeGlow), pupil = new THREE.Mesh(slit, dark);
      eye.position.x = side * 3.3 * MM; pupil.position.z = 0.02 * MM;
      eye.add(pupil); this.eyes.add(eye); this.pupils.push(pupil);
    }
    this.eyes.position.set(gx, gy + 0.02, 0.0041);
    this.eyes.traverse((o) => o.layers.set(layer));
    this.eyes.visible = false;
    root.add(this.eyes);
    this.open = 0;

    // The debug display and the drive light.
    this.display = new Display(parts.display.w, parts.display.h);
    const face = new THREE.PlaneGeometry(parts.display.w, parts.display.h);
    add(new THREE.Mesh(face, this.display.material)).position.set(...parts.display.pos);
    const bulb = new THREE.BoxGeometry(0.0018, 0.0009, 0.0008);
    this.lamp = new THREE.MeshBasicMaterial({ color: 0x000000 });
    add(new THREE.Mesh(bulb, this.lamp)).position.set(...parts.activity);
    this.disposables.push(face, bulb, this.lamp);
    this.temp = 41; this.queue = []; this.showFor = 0;
    this.blink = { on: false, left: 1, queue: [] };

    // What the skin reads back each frame.
    this.power = 1;      // every light's level, 0..1
    this.key = 1;        // the case strip's own stutter, on top of that
    this.fan = 1;        // the fans' speed
    this.rush = false;   // set when the light has changed enough that the bounce should be remeasured at once
    this.sag = null; this.flicker = { left: 0, hold: 0, level: 1, next: rnd(15, 40) };
    this.act = null;
    this.due = Object.fromEntries(Object.entries(EVENTS).map(([k, [first]]) => [k, rnd(...first)]));
    this.cycle = 0;
    this.p = new THREE.Vector3();
  }

  // MARK: - Starting things

  /** Starts an event by name, or the next one in turn; returns the name of what started, or null if it could not. */
  trigger(name) {
    const names = Object.keys(EVENTS);
    name ??= names[this.cycle++ % names.length];
    if (!(name in EVENTS)) return null;
    if (CREATURES.includes(name)) { this.endAct(); if (name === 'eyes') this.eyesOpen(); else this[name](); }
    else if (name === 'sag') this.sag = { t: 0, eyes: !this.act && Math.random() < 0.4 };
    else if (name === 'code') {
      const words = pick(CODES);
      this.queue = [['  ', 0.5], ...[0, 1].flatMap(() => [[words[0], 0.9], [words[1], 0.9], ['  ', 0.35]])];
      this.showFor = 0;
    } else if (name === 'morse') this.blink.queue = morse(pick(MESSAGES));
    this.due[name] = rnd(...EVENTS[name][1]);
    return name;
  }

  crawl() {
    const { x, y, mouth } = this.hole, sp = this.spider;
    sp.sink = 1; sp.tuck = 0.45;
    sp.plant(x, mouth, Math.PI / 2, this.height);
    const pts = [[x, y + 0.05]];
    for (let i = Math.round(rnd(2, 4)); i > 0; i--) pts.push([x + rnd(-0.014, 0.02), y + rnd(0.052, 0.086)]);
    // She is black and so is the tray: a walk over a drive's pale label is where she shows best.
    const drive = this.parts.ssds?.length ? pick(this.parts.ssds) : null;
    if (drive) pts.push([x + 0.024, y + 0.082], [drive.x - rnd(0.004, 0.02), drive.y + rnd(-0.01, 0.03)], [x + 0.024, y + rnd(0.06, 0.082)]);
    pts.push([x, y + 0.05], [x, mouth]);
    this.act = { kind: 'crawl', pts, i: 0, pause: 0, burst: rnd(0.6, 1.4), freeze: 0, bolt: false };
  }

  descend() {
    const L = this.L, drive = this.parts.ssds?.[0];
    // In front of something bright, or she is a black thing in the dark: the memory's light bars, mostly.
    const x = drive && Math.random() < 0.3 ? drive.x + rnd(-0.02, 0.02) : this.parts.lamps.ram[0] + rnd(-0.016, 0.022);
    this.act = {
      kind: 'descend', x, z: L.d - 0.025, y: L.h + 0.02, stop: rnd(0.15, 0.215),
      phase: 'down', pause: 0, burst: rnd(0.6, 1.4), stay: rnd(8, 14), t: rnd(0, 20), curl: 0, freeze: 0, bolt: false,
    };
  }

  eyesOpen(seconds) { this.act = { kind: 'eyes', left: seconds ?? rnd(14, 26), blink: rnd(1.5, 4), shut: 0.4 }; }

  endAct() {
    this.act = null;
    this.spider.group.visible = false; this.thread.visible = false;
    this.spider.sink = 0; this.spider.tuck = 1;
  }

  /** A knock on the glass: whatever is out goes back where it came from, and the case's strip stutters. */
  knock() {
    const a = this.act;
    if (a?.kind === 'crawl' && !a.bolt) { a.bolt = true; a.pts = [[this.hole.x, this.hole.y + 0.05], [this.hole.x, this.hole.mouth]]; a.i = this.spider.v < this.hole.y + 0.05 && Math.abs(this.spider.u - this.hole.x) < 0.01 ? 1 : 0; }
    else if (a?.kind === 'descend') { a.phase = 'up'; a.bolt = true; }
    else if (a?.kind === 'eyes') a.left = 0;
    this.flicker.left = 0.45;
  }

  // MARK: - Every frame

  /**
   * `view`: { eye: the viewer's eye in the chamber's design metres, distance: metres from the glass,
   * speed: how fast the head is moving, m/s }.
   */
  step(dt, time, view) {
    this.rush = false;
    const fast = view.speed > 0.6;

    for (const name of Object.keys(EVENTS)) {
      this.due[name] -= dt;
      if (this.due[name] > 0) continue;
      if ((CREATURES.includes(name) && this.act) || this.sag) { this.due[name] = 12; continue; } // busy; try again shortly
      this.trigger(name);
    }

    this.stepPower(dt);
    this.stepPanel(dt);
    const a = this.act;
    if (a?.kind === 'crawl') this.stepCrawl(a, dt, fast);
    else if (a?.kind === 'descend') this.stepDescend(a, dt, fast);
    this.stepEyes(a?.kind === 'eyes' ? a : null, dt, fast, view);
    this.dust.uniforms.time.value = time % 3600;
  }

  stepCrawl(a, dt, fast) {
    const sp = this.spider, { x, mouth } = this.hole;
    const [tu, tv] = a.pts[a.i];
    // Inside the grommet she is under the surface with her legs drawn in; she rises as she leaves it.
    const out = Math.abs(sp.u - x) < 0.009 ? smooth((sp.v - mouth) / 0.03) : 1;
    sp.sink = 1 - out; sp.tuck = 0.45 + 0.55 * out;
    if (fast && !a.bolt) a.freeze = 1.4;
    let speed = a.bolt ? 0.12 : out < 1 ? 0.02 : 0.032;
    if (!a.bolt) {
      if (a.freeze > 0) { a.freeze -= dt; speed = 0; }
      else if (a.pause > 0) { a.pause -= dt; speed = 0; }
      else if (out >= 1) { a.burst -= dt; if (a.burst <= 0) { a.pause = rnd(0.3, 1.5); a.burst = rnd(0.5, 1.5); } }
    }
    if (speed > 0 && sp.turnToward(tu, tv, dt, a.bolt ? 12 : 5) > 0.7) speed *= 0.15; // turn on the spot before setting off
    sp.walk(dt, speed, this.height);
    if (Math.hypot(tu - sp.u, tv - sp.v) < 0.003) {
      a.i++;
      if (a.i >= a.pts.length) this.endAct();
      else if (!a.bolt && a.i > 1 && a.i < a.pts.length - 1) a.pause = rnd(0.6, 2.6);
    }
  }

  stepDescend(a, dt, fast) {
    const sp = this.spider, top = this.L.h;
    if (fast && !a.bolt) a.freeze = 1.6;
    a.freeze -= dt;
    const still = a.freeze > 0 && !a.bolt;
    a.curl += ((still ? 1 : 0) - a.curl) * Math.min(1, dt * (still ? 14 : 2));
    if (!still) {
      a.t += dt;
      if (a.phase === 'down') {
        if (a.pause > 0) a.pause -= dt;
        else { a.y -= 0.035 * dt; a.burst -= dt; if (a.burst <= 0) { a.pause = rnd(0.6, 1.8); a.burst = rnd(0.5, 1.3); } }
        if (a.y <= a.stop) a.phase = 'hang';
      } else if (a.phase === 'hang') { a.stay -= dt; if (a.stay <= 0) a.phase = 'up'; }
      else { a.y += (a.bolt ? 0.2 : 0.022) * dt; if (a.y > top + 0.02) { this.endAct(); return; } }
    }
    const twist = 0.7 * Math.sin(a.t * 0.45) + 0.2 * Math.sin(a.t * 1.3);
    sp.hang(a.x + 0.0015 * Math.sin(a.t * 1.7), a.y, a.z + 0.001 * Math.sin(a.t * 1.3), twist, a.t, a.curl);
    const p = sp.spinneret(this.p);
    this.thread.visible = p.y < top;
    this.thread.position.copy(p);
    this.thread.scale.set(1, Math.max(1e-4, top - p.y), 1);
  }

  stepEyes(a, dt, fast, view) {
    let want = 0;
    if (a) {
      a.left -= dt; a.shut -= dt; a.blink -= dt;
      if (a.blink <= 0) { a.blink = rnd(1.8, 5.5); a.shut = 0.13; }
      if (fast) a.shut = 1.3;
      if (view.distance < 0.42) a.shut = 0.8; // too close: they will not open
      want = a.left > 0.3 && a.shut <= 0 ? 1 : 0;
      if (a.left <= 0 && this.open < 0.03) this.act = null;
    }
    this.open += (want - this.open) * Math.min(1, dt * 16);
    this.eyes.visible = this.open > 0.03;
    if (!this.eyes.visible) return;
    // They follow the head: the eyes a little, the pupils more.
    const e = this.eyes.position, dx = view.eye.x - e.x, dy = view.eye.y - e.y, d = Math.hypot(dx, dy, view.eye.z) || 1;
    const lx = dx / d, ly = dy / d;
    this.eyes.children.forEach((eye, i) => {
      eye.position.set((i ? 1 : -1) * 3.3 * MM + lx * 0.5 * MM, ly * 0.5 * MM, 0);
      eye.scale.set(1, Math.max(0.03, this.open), 1);
      this.pupils[i].position.x = lx * 0.6 * MM;
    });
    this.eyeGlow.color.setRGB(1.7, 0.95, 0.1).multiplyScalar(0.55 + 0.45 * this.open);
  }

  /** The power sag, and the case strip's occasional stutter. */
  stepPower(dt) {
    const f = this.flicker;
    f.next -= dt;
    if (f.next <= 0) { f.next = rnd(18, 55); f.left = rnd(0.25, 0.9); }
    if (f.left > 0) {
      f.left -= dt; f.hold -= dt;
      if (f.hold <= 0) { f.hold = rnd(0.03, 0.11); f.level = pick([0.15, 0.5, 1, 1, 1.5]); }
      this.key = f.level;
    } else this.key = 1;

    const g = this.sag;
    let fan = 1;
    if (g) {
      const before = g.t;
      g.t += dt;
      const crossed = (at) => before < at && g.t >= at;
      if (g.t < 1.5 || (g.t >= 3.9 && g.t < 4.5)) {
        g.hold = (g.hold ?? 0) - dt;
        if (g.hold <= 0) { g.hold = rnd(0.04, 0.13); g.level = pick(g.t < 1.5 ? [1, 0.6, 0.2, 0.05, 1] : [0.3, 1, 0.6, 1]); }
        this.power = g.level;
      } else this.power = g.t < 3.9 ? 0 : 1;
      fan = g.t < 3.9 ? 0.1 : g.t < 6.5 ? 1.7 : 1;
      if (crossed(1.5)) { this.rush = true; this.queue = [['  ', 2.4], ...BOOT.map((c) => [c, 0.17])]; this.showFor = 0; }
      if (crossed(1.9) && g.eyes && !this.act) this.eyesOpen(2.0);
      if (crossed(4.5)) this.rush = true;
      if (g.t > 9) this.sag = null;
    } else this.power = 1;
    this.fan += (fan - this.fan) * Math.min(1, dt / (fan < this.fan ? 1.1 : 0.8));
  }

  /** The debug display's reading and the drive light. */
  stepPanel(dt) {
    this.showFor -= dt;
    if (this.showFor <= 0) {
      if (this.queue.length) { const [text, seconds] = this.queue.shift(); this.display.show(text); this.showFor = seconds; }
      else {
        this.temp = clamp(this.temp + Math.round(rnd(-1.6, 1.6)), 37, 47);
        this.display.show(String(this.temp)); this.showFor = rnd(2.5, 6);
      }
    }
    this.display.material.color.setScalar(2.4 * (this.power > 0.5 ? 1 : 0.02));

    const b = this.blink;
    b.left -= dt;
    if (b.left <= 0) {
      if (b.queue.length) [b.on, b.left] = b.queue.shift();
      else { b.on = !b.on; b.busy = b.on ? b.busy : Math.random() < 0.8; b.left = b.on ? rnd(0.03, 0.12) : b.busy ? rnd(0.03, 0.12) : rnd(0.6, 3.5); }
    }
    const lit = b.on && this.power > 0.5 ? 1 : 0;
    this.lamp.color.setRGB(3.2 * lit + 0.05, 0.25 * lit, 0.1 * lit);
  }

  /** Lights the dust: up to four of the skin's lamps (three.js lights), and a little of everything else. */
  lightDust(lights, ambient) {
    const u = this.dust.uniforms;
    for (let i = 0; i < 4; i++) {
      const l = lights[i];
      if (!l) { u.lampCol.value[i].set(0, 0, 0); continue; }
      l.getWorldPosition(u.lampPos.value[i]);
      u.lampCol.value[i].set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity * 0.1);
    }
    u.ambient.value.copy(ambient);
  }

  dispose() {
    this.dust.dispose(); this.spider.dispose(); this.display.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
