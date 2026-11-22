// Diorama — the office skin's story: what happens on which night, and when. No three.js in here.
//
// The office is a private investigator's, and nobody is ever in it while you watch: the story is told by what
// has changed on the pinboard and the desk since last night, by the shadows that come to the frosted door, and
// by what the light through the blinds is doing. Four nights, with a day run through in a few seconds between
// each (the sun's stripes sweep the floor, the clock's hands spin, and the room is rearranged while it is dark).
//
//   Monday      The client. A woman in a wide hat knocks, waits, and pushes an envelope under the door.
//   Tuesday     The trail. A jeweller has vanished with the Harrow Sapphire. The pinboard has begun. A heavy
//               man tries the door handle, and someone across the street is watching the window.
//   Wednesday   The warning. The office has been turned over: drawers out, a chair on its side, a bullet
//               hole in the door glass and a note knifed to the desk.
//   Thursday    The answer. Every string on the board now ends at the client's photograph. The safe stands
//               open with the sapphire in it, police lights turn in the street, and two officers walk her
//               past the door. Then the rain stops, and it starts again the next Monday.

/** Seconds a night lasts, and seconds the day between two nights is run through in. */
export const NIGHT = 150, LAPSE = 16;
/** How far through the day the room is rearranged: in the dark before dawn. */
export const SWAP = 0.14;

/**
 * Each night: its caption, and its beats as [seconds into the night, what, details].
 *   ring      the telephone rings `rings` times and nobody answers
 *   train     the elevated train passes outside
 *   visitor   a shadow comes to the door: `who` (client, heavy, escort, passer) and what it does there
 *   lightning
 *   watcher   a window across the street lights up with somebody in it
 *   flicker   the desk lamp stutters
 *   police    a patrol car's lights turn in the street below
 *   dry       the rain stops
 */
export const CHAPTERS = [
  {
    key: 'client', day: 'MON', date: 3, title: 'The Client', caption: 'Monday night. Somebody who would not wait.',
    beats: [[14, 'ring', { rings: 4 }], [40, 'train'], [62, 'visitor', { who: 'client', act: 'envelope' }], [108, 'lightning'], [126, 'visitor', { who: 'passer', act: 'pass' }]],
  },
  {
    key: 'trail', day: 'TUE', date: 4, title: 'The Trail', caption: 'Tuesday. A jeweller is missing, and so is the Harrow Sapphire.',
    beats: [[12, 'watcher'], [38, 'train'], [60, 'visitor', { who: 'heavy', act: 'handle' }], [102, 'ring', { rings: 2 }], [124, 'lightning']],
  },
  {
    key: 'warning', day: 'WED', date: 5, title: 'The Warning', caption: 'Wednesday. Somebody wants the case dropped.',
    beats: [[9, 'lightning'], [15, 'lightning'], [34, 'ring', { rings: 7 }], [68, 'visitor', { who: 'heavy', act: 'loiter' }], [98, 'train'], [118, 'flicker'], [132, 'watcher']],
  },
  {
    key: 'answer', day: 'THU', date: 6, title: 'The Answer', caption: 'Thursday. Every string ends at the client.',
    beats: [[12, 'police'], [32, 'visitor', { who: 'escort', act: 'pass' }], [78, 'ring', { rings: 3 }], [100, 'train'], [120, 'dry']],
  },
];

export class Story {
  constructor(start = 0) {
    this.index = ((start % CHAPTERS.length) + CHAPTERS.length) % CHAPTERS.length;
    this.phase = 'night'; // or 'lapse': the day between two nights
    this.t = 0;
    this.fired = 0;
    this.announced = false;
    this.swapped = false;
  }

  get chapter() { return CHAPTERS[this.index]; }
  /** 0..1 through the day between two nights; 0 at night. */
  get lapse() { return this.phase === 'lapse' ? Math.min(1, this.t / LAPSE) : 0; }
  /** The time on the wall clock, in hours: a night runs from ten to one, and the lapse brings it round to ten again. */
  get clock() { return this.phase === 'night' ? 22 + 3 * Math.min(1, this.t / NIGHT) : 25 + 21 * this.lapse; }

  /**
   * Advances by dt seconds. Returns what happened, in order: { type: 'night', index } as a night begins,
   * { type: 'beat', what, ...details }, { type: 'lapse' } as a night ends, { type: 'chapter', index } at the
   * moment the room is to be rearranged.
   */
  step(dt) {
    const out = [];
    this.t += dt;
    if (this.phase === 'night') {
      if (!this.announced) { this.announced = true; out.push({ type: 'night', index: this.index }); }
      const beats = this.chapter.beats;
      while (this.fired < beats.length && beats[this.fired][0] <= this.t) {
        const [, what, details] = beats[this.fired++];
        out.push({ type: 'beat', what, ...details });
      }
      if (this.t >= NIGHT) { this.phase = 'lapse'; this.t = 0; this.swapped = false; out.push({ type: 'lapse' }); }
    } else {
      if (!this.swapped && this.t >= LAPSE * SWAP) {
        this.swapped = true;
        this.index = (this.index + 1) % CHAPTERS.length;
        out.push({ type: 'chapter', index: this.index });
      }
      if (this.t >= LAPSE) { this.phase = 'night'; this.t = 0; this.fired = 0; this.announced = false; }
    }
    return out;
  }

  /** Ends the night now (the menu's way on to the next chapter). Returns the same events step() would. */
  skip() {
    if (this.phase !== 'night') return [];
    this.phase = 'lapse'; this.t = 0; this.swapped = false;
    return [{ type: 'lapse' }];
  }
}

/**
 * The light of the day that is run through between two nights, for u = 0..1 through it:
 *   night  how much of the night's own light is on (lamp, neon, street lamp): out before the swap, back at dusk
 *   sun    0..1, the daylight
 *   arc    -1..1, where the sun is along its path (morning to evening)
 */
export function daylight(u) {
  const ramp = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a)));
  const night = u <= 0 ? 1 : Math.max(1 - ramp(0, SWAP * 0.75, u), ramp(0.9, 1, u));
  const day = ramp(SWAP + 0.03, 0.3, u) * (1 - ramp(0.72, 0.9, u));
  return { night, sun: day * day * (3 - 2 * day), arc: ramp(SWAP, 0.9, u) * 2 - 1 };
}
