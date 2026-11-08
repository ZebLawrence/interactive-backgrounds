#!/usr/bin/env node
// Hangar — authoring script for hangar/html/data/e1m1.json.
//
// Every polygon below was traced by hand, in pixels, off the published top-down E1M1 map
// "E1M1dots.png" (Doom Wiki on Fandom, 999x619 px, north up; see REFERENCES.md), then
// converted to Doom units here. No WAD data is read or used. Heights are in Doom units and
// were set from the published screenshots and walkthroughs, then adjusted for the spec
// (REFERENCES.md lists every adjustment).
//
// The script also makes shared vertices exact: any vertex that lies on another sector's edge is
// inserted into that edge, so neighbouring sectors always meet vertex to vertex.
//
//   node hangar/tools/build-e1m1.mjs            # writes hangar/html/data/e1m1.json
//   node hangar/tools/build-e1m1.mjs --svg f.svg # also draws a plan for checking the trace

import { mkdirSync, writeFileSync } from 'node:fs';

// Pixel → Doom units. Scale 4 Doom units per map pixel (see REFERENCES.md, "Scale"); the
// player start (pixel 398,340) is put at Doom (1056, -3616), E1M1's own start spot.
const S = 4;
const ANCHOR = { px: 398, py: 340, x: 1056, y: -3616 };
const X = (px) => Math.round((px - ANCHOR.px) * S + ANCHOR.x);
const Y = (py) => Math.round(-(py - ANCHOR.py) * S + ANCHOR.y);
const pt = ([px, py]) => [X(px), Y(py)];

const SKY = 400; // courtyard "ceiling": the height the base walls rise to round the open sky

// [id, pixel polygon, floor, ceil, tags, light]
const SECTORS = [
  // ── West: the green-armour security post, with windows onto an outdoor slime pit ─────────
  ['west-ring', [[2, 200], [32, 172], [183, 172], [32, 199], [32, 324], [183, 352], [32, 352], [2, 323]], -24, SKY, ['sky', 'mat:regolith'], 255],
  ['west-pit', [[32, 199], [183, 172], [183, 200], [152, 237], [143, 237], [143, 231], [115, 231], [115, 237], [97, 237], [97, 245], [91, 245], [91, 277], [97, 277], [97, 285], [115, 285], [115, 291], [143, 291], [143, 285], [152, 285], [183, 323], [183, 352], [32, 324]], -40, SKY, ['sky', 'slime', 'mat:concrete'], 255],
  ['armor-win-n', [[115, 231], [143, 231], [143, 237], [115, 237]], 80, 160, ['window', 'mat:steel'], 192],
  ['armor-win-s', [[115, 285], [143, 285], [143, 291], [115, 291]], 80, 160, ['window', 'mat:steel'], 192],
  ['armor-win-w', [[91, 245], [97, 245], [97, 277], [91, 277]], 80, 160, ['window', 'mat:steel'], 192],
  ['armor-alcove', [[97, 237], [115, 237], [143, 237], [152, 237], [157, 240], [157, 280], [152, 285], [143, 285], [115, 285], [97, 285], [97, 277], [97, 245]], 64, 168, ['mat:steel'], 208],
  ['armor-plat', [[152, 237], [182, 227], [197, 248], [197, 268], [182, 296], [152, 285], [157, 280], [157, 240]], 64, 184, ['mat:panel-brown'], 192],
  ['armor-step-1', [[197, 248], [211, 248], [211, 268], [197, 268]], 48, 184, ['mat:steel'], 192],
  ['armor-step-2', [[211, 248], [225, 248], [225, 268], [211, 268]], 32, 184, ['mat:steel'], 192],
  ['armor-step-3', [[225, 248], [240, 248], [240, 268], [225, 268]], 16, 184, ['mat:steel'], 192],
  ['armor-room', [[198, 213], [268, 213], [278, 239], [278, 280], [268, 311], [198, 311], [182, 296], [197, 268], [225, 268], [240, 268], [240, 248], [225, 248], [211, 248], [197, 248], [182, 227]], 0, 184, ['mat:panel-brown'], 176],
  ['cor-w', [[278, 239], [322, 232], [322, 290], [278, 280]], 0, 96, ['corridor', 'mat:panel-brown'], 160],

  // ── Start room: a raised platform with a short stair down, a sunken blue floor, windows east ─
  ['start-main', [[322, 198], [350, 198], [380, 184], [432, 184], [462, 184], [462, 234], [430, 228], [365, 228], [365, 292], [430, 292], [462, 286], [462, 312], [440, 312], [440, 300], [360, 300], [360, 312], [322, 312], [322, 290], [322, 232]], 0, 176, ['mat:panel-brown'], 192],
  ['start-pit', [[365, 228], [430, 228], [462, 234], [462, 286], [430, 292], [365, 292]], -16, 176, ['mat:steel'], 176],
  ['start-step', [[360, 300], [440, 300], [440, 312], [360, 312]], 12, 176, ['mat:steel'], 192],
  ['start-plat', [[322, 312], [360, 312], [440, 312], [462, 312], [462, 330], [450, 330], [420, 350], [380, 350], [350, 330], [322, 330]], 24, 176, ['mat:panel-brown'], 208],
  ['start-win-1', [[462, 226], [468, 226], [468, 250], [462, 250]], 24, 128, ['window', 'mat:steel'], 192],
  ['start-win-2', [[462, 262], [468, 262], [468, 286], [462, 286]], 24, 128, ['window', 'mat:steel'], 192],
  ['door-yard', [[462, 298], [468, 298], [468, 322], [462, 322]], 0, 128, ['door', 'mat:steel'], 176],

  // ── North corridor and door into the computer room ─────────────────────────────────────────
  ['cor-n1', [[432, 184], [462, 184], [467, 122], [437, 110]], 0, 80, ['corridor', 'mat:panel-brown'], 144],
  ['cor-n2', [[437, 110], [467, 122], [495, 113], [495, 88], [488, 88]], 0, 80, ['corridor', 'mat:panel-brown'], 144],
  ['door-comp', [[495, 88], [505, 88], [505, 113], [495, 113]], 0, 80, ['door', 'mat:steel'], 160],

  // ── Computer room, with the window south onto the courtyard ────────────────────────────────
  ['comp-main', [[530, 10], [620, 10], [620, 158], [530, 158], [518, 146], [518, 113], [505, 113], [505, 88], [518, 88], [518, 22]], 0, 224, ['computer', 'mat:computer'], 208],
  ['comp-core', [[620, 10], [708, 10], [720, 22], [720, 100], [712, 108], [712, 113], [712, 142], [712, 158], [640, 158], [620, 158]], 16, 224, ['computer', 'mat:computer'], 208],
  ['comp-window', [[530, 158], [620, 158], [640, 158], [636, 172], [534, 172]], 40, 160, ['window', 'mat:steel'], 208],

  // ── Curved hallway down to the slime hall (the "shadow line" end) ──────────────────────────
  ['hall-a', [[712, 113], [765, 113], [738, 165], [712, 142]], 16, 96, ['corridor', 'mat:panel-brown'], 160],
  ['hall-b', [[765, 113], [812, 137], [765, 163], [738, 165]], 0, 96, ['corridor', 'mat:panel-brown'], 144],
  ['hall-c', [[812, 137], [830, 186], [772, 224], [770, 193], [795, 188], [765, 163]], -16, 80, ['corridor', 'mat:panel-brown'], 128],

  // ── The slime hall: a tall hall over a pool, crossed by a four-leg zigzag walkway ──────────
  ['zz-landing', [[772, 224], [830, 186], [888, 220], [848, 227], [817, 227]], -16, 320, ['walkway', 'mat:grate'], 160],
  ['zz-leg-1', [[817, 227], [780, 262], [817, 253], [848, 227]], -16, 320, ['walkway', 'mat:grate'], 160],
  ['zz-leg-2', [[780, 262], [845, 290], [882, 281], [817, 253]], -16, 320, ['walkway', 'mat:grate'], 160],
  ['zz-leg-3', [[845, 290], [810, 328], [842, 330], [882, 281]], -16, 320, ['walkway', 'mat:grate'], 160],
  ['zz-leg-4', [[810, 328], [808, 352], [835, 347], [842, 330]], -16, 320, ['walkway', 'mat:grate'], 160],
  ['zz-slime-w', [[772, 224], [817, 227], [780, 262], [845, 290], [810, 328], [808, 352], [772, 340]], -48, 320, ['slime', 'mat:concrete'], 176],
  ['zz-slime-e', [[848, 227], [888, 220], [908, 245], [923, 303], [893, 333], [880, 343], [835, 347], [842, 330], [882, 281], [817, 253]], -48, 320, ['slime', 'mat:concrete'], 176],
  ['zz-ledge', [[888, 220], [918, 217], [940, 292], [923, 303], [908, 245]], 48, 320, ['mat:panel-brown'], 144],
  ['zz-window', [[765, 240], [772, 240], [772, 290], [765, 290]], 0, 200, ['window', 'mat:steel'], 176],

  // ── The courtyard: open sky, regolith, a slime pool with channels, a raised platform ───────
  ['yard-west', [[468, 198], [490, 185], [530, 185], [534, 172], [538, 172], [538, 232], [530, 232], [500, 245], [502, 292], [546, 308], [546, 350], [468, 350]], -16, SKY, ['sky', 'courtyard', 'mat:regolith'], 255],
  ['yard-slime', [[538, 172], [562, 172], [562, 232], [578, 232], [612, 242], [631, 270], [617, 300], [572, 307], [572, 350], [546, 350], [546, 308], [502, 292], [500, 245], [530, 232], [538, 232]], -32, SKY, ['sky', 'courtyard', 'slime', 'mat:concrete'], 255],
  ['yard-east', [[562, 172], [636, 172], [640, 193], [658, 207], [695, 232], [765, 232], [765, 350], [655, 350], [640, 350], [612, 350], [572, 350], [572, 307], [617, 300], [631, 270], [612, 242], [578, 232], [562, 232]], -16, SKY, ['sky', 'courtyard', 'mat:regolith'], 255],
  ['yard-step', [[655, 350], [765, 350], [732, 359], [655, 359]], 4, SKY, ['sky', 'courtyard', 'mat:concrete'], 255],
  ['yard-platform', [[655, 359], [732, 359], [655, 380]], 24, SKY, ['sky', 'courtyard', 'mat:concrete'], 255],

  // ── South corridor, the hidden tunnel out to the courtyard (secret #1) ─────────────────────
  ['cor-s', [[808, 352], [835, 347], [835, 428], [808, 428]], -16, 64, ['corridor', 'mat:panel-brown'], 144],
  ['door-tunnel', [[800, 380], [808, 380], [808, 407], [800, 407]], -16, 64, ['door', 'mat:steel'], 112],
  ['tun-step-1', [[788, 380], [800, 380], [800, 407], [788, 407]], -24, 56, ['corridor', 'mat:concrete'], 112],
  ['tun-step-2', [[776, 380], [788, 380], [788, 407], [776, 407]], -32, 48, ['corridor', 'mat:concrete'], 112],
  ['tun-step-3', [[765, 380], [776, 380], [776, 407], [765, 407]], -40, 40, ['corridor', 'mat:concrete'], 112],
  ['tun-step-4', [[753, 380], [765, 380], [765, 407], [753, 407]], -48, 32, ['corridor', 'mat:concrete'], 112],
  ['tunnel-diag', [[683, 420], [745, 380], [753, 380], [753, 407], [683, 447]], -56, 24, ['corridor', 'mat:concrete'], 112],
  ['tunnel-bend', [[612, 407], [640, 407], [655, 420], [655, 447], [633, 440], [615, 425]], -56, 24, ['corridor', 'mat:concrete'], 112],
  ['tunnel-sq', [[655, 420], [683, 420], [683, 447], [655, 447]], -56, 24, ['corridor', 'mat:concrete'], 112],
  ['tun-up-1', [[612, 392], [640, 392], [640, 407], [612, 407]], -48, 32, ['corridor', 'mat:concrete'], 128],
  ['tun-up-2', [[612, 378], [640, 378], [640, 392], [612, 392]], -40, 40, ['corridor', 'mat:concrete'], 144],
  ['tun-up-3', [[612, 364], [640, 364], [640, 378], [612, 378]], -32, 48, ['corridor', 'mat:concrete'], 160],
  ['tun-up-4', [[612, 350], [640, 350], [640, 364], [612, 364]], -24, 56, ['corridor', 'mat:concrete'], 192],

  // ── The dark zone: a dim room with a raised dais, emergency lamps ──────────────────────────
  ['door-dark', [[808, 428], [835, 428], [835, 438], [808, 438]], -16, 64, ['door', 'mat:steel'], 96],
  ['dark-neck', [[808, 438], [835, 438], [842, 462], [800, 462]], -16, 96, ['dark', 'mat:concrete'], 72],
  ['dark-dais', [[790, 462], [800, 462], [842, 462], [857, 462], [857, 497], [849, 505], [798, 505], [790, 497]], -16, 144, ['dark', 'mat:steel'], 80],
  ['dark-step', [[798, 505], [849, 505], [849, 515], [798, 515]], -24, 144, ['dark', 'mat:steel'], 72],
  ['dark-room', [[752, 455], [782, 455], [790, 462], [790, 497], [798, 505], [798, 515], [849, 515], [849, 505], [857, 497], [857, 462], [863, 455], [892, 455], [892, 535], [880, 547], [837, 547], [808, 547], [764, 547], [752, 535]], -32, 144, ['dark', 'mat:concrete'], 64],

  // ── The way out: a lift up to a high exit room with the widest view ────────────────────────
  ['exit-lift', [[808, 547], [837, 547], [837, 562], [808, 562]], -32, 200, ['lift', 'mat:steel'], 128],
  ['door-exit', [[808, 562], [837, 562], [837, 572], [808, 572]], 104, 192, ['door', 'mat:steel'], 160],
  ['exit-room', [[800, 572], [808, 572], [837, 572], [843, 572], [856, 585], [856, 617], [787, 617], [787, 585]], 104, 272, ['exit', 'mat:steel'], 224],
  ['exit-win', [[795, 617], [848, 617], [848, 623], [795, 623]], 120, 256, ['window', 'mat:steel'], 224],
  ['exit-view', [[770, 623], [873, 623], [910, 700], [733, 700]], -160, 520, ['sky', 'mat:regolith'], 255],
];

const DOORS = ['door-yard', 'door-comp', 'door-tunnel', 'door-dark', 'door-exit'];
const LIFTS = [{ sector: 'exit-lift', low: -32, high: 104 }];

// Start: E1M1's player 1 spot on the raised platform, facing north (Doom angle 90).
const START = { px: 398, py: 340, angle: 90 };

// [id, kind, pixel pos, pixel look target, look height (Doom units, absolute) or null for eye level]
const POIS = [
  ['start', 'room', [398, 322], [398, 200], null],
  ['start-window', 'window', [450, 262], [600, 280], 40],
  ['armor-view', 'view', [170, 262], [40, 262], 20],
  ['armor-stairs', 'room', [255, 300], [180, 258], 110],
  ['comp-window', 'window', [585, 148], [590, 290], 20],
  ['comp-consoles', 'console', [575, 80], [578, 52], 60],
  ['comp-core', 'console', [665, 130], [650, 70], 80],
  ['hall-turn', 'room', [785, 150], [840, 260], 40],
  ['slime-landing', 'slime', [820, 212], [850, 320], -48],
  ['slime-leg', 'slime', [835, 272], [870, 315], -48],
  ['slime-window', 'window', [806, 245], [690, 270], 40],
  ['slime-look-up', 'view', [823, 338], [830, 210], 300],
  // The courtyard views look south and up at Mars (phobos.js hangs it over the courtyard's open side, about
  // 25° up): from the middle over the south parapet, down the slime channel past its reflection, and from the
  // raised platform out over the parapet to the horizon.
  ['yard-sky', 'view', [700, 300], [708, 400], 250],
  ['yard-pool', 'view', [600, 180], [585, 330], 200],
  ['yard-platform', 'view', [690, 360], [698, 440], 185],
  ['tunnel', 'room', [668, 433], [626, 380], -20],
  ['dark-room', 'room', [822, 530], [822, 480], 20],
  ['exit-view', 'window', [822, 605], [822, 760], -100],
];

// [kind, pixel pos, height (absolute Doom units), dir [x, y, z] or null, len (Doom units) or null]
const FIXTURES = [
  // start room: ceiling light strips over the platform and the pit, column lamps at the pit corners
  ['strip', [398, 322], 172, [1, 0, 0], 96],
  ['strip', [398, 245], 172, [1, 0, 0], 160],
  ['strip', [398, 275], 172, [1, 0, 0], 160],
  ['lamp', [368, 231], 120, null, null],
  ['lamp', [427, 231], 120, null, null],
  ['lamp', [368, 289], 120, null, null],
  ['lamp', [427, 289], 120, null, null],
  // armour post: lamps on the two pillars by the stair, a strip over the alcove
  ['lamp', [232, 233], 120, null, null],
  ['lamp', [232, 289], 120, null, null],
  ['strip', [127, 261], 164, [0, 1, 0], 120],
  // corridors north and west
  ['strip', [450, 150], 76, [0, 1, 0], 160],
  ['strip', [300, 261], 92, [1, 0, 0], 120],
  // computer room: ceiling strips, console glow
  ['strip', [570, 60], 220, [1, 0, 0], 200],
  ['strip', [570, 120], 220, [1, 0, 0], 200],
  ['strip', [670, 60], 220, [0, 1, 0], 200],
  ['lamp', [578, 52], 64, null, null],
  ['lamp', [578, 123], 64, null, null],
  // curved hallway
  ['strip', [740, 132], 92, [1, -0.5, 0], 120],
  ['strip', [790, 165], 60, [1, -1, 0], 120],
  // slime hall: wall lamps high on the hall, a lamp over the ledge
  ['lamp', [830, 192], 260, null, null],
  ['lamp', [776, 300], 220, null, null],
  ['lamp', [915, 270], 260, null, null],
  ['lamp', [860, 340], 220, null, null],
  // south corridor
  ['strip', [821, 390], 60, [0, 1, 0], 200],
  // tunnel: one emergency lamp
  ['emergency', [669, 433], 20, null, null],
  // dark zone: emergency lamps and one weak lamp over the dais
  ['emergency', [758, 470], 120, null, null],
  ['emergency', [886, 470], 120, null, null],
  ['emergency', [822, 542], 120, null, null],
  ['lamp', [822, 480], 140, null, null],
  // lift and exit room
  ['strip', [822, 554], 196, [1, 0, 0], 80],
  ['strip', [822, 590], 268, [1, 0, 0], 200],
  ['lamp', [792, 590], 200, null, null],
  ['lamp', [851, 590], 200, null, null],
];

// ─────────────────────────────────────────────────────────────────────────────────────────────

const area = (poly) => poly.reduce((s, [x1, y1], i) => {
  const [x2, y2] = poly[(i + 1) % poly.length];
  return s + x1 * y2 - x2 * y1;
}, 0) / 2;

/** Insert every vertex that lies on another sector's edge into that edge (within 0.75 unit). */
function weld(sectors) {
  const all = [];
  for (const s of sectors) for (const p of s.poly) all.push(p);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of sectors) {
      for (let i = 0; i < s.poly.length; i++) {
        const a = s.poly[i], b = s.poly[(i + 1) % s.poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        let best = null;
        for (const p of all) {
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(len2);
          if (d > 0.75) continue;
          if (p[0] === a[0] && p[1] === a[1]) continue;
          if (!best || t < best.t) best = { t, p };
        }
        if (best) {
          s.poly.splice(i + 1, 0, [best.p[0], best.p[1]]);
          changed = true;
        }
      }
    }
  }
}

function build() {
  const sectors = SECTORS.map(([id, poly, floor, ceil, tags, light]) => {
    const p = poly.map(pt);
    // Drop consecutive duplicates that rounding can create.
    const clean = p.filter((q, i) => {
      const r = p[(i + 1) % p.length];
      return q[0] !== r[0] || q[1] !== r[1];
    });
    return { id, poly: clean, floor, ceil, tags, light };
  });
  weld(sectors);
  for (const s of sectors) if (area(s.poly) < 0) s.poly.reverse();

  const ids = new Set(sectors.map((s) => s.id));
  for (const d of DOORS) if (!ids.has(d)) throw new Error(`door ${d} has no sector`);

  const json = {
    unit: 0.03,
    source: 'Traced by hand from published E1M1 top-down maps; see hangar/tools/REFERENCES.md. No WAD data.',
    sectors,
    doors: DOORS.map((id) => ({ sector: id, openCeil: sectors.find((s) => s.id === id).ceil })),
    lifts: LIFTS,
    start: { x: X(START.px), y: Y(START.py), angle: START.angle },
    pois: POIS.map(([id, kind, p, look, z]) => ({
      id, x: X(p[0]), y: Y(p[1]),
      look: z === null ? [X(look[0]), Y(look[1])] : [X(look[0]), Y(look[1]), z],
      kind,
    })),
    fixtures: FIXTURES.map(([kind, p, z, dir, len]) => {
      const f = { kind, x: X(p[0]), y: Y(p[1]), z };
      if (dir) f.dir = dir;
      if (len) f.len = len;
      return f;
    }),
  };
  return json;
}

function svg(json) {
  const xs = json.sectors.flatMap((s) => s.poly.map((p) => p[0]));
  const ys = json.sectors.flatMap((s) => s.poly.map((p) => p[1]));
  const minX = Math.min(...xs) - 50, maxX = Math.max(...xs) + 50;
  const minY = Math.min(...ys) - 50, maxY = Math.max(...ys) + 50;
  const k = 0.4;
  const tx = (x) => ((x - minX) * k).toFixed(1), ty = (y) => ((maxY - y) * k).toFixed(1);
  const colour = (s) => s.tags.includes('slime') ? '#3a3' : s.tags.includes('sky') ? '#b98' :
    s.tags.includes('window') ? '#6cf' : s.tags.includes('door') ? '#c80' : s.tags.includes('lift') ? '#f0f' :
    s.tags.includes('walkway') ? '#999' : s.tags.includes('dark') ? '#335' : s.tags.includes('computer') ? '#47a' :
    s.tags.includes('corridor') ? '#865' : '#a86';
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${((maxX - minX) * k).toFixed(0)}" height="${((maxY - minY) * k).toFixed(0)}" style="background:#111">`;
  for (const s of json.sectors) {
    out += `<polygon points="${s.poly.map(([x, y]) => `${tx(x)},${ty(y)}`).join(' ')}" fill="${colour(s)}" stroke="#fff" stroke-width="0.6"/>`;
  }
  for (const p of json.pois) out += `<circle cx="${tx(p.x)}" cy="${ty(p.y)}" r="4" fill="red"/><line x1="${tx(p.x)}" y1="${ty(p.y)}" x2="${tx(p.look[0])}" y2="${ty(p.look[1])}" stroke="red" stroke-width="0.8"/>`;
  for (const f of json.fixtures) out += `<circle cx="${tx(f.x)}" cy="${ty(f.y)}" r="2.5" fill="${f.kind === 'emergency' ? '#f33' : '#ff0'}"/>`;
  out += `<circle cx="${tx(json.start.x)}" cy="${ty(json.start.y)}" r="6" fill="none" stroke="#0f0" stroke-width="2"/>`;
  return out + '</svg>';
}

const json = build();
const outPath = new URL('../html/data/e1m1.json', import.meta.url);
mkdirSync(new URL('../html/data/', import.meta.url), { recursive: true });
writeFileSync(outPath, JSON.stringify(json, null, 1).replace(/\[\s+(-?\d+),\s+(-?\d+)\s+\]/g, '[$1, $2]') + '\n');
console.log(`wrote ${json.sectors.length} sectors, ${json.pois.length} pois, ${json.fixtures.length} fixtures`);
const i = process.argv.indexOf('--svg');
if (i > 0) writeFileSync(process.argv[i + 1], svg(json));
