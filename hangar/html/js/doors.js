// Hangar — Doors, the lift and the wall switches: the base reacting to the walker and to clicks.
//
// Doors (Ruling R15): every door sector gets a real frame on both portal faces, brushed-steel jambs and
// lintel with depth, an architrave where the room's wall carries on beside the opening, and a hazard-striped
// threshold plate; and two panels split along a horizontal seam (hazard bands either side of it) that part
// in OPEN_TIME with an ease, the top one into the lintel space above the door's ceiling, the bottom one into
// the floor. A door opens while the walker announces it (Walker calls onApproach for doors on its path within
// 3 m, and while it stands in one) and closes NEAR_HOLD after the last announcement, never while the walker
// is in or right beside it. A click opens a closed door for CLICK_HOLD, or closes an open one the walker is
// not using. Door sectors keep their ceiling at the open height (Ruling R1): the passage itself never moves.
//
// The lift: the lift sector's floor rides on a steel block (skirt down to below the low landing), eased at
// up to LIFT_V; Walker drives it through ride/call promises and reads height() and duration().
// Switches: a plate with a toggle lever and a status lamp on the wall beside a door; each one switches its
// room's lights (LightRig.setRoom).

import * as THREE from 'three';
import { doorFrames, doorPoint, wallBeside, planSwitches, JAMB, LINTEL, FRAME_DEPTH } from './propplan.js';

export const OPEN_TIME = 1.2; // s for the panels to part or meet
export const NEAR_HOLD = 4; // s a door stays open after the walker's last announcement
export const CLICK_HOLD = 10; // s a clicked door stays open
const KEEP_CLEAR = 0.8; // m: never close while the walker is this close to the door sector
const PANEL_T = 0.08; // panel thickness
const SEAM = 0.004; // gap between the closed panels
const BAND = 0.1; // hazard band height either side of the seam
const LIFT_V = 0.6; // m/s, the lift's peak speed (smoothstep: average is 2/3 of it)

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Greybox stand-ins worn until the scanned material arrives.
const GREYS = {
  'mat:steel-brushed': { color: 0xa9b0b6, metalness: 0.9, roughness: 0.35 },
  'mat:steel': { color: 0x8d96a0, metalness: 0.8, roughness: 0.5 },
  'mat:hazard': { color: 0xd9a81e, metalness: 0.3, roughness: 0.6 },
  'mat:diamond-plate': { color: 0x9aa0a6, metalness: 0.9, roughness: 0.4 },
  'mat:computer': { color: 0x4d6a7c, metalness: 0.7, roughness: 0.5 },
};

/**
 * Materials for the props by manifest tag: greybox until set() hands over the scanned material, then every
 * mesh that wears the tag switches. Greys are owned here (dispose), scanned materials by the page.
 */
export class PropMaterials {
  constructor() {
    this.current = new Map();
    this.meshes = new Map();
    this.greys = [];
  }

  /** The material for `tag` now; `mesh` (optional) is switched when the scanned one arrives. */
  get(tag, mesh = null) {
    let m = this.current.get(tag);
    if (!m) {
      const g = GREYS[tag] ?? { color: 0x888888, metalness: 0.5, roughness: 0.6 };
      m = new THREE.MeshStandardMaterial({ ...g, name: `${tag} (grey)` });
      this.greys.push(m);
      this.current.set(tag, m);
    }
    if (mesh) {
      if (!this.meshes.has(tag)) this.meshes.set(tag, new Set());
      this.meshes.get(tag).add(mesh);
    }
    return m;
  }

  has(tag) { return this.meshes.has(tag); }

  set(tag, material) {
    if (!material) return;
    this.current.set(tag, material);
    for (const m of this.meshes.get(tag) ?? []) m.material = material;
  }

  dispose() { for (const g of this.greys) g.dispose(); }
}

/**
 * A box sx × sy × sz centred on the origin whose UVs are in metres / 2 (the level's convention, Ruling R3), so
 * scanned materials keep their texel density on every face whatever the box's size.
 */
export function boxGeo(sx, sy, sz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.attributes.uv;
  // BoxGeometry faces in order +x, -x, +y, -y, +z, -z, four vertices each: (u, v) spans (z, y), (x, z), (x, y).
  const span = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, (uv.getX(i) * span[f][0]) / 2, (uv.getY(i) * span[f][1]) / 2);
  }
  return g;
}

/** A mesh placed in a door's frame: (along, y, across) in the door's axes, `sector` for its probe. */
function placed(geo, mat, f, along, y, across, sector) {
  const m = new THREE.Mesh(geo, mat);
  const [x, z] = doorPoint(f, along, across);
  m.position.set(x, y, z);
  // Local x runs along the opening (u), local z through it (n).
  m.rotation.y = Math.atan2(-f.u[1], f.u[0]);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.sector = sector;
  return m;
}

export class Doors {
  /**
   * `meshes` is buildLevelMesh's output (unused for now: the passage lining stays as built), `assets` a
   * PropMaterials. opts.sunlit (Set of sectors the sun reaches) marks doors whose motion must refresh the sun's
   * shadow map.
   */
  constructor(level, meshes, assets, opts = {}) {
    void meshes;
    this.level = level;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'doors';
    this.frames = doorFrames(level);
    this.time = 0;
    this.walker = null;
    this.interactive = [];
    this.byId = new Map();
    const sunlit = opts.sunlit ?? new Set();
    for (const f of this.frames) {
      const d = {
        f, t: 0, last: -Infinity, hold: 0, panels: [],
        sun: f.sides.some((s) => s.room && sunlit.has(s.room)) || sunlit.has(f.sector),
        moving: false,
      };
      this.build(d);
      this.byId.set(f.sector, d);
    }
  }

  build(d) {
    const { f } = d;
    const A = this.assets, g = this.group;
    const H = f.height, W = f.width;
    const brushed = (m) => { m.material = A.get('mat:steel-brushed', m); return m; };
    const hazard = (m) => { m.material = A.get('mat:hazard', m); return m; };
    const tag = (m) => { m.userData.interactive = { kind: 'door', id: f.sector }; this.interactive.push(m); return m; };
    for (const side of f.sides) {
      const face = (f.depth / 2) * side.s;
      const sec = side.room ?? f.sector;
      // Jambs and lintel, centred on the portal plane: half in the passage, half standing proud of the room's wall.
      for (const sg of [-1, 1]) g.add(tag(brushed(placed(boxGeo(JAMB, H, FRAME_DEPTH), null, f, sg * (W / 2 - JAMB / 2), f.floor + H / 2, face, sec))));
      g.add(tag(brushed(placed(boxGeo(W - 2 * JAMB, LINTEL, FRAME_DEPTH), null, f, 0, f.ceil - LINTEL / 2, face, sec))));
      // Architrave: a flat plate on the room's wall round the opening, where the wall carries on beside it.
      const room = side.room ? this.level.byId.get(side.room) : null;
      if (room) {
        for (const sg of [-1, 1]) {
          if (!wallBeside(this.level, f, side, sg * (W / 2 + 0.06))) continue;
          const top = Math.min(room.ceil, f.ceil + 0.1);
          g.add(tag(brushed(placed(boxGeo(0.1, top - room.floor, 0.024), null, f, sg * (W / 2 + 0.05), room.floor + (top - room.floor) / 2, face + side.s * 0.012, sec))));
        }
        if (room.ceil > f.ceil + 0.12) g.add(tag(brushed(placed(boxGeo(W + 0.2, 0.1, 0.024), null, f, 0, f.ceil + 0.05, face + side.s * 0.012, sec))));
      }
      // Hazard threshold plate under the frame, on the passage's own floor (never over a lower room or the lift).
      const plate = hazard(placed(boxGeo(W - 2 * JAMB, 0.012, FRAME_DEPTH / 2), null, f, 0, f.floor + 0.006, face - side.s * (FRAME_DEPTH / 4), f.sector));
      plate.castShadow = false;
      g.add(plate);
    }
    // Panels: bottom and top halves meeting at a horizontal seam, with hazard bands either side of it.
    const half = (H - SEAM) / 2;
    for (const which of [-1, 1]) { // -1 bottom, +1 top
      const p = new THREE.Group();
      const part = (geo, mtag) => {
        const m = new THREE.Mesh(geo, null);
        m.material = A.get(mtag, m);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.sector = f.sector;
        p.add(tag(m));
        return m;
      };
      part(boxGeo(W - 0.02, half, PANEL_T), 'mat:steel');
      for (const fs of [-1, 1]) {
        const band = part(boxGeo(W - 0.02, BAND, 0.006), 'mat:hazard');
        band.position.set(0, -which * (half / 2 - BAND / 2), fs * (PANEL_T / 2 + 0.003));
        band.castShadow = false;
      }
      const [x, z] = f.c;
      p.position.set(x, 0, z);
      p.rotation.y = Math.atan2(-f.u[1], f.u[0]);
      p.userData.closedY = f.floor + (which < 0 ? half / 2 : H - half / 2);
      p.userData.travel = which * (half + 0.03);
      p.position.y = p.userData.closedY;
      g.add(p);
      d.panels.push(p);
    }
  }

  /** The walker, so a door never closes on it (set by the scene). */
  setWalker(w) { this.walker = w; }

  /** Fully open: the walker may step in. */
  isOpen(sectorId) {
    const d = this.byId.get(sectorId);
    return !d || d.t >= 1;
  }

  /** The walker's path reaches this door within 3 m (or it stands in it): open, and stay open a while. */
  onApproach(sectorId) {
    const d = this.byId.get(sectorId);
    if (d) d.last = this.time;
  }

  /** A click: open a closed door for a while, or close an open one the walker is not near. */
  operate(sectorId) {
    const d = this.byId.get(sectorId);
    if (!d) return false;
    if (this.wanted(d, null)) {
      if (this.near(d) || this.time - d.last < 0.5) return false; // the walker is using it
      d.last = -Infinity;
      d.hold = 0;
    } else {
      d.hold = CLICK_HOLD;
    }
    return true;
  }

  near(d, pose = null) {
    const p = pose ?? this.walker ?? null;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
    const { f } = d;
    // Same storey only: on the lift's lower landing the walker stands right under the exit door's sill.
    const feet = Number.isFinite(p.floor) ? p.floor : Number.isFinite(p.y) ? p.y - 1.7 : f.floor; // a Walker, or a pose (eye height)
    if (feet < f.floor - 0.8 || feet > f.ceil) return false;
    const rx = p.x - f.c[0], rz = p.z - f.c[1];
    const a = Math.abs(rx * f.u[0] + rz * f.u[1]) - f.width / 2, n = Math.abs(rx * f.n[0] + rz * f.n[1]) - f.depth / 2;
    return Math.hypot(Math.max(a, 0), Math.max(n, 0)) < KEEP_CLEAR;
  }

  wanted(d, pose) {
    return this.time - d.last < NEAR_HOLD || d.hold > 0 || this.near(d, pose);
  }

  /** Steps every door; returns true if a door the sun can see moved (the scene refreshes the sun's shadow). */
  update(dt, walkerPose) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.time += dt;
    let sun = false;
    for (const d of this.byId.values()) {
      d.hold = Math.max(0, d.hold - dt);
      const want = this.wanted(d, walkerPose);
      const t0 = d.t;
      d.t = clamp01(d.t + (want ? dt : -dt) / OPEN_TIME);
      const moving = d.t !== t0;
      if (moving || d.moving) {
        const e = smooth(d.t);
        for (const p of d.panels) p.position.y = p.userData.closedY + p.userData.travel * e;
        if (d.sun) sun = true; // while moving, and once more on the frame it stops
      }
      d.moving = moving;
    }
    return sun;
  }

  /** Door state for checks: { sector: t } (0 shut, 1 open). */
  get state() { return Object.fromEntries([...this.byId].map(([k, d]) => [k, d.t])); }
}

export class Lift {
  /**
   * `def` is a Level lift { sector, low, high }. The sector's floor mesh from buildLevelMesh becomes the
   * platform's top; a skirt of brushed steel hangs from it to below the low landing, with a hazard band at
   * the top edge.
   */
  constructor(level, meshes, assets, def, opts = {}) {
    this.level = level;
    this.def = def;
    this.sector = def.sector;
    this.h = def.low;
    this.motion = null;
    this.group = new THREE.Group();
    this.group.name = 'lift';
    this.tops = (meshes.bySector.get(def.sector) ?? []).filter((m) => m.userData.surface === 'floor');
    const s = level.byId.get(def.sector);
    this.sun = !!opts.sunlit?.has(def.sector);
    this.interactive = [];
    if (s) this.buildSkirt(s, assets);
    this.apply();
  }

  buildSkirt(s, A) {
    const drop = this.def.high - this.def.low + 0.1;
    const poly = s.poly;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const ox = -(bz - az) / len, oz = (bx - ax) / len; // outward (the interior lies to the left of a→b)
      const mx = (ax + bx) / 2 - ox * 0.012, mz = (az + bz) / 2 - oz * 0.012;
      const yaw = Math.atan2(ox, oz);
      for (const [tag, h, y0] of [['mat:steel-brushed', drop - 0.08, -0.08 - (drop - 0.08) / 2], ['mat:hazard', 0.08, -0.04]]) {
        const m = new THREE.Mesh(boxGeo(len - 0.024, h, 0.02), null);
        m.material = A.get(tag, m);
        m.position.set(mx, y0, mz);
        m.rotation.y = yaw;
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.sector = s.id;
        m.userData.liftY = y0;
        this.group.add(m);
      }
    }
  }

  apply() {
    const dy = this.h - this.def.low;
    for (const m of this.tops) { m.position.y = dy; m.updateMatrixWorld(); }
    for (const m of this.group.children) m.position.y = this.h + m.userData.liftY;
  }

  height(sectorId) { return sectorId === undefined || sectorId === this.sector ? this.h : NaN; }

  /** Seconds a move from `from` to `to` takes (eased: the peak speed is LIFT_V). */
  duration(from, to) {
    const a = Number.isFinite(from) ? from : this.h, b = Number.isFinite(to) ? to : this.h;
    return (Math.abs(b - a) / LIFT_V) * 1.5;
  }

  move(to) {
    if (!Number.isFinite(to)) return Promise.resolve();
    this.motion?.resolve();
    return new Promise((resolve) => {
      this.motion = { from: this.h, to, t: 0, dur: this.duration(this.h, to), resolve };
      if (this.motion.dur <= 1e-6) { this.h = to; this.apply(); this.motion = null; resolve(); }
    });
  }

  /** At rest at height `h` (no move under way). */
  settled(h) { return !this.motion && Math.abs(this.h - h) < 1e-6; }

  /** Bring the platform to where the walker waits. */
  call(from, to) { void from; return this.move(to); }

  /** Carry the walker from `from` to `to`. */
  ride(from, to) { void from; return this.move(to); }

  /** Steps the platform; true if it moved and the sun can see it. */
  update(dt) {
    const m = this.motion;
    if (!m) return false;
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    m.t += dt;
    const k = clamp01(m.t / m.dur);
    this.h = m.from + (m.to - m.from) * smooth(k);
    this.apply();
    if (k >= 1) { this.motion = null; m.resolve(); }
    return this.sun;
  }
}

export class Switches {
  /** Wall switches (propplan.planSwitches); `rig` is the LightRig they drive. */
  constructor(level, frames, assets, rig, hasLights) {
    this.rig = rig;
    this.group = new THREE.Group();
    this.group.name = 'switches';
    this.list = planSwitches(level, frames, hasLights);
    this.interactive = [];
    this.byId = new Map();
    this.ledMats = [];
    for (const s of this.list) {
      const g = new THREE.Group();
      g.position.set(s.x + s.nx * 0.002, s.y, s.z + s.nz * 0.002);
      g.rotation.y = Math.atan2(s.nx, s.nz); // local +z points out of the wall
      const plate = new THREE.Mesh(boxGeo(0.1, 0.16, 0.014), null);
      plate.material = assets.get('mat:steel-brushed', plate);
      plate.position.z = 0.007;
      const housing = new THREE.Mesh(boxGeo(0.034, 0.05, 0.016), new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.5, metalness: 0.4 }));
      housing.position.set(0, -0.012, 0.022);
      const lever = new THREE.Group();
      lever.position.set(0, -0.012, 0.03);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0055, 0.04, 10), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.3, metalness: 1 }));
      stick.position.y = 0.02;
      lever.add(stick);
      lever.rotation.x = Math.PI / 2 - 0.5;
      const led = new THREE.MeshBasicMaterial({ color: 0x2aff60 });
      this.ledMats.push(led);
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 12), led);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(0, 0.048, 0.016);
      // Click target: an invisible box a little larger than the plate.
      const hit = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.08), new THREE.MeshBasicMaterial());
      hit.visible = false;
      hit.position.z = 0.04;
      hit.userData.interactive = { kind: 'switch', id: s.id };
      for (const m of [plate, housing, stick, lamp]) { m.castShadow = true; m.receiveShadow = true; m.userData.sector = s.room; }
      g.add(plate, housing, lever, lamp, hit);
      this.group.add(g);
      this.interactive.push(hit);
      this.byId.set(s.id, { s, lever, led, k: 1 });
    }
  }

  operate(id) {
    const w = this.byId.get(id);
    if (!w || !this.rig) return false;
    return this.rig.setRoom(w.s.room, !this.rig.roomOn(w.s.room));
  }

  update(dt) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    for (const w of this.byId.values()) {
      const on = this.rig?.roomOn(w.s.room) ?? true;
      w.k = on ? Math.min(1, w.k + dt / 0.15) : Math.max(0, w.k - dt / 0.15);
      w.lever.rotation.x = Math.PI / 2 - 0.5 + (1 - smooth(w.k)); // sticks out of the wall: tipped up = on, down = off
      w.led.color.setRGB(on ? 0.16 : 1.6, on ? 1.6 : 0.06, on ? 0.38 : 0.03);
    }
  }
}
