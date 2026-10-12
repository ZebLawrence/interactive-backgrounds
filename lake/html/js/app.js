// Loon Lake — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Lake, DENSITY } from './lake.js';

const params = new URLSearchParams(location.search);

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('lake.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('lake.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?night` / `?dusk` and `?rain` / `?dry` override the saved settings for testing.
  nightOverride: params.has('night') ? true : (params.has('dusk') ? false : null),
  rainOverride: params.has('rain') ? true : (params.has('dry') ? false : null),
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get clickToSkip() { return this.read('clickToSkip', true); },
  set clickToSkip(v) { this.write('clickToSkip', v); },
  get night() { return this.nightOverride ?? this.read('night', false); },
  set night(v) { this.nightOverride = null; this.write('night', v); },
  get rain() { return this.rainOverride ?? this.read('rain', false); },
  set rain(v) { this.rainOverride = null; this.write('rain', v); },
  get density() { const d = this.read('density', 'normal'); return d in DENSITY ? d : 'normal'; },
  set density(v) { this.write('density', v); },
  get fps() { return this.lowPower ? 30 : 60; },
};

/** Vignette and a touch of extra saturation, in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, 1.05), 0.0);
      float d = length(vUv - 0.5) * 1.35;
      c.rgb *= 1.0 - 0.4 * pow(clamp(d, 0.0, 1.0), 2.6);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('lake');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map is drawn once per frame, during the refraction pass (see Lake.renderPasses).
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.autoClear = true;
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
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.45, 0.9));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.lake) { this.attachLake(); this.lake.buildTargets(); }
  }

  attachLake() {
    this.renderPass.scene = this.lake.scene;
    this.renderPass.camera = this.lake.camera;
    this.lake.resize(this.size.w, this.size.h);
  }

  /** Build (or re-seed) the lake for the current window size. */
  rebuild() {
    const old = this.lake;
    this.lake = new Lake(this, this.renderer, this.size.w, this.size.h, this.settings);
    this.attachLake();
    if (old) old.dispose();
    this.updateMenu();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const interval = 1000 / this.settings.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    this.lake.step(dt, this.pointer, this.settings);
    this.lake.renderPasses();
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
      if (this.settings.clickToSkip) this.lake.skipStone({ x: e.clientX, y: this.size.h - e.clientY });
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') this.act('skip');
      else if (k === 'n') this.toggle('night');
      else if (k === 'r') this.toggle('rain');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachLake();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const l = this.lake;
        if (Math.abs(l.screenW - this.size.w) > 4 || Math.abs(l.screenH - this.size.h) > 4) this.attachLake();
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
    this.menu.querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', () => {
      this.settings.density = b.dataset.density;
      this.lake.setDensity(b.dataset.density);
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
      case 'skip': {
        // Toward the cursor if it is over the page, otherwise out into the middle of the lake.
        const p = this.pointer.inside ? { x: this.pointer.x, y: this.pointer.y } : { x: this.size.w * (0.35 + Math.random() * 0.3), y: this.size.h * 0.45 };
        this.lake.skipStone(p);
        break;
      }
      case 'density': {
        const s = document.getElementById('density');
        s.hidden = !s.hidden;
        this.menu.querySelector('[data-act="density"] .check').textContent = s.hidden ? '▸' : '▾';
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
    const l = this.lake;
    document.getElementById('menuTitle').textContent = `Loon Lake — ${l.shoal.fish.length} trout, ${l.loons.list.length} ${l.loons.list.length === 1 ? 'loon' : 'loons'}`;
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => {
      const on = this.settings[b.dataset.toggle];
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    this.menu.querySelectorAll('[data-density]').forEach((b) => {
      b.querySelector('.check').textContent = b.dataset.density === this.settings.density ? '✓' : '';
    });
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

function start() {
  // Some hosts report a 0x0 window while the page is still being laid out; wait for a real size.
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) { requestAnimationFrame(start); return; }
  try {
    window.lake = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('error');
    el.hidden = false;
    el.textContent = 'Loon Lake needs WebGL 2 to run. ' + (err?.message ?? '');
  }
}
start();
