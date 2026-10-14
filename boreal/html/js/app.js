// Boreal Night — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Boreal, OWLS } from './boreal.js';

const params = new URLSearchParams(location.search);
const flag = (on, off) => (params.has(on) ? true : (params.has(off) ? false : null));

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('boreal.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('boreal.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?snow` / `?clear`, `?moon` / `?dark` override the saved settings for testing; `?substorm`
  // starts with the aurora breaking up.
  snowOverride: flag('snow', 'clear'),
  moonOverride: flag('moon', 'dark'),
  substormAtStart: params.has('substorm'),
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get snowfall() { return this.snowOverride ?? this.read('snowfall', true); },
  set snowfall(v) { this.snowOverride = null; this.write('snowfall', v); },
  get moonlight() { return this.moonOverride ?? this.read('moonlight', true); },
  set moonlight(v) { this.moonOverride = null; this.write('moonlight', v); },
  get clickToHunt() { return this.read('clickToHunt', true); },
  set clickToHunt(v) { this.write('clickToHunt', v); },
  get owls() { const d = this.read('owls', 'one'); return d in OWLS ? d : 'one'; },
  set owls(v) { this.write('owls', v); },
  get fps() { return this.lowPower ? 30 : 60; },
};

/** Vignette and a cool lift in the shadows, in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length(vUv - 0.5) * 1.35;
      c.rgb *= 1.0 - 0.4 * pow(clamp(d, 0.0, 1.0), 2.6);
      c.rgb = max(c.rgb, 0.0);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('forest');
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
    if (this.settings.substormAtStart) this.forest.substorm();
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
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.6, 0.55));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.forest) this.attachForest();
  }

  attachForest() {
    this.renderPass.scene = this.forest.scene;
    this.renderPass.camera = this.forest.camera;
    this.forest.resize(this.size.w, this.size.h);
  }

  /** Build (or re-seed) the forest for the current window size. */
  rebuild() {
    const old = this.forest;
    if (old) old.dispose();
    this.forest = new Boreal(this, this.size.w, this.size.h, this.settings);
    this.attachForest();
    this.updateMenu();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const interval = 1000 / this.settings.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    this.forest.step(dt, this.pointer, this.settings);
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
      if (this.settings.clickToHunt) this.forest.click({ x: e.clientX, y: this.size.h - e.clientY });
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a') this.act('substorm');
      else if (k === 'h') this.act('hunt');
      else if (k === 's') this.toggle('snowfall');
      else if (k === 'm') this.toggle('moonlight');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      if (!(this.size.w > 0 && this.size.h > 0)) return;
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachForest();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const f = this.forest;
        if (Math.abs(f.screenW - this.size.w) > 4 || Math.abs(f.screenH - this.size.h) > 4) this.rebuild();
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
    this.menu.querySelectorAll('[data-owls]').forEach((b) => b.addEventListener('click', () => {
      this.settings.owls = b.dataset.owls;
      this.forest.setOwls(b.dataset.owls);
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
      case 'substorm': this.forest.substorm(); break;
      case 'hunt': this.forest.huntSomewhere(); break;
      case 'owls': {
        const s = document.getElementById('owls');
        s.hidden = !s.hidden;
        this.menu.querySelector('[data-act="owls"] .check').textContent = s.hidden ? '▸' : '▾';
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
    this.menu.querySelectorAll('[data-owls]').forEach((b) => {
      b.querySelector('.check').textContent = b.dataset.owls === this.settings.owls ? '✓' : '';
    });
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

function start() {
  // Some hosts report a 0x0 window while the page is still being laid out; wait for a real size.
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) { requestAnimationFrame(start); return; }
  try {
    window.boreal = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('error');
    el.hidden = false;
    el.textContent = 'Boreal Night needs WebGL 2 to run. ' + (err?.message ?? '');
  }
}
start();
