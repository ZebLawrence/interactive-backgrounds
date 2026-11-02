// Hangar — Prop plan: where the door frames, wall switches and computer consoles go. Pure: no three.js
// (doors.js and screens.js turn the plan into meshes).
//
// A door sector is a rectangle between two portals: `doorFrames` gives each one's axes (u along the
// opening, n through it), size and the room on either side. Switches sit on the room-side wall beside
// a door, consoles stand against the solid walls of the computer rooms. Units: metres, x east, z south.

import { sectorAt } from './level.js';
import { clearanceAt } from './navgraph.js';

export const JAMB = 0.16; // frame jamb width in the opening (m)
export const LINTEL = 0.14; // frame lintel height under the door's ceiling (m)
export const FRAME_DEPTH = 0.18; // frame depth through the wall (m), centred on the portal plane
export const SWITCH_OUT = 0.45; // switch centre beyond the opening's edge (m)
export const SWITCH_Y = 1.3; // above the room floor (m)
export const CONSOLE_W = 1.0; // one console unit's width along the wall (m)
export const CONSOLE_GAP = 0.04;
export const CONSOLE_DEPTH = 0.24; // how far a console stands out from its wall: under the walker's 0.35 m clearance
const CONSOLE_END = 0.9; // keep this far from a wall's ends (corners, doorways)
const MAX_PER_WALL = 4;
const MAX_CONSOLES = 16;
const NO_SWITCH = ['corridor', 'door', 'window', 'sky', 'lift'];

const key = ([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`;

/** Map "a>b" (directed edge of a sector polygon) -> sector, for finding a polygon edge's neighbour. */
function edgeOwners(level) {
  const owner = new Map();
  for (const s of level.sectors) s.poly.forEach((a, i) => owner.set(`${key(a)}>${key(s.poly[(i + 1) % s.poly.length])}`, s));
  return owner;
}

/**
 * One entry per Level door: { sector, floor, ceil, height, c: [x, z] centre, u: [x, z] along the opening,
 * n: [x, z] through it, width, depth, sides: [{ s: -1 | 1, room: sectorId | null }] }. The two portal faces
 * lie at c ± n·depth/2; side s's room is the sector just outside face s.
 */
export function doorFrames(level) {
  const owner = edgeOwners(level);
  const out = [];
  for (const d of level.doors) {
    const s = level.byId.get(d.sector);
    if (!s) continue;
    // The longest edge shared with another sector is a portal: it gives the axis along the opening.
    let best = null;
    s.poly.forEach((a, i) => {
      const b = s.poly[(i + 1) % s.poly.length];
      const t = owner.get(`${key(b)}>${key(a)}`);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (t && (!best || len > best.len)) best = { a, b, len };
    });
    if (!best) continue;
    const u = [(best.b[0] - best.a[0]) / best.len, (best.b[1] - best.a[1]) / best.len];
    const n = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (const [x, z] of s.poly) {
      const pu = x * u[0] + z * u[1], pn = x * n[0] + z * n[1];
      u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); n0 = Math.min(n0, pn); n1 = Math.max(n1, pn);
    }
    const cu = (u0 + u1) / 2, cn = (n0 + n1) / 2;
    const c = [u[0] * cu + n[0] * cn, u[1] * cu + n[1] * cn];
    const depth = n1 - n0, width = u1 - u0;
    const sides = [-1, 1].map((sg) => {
      const off = depth / 2 + 0.08;
      const room = sectorAt(level, c[0] + n[0] * off * sg, c[1] + n[1] * off * sg);
      return { s: sg, room: room && room.id !== s.id ? room.id : null };
    });
    out.push({ sector: s.id, floor: s.floor, ceil: s.ceil, height: s.ceil - s.floor, c, u, n, width, depth, sides });
  }
  return out;
}

/** Point at (along, across) in a door's frame: c + u·along + n·across. */
export const doorPoint = (f, along, across) => [f.c[0] + f.u[0] * along + f.n[0] * across, f.c[1] + f.u[1] * along + f.n[1] * across];

/**
 * Does the room's wall continue past the opening at `along` on side `side`? True when the point just in
 * front of the portal plane is in the room and the point just behind it is not (a wall, not more room).
 */
export function wallBeside(level, f, side, along) {
  const face = (f.depth / 2) * side.s;
  const front = sectorAt(level, ...doorPoint(f, along, face + 0.06 * side.s));
  const back = sectorAt(level, ...doorPoint(f, along, face - 0.06 * side.s));
  return !!front && front.id === side.room && (!back || back.id !== side.room);
}

/**
 * Wall switches: one per lit room that a door opens into, on the room-side wall beside the opening, at
 * SWITCH_Y above the room floor. { id, door, room, x, y, z, nx, nz } with (nx, nz) the wall's outward normal.
 * `hasLights(sectorId)` (optional) skips rooms with nothing to switch.
 */
export function planSwitches(level, frames = doorFrames(level), hasLights = () => true) {
  const out = [];
  const seen = new Set();
  for (const f of frames) {
    for (const side of f.sides) {
      const room = side.room && level.byId.get(side.room);
      if (!room || NO_SWITCH.some((t) => room.tags.has(t)) || seen.has(room.id) || !hasLights(room.id)) continue;
      const face = (f.depth / 2) * side.s;
      const half = f.width / 2 + SWITCH_OUT;
      const put = (x, z, nx, nz) => {
        out.push({ id: `switch-${room.id}`, door: f.sector, room: room.id, x, y: room.floor + SWITCH_Y, z, nx, nz });
        seen.add(room.id);
      };
      for (const along of [half, -half]) {
        if (![-0.1, 0, 0.1].every((dk) => wallBeside(level, f, side, along + dk))) continue;
        put(...doorPoint(f, along, face), f.n[0] * side.s, f.n[1] * side.s);
        break;
      }
      if (seen.has(room.id)) continue;
      // The opening ends a passage as wide as the door: the switch goes on the passage's side wall, a little
      // way into the room, facing across it.
      const across = face + side.s * (FRAME_DEPTH / 2 + SWITCH_OUT);
      for (const sg of [1, -1]) {
        const inRoom = (a) => sectorAt(level, ...doorPoint(f, a, across))?.id === room.id;
        const edge = sg * (f.width / 2);
        if (!inRoom(edge - sg * 0.06) || inRoom(edge + sg * 0.06)) continue;
        if (![-0.1, 0.1].every((dk) => {
          const a = across + dk * side.s;
          return sectorAt(level, ...doorPoint(f, edge - sg * 0.06, a))?.id === room.id && sectorAt(level, ...doorPoint(f, edge + sg * 0.06, a))?.id !== room.id;
        })) continue;
        put(...doorPoint(f, edge, across), -f.u[0] * sg, -f.u[1] * sg);
        break;
      }
    }
  }
  return out;
}

/**
 * Console units against the solid walls of the `computer` sectors: banks of up to MAX_PER_WALL units,
 * centred on each long wall, kept CONSOLE_END from the wall's ends and off any spot where a switch or a door
 * frame sits. { id, sector, x, z, floor, yaw, nx, nz, wall } with (x, z) on the wall face and (nx, nz) pointing
 * into the room; yaw turns a unit built facing +z to face the room.
 */
export function planConsoles(level, switches = []) {
  const out = [];
  for (const w of level.walls) {
    if (w.kind !== 'solid') continue;
    const s = level.byId.get(w.front);
    if (!s?.tags.has('computer')) continue;
    const [ax, az] = w.a, [bx, bz] = w.b;
    const len = Math.hypot(bx - ax, bz - az);
    const usable = len - 2 * CONSOLE_END;
    const n = Math.min(MAX_PER_WALL, Math.floor((usable + CONSOLE_GAP) / (CONSOLE_W + CONSOLE_GAP)));
    if (n < 1) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const nx = uz, nz = -ux; // into the front sector (wallQuads' rule)
    const span = n * CONSOLE_W + (n - 1) * CONSOLE_GAP;
    for (let k = 0; k < n; k++) {
      const t = (len - span) / 2 + k * (CONSOLE_W + CONSOLE_GAP) + CONSOLE_W / 2;
      const x = ax + ux * t, z = az + uz * t;
      // The whole footprint stands on this sector's floor, clear of other walls, switches and frames.
      let ok = true;
      for (const du of [-CONSOLE_W / 2 + 0.02, 0, CONSOLE_W / 2 - 0.02]) {
        const px = x + ux * du + nx * (CONSOLE_DEPTH / 2), pz = z + uz * du + nz * (CONSOLE_DEPTH / 2);
        if (sectorAt(level, px, pz)?.id !== s.id) ok = false;
      }
      if (clearanceAt(level, x + nx * 0.6, z + nz * 0.6) < 0.55) ok = false; // a corner or a jutting wall right in front
      if (switches.some((q) => Math.hypot(q.x - x, q.z - z) < CONSOLE_W / 2 + 0.3)) ok = false;
      if (!ok) continue;
      out.push({ id: `console-${out.length}`, sector: s.id, x, z, floor: s.floor, yaw: Math.atan2(nx, nz), nx, nz, wall: `${w.front}:${key(w.a)}` });
      if (out.length >= MAX_CONSOLES) return out;
    }
  }
  return out;
}
