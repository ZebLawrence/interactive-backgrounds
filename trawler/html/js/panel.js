// Trawler — Everything on the wheelhouse panels that is not a live screen: the engine gauges, the
// radios, the breaker and switch panels, the autopilot head. All of it drawn here rather than
// downloaded, because there is no CC0 scan of a marine instrument and because a drawn face can be
// made exactly as sharp as it needs to be.
//
// How sharp is "enough". Everything in this module is within two metres of the eye, so the rule is
// the project's 1024 pixels per metre and then some. A 90 mm gauge face on a 512 px canvas is 5700
// px/m; a 420 mm breaker panel on 1024 px is 2400. Both survive a 4K screen with the owner leaning
// in, which is the test (guidelines section 1).
//
// What is drawn and what is modelled. The *face* is a texture - ticks, numerals, lettering, the red
// arc at the top of the range - because that is printing on a dial and printing is flat. Everything
// that catches the light is geometry: the chrome bezel is a torus, the needle is a tapered bar
// standing a millimetre proud of the face, the glass is its own disc with its own reflection, the
// knobs are turned cylinders and the rocker switches are little boxes that actually move. A gauge
// drawn entirely into one texture reads as a sticker the moment the boat rolls and the highlight
// does not travel across it.

import * as THREE from 'three';
import { LAYER } from './shaders.js';
import { paint, scaleUvs } from './materials.js';
import { Art, TAU, DEG, clamp01, lerp } from './util.js';

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CONDENSED = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';

// =============================================================================================
// The faces: what is printed on a dial
// =============================================================================================

/**
 * A round instrument face. The sweep is the real one: a marine engine gauge runs its scale over
 * about 250 degrees with the zero at the bottom left, which is why a tachometer's needle points
 * straight up at roughly two thirds of its range rather than at half.
 *
 * `opts`: label (what it measures), unit, min, max, major (the step the numerals go on), minor
 * (the step the small ticks go on), redFrom (where the red arc starts, or null), dark (a black
 * face rather than a cream one), size.
 */
export function gaugeFace({
  label = '', unit = '', min = 0, max = 100, major = 20, minor = 5,
  redFrom = null, dark = true, size = 512, maker = 'FARIA',
} = {}) {
  const A0 = 125 * DEG, A1 = 415 * DEG; // from lower-left, clockwise, through the top
  return Art.image(size, size, (ctx, w) => {
    const c = w / 2, r = w * 0.5;
    const ink = dark ? '#f2efe8' : '#1a1a18';
    const faceA = dark ? '#17181a' : '#e8e4d8';
    const faceB = dark ? '#05060a' : '#cfc9b8';

    // The dial plate, with the faint vignette a real one has toward its rim.
    const g = ctx.createRadialGradient(c, c * 0.86, r * 0.1, c, c, r);
    g.addColorStop(0, faceA);
    g.addColorStop(1, faceB);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.fill();

    const at = (v) => A0 + (A1 - A0) * clamp01((v - min) / (max - min));
    const polar = (ang, rad) => [c + Math.cos(ang) * rad, c + Math.sin(ang) * rad];

    // The red arc over the top of the range, inside the tick ring.
    if (redFrom !== null) {
      ctx.strokeStyle = '#d2302a';
      ctx.lineWidth = r * 0.055;
      ctx.beginPath();
      ctx.arc(c, c, r * 0.80, at(redFrom), at(max));
      ctx.stroke();
    }

    // Ticks. The minor ones are hairlines; the major ones are long and carry a numeral.
    ctx.lineCap = 'butt';
    for (let v = min; v <= max + 1e-6; v += minor) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const ang = at(v);
      const r0 = r * (isMajor ? 0.665 : 0.715);
      const r1 = r * 0.755;
      ctx.strokeStyle = ink;
      ctx.lineWidth = r * (isMajor ? 0.030 : 0.013);
      ctx.beginPath();
      ctx.moveTo(...polar(ang, r0));
      ctx.lineTo(...polar(ang, r1));
      ctx.stroke();
      if (!isMajor) continue;
      const [tx, ty] = polar(ang, r * 0.545);
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.round(r * 0.20)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round(v)), tx, ty);
    }

    // The maker's name over the spindle and what the dial measures under it: the two bits of
    // lettering every marine gauge carries.
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.font = `500 ${Math.round(r * 0.105)}px ${CONDENSED}`;
    ctx.globalAlpha = 0.72;
    ctx.fillText(maker, c, c - r * 0.30);
    ctx.globalAlpha = 1;
    ctx.font = `700 ${Math.round(r * 0.145)}px ${CONDENSED}`;
    ctx.fillText(label, c, c + r * 0.34);
    if (unit) {
      ctx.font = `400 ${Math.round(r * 0.115)}px ${CONDENSED}`;
      ctx.globalAlpha = 0.8;
      ctx.fillText(unit, c, c + r * 0.50);
      ctx.globalAlpha = 1;
    }
  });
}

/**
 * A black anodised panel with engraved white lettering: the legends beside a row of rocker
 * switches or circuit breakers. The switches themselves are modelled, so this is only the plate.
 * `rows` is the list of legends, top to bottom; `columns` splits them into two banks.
 */
export function switchPlateFace(rows, { size = 1024, columns = 1, title = null } = {}) {
  const h = Math.round(size * (rows.length / columns + (title ? 1.1 : 0.4)) / 9);
  return Art.image(size, Math.max(64, h), (ctx, w, hh) => {
    const g = ctx.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, '#2a2d31');
    g.addColorStop(0.5, '#1b1e21');
    g.addColorStop(1, '#101215');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hh);
    // The brushed grain of an anodised plate: fine horizontal streaks, barely there.
    ctx.globalAlpha = 0.10;
    for (let i = 0; i < hh; i += 2) {
      ctx.strokeStyle = i % 4 ? '#ffffff' : '#000000';
      ctx.beginPath();
      ctx.moveTo(0, i + 0.5);
      ctx.lineTo(w, i + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    let y = 6;
    if (title) {
      ctx.fillStyle = '#cfd4d8';
      ctx.font = `700 ${Math.round(hh * 0.07)}px ${CONDENSED}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(title.toUpperCase(), w / 2, y);
      y += hh * 0.1;
      ctx.strokeStyle = 'rgba(190,200,210,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w * 0.06, y);
      ctx.lineTo(w * 0.94, y);
      ctx.stroke();
      y += hh * 0.02;
    }
    const perCol = Math.ceil(rows.length / columns);
    const colW = w / columns;
    const step = (hh - y - 6) / perCol;
    ctx.textBaseline = 'middle';
    rows.forEach((text, i) => {
      const col = Math.floor(i / perCol), k = i % perCol;
      const cx = col * colW;
      // Engraving: a dark cut with a light edge under it, which is what gives it depth.
      const ty = y + step * (k + 0.5);
      ctx.font = `600 ${Math.round(step * 0.42)}px ${CONDENSED}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(text.toUpperCase(), cx + colW * 0.30, ty + step * 0.035);
      ctx.fillStyle = '#e6ebee';
      ctx.fillText(text.toUpperCase(), cx + colW * 0.30, ty);
    });
  });
}

/**
 * The fascia of a boxed set - a VHF, an autopilot head, a hailer. The LCD window is left black
 * here and lit by its own emissive quad, so the glass glows and the plastic round it does not.
 */
export function setFace(name, { size = 1024, keys = [], lcd = [0.06, 0.1, 0.52, 0.52], brand = 'ICOM' } = {}) {
  return Art.image(size, Math.round(size * 0.42), (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#34383d');
    g.addColorStop(0.35, '#23272b');
    g.addColorStop(1, '#15181b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // The LCD's recess: a black well with a bright lower lip, so it reads as set into the case.
    const [lx, ly, lw, lh] = lcd;
    ctx.fillStyle = '#050607';
    ctx.fillRect(lx * w, ly * h, lw * w, lh * h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(2, h * 0.012);
    ctx.strokeRect(lx * w, ly * h, lw * w, lh * h);

    ctx.fillStyle = '#cdd3d8';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(h * 0.13)}px ${CONDENSED}`;
    ctx.fillText(brand, w * 0.055, h * 0.80);
    ctx.globalAlpha = 0.72;
    ctx.font = `500 ${Math.round(h * 0.095)}px ${CONDENSED}`;
    ctx.fillText(name.toUpperCase(), w * 0.055 + ctx.measureText(brand).width * 1.5, h * 0.80);
    ctx.globalAlpha = 1;

    // The key legends along the bottom right: small, square, slightly recessed.
    const n = keys.length;
    for (let i = 0; i < n; i++) {
      const bw = w * 0.085, bh = h * 0.20;
      const bx = w * 0.62 + i * bw * 1.12, by = h * 0.70;
      ctx.fillStyle = '#2b2f33';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#d7dce0';
      ctx.font = `600 ${Math.round(bh * 0.46)}px ${CONDENSED}`;
      ctx.textAlign = 'center';
      ctx.fillText(keys[i].toUpperCase(), bx + bw / 2, by + bh / 2);
      ctx.textAlign = 'left';
    }
  });
}

// =============================================================================================
// The things themselves
// =============================================================================================

/**
 * A round gauge: chrome bezel, printed face, a needle standing proud of it, and its own glass.
 *
 * The needle is a child of the group and is turned by `set(value)`, so a caller can drive it from
 * the boat's own numbers. Its sweep matches gaugeFace's: 125 degrees to 415, clockwise.
 */
export class Gauge {
  /** @param {object} opts the same as gaugeFace, plus diameter (metres) and depth. */
  constructor(opts = {}) {
    const d = opts.diameter ?? 0.090;
    const r = d / 2;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 100;
    this.group = new THREE.Group();

    const chrome = paint(0xdfe3e6, 0.18, 0.92);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(r * 0.96, r * 0.10, 12, 40), chrome);
    bezel.position.z = 0.004;
    this.group.add(bezel);
    // The can behind it, which is what you see of a gauge from the side.
    const can = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 0.86, 0.052, 28, 1, true),
      paint(0x15171a, 0.62, 0.25, { side: THREE.DoubleSide }));
    can.rotation.x = Math.PI / 2;
    can.position.z = -0.026;
    this.group.add(can);

    this.faceTex = Art.texture(gaugeFace(opts));
    const face = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, 40),
      new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.66, metalness: 0 }));
    this.group.add(face);

    // The needle: a tapered blade with a counterweight behind the spindle, in signal red.
    const needle = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r * 0.70, r * 0.055, 0.0016), paint(0xd0231c, 0.42, 0.05));
    blade.position.set(r * 0.33, 0, 0.0045);
    needle.add(blade);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.20, r * 0.075, 0.0016), paint(0xd0231c, 0.42, 0.05));
    tail.position.set(-r * 0.10, 0, 0.0045);
    needle.add(tail);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.085, r * 0.085, 0.006, 16), chrome);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.006;
    needle.add(hub);
    this.group.add(needle);
    this.needle = needle;

    // The glass, a hair proud of the bezel's inner edge. Rough enough to catch the window as a
    // smear rather than a mirror, which is what instrument glass does.
    const glass = new THREE.Mesh(new THREE.CircleGeometry(r * 0.93, 40), new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.08, metalness: 0, transmission: 0, transparent: true,
      opacity: 0.10, depthWrite: false,
    }));
    glass.position.z = 0.0085;
    glass.renderOrder = 6;
    this.group.add(glass);

    this.set(opts.start ?? this.min);
  }

  /** Points the needle at a value, clamped to the dial. */
  set(value) {
    const t = clamp01((value - this.min) / (this.max - this.min || 1));
    this.needle.rotation.z = -(125 * DEG + t * 290 * DEG);
  }

  dispose() {
    this.faceTex.dispose();
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

/**
 * A bank of rocker switches or breakers on an engraved plate. Each switch is a real little box
 * that tilts, so clicking one can throw it; `throwSwitch(i)` is what does that.
 */
export class SwitchBank {
  /**
   * @param {string[]} legends one per switch, top to bottom
   * @param {object} opts width/height in metres, columns, title, breaker (round breakers rather
   *   than rockers), on (which start thrown)
   */
  constructor(legends, opts = {}) {
    const w = opts.width ?? 0.30;
    const h = opts.height ?? 0.22;
    const columns = opts.columns ?? 1;
    this.group = new THREE.Group();
    this.switches = [];

    this.plateTex = Art.texture(switchPlateFace(legends, { columns, title: opts.title }));
    const plate = new THREE.Mesh(scaleUvs(new THREE.PlaneGeometry(w, h), 1, 1),
      new THREE.MeshStandardMaterial({ map: this.plateTex, roughness: 0.48, metalness: 0.35 }));
    this.group.add(plate);
    // The frame it is screwed into.
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.014, h + 0.014, 0.018),
      paint(0x1b1e21, 0.5, 0.4));
    frame.position.z = -0.010;
    this.group.add(frame);

    const perCol = Math.ceil(legends.length / columns);
    const colW = w / columns;
    const step = h / (perCol + (opts.title ? 0.9 : 0.35));
    const top = h / 2 - step * (opts.title ? 1.1 : 0.5);
    legends.forEach((_, i) => {
      const col = Math.floor(i / perCol), k = i % perCol;
      const x = -w / 2 + colW * (col + 0.14);
      const y = top - step * k;
      const body = opts.breaker
        ? new THREE.Mesh(new THREE.CylinderGeometry(step * 0.17, step * 0.17, 0.012, 14), paint(0x0d0f11, 0.55, 0.2))
        : new THREE.Mesh(new THREE.BoxGeometry(colW * 0.16, step * 0.52, 0.012), paint(0x0d0f11, 0.55, 0.2));
      if (opts.breaker) body.rotation.x = Math.PI / 2;
      body.position.set(x, y, 0.009);
      this.group.add(body);
      // The lit tell-tale beside it, which is the only part that glows.
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(step * 0.075, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a0c08, emissive: 0xff5a2a, emissiveIntensity: 0, roughness: 0.4 }));
      lamp.position.set(x + colW * 0.13, y, 0.011);
      this.group.add(lamp);
      this.switches.push({ body, lamp, on: (opts.on ?? []).includes(i) });
    });
    this.apply();
  }

  /** Tilts each rocker to match its state, and lights the ones that are on. */
  apply() {
    for (const s of this.switches) {
      s.body.rotation.x = (s.body.geometry.type === 'BoxGeometry' ? 1 : 0) * (s.on ? -0.28 : 0.28);
    }
  }

  throwSwitch(i) {
    const s = this.switches[i];
    if (!s) return false;
    s.on = !s.on;
    this.apply();
    return s.on;
  }

  /** The tell-tales are a screen brightness, so they take the camera's exposure like everything else. */
  setLamps(level, emissiveScale = 1) {
    for (const s of this.switches) {
      s.lamp.material.emissiveIntensity = (s.on ? 0.55 : 0.0) * level * emissiveScale;
    }
  }

  dispose() {
    this.plateTex.dispose();
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

/**
 * A boxed set in the overhead: a VHF, the autopilot head, the hailer. The case and the knobs are
 * modelled, the fascia is printed, and the LCD is a small emissive quad so the display glows on
 * its own at night without the case glowing with it.
 */
export class RadioSet {
  constructor(name, opts = {}) {
    const w = opts.width ?? 0.185;
    const h = opts.height ?? 0.078;
    const d = opts.depth ?? 0.15;
    this.group = new THREE.Group();

    this.faceTex = Art.texture(setFace(name, { keys: opts.keys ?? ['16', 'hi/lo', 'scan'], brand: opts.brand }));
    const case_ = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paint(0x1c1f22, 0.56, 0.28));
    case_.position.z = -d / 2;
    this.group.add(case_);
    const fascia = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.5, metalness: 0.2 }));
    fascia.position.z = 0.0012;
    this.group.add(fascia);

    // The display: amber on an ICOM, green on a plotter head. Lit from behind.
    const lw = w * 0.52, lh = h * 0.52;
    this.lcdTex = Art.texture(Art.image(512, 256, (ctx, cw, ch) => {
      ctx.fillStyle = '#0a1208';
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = opts.lcdColor ?? '#9fe36a';
      ctx.font = `700 ${Math.round(ch * 0.56)}px ${CONDENSED}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.lcdText ?? '16', cw * 0.42, ch * 0.52);
      ctx.font = `600 ${Math.round(ch * 0.19)}px ${CONDENSED}`;
      ctx.textAlign = 'left';
      ctx.fillText(opts.lcdSub ?? 'DUP', cw * 0.70, ch * 0.30);
      ctx.fillText('TX', cw * 0.70, ch * 0.72);
    }));
    const lcd = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), new THREE.MeshStandardMaterial({
      map: this.lcdTex, emissiveMap: this.lcdTex, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.25, metalness: 0,
    }));
    lcd.position.set(-w * 0.5 + w * 0.06 + lw / 2, h * 0.5 - h * 0.1 - lh / 2, 0.0018);
    this.group.add(lcd);
    this.lcd = lcd;

    // Two knobs on the right-hand end: volume and squelch, the pair every set has.
    const chrome = paint(0xc9ced2, 0.3, 0.8);
    for (let i = 0; i < 2; i++) {
      const k = new THREE.Mesh(scaleUvs(new THREE.CylinderGeometry(h * 0.17, h * 0.19, 0.016, 18), 0.1, 0.016), chrome);
      k.rotation.x = Math.PI / 2;
      k.position.set(w * 0.5 - h * (0.26 + i * 0.46), h * 0.18, 0.008);
      this.group.add(k);
    }
  }

  setLit(level, emissiveScale = 1) {
    this.lcd.material.emissiveIntensity = level * 0.5 * emissiveScale;
  }

  dispose() {
    this.faceTex.dispose();
    this.lcdTex.dispose();
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
}

/**
 * The VHF handset on its curly cord, hanging from a clip under the overhead. The cord is a helix
 * sagging under its own weight between the set and the handset, which is the detail that says
 * somebody works here.
 */
export function handset(material = null) {
  const g = new THREE.Group();
  const body = paint(0x202327, 0.55, 0.2);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.115, 0.030), body);
  g.add(grip);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.030, 0.034), body);
  head.position.y = 0.070;
  g.add(head);
  // The press-to-talk bar down one side.
  const ptt = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.050, 0.010), paint(0x0e1012, 0.5, 0.1));
  ptt.position.set(-0.024, 0.010, 0.0);
  g.add(ptt);
  // The cord: a coil of twelve turns, stretched a little and sagging.
  const turns = 14, pts = [];
  for (let i = 0; i <= turns * 8; i++) {
    const t = i / (turns * 8);
    const a = t * turns * TAU;
    const sag = Math.sin(t * Math.PI) * 0.035;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.016, -0.055 - t * 0.21 - sag, Math.sin(a) * 0.016 - t * 0.05));
  }
  const cord = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 8, 0.0035, 6, false),
    paint(0x17191b, 0.68, 0.05),
  );
  g.add(cord);
  g.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); });
  return g;
}

/**
 * A louvred cabinet door: the slatted front that every locker in this wheelhouse has. The slats
 * are real geometry rather than a normal map, because they are 30 mm apart at arm's length and a
 * map of them goes flat the moment the light moves.
 */
export function louvreDoor(w, h, material, { slat = 0.026, frame = 0.055 } = {}) {
  const g = new THREE.Group();
  const stileW = frame;
  const inner = { w: w - stileW * 2, h: h - stileW * 2 };
  // Stiles and rails.
  const parts = [
    [stileW, h, -w / 2 + stileW / 2, 0], [stileW, h, w / 2 - stileW / 2, 0],
    [inner.w, stileW, 0, h / 2 - stileW / 2], [inner.w, stileW, 0, -h / 2 + stileW / 2],
  ];
  for (const [pw, ph, px, py] of parts) {
    const m = new THREE.Mesh(scaleUvs(new THREE.BoxGeometry(pw, ph, 0.020), pw, ph), material);
    m.position.set(px, py, 0);
    g.add(m);
  }
  // The slats, each tipped down so you cannot see through and so each one catches the light.
  const n = Math.max(3, Math.floor(inner.h / slat));
  for (let i = 0; i < n; i++) {
    const y = -inner.h / 2 + (i + 0.5) * (inner.h / n);
    const s = new THREE.Mesh(scaleUvs(new THREE.BoxGeometry(inner.w, slat * 0.92, 0.009), inner.w, slat), material);
    s.position.set(0, y, -0.004);
    s.rotation.x = 28 * DEG;
    g.add(s);
  }
  return g;
}
