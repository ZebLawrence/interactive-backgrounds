// Diorama — the paper theatre's play: which scene is on, how far through it is, and its cues. No three.js here.
//
// "The Voyage of the Petrel", a play for a mechanical toy theatre in five scenes. Nothing in it is alive:
// every player is a piece of painted card on a rod, a wire or a slide, and the sea is four rows of cut waves
// rocking against one another. The ship is the hero.
//
//   I    The Harbour    Dawn over the town. The sun comes up on its rod, the gulls turn, and the Petrel
//                       leaves the quay.
//   II   Fair Wind      Open sea. Islands go by on the painted panorama, clouds drift, dolphins leap between
//                       the rows of waves.
//   III  The Storm      The sky cloth goes slate. Black cloud is lowered, rain comes down on its threads, the
//                       waves heave, lightning is dropped in, and a sea serpent rises round the ship.
//   IV   The Calm       Night. The moon comes up, the stars are let down, a whale surfaces and blows, and a
//                       star falls.
//   V    Landfall       Home at dusk: the town and the lighthouse slide back in, the lamps are lit, and
//                       there are fireworks. Then the curtain.

/** Seconds the curtain takes to open or close, the scenery takes to change, and the house waits between performances. */
export const CURTAIN = 7, CHANGE = 8, INTERVAL = 9;

/**
 * Each scene: its number and title (for the placard), its caption, how long it runs, and its cues as
 * [fraction of the scene, what]. Cues:
 *   sail      the ship leaves the quay            leap      a dolphin jumps
 *   bolt      lightning                           serpent / dive   the serpent rises, and goes
 *   whale / sound    the whale surfaces, and goes spout     it blows
 *   fall      a shooting star                     rocket    a firework
 *   lamps     the harbour's lamps are lit
 */
export const SCENES = [
  { key: 'harbour', numeral: 'I', title: 'The Harbour', caption: 'Scene one. The Petrel sails on the morning tide.', seconds: 62, cues: [[0.46, 'sail']] },
  { key: 'fair', numeral: 'II', title: 'Fair Wind', caption: 'Scene two. Fair wind, and dolphins at the bow.', seconds: 66, cues: [[0.2, 'leap'], [0.31, 'leap'], [0.36, 'leap'], [0.58, 'leap'], [0.63, 'leap'], [0.84, 'leap']] },
  { key: 'storm', numeral: 'III', title: 'The Storm', caption: 'Scene three. The storm, and what came up out of it.', seconds: 76, cues: [[0.16, 'bolt'], [0.27, 'bolt'], [0.33, 'serpent'], [0.42, 'bolt'], [0.5, 'bolt'], [0.58, 'bolt'], [0.69, 'bolt'], [0.72, 'dive'], [0.86, 'bolt']] },
  { key: 'calm', numeral: 'IV', title: 'The Calm', caption: 'Scene four. Becalmed, under a moon, in company.', seconds: 70, cues: [[0.3, 'whale'], [0.42, 'spout'], [0.52, 'spout'], [0.6, 'fall'], [0.66, 'sound']] },
  { key: 'landfall', numeral: 'V', title: 'Landfall', caption: 'Scene five. Home, and the town has seen the sail.', seconds: 64, cues: [[0.5, 'lamps'], [0.58, 'rocket'], [0.66, 'rocket'], [0.72, 'rocket'], [0.8, 'rocket'], [0.85, 'rocket'], [0.92, 'rocket']] },
];

/**
 * The performance as a clock. Phases, in order:
 *   opening   the curtain rises on scene one       scene      a scene is playing
 *   change    the scenery is changing (the lights are down but the curtain stays up)
 *   closing   the curtain falls on scene five       interval   the curtain is down
 */
export class Play {
  constructor(start = 0) {
    this.index = ((start % SCENES.length) + SCENES.length) % SCENES.length;
    this.phase = this.index === 0 ? 'opening' : 'scene';
    this.t = 0;
    this.fired = 0;
    this.announced = false;
  }

  get scene() { return SCENES[this.index]; }
  /** 0..1 through whatever phase this is. */
  get u() { return Math.min(1, this.t / this.length); }
  get length() { return { opening: CURTAIN, closing: CURTAIN, change: CHANGE, interval: INTERVAL, scene: this.scene.seconds }[this.phase]; }
  /** How far up the curtain is, 0 down .. 1 up. */
  get curtain() { return this.phase === 'opening' ? this.u : this.phase === 'closing' ? 1 - this.u : this.phase === 'interval' ? 0 : 1; }
  /** How much of the stage lighting is up: it dips for a change of scene. */
  get lights() {
    if (this.phase === 'change') return Math.min(1, Math.abs(this.u - 0.5) * 2 / 0.6);
    return this.phase === 'interval' ? 0 : this.phase === 'opening' ? this.u : this.phase === 'closing' ? 1 - this.u : 1;
  }

  /**
   * Advances by dt. Returns, in order: { type: 'scene', index } as a scene starts playing, { type: 'cue', what },
   * { type: 'set', index } at the moment the scenery for scene `index` should be set (in the dark of a change,
   * or behind the curtain).
   */
  step(dt) {
    const out = [];
    this.t += dt;
    if (this.phase === 'scene') {
      if (!this.announced) { this.announced = true; out.push({ type: 'scene', index: this.index }); }
      const cues = this.scene.cues;
      while (this.fired < cues.length && cues[this.fired][0] * this.scene.seconds <= this.t) out.push({ type: 'cue', what: cues[this.fired++][1] });
      if (this.t >= this.scene.seconds) this.go(this.index === SCENES.length - 1 ? 'closing' : 'change');
    } else if (this.phase === 'change') {
      if (!this.set && this.u >= 0.5) { this.set = true; this.index++; out.push({ type: 'set', index: this.index }); }
      if (this.t >= CHANGE) this.go('scene');
    } else if (this.phase === 'closing') {
      if (this.t >= CURTAIN) this.go('interval');
    } else if (this.phase === 'interval') {
      if (!this.set && this.u >= 0.5) { this.set = true; this.index = 0; out.push({ type: 'set', index: 0 }); }
      if (this.t >= INTERVAL) this.go('opening');
    } else if (this.t >= CURTAIN) this.go('scene');
    return out;
  }

  go(phase) { this.phase = phase; this.t = 0; this.fired = 0; this.announced = false; this.set = false; }

  /** Cuts the scene short (the menu's way on to the next one). */
  skip() { if (this.phase === 'scene') this.go(this.index === SCENES.length - 1 ? 'closing' : 'change'); }
}
