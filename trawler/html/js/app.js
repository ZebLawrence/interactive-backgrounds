// Trawler — Entry point: settings, the menu, input, the renderer and the frame loop.
//
// Everything about the shell is here; the scene itself only ever sees the cursor in screen points,
// a click point and the screen size.

import * as THREE from 'three';
import { Scene } from './scene.js';
import { FrameGovernor } from './governor.js';

const params = new URLSearchParams(location.search);
const num = (key, fallback) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};

export const SEA_MODES = ['drift', 'calm', 'moderate', 'rough', 'storm'];
export const TIME_MODES = ['cycle', 'dawn', 'noon', 'dusk', 'night'];
/** Where each pinned clock sits in the day (0 = midnight). Dawn and dusk are picked per date. */
export const TIME_AT = { dawn: 0.24, noon: 0.5, dusk: 0.80, night: 0.02 };
/** Where each pinned sea state sits on the 0..1 scale. */
export const SEA_AT = { calm: 0.06, moderate: 0.34, rough: 0.62, storm: 0.93 };

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('trawler.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('trawler.' + key, String(value)); } catch { /* private mode */ }
  },

  // Flags override the saved settings, for testing each mode without clearing storage.
  seaOverride: SEA_MODES.find((m) => m !== 'drift' && params.has(m)) ?? null,
  timeOverride: TIME_MODES.find((m) => m !== 'cycle' && params.has(m)) ?? null,
  rainOverride: params.has('rain') ? true : (params.has('norain') ? false : null),
  redOverride: params.has('red') ? true : null,
  lowPowerOverride: params.has('lowpower') ? true : null,
  // Raw numeric pins, for stepping through the whole range in a test.
  seaValue: params.has('sea') ? Math.min(Math.max(num('sea', 0.3), 0), 1) : null,
  timeValue: params.has('time') ? num('time', 0.3) - Math.floor(num('time', 0.3)) : null,
  perf: params.has('perf'),

  get seaMode() { return this.seaOverride ?? this.read('seaMode', 'drift'); },
  set seaMode(v) { this.seaOverride = null; this.seaValue = null; this.write('seaMode', v); },
  get timeMode() { return this.timeOverride ?? this.read('timeMode', 'cycle'); },
  set timeMode(v) { this.timeOverride = null; this.timeValue = null; this.write('timeMode', v); },
  get rain() { return this.rainOverride ?? this.read('rain', false); },
  set rain(v) { this.rainOverride = null; this.write('rain', v); },
  get redLight() { return this.redOverride ?? this.read('redLight', false); },
  set redLight(v) { this.redOverride = null; this.write('redLight', v); },
  get lowPower() { return this.lowPowerOverride ?? this.read('lowPower', false); },
  set lowPower(v) { this.lowPowerOverride = null; this.write('lowPower', v); },

  /** The clock the scene should start on: a pinned mode, a raw ?time, or a point in the morning. */
  get startTime() {
    if (this.timeValue !== null) return this.timeValue;
    const m = this.timeMode;
    return m === 'cycle' ? 0.28 : TIME_AT[m];
  },
  /** The sea state the scene should start on, or null to let the weather drift. */
  get startSea() {
    if (this.seaValue !== null) return this.seaValue;
    const m = this.seaMode;
    return m === 'drift' ? null : SEA_AT[m];
  },
};

/** Low Power's pixel ratio: native, but no more than about 1920x1080 pixels in all. */
export function lowPowerRatio(w, h, dpr) {
  if (!(w > 0 && h > 0 && dpr > 0)) return 1;
  return Math.min(1, Math.sqrt((1920 * 1080) / (w * h * dpr * dpr))) * dpr;
}

function initialSeed() {
  const s = Number(params.get('seed'));
  return params.has('seed') && Number.isFinite(s) ? s >>> 0 : (Math.random() * 4294967296) >>> 0;
}

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('trawler');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;
    this.paused = false;
    this.seed = initialSeed();
    this.governor = new FrameGovernor();
    this.settleUntil = 0;

    // No canvas MSAA: the scene renders into post.js's 4x MSAA target, and only a full-screen pass
    // reaches the canvas. ACES is applied there (OutputPass reads it from the renderer).
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // raised once a frame by the scene
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.size = this.windowSize();
    this.applyPixelRatio();
    this.rebuild();
    this.bindInput();
    this.bindMenu();
    this.perfEl = null;
    if (this.settings.perf) this.initPerf();
    requestAnimationFrame((t) => this.frame(t));
  }

  windowSize() { return { w: window.innerWidth, h: window.innerHeight }; }

  /**
   * Native resolution: window size x devicePixelRatio, capped at 2. Low Power caps the drawing
   * buffer near 1920x1080's pixel count instead (the canvas still fills the window, scaled up):
   * a plain pixelRatio of 1 would change nothing on a DPR-1 4K display.
   */
  applyPixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = this.settings.lowPower ? lowPowerRatio(this.size.w, this.size.h, dpr) : dpr;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.size.w, this.size.h, false); // the stylesheet gives the canvas its CSS size
    this.pixelRatio = ratio;
  }

  rebuild(reseed = false) {
    if (reseed) this.seed = (Math.random() * 4294967296) >>> 0;
    const old = this.scene;
    const scene = new Scene(this, this.renderer, this.size.w, this.size.h, this.settings, this.seed);
    this.scene = scene;
    Promise.resolve(scene.ready).catch((err) => { if (this.scene === scene) showNote(`Trawler: ${err?.message ?? err}`); });
    if (old) old.dispose();
    this.applyModes();
    this.settle();
    this.updateMenu();
  }

  /** Pushes the current menu settings into the scene. */
  applyModes() {
    const s = this.scene;
    if (!s) return;
    s.sky.setTime(this.settings.timeMode === 'cycle' && this.settings.timeValue === null ? null : this.settings.startTime);
    s.setSeaTarget?.(this.settings.startSea);
    s.setRain?.(this.settings.rain);
    s.setRedLight?.(this.settings.redLight);
    s.stepExposure?.(0, true); // a pinned clock is a jump, not a sunset: adapt at once
  }

  get fps() { return this.settings.lowPower ? 30 : this.governor.fps; }

  settle(ms = 3000) {
    this.settleUntil = performance.now() + ms;
    this.governor.reset();
  }

  /** Waits for the GPU: gl.finish(), then a 1-pixel read (finish alone does not always block). */
  syncGpu() {
    const gl = this.renderer.getContext();
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPx ??= new Uint8Array(4));
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.paused) return;
    const interval = 1000 / this.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    const since = this.lastFrame === null ? null : now - this.lastFrame;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    const settled = now >= this.settleUntil;
    const govern = settled && !this.settings.lowPower;
    if (govern && since !== null && !this.perfEl) this.governor.interval(since, now / 1000);
    this.scene.step(dt, this.pointer, this.settings);
    this.renderer.info.reset();
    // Once a second while at 30 (every frame with ?perf) a frame is timed end to end with the GPU
    // drained either side. Never at 60: the stall itself would make a near-budget frame miss vsync.
    const probe = govern && this.governor.wantsProbe(now / 1000, !!this.perfEl);
    let ms = null;
    if (probe || this.perfEl) {
      this.syncGpu();
      const t0 = performance.now();
      this.scene.render();
      this.syncGpu();
      ms = performance.now() - t0;
    } else {
      this.scene.render();
    }
    if (probe) this.governor.probe(ms, now / 1000);
    if (this.perfEl) this.updatePerf(dt, ms, now);
  }

  initPerf() {
    this.perfEl = document.createElement('div');
    this.perfEl.style.cssText = 'position:fixed;left:8px;top:8px;font:12px/1.4 monospace;color:#9f9;background:rgba(0,0,0,.6);padding:4px 6px;pointer-events:none;white-space:pre;z-index:10';
    document.body.appendChild(this.perfEl);
    this.perfAcc = 0; this.perfN = 0; this.perfMs = []; this.texAt = 0; this.texMB = 0; this.perfLast = null;
  }

  updatePerf(dt, ms, now) {
    if (this.perfLast !== null && now - this.perfLast < 1000) { this.perfAcc += (now - this.perfLast) / 1000; this.perfN++; }
    this.perfLast = now;
    if (ms !== null) this.perfMs.push(ms);
    if (this.perfAcc < 0.5) return;
    const info = this.renderer.info;
    if (now >= this.texAt) { this.texMB = (this.scene.textureBytes?.() ?? 0) / 1048576; this.texAt = now + 2000; }
    const sorted = this.perfMs.slice().sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : NaN;
    const max = sorted.length ? sorted[sorted.length - 1] : NaN;
    const c = this.canvas;
    const mode = this.settings.lowPower ? 'Low Power: 30' : `governor: ${this.governor.describe(now / 1000)}`;
    const sc = this.scene;
    this.perfEl.textContent = [
      `${(this.perfN / this.perfAcc).toFixed(0)} fps · frame ${med.toFixed(1)} ms (max ${max.toFixed(1)}, GPU-synced)`,
      `${info.render.calls} draws · ${(info.render.triangles / 1e6).toFixed(2)} M tris · tex ~${this.texMB.toFixed(0)} MB (${info.memory.textures} textures, ${info.programs?.length ?? 0} programs)`,
      `${c.width}x${c.height} @ ${+this.pixelRatio.toFixed(3)}x · ${mode}`,
      sc?.describe?.() ?? '',
    ].filter(Boolean).join('\n');
    this.perfAcc = 0; this.perfN = 0; this.perfMs.length = 0;
  }

  // MARK: - Input

  bindInput() {
    const setPointer = (e) => { this.pointer = { x: e.clientX, y: this.size.h - e.clientY, inside: true }; };
    window.addEventListener('pointermove', (e) => { setPointer(e); this.wake(); }, { passive: true });
    window.addEventListener('pointerdown', setPointer);
    const leave = () => { this.pointer = { ...this.pointer, inside: false }; };
    document.documentElement.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    window.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') leave(); });
    window.addEventListener('pointercancel', leave);

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.closeMenu();
      this.scene.click({ x: e.clientX, y: this.size.h - e.clientY });
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 's') this.cycleSea();
      else if (k === 'n') this.setTimeMode(this.settings.timeMode === 'night' ? 'cycle' : 'night');
      else if (k === 'r') this.toggle('rain');
      else if (k === 'l') this.toggle('redLight');
      else if (k >= '1' && k <= '4') this.setSeaMode(SEA_MODES[Number(k)]);
      else if (k === '0') this.setSeaMode('drift');
      else if (k === 'escape') this.closeMenu();
    });

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.lastFrame = null;
      this.lastStep = null;
      this.settle();
    });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 10000);
  }

  resize() {
    const size = this.windowSize();
    if (!(size.w > 0 && size.h > 0)) return;
    this.size = size;
    this.applyPixelRatio();
    this.scene.resize(size.w, size.h, this.pixelRatio);
    this.settle(1500);
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
    this.menu.querySelectorAll('[data-sea]').forEach((b) => b.addEventListener('click', () => this.setSeaMode(b.dataset.sea)));
    this.menu.querySelectorAll('[data-clock]').forEach((b) => b.addEventListener('click', () => this.setTimeMode(b.dataset.clock)));
    this.wake();
  }

  openMenu() {
    this.updateMenu();
    this.menu.hidden = false;
    this.ui.classList.add('open');
    this.menuBtn.setAttribute('aria-expanded', 'true');
  }

  closeMenu() {
    this.menu.hidden = true;
    this.ui.classList.remove('open');
    this.menuBtn.setAttribute('aria-expanded', 'false');
  }

  setSeaMode(mode) {
    if (!SEA_MODES.includes(mode)) return;
    this.settings.seaMode = mode;
    this.applyModes();
    this.updateMenu();
  }

  cycleSea() {
    const i = SEA_MODES.indexOf(this.settings.seaMode);
    this.setSeaMode(SEA_MODES[(i + 1) % SEA_MODES.length]);
  }

  setTimeMode(mode) {
    if (!TIME_MODES.includes(mode)) return;
    this.settings.timeMode = mode;
    this.applyModes();
    this.updateMenu();
  }

  act(name) {
    switch (name) {
      case 'reseed': this.rebuild(true); break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
    }
    this.updateMenu();
  }

  toggle(key) {
    this.settings[key] = !this.settings[key];
    if (key === 'lowPower') {
      this.applyPixelRatio();
      this.scene.setLowPower(this.settings.lowPower, this.pixelRatio);
      this.settle();
    } else {
      this.applyModes();
    }
    this.updateMenu();
  }

  updateMenu() {
    if (!this.menu) return;
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => {
      const on = this.settings[b.dataset.toggle];
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    const sea = this.settings.seaMode;
    this.menu.querySelectorAll('[data-sea]').forEach((b) => {
      const on = b.dataset.sea === sea;
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    const clock = this.settings.timeMode;
    this.menu.querySelectorAll('[data-clock]').forEach((b) => {
      const on = b.dataset.clock === clock;
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    const fs = this.menu.querySelector('[data-act="fullscreen"] .check');
    if (fs) fs.textContent = document.fullscreenElement ? '✓' : '';
  }
}

// Debug API (guidelines section 5): look() aims the camera and renders once; run() steps the sim at
// 1/60 s and renders once at the end, so a minute of scene time costs a second.
function installDebug(app) {
  window.trawler = {
    app,
    get scene() { return app.scene; },
    get sky() { return app.scene.sky; },
    get governor() { return app.governor; },
    look(x, y, z, yawDeg = 0, pitchDeg = 0, fovDeg = 62) {
      const c = app.scene.camera;
      app.paused = true;
      app.scene.freeCamera = true;
      c.position.set(x, y, z);
      c.rotation.order = 'YXZ';
      c.rotation.set(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0);
      c.fov = fovDeg;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
      app.scene.sky.step(0, c, { pixelRatio: app.pixelRatio });
      app.scene.render();
    },
    /** Aims the camera at a world point from `from`, with a narrow field of view for detail. */
    at(fx, fy, fz, tx, ty, tz, fovDeg = 18) {
      const dx = tx - fx, dy = ty - fy, dz = tz - fz;
      const yaw = Math.atan2(-dx, -dz) * 180 / Math.PI;
      const pitch = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
      return window.trawler.look(fx, fy, fz, yaw, pitch, fovDeg);
    },
    run(seconds, pointer = { x: -10000, y: -10000, inside: false }) {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) app.scene.step(1 / 60, pointer, app.settings);
      app.scene.render();
    },
    /** Puts the clock at `t` (0..1 of the day) without touching the saved settings. */
    time(t) { app.scene.sky.setTime(t); app.scene.stepExposure(0, true); app.scene.render(); },
    sea(v) { app.scene.setSeaTarget?.(v, true); app.scene.render(); },
    pause() { app.paused = true; },
    resume() { app.lastStep = null; app.paused = false; app.scene.freeCamera = false; },
    bench(frames = 60) {
      const gl = app.renderer.getContext(), px = new Uint8Array(4);
      const one = () => { app.renderer.info.reset(); app.scene.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
      for (let i = 0; i < 5; i++) one();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) one();
      return (performance.now() - t0) / frames;
    },
    /** Does the sea the GPU draws match the sea the hull rides? (ocean.verify) */
    verifyOcean(points = 24) { return app.scene.ocean.verify(points); },
    /**
     * The bounding box of every scanned prop, in metres, in the pilot house's own frame. A prop
     * whose numbers do not read like the real object is placed wrong or scaled wrong, and this is
     * how you find out which rather than squinting at a screenshot.
     */
    propSizes() {
      const house = app.scene.pilot;
      const inv = house.group.matrixWorld.clone().invert();
      const out = {};
      for (const key of Object.keys(house.parts)) {
        if (!key.startsWith('prop:')) continue;
        const obj = house.parts[key];
        obj.updateWorldMatrix(true, true);
        const b = new THREE.Box3();
        obj.traverse((m) => {
          if (!m.isMesh || !m.geometry) return;
          m.geometry.computeBoundingBox();
          b.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld.clone().premultiply(inv)));
        });
        const size = b.getSize(new THREE.Vector3());
        out[key.slice(5)] = {
          size: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
          lo: [+b.min.x.toFixed(3), +b.min.y.toFixed(3), +b.min.z.toFixed(3)],
          hi: [+b.max.x.toFixed(3), +b.max.y.toFixed(3), +b.max.z.toFixed(3)],
        };
      }
      return out;
    },
    /** Any shader that failed to compile, by name (guidelines section 4). */
    shaderErrors() {
      return app.renderer.info.programs.filter((p) => p.diagnostics).map((p) => ({ name: p.name, d: p.diagnostics }));
    },
  };
}

const NOTE_MS = 20000;
let noteTimer = 0;

/** A non-blocking note along the top of the page; the scene keeps running underneath. */
function showNote(text) {
  console.warn(text);
  const el = document.getElementById('error');
  if (!el.hidden && !el.classList.contains('soft')) return;
  el.classList.add('soft');
  el.classList.remove('faded');
  el.hidden = false;
  el.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (!el.classList.contains('soft')) return;
    el.classList.add('faded');
    noteTimer = setTimeout(() => { if (el.classList.contains('faded')) el.hidden = true; }, 1600);
  }, NOTE_MS);
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
    const app = new App();
    installDebug(app);
  } catch (err) {
    let gl2 = false;
    try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { /* none */ }
    showError(gl2 ? 'Trawler could not start: ' : 'Trawler needs WebGL 2 to run, and this browser could not create a WebGL 2 context. ', err);
  }
}
start();
