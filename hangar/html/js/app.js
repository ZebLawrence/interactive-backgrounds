// Hangar — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { Scene } from './scene.js';

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
  get fps() { return this.lowPower ? 30 : 60; },
};

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

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
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

  /** Native resolution: window size x devicePixelRatio, capped at 2; Low Power drops to 1. */
  applyPixelRatio() {
    const ratio = this.settings.lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2);
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
    this.updateMenu();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.paused) return;
    const interval = 1000 / this.settings.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    this.scene.step(dt, this.pointer, this.settings);
    this.scene.render();
    if (this.perfEl) this.updatePerf(dt);
  }

  initPerf() {
    this.perfEl = document.createElement('div');
    this.perfEl.style.cssText = 'position:fixed;left:8px;top:8px;font:12px monospace;color:#9f9;background:rgba(0,0,0,.5);padding:4px 6px;pointer-events:none';
    document.body.appendChild(this.perfEl);
    this.perfAcc = 0; this.perfN = 0;
  }

  updatePerf(dt) {
    this.perfAcc += dt; this.perfN++;
    if (this.perfAcc >= 0.5) {
      this.perfEl.textContent = `${(this.perfN / this.perfAcc).toFixed(0)} fps · ${this.pixelRatio}x`;
      this.perfAcc = 0; this.perfN = 0;
    }
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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'e') this.toggle('emergency');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      if (!(this.size.w > 0 && this.size.h > 0)) return;
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.scene.resize(this.size.w, this.size.h);
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const s = this.scene;
        if (Math.abs(s.screenW - this.size.w) > 4 || Math.abs(s.screenH - this.size.h) > 4) this.rebuild();
      }, 400);
    });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 9000);
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
    if (key === 'lowPower') this.applyPixelRatio();
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
    look(x, y, z, yawDeg = 0, pitchDeg = 0, fovDeg = 70) {
      const c = app.scene.camera;
      app.paused = true;
      c.position.set(x, y, z);
      c.rotation.order = 'YXZ';
      c.rotation.set(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0);
      c.fov = fovDeg;
      c.updateProjectionMatrix();
      app.scene.render();
    },
    run(seconds, pointer = { x: -10000, y: -10000, inside: false }) {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) app.scene.step(1 / 60, pointer, app.settings);
      app.scene.render();
    },
    pause() { app.paused = true; },
    resume() { app.lastStep = null; app.paused = false; },
  };
}

function showError(prefix, err) {
  console.error(err);
  const el = document.getElementById('error');
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
    showError('Hangar needs WebGL 2 to run. ', err);
  }
}
start();
