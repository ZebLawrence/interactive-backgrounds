// Firefly Meadow — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Meadow, DENSITY } from './meadow.js';

const params = new URLSearchParams(location.search);

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('meadow.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('meadow.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?storm` / `?calm` and `?dark` / `?moon` override for testing without changing saved settings.
  stormOverride: params.has('storm') ? true : (params.has('calm') ? false : null),
  moonOverride: params.has('dark') ? false : (params.has('moon') ? true : null),
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get clickToClap() { return this.read('clickToClap', true); },
  set clickToClap(v) { this.write('clickToClap', v); },
  get moonlight() { return this.moonOverride ?? this.read('moonlight', true); },
  set moonlight(v) { this.moonOverride = null; this.write('moonlight', v); },
  get storm() { return this.stormOverride ?? this.read('storm', false); },
  set storm(v) { this.stormOverride = null; this.write('storm', v); },
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
      c.rgb = max(mix(vec3(l), c.rgb, 1.08), 0.0);
      float d = length(vUv - 0.5) * 1.35;
      c.rgb *= 1.0 - 0.6 * pow(clamp(d, 0.0, 1.0), 2.6);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('meadow');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
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
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.45, 0.8));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.meadow) this.attachMeadow();
  }

  attachMeadow() {
    this.renderPass.scene = this.meadow.scene;
    this.renderPass.camera = this.meadow.camera;
    this.meadow.camera.aspect = this.size.w / this.size.h;
    this.meadow.camera.updateProjectionMatrix();
    this.meadow.setPixelScale(this.size.h * this.pixelRatio / (2 * Math.tan(this.meadow.fov / 2 * Math.PI / 180)));
  }

  /** Build (or re-seed) the meadow for the current window size. */
  rebuild() {
    const old = this.meadow;
    this.meadow = new Meadow(this, this.size.w, this.size.h, this.settings);
    this.attachMeadow();
    if (old) old.dispose();
    this.updateMenu();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    // Render only when we step the simulation, at a fixed 30/60 fps (skip frames on 120 Hz displays).
    const interval = 1000 / this.settings.fps;
    if (this.lastFrame !== null && now - this.lastFrame < interval - 2) return;
    this.lastFrame = now;
    const dt = this.lastStep === null ? 0 : Math.min((now - this.lastStep) / 1000, 1 / 15);
    this.lastStep = now;
    this.meadow.step(dt, this.pointer, this.settings);
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
      if (this.settings.clickToClap) this.meadow.clap({ x: e.clientX, y: this.size.h - e.clientY });
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'c') this.act('clap');
      else if (k === 's') this.toggle('storm');
      else if (k === 'm') this.toggle('moonlight');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachMeadow();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const m = this.meadow;
        if (Math.abs(m.screenW - this.size.w) > 4 || Math.abs(m.screenH - this.size.h) > 4) this.rebuild();
      }, 400);
    });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 8000);
  }

  /** The menu button fades away when the mouse rests, so it doesn't spoil the view. */
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
      this.meadow.setDensity(b.dataset.density);
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
      case 'clap': this.meadow.clap({ x: this.size.w / 2, y: this.size.h * 0.45 }); break;
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
    const n = this.meadow.swarm.flies.length;
    document.getElementById('menuTitle').textContent = `Firefly Meadow — ${n} fireflies`;
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
    window.meadow = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('error');
    el.hidden = false;
    el.textContent = 'Firefly Meadow needs WebGL 2 to run. ' + (err?.message ?? '');
  }
}
start();
