// Trawler — Everything on the wheelhouse panels: the VHF and its handset, the twin-lever engine
// control, the engine gauges, the breaker panels, the displays, the small switch panels, the chart
// lights, the handhelds in their cradle, the thruster joystick, the compass on the pod. All of it
// modelled and drawn here, to the owner's reference photograph of a real wheelhouse, because there
// is no CC0 scan of a marine instrument and a drawn one can be made exactly as sharp as it needs to
// be and exactly the shape the real one is.
//
// The rule that runs through every device in this file: what is *printed* is a texture, because
// printing is flat; everything that catches the light is geometry. A case is an extruded, bevelled
// rounded rectangle, not a box. A key is a raised cap you could press. A knob is turned on a lathe
// with the flat it really has. A gauge bezel is a ring standing proud of the face and the needle a
// blade standing proud of the dial, so the highlight travels across it when she rolls. A device
// drawn entirely into one texture reads as a sticker the moment the light moves, and the owner's
// first comparison - the real ICOM beside a flat box with two grey blobs - was exactly that.
//
// How sharp is "enough". Everything here is within two metres of the eye, so the rule is the
// project's 1024 pixels per metre and then some: a 260 mm radio fascia drawn on a 1536 px canvas is
// 5900 px/m, a 90 mm gauge face on 512 px is 5700. Both survive a 4K screen with the owner leaning
// in, which is the test (guidelines section 1).

import * as THREE from 'three';
import { LAYER } from './shaders.js';
import { paint, scaleUvs } from './materials.js';
import { Art, TAU, DEG, clamp01, lerp } from './util.js';

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CONDENSED = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = '"Consolas", "Lucida Console", "Courier New", monospace';

/**
 * Polished stainless.
 *
 * A mirror-finish metal is nothing but its reflections, so it is lit by a picture of the room: the
 * house renders a cube map of itself from a point by the wheel (pilot.js, one face a frame) and
 * every chrome in here looks its reflection up in that. The lookup is a small shader of its own
 * rather than a standard material with an environment map, because three's physical materials
 * want that map pre-filtered through PMREM, which renders black on the owner's GPU (see sky.js),
 * and because a mirror needs nothing a BRDF offers: the reflected radiance, a little Fresnel, and
 * the slightly warm, slightly dark tint that makes stainless read as stainless and not as glass.
 * The cube map is rendered in the scene's own linear radiance, so the chrome follows the exposure
 * from noon to a lamplit night with no scaling of its own.
 */
const CHROME = new Set();
let chromeEnv = null;
const CHROME_VERT = /* glsl */ `
  out vec3 vN;
  out vec3 vW;
  void main() {
    vN = normalize( mat3( modelMatrix ) * normal );
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const CHROME_FRAG = /* glsl */ `
  precision highp float;
  uniform samplerCube uEnv;
  uniform float uLod;
  uniform vec3 uTint;
  uniform float uHasEnv;
  in vec3 vN;
  in vec3 vW;
  out vec4 outColor;
  void main() {
    vec3 N = normalize( vN );
    vec3 V = normalize( cameraPosition - vW );
    vec3 R = reflect( -V, N );
    float ndv = max( dot( N, V ), 0.0 );
    // Stainless returns about sixty per cent at normal incidence and everything at grazing.
    float f = 0.60 + 0.40 * pow( 1.0 - ndv, 5.0 );
    vec3 env = uHasEnv > 0.5 ? textureLod( uEnv, R, uLod ).rgb : vec3( 0.0 );
    outColor = vec4( env * uTint * f, 1.0 );
  }
`;

/** A polished-stainless material: see above. `tone` darkens one that is less bright a metal. */
export function chromeMaterial(tone = 1) {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uEnv: { value: chromeEnv },
      uLod: { value: 1.0 },
      uTint: { value: new THREE.Color(0.92 * tone, 0.92 * tone, 0.94 * tone) },
      uHasEnv: { value: chromeEnv ? 1 : 0 },
    },
    vertexShader: CHROME_VERT,
    fragmentShader: CHROME_FRAG,
  });
  m.userData.chrome = true;
  CHROME.add(m);
  return m;
}

/** Hands the room's cube map to every chrome in it. */
export function setChromeEnv(texture) {
  chromeEnv = texture;
  for (const m of CHROME) { m.uniforms.uEnv.value = texture; m.uniforms.uHasEnv.value = texture ? 1 : 0; }
}

/** Kept for callers: the cube map is radiance, so there is no level to set any more. */
export function setChromeLevel() {}


/**
 * The beam of a lamp, in the air. A downlight in a dark wheelhouse shows as a soft cone below it,
 * because there is always a little salt haze and breath in the air for its light to catch; the
 * lamp itself lights the room (that is the SpotLight), and this is only what the air does. A
 * surface cone, additive, brightest near the lamp and where it faces the camera - which is where
 * a view ray crosses the most lit air - fading to nothing toward the base. It is drawn at a
 * screen brightness like the lens, so it is scaled by the camera's exposure and vanishes by day.
 */
const BEAM_VERT = /* glsl */ `
  out vec2 vUv;
  out vec3 vN;
  out vec3 vW;
  void main() {
    vUv = uv;
    vN = normalize( mat3( modelMatrix ) * normal );
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const BEAM_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uGain;
  in vec2 vUv;
  in vec3 vN;
  in vec3 vW;
  out vec4 outColor;
  void main() {
    float fromApex = 1.0 - vUv.y; // the cone's uv.y is 1 at the apex
    vec3 V = normalize( cameraPosition - vW );
    float facing = abs( dot( normalize( vN ), V ) );
    float a = pow( 1.0 - fromApex, 1.6 ) * ( 0.06 + 0.94 * facing * facing );
    outColor = vec4( uColor * ( uGain * a ), 1.0 );
  }
`;

/** A lamp's beam: apex at the origin, opening downward, `height` tall at `halfAngle`. */
export function lampBeam(height, halfAngle, colour = 0xffe9cf) {
  const r = height * Math.tan(halfAngle);
  const g = new THREE.ConeGeometry(r, height, 28, 1, true);
  g.translate(0, -height / 2, 0);
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uColor: { value: new THREE.Color(colour) }, uGain: { value: 0 } },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 815; // after the room, before the glass
  mesh.frustumCulled = false;
  return mesh;
}

// The plastics and metals every device here is made of. Each is a function so that a device owns
// its materials and can dispose of them; the colours are shared so that the room is one palette.
export const PLASTIC = {
  /** The charcoal of a marine electronics case: a hard plastic with a slight sheen. */
  case: () => paint(0x24272b, 0.46, 0.12),
  /** The matt black of a panel plate, which is what the legends are printed on. */
  plate: () => paint(0x121417, 0.58, 0.08),
  /** The soft black of a handset or a rubber knob grip. */
  rubber: () => paint(0x17191b, 0.72, 0.02),
  /** Polished stainless: a matcap of the room, see chromeMaterial. */
  chrome: () => chromeMaterial(1),
  /** Black-anodised aluminium: the chart lights and the joystick. */
  anodised: () => paint(0x141618, 0.42, 0.3),
};

const interior = (root) => { root.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.INTERIOR); }); return root; };
const disposeTree = (root, keep = null) => root.traverse((o) => {
  o.geometry?.dispose?.();
  if (o !== keep) o.material?.dispose?.();
  o.userData?.tex?.dispose?.();
});

// =============================================================================================
// Geometry helpers: the shapes a real device is made of
// =============================================================================================

/** A rounded rectangle as a Shape, centred on (cx, cy). A Shape is a Path, so it also serves as a hole. */
export function roundedRectShape(w, h, r, cx = 0, cy = 0) {
  const s = new THREE.Shape();
  const x = cx - w / 2, y = cy - h / 2;
  r = Math.max(0.0005, Math.min(r, w / 2, h / 2));
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * Remaps the uvs of every face that looks along +z onto 0..1 across the given width and height, so
 * a printed fascia lands on the front of an extruded case exactly. Everything else keeps the
 * extruder's own uvs, which for a plain material do not matter.
 */
export function frontFaceUvs(geometry, w, h) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    if (nor.getZ(i) > 0.9) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * A case or a plate: a rounded rectangle extruded back from z = 0 with a bevel on its front edge.
 * The front face is at z = 0 facing +z and the body behind it, so a device is built with its
 * fascia at the origin and everything on the fascia at small positive z.
 */
export function plate(w, h, depth, { radius = 0.006, bevel = 0.0025, material, frontUv = false } = {}) {
  bevel = Math.min(bevel, depth * 0.45, w * 0.2, h * 0.2);
  const shape = roundedRectShape(w - bevel * 2, h - bevel * 2, Math.max(radius - bevel, 0.0005));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - bevel, 0.0005), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 3, curveSegments: 8,
  });
  // Extrude runs 0..depth along +z with the bevel outside both ends; turn it round so the front
  // bevel is at z = 0 facing +z and the body runs back from there.
  g.rotateY(Math.PI);
  g.translate(0, 0, -bevel);
  g.computeVertexNormals();
  if (frontUv) frontFaceUvs(g, w, h);
  return new THREE.Mesh(g, material ?? PLASTIC.case());
}

/** A knob or a dome turned on a lathe: `profile` is [radius, y] pairs from the base up. */
export function lathe(profile, material, segments = 28) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return new THREE.Mesh(g, material);
}

/** A length of round bar between two points. */
export function bar(a, b, radius, material, segments = 10) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = scaleUvs(new THREE.CylinderGeometry(radius, radius, len, segments, 1), TAU * radius, len);
  const m = new THREE.Mesh(g, material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** A printed label on a thin plate: the white legend strips and black plaques every panel has. */
export function label(text, w, h, { bg = '#e8e6df', ink = '#1a1a1a', size = 0.55, bold = true } = {}) {
  const px = Math.max(96, Math.round(w * 6000));
  const tex = Art.texture(Art.image(px, Math.max(24, Math.round(px * h / w)), (ctx, cw, ch) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = ink;
    ctx.font = `${bold ? 700 : 500} ${Math.round(ch * size)}px ${CONDENSED}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.toUpperCase(), cw / 2, ch / 2 + ch * 0.02);
  }));
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
  m.userData.tex = tex;
  return m;
}

/**
 * A key cap: a low rounded block with its legend printed on the top, standing proud of a fascia.
 * These are the things a finger goes to, and modelling them is most of what makes a radio read as
 * a radio rather than a photograph of one.
 */
export function keyCap(legend, w, h, { depth = 0.004, colour = '#cfd3d7', face = '#3a3e43', size = 0.5 } = {}) {
  const px = 128;
  const tex = Art.texture(Art.image(px, Math.max(32, Math.round(px * h / w)), (ctx, cw, ch) => {
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#4a4f55');
    g.addColorStop(1, face);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = colour;
    ctx.font = `700 ${Math.round(ch * size)}px ${CONDENSED}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(legend, cw / 2, ch / 2 + ch * 0.03);
  }));
  const cap = plate(w, h, depth, { radius: Math.min(w, h) * 0.25, bevel: 0.0008, frontUv: true,
    material: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05 }) });
  cap.userData.tex = tex;
  return cap;
}

/** Seven-segment digits for the LCDs: the one typeface every marine set still uses. */
function sevenSegment(ctx, text, x, y, digitH, colour, { dim = null } = {}) {
  const dw = digitH * 0.56, t = digitH * 0.11, gap = digitH * 0.16;
  const segs = { 0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1], 3: [1,1,1,1,0,0,1], 4: [0,1,1,0,0,1,1],
    5: [1,0,1,1,0,1,1], 6: [1,0,1,1,1,1,1], 7: [1,1,1,0,0,0,0], 8: [1,1,1,1,1,1,1], 9: [1,1,1,1,0,1,1], '-': [0,0,0,0,0,0,1], ' ': [0,0,0,0,0,0,0] };
  const draw = (sx, on) => {
    const h2 = digitH / 2;
    const bars = [
      [sx + t, y, dw - 2 * t, t], [sx + dw - t, y + t, t, h2 - 1.5 * t], [sx + dw - t, y + h2 + t * 0.5, t, h2 - 1.5 * t],
      [sx + t, y + digitH - t, dw - 2 * t, t], [sx, y + h2 + t * 0.5, t, h2 - 1.5 * t], [sx, y + t, t, h2 - 1.5 * t],
      [sx + t, y + h2 - t / 2, dw - 2 * t, t],
    ];
    bars.forEach((b, i) => {
      if (on[i]) { ctx.fillStyle = colour; ctx.fillRect(...b); }
      else if (dim) { ctx.fillStyle = dim; ctx.fillRect(...b); }
    });
  };
  let sx = x;
  for (const ch of text) { draw(sx, segs[ch] ?? segs[' ']); sx += dw + gap; }
  return sx - gap;
}

/** The faint stipple a moulded case has, drawn over a fascia. Seeded, so it is the same each load. */
function stipple(ctx, w, h, alpha = 0.06, n = 12000) {
  let s = 1234567;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  ctx.globalAlpha = alpha;
  for (let i = 0; i < n; i++) { ctx.fillStyle = rnd() < 0.5 ? '#fff' : '#000'; ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
  ctx.globalAlpha = 1;
}

/** The brushed grain of an anodised plate. */
function brushed(ctx, w, h, alpha = 0.07) {
  ctx.globalAlpha = alpha;
  for (let y = 0; y < h; y += 2) { ctx.fillStyle = y % 4 ? '#ffffff' : '#000000'; ctx.fillRect(0, y, w, 1); }
  ctx.globalAlpha = 1;
}

/** A glass over a display or dial: black and additive, so it adds its reflection and takes nothing away. */
function glassMaterial(roughness = 0.05) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000, roughness, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// =============================================================================================
// The VHF set and its handset
// =============================================================================================

/**
 * A fixed-mount marine VHF in the pattern of the ICOM M506 the reference shows: a charcoal case
 * 260 mm across, a big amber LCD left of centre, a twelve-key pad to its right, a row of soft keys
 * under the display, the channel knob and the volume/squelch knob, the red DISTRESS button under
 * its flip cover at the lower left, and a speaker grille. The handset hangs on a clip to the right
 * of it and its coiled cord drops to the set's socket.
 */
export class VhfSet {
  constructor({ width = 0.262, height = 0.142, depth = 0.16 } = {}) {
    this.w = width; this.h = height;
    this.group = new THREE.Group();
    const W = width, H = height;

    // The case, bevelled, with the fascia printed on its face.
    this.faceTex = Art.texture(this.drawFascia(1536, Math.round(1536 * H / W)));
    const face = new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.5, metalness: 0.1 });
    const body = plate(W, H, 0.02, { radius: 0.012, bevel: 0.004, material: face, frontUv: true });
    this.group.add(body);
    // The case behind the fascia is plainer plastic.
    const back = new THREE.Mesh(new THREE.BoxGeometry(W - 0.008, H - 0.008, depth - 0.02), PLASTIC.case());
    back.position.z = -(depth - 0.02) / 2 - 0.02;
    this.group.add(back);

    // The LCD: a recess, glass over it, and the lit display behind the glass.
    const lcd = { x: -W * 0.165, y: H * 0.14, w: W * 0.34, h: H * 0.40 };
    this.lcd = lcd;
    this.lcdTex = Art.texture(this.drawLcd(640, Math.round(640 * lcd.h / lcd.w)));
    this.lcdMat = new THREE.MeshStandardMaterial({
      map: this.lcdTex, emissiveMap: this.lcdTex, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.3, metalness: 0,
    });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(lcd.w, lcd.h), this.lcdMat);
    screen.position.set(lcd.x, lcd.y, 0.0012);
    this.group.add(screen);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(lcd.w + 0.004, lcd.h + 0.004), glassMaterial());
    glass.position.set(lcd.x, lcd.y, 0.0026);
    glass.renderOrder = 6;
    this.group.add(glass);

    // The keypad: four columns by three rows to the right of the display, as the M506 has.
    const keys = [['1', '2', '3', 'CH/WX'], ['4', '5', '6', 'HI/LO'], ['7', '8', '9', 'SCAN']];
    const kw = W * 0.062, kh = H * 0.095, kx0 = W * 0.085, ky0 = H * 0.30;
    keys.forEach((row, r) => row.forEach((legend, c) => {
      const cap = keyCap(legend, kw, kh, { size: legend.length > 2 ? 0.34 : 0.55 });
      cap.position.set(kx0 + c * (kw + W * 0.012), ky0 - r * (kh + H * 0.035), 0.0015);
      this.group.add(cap);
    }));
    // The soft keys under the display.
    const soft = ['DUAL', 'TRI', 'MENU', 'CLR', 'ENT'];
    soft.forEach((legend, i) => {
      const cap = keyCap(legend, W * 0.052, H * 0.085, { size: 0.36 });
      cap.position.set(lcd.x - lcd.w / 2 + W * 0.03 + i * W * 0.064, lcd.y - lcd.h / 2 - H * 0.11, 0.0015);
      this.group.add(cap);
    });
    // The red-faced 16/9 key under the keypad.
    const k169 = keyCap('16/9', W * 0.062, H * 0.095, { size: 0.38, face: '#8a2a1e', colour: '#f3e0d8' });
    k169.position.set(kx0 + 3 * (kw + W * 0.012), ky0 - 3 * (kh + H * 0.035) + H * 0.01, 0.0015);
    this.group.add(k169);

    // The channel knob: a chrome-ringed rubber-gripped knob at the right. The grip is a 24-sided
    // lathe rather than a round one, so the facets catch the light the way a knurl does.
    const chrome = PLASTIC.chrome(), rubber = PLASTIC.rubber();
    const pointerMat = paint(0xf0f0ea, 0.5, 0);
    const knob = new THREE.Group();
    knob.add(lathe([[0.0, 0], [0.0165, 0], [0.0165, 0.004], [0.0150, 0.006]], chrome));
    knob.add(lathe([[0.0, 0.006], [0.0148, 0.006], [0.0148, 0.016], [0.0135, 0.019], [0.0, 0.019]], rubber, 24));
    const chPointer = new THREE.Mesh(new THREE.BoxGeometry(0.0018, 0.0006, 0.009), pointerMat);
    chPointer.position.set(0, 0.0192, 0.008);
    knob.add(chPointer);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(W * 0.42, -H * 0.19, 0.001);
    this.group.add(knob);
    this.knob = knob;
    // The volume/squelch knob at the top left, smaller, with a pointer line.
    const vol = new THREE.Group();
    vol.add(lathe([[0.0, 0], [0.011, 0], [0.011, 0.003], [0.0098, 0.0045]], chrome));
    vol.add(lathe([[0.0, 0.0045], [0.0096, 0.0045], [0.0096, 0.013], [0.0085, 0.015], [0.0, 0.015]], rubber, 24));
    const pointer = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.0005, 0.007), pointerMat);
    pointer.position.set(0, 0.0152, 0.005);
    vol.add(pointer);
    vol.rotation.x = Math.PI / 2;
    vol.position.set(-W * 0.38, H * 0.16, 0.001);
    this.group.add(vol);

    // DISTRESS: a red button in a well under a hinged translucent cover, propped a little open,
    // at the bottom left where the real set has it.
    const wellX = -W * 0.38, wellY = -H * 0.20;
    const well = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.026, 0.006), paint(0x0b0c0e, 0.6, 0.05));
    well.position.set(wellX, wellY, -0.002);
    this.group.add(well);
    const red = plate(0.016, 0.016, 0.004, { radius: 0.002, bevel: 0.001, material: paint(0xc8201a, 0.38, 0.05) });
    red.position.set(wellX, wellY, 0.0005);
    this.group.add(red);
    const coverGeo = new THREE.BoxGeometry(0.026, 0.026, 0.0015);
    coverGeo.translate(0, -0.013, 0);
    const cover = new THREE.Mesh(coverGeo, new THREE.MeshStandardMaterial({
      color: 0xb0b6bb, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false,
    }));
    cover.renderOrder = 7;
    cover.position.set(wellX, wellY + 0.013, 0.0045);
    cover.rotation.x = -0.55;
    this.group.add(cover);

    // The handset socket at the lower right of the case.
    const socket = lathe([[0, 0], [0.009, 0], [0.009, 0.004], [0.006, 0.004], [0.006, 0.001], [0, 0.001]], PLASTIC.plate());
    socket.rotation.x = Math.PI / 2;
    socket.position.set(W * 0.17, -H * 0.42, 0.0005);
    this.group.add(socket);
    this.socket = socket.position.clone().add(new THREE.Vector3(0, 0, 0.004));

    interior(this.group);
  }

  /** The fascia: everything printed on the set's face. */
  drawFascia(w, h) {
    return Art.image(w, h, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#30343a');
      g.addColorStop(0.5, '#25282d');
      g.addColorStop(1, '#1b1e22');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      stipple(ctx, w, h);
      // The display's surround: a slightly raised darker frame round the LCD recess.
      const lcd = this.lcd ?? { x: -0.165 * 0.262, y: 0.14 * 0.142, w: 0.34 * 0.262, h: 0.40 * 0.142 };
      const W = 0.262, H = 0.142;
      const lcdX = w * (0.5 + lcd.x / W - lcd.w / W / 2), lcdY = h * (0.5 - lcd.y / H - lcd.h / H / 2), lcdW = w * lcd.w / W, lcdH = h * lcd.h / H;
      ctx.fillStyle = '#121416';
      ctx.fillRect(lcdX - w * 0.012, lcdY - h * 0.03, lcdW + w * 0.024, lcdH + h * 0.06);
      ctx.fillStyle = '#060708';
      ctx.fillRect(lcdX, lcdY, lcdW, lcdH);
      // The speaker: a column of slots down the left edge, between the knob and the distress
      // button, where the M506's is.
      ctx.fillStyle = '#0a0b0c';
      for (let r = 0; r < 11; r++) {
        const yy = h * (0.17 + r * 0.062);
        ctx.fillRect(w * 0.015, yy, w * 0.038, h * 0.022);
      }
      // The lettering.
      ctx.fillStyle = '#d7dbdf';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `800 ${Math.round(h * 0.085)}px ${FONT}`;
      ctx.fillText('ICOM', w * 0.17, h * 0.085);
      ctx.font = `600 ${Math.round(h * 0.050)}px ${CONDENSED}`;
      ctx.globalAlpha = 0.85;
      ctx.fillText('VHF MARINE TRANSCEIVER', w * 0.305, h * 0.088);
      ctx.textAlign = 'right';
      ctx.fillText('IC-M506', w * 0.945, h * 0.088);
      ctx.textAlign = 'center';
      ctx.font = `600 ${Math.round(h * 0.040)}px ${CONDENSED}`;
      ctx.fillText('VOL / SQL', w * 0.12, h * 0.55);
      ctx.fillText('DISTRESS', w * 0.12, h * 0.95);
      ctx.fillText('CHANNEL  ·  PUSH SQL', w * 0.90, h * 0.955);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#9b1c16';
      ctx.fillRect(w * 0.07, h * 0.585, w * 0.10, h * 0.012);
    });
  }

  /** The LCD's picture: channel 16 on an amber backlight, with the annunciators a set shows. */
  drawLcd(w, h) {
    return Art.image(w, h, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#f6b24a');
      g.addColorStop(1, '#e9972c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // The LCD's dot structure: a very faint grid, which keeps it from reading as paint.
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = '#5a3a10';
      for (let x = 0; x < w; x += 4) ctx.fillRect(x, 0, 1, h);
      for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
      ctx.globalAlpha = 1;
      const ink = '#2a1d0c', ghost = 'rgba(42,29,12,0.10)';
      // The annunciators along the top, the channel large, its name under it, the bars below.
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(h * 0.12)}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText('INT', w * 0.04, h * 0.05);
      ctx.fillText('DUP', w * 0.20, h * 0.05);
      ctx.fillText('HI', w * 0.36, h * 0.05);
      ctx.textAlign = 'right';
      ctx.fillText('BUSY', w * 0.96, h * 0.05);
      ctx.fillStyle = ghost;
      ctx.fillText('TX', w * 0.74, h * 0.05);
      sevenSegment(ctx, '16', w * 0.34, h * 0.21, h * 0.46, ink, { dim: ghost });
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(h * 0.105)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('DISTRESS  SAFETY  CALLING', w * 0.50, h * 0.69);
      ctx.font = `700 ${Math.round(h * 0.10)}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('VOL', w * 0.04, h * 0.84);
      for (let i = 0; i < 10; i++) { ctx.fillStyle = i < 6 ? ink : ghost; ctx.fillRect(w * 0.16 + i * w * 0.03, h * 0.84, w * 0.02, h * 0.11); }
      ctx.fillStyle = ink;
      ctx.fillText('SQL', w * 0.50, h * 0.84);
      for (let i = 0; i < 10; i++) { ctx.fillStyle = i < 4 ? ink : ghost; ctx.fillRect(w * 0.62 + i * w * 0.03, h * 0.84, w * 0.02, h * 0.11); }
    });
  }

  setLit(level, emissiveScale = 1) {
    this.lcdMat.emissiveIntensity = level * 0.55 * emissiveScale;
  }

  dispose() {
    this.faceTex.dispose(); this.lcdTex.dispose();
    disposeTree(this.group);
  }
}

/**
 * The handset: a hand-sized black body with a rounded back, the oval speaker grille and a small
 * keypad on its face, the press-to-talk bar down its left side, and the hook on its back that
 * hangs it on the clip. The handset's own frame has its face at +z and its top at +y; `cordTo`,
 * if given, is where its coiled cord goes - the set's socket - in that frame.
 */
export class Handset {
  constructor({ cordTo = null } = {}) {
    this.group = new THREE.Group();
    const rubber = PLASTIC.rubber();
    const W = 0.058, H = 0.112, D = 0.034;
    this.size = { W, H, D };
    const body = plate(W, H, D, { radius: 0.014, bevel: 0.006, material: rubber });
    this.group.add(body);
    this.faceTex = Art.texture(Art.image(384, Math.round(384 * H / W), (ctx, w, h) => {
      ctx.fillStyle = '#1b1d20';
      ctx.fillRect(0, 0, w, h);
      // The oval grille: concentric rings of holes.
      ctx.fillStyle = '#070809';
      const cx = w / 2, cy = h * 0.27, rx = w * 0.33, ry = h * 0.15;
      for (let ring = 1; ring <= 4; ring++) {
        const n = ring * 7;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rx * ring / 4.4, cy + Math.sin(a) * ry * ring / 4.4, w * 0.018, 0, TAU); ctx.fill();
        }
      }
      ctx.beginPath(); ctx.arc(cx, cy, w * 0.02, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c9cdd1';
      ctx.font = `800 ${Math.round(w * 0.11)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ICOM', cx, h * 0.50);
    }));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.012, H - 0.012),
      new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.62, metalness: 0.02 }));
    face.position.z = 0.0008;
    this.group.add(face);
    // The keys: channel up and down, 16/9, squelch.
    for (const [legend, s] of [['▲', -1], ['▼', 1]]) {
      const cap = keyCap(legend, 0.011, 0.009, { size: 0.6 });
      cap.position.set(s * 0.012, -H * 0.12, 0.0015);
      this.group.add(cap);
    }
    const k16 = keyCap('16/9', 0.020, 0.009, { size: 0.5, face: '#8a2a1e', colour: '#f3e0d8' });
    k16.position.set(0, -H * 0.24, 0.0015);
    this.group.add(k16);
    const sql = keyCap('SQL', 0.020, 0.009, { size: 0.5 });
    sql.position.set(0, -H * 0.35, 0.0015);
    this.group.add(sql);
    // The press-to-talk bar down the left flank.
    const ptt = plate(0.010, 0.046, 0.005, { radius: 0.004, bevel: 0.0015, material: paint(0x0e0f11, 0.5, 0.08) });
    ptt.rotation.y = -Math.PI / 2;
    ptt.position.set(-W / 2 - 0.001, 0.004, -D / 2);
    this.group.add(ptt);
    // The hook on the back and the cord's exit at the bottom.
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.006, 0.010), rubber);
    hook.position.set(0, H * 0.30, -D - 0.004);
    this.group.add(hook);
    const exit = lathe([[0, 0], [0.006, 0], [0.006, 0.012], [0.004, 0.012], [0.004, 0.0], [0, 0]], rubber);
    exit.rotation.x = Math.PI; // pointing down
    exit.position.set(0.006, -H / 2 - 0.002, -D / 2);
    this.group.add(exit);
    if (cordTo) this.group.add(coiledCord(new THREE.Vector3(0.006, -H / 2 - 0.016, -D / 2), cordTo, rubber));
    interior(this.group);
  }

  dispose() { this.faceTex.dispose(); disposeTree(this.group); }
}

/**
 * A coiled cord from `a` to `b`: a helix wound round a path that sags between its ends under its
 * own weight. A real cord hangs in a catenary and the coils open where it is stretched; the sag
 * here is a sine and the pitch constant, which at two metres is the same thing.
 */
export function coiledCord(a, b, material, { coilRadius = 0.011, pitch = 0.0085, wireRadius = 0.0028, sag = 0.22 } = {}) {
  const span = new THREE.Vector3().subVectors(b, a);
  const len = span.length();
  const turns = Math.max(6, Math.round(len / pitch));
  const dir = span.clone().normalize();
  let side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1));
  if (side.lengthSq() < 0.1) side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(1, 0, 0));
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  const steps = turns * 10;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const centre = a.clone().addScaledVector(span, t);
    centre.y -= Math.sin(t * Math.PI) * len * sag;
    const ang = t * turns * TAU;
    centre.addScaledVector(side, Math.cos(ang) * coilRadius).addScaledVector(up, Math.sin(ang) * coilRadius);
    pts.push(centre);
  }
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps, wireRadius, 7, false);
  return new THREE.Mesh(g, material);
}

/**
 * The loudhailer / intercom: the small set under the autopilot head on the pod, a charcoal case
 * with a green LCD at the left, four keys under it and a volume knob at the right. Built facing +z.
 */
export class Hailer {
  constructor({ width = 0.145, height = 0.092 } = {}) {
    this.group = new THREE.Group();
    const W = width, H = height;
    this.faceTex = Art.texture(Art.image(768, Math.round(768 * H / W), (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#30343a'); g.addColorStop(1, '#1b1e22');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      stipple(ctx, w, h, 0.06, 5000);
      ctx.fillStyle = '#0a0b0c';
      ctx.fillRect(w * 0.08, h * 0.16, w * 0.50, h * 0.40);
      ctx.fillStyle = '#d7dbdf'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.font = `800 ${Math.round(h * 0.11)}px ${FONT}`;
      ctx.fillText('STANDARD HORIZON', w * 0.08, h * 0.085);
      ctx.textAlign = 'right'; ctx.font = `600 ${Math.round(h * 0.075)}px ${CONDENSED}`;
      ctx.globalAlpha = 0.85; ctx.fillText('VLH-3000  LOUDHAILER', w * 0.94, h * 0.085);
      ctx.textAlign = 'center'; ctx.font = `600 ${Math.round(h * 0.07)}px ${CONDENSED}`;
      ctx.fillText('VOL', w * 0.80, h * 0.93);
      ctx.globalAlpha = 1;
    }));
    const face = new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.5, metalness: 0.1 });
    this.group.add(plate(W, H, 0.018, { radius: 0.008, bevel: 0.003, material: face, frontUv: true }));
    const back = new THREE.Mesh(new THREE.BoxGeometry(W - 0.006, H - 0.006, 0.09), PLASTIC.case());
    back.position.z = -0.063;
    this.group.add(back);
    // The LCD.
    const lcd = { x: -W * 0.17, y: H * 0.14, w: W * 0.50, h: H * 0.40 };
    this.lcdTex = Art.texture(Art.image(512, Math.round(512 * lcd.h / lcd.w), (ctx, w, h) => {
      ctx.fillStyle = '#b9d9a4'; ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.08; ctx.fillStyle = '#1a2a10';
      for (let x = 0; x < w; x += 4) ctx.fillRect(x, 0, 1, h);
      for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
      ctx.globalAlpha = 1;
      const ink = '#1b2a14';
      ctx.fillStyle = ink; ctx.font = `700 ${Math.round(h * 0.26)}px ${FONT}`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillText('HAIL', w * 0.05, h * 0.08);
      ctx.fillText('FOG  OFF', w * 0.05, h * 0.40);
      ctx.textAlign = 'right';
      ctx.fillText('INTERCOM', w * 0.95, h * 0.08);
      sevenSegment(ctx, '4', w * 0.80, h * 0.36, h * 0.55, ink, { dim: 'rgba(27,42,20,0.10)' });
    }));
    this.lcdMat = new THREE.MeshStandardMaterial({ map: this.lcdTex, emissiveMap: this.lcdTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(lcd.w, lcd.h), this.lcdMat);
    screen.position.set(lcd.x, lcd.y, 0.0012);
    this.group.add(screen);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(lcd.w + 0.003, lcd.h + 0.003), glassMaterial());
    glass.position.set(lcd.x, lcd.y, 0.0024); glass.renderOrder = 6;
    this.group.add(glass);
    // The keys.
    ['HAIL', 'FOG', 'LISTEN', 'I/C'].forEach((legend, i) => {
      const cap = keyCap(legend, W * 0.11, H * 0.16, { size: 0.42 });
      cap.position.set(-W * 0.37 + i * W * 0.125, -H * 0.30, 0.0015);
      this.group.add(cap);
    });
    // The volume knob, with a ring of ridges.
    const knob = new THREE.Group();
    knob.add(lathe([[0, 0], [0.0135, 0], [0.0135, 0.004], [0.012, 0.006]], PLASTIC.chrome()));
    const rubber = PLASTIC.rubber();
    knob.add(lathe([[0, 0.006], [0.0118, 0.006], [0.0118, 0.016], [0.0105, 0.018], [0, 0.018]], rubber, 28));
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.009, 0.0012), rubber);
      ridge.position.set(Math.cos(a) * 0.0119, 0.011, Math.sin(a) * 0.0119);
      ridge.rotation.y = -a;
      knob.add(ridge);
    }
    knob.rotation.x = Math.PI / 2;
    knob.position.set(W * 0.30, -H * 0.08, 0.001);
    this.group.add(knob);
    interior(this.group);
  }

  setLit(level, emissiveScale = 1) { this.lcdMat.emissiveIntensity = level * 0.35 * emissiveScale; }
  dispose() { this.faceTex.dispose(); this.lcdTex.dispose(); disposeTree(this.group); }
}

/**
 * The autopilot's control head: a compact black unit with a small display across its top, two
 * rows of keys under it - the mode keys coloured, as they are on the real thing - and the course
 * knob at the lower right. The display is the caller's (instruments.js paints the heading).
 */
export class AutopilotHead {
  constructor(screenMaterial, { width = 0.125, height = 0.098 } = {}) {
    this.group = new THREE.Group();
    const W = width, H = height;
    this.faceTex = Art.texture(Art.image(640, Math.round(640 * H / W), (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2b2e33'); g.addColorStop(1, '#191c20');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      stipple(ctx, w, h, 0.06, 4000);
      ctx.fillStyle = '#060708';
      ctx.fillRect(w * 0.08, h * 0.10, w * 0.64, h * 0.36);
      ctx.fillStyle = '#d7dbdf'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.font = `800 ${Math.round(h * 0.085)}px ${FONT}`;
      ctx.fillText('SIMRAD', w * 0.76, h * 0.16);
      ctx.font = `600 ${Math.round(h * 0.065)}px ${CONDENSED}`; ctx.globalAlpha = 0.8;
      ctx.fillText('AP44', w * 0.76, h * 0.27);
      ctx.textAlign = 'center';
      ctx.fillText('COURSE', w * 0.80, h * 0.95);
      ctx.globalAlpha = 1;
    }));
    const face = new THREE.MeshStandardMaterial({ map: this.faceTex, roughness: 0.5, metalness: 0.1 });
    this.group.add(plate(W, H, 0.016, { radius: 0.008, bevel: 0.003, material: face, frontUv: true }));
    const back = new THREE.Mesh(new THREE.BoxGeometry(W - 0.006, H - 0.006, 0.06), PLASTIC.case());
    back.position.z = -0.046;
    this.group.add(back);
    const sw = W * 0.62, sh = H * 0.34;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screenMaterial);
    screen.position.set(-W * 0.10, H * 0.22, 0.0012);
    this.group.add(screen);
    this.screen = screen;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(sw + 0.003, sh + 0.003), glassMaterial());
    glass.position.set(-W * 0.10, H * 0.22, 0.0024); glass.renderOrder = 6;
    this.group.add(glass);
    const keys = [
      ['STBY', '#5a5e63', '#f0f2f4'], ['AUTO', '#2a7a3a', '#eafbea'], ['NAV', '#9a7a1a', '#fff6d8'],
      ['◀', '#3a3e43', '#cfd3d7'], ['▶', '#3a3e43', '#cfd3d7'], ['MENU', '#3a3e43', '#cfd3d7'],
    ];
    keys.forEach(([legend, bg, ink], i) => {
      const cap = keyCap(legend, W * 0.17, H * 0.14, { size: 0.42, face: bg, colour: ink });
      cap.position.set(-W * 0.36 + (i % 3) * W * 0.20, -H * 0.10 - Math.floor(i / 3) * H * 0.20, 0.0015);
      this.group.add(cap);
    });
    const knob = new THREE.Group();
    knob.add(lathe([[0, 0], [0.012, 0], [0.012, 0.004], [0.0105, 0.006]], PLASTIC.chrome()));
    const rubber = PLASTIC.rubber();
    knob.add(lathe([[0, 0.006], [0.0103, 0.006], [0.0103, 0.015], [0.009, 0.017], [0, 0.017]], rubber, 28));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.008, 0.0012), rubber);
      ridge.position.set(Math.cos(a) * 0.0104, 0.0105, Math.sin(a) * 0.0104);
      ridge.rotation.y = -a;
      knob.add(ridge);
    }
    knob.rotation.x = Math.PI / 2;
    knob.position.set(W * 0.30, -H * 0.18, 0.001);
    this.group.add(knob);
    interior(this.group);
  }

  dispose() { this.faceTex.dispose(); disposeTree(this.group, this.screen); }
}

// =============================================================================================
// The engine control
// =============================================================================================

/**
 * A twin-lever single-station engine control in polished stainless, in the pattern of the chrome
 * Kobelt head the reference shows: a bevelled block of a housing on a base plate, two levers rising
 * from pivots in its top and curving aft, each ending in the flat paddle of a handle, with the
 * red neutral mark on the housing between them. Built with +y up and the levers swinging about x,
 * so the handles come aft toward +z when pulled back. The port lever (−x) is the throttle and the
 * starboard the gear: `set(throttle, gear)`.
 */
export class EngineControl {
  constructor() {
    this.group = new THREE.Group();
    const chrome = chromeMaterial(1);
    const base = plate(0.150, 0.125, 0.006, { radius: 0.010, bevel: 0.002, material: chrome });
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.006;
    this.group.add(base);
    const housing = plate(0.122, 0.098, 0.092, { radius: 0.012, bevel: 0.007, material: chrome });
    housing.rotation.x = -Math.PI / 2;
    housing.position.y = 0.098;
    this.group.add(housing);
    for (const s of [-1, 1]) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.0015, 0.064), paint(0x0a0b0c, 0.6, 0.1));
      slot.position.set(s * 0.028, 0.0985, 0.0);
      this.group.add(slot);
    }
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.0012, 0.004), paint(0xd0221a, 0.4, 0.05));
    mark.position.set(0, 0.0988, 0.008);
    this.group.add(mark);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 12, 8), new THREE.MeshStandardMaterial({
      color: 0x4a0d08, emissive: 0xff3a22, emissiveIntensity: 0, roughness: 0.35,
    }));
    lamp.position.set(0, 0.062, 0.050);
    this.group.add(lamp);
    this.lamp = lamp;

    this.levers = [];
    for (const s of [-1, 1]) {
      const lever = new THREE.Group();
      lever.position.set(s * 0.028, 0.080, 0.0);
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.070, -0.004), new THREE.Vector3(0, 0.130, -0.016),
        new THREE.Vector3(0, 0.172, -0.034),
      ]);
      lever.add(new THREE.Mesh(new THREE.TubeGeometry(path, 18, 0.0058, 10, false), chrome));
      // The handle: a flattened, rounded paddle lying across the lever's end, the way you cup it.
      const paddle = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), chrome);
      paddle.scale.set(0.034, 0.013, 0.021);
      paddle.position.set(0, 0.178, -0.040);
      paddle.rotation.x = -0.35;
      lever.add(paddle);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0058, 0.012, 12), chrome);
      neck.position.set(0, 0.170, -0.033);
      neck.rotation.x = -0.4;
      lever.add(neck);
      this.group.add(lever);
      this.levers.push(lever);
    }
    this.set(0.5, 1);
    interior(this.group);
  }

  /** Throttle 0..1 (idle to full) and gear -1, 0, 1 (astern, neutral, ahead). */
  set(throttle, gear) {
    this.levers[0].rotation.x = lerp(0.45, -0.55, clamp01(throttle));
    this.levers[1].rotation.x = -0.48 * Math.sign(gear);
  }

  setLit(level, emissiveScale = 1) { this.lamp.material.emissiveIntensity = level * 0.6 * emissiveScale; }
  dispose() { disposeTree(this.group); }
}

// =============================================================================================
// Gauges
// =============================================================================================

/**
 * A round instrument face. The sweep is the real one: a marine engine gauge runs its scale over
 * about 250 degrees with the zero at the bottom left, which is why a tachometer's needle points
 * straight up at roughly two thirds of its range rather than at half.
 */
export function gaugeFace({
  label = '', unit = '', min = 0, max = 100, major = 20, minor = 5,
  redFrom = null, dark = true, blue = false, size = 512, maker = 'FARIA', sub = '',
} = {}) {
  const A0 = 125 * DEG, A1 = 415 * DEG;
  return Art.image(size, size, (ctx, w) => {
    const c = w / 2, r = w * 0.5;
    const ink = blue ? '#f2f4f8' : dark ? '#f2efe8' : '#1a1a18';
    const faceA = blue ? '#2457a6' : dark ? '#17181a' : '#e8e4d8';
    const faceB = blue ? '#0b2558' : dark ? '#05060a' : '#cfc9b8';
    const g = ctx.createRadialGradient(c, c * 0.86, r * 0.1, c, c, r);
    g.addColorStop(0, faceA);
    g.addColorStop(1, faceB);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.fill();
    const at = (v) => A0 + (A1 - A0) * clamp01((v - min) / (max - min));
    const polar = (ang, rad) => [c + Math.cos(ang) * rad, c + Math.sin(ang) * rad];
    if (redFrom !== null) {
      ctx.strokeStyle = '#d2302a';
      ctx.lineWidth = r * 0.055;
      ctx.beginPath(); ctx.arc(c, c, r * 0.80, at(redFrom), at(max)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    for (let v = min; v <= max + 1e-6; v += minor) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const ang = at(v);
      ctx.strokeStyle = ink;
      ctx.lineWidth = r * (isMajor ? 0.030 : 0.013);
      ctx.beginPath(); ctx.moveTo(...polar(ang, r * (isMajor ? 0.665 : 0.715))); ctx.lineTo(...polar(ang, r * 0.755)); ctx.stroke();
      if (!isMajor) continue;
      const [tx, ty] = polar(ang, r * 0.545);
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.round(r * 0.20)}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round(v)), tx, ty);
    }
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
      ctx.globalAlpha = 0.8; ctx.fillText(unit, c, c + r * 0.50); ctx.globalAlpha = 1;
    }
    if (sub) { ctx.font = `500 ${Math.round(r * 0.09)}px ${CONDENSED}`; ctx.globalAlpha = 0.6; ctx.fillText(sub, c, c + r * 0.64); ctx.globalAlpha = 1; }
  });
}

/**
 * A round gauge: a bezel standing proud of the face, the printed dial, a needle a millimetre proud
 * of that, and its own glass. `bezel` is 'black' (the engine gauges in the reference have a black
 * bezel with a thin bright ring at the glass) or 'chrome' (the clock and barometer aft). The
 * needle is turned by `set(value)` on gaugeFace's sweep. Built facing +z.
 */
export class Gauge {
  constructor(opts = {}) {
    const d = opts.diameter ?? 0.090;
    const r = d / 2;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 100;
    this.group = new THREE.Group();
    const ring = opts.bezel === 'chrome' ? PLASTIC.chrome() : paint(0x111317, 0.42, 0.25);
    const bezel = lathe([[r * 0.80, 0], [r * 1.02, 0], [r * 1.02, 0.004], [r * 0.98, 0.009], [r * 0.90, 0.011], [r * 0.86, 0.011]], ring, 44);
    bezel.rotation.x = Math.PI / 2;
    this.group.add(bezel);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.88, 0.0012, 8, 48), PLASTIC.chrome());
    lip.position.z = 0.011;
    this.group.add(lip);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.82, 0.055, 28, 1, true), paint(0x15171a, 0.62, 0.25, { side: THREE.DoubleSide }));
    can.rotation.x = Math.PI / 2;
    can.position.z = -0.0275;
    this.group.add(can);

    // The dial, with its own map as an emissive map too: at night a marine gauge's dial is lit
    // from behind, and setLit turns that up as the panel lighting comes on.
    this.faceTex = Art.texture(gaugeFace(opts));
    this.faceMat = new THREE.MeshStandardMaterial({ map: this.faceTex, emissiveMap: this.faceTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.66, metalness: 0 });
    const face = new THREE.Mesh(new THREE.CircleGeometry(r * 0.86, 44), this.faceMat);
    face.position.z = 0.003;
    this.group.add(face);

    const needle = new THREE.Group();
    const needleColour = opts.needle ?? 0xf2f0ea;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r * 0.66, r * 0.05, 0.0014), paint(needleColour, 0.42, 0.05));
    blade.position.set(r * 0.31, 0, 0.0065);
    needle.add(blade);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.18, r * 0.07, 0.0014), paint(needleColour, 0.42, 0.05));
    tail.position.set(-r * 0.09, 0, 0.0065);
    needle.add(tail);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.08, r * 0.08, 0.005, 16), paint(0x0c0d0f, 0.4, 0.3));
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.0075;
    needle.add(hub);
    this.group.add(needle);
    this.needle = needle;

    const glass = new THREE.Mesh(new THREE.CircleGeometry(r * 0.87, 44), glassMaterial(0.06));
    glass.position.z = 0.0105;
    glass.renderOrder = 6;
    this.group.add(glass);
    this.set(opts.start ?? this.min);
    interior(this.group);
  }

  set(value) {
    const t = clamp01((value - this.min) / (this.max - this.min || 1));
    this.needle.rotation.z = -(125 * DEG + t * 290 * DEG);
  }

  /** The dial's backlight, a screen brightness like every other lit thing in the house. */
  setLit(level, emissiveScale = 1) { this.faceMat.emissiveIntensity = level * 0.6 * emissiveScale; }

  dispose() { this.faceTex.dispose(); disposeTree(this.group); }
}

// =============================================================================================
// Displays
// =============================================================================================

/**
 * A bezelled display: the chartplotter, the fishfinder, the overhead repeaters. The bezel is a
 * bevelled charcoal case with a row of keys along its lower edge (or down its right side) and a
 * brand strip; the screen is whatever material the caller hands in (instruments.js paints the live
 * ones), a hair behind the bezel's face under a glass. Built facing +z, centred on the screen.
 */
export class Display {
  constructor(screenMaterial, { width = 0.30, height = 0.22, keys = ['MENU', 'PAGE', 'MOB', 'RANGE', 'ENT'], brand = 'FURUNO', keysRight = false, depth = 0.030 } = {}) {
    this.group = new THREE.Group();
    const bezW = width + (keysRight ? 0.078 : 0.046), bezH = height + (keysRight ? 0.046 : 0.082);
    const body = plate(bezW, bezH, depth, { radius: 0.010, bevel: 0.004, material: PLASTIC.case() });
    body.position.set(keysRight ? 0.016 : 0, keysRight ? 0 : -0.018, 0);
    this.group.add(body);
    this.size = { w: bezW, h: bezH, x: body.position.x, y: body.position.y };
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), screenMaterial);
    screen.position.z = 0.0012;
    this.group.add(screen);
    this.screen = screen;
    const border = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.014, height + 0.014), paint(0x050607, 0.3, 0.1));
    border.position.z = 0.0006;
    this.group.add(border);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.014, height + 0.014), glassMaterial(0.04));
    glass.position.z = 0.0022;
    glass.renderOrder = 6;
    this.group.add(glass);
    const kw = 0.020, kh = 0.011;
    keys.forEach((legend, i) => {
      const cap = keyCap(legend, kw, kh, { size: 0.42 });
      if (keysRight) cap.position.set(width / 2 + 0.030, height / 2 - 0.012 - i * (kh + 0.006), 0.0015);
      else cap.position.set(-width / 2 + 0.02 + i * (kw + 0.008), -height / 2 - 0.028, 0.0015);
      this.group.add(cap);
    });
    const tag = label(brand, 0.05, 0.009, { bg: '#1c1f23', ink: '#c9ced3', size: 0.7 });
    if (keysRight) tag.position.set(width / 2 + 0.030, -height / 2 + 0.012, 0.0015);
    else tag.position.set(width / 2 - 0.03, -height / 2 - 0.028, 0.0015);
    this.group.add(tag);
    interior(this.group);
  }

  dispose() { disposeTree(this.group, this.screen); }
}

// =============================================================================================
// The breaker panels
// =============================================================================================

/**
 * A DC distribution panel of the kind on either side of the wheel: a black plate in a bevelled
 * frame, two digital meters along the top, a legend for each circuit, and two columns of breakers
 * - each a small black toggle standing proud of the plate with a red tell-tale beside it that
 * lights when the circuit is live. Built facing +z.
 */
export class BreakerPanel {
  constructor(circuits, { width = 0.30, height = 0.42, title = 'DC DISTRIBUTION', meters = ['VOLTS', 'AMPS'], on = [] } = {}) {
    this.group = new THREE.Group();
    this.w = width; this.h = height;
    const perCol = Math.ceil(circuits.length / 2);
    const topBand = height * 0.26;
    const rowH = (height - topBand - 0.02) / perCol;

    this.plateTex = Art.texture(Art.image(1024, Math.round(1024 * height / width), (ctx, w, h) => {
      ctx.fillStyle = '#0f1113';
      ctx.fillRect(0, 0, w, h);
      brushed(ctx, w, h);
      ctx.fillStyle = '#d9dde1';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(w * 0.045)}px ${CONDENSED}`;
      ctx.fillText(title, w / 2, h * 0.035);
      meters.forEach((m, i) => {
        const mx = w * (0.28 + i * 0.44);
        ctx.fillStyle = '#1e2226';
        ctx.fillRect(mx - w * 0.16, h * 0.07, w * 0.32, h * 0.085);
        ctx.fillStyle = '#9aa0a6';
        ctx.font = `600 ${Math.round(w * 0.034)}px ${CONDENSED}`;
        ctx.fillText(m, mx, h * 0.175);
      });
      ctx.fillStyle = 'rgba(200,210,220,0.3)';
      ctx.fillRect(w * 0.05, h * 0.215, w * 0.90, 2);
      ctx.textAlign = 'left';
      circuits.forEach((name, i) => {
        const col = Math.floor(i / perCol), k = i % perCol;
        const cx = w * (0.05 + col * 0.50), cy = h * (topBand / height) + (k + 0.5) * rowH / height * h;
        ctx.fillStyle = '#e4e8eb';
        ctx.font = `600 ${Math.round(w * 0.031)}px ${CONDENSED}`;
        ctx.fillText(name.toUpperCase(), cx + w * 0.185, cy - h * 0.004);
        ctx.globalAlpha = 0.55;
        ctx.font = `500 ${Math.round(w * 0.024)}px ${CONDENSED}`;
        ctx.fillText(`${[5, 10, 15, 20, 30][i % 5]} A`, cx + w * 0.185, cy + h * 0.016);
        ctx.globalAlpha = 1;
      });
    }));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({ map: this.plateTex, roughness: 0.5, metalness: 0.3 }));
    this.group.add(face);
    const frame = plate(width + 0.016, height + 0.016, 0.012, { radius: 0.004, bevel: 0.002, material: PLASTIC.plate() });
    frame.position.z = -0.0005;
    this.group.add(frame);

    this.meters = meters.map((m, i) => {
      const tex = Art.texture(Art.image(256, 96, (ctx, w, h) => { ctx.fillStyle = '#0d1a0f'; ctx.fillRect(0, 0, w, h); }));
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.30, height * 0.075), mat);
      mesh.position.set(-width / 2 + width * (0.28 + i * 0.44), height / 2 - height * 0.1125, 0.0012);
      mesh.userData.tex = tex;
      this.group.add(mesh);
      return { tex, mat, mesh, kind: m, shown: null };
    });

    this.breakers = [];
    const toggleMat = paint(0x1a1c1f, 0.45, 0.2);
    circuits.forEach((name, i) => {
      const col = Math.floor(i / perCol), k = i % perCol;
      const x = -width / 2 + width * (0.05 + col * 0.50) + width * 0.06;
      const y = height / 2 - topBand - (k + 0.5) * rowH;
      const boss = lathe([[0, 0], [0.0055, 0], [0.0055, 0.0025], [0.0040, 0.0035], [0, 0.0035]], PLASTIC.plate());
      boss.rotation.x = Math.PI / 2;
      boss.position.set(x, y, 0);
      this.group.add(boss);
      const lever = new THREE.Group();
      lever.position.set(x, y, 0.0035);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0022, 0.012, 10), toggleMat);
      stem.position.y = 0.006;
      lever.add(stem);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 12, 8), toggleMat);
      tip.position.y = 0.0125;
      lever.add(tip);
      this.group.add(lever);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 10, 8), new THREE.MeshStandardMaterial({
        color: 0x3a0806, emissive: 0xff2a1c, emissiveIntensity: 0, roughness: 0.35,
      }));
      led.position.set(x + width * 0.075, y, 0.0015);
      this.group.add(led);
      this.breakers.push({ lever, led, on: on.includes(i), name });
    });
    this.apply();
    interior(this.group);
  }

  /** Tilts each toggle to its state: up is on. The lever's rest is along +z, out of the panel. */
  apply() {
    for (const b of this.breakers) b.lever.rotation.x = Math.PI / 2 + (b.on ? -0.55 : 0.55);
  }

  throwBreaker(i) {
    const b = this.breakers[i]; if (!b) return false;
    b.on = !b.on; this.apply(); return b.on;
  }

  /**
   * The tell-tales and the meters, as screen brightnesses following the camera's exposure.
   * `values` is one number per meter, in the order the meters were named.
   */
  setLit(level, emissiveScale = 1, values = []) {
    for (const b of this.breakers) b.led.material.emissiveIntensity = (b.on ? 0.6 : 0) * level * emissiveScale;
    this.meters.forEach((m, i) => {
      const v = (values[i] ?? 0).toFixed(1);
      if (v !== m.shown) {
        const ctx = m.tex.image.getContext('2d'), w = m.tex.image.width, h = m.tex.image.height;
        ctx.fillStyle = '#0d1a0f'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#8ff07a';
        ctx.font = `700 ${Math.round(h * 0.78)}px ${MONO}`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(v, w * 0.92, h * 0.55);
        m.tex.needsUpdate = true;
        m.shown = v;
      }
      m.mat.emissiveIntensity = 0.45 * level * emissiveScale;
    });
  }

  dispose() { this.plateTex.dispose(); disposeTree(this.group); }
}

// =============================================================================================
// The small panels, lights and oddments
// =============================================================================================

/** A plain black plate with its four screws: the blanking panel at the left of the fascia. */
export function blankPanel(w, h) {
  const g = new THREE.Group();
  g.add(plate(w, h, 0.004, { radius: 0.004, bevel: 0.001, material: PLASTIC.plate() }));
  const chrome = PLASTIC.chrome();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const screw = lathe([[0, 0], [0.0035, 0], [0.0035, 0.0012], [0.0028, 0.002], [0, 0.002]], chrome, 16);
    screw.rotation.x = Math.PI / 2;
    screw.position.set(sx * (w / 2 - 0.012), sy * (h / 2 - 0.012), 0.0005);
    g.add(screw);
  }
  return interior(g);
}

/**
 * A small switch panel of the kind that sits between the instruments overhead: a black plate with
 * a rotary selector and a pair of knobs across the top, and a lower section of push buttons with
 * tell-tales. `legends` names the lower buttons. Built facing +z.
 */
export class SwitchPanel {
  constructor(legends = ['NAV', 'ANCHOR', 'DECK', 'SPOT'], { width = 0.15, height = 0.24, title = 'LIGHTING', lit = [0] } = {}) {
    this.group = new THREE.Group();
    this.tex = Art.texture(Art.image(512, Math.round(512 * height / width), (ctx, w, h) => {
      ctx.fillStyle = '#121416'; ctx.fillRect(0, 0, w, h);
      brushed(ctx, w, h, 0.06);
      ctx.fillStyle = '#d9dde1'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(w * 0.075)}px ${CONDENSED}`;
      ctx.fillText(title, w / 2, h * 0.045);
      ctx.font = `600 ${Math.round(w * 0.055)}px ${CONDENSED}`;
      ['DIM', 'PANEL', 'WIPER'].forEach((t, i) => ctx.fillText(t, w * (0.22 + i * 0.28), h * 0.30));
      ctx.fillStyle = 'rgba(200,210,220,0.3)'; ctx.fillRect(w * 0.06, h * 0.40, w * 0.88, 2);
      ctx.fillStyle = '#d9dde1';
      legends.forEach((t, i) => ctx.fillText(t.toUpperCase(), w * (0.27 + (i % 2) * 0.46), h * (0.52 + Math.floor(i / 2) * 0.20)));
    }));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.5, metalness: 0.3 }));
    this.group.add(face);
    const frame = plate(width + 0.012, height + 0.012, 0.010, { radius: 0.004, bevel: 0.002, material: PLASTIC.plate() });
    frame.position.z = -0.0005;
    this.group.add(frame);
    const chrome = PLASTIC.chrome(), rubber = PLASTIC.rubber();
    const pointerMat = paint(0xf0f0ea, 0.5, 0);
    [0.22, 0.50, 0.78].forEach((fx, i) => {
      const k = new THREE.Group();
      k.add(lathe([[0, 0], [0.011, 0], [0.011, 0.004], [0.0092, 0.006]], chrome));
      k.add(lathe([[0, 0.006], [0.0090, 0.006], [0.0090, 0.014], [0.0078, 0.016], [0, 0.016]], rubber));
      const ptr = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.0006, 0.007), pointerMat);
      ptr.position.set(0, 0.0162, 0.0045);
      k.add(ptr);
      k.rotation.x = Math.PI / 2; k.rotation.y = 0.3 + i * 0.8;
      k.position.set(-width / 2 + width * fx, height / 2 - height * 0.17, 0.001);
      this.group.add(k);
    });
    this.lamps = [];
    this.lit = lit;
    const btnMat = paint(0x2b2f34, 0.45, 0.1);
    legends.forEach((t, i) => {
      const x = -width / 2 + width * (0.27 + (i % 2) * 0.46), y = height / 2 - height * (0.52 + Math.floor(i / 2) * 0.20) - 0.018;
      const btn = lathe([[0, 0], [0.0075, 0], [0.0075, 0.004], [0.0062, 0.005], [0, 0.005]], btnMat, 20);
      btn.rotation.x = Math.PI / 2; btn.position.set(x - 0.012, y, 0.001);
      this.group.add(btn);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.0025, 10, 8), new THREE.MeshStandardMaterial({ color: 0x1a2a0a, emissive: 0x6cff40, emissiveIntensity: 0, roughness: 0.35 }));
      led.position.set(x + 0.014, y, 0.0015);
      this.group.add(led);
      this.lamps.push(led);
    });
    interior(this.group);
  }

  setLit(level, emissiveScale = 1) { this.lamps.forEach((l, i) => { l.material.emissiveIntensity = (this.lit.includes(i) ? 0.6 : 0) * level * emissiveScale; }); }
  dispose() { this.tex.dispose(); disposeTree(this.group); }
}

/**
 * A chart light: a black gooseneck from a base on the desk, curving up and over to a cylindrical
 * hood that points down at the chart. `reach` is signed: positive brings the hood toward +x.
 * Returns the group with `userData.bulb`, the lit disc inside the hood.
 */
export function chartLight(height = 0.30, reach = 0.16) {
  const g = new THREE.Group();
  const black = PLASTIC.anodised();
  g.add(lathe([[0, 0], [0.024, 0], [0.024, 0.008], [0.018, 0.012], [0.009, 0.012], [0.009, 0.03], [0, 0.03]], black, 24));
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(0, height * 0.55, 0.0), new THREE.Vector3(reach * 0.35, height * 0.95, 0.02),
    new THREE.Vector3(reach * 0.8, height, 0.05), new THREE.Vector3(reach, height * 0.92, 0.06),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 24, 0.0065, 9, false), black));
  for (let i = 1; i < 22; i++) {
    const t = i / 22;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0068, 0.0012, 6, 14), black);
    ring.position.copy(path.getPoint(t));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), path.getTangent(t));
    g.add(ring);
  }
  // The hood hangs from the end of the neck and points down and a little forward.
  const end = path.getPoint(1);
  const hood = new THREE.Group();
  hood.position.copy(end);
  hood.rotation.set(0.25, 0, Math.sign(reach) * -0.3);
  hood.add(lathe([[0.006, 0], [0.014, -0.010], [0.020, -0.022], [0.020, -0.060], [0.013, -0.060], [0.013, -0.024], [0.004, -0.004]], black, 24));
  const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.0125, 18), new THREE.MeshStandardMaterial({ color: 0xf6efe0, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.5 }));
  bulb.position.y = -0.058;
  bulb.rotation.x = Math.PI / 2;
  hood.add(bulb);
  // And the light it throws: a narrow warm cone down onto the desk, with a shadow map of its own,
  // so the binder and the keyboard sit in its pool rather than float in it. pilot.js sets its
  // strength with the room's lamps.
  const spot = new THREE.SpotLight(0xffe2bc, 0, 2.2, 0.55, 0.5, 2);
  spot.position.set(0, -0.050, 0);
  spot.target.position.set(0, -1.0, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.0003;
  spot.shadow.normalBias = 0.01;
  spot.shadow.camera.near = 0.05;
  spot.shadow.camera.far = 2.5;
  spot.shadow.autoUpdate = false;
  hood.add(spot);
  hood.add(spot.target);
  const beam = lampBeam(0.42, 0.42, 0xffe2bc);
  beam.position.set(0, -0.052, 0);
  hood.add(beam);
  g.add(hood);
  g.userData.bulb = bulb;
  g.userData.spot = spot;
  g.userData.beam = beam;
  return interior(g);
}

/** A handheld VHF: the little black radio with its stub antenna, standing in its cradle. */
export function handheldVhf() {
  const g = new THREE.Group();
  const rubber = PLASTIC.rubber();
  const body = plate(0.062, 0.125, 0.034, { radius: 0.008, bevel: 0.004, material: rubber });
  body.position.y = 0.0625;
  g.add(body);
  const tex = Art.texture(Art.image(192, 384, (ctx, w, h) => {
    ctx.fillStyle = '#1c1e21'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9fe36a'; ctx.fillRect(w * 0.15, h * 0.12, w * 0.70, h * 0.22);
    ctx.fillStyle = '#1c1e21'; ctx.font = `700 ${Math.round(h * 0.14)}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('16', w * 0.5, h * 0.23);
    ctx.fillStyle = '#3a3e43';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) ctx.fillRect(w * (0.15 + c * 0.25), h * (0.42 + r * 0.11), w * 0.20, h * 0.08);
    ctx.fillStyle = '#0a0b0c';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) { ctx.beginPath(); ctx.arc(w * (0.2 + c * 0.12), h * (0.90 + r * 0.03), w * 0.02, 0, TAU); ctx.fill(); }
  }));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.050, 0.112), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0x202020, emissiveIntensity: 0.3, roughness: 0.6 }));
  face.position.set(0, 0.0625, 0.0012);
  face.userData.tex = tex;
  g.add(face);
  g.add(bar(new THREE.Vector3(-0.018, 0.125, -0.012), new THREE.Vector3(-0.018, 0.27, -0.012), 0.0045, rubber, 10));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0048, 10, 8), rubber);
  tip.position.set(-0.018, 0.27, -0.012);
  g.add(tip);
  return interior(g);
}

/** The thruster joystick: a black base and a stick with a ball top, on the starboard desk. */
export function joystick() {
  const g = new THREE.Group();
  const black = PLASTIC.anodised();
  const base = plate(0.075, 0.075, 0.016, { radius: 0.006, bevel: 0.003, material: black });
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.016;
  g.add(base);
  g.add(lathe([[0, 0.016], [0.018, 0.016], [0.012, 0.036], [0.006, 0.050], [0, 0.050]], PLASTIC.rubber(), 20));
  g.add(bar(new THREE.Vector3(0, 0.045, 0), new THREE.Vector3(0.012, 0.11, 0.0), 0.0045, black, 10));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 18, 12), PLASTIC.rubber());
  ball.position.set(0.014, 0.122, 0);
  g.add(ball);
  return interior(g);
}

/** A steering compass in a black binnacle with a chrome bezel and a glass dome, as on top of the pod. */
export function compassDome() {
  const g = new THREE.Group();
  const black = paint(0x15171a, 0.5, 0.2);
  g.add(lathe([[0, 0], [0.052, 0], [0.056, 0.006], [0.056, 0.026], [0.050, 0.030], [0.046, 0.030]], black, 36));
  g.add(lathe([[0.044, 0.030], [0.052, 0.030], [0.052, 0.036], [0.048, 0.038], [0.044, 0.036]], PLASTIC.chrome(), 36));
  const card = Art.texture(Art.image(256, 256, (ctx, w) => {
    ctx.fillStyle = '#f0ece2'; ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    for (let i = 0; i < 72; i++) {
      const a = i * TAU / 72; const r0 = i % 2 ? w * 0.42 : w * 0.38;
      ctx.beginPath(); ctx.moveTo(w / 2 + Math.cos(a) * r0, w / 2 + Math.sin(a) * r0); ctx.lineTo(w / 2 + Math.cos(a) * w * 0.46, w / 2 + Math.sin(a) * w * 0.46); ctx.stroke();
    }
    ctx.fillStyle = '#222'; ctx.font = `700 ${Math.round(w * 0.14)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => { const a = (d - 90) * DEG; ctx.fillText(t, w / 2 + Math.cos(a) * w * 0.28, w / 2 + Math.sin(a) * w * 0.28); });
    ctx.strokeStyle = '#c0281e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(w / 2, w * 0.1); ctx.lineTo(w / 2, w * 0.9); ctx.stroke();
  }));
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.044, 36), new THREE.MeshStandardMaterial({ map: card, roughness: 0.5 }));
  face.rotation.x = -Math.PI / 2; face.position.y = 0.030;
  face.userData.tex = card;
  g.add(face);
  g.userData.card = face;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.046, 32, 16, 0, TAU, 0, Math.PI / 2), new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  dome.position.y = 0.032;
  dome.renderOrder = 7;
  g.add(dome);
  return interior(g);
}

/** A cream wall outlet or switch plate, printed. */
export function wallPlate(kind = 'outlet') {
  const w = 0.072, h = 0.115;
  const tex = Art.texture(Art.image(192, Math.round(192 * h / w), (ctx, cw, ch) => {
    ctx.fillStyle = '#ebe6da'; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#d8d2c4'; ctx.fillRect(cw * 0.06, ch * 0.04, cw * 0.88, ch * 0.92);
    if (kind === 'outlet') {
      for (const y of [0.30, 0.70]) {
        ctx.fillStyle = '#ebe6da'; ctx.beginPath(); ctx.arc(cw * 0.5, ch * y, cw * 0.17, 0, TAU); ctx.fill();
        ctx.fillStyle = '#2a2a28'; ctx.fillRect(cw * 0.40, ch * (y - 0.07), cw * 0.05, ch * 0.08); ctx.fillRect(cw * 0.55, ch * (y - 0.07), cw * 0.05, ch * 0.08);
        ctx.beginPath(); ctx.arc(cw * 0.5, ch * (y + 0.07), cw * 0.035, 0, TAU); ctx.fill();
      }
    } else {
      ctx.fillStyle = '#ebe6da'; ctx.fillRect(cw * 0.33, ch * 0.22, cw * 0.34, ch * 0.56);
      ctx.fillStyle = '#d0cabd'; ctx.fillRect(cw * 0.36, ch * 0.25, cw * 0.28, ch * 0.25);
    }
    ctx.fillStyle = '#b9b3a6'; for (const y of [0.09, 0.91]) { ctx.beginPath(); ctx.arc(cw * 0.5, ch * y, cw * 0.035, 0, TAU); ctx.fill(); }
  }));
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
  m.userData.tex = tex;
  return m;
}

/**
 * A louvred cabinet door with its knob. The slats are geometry rather than a normal map, because
 * they are 30 mm apart at arm's length and a map of them goes flat the moment the light moves.
 */
export function louvreDoor(w, h, material, { slat = 0.026, frame = 0.055, knob = true, hinge = 1 } = {}) {
  const g = new THREE.Group();
  const inner = { w: w - frame * 2, h: h - frame * 2 };
  for (const [pw, ph, px, py] of [
    [frame, h, -w / 2 + frame / 2, 0], [frame, h, w / 2 - frame / 2, 0],
    [inner.w, frame, 0, h / 2 - frame / 2], [inner.w, frame, 0, -h / 2 + frame / 2],
  ]) {
    const m = new THREE.Mesh(scaleUvs(new THREE.BoxGeometry(pw, ph, 0.020), pw, ph), material);
    m.position.set(px, py, 0);
    g.add(m);
  }
  const n = Math.max(3, Math.floor(inner.h / slat));
  for (let i = 0; i < n; i++) {
    const y = -inner.h / 2 + (i + 0.5) * (inner.h / n);
    const s = new THREE.Mesh(scaleUvs(new THREE.BoxGeometry(inner.w, slat * 0.92, 0.009), inner.w, slat), material);
    s.position.set(0, y, -0.004);
    s.rotation.x = 28 * DEG;
    g.add(s);
  }
  if (knob) {
    const k = lathe([[0, 0], [0.007, 0], [0.007, 0.010], [0.014, 0.016], [0.014, 0.024], [0.009, 0.028], [0, 0.028]], material, 18);
    k.rotation.x = Math.PI / 2;
    k.position.set(-hinge * (w / 2 - frame * 0.5 - 0.012), 0, 0.010);
    g.add(k);
  }
  return g;
}
