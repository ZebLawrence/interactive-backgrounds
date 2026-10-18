// Sandstone Arch — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Scene } from './scene.js';

const params = new URLSearchParams(location.search);
const flag = (on, off) => (params.has(on) ? true : (params.has(off) ? false : null));

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('arch.' + key);
      if (v === null) return fallback;
      return typeof fallback === 'boolean' ? v === 'true' : v;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('arch.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?aurora` / `?noaurora`, `?moon` / `?nomoon`, `?craft` / `?nocraft` override the saved settings for testing.
  auroraOverride: flag('aurora', 'noaurora'),
  moonOverride: flag('moon', 'nomoon'),
  craftOverride: flag('craft', 'nocraft'),
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get aurora() { return this.auroraOverride ?? this.read('aurora', true); },
  set aurora(v) { this.auroraOverride = null; this.write('aurora', v); },
  get moonlight() { return this.moonOverride ?? this.read('moonlight', true); },
  set moonlight(v) { this.moonOverride = null; this.write('moonlight', v); },
  get craft() { return this.craftOverride ?? this.read('craft', true); },
  set craft(v) { this.craftOverride = null; this.write('craft', v); },
  get clickToSplash() { return this.read('clickToSplash', true); },
  set clickToSplash(v) { this.write('clickToSplash', v); },
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
      c.rgb *= 1.0 - 0.2 * pow(clamp(d, 0.0, 1.0), 2.6);
      c.rgb = max(c.rgb, 0.0);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('canyon');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map is drawn once per frame, during the refraction pass (see Canyon.renderPasses).
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
    // Bloom for the craft's lights, the aurora and the moon.
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.6, 0.85));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.canyon) { this.attachCanyon(); this.canyon.buildTargets(); }
  }

  attachCanyon() {
    this.renderPass.scene = this.canyon.scene;
    this.renderPass.camera = this.canyon.camera;
    this.canyon.resize(this.size.w, this.size.h);
  }

  /** Build (or re-seed) the scene for the current window size. */
  rebuild() {
    const old = this.canyon;
    this.canyon = new Scene(this, this.renderer, this.size.w, this.size.h, this.settings);
    this.attachCanyon();
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
    this.canyon.step(dt, this.pointer, this.settings);
    this.render();
  }

  render() {
    this.canyon.renderPasses();
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
      this.canyon.click({ x: e.clientX, y: this.size.h - e.clientY }, this.settings.clickToSplash);
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') this.act('surge');
      else if (k === 'a') this.toggle('aurora');
      else if (k === 'm') this.toggle('moonlight');
      else if (k === 'c') this.toggle('craft');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      if (!(this.size.w > 0 && this.size.h > 0)) return;
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachCanyon();
      this.canyon.buildTargets();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const c = this.canyon;
        if (Math.abs(c.screenW - this.size.w) > 4 || Math.abs(c.screenH - this.size.h) > 4) this.rebuild();
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
      case 'surge': this.canyon.surge(); break;
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
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

// Console aids for checking the scene up close (see guidelines.md): __view(x, y, z, fov) aims the
// camera at a world point with a narrow field of view and renders once; __adv(seconds, px, py)
// runs the simulation ahead with the pointer held at a screen point; __resume() returns to normal.
Object.assign(window, {
  __view(x, y, z, fov = 10) {
    const app = window.arch, c = app.canyon;
    app.paused = true;
    c.camera.fov = fov;
    c.camera.updateProjectionMatrix();
    c.camera.lookAt(x, y, z);
    c.cameraInverse = c.camera.quaternion.clone().invert();
    app.render();
  },
  __adv(seconds, px = -10000, py = -10000) {
    const app = window.arch;
    const n = Math.round(seconds * 60);
    const inside = px > -1000;
    for (let i = 0; i < n; i++) app.canyon.step(1 / 60, { x: px, y: py, inside }, app.settings);
    app.render();
  },
  __resume() {
    const app = window.arch, c = app.canyon;
    c.camera.fov = c.fov;
    c.camera.updateProjectionMatrix();
    c.setCameraTurn(c.cameraAngles.x, c.cameraAngles.y);
    app.paused = false;
  },
});

function start() {
  // Some hosts report a 0x0 window while the page is still being laid out; wait for a real size.
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) { requestAnimationFrame(start); return; }
  try {
    window.arch = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('error');
    el.hidden = false;
    el.textContent = 'Sandstone Arch needs WebGL 2 to run. ' + (err?.message ?? '');
  }
}
start();
