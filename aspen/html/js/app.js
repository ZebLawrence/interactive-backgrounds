// Aspen Snow — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Aspen, HARES } from './aspen.js';

const params = new URLSearchParams(location.search);
const flag = (on, off) => (params.has(on) ? true : (params.has(off) ? false : null));

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('aspen.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('aspen.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?snow` / `?clear`, `?sun` / `?overcast`, `?night` / `?day` override the saved settings for testing.
  snowOverride: flag('snow', 'clear'),
  sunOverride: flag('sun', 'overcast'),
  nightOverride: flag('night', 'day'),
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get snowfall() { return this.snowOverride ?? this.read('snowfall', true); },
  set snowfall(v) { this.snowOverride = null; this.write('snowfall', v); },
  get sunlight() { return this.sunOverride ?? this.read('sunlight', false); },
  set sunlight(v) { this.sunOverride = null; this.write('sunlight', v); },
  get night() { return this.nightOverride ?? this.read('night', false); },
  set night(v) { this.nightOverride = null; this.write('night', v); },
  get clickToFlush() { return this.read('clickToFlush', true); },
  set clickToFlush(v) { this.write('clickToFlush', v); },
  get hares() { const d = this.read('hares', 'two'); return d in HARES ? d : 'two'; },
  set hares(v) { this.write('hares', v); },
  get fps() { return this.lowPower ? 30 : 60; },
};

/** A soft vignette, in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length(vUv - 0.5) * 1.35;
      c.rgb *= 1.0 - 0.22 * pow(clamp(d, 0.0, 1.0), 2.6);
      c.rgb = max(c.rgb, 0.0);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('grove');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    this.size = this.windowSize();
    this.buildComposer();
    this.rebuild();
    this.bindInput();
    this.bindMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  windowSize() { return { w: window.innerWidth, h: window.innerHeight }; }

  buildComposer() {
    const { w, h } = this.size;
    const low = this.settings.lowPower;
    const ratio = low ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer?.dispose();
    const target = new THREE.WebGLRenderTarget(w * ratio, h * ratio, { type: THREE.HalfFloatType, samples: low ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.composer.addPass(this.renderPass);
    // A gentle bloom: the sun's glints on the snow and the moon's halo, nothing else.
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.5, 0.92));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.grove) this.attachGrove();
  }

  attachGrove() {
    this.renderPass.scene = this.grove.scene;
    this.renderPass.camera = this.grove.camera;
    this.grove.resize(this.size.w, this.size.h);
  }

  /** Build (or re-seed) the grove for the current window size. */
  rebuild() {
    const old = this.grove;
    if (old) old.dispose();
    this.grove = new Aspen(this, this.size.w, this.size.h, this.settings);
    this.attachGrove();
    this.updateMenu();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const interval = 1000 / this.settings.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    this.grove.step(dt, this.pointer, this.settings);
    this.composer.render();
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
      this.grove.click({ x: e.clientX, y: this.size.h - e.clientY }, this.settings.clickToFlush);
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'g') this.act('flush');
      else if (k === 's') this.toggle('snowfall');
      else if (k === 'l') this.toggle('sunlight');
      else if (k === 'n') this.toggle('night');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      if (!(this.size.w > 0 && this.size.h > 0)) return;
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachGrove();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const g = this.grove;
        if (Math.abs(g.screenW - this.size.w) > 4 || Math.abs(g.screenH - this.size.h) > 4) this.rebuild();
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
    this.menu.querySelectorAll('[data-hares]').forEach((b) => b.addEventListener('click', () => {
      this.settings.hares = b.dataset.hares;
      this.grove.setHares(b.dataset.hares);
      this.updateMenu();
    }));
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
      case 'flush': this.grove.flushSomewhere(); break;
      case 'hares': {
        const s = document.getElementById('hares');
        s.hidden = !s.hidden;
        this.menu.querySelector('[data-act="hares"] .check').textContent = s.hidden ? '▸' : '▾';
        break;
      }
      case 'reseed': this.rebuild(); break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
    }
    this.updateMenu();
  }

  toggle(key) {
    this.settings[key] = !this.settings[key];
    if (key === 'lowPower') this.buildComposer();
    this.updateMenu();
  }

  updateMenu() {
    if (!this.menu) return;
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => {
      const on = this.settings[b.dataset.toggle];
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    this.menu.querySelectorAll('[data-hares]').forEach((b) => {
      b.querySelector('.check').textContent = b.dataset.hares === this.settings.hares ? '✓' : '';
    });
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

function start() {
  // Some hosts report a 0x0 window while the page is still being laid out; wait for a real size.
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) { requestAnimationFrame(start); return; }
  try {
    window.aspen = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('error');
    el.hidden = false;
    el.textContent = 'Aspen Snow needs WebGL 2 to run. ' + (err?.message ?? '');
  }
}
start();
