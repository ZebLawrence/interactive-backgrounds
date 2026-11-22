// Diorama — the office, as geometry.
//
// Built in the room's own metres: x to the right from the left wall, y up from the floor, z from the back
// wall (0) toward the glass you look through (R.d). The skin scales it to a 1:10 miniature that fills the
// window. The room is a corner office: its back-left corner is cut off by a wall at 45 degrees with the door
// in it, so the door's frosted glass half-faces you. The back wall has the pinboard and the window; the desk
// stands in front of the window, the filing cabinets on the left, the bookcase and the safe on the right.
//
// buildRoom() is everything that never moves. buildNight() is what a given night adds or rearranges: the
// state of the desk, the drawers, the chair, the safe, the coat stand.

import * as THREE from 'three';
import { at, box, rbox, Batch } from './pcparts.js';
import { makeRand } from './pcboard.js';
import { PANE, BOARD_SIZE } from './noirprint.js';

const HALF_PI = Math.PI / 2, S2 = Math.SQRT1_2;
export const ROOM = { h: 3.0, d: 4.0, minW: 5.2, chamfer: 1.3 };

/** A cylinder standing along y. */
const cyl = (r, h, seg = 20, top = r) => new THREE.CylinderGeometry(top, r, h, seg);
const ball = (r, seg = 16) => new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));

/** Collects one object's pieces in its own frame, then places them all in a batch at once. */
class Kit {
  constructor() { this.list = []; }
  add(key, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { this.list.push([key, at(geo, x, y, z, rx, ry, rz)]); return this; }
  into(b, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { for (const [key, geo] of this.list) b.add(key, at(geo, x, y, z, rx, ry, rz)); }
}

/** Everything that depends on the room's width, worked out once. */
export function plan(R) {
  const C = ROOM.chamfer, wx1 = R.w - 0.55, wx0 = wx1 - 1.8;
  const p = {
    C, win: { x0: wx0, x1: wx1, y0: 0.85, y1: 2.55, cx: (wx0 + wx1) / 2, cy: 1.7 },
    board: { x: C + 0.15 + BOARD_SIZE.w / 2, y: 1.62 },
    desk: { x: (wx0 + wx1) / 2 - 0.35, z: 1.9, top: 0.78, w: 1.7, d: 0.85 },
    door: { hinge: [C / 2 - 0.47 * S2, 0.012, C / 2 + 0.41 * S2], ry: Math.PI / 4, w: 0.88, h: 2.06 }, // lx -0.44, lz -0.03
    cabinets: [1.78, 2.27], safe: { x: R.w - 0.58, z: 3.02, ry: -HALF_PI + 0.9 }, bookcase: { z: 1.3 }, stand: { x: 0.42, z: 3.25 },
    fan: [R.w / 2, R.h - 0.3, 2.1],
  };
  p.lamp = [p.desk.x - 0.52, p.desk.top, p.desk.z + 0.08];
  p.phone = [p.desk.x + 0.62, p.desk.top, p.desk.z + 0.12];
  p.clock = [p.board.x, 2.48, 0.03];
  /** A point in the safe's own frame (it stands cornerwise, its door toward the middle of the room). */
  p.onSafe = (lx, y, lz) => [p.safe.x + lx * Math.cos(p.safe.ry) + lz * Math.sin(p.safe.ry), 0.05 + y, p.safe.z - lx * Math.sin(p.safe.ry) + lz * Math.cos(p.safe.ry)];
  /** The coat stand's four upper arms: the angle each points at, and where its knob is. */
  p.hookAngle = (i) => 0.35 + i * HALF_PI;
  p.hook = (i) => { const a = p.hookAngle(i), r = 0.02 + Math.sin(0.9) * 0.22; return [p.stand.x + Math.cos(a) * r, 1.62 + Math.cos(0.9) * 0.22, p.stand.z - Math.sin(a) * r]; };
  /** A point on the angled wall: lx along it from its middle, lz out of it into the room. */
  p.onChamfer = (lx, y, lz) => [C / 2 + (lx + lz) * S2, y, C / 2 + (lz - lx) * S2];
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Furniture, each in its own frame with its front toward +z
// ---------------------------------------------------------------------------------------------------------

function woodenChair() {
  const k = new Kit();
  k.add('wood', rbox(0.44, 0.04, 0.44, 0.012), 0, 0.46, 0);
  for (const [x, z] of [[-0.19, 0.19], [0.19, 0.19]]) k.add('wood', cyl(0.02, 0.45, 10, 0.024), x, 0.225, z);
  for (const x of [-0.19, 0.19]) k.add('wood', cyl(0.02, 0.98, 10, 0.022), x, 0.49, -0.2, -0.06);
  k.add('wood', rbox(0.42, 0.11, 0.022, 0.008), 0, 0.92, -0.225, -0.06);
  k.add('wood', rbox(0.42, 0.05, 0.02, 0.008), 0, 0.72, -0.212, -0.06);
  for (const y of [0.16, 0.3]) k.add('wood', cyl(0.011, 0.38, 8), 0, y, 0.19, 0, 0, HALF_PI);
  return k;
}

function swivelChair() {
  const k = new Kit();
  k.add('leather', rbox(0.52, 0.1, 0.5, 0.04), 0, 0.5, 0);
  k.add('leather', rbox(0.5, 0.62, 0.09, 0.04), 0, 0.9, -0.25, -0.14);
  for (const x of [-0.27, 0.27]) { k.add('wood', rbox(0.05, 0.035, 0.36, 0.012), x, 0.72, -0.02); k.add('wood', cyl(0.016, 0.2, 8), x, 0.61, 0.12); k.add('wood', cyl(0.016, 0.2, 8), x, 0.61, -0.16); }
  k.add('steel', cyl(0.028, 0.3, 14), 0, 0.3, 0);
  for (let i = 0; i < 4; i++) { const a = i * HALF_PI + 0.4; k.add('wood', rbox(0.3, 0.035, 0.05, 0.012), Math.cos(a) * 0.15, 0.1, Math.sin(a) * 0.15, 0, -a, 0); k.add('bakelite', ball(0.03, 10), Math.cos(a) * 0.3, 0.035, Math.sin(a) * 0.3); }
  return k;
}

/** A filing cabinet's body; its drawers come with the night. */
function cabinet() {
  const k = new Kit(), w = 0.46, h = 1.32, d = 0.62, t = 0.012;
  k.add('cabinet', box(t, h, d), -w / 2 + t / 2, h / 2, 0); k.add('cabinet', box(t, h, d), w / 2 - t / 2, h / 2, 0);
  k.add('cabinet', box(w, t, d), 0, h - t / 2, 0); k.add('cabinet', box(w, 0.06, d), 0, 0.03, 0); k.add('cabinet', box(w, h, t), 0, h / 2, -d / 2 + t / 2);
  k.add('void', box(w - 0.03, h - 0.08, 0.004), 0, h / 2 + 0.02, d / 2 - 0.05);
  return k;
}
/** One drawer, pulled out by `pull` metres. `row` 0 is the bottom. */
function drawer(k, row, pull) {
  const y = 0.085 + row * 0.305 + 0.145, z0 = 0.31;
  if (pull > 0.01) {
    k.add('cabinet', box(0.4, 0.24, pull), 0, y - 0.01, z0 + pull / 2 - 0.01);
    k.add('void', box(0.37, 0.004, pull - 0.03), 0, y + 0.112, z0 + pull / 2 - 0.01);
    for (let i = 0; i < Math.floor(pull / 0.05); i++) k.add(i % 3 ? 'manila' : 'paper', box(0.34, 0.25, 0.006), (i % 2) * 0.01, y + 0.015 + (i % 3) * 0.008, z0 + 0.03 + i * 0.045, -0.12);
  }
  k.add('cabinet', rbox(0.43, 0.285, 0.018, 0.006), 0, y, z0 + pull);
  k.add('steel', rbox(0.13, 0.016, 0.022, 0.006), 0, y - 0.04, z0 + pull + 0.02);
  k.add('brass', box(0.09, 0.045, 0.004), 0, y + 0.06, z0 + pull + 0.011); k.add('paper', box(0.078, 0.033, 0.002), 0, y + 0.06, z0 + pull + 0.0135);
}

function safeBody() {
  const k = new Kit(), w = 0.62, h = 0.8, d = 0.6, t = 0.05;
  k.add('safe', rbox(t, h, d, 0.012), -w / 2 + t / 2, h / 2, 0); k.add('safe', rbox(t, h, d, 0.012), w / 2 - t / 2, h / 2, 0);
  k.add('safe', rbox(w, t, d, 0.012), 0, h - t / 2, 0); k.add('safe', rbox(w, t, d, 0.012), 0, t / 2, 0); k.add('safe', box(w, h, t), 0, h / 2, -d / 2 + t / 2);
  k.add('felt', box(w - 2 * t, 0.012, d - 2 * t), 0, h * 0.5, 0); // the shelf
  k.add('felt', box(w - 2 * t, 0.006, d - 2 * t), 0, t + 0.003, 0);
  for (const x of [-0.24, 0.24]) for (const z of [-0.22, 0.22]) k.add('bakelite', cyl(0.035, 0.05, 12), x, -0.02, z);
  return k;
}
/** The safe's door, in a frame whose origin is the hinge (door closed lies along +x). */
function safeDoor() {
  const k = new Kit(), w = 0.56, h = 0.72;
  k.add('safe', rbox(w, h, 0.06, 0.012), w / 2, h / 2, 0);
  k.add('safe', rbox(w - 0.1, h - 0.1, 0.02, 0.008), w / 2, h / 2, 0.034);
  k.add('brass', cyl(0.07, 0.03, 32), w * 0.45, h * 0.62, 0.055, HALF_PI); k.add('steel', cyl(0.05, 0.02, 32), w * 0.45, h * 0.62, 0.075, HALF_PI); k.add('bakelite', cyl(0.022, 0.03, 16), w * 0.45, h * 0.62, 0.09, HALF_PI);
  k.add('steel', cyl(0.014, 0.2, 10), w * 0.72, h * 0.4, 0.07, 0, 0, 0.5); k.add('steel', cyl(0.02, 0.05, 12), w * 0.72, h * 0.4, 0.05, HALF_PI);
  for (const y of [0.14, h - 0.14]) k.add('steel', cyl(0.018, 0.12, 12), 0, y, 0.035);
  k.add('brass', box(0.14, 0.05, 0.004), w / 2, h * 0.88, 0.046);
  return k;
}

function bookcase(rand) {
  const k = new Kit(), w = 1.05, h = 2.05, d = 0.3, t = 0.025;
  k.add('woodLight', box(t, h, d), -w / 2 + t / 2, h / 2, 0); k.add('woodLight', box(t, h, d), w / 2 - t / 2, h / 2, 0);
  k.add('woodLight', box(w + 0.04, 0.04, d + 0.02), 0, h, 0); k.add('woodLight', box(w, 0.1, d), 0, 0.05, 0); k.add('woodLight', box(w, h, 0.012), 0, h / 2, -d / 2 + 0.006);
  const shelves = [0.1, 0.5, 0.88, 1.24, 1.6];
  shelves.forEach((y, s) => {
    k.add('woodLight', box(w - 2 * t, 0.022, d - 0.01), 0, y + 0.011, 0);
    let x = -w / 2 + t + 0.01; const top = (shelves[s + 1] ?? h) - y - 0.05;
    while (x < w / 2 - t - 0.07) {
      const kind = rand();
      if (kind < 0.1) { x += 0.04 + rand() * 0.08; continue; }                       // a gap
      if (kind < 0.22 && s > 0) {                                                    // a box file
        k.add('manila', rbox(0.075, Math.min(top, 0.31), 0.24, 0.004), x + 0.04, y + 0.022 + Math.min(top, 0.31) / 2, 0.01); k.add('paper', box(0.05, 0.07, 0.002), x + 0.04, y + 0.14, 0.131);
        x += 0.082; continue;
      }
      const bw = 0.022 + rand() * 0.04, bh = Math.min(top, 0.19 + rand() * 0.11), lean = rand() < 0.08 ? 0.16 : 0;
      k.add(rand.pick(['bookRed', 'bookGreen', 'bookBlue', 'bookTan', 'bookTan', 'bookGreen']), rbox(bw, bh, 0.16 + rand() * 0.05, 0.004), x + bw / 2 + lean * bh / 2, y + 0.022 + bh / 2, 0.02 + rand() * 0.03, 0, 0, -lean);
      if (rand() < 0.5) k.add('brass', box(bw * 0.7, 0.006, 0.002), x + bw / 2, y + 0.022 + bh * 0.8, 0.125);
      x += bw + 0.002 + lean * bh;
    }
  });
  return k;
}

function fedora() {
  const k = new Kit();
  k.add('hat', cyl(0.17, 0.012, 28), 0, 0.006, 0);
  k.add('hat', new THREE.CylinderGeometry(0.085, 0.1, 0.11, 24).scale(1, 1, 1.18), 0, 0.066, 0);
  k.add('bakelite', new THREE.CylinderGeometry(0.102, 0.103, 0.028, 24).scale(1, 1, 1.18), 0, 0.027, 0);
  return k;
}

// ---------------------------------------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything fixed. Returns what the skin must dress or animate:
 *   prints: [{ key, pos, rot, w, h }] flat printed things; glow: [{ group, geo }] parts that give light;
 *   slats: the blinds' geometry (its own mesh, so that it can be left out of nothing and shadows everything).
 */
export function buildRoom(b, R) {
  const P = plan(R), { C, win, desk } = P, out = { plan: P, prints: [], glow: [] };
  const rand = makeRand(1947);
  const T = 0.25; // wall thickness: the window's reveal

  // ----- Shell -----
  b.add('floor', at(box(R.w + 0.6, 0.06, R.d + 0.6), R.w / 2, -0.03, R.d / 2 - 0.2));
  b.add('ceiling', at(box(R.w + 0.6, 0.06, R.d + 0.6), R.w / 2, R.h + 0.03, R.d / 2 - 0.2));
  // Walls run 20 cm past the floor and the ceiling, so no light gets in along a seam.
  const WH = R.h + 0.4;
  b.add('wall', at(box(T, WH, R.d - C + 0.3), -T / 2, R.h / 2, (C + R.d) / 2 + 0.15));
  b.add('wall', at(box(T, WH, R.d + 0.6), R.w + T / 2, R.h / 2, R.d / 2));
  // The back wall, round the window.
  b.add('wall', at(box(win.x0 - C + 0.2, WH, T), (C + win.x0) / 2 - 0.1, R.h / 2, -T / 2));
  b.add('wall', at(box(R.w - win.x1 + 0.2, WH, T), (win.x1 + R.w) / 2 + 0.1, R.h / 2, -T / 2));
  b.add('wall', at(box(win.x1 - win.x0, win.y0 + 0.2, T), win.cx, win.y0 / 2 - 0.1, -T / 2));
  b.add('wall', at(box(win.x1 - win.x0, R.h - win.y1 + 0.2, T), win.cx, (win.y1 + R.h) / 2 + 0.1, -T / 2));
  // The angled wall, round the door.
  const Lc = C * Math.SQRT2, dw = 0.45, dh = 2.08;
  const ch = (key, geo, lx, y, lz) => b.add(key, at(geo, ...P.onChamfer(lx, y, lz), 0, Math.PI / 4, 0));
  ch('wall', box(Lc / 2 - dw + 0.3, WH, 0.2), -(Lc / 2 + dw) / 2 - 0.15, R.h / 2, -0.1);
  ch('wall', box(Lc / 2 - dw + 0.3, WH, 0.2), (Lc / 2 + dw) / 2 + 0.15, R.h / 2, -0.1);
  ch('wall', box(2 * dw, R.h - dh + 0.2, 0.2), 0, (dh + R.h) / 2 + 0.1, -0.1);
  ch('wood', box(0.09, dh + 0.09, 0.03), -dw - 0.045, (dh + 0.09) / 2, 0.015); ch('wood', box(0.09, dh + 0.09, 0.03), dw + 0.045, (dh + 0.09) / 2, 0.015);
  ch('wood', box(2 * dw + 0.24, 0.11, 0.04), 0, dh + 0.055, 0.02);
  ch('wood', box(2 * dw, 0.03, 0.2), 0, 0.012, -0.1); // the threshold
  ch('bakelite', rbox(0.075, 0.115, 0.012, 0.004), -dw - 0.2, 1.3, 0.006); ch('brass', cyl(0.006, 0.03, 8), -dw - 0.2, 1.31, 0.02, HALF_PI); // the light switch

  // Skirting, dado panelling, chair rail and cornice, along every wall.
  const run = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(-(z1 - z0), x1 - x0), nx = -(z1 - z0) / len, nz = (x1 - x0) / len; // the normal points to the left of the direction of travel
    const put = (key, h, d, y) => b.add(key, at(box(len, h, d), (x0 + x1) / 2 + nx * d / 2, y, (z0 + z1) / 2 + nz * d / 2, 0, ry, 0));
    put('wood', 0.15, 0.022, 0.075); put('dado', 0.8, 0.008, 0.55); put('wood', 0.055, 0.03, 0.975); put('ceiling', 0.09, 0.07, R.h - 0.045);
  };
  // Directions are chosen so that "left of travel" is into the room.
  run(0, R.d, 0, C);                                             // left wall, front to back
  const xz = (lx) => { const q = P.onChamfer(lx, 0, 0); return [q[0], q[2]]; };
  run(...xz(-Lc / 2), ...xz(-dw - 0.09)); run(...xz(dw + 0.09), ...xz(Lc / 2));          // the angled wall, either side of the door
  run(C, 0, win.x0 - 0.09, 0); run(win.x1 + 0.09, 0, R.w, 0);    // back wall, either side of the window
  run(R.w, 0, R.w, R.d);                                         // right wall
  b.add('wood', at(box(1.98, 0.15, 0.022), win.cx, 0.075, 0.011)); b.add('dado', at(box(1.98, 0.62, 0.008), win.cx, 0.46, 0.004));

  // ----- The window -----
  const ww = win.x1 - win.x0, wh = win.y1 - win.y0, fz = -0.19;
  for (const x of [win.x0 + 0.035, win.x1 - 0.035, win.cx]) b.add('frame', at(box(x === win.cx ? 0.045 : 0.07, wh, 0.06), x, win.cy, fz));
  for (const y of [win.y0 + 0.035, win.y1 - 0.035, win.cy]) b.add('frame', at(box(ww, y === win.cy ? 0.05 : 0.07, 0.065), win.cx, y, fz));
  b.add('wood', at(rbox(ww + 0.2, 0.04, 0.3, 0.012), win.cx, win.y0 - 0.02, -0.07));                    // the sill board
  for (const x of [win.x0 - 0.05, win.x1 + 0.05]) b.add('wood', at(box(0.1, wh + 0.2, 0.03), x, win.cy, 0.015));
  b.add('wood', at(box(ww + 0.2, 0.12, 0.04), win.cx, win.y1 + 0.06, 0.02));
  for (const x of [win.cx - 0.3, win.cx + 0.3]) b.add('brass', at(rbox(0.1, 0.02, 0.03, 0.006), x, win.y0 + 0.09, fz + 0.045)); // sash lifts
  out.glass = { pos: [win.cx, win.cy, fz - 0.01], w: ww - 0.1, h: wh - 0.1 };
  // The blinds: a head rail, forty slats, near enough on two tapes, a bottom rail and its cord. Three slats are bent
  // where somebody keeps parting them with two fingers to look down at the street.
  const slats = [], pitch = 0.04, tilt = 0.5, bz = -0.075;
  const n = Math.floor((wh - 0.1) / pitch);
  for (let i = 0; i < n; i++) {
    const g = new THREE.BoxGeometry(ww - 0.05, 0.003, 0.05, 36, 1, 1), y = win.y1 - 0.09 - i * pitch;
    const bend = i >= 14 && i <= 16 ? (i === 15 ? 0.034 : 0.016) * (i === 14 ? -1 : 1) : (rand() < 0.12 ? 0.004 : 0);
    const where = i >= 14 && i <= 16 ? -0.38 : rand.range(-0.7, 0.7);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) p.setY(v, p.getY(v) - bend * Math.exp(-(((p.getX(v) - where) / 0.1) ** 2)) + 0.004 * Math.cos(p.getZ(v) * 60));
    g.computeVertexNormals();
    slats.push(at(g, win.cx, y, bz, tilt + rand.range(-0.03, 0.03), 0, rand.range(-0.004, 0.004)));
  }
  for (const s of slats) b.add('slat', s);
  b.add('slat', at(rbox(ww - 0.03, 0.05, 0.06, 0.008), win.cx, win.y1 - 0.045, bz)); b.add('slat', at(rbox(ww - 0.05, 0.025, 0.05, 0.008), win.cx, win.y1 - 0.09 - n * pitch, bz));
  for (const x of [win.cx - 0.6, win.cx + 0.6]) for (const z of [bz - 0.027, bz + 0.027]) b.add('tape', at(box(0.03, n * pitch, 0.0015), x, win.y1 - 0.09 - n * pitch / 2, z));
  b.add('tape', at(cyl(0.004, 1.1, 6), win.x1 - 0.1, win.y1 - 0.62, bz + 0.04)); b.add('wood', at(cyl(0.012, 0.06, 8, 0.006), win.x1 - 0.1, win.y1 - 1.19, bz + 0.04));
  // The radiator under it: twelve cast-iron columns, a valve and its pipe.
  for (let i = 0; i < 12; i++) { const x = win.cx - 0.9 + 0.35 + i * 0.066; b.add('iron', at(rbox(0.052, 0.6, 0.15, 0.022), x, 0.4, 0.14)); b.add('iron', at(rbox(0.06, 0.05, 0.1, 0.02), x, 0.66, 0.14)); b.add('iron', at(rbox(0.06, 0.05, 0.1, 0.02), x, 0.14, 0.14)); }
  for (const x of [win.cx - 0.5, win.cx + 0.13]) b.add('iron', at(cyl(0.02, 0.1, 10), x, 0.05, 0.14));
  b.add('brass', at(cyl(0.022, 0.07, 12), win.cx - 0.62, 0.16, 0.14)); b.add('bakelite', at(cyl(0.032, 0.03, 12), win.cx - 0.62, 0.21, 0.14)); b.add('iron', at(cyl(0.014, 0.16, 8), win.cx - 0.62, 0.08, 0.14));

  // ----- The back wall: the pinboard, the clock -----
  const bd = P.board;
  b.add('cork', at(box(BOARD_SIZE.w, BOARD_SIZE.h, 0.02), bd.x, bd.y, 0.01));
  for (const s of [-1, 1]) { b.add('woodLight', at(box(0.045, BOARD_SIZE.h + 0.09, 0.035), bd.x + s * (BOARD_SIZE.w / 2 + 0.022), bd.y, 0.0175)); b.add('woodLight', at(box(BOARD_SIZE.w + 0.09, 0.045, 0.035), bd.x, bd.y + s * (BOARD_SIZE.h / 2 + 0.022), 0.0175)); }
  out.board = { pos: [bd.x, bd.y, 0.0215], w: BOARD_SIZE.w, h: BOARD_SIZE.h };
  // A brass picture light over it, on two arms.
  const ply = bd.y + BOARD_SIZE.h / 2 + 0.14;
  b.add('brass', at(cyl(0.026, 0.9, 16), bd.x, ply, 0.2, 0, 0, HALF_PI));
  for (const s of [-1, 1]) { b.add('brass', at(cyl(0.008, 0.2, 8), bd.x + s * 0.3, ply, 0.1, HALF_PI)); b.add('brass', at(cyl(0.03, 0.012, 12), bd.x + s * 0.3, ply, 0.006, HALF_PI)); }
  out.glow.push({ group: 'bulb', geo: at(box(0.84, 0.006, 0.03), bd.x, ply - 0.024, 0.2) });
  out.boardLight = [bd.x, ply - 0.03, 0.21];
  b.add('bakelite', at(cyl(0.2, 0.05, 48), P.clock[0], P.clock[1], 0.025, HALF_PI)); b.add('brass', at(new THREE.TorusGeometry(0.19, 0.012, 10, 48), P.clock[0], P.clock[1], 0.05));
  out.prints.push({ key: 'clock', pos: [P.clock[0], P.clock[1], 0.0515], rot: [0, 0, 0], w: 0.36, h: 0.36, round: true });
  out.clock = [P.clock[0], P.clock[1], 0.056];
  // The calendar hangs beside the door; the licence over the cabinets.
  out.calendar = { pos: P.onChamfer(dw + 0.3, 1.52, 0.012), rot: [0, Math.PI / 4, 0], w: 0.27, h: 0.38 };
  b.add('woodLight', at(box(0.3, 0.41, 0.01), ...P.onChamfer(dw + 0.3, 1.52, 0.005), 0, Math.PI / 4, 0));
  b.add('woodLight', at(box(0.02, 0.44, 0.56), 0.01, 1.82, 2.02)); out.prints.push({ key: 'licence', pos: [0.022, 1.82, 2.02], rot: [0, HALF_PI, 0], w: 0.5, h: 0.39 });

  // ----- The left wall: two filing cabinets -----
  for (const z of P.cabinets) cabinet().into(b, 0.33, 0, z, 0, HALF_PI, 0);
  // A stack of box files and a fan heater on top of them.
  for (let i = 0; i < 3; i++) b.add('manila', at(rbox(0.36, 0.08, 0.27, 0.006), 0.31, 1.36 + i * 0.082, P.cabinets[0] + 0.02, 0, 0.1 * (i - 1), 0));
  b.add('bakelite', at(rbox(0.24, 0.2, 0.2, 0.03), 0.3, 1.42, P.cabinets[1])); b.add('steel', at(cyl(0.085, 0.01, 24), 0.425, 1.43, P.cabinets[1], 0, 0, HALF_PI)); // an old radio set
  b.add('brass', at(cyl(0.016, 0.02, 12), 0.425, 1.36, P.cabinets[1] - 0.07, 0, 0, HALF_PI)); b.add('brass', at(cyl(0.016, 0.02, 12), 0.425, 1.36, P.cabinets[1] + 0.07, 0, 0, HALF_PI));

  // ----- The right wall: the safe (its door comes with the night), the bookcase -----
  safeBody().into(b, P.safe.x, 0.05, P.safe.z, 0, P.safe.ry, 0);
  bookcase(rand).into(b, R.w - 0.16, 0, P.bookcase.z, 0, -HALF_PI, 0);
  b.add('brass', at(ball(0.11, 24), R.w - 0.2, 2.2, P.bookcase.z - 0.25)); b.add('wood', at(cyl(0.07, 0.04, 16), R.w - 0.2, 2.09, P.bookcase.z - 0.25)); // a globe-ish trophy on top
  for (let i = 0; i < 4; i++) b.add(i % 2 ? 'bookTan' : 'bookRed', at(rbox(0.26, 0.045, 0.19, 0.005), R.w - 0.18, 2.095 + i * 0.047, P.bookcase.z + 0.22, 0, 0.2 * i, 0));

  // ----- The desk -----
  const dk = new Kit(), top = desk.top;
  dk.add('wood', rbox(desk.w, 0.05, desk.d, 0.014), 0, top - 0.025, 0);
  for (const s of [-1, 1]) {
    dk.add('wood', rbox(0.44, top - 0.11, desk.d - 0.1, 0.01), s * (desk.w / 2 - 0.26), (top - 0.05) / 2 + 0.03, 0);
    dk.add('wood', box(0.4, 0.06, desk.d - 0.16), s * (desk.w / 2 - 0.26), 0.03, 0);
    dk.add('woodLight', rbox(0.34, top - 0.24, 0.012, 0.004), s * (desk.w / 2 - 0.26), top / 2, desk.d / 2 - 0.046);                   // panels on the visitor's side
    for (let i = 0; i < 3; i++) { dk.add('woodLight', rbox(0.38, 0.19, 0.014, 0.005), s * (desk.w / 2 - 0.26), 0.2 + i * 0.205, -(desk.d / 2 - 0.045)); dk.add('brass', rbox(0.1, 0.014, 0.02, 0.005), s * (desk.w / 2 - 0.26), 0.2 + i * 0.205, -(desk.d / 2 - 0.03)); }
  }
  dk.add('wood', box(desk.w - 0.9, top - 0.3, 0.02), 0, top - 0.05 - (top - 0.3) / 2, desk.d / 2 - 0.12);                                // the modesty panel
  dk.add('leather', rbox(0.72, 0.008, 0.46, 0.003), 0.08, top + 0.004, -0.12);
  dk.into(b, desk.x, 0, desk.z);
  out.panel = [desk.x, top - 0.05 - (top - 0.3) / 2, desk.z + desk.d / 2 - 0.108]; // where a note can be knifed to the desk's front

  // The banker's lamp: a brass foot and stem, and a green glass shade over the bulb.
  const [lx, , lz] = P.lamp;
  b.add('brass', at(rbox(0.2, 0.025, 0.13, 0.01), lx, top + 0.0125, lz)); b.add('brass', at(cyl(0.012, 0.3, 12), lx, top + 0.17, lz - 0.03));
  b.add('brass', at(cyl(0.01, 0.1, 10), lx, top + 0.325, lz - 0.0, HALF_PI * 0.5)); b.add('brass', at(cyl(0.012, 0.34, 10), lx, top + 0.36, lz + 0.03, 0, 0, HALF_PI));
  const shade = new THREE.CylinderGeometry(0.075, 0.075, 0.32, 28, 1, false, 0, Math.PI).rotateZ(HALF_PI);
  out.glow.push({ group: 'shade', geo: at(shade, lx, top + 0.345, lz + 0.03) });
  out.glow.push({ group: 'bulb', geo: at(cyl(0.02, 0.2, 10), lx, top + 0.345, lz + 0.03, 0, 0, HALF_PI) });
  b.add('brass', at(cyl(0.0025, 0.1, 5), lx + 0.1, top + 0.29, lz + 0.05)); b.add('brass', at(ball(0.008, 8), lx + 0.1, top + 0.235, lz + 0.05));
  out.lampLight = [lx, top + 0.33, lz + 0.03];

  // The typewriter, its back to you: a black body, the platen and its knobs, a sheet in it, the key bank beyond.
  const tw = new Kit();
  tw.add('bakelite', rbox(0.37, 0.1, 0.32, 0.02), 0, 0.05, 0); tw.add('bakelite', rbox(0.37, 0.07, 0.12, 0.02), 0, 0.13, 0.09);
  tw.add('bakelite', cyl(0.026, 0.44, 16), 0, 0.2, 0.09, 0, 0, HALF_PI); for (const s of [-1, 1]) tw.add('steel', cyl(0.03, 0.025, 16), s * 0.235, 0.2, 0.09, 0, 0, HALF_PI);
  tw.add('paper', box(0.215, 0.24, 0.001), 0.01, 0.33, 0.105, 0.12); tw.add('steel', rbox(0.3, 0.012, 0.012, 0.004), 0, 0.235, 0.06);
  tw.add('steel', cyl(0.006, 0.16, 6), -0.24, 0.26, 0.05, 0.5, 0, 0.4);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 11; c++) tw.add('steel', cyl(0.0095, 0.012, 10), (c - 5 + (r % 2) * 0.5) * 0.027, 0.105 - r * 0.014, -0.06 - r * 0.028);
  tw.add('brass', box(0.12, 0.022, 0.002), 0, 0.07, 0.161);
  tw.into(b, desk.x + 0.14, top, desk.z - 0.1);

  // The telephone (its handset is the skin's, so that it can jump when it rings).
  const [px, , pz] = P.phone, ph = new Kit();
  ph.add('bakelite', new THREE.CylinderGeometry(0.075, 0.105, 0.085, 28).scale(1, 1, 0.85), 0, 0.0425, 0);
  ph.add('bakelite', rbox(0.19, 0.03, 0.05, 0.012), 0, 0.1, -0.02); for (const s of [-1, 1]) ph.add('bakelite', rbox(0.022, 0.05, 0.07, 0.008), s * 0.085, 0.125, -0.02);
  ph.add('steel', cyl(0.058, 0.008, 32), 0, 0.06, 0.07, 1.0); ph.add('paper', cyl(0.024, 0.009, 16), 0, 0.061, 0.071, 1.0);
  ph.into(b, px, top, pz, 0, -0.35, 0);
  b.add('bakelite', new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[px - 0.08, top + 0.02, pz - 0.05], [px - 0.2, top + 0.006, pz - 0.2], [px - 0.1, top + 0.006, pz - 0.36], [px + 0.05, top - 0.05, pz - 0.5]].map((v) => new THREE.Vector3(...v))), 24, 0.005, 6));
  out.handset = [px, top + 0.16, pz - 0.02, -0.35];

  // The brass nameplate on the desk's front edge, and the ashtray.
  b.add('brass', at(rbox(0.3, 0.06, 0.035, 0.006), desk.x + 0.52, top + 0.03, desk.z + desk.d / 2 - 0.06, -0.3));
  out.prints.push({ key: 'nameplate', pos: [desk.x + 0.52, top + 0.033, desk.z + desk.d / 2 - 0.0405], rot: [-0.3, 0, 0], w: 0.27, h: 0.05, metal: true });
  out.ashtray = [desk.x - 0.2, top, desk.z - 0.2];
  b.add('glass', at(cyl(0.065, 0.022, 24, 0.075), ...out.ashtray).translate(0, 0.011, 0)); b.add('void', at(cyl(0.055, 0.004, 24), out.ashtray[0], top + 0.021, out.ashtray[2]));

  // The swivel chair, left as it stopped turning; the rug; the waste bin; the umbrella stand; the ceiling fan's mount.
  swivelChair().into(b, desk.x + 0.1, 0, desk.z - 0.95, 0, 2.5, 0);
  b.add('carpet', at(box(3.0, 0.014, 2.1), desk.x - 0.1, 0.007, desk.z + 0.25)); for (const s of [-1, 1]) b.add('carpetEdge', at(box(3.0, 0.016, 0.09), desk.x - 0.1, 0.008, desk.z + 0.25 + s * 1.0));
  b.add('bin', at(new THREE.CylinderGeometry(0.15, 0.115, 0.32, 20, 1, true), desk.x + 1.05, 0.16, desk.z + 0.35)); b.add('bin', at(cyl(0.115, 0.01, 20), desk.x + 1.05, 0.005, desk.z + 0.35));
  for (let i = 0; i < 5; i++) b.add('paper', at(new THREE.IcosahedronGeometry(0.04 + rand() * 0.02, 0), desk.x + 1.05 + rand.range(-0.06, 0.06), 0.1 + i * 0.045, desk.z + 0.35 + rand.range(-0.06, 0.06), rand() * 3, rand() * 3, 0));
  b.add('paper', at(new THREE.IcosahedronGeometry(0.045, 0), desk.x + 1.3, 0.04, desk.z + 0.5, 1, 2, 0));
  const us = P.onChamfer(dw + 0.33, 0, 0.2);
  b.add('bin', at(new THREE.CylinderGeometry(0.11, 0.1, 0.5, 20, 1, true), us[0], 0.25, us[2])); b.add('brass', at(cyl(0.1, 0.012, 20), us[0], 0.006, us[2]));
  b.add('bakelite', at(cyl(0.012, 0.85, 8, 0.03), us[0] + 0.02, 0.45, us[2], 0.08, 0, 0.06)); b.add('wood', at(new THREE.TorusGeometry(0.04, 0.011, 8, 14, Math.PI), us[0] + 0.045, 0.9, us[2] - 0.03, 0, 0, 0.06));
  b.add('brass', at(cyl(0.012, 0.3, 10), P.fan[0], R.h - 0.15, P.fan[2])); b.add('brass', at(cyl(0.07, 0.06, 20, 0.04), P.fan[0], R.h - 0.03, P.fan[2]));
  // The coat stand.
  b.add('wood', at(cyl(0.2, 0.035, 24, 0.17), P.stand.x, 0.0175, P.stand.z)); b.add('wood', at(cyl(0.024, 1.78, 12, 0.02), P.stand.x, 0.92, P.stand.z)); b.add('wood', at(ball(0.035, 12), P.stand.x, 1.83, P.stand.z));
  // Its arms: four long ones round the top, each rising outward from the pole and ending in a knob, and four
  // short pegs lower down, set between them. Each is leaned outward first and only then turned round the pole.
  const arm = (a, y0, len, lean) => {
    const g = cyl(0.011, len, 8, 0.009).rotateZ(-lean).translate(0.02 + Math.sin(lean) * len / 2, y0 + Math.cos(lean) * len / 2, 0);
    const knob = ball(0.017, 10).translate(0.02 + Math.sin(lean) * len, y0 + Math.cos(lean) * len, 0);
    for (const part of [g, knob]) b.add('wood', part.rotateY(a).translate(P.stand.x, 0, P.stand.z));
  };
  for (let i = 0; i < 4; i++) { arm(P.hookAngle(i), 1.62, 0.22, 0.9); arm(P.hookAngle(i) + Math.PI / 4, 1.38, 0.11, 1.1); }
  b.add('wood', at(cyl(0.032, 0.03, 12), P.stand.x, 1.62, P.stand.z)); b.add('wood', at(cyl(0.03, 0.025, 12), P.stand.x, 1.38, P.stand.z));
  // A mouse hole in the skirting, at the foot of the back wall near the bookcase.
  out.hole = [R.w - 0.75, 0, 0.024];
  b.add('void', at(new THREE.CircleGeometry(0.045, 16, 0, Math.PI), out.hole[0], 0, 0.0228));
  return out;
}

/** The door's leaf, in its own frame: the hinge edge at x = 0, the face that looks into the office toward +z. */
export function buildDoor(b) {
  const w = 0.88, h = 2.06, gx = w / 2, gy = PANE.y + PANE.h / 2;
  b.add('wood', at(rbox(w, PANE.y - 0.02, 0.045, 0.006), w / 2, (PANE.y - 0.02) / 2 + 0.01, 0));
  b.add('woodLight', at(rbox(w - 0.24, PANE.y - 0.3, 0.012, 0.004), w / 2, PANE.y / 2, 0.024));
  for (const x of [(w - PANE.w) / 4, w - (w - PANE.w) / 4]) b.add('wood', at(rbox((w - PANE.w) / 2, h, 0.045, 0.006), x, h / 2, 0));
  b.add('wood', at(rbox(w, h - PANE.y - PANE.h, 0.045, 0.006), w / 2, (h + PANE.y + PANE.h) / 2, 0));
  for (const s of [-1, 1]) { b.add('wood', at(box(0.014, PANE.h, 0.012), gx + s * (PANE.w / 2 - 0.005), gy, 0.02)); b.add('wood', at(box(PANE.w, 0.014, 0.012), gx, gy + s * (PANE.h / 2 - 0.005), 0.02)); }
  b.add('brass', at(rbox(0.06, 0.2, 0.008, 0.003), w - 0.07, 1.0 - 0.08, 0.027)); b.add('brass', at(cyl(0.012, 0.05, 10), w - 0.07, 0.95, 0.05, HALF_PI)); b.add('brass', at(ball(0.032, 16).scale(1, 1, 0.8), w - 0.07, 0.95, 0.085));
  for (const y of [0.25, 1.05, 1.85]) b.add('brass', at(cyl(0.009, 0.1, 8), 0.0, y, 0.027));
  return { glass: { pos: [gx, gy, 0.006], w: PANE.w - 0.012, h: PANE.h - 0.012 } };
}

// ---------------------------------------------------------------------------------------------------------
// What a night adds
// ---------------------------------------------------------------------------------------------------------

/**
 * The room's state on night `n` (0 Monday .. 3 Thursday), into batch `b`. Returns { prints, glow, gem, smoke }.
 */
export function buildNight(b, R, n) {
  const P = plan(R), { desk } = P, top = desk.top, out = { prints: [], glow: [], gem: null, smoke: null };
  const rand = makeRand(100 + n);

  // Filing cabinets: shut, except on Wednesday.
  const pulls = n === 2 ? [[0.42, 0, 0.3, 0.18], [0, 0.36, 0, 0.44]] : [[0, 0, 0, 0], [0, 0, n === 1 ? 0.12 : 0, 0]];
  P.cabinets.forEach((z, i) => { const k = new Kit(); pulls[i].forEach((p, row) => drawer(k, row, p)); k.into(b, 0.33, 0, z, 0, HALF_PI, 0); });

  // The safe: shut until Thursday, when it stands open with the sapphire on its shelf.
  safeDoor().into(b, ...P.onSafe(-0.28, 0.04, 0.33), 0, P.safe.ry + (n === 3 ? -1.9 : 0), 0);
  if (n === 3) {
    out.gem = P.onSafe(0, 0.4 + 0.075, 0.08);
    b.add('felt', at(rbox(0.16, 0.03, 0.16, 0.01), ...P.onSafe(0, 0.4 + 0.02, 0.08), 0, P.safe.ry, 0));
    for (let i = 0; i < 4; i++) b.add('money', at(rbox(0.16, 0.035, 0.075, 0.004), ...P.onSafe(-0.08 + (i % 2) * 0.18, 0.075 + Math.floor(i / 2) * 0.036, 0.1), 0, P.safe.ry + 0.1 * i, 0));
  }

  // The visitor's chair: by the desk, and on Wednesday on its side.
  if (n === 2) woodenChair().into(b, desk.x - 1.25, 0.23, desk.z + 0.75, 0, 0.7, HALF_PI * 0.98);
  else woodenChair().into(b, desk.x - 0.75, 0, desk.z + 1.0, 0, Math.PI - 0.5, 0);

  // The coat stand: Quill's coat and hat are on it when Quill has been in.
  if (n === 1 || n === 3) {
    const prof = [[0.02, 0], [0.25, 0.02], [0.24, 0.45], [0.195, 0.78], [0.2, 0.95], [0.225, 1.08], [0.13, 1.17], [0.05, 1.22], [0.0, 1.22]].map(([r, y]) => new THREE.Vector2(r, y)); // hem, waist, shoulders, collar
    // The coat hangs by its collar from one arm's knob, flat side to the pole; the hat sits on the arm opposite.
    const [hx, hy, hz] = P.hook(0), turn = P.hookAngle(0) + HALF_PI;
    b.add('coat', at(new THREE.LatheGeometry(prof, 20).scale(1, 1, 0.5), hx, hy - 1.2, hz, 0, turn, 0));
    b.add('coatBelt', at(new THREE.TorusGeometry(0.197, 0.014, 6, 28).rotateX(HALF_PI).scale(1, 1.6, 0.5), hx, hy - 1.2 + 0.78, hz, 0, turn, 0)); // the belt
    if (n === 1) { const [tx, ty, tz] = P.hook(2), a = P.hookAngle(2); fedora().into(b, tx - Math.cos(a) * 0.03, ty - 0.035, tz + Math.sin(a) * 0.03, 0.35 * Math.sin(a), 0, -0.35 * Math.cos(a)); }
  }
  if (n === 3) fedora().into(b, desk.x - 0.1, top, desk.z + 0.18, 0, 0.4, 0);

  // On the desk.
  const paperAt = (x, z, ry, key = 'paper') => b.add(key, at(box(0.21, 0.002, 0.297), desk.x + x, top + 0.002 + rand() * 0.004, desk.z + z, 0, ry, 0));
  const folder = (x, z, ry, i = 0) => b.add('manila', at(rbox(0.33, 0.008, 0.24, 0.003), desk.x + x, top + 0.006 + i * 0.009, desk.z + z, 0, ry, 0));
  folder(-0.3, 0.2, 0.3); folder(-0.31, 0.19, 0.15, 1);
  if (n >= 1) {
    // The front page, folded and stood against the typewriter.
    const nz = desk.z + 0.17, nx = desk.x + 0.2;
    b.add('paper', at(rbox(0.41, 0.32, 0.012, 0.004), nx, top + 0.15, nz, -0.42));
    out.prints.push({ key: n === 3 ? 'paperB' : 'paperA', pos: [nx, top + 0.15 + 0.003, nz + 0.0075], rot: [-0.42, 0, 0], w: 0.4, h: 0.31 });
    // A cup and saucer; the cigarette, still going.
    b.add('china', at(cyl(0.07, 0.01, 20), desk.x + 0.45, top + 0.005, desk.z - 0.25)); b.add('china', at(cyl(0.036, 0.06, 18, 0.042), desk.x + 0.45, top + 0.04, desk.z - 0.25)); b.add('void', at(cyl(0.037, 0.003, 18), desk.x + 0.45, top + 0.069, desk.z - 0.25));
    b.add('paper', at(cyl(0.0045, 0.075, 8), P.desk.x - 0.2 + 0.03, top + 0.027, desk.z - 0.2 + 0.02, 0, 0.6, 1.35));
    out.glow.push({ group: 'ember', geo: at(cyl(0.0048, 0.008, 8), P.desk.x - 0.2 + 0.001, top + 0.034, desk.z - 0.2 + 0.04, 0, 0.6, 1.35) });
    out.smoke = [P.desk.x - 0.2, top + 0.04, desk.z - 0.16];
    paperAt(0.0, -0.2, 0.2); paperAt(0.02, -0.19, -0.1);
  } else {
    paperAt(0.05, -0.15, 0.1);
  }
  if (n >= 2) {
    // The bottle and a glass (two on Thursday).
    const bx = desk.x + 0.72, bzz = desk.z - 0.22;
    const prof = [[0, 0], [0.04, 0], [0.04, 0.17], [0.03, 0.2], [0.013, 0.23], [0.013, 0.29], [0.016, 0.29], [0.016, 0.3], [0, 0.3]].map(([r, y]) => new THREE.Vector2(r, y));
    b.add('amber', at(new THREE.LatheGeometry(prof, 20), bx, top, bzz)); b.add('paper', at(new THREE.CylinderGeometry(0.0405, 0.0405, 0.08, 20, 1, true), bx, top + 0.09, bzz));
    for (let i = 0; i < (n === 3 ? 2 : 1); i++) { b.add('glass', at(new THREE.CylinderGeometry(0.036, 0.03, 0.085, 18, 1, true), bx - 0.15 - i * 0.12, top + 0.0425, bzz + 0.12 + i * 0.03)); b.add('amber', at(cyl(0.028, 0.025, 18, 0.032), bx - 0.15 - i * 0.12, top + 0.0145, bzz + 0.12 + i * 0.03)); }
  }
  if (n === 2) {
    // Turned over: paper across the floor, a drawer's worth of folders, and the note, knifed to the front of the desk.
    for (let i = 0; i < 26; i++) b.add(i % 4 ? 'paper' : 'manila', at(box(i % 4 ? 0.21 : 0.33, 0.002, i % 4 ? 0.297 : 0.24), rand.range(0.7, desk.x - 0.9), 0.004 + i * 0.0012, rand.range(1.3, 3.5), 0, rand() * 6.3, 0));
    for (let i = 0; i < 7; i++) b.add('paper', at(box(0.21, 0.002, 0.297), desk.x + rand.range(-0.6, 0.5), 0.018 + i * 0.001, desk.z + rand.range(0.5, 1.2), 0, rand() * 6.3, 0));
    const nx = desk.x - 0.05, ny = top - 0.3, nz = desk.z + desk.d / 2 - 0.108;
    b.add('paper', at(box(0.3, 0.19, 0.002), nx, ny, nz + 0.002, 0, 0, 0.06));
    out.prints.push({ key: 'dropit', pos: [nx, ny, nz + 0.0035], rot: [0, 0, 0.06], w: 0.3, h: 0.19 });
    b.add('steel', at(box(0.022, 0.003, 0.12), nx + 0.02, ny + 0.078, nz + 0.06, 0.25, 0, 0.3)); b.add('wood', at(rbox(0.03, 0.022, 0.11, 0.008), nx + 0.02, ny + 0.106, nz + 0.17, 0.25, 0, 0.3));
    b.add('glass', at(new THREE.IcosahedronGeometry(0.03, 0), 1.1, 0.02, 1.25)); for (let i = 0; i < 9; i++) b.add('glass', at(new THREE.TetrahedronGeometry(0.012 + rand() * 0.02), 0.9 + rand() * 0.7, 0.008, 1.0 + rand() * 0.6, rand() * 3, rand() * 3, 0)); // glass from the door
  }
  if (n === 3) {
    const fx = desk.x - 0.42, fz = desk.z + 0.25;
    b.add('manila', at(rbox(0.33, 0.25, 0.008, 0.003), fx, top + 0.118, fz, -0.5, 0.15, 0));
    out.prints.push({ key: 'closed', pos: [fx + 0.0007, top + 0.118 + 0.002, fz + 0.005], rot: [-0.5, 0.15, 0], w: 0.32, h: 0.24 });
  }
  if (n === 0) out.envelope = { from: P.onChamfer(0.05, 0.006, -0.12), to: P.onChamfer(0.1, 0.006, 0.42), ry: Math.PI / 4 + 0.2 };
  else if (n === 1) { b.add('paper', at(box(0.24, 0.003, 0.12), desk.x - 0.62, top + 0.003, desk.z + 0.26, 0, 0.5, 0)); b.add('paper', at(box(0.11, 0.002, 0.15), desk.x - 0.55, top + 0.007, desk.z + 0.2, 0, -0.3, 0)); }
  return out;
}

export { Batch };
