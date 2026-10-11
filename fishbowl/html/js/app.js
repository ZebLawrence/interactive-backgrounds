// Fishbowl — Entry point: settings, menu, input, renderer and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp, Art } from './util.js';
import { snowMaterial } from './shaders.js';
import { Species } from './species.js';
import { Shark } from './fish.js';
import { Tank } from './tank.js';

// ---------------------------------------------------------------------------------------------
// App shell (AppDelegate.swift, Settings.swift, RenderView.swift): settings, the menu, input,
// rendering at a fixed 30/60 fps, and rebuilding the tank when the window size changes
// ---------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);

const Settings = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem('fishbowl.' + key);
      return v === null ? fallback : v === 'true';
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem('fishbowl.' + key, String(value)); } catch { /* private mode */ }
  },
  // `?night` / `?day` / `?shark` / `?hunt-now` override for testing without changing saved settings.
  nightOverride: params.has('night') ? true : (params.has('day') ? false : null),
  sharkOverride: params.has('shark') || params.has('hunt-now') ? true : null,
  get lowPower() { return this.read('lowPower', false); },
  set lowPower(v) { this.write('lowPower', v); },
  get clickToFeed() { return this.read('clickToFeed', true); },
  set clickToFeed(v) { this.write('clickToFeed', v); },
  get nightMode() { return this.nightOverride ?? this.read('nightMode', false); },
  set nightMode(v) { this.nightOverride = null; this.write('nightMode', v); },
  get shark() { return this.sharkOverride ?? this.read('shark', false); },
  set shark(v) { this.sharkOverride = null; this.write('shark', v); },
  get fps() { return this.lowPower ? 30 : 60; },
};
if (params.has('hunt-now')) Shark.huntSoon = true;

/** Vignette and a touch of extra saturation, in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, aspect: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, 1.05), 0.0);
      float d = length(vUv - 0.5) * 1.35;
      c.rgb *= 1.0 - 0.7 * pow(clamp(d, 0.0, 1.0), 2.6);
      gl_FragColor = c;
    }`,
};

class App {
  constructor() {
    this.settings = Settings;
    this.canvas = document.getElementById('tank');
    this.fxEl = document.getElementById('fx');
    this.pointer = { x: -10000, y: -10000, inside: false };
    this.lastFrame = null;
    this.lastStep = null;

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = Math.pow(2, 0.1);
    this.renderer = renderer;

    // Image-based lighting from the vertical water gradient.
    const envSource = new THREE.CanvasTexture(Art.waterGradient(256, 128));
    envSource.mapping = THREE.EquirectangularReflectionMapping;
    envSource.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromEquirectangular(envSource).texture;
    envSource.dispose();
    pmrem.dispose();

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
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.35, 0.85));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.pixelRatio = ratio;
    if (this.tank) this.attachTank();
  }

  attachTank() {
    this.renderPass.scene = this.tank.scene;
    this.renderPass.camera = this.tank.camera;
    this.tank.camera.aspect = this.size.w / this.size.h;
    this.tank.camera.updateProjectionMatrix();
    this.tank.snowMaterial.uniforms.pxScale.value = this.size.h * this.pixelRatio / (2 * Math.tan(20 * Math.PI / 180));
  }

  /** Build (or refill) the tank for the current window size. */
  rebuild() {
    const old = this.tank;
    this.tank = new Tank(this, this.size.w, this.size.h);
    this.attachTank();
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
    this.tank.step(dt, this.pointer, this.settings);
    this.composer.render();
  }

  // MARK: - Input

  bindInput() {
    const setPointer = (e) => {
      this.pointer = { x: e.clientX, y: this.size.h - e.clientY, inside: true };
    };
    window.addEventListener('pointermove', (e) => {
      setPointer(e);
      this.wake();
    }, { passive: true });
    window.addEventListener('pointerdown', setPointer);
    const leave = () => { this.pointer = { ...this.pointer, inside: false }; };
    document.documentElement.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    window.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') leave(); });
    window.addEventListener('pointercancel', leave);

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.closeMenu();
      if (this.settings.clickToFeed) this.tank.dropFood({ x: e.clientX, y: this.size.h - e.clientY });
    });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') this.act('feed');
      else if (k === 'n') this.toggle('nightMode');
      else if (k === 'escape') this.closeMenu();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      this.size = this.windowSize();
      this.renderer.setSize(this.size.w, this.size.h, false);
      this.composer.setSize(this.size.w, this.size.h);
      this.attachTank();
      clearTimeout(resizeTimer);
      // Only rebuild once the layout settles, and only if the tank's shape really changed.
      resizeTimer = setTimeout(() => {
        const t = this.tank;
        if (Math.abs(t.screenW - this.size.w) > 4 || Math.abs(t.screenH - this.size.h) > 4) this.rebuild();
      }, 400);
    });

    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('gone'), 7000);
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
    const species = document.getElementById('species');
    for (const sp of Species.all) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="check"></span><span class="label">${sp.name}</span>`;
      b.addEventListener('click', () => { this.tank.addFish(sp); this.updateMenu(); });
      species.appendChild(b);
    }
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
      case 'feed': this.tank.dropFoodRandomly(); break;
      case 'add': {
        const s = document.getElementById('species');
        s.hidden = !s.hidden;
        this.menu.querySelector('[data-act="add"] .check').textContent = s.hidden ? '▸' : '▾';
        break;
      }
      case 'remove': this.tank.removeFish(); break;
      case 'refill': this.rebuild(); break;
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
    const n = this.tank.fish.length;
    document.getElementById('menuTitle').textContent = `Fishbowl — ${n} fish`;
    this.menu.querySelectorAll('[data-toggle]').forEach((b) => {
      const on = this.settings[b.dataset.toggle];
      b.querySelector('.check').textContent = on ? '✓' : '';
      b.setAttribute('aria-checked', String(on));
    });
    this.menu.querySelector('[data-act="fullscreen"] .check').textContent = document.fullscreenElement ? '✓' : '';
  }
}

try {
  window.fishbowl = new App();
} catch (err) {
  console.error(err);
  const el = document.getElementById('error');
  el.hidden = false;
  el.textContent = 'Fishbowl needs WebGL 2 to run. ' + (err?.message ?? '');
}
