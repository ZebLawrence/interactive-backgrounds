// Hangar — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { Scene } from './scene.js';
import { loadManifest, loadAssets } from './assets.js';
import { FrameGovernor } from './governor.js';

const params = new URLSearchParams(location.search);
const flag = (on, off) => (params.has(on) ? true : (params.has(off) ? false : null));

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('hangar.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('hangar.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?emergency` / `?noemergency` and `?lowpower` override the saved settings for testing; `?perf` shows frame timing.
  emergencyOverride: flag('emergency', 'noemergency'),
  lowPowerOverride: params.has('lowpower') ? true : null,
  perf: params.has('perf'),
  get emergency() { return this.emergencyOverride ?? this.read('emergency', false); },
  set emergency(v) { this.emergencyOverride = null; this.write('emergency', v); },
  get lowPower() { return this.lowPowerOverride ?? this.read('lowPower', false); },
  set lowPower(v) { this.lowPowerOverride = null; this.write('lowPower', v); },
};

// Fetched first: the level's own surfaces (the start room is brown panels, steel and concrete), then the
// sky, so the walk starts looking right; props and the trim/variety sets follow.
const ASSET_PRIORITY = ['mat:panel-brown', 'mat:steel', 'mat:concrete', 'mat:computer', 'mat:regolith', 'mars'];

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
    this.canvas = document.getElementById('hangar');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;
    this.paused = false;
    this.seed = initialSeed();
    // Ruling R17: 60, or a steady 30 when 60 can't hold (Low Power is always 30). Resolution never moves.
    this.governor = new FrameGovernor();
    this.settleUntil = 0; // no timing until builds, resizes and mode changes have settled
    this.assetsDone = false;

    // No canvas MSAA: the scene renders into post.js's 4x MSAA target, and only a full-screen pass reaches the
    // canvas. ACES is applied there too (OutputPass reads it from the renderer).
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.info.autoReset = false; // a frame is many render calls (probes, mirror, post): counted whole, reset in frame()
    this.renderer = renderer;

    this.size = this.windowSize();
    this.applyPixelRatio();
    this.assetItems = new Map(); // items loaded so far, for scenes built after they arrived (reseed)
    this.manifest = null;
    this.assets = this.loadAssets();
    this.assets.then(() => { this.assetsDone = true; this.settle(); });
    this.rebuild();
    this.bindInput();
    this.bindMenu();
    this.perfEl = null;
    if (this.settings.perf) this.initPerf();
    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * Loads the scanned materials, images and models once for the life of the page (reseeds reuse them).
   * Never rejects: files that fail become neutral stand-ins and are named in the error note.
   */
  async loadAssets() {
    const bar = document.getElementById('loadbar');
    const progress = (f) => {
      bar.style.transform = `scaleX(${f})`;
      bar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    };
    let assets;
    try {
      const { manifest, failures: missing } = await loadManifest();
      this.manifest = manifest; // before any item arrives: scenes read per-tag tiling from it
      assets = await loadAssets(this.renderer, manifest, progress, {
        priority: ASSET_PRIORITY,
        // Items arrive one by one while the tour already runs; the scene may swap greybox for the real thing.
        onItem: (kind, name, asset) => {
          this.assetItems.set(`${kind}:${name}`, { kind, name, asset });
          this.scene?.applyAsset?.(kind, name, asset);
        },
      });
      assets.manifest = manifest;
      assets.failures.unshift(...missing);
    } catch (err) {
      console.error(err);
      assets = { textures: new Map(), models: new Map(), failures: [`all assets (${err?.message ?? err})`], manifest: null };
    }
    progress(1);
    bar.classList.add('done');
    if (assets.failures.length) showNote(`Hangar could not load ${assets.failures.length} asset file${assets.failures.length > 1 ? 's' : ''} (using plain stand-ins): ${assets.failures.join(', ')}`);
    return assets;
  }

  windowSize() { return { w: window.innerWidth, h: window.innerHeight }; }

  /**
   * Native resolution: window size x devicePixelRatio, capped at 2. Low Power (Ruling R26) caps the drawing
   * buffer at about 1920x1080's pixel count instead (the canvas still fills the window, scaled up): a plain
   * pixelRatio 1 would change nothing on a DPR-1 4K display. Default mode never goes below native.
   */
  applyPixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = this.settings.lowPower ? lowPowerRatio(this.size.w, this.size.h, dpr) : dpr;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.pixelRatio = ratio;
  }

  /** Build the scene for the current window size and seed. */
  rebuild(reseed = false) {
    if (reseed) this.seed = (Math.random() * 4294967296) >>> 0;
    const old = this.scene;
    const scene = new Scene(this, this.renderer, this.size.w, this.size.h, this.settings, this.seed);
    this.scene = scene;
    // The scene may load its level asynchronously; show a failure instead of leaving an empty canvas.
    Promise.resolve(scene.ready).catch((err) => { if (this.scene === scene) showError('Hangar could not load the level. ', err); });
    if (old) old.dispose();
    this.settle();
    this.updateMenu();
  }

  /** The frame rate to hold: Low Power's 30, else the governor's 60 or 30. */
  get fps() { return this.settings.lowPower ? 30 : this.governor.fps; }

  /** Builds, resizes, mode changes and a returning tab compile shaders and re-bake: don't time frames for a while. */
  settle(ms = 3000) {
    this.settleUntil = performance.now() + ms;
    this.governor.reset();
  }

  /** Waits for the GPU: gl.finish(), then a 1-pixel read (finish alone does not block in Chrome on macOS). */
  syncGpu() {
    const gl = this.renderer.getContext();
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPx ??= new Uint8Array(4));
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.paused) return;
    // Even pacing: at 30 every second vsync renders (every fourth at 120 Hz), with the 2 ms slack for jitter.
    const interval = 1000 / this.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    const since = this.lastFrame === null ? null : now - this.lastFrame;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    const settled = this.assetsDone && !!this.scene.walker && now >= this.settleUntil;
    const govern = settled && !this.settings.lowPower;
    if (govern && since !== null && !this.perfEl) this.governor.interval(since, now / 1000);
    this.scene.step(dt, this.pointer, this.settings);
    this.renderer.info.reset();
    // Once a second while governing at 30 (every frame with ?perf) a frame is timed end to end, the GPU drained
    // either side: at 30 there is room for the stall, and it is the only way to see headroom for a climb. At 60
    // never (governor.wantsProbe): the stall could make a near-budget frame miss vsync, and late frames show in
    // the intervals; ?perf, which drains every frame and so feeds no intervals, probes at 60 too. Low Power never
    // pays for it.
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
    // Wall-clock time between rendered frames (the sim's dt is capped at 1/15 s, which would floor fps at 15).
    if (this.perfLast !== null && now - this.perfLast < 1000) { this.perfAcc += (now - this.perfLast) / 1000; this.perfN++; }
    this.perfLast = now;
    if (ms !== null) this.perfMs.push(ms);
    if (this.perfAcc < 0.5) return;
    const info = this.renderer.info;
    if (now >= this.texAt) { this.texMB = (this.scene.textureBytes?.() ?? 0) / 1048576; this.texAt = now + 2000; }
    const sorted = this.perfMs.slice().sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : NaN;
    const max = sorted.length ? sorted[sorted.length - 1] : NaN;
    const c = this.renderer.domElement;
    const mode = this.settings.lowPower ? 'Low Power: 30' : `governor: ${this.governor.describe(now / 1000)}`;
    this.perfEl.textContent = [
      `${(this.perfN / this.perfAcc).toFixed(0)} fps · frame ${med.toFixed(1)} ms (max ${max.toFixed(1)}, GPU-synced)`,
      `${info.render.calls} draws · ${(info.render.triangles / 1e6).toFixed(2)} M tris · tex ≈${this.texMB.toFixed(0)} MB (${info.memory.textures} textures, ${info.programs?.length ?? 0} programs)`,
      `${c.width}x${c.height} @ ${+this.pixelRatio.toFixed(3)}x · 4x MSAA${this.settings.lowPower ? '' : ' · GTAO'} · ${mode}`,
    ].join('\n');
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
      // A held key's auto-repeat would flip Emergency Power on and off for as long as it is held.
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'e') this.toggle('emergency');
      else if (k === 'escape') this.closeMenu();
    });

    // A resize keeps the walk, the seed and every bit of state: only the canvas, the camera and the post
    // targets change size (the scene is never rebuilt for it). A 0x0 report (minimising, some hosts mid-layout)
    // is ignored, and the last real size kept.
    window.addEventListener('resize', () => this.resize());
    // A hidden tab gets no frames; on return the walk resumes where it was (no catch-up step) and timing waits.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.lastFrame = null;
      this.lastStep = null;
      this.settle();
    });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 9000);
  }

  resize() {
    const size = this.windowSize();
    if (!(size.w > 0 && size.h > 0)) return;
    this.size = size;
    this.applyPixelRatio(); // also picks up a devicePixelRatio change (the window moved to another display)
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
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

// Debug API (see guidelines.md): look() aims the camera and renders once; run() steps at 1/60 s and renders once at the end.
function installDebug(app) {
  window.hangar = {
    app,
    get scene() { return app.scene; },
    get governor() { return app.governor; },
    assets: app.assets,
    look(x, y, z, yawDeg = 0, pitchDeg = 0, fovDeg = 70) {
      const c = app.scene.camera;
      app.paused = true;
      c.position.set(x, y, z);
      c.rotation.order = 'YXZ';
      c.rotation.set(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0);
      c.fov = fovDeg;
      c.updateProjectionMatrix();
      // Let the pooled lights settle on the new spot (2 s of light time; the walk itself does not move).
      for (let i = 0; i < 120; i++) app.scene.updateLights?.(1 / 60, app.settings);
      app.scene.render();
    },
    run(seconds, pointer = { x: -10000, y: -10000, inside: false }) {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) app.scene.step(1 / 60, pointer, app.settings);
      app.scene.render();
    },
    pause() { app.paused = true; },
    // GPU frame time in ms: each frame is followed by a 1-pixel readPixels, which waits for the GPU (gl.finish()
    // does not block in Chrome on macOS, and read 0.5 ms for a 13 ms frame).
    bench(frames = 60) {
      const gl = app.renderer.getContext(), px = new Uint8Array(4);
      const one = () => { app.renderer.info.reset(); app.scene.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
      for (let i = 0; i < 5; i++) one();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) one();
      return (performance.now() - t0) / frames;
    },
    // Verification helpers: an extra raking point lamp for close inspection, relief on/off.
    light(x, y, z, intensity = 6, distance = 8) { app.scene.setDebugLamp(x, y, z, intensity, distance); app.scene.render(); },
    relief(on = true) { app.scene.setRelief(on); app.scene.render(); },
    resume() { app.lastStep = null; app.paused = false; },
  };
}

// How long the soft note stays before it fades (ms); the console keeps the text.
const NOTE_MS = 20000;
let noteTimer = 0;

/** A non-blocking note along the top of the page (asset failures): the scene keeps running underneath. Fades after NOTE_MS. */
function showNote(text) {
  console.warn(text);
  const el = document.getElementById('error');
  if (!el.hidden && !el.classList.contains('soft')) return; // a fatal error is already showing
  el.classList.add('soft');
  el.classList.remove('faded');
  el.hidden = false;
  el.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (!el.classList.contains('soft')) return; // a fatal error replaced it: that one stays
    el.classList.add('faded'); // a 1.5 s opacity transition (styles.css), then gone
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
    // Only say WebGL 2 is missing when it is: anything else is a bug, shown as itself.
    let gl2 = false;
    try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { /* none */ }
    showError(gl2 ? 'Hangar could not start: ' : 'Hangar needs WebGL 2 to run, and this browser could not create a WebGL 2 context. ', err);
  }
}
start();
