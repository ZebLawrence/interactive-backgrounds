// Diorama — Entry point: settings, menu, the eye (webcam or mouse), the window projection and the frame loop.

import * as THREE from 'three';
import { windowFrustum, MIN_EYE_Z } from './offaxis.js';
import { cameraToWindow, windowMetrics, HeadFilter, REST_HEAD } from './headpose.js';
import { Tracker, DEFAULT_CAMERA_FOV } from './tracker.js';
import { Room } from './room.js';
import { Computer } from './pc.js';
import { Office } from './noir.js';
import { Theatre } from './stage.js';
import { buildPost } from './post.js';
import { Governor } from './governor.js';

/** The skins: what lives behind the glass. The box is the plain proof of concept, kept for checking the tracking. */
const SKINS = { theatre: { name: 'Paper Theatre', make: Theatre }, office: { name: 'The Office', make: Office }, computer: { name: 'Computer', make: Computer }, box: { name: 'Test Box', make: Room } };

const params = new URLSearchParams(location.search);

/** Display sizes the menu steps through, in inches across the diagonal. */
const DIAGONALS = [13, 14, 16, 22, 24, 27, 32, 34, 43];
/** Where Calibrate assumes the viewer is sitting: straight in front of the window's centre, this far back. */
const CALIBRATE_DISTANCE = 0.6;
/** A face not seen for this long is gone, and the view drifts back to the middle. */
const LOST_AFTER = 0.6;

/** A first guess at the display's size from what the browser says about it; the menu corrects it. */
function guessDiagonal() {
  const w = screen.width, dpr = window.devicePixelRatio || 1;
  if (dpr >= 1.5 && w <= 1800) return w <= 1470 ? 14 : 16; // a laptop's own panel
  if (w >= 3000) return 27;
  return 24;
}

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('diorama.' + key);
      if (v === null) return fallback;
      if (typeof fallback === 'boolean') return v === 'true';
      if (typeof fallback === 'number') return Number.isFinite(Number(v)) ? Number(v) : fallback;
      return v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('diorama.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?camera` / `?mouse`, `?preview`, `?hud`, `?lowpower` and `?diag=27` override the saved settings for testing.
  trackingOverride: params.has('camera') ? 'camera' : (params.has('mouse') ? 'mouse' : null),
  /** 'camera', 'mouse', or '' while the viewer has not been asked yet. */
  get tracking() { return this.trackingOverride ?? this.read('tracking', ''); },
  set tracking(v) { this.trackingOverride = null; this.write('tracking', v); },
  get preview() { return params.has('preview') || this.read('preview', false); },
  set preview(v) { this.write('preview', v); },
  get hud() { return params.has('hud') || this.read('hud', false); },
  set hud(v) { this.write('hud', v); },
  get skin() { const q = params.get('skin'); return q in SKINS ? q : (this.read('scene', 'theatre') in SKINS ? this.read('scene', 'theatre') : 'theatre'); },
  set skin(v) { params.delete('skin'); this.write('scene', v); },
  // Each skin's own mood or chapter: the computer's lighting, the office's night.
  get ledMode() { return params.get('leds') ?? this.read(`mode.${this.skin}`, ''); },
  set ledMode(v) { params.delete('leds'); this.write(`mode.${this.skin}`, v); },
  get fullRes() { return params.has('fullres') || this.read('fullRes', false); },
  set fullRes(v) { this.write('fullRes', v); },
  get lowPower() { return params.has('lowpower') || this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get diagonal() {
    const q = Number(params.get('diag'));
    return q > 5 && q < 120 ? q : this.read('diagonal', guessDiagonal());
  },
  set diagonal(v) { this.write('diagonal', v); },
  // Calibration: a correction to the camera's focal length, and to where the lens is taken to be.
  get focalScale() { return this.read('focalScale', 1); },
  set focalScale(v) { this.write('focalScale', v); },
  get camFixX() { return this.read('camFixX', 0); },
  set camFixX(v) { this.write('camFixX', v); },
  get camFixY() { return this.read('camFixY', 0); },
  set camFixY(v) { this.write('camFixY', v); },
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('diorama');
    this.pointer = { x: 0.5, y: 0.5 }; // fractions of the window, y up
    this.mouseZ = REST_HEAD.z;
    this.eye = { ...REST_HEAD };       // the eye the frame is drawn for, in the window frame, metres
    this.pinned = null;                // a fixed eye, set from the console for testing
    this.headCam = null;               // the tracker's filtered head, in the camera frame
    this.lastSeen = -Infinity;         // when a face was last found, seconds
    this.lastSample = null;
    this.filter = new HeadFilter();
    this.time = 0;
    this.settleUntil = 0;
    this.lastFrame = null;
    this.paused = false;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070a);
    // An ordinary camera object, but its projection is set by hand every frame and it never turns (offaxis.js).
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = true;

    this.video = document.getElementById('cam');
    this.overlay = document.getElementById('camOverlay');
    this.tracker = new Tracker(this.video, (s) => this.onSample(s), () => this.settings.focalScale);

    this.layout();
    this.bindInput();
    this.bindMenu();
    this.applyPanels();

    const mode = this.settings.tracking;
    if (mode === 'camera') this.startCamera();
    else if (mode === '') this.showIntro();
    requestAnimationFrame((t) => this.frame(t));
  }

  // MARK: - The window and the skin

  /** Measures the window in metres, sizes the canvas and (re)builds the box to fit. */
  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!(w > 0 && h > 0)) return;
    this.size = { w, h };
    this.measure();
    // A new size starts the governor again from full resolution.
    this.governor = new Governor({ allowScale: !this.settings.fullRes, fps: this.settings.lowPower ? 30 : 60 });
    this.nativeRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatio = this.nativeRatio * this.governor.scale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post?.resize(w, h, this.pixelRatio);
    // The skin is built to the window's size. Building one takes a moment, and a window being dragged to a
    // new size reports dozens of sizes: build at once the first time, then only when the size has settled.
    clearTimeout(this.buildTimer);
    if (!this.skin) this.buildSkin();
    else this.buildTimer = setTimeout(() => this.buildSkin(), 250);
  }

  /** The governor stepped down: draw fewer pixels (the canvas still fills the window), and give it a moment. */
  applyGovernor() {
    this.pixelRatio = this.nativeRatio * this.governor.scale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.post?.resize(this.size.w, this.size.h, this.pixelRatio);
    this.settle(1500);
  }

  /** Builds, resizes and mode changes compile shaders and warm the light probes: do not judge the frame rate for a while. */
  settle(ms = 4000) { this.settleUntil = performance.now() + ms; this.governor?.settle(); }

  /** A line from the skin (a chapter's caption), shown where the first hint was and faded out again. */
  say(text, ms = 9000) {
    if (!this.hint) return;
    this.hint.textContent = text;
    this.hint.classList.remove('gone');
    clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(() => this.hint.classList.add('gone'), ms);
  }

  /** Replaces what is behind the glass, and the post stack that goes with its look. */
  buildSkin() {
    clearTimeout(this.buildTimer);
    this.skin?.dispose();
    this.post?.dispose();
    const { make } = SKINS[this.settings.skin];
    this.skin = new make(this.scene, this.renderer, { width: this.metrics.width, height: this.metrics.height },
      { camera: this.camera, lowPower: this.settings.lowPower, mode: this.settings.ledMode, say: (text) => this.say(text) });
    // A skin may say how it wants to be finished (contact shadows, bloom, exposure); the box asks for little.
    const look = this.skin.look ?? { ao: { radius: this.metrics.height * 0.12, intensity: 0.6 }, bloom: null };
    this.renderer.toneMappingExposure = look.exposure ?? 1;
    this.post = buildPost(this.renderer, this.scene, this.camera, this.size.w, this.size.h, this.pixelRatio, look, this.settings.lowPower);
    this.settle();
    this.updateMenu();
    const event = params.get('event'); // a flag for testing: start one of the skin's random events once it has settled
    if (event) setTimeout(() => this.skin?.trigger?.(event), 3000);
  }

  /** The window's physical size and the lens's place relative to it; cheap, so it is redone as the window moves. */
  measure() {
    const left = screen.availLeft ?? 0, top = screen.availTop ?? 0; // this display's corner among several
    this.metrics = windowMetrics({
      diagonalInches: this.settings.diagonal,
      screenW: screen.width, screenH: screen.height,
      innerW: this.size.w, innerH: this.size.h,
      outerW: window.outerWidth || this.size.w, outerH: window.outerHeight || this.size.h,
      winX: (window.screenX ?? 0) - left, winY: (window.screenY ?? 0) - top,
    });
    this.windowKey = `${window.screenX},${window.screenY},${window.outerWidth},${window.outerHeight}`;
  }

  /** Where the lens is in the window frame: on top of the display, in the middle, moved by the calibration. */
  get lens() {
    const c = this.metrics.cam;
    return { x: c.x + this.settings.camFixX, y: c.y + this.settings.camFixY, z: c.z };
  }

  // MARK: - The eye

  /** One camera frame from the tracker. */
  onSample({ head, source, landmarks, pose, time }) {
    const dt = this.lastSample === null ? 0 : time - this.lastSample;
    this.lastSample = time;
    if (head) {
      if (time - this.lastSeen > LOST_AFTER) this.filter.reset(); // a viewer coming back starts clean
      this.source = source;
      this.headCam = this.filter.filter(head, dt);
      this.lastSeen = time;
    }
    if (this.settings.preview) this.drawOverlay(landmarks, source === 'body' ? pose : null);
  }

  /** The tracked head in the window frame with the calibration applied, or null if no face is in view. */
  trackedHead(now) {
    if (!this.headCam || now - this.lastSeen > LOST_AFTER) return null;
    return cameraToWindow(this.headCam, this.lens);
  }

  /** The eye a mouse stands in for: the pointer's place in the window is the head's place in front of it. */
  mouseHead() {
    const m = this.metrics;
    return {
      x: (this.pointer.x - 0.5) * Math.max(0.7, m.width * 1.6),
      y: (this.pointer.y - 0.5) * Math.max(0.45, m.height * 1.6),
      z: this.mouseZ,
    };
  }

  updateEye(dt, now) {
    if (this.pinned) { Object.assign(this.eye, this.pinned); return; }
    let target, tau;
    if (this.tracker.state === 'on') {
      const head = this.trackedHead(now);
      // Tracking: follow at once (the filter has done the smoothing; this only spans the gap between camera
      // frames). Face lost: drift back to the middle slowly, so a glance away does not jerk the picture.
      target = head ?? REST_HEAD; tau = head ? 0.03 : 1.4;
    } else {
      target = this.mouseHead(); tau = 0.1;
    }
    const k = 1 - Math.exp(-dt / tau);
    this.eye.x += (target.x - this.eye.x) * k;
    this.eye.y += (target.y - this.eye.y) * k;
    this.eye.z += (target.z - this.eye.z) * k;
    this.eye.z = Math.max(this.eye.z, MIN_EYE_Z);
  }

  /** Sit straight in front of the middle of the window, 60 cm back, and call this: it measures the camera. */
  calibrate() {
    const now = performance.now() / 1000;
    if (this.tracker.state !== 'on' || !this.tracker.last || now - this.lastSeen > LOST_AFTER) {
      showNote('Calibrate needs the webcam on and your face in view, looking at the screen.');
      return false;
    }
    // The distance read off a face scales with the focal length assumed (very nearly in proportion), so one
    // known distance fixes the focal length: step the scale until the face reads 60 cm. Sideways position
    // hardly depends on it, so it must be measured again at the new scale, not scaled with the distance.
    let scale = this.settings.focalScale, p = null;
    for (let i = 0; i < 5; i++) {
      p = this.tracker.remeasure(scale);
      if (!p) { showNote('Calibrate lost your face; try again.'); return false; }
      scale *= CALIBRATE_DISTANCE / p.z;
    }
    p = this.tracker.remeasure(scale);
    // The head is by definition in front of the window's centre, which says where the lens is.
    const m = this.metrics.cam;
    this.settings.focalScale = scale;
    this.settings.camFixX = p.x - m.x;
    this.settings.camFixY = p.y - m.y;
    this.filter.reset();
    this.headCam = p;
    showNote(`Calibrated: camera field of view about ${this.cameraFov().toFixed(0)} degrees.`, 4000);
    return true;
  }

  resetCalibration() {
    this.settings.focalScale = 1; this.settings.camFixX = 0; this.settings.camFixY = 0;
    showNote('Calibration cleared.', 3000);
  }

  /** The camera's horizontal field of view that the calibration implies, in degrees. */
  cameraFov() {
    const base = Math.tan((DEFAULT_CAMERA_FOV * Math.PI / 180) / 2);
    return 2 * Math.atan(base / this.settings.focalScale) * 180 / Math.PI;
  }

  async startCamera(stream = null) {
    this.hideIntro();
    try {
      await this.tracker.start(stream);
      this.settings.tracking = 'camera';
    } catch (err) {
      console.warn(err);
      const why = err?.name === 'NotAllowedError' ? 'permission was not given'
        : err?.name === 'NotFoundError' ? 'no camera was found' : (err?.message ?? 'it could not be opened');
      showNote(`The webcam is off (${why}). Move the mouse to look around instead.`);
    }
    this.applyPanels();
    this.updateMenu();
  }

  stopCamera() {
    this.tracker.stop();
    this.settings.tracking = 'mouse';
    this.applyPanels();
    this.updateMenu();
  }

  // MARK: - Frame

  frame(nowMs) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.paused) return;
    const interval = 1000 / this.governor.fps;
    if (this.lastFrame !== null && nowMs - this.lastFrame < interval - 2) return;
    if (this.lastFrame !== null && nowMs >= this.settleUntil && this.governor.frame(nowMs - this.lastFrame)) this.applyGovernor();
    const dt = this.lastFrame === null ? 0 : Math.min((nowMs - this.lastFrame) / 1000, 1 / 15);
    this.lastFrame = nowMs;
    this.step(dt);
    this.render();
  }

  step(dt) {
    this.time += dt;
    // A window dragged across the screen moves relative to the lens; notice, without rebuilding anything.
    const key = `${window.screenX},${window.screenY},${window.outerWidth},${window.outerHeight}`;
    if (key !== this.windowKey) this.measure();
    this.updateEye(dt, performance.now() / 1000);
    this.skin.step(dt, this.time, this.eye);
    if (this.settings.hud) this.updateHud();
  }

  render() {
    const m = this.metrics, e = this.eye;
    const f = windowFrustum(e, m.width / 2, m.height / 2, 0.01, 40);
    if (this.crop) { // a debugging close-up: the same view, a part of it filling the screen
      const { x, y, k } = this.crop, cx = (f.left + f.right) / 2 + x * (f.right - f.left) / 2, cy = (f.bottom + f.top) / 2 + y * (f.top - f.bottom) / 2;
      const hw = (f.right - f.left) / 2 / k, hh = (f.top - f.bottom) / 2 / k;
      f.left = cx - hw; f.right = cx + hw; f.bottom = cy - hh; f.top = cy + hh;
    }
    this.camera.position.set(e.x, e.y, Math.max(e.z, MIN_EYE_Z));
    this.camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, f.near, f.far);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.near = f.near; this.camera.far = f.far; // for the passes that read them; the projection itself is set above
    this.skin.update?.(this.renderer);
    this.post.render();
  }

  // MARK: - Panels (preview, readout, intro)

  applyPanels() {
    const on = this.tracker.state !== 'off';
    document.getElementById('preview').hidden = !(this.settings.preview && on);
    this.hudEl ??= document.getElementById('hud');
    this.hudEl.hidden = !this.settings.hud;
  }

  /** Marks what the tracker measures on the preview: the two irises and the point between them. */
  drawOverlay(landmarks, pose = null) {
    const v = this.video, c = this.overlay;
    if (!(v.videoWidth > 0)) return;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (pose) {
      // The backup has the viewer: its head points and shoulders, in orange.
      const r = Math.max(3, c.width / 110);
      g.fillStyle = '#ff9f43'; g.strokeStyle = '#ff9f43'; g.lineWidth = r * 0.6;
      for (const i of [0, 2, 5, 7, 8, 11, 12]) {
        const p = pose[i];
        if (!p || (p.visibility ?? 1) < 0.5) continue;
        g.beginPath(); g.arc(p.x * c.width, p.y * c.height, r, 0, Math.PI * 2); g.fill();
      }
      const [a, b] = [pose[11], pose[12]];
      if (a && b && (a.visibility ?? 1) >= 0.5 && (b.visibility ?? 1) >= 0.5) {
        g.beginPath(); g.moveTo(a.x * c.width, a.y * c.height); g.lineTo(b.x * c.width, b.y * c.height); g.stroke();
      }
      return;
    }
    if (!landmarks || landmarks.length < 478) return;
    const px = (i) => [landmarks[i].x * c.width, landmarks[i].y * c.height];
    g.lineWidth = Math.max(2, c.width / 160); // the preview is a fifth of the picture's size: draw for that
    g.strokeStyle = '#6cf0c2';
    for (const [centre, edge] of [[468, 469], [473, 474]]) {
      const [x, y] = px(centre), [ex, ey] = px(edge);
      g.beginPath(); g.arc(x, y, Math.hypot(ex - x, ey - y), 0, Math.PI * 2); g.stroke();
    }
    const [ax, ay] = px(468), [bx, by] = px(473);
    g.fillStyle = '#ffd166';
    g.beginPath(); g.arc((ax + bx) / 2, (ay + by) / 2, g.lineWidth * 1.5, 0, Math.PI * 2); g.fill();
  }

  updateHud() {
    const cm = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).padStart(4)} cm`;
    const e = this.eye, m = this.metrics, t = this.tracker;
    const seen = performance.now() / 1000 - this.lastSeen <= LOST_AFTER;
    const source = this.pinned ? 'pinned from the console'
      : t.state === 'on' ? `webcam ${t.rate.toFixed(0)} Hz · ${!seen ? 'nobody in view: drifting to centre' : this.source === 'body' ? 'face lost: following your head and shoulders' : 'face in view'}`
        : t.state === 'starting' ? 'webcam starting…' : 'mouse (wheel = distance)';
    this.hudEl.textContent = [
      `eye   x ${cm(e.x)}   y ${cm(e.y)}   distance ${(e.z * 100).toFixed(1)} cm`,
      `input ${source}`,
      `ruler eye corners ${(t.meter.span * 1000).toFixed(1)} mm apart${t.meter.samples ? '' : ' (typical; not measured yet)'} · backup ${t.pose ? `ready, shoulders ${(t.body.shoulders * 100).toFixed(0)} cm${t.body.taught ? '' : ' (typical)'}` : 'not loaded'}`,
      `drawn ${this.renderer.domElement.width} x ${this.renderer.domElement.height} (${Math.round(this.governor.scale * 100)}% of native) at ${this.governor.fps} fps`,
      `glass ${(m.width * 100).toFixed(1)} x ${(m.height * 100).toFixed(1)} cm (a ${this.settings.diagonal}-inch display) · camera fov ≈ ${this.cameraFov().toFixed(0)}°`,
    ].join('\n');
  }

  showIntro() { document.getElementById('intro').hidden = false; }
  hideIntro() { document.getElementById('intro').hidden = true; }

  // MARK: - Input

  bindInput() {
    window.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX / this.size.w, y: 1 - e.clientY / this.size.h };
      this.wake();
    }, { passive: true });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.mouseZ = Math.min(1.5, Math.max(0.25, this.mouseZ * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', () => { this.closeMenu(); this.skin?.knock?.(); });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'c') this.toggle('camera');
      else if (k === 'k') this.calibrate();
      else if (k === 'p') this.toggle('preview');
      else if (k === 'h') this.toggle('hud');
      else if (k === 'l') this.act('leds');
      else if (k === 's') this.act('skin');
      else if (k === 'e') this.skin?.trigger?.(); // not in the menu: starts the next of the things that happen by themselves
      else if (k === 'escape') this.closeMenu();
    });

    window.addEventListener('resize', () => this.layout());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.lastFrame = null; this.settle(1500); } });

    document.getElementById('introCamera').addEventListener('click', () => this.startCamera());
    document.getElementById('introMouse').addEventListener('click', () => { this.settings.tracking = 'mouse'; this.hideIntro(); this.updateMenu(); });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 12000);
  }

  wake() {
    const ui = document.getElementById('ui');
    ui.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => ui.classList.add('idle'), 2500);
  }

  // MARK: - Menu

  bindMenu() {
    this.menu = document.getElementById('menu');
    this.menuBtn = document.getElementById('menuBtn');
    this.ui = document.getElementById('ui');
    this.menuBtn.addEventListener('click', () => (this.menu.hidden ? this.openMenu() : this.closeMenu()));
    this.menu.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)));
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.toggle)));
    this.updateMenu();
    this.wake();
  }

  openMenu() { this.updateMenu(); this.menu.hidden = false; this.ui.classList.add('open'); this.menuBtn.setAttribute('aria-expanded', 'true'); }
  closeMenu() { this.menu.hidden = true; this.ui.classList.remove('open'); this.menuBtn.setAttribute('aria-expanded', 'false'); }

  act(name) {
    switch (name) {
      case 'calibrate': this.calibrate(); break;
      case 'uncalibrate': this.resetCalibration(); break;
      case 'diagonal': {
        const i = DIAGONALS.findIndex((d) => d > this.settings.diagonal);
        this.settings.diagonal = DIAGONALS[i < 0 ? 0 : i];
        this.layout();
        break;
      }
      case 'skin': {
        const keys = Object.keys(SKINS);
        this.settings.skin = keys[(keys.indexOf(this.settings.skin) + 1) % keys.length];
        this.buildSkin();
        break;
      }
      case 'leds':
        if (this.skin.cycleMode) this.settings.ledMode = this.skin.cycleMode();
        break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
    }
    this.updateMenu();
  }

  toggle(key) {
    if (key === 'camera') {
      if (this.tracker.state === 'off') this.startCamera(); else this.stopCamera();
      return;
    }
    this.settings[key] = !this.settings[key];
    if (key === 'lowPower' || key === 'fullRes') { this.layout(); this.buildSkin(); }
    this.applyPanels();
    this.updateMenu();
  }

  updateMenu() {
    if (!this.menu) return;
    const state = { camera: this.tracker.state !== 'off', preview: this.settings.preview, hud: this.settings.hud, lowPower: this.settings.lowPower, fullRes: this.settings.fullRes };
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => {
      const on = !!state[b.dataset.toggle];
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    this.menu.querySelector('[data-act="diagonal"] .label').textContent = `Display Size: ${this.settings.diagonal} in`;
    this.menu.querySelector('[data-act="skin"] .label').textContent = `Scene: ${SKINS[this.settings.skin].name}`;
    const leds = this.menu.querySelector('[data-act="leds"]');
    leds.hidden = !this.skin?.cycleMode;
    if (this.skin?.modeName) leds.querySelector('.label').textContent = `${this.skin.modeLabel ?? 'Lighting'}: ${this.skin.modeName}`;
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

// Debug API (see guidelines.md): eye() pins the eye and renders once; run() steps ahead; useStream() feeds the
// tracker a MediaStream of your own in place of the webcam.
function installDebug(app) {
  window.diorama = {
    app,
    /** Pin the eye at (x, y, z) metres in front of the window's centre and draw one frame. */
    eye(x = 0, y = 0, z = REST_HEAD.z) { app.pinned = { x, y, z }; app.step(0); app.render(); return { ...app.eye }; },
    /** Magnify the part of the view round (x, y) (-1..1 across the window) k times, as a 4K screen would show it; zoom() resets. */
    zoom(x = 0, y = 0, k = 1) { app.crop = k > 1 ? { x, y, k } : null; app.render(); },
    /** Let the webcam or the mouse have the eye back. */
    release() { app.pinned = null; },
    run(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) app.step(1 / 60); app.render(); return { ...app.eye }; },
    pause() { app.paused = true; },
    resume() { app.lastFrame = null; app.paused = false; },
    useStream(stream) { app.tracker.stop(); return app.startCamera(stream); },
    /** Start one of the skin's random events by name (the computer's: crawl, eyes, descend, code, morse, sag). */
    event(name) { return app.skin?.trigger?.(name) ?? null; },
    get head() { return app.trackedHead(performance.now() / 1000); },
  };
}

let noteTimer = 0;
/** A note along the top of the page that fades by itself; the scene keeps running underneath. */
function showNote(text, ms = 9000) {
  const el = document.getElementById('error');
  el.classList.add('soft');
  el.classList.remove('faded');
  el.hidden = false;
  el.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    el.classList.add('faded');
    noteTimer = setTimeout(() => { el.hidden = true; }, 1600);
  }, ms);
}

function showError(prefix, err) {
  console.error(err);
  clearTimeout(noteTimer);
  const el = document.getElementById('error');
  el.classList.remove('soft', 'faded');
  el.hidden = false;
  el.textContent = prefix + (err?.message ?? '');
}

function start() {
  // Some hosts report a 0x0 window while the page is still being laid out; wait for a real size.
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) { requestAnimationFrame(start); return; }
  try {
    installDebug(new App());
  } catch (err) {
    let gl2 = false;
    try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { /* none */ }
    showError(gl2 ? 'Diorama could not start: ' : 'Diorama needs WebGL 2 to run, and this browser could not create a WebGL 2 context. ', err);
  }
}
start();
