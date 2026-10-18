// Sandstone Arch — The scene: a lake under a natural bridge at night, the aurora over it, the
// craft hovering beneath. Owns the camera, the lights, the cursor's verbs, and steps every
// system. Units are metres; the water is y = 0, the viewer stands on the near bank at the
// origin, the bridge is 200 m away toward -z.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, smoothstep, v3, unit, quatAxis, seeded, approach, TIME_WRAP } from './util.js';
import { G, LAYER } from './shaders.js';
import { Terrain, Bridge, makeRockMaterial, loadPhotos, groundHeight, shoreX, bridgeContact, insideRock, BRIDGE, REF } from './terrain.js';
import { WaveSim, Rings, Water, Floor, inSim, floorHeight } from './water.js';
import { Shrubs, Blocks, Puffs } from './shore.js';
import { Sky, Moon, Light, SKY_RADIUS } from './sky.js';
import { Aurora } from './aurora.js';
import { Craft } from './craft.js';

const EYE = 1.7;
const FOV = 50;
const PITCH = REF.pitch;

export class Cursor {
  constructor() {
    this.screen = { x: -10000, y: -10000 };
    this.present = false;
    this.vel = { dx: 0, dy: 0 };
    this.speed = 0;
    this.stillTime = 0;
  }

  update(p, inside, dt) {
    if (inside && this.present && dt > 0) {
      const vx = (p.x - this.screen.x) / dt, vy = (p.y - this.screen.y) / dt;
      this.vel = { dx: this.vel.dx + (vx - this.vel.dx) * 0.35, dy: this.vel.dy + (vy - this.vel.dy) * 0.35 };
    } else {
      this.vel = { dx: 0, dy: 0 };
    }
    this.present = inside;
    this.screen = { x: p.x, y: p.y };
    this.speed = Math.hypot(this.vel.dx, this.vel.dy);
    this.stillTime = this.speed < 25 ? this.stillTime + dt : 0;
  }
}

const GRAVITY = 9.81;

/** A tossed stone: from the hand to where you clicked, then a plunk. */
class Stone {
  constructor(scene, target) {
    this.scene = scene;
    this.pos = scene.camera.position.clone().add(v3(0.3, -0.4, -0.4));
    const to = target.clone().sub(this.pos);
    const D = Math.hypot(to.x, to.z);
    const vh = clamp(D / 1.3, 4, 18);
    const T = D / vh;
    this.vel = v3(to.x / D * vh, (target.y - this.pos.y + GRAVITY * T * T / 2) / T, to.z / D * vh);
    this.spin = rnd(0, TAU);
    this.size = rnd(0.035, 0.055);
    this.mesh = new THREE.Mesh(scene.stoneGeometry, scene.stoneMaterial);
    this.mesh.scale.set(this.size, this.size * 0.6, this.size * 0.85);
    this.mesh.castShadow = true;
    this.mesh.layers.enable(LAYER.ABOVE);
    this.mesh.frustumCulled = false;
    scene.scene.add(this.mesh);
    this.done = false;
  }

  update(dt) {
    const s = this.scene;
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.spin += dt * 18;
    const ground = groundHeight(this.pos.x, this.pos.z);
    if (ground > 0 && this.pos.y <= ground && this.vel.y < 0) {
      s.dust(this.pos.clone().setY(ground + 0.05), 6, 0.25);
      this.pos.y = ground + this.size * 0.3;
      this.mesh.position.copy(this.pos);
      this.settled = true;
      this.done = true;
      s.keepStone(this.mesh);
      return;
    }
    if (this.pos.y <= 0 && this.vel.y < 0 && !this.sinking) {
      this.pos.y = 0;
      s.splash(this.pos.x, this.pos.z, this.size * 6, this.vel.length());
      this.mesh.layers.set(LAYER.BELOW);
      this.vel.multiplyScalar(0.2);
      this.sinking = true;
    }
    if (this.sinking) {
      this.vel.multiplyScalar(Math.exp(-dt * 3));
      this.vel.y = -0.6;
      if (this.pos.y < floorHeight(this.pos.x, this.pos.z) - 0.1 || this.pos.y < -12) this.done = true;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(quatAxis(this.spin, 0.3, 1, 0.2));
  }

  dispose() { if (!this.settled) this.scene.scene.remove(this.mesh); }
}

export class Scene {
  constructor(app, renderer, screenW, screenH, settings) {
    this.app = app;
    this.renderer = renderer;
    this.screenW = screenW;
    this.screenH = screenH;
    this.settings = settings;
    this.seed = Math.floor(Math.random() * 1e9);
    const rng = seeded(this.seed);
    this.rng = rng;
    this.aspect = screenW / screenH;
    this.fov = FOV;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.basePitch = PITCH;
    this.cursor = new Cursor();
    this.clock = 0;
    this.cameraAngles = new THREE.Vector2();
    this.finger = { point: v3(), inWater: false, valid: false, prev: null };
    this.startles = [];
    this.stones = [];
    this.keptStones = [];
    this.breeze = { angle: Math.PI / 2, strength: 0.12, target: 0.12, timer: rnd(10, 30), gust: 0 };
    G.uWind.value.set(0, 1, 0.12);
    G.uNight.value = 1;
    G.uDusk.value = 0;
    this.light = {};

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(), G.uFogNear.value, G.uFogFar.value);
    this.eyeY = REF.eyeY;
    this.camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.2, 60000);
    this.camera.position.set(0, this.eyeY, 0);
    this.camera.layers.enable(LAYER.ABOVE);
    this.scene.add(this.camera);
    this.setCameraTurn(0, 0);
    this.mirrorCamera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.2, 60000);
    this.mirrorCamera.layers.set(LAYER.ABOVE);

    // --- Lights -------------------------------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0x203050, 0x201a18, 1.3);
    this.key = new THREE.DirectionalLight(0xffd0a0, 2.2);
    this.key.castShadow = true;
    this.key.target.position.set(-10, 30, -150);
    this.key.shadow.mapSize.set(4096, 4096);
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 1.6;
    this.key.shadow.radius = 4;
    this.bounce = new THREE.DirectionalLight(0xff9a5a, 0.1);
    this.bounce.position.set(0, -40, -120);
    this.bounce.target.position.set(0, 40, -200);
    for (const l of [this.hemi, this.key, this.bounce]) { l.layers.enable(LAYER.ABOVE); l.layers.enable(LAYER.BELOW); this.scene.add(l); }
    this.scene.add(this.key.target, this.bounce.target);
    this.shadowBox = new THREE.Box3(v3(-150, -12, -215), v3(125, 100, 12));

    // --- The land -----------------------------------------------------------------------------
    this.rockMaterial = makeRockMaterial(1);
    this.blockMaterial = makeRockMaterial(0.55);
    // The reference image is projected onto the rock from where the viewer stands, through a
    // camera of this scene's field of view at the picture's own aspect, so the rock carries the
    // photograph wherever the two line up.
    {
      const refCam = new THREE.PerspectiveCamera(REF.fov, REF.w / REF.h, 0.2, 60000);
      refCam.position.copy(this.camera.position);
      refCam.quaternion.copy(this.camera.quaternion);
      refCam.updateMatrixWorld();
      refCam.updateProjectionMatrix();
      const m = new THREE.Matrix4().multiplyMatrices(refCam.projectionMatrix, refCam.matrixWorldInverse);
      this.rockMaterial.userData.uniforms.uRefMatrix.value.copy(m);
      this.blockMaterial.userData.uniforms.uRefMatrix.value.copy(m);
    }
    this.photos = loadPhotos((key, tex) => { this.rockMaterial.userData.setPhoto(key, tex); this.blockMaterial.userData.setPhoto(key, tex); });
    this.terrain = new Terrain(this.rockMaterial);
    this.bridge = new Bridge(this.rockMaterial, rng);
    this.scene.add(this.terrain.mesh, this.bridge.mesh);

    // --- The sky ------------------------------------------------------------------------------
    this.sky = new Sky();
    this.moon = new Moon();
    this.aurora = new Aurora();
    this.lightState = new Light();
    this.scene.add(this.sky.mesh, this.moon.mesh, this.aurora.group);
    this.aurora.group.traverse((o) => o.layers.enable(LAYER.ABOVE));

    // --- The water ----------------------------------------------------------------------------
    this.sim = new WaveSim(renderer, settings.lowPower ? 1536 : 2048);
    this.rings = new Rings();
    this.water = new Water(renderer, this.sim, this.rings);
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    this.whiteTex = white;
    this.floor = new Floor(this.sim, white);
    this.scene.add(this.water.mesh, this.floor.mesh);

    // --- The shore ----------------------------------------------------------------------------
    this.shrubs = new Shrubs(rng);
    this.blocks = new Blocks(rng, this.blockMaterial);
    this.puffs = new Puffs(400);
    this.drops = new Puffs(400, [1.3, 1.4, 1.5]);
    this.scene.add(this.shrubs.group, this.blocks.group, this.puffs.points, this.drops.points);
    this.stoneGeometry = new THREE.SphereGeometry(1, 12, 9);
    this.stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x6b5244, roughness: 0.8, metalness: 0.02 });

    // --- The craft -----------------------------------------------------------------------------
    this.craft = new Craft(this);
    this.scene.add(this.craft.group);

    this.buildTargets();
    this.lightState.update(0, settings, this.light, this.aurora.level);
    this.applyLight();
    this.updateShadowCamera();
  }

  // MARK: - Geometry helpers

  setCameraTurn(yaw, pitch) {
    this.camera.quaternion.copy(quatAxis(yaw, 0, 1, 0).multiply(quatAxis(this.basePitch + pitch, 1, 0, 0)));
    this.cameraInverse = this.camera.quaternion.clone().invert();
  }

  project(p) {
    const q = p.clone().sub(this.camera.position).applyQuaternion(this.cameraInverse);
    const depth = Math.max(-q.z, 0.01);
    const f = this.focal / depth;
    return { x: this.screenW / 2 + q.x * f, y: this.screenH / 2 + q.y * f, depth };
  }

  ray(s) {
    const dir = v3((s.x - this.screenW / 2) / this.focal, (s.y - this.screenH / 2) / this.focal, -1).applyQuaternion(this.camera.quaternion).normalize();
    return { origin: this.camera.position.clone(), dir };
  }

  closestPointOnCursorRay(p) {
    const { origin, dir } = this.ray(this.cursor.screen);
    return origin.clone().addScaledVector(dir, Math.max(0, p.clone().sub(origin).dot(dir)));
  }

  /** Where a screen point meets the water, if it does within `maxDist` metres and over the lake. */
  waterPoint(s, maxDist = 300) {
    const { origin, dir } = this.ray(s);
    if (dir.y >= -1e-4) return null;
    const t = -origin.y / dir.y;
    if (t > maxDist) return null;
    const p = origin.clone().addScaledVector(dir, t);
    if (groundHeight(p.x, p.z) > -0.05) return null;
    // Rock in the way?
    if (this.rockHit(s, t)) return null;
    return p;
  }

  /** The first rock (ground or bridge) along a screen ray. */
  rockHit(s, maxDist = 900) {
    const { origin, dir } = this.ray(s);
    return this.rockRay(origin, dir, maxDist);
  }

  /** The first rock along a world ray, marched in steps that grow with distance. */
  rockRay(origin, dir, maxDist = 900) {
    const p = origin.clone();
    let step = 0.5;
    for (let d = 0; d < maxDist; d += step) {
      p.addScaledVector(dir, step);
      if (insideRock(p)) return { point: p.clone(), dist: d };
      if (p.y > 400) return null;
      step = clamp(d * 0.01, 0.5, 6);
    }
    return null;
  }

  /** Does a screen point land on the craft? */
  craftHit(s) {
    const { origin, dir } = this.ray(s);
    const c = this.craft.group.position;
    const to = c.clone().sub(origin);
    const t = to.dot(dir);
    if (t < 0) return false;
    const closest = origin.clone().addScaledVector(dir, t);
    return closest.distanceTo(c) < 14;
  }

  // MARK: - Disturbing the water

  disturb(x, z, radius, amount, ringAmp = 0) {
    if (this.sim.splat(x, z, radius, amount)) return;
    if (ringAmp > 0) this.rings.add(x, z, ringAmp * 0.006, this.clock);
  }

  splash(x, z, size, speed) {
    const s = clamp(size, 0.1, 3), v = clamp(speed / 10, 0.3, 2.5);
    this.disturb(x, z, 0.12 + s * 0.35, -(0.015 + 0.04 * s) * v, 1.2 * s * v);
    this.drops.burst(v3(x, 0.05, z), Math.round(10 + 50 * s * v), 0.45 + s * 0.8 * v, v3(0, 3.2 * v * (0.5 + s), 0));
    this.startles.push({ x, z, radius: 4 + 5 * s * v });
  }

  dust(at, n, size) { this.puffs.burst(at, n, size); }

  keepStone(mesh) {
    this.keptStones.push(mesh);
    if (this.keptStones.length > 40) this.scene.remove(this.keptStones.shift());
  }

  // MARK: - Cursor verbs

  updateFinger(dt) {
    const c = this.cursor, f = this.finger;
    if (!c.present) { f.valid = false; f.inWater = false; f.prev = null; return; }
    const wp = this.waterPoint(c.screen, 120);
    const wasInWater = f.inWater && f.prev;
    if (wp) {
      f.point.copy(wp).setY(0);
      f.inWater = true;
      f.valid = true;
    } else {
      const { origin, dir } = this.ray(c.screen);
      f.point.copy(origin).addScaledVector(dir, 6);
      f.inWater = false;
      f.valid = f.point.y < 4;
    }
    if (f.inWater && inSim(f.point.x, f.point.z)) {
      const segLen = wasInWater ? f.prev.distanceTo(f.point) : 0;
      if (wasInWater && c.speed > 30 && segLen < 2) {
        const from = f.prev, to = f.point;
        const n = clamp(Math.ceil(segLen / 0.05), 1, 8);
        const amount = -0.004 * clamp(c.speed / 600, 0.4, 1.6);
        for (let i = 1; i <= n; i++) {
          const p = from.clone().lerp(to, i / n);
          this.sim.splat(p.x, p.z, 0.06 + 0.03 * clamp(c.speed / 1000, 0, 1), amount / Math.sqrt(n));
        }
      } else if (!wasInWater) {
        this.sim.splat(f.point.x, f.point.z, 0.08, -0.005);
      }
    }
    f.prev = f.inWater ? f.point.clone() : null;
    if (c.speed > 700) this.breeze.gust = Math.min(this.breeze.gust + dt * 2, 1);
  }

  /** A click: the craft, a stone onto the water or the shore, or a surge in the aurora. */
  click(s, clickToSplash) {
    if (!clickToSplash) return;
    if (this.settings.craft && this.craftHit(s)) { this.craft.rouse(); return; }
    const wp = this.waterPoint(s, 400);
    if (wp) { this.stones.push(new Stone(this, wp)); return; }
    const rock = this.rockHit(s, 60);
    if (rock) {
      const p = rock.point;
      if (groundHeight(p.x, p.z) < 6 && p.distanceTo(this.camera.position) < 60) { p.y = groundHeight(p.x, p.z); this.stones.push(new Stone(this, p)); }
      return;
    }
    const { dir } = this.ray(s);
    this.aurora.flare(dir);
  }

  surge() { this.aurora.substorm(); }

  // MARK: - Frame loop

  updateCamera(dt) {
    const maxYaw = 3 * Math.PI / 180, maxPitch = 1.5 * Math.PI / 180;
    const target = new THREE.Vector2();
    const c = this.cursor;
    if (c.present) {
      const w = this.screenW, h = this.screenH;
      const zoneX = w * 0.12, zoneY = h * 0.12;
      const right = smoothstep(w - zoneX, w, c.screen.x) - smoothstep(zoneX, 0, c.screen.x);
      const up = smoothstep(h - zoneY, h, c.screen.y) - smoothstep(zoneY, 0, c.screen.y);
      target.set(-right * maxYaw, up * maxPitch);
    }
    const before = this.cameraAngles.clone();
    this.cameraAngles.add(target.sub(this.cameraAngles).multiplyScalar(Math.min(1, dt * 1.0)));
    if (before.distanceTo(this.cameraAngles) > 1e-7) this.setCameraTurn(this.cameraAngles.x, this.cameraAngles.y);
  }

  updateBreeze(dt) {
    const b = this.breeze;
    b.timer -= dt;
    if (b.timer <= 0) { b.target = Math.random() < 0.5 ? rnd(0, 0.08) : rnd(0.1, 0.35); b.timer = rnd(20, 70); }
    b.strength += clamp(b.target - b.strength, -dt * 0.01, dt * 0.01);
    b.angle += Math.sin(this.clock * 0.011) * 0.02 * dt;
    b.gust = Math.max(0, b.gust - dt * 0.35);
    const s = clamp(b.strength + b.gust * 0.6, 0, 1);
    G.uWind.value.set(Math.cos(b.angle), Math.sin(b.angle), s);
  }

  applyLight() {
    const L = this.light;
    this.hemi.color.setRGB(L.sky.x, L.sky.y, L.sky.z);
    this.hemi.groundColor.setRGB(L.ground.x, L.ground.y, L.ground.z);
    this.hemi.intensity = L.hemi;
    this.key.position.copy(this.key.target.position).addScaledVector(G.uMoonDir.value, 420);
    this.key.color.setRGB(L.key.x, L.key.y, L.key.z);
    this.key.intensity = L.keyI;
    this.bounce.color.setRGB(L.bounce.x, L.bounce.y, L.bounce.z);
    this.bounce.intensity = L.bounceI;
    this.scene.fog.color.setRGB(L.fog.x, L.fog.y, L.fog.z);
    this.scene.fog.near = L.fogNear;
    this.scene.fog.far = L.fogFar;
  }

  updateShadowCamera() {
    const sc = this.key.shadow.camera;
    this.key.updateMatrixWorld();
    this.key.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(this.key.position, this.key.target.position, v3(0, 1, 0)).invert();
    const min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity);
    const b = this.shadowBox, c = v3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(this.key.position).applyMatrix4(view);
      min.min(c); max.max(c);
    }
    sc.left = min.x; sc.right = max.x; sc.bottom = min.y; sc.top = max.y;
    sc.near = Math.max(1, -max.z - 5); sc.far = -min.z + 5;
    sc.updateProjectionMatrix();
  }

  step(dt, pointer, settings) {
    this.clock += dt;
    G.uTime.value = this.clock % TIME_WRAP;
    this.cursor.update(pointer, pointer.inside, dt);
    this.updateCamera(dt);
    this.aurora.update(dt, this.camera);
    this.aurora.group.visible = this.lightState.aurora > 0.01;
    if (this.lightState.aurora < 0.999) G.uAuroraLight.value.multiplyScalar(this.lightState.aurora);
    this.lightState.update(dt, settings, this.light, this.aurora.level);
    this.applyLight();
    this.updateBreeze(dt);
    this.startles = [];
    this.updateFinger(dt);
    for (const s of this.stones) s.update(dt);
    this.stones = this.stones.filter((s) => { if (s.done) { s.dispose(); return false; } return true; });
    this.puffs.update(dt);
    this.drops.update(dt);
    this.craft.group.visible = !!settings.craft;
    if (settings.craft) {
      for (const s of this.startles) if (Math.hypot(s.x - this.craft.pos.x, s.z - this.craft.pos.z) < 40) this.craft.startle(v3(s.x, 0, s.z), 0.6);
      this.craft.update(dt, this);
    }
    this.moon.update(this.lightState.moon);
    this.water.uniforms.uRingCount.value = this.rings.update(this.clock);
    this.sim.step(dt);
  }

  // MARK: - Render passes

  buildTargets() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, size.x), h = Math.max(1, size.y);
    this.reflTarget?.dispose();
    this.refrTarget?.dispose();
    this.reflTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.reflTarget.texture.minFilter = THREE.LinearFilter;
    this.refrTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.refrTarget.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    const u = this.water.uniforms;
    u.uReflection.value = this.reflTarget.texture;
    u.uRefraction.value = this.refrTarget.texture;
    u.uRefrDepth.value = this.refrTarget.depthTexture;
    u.uResolution.value.set(w, h);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    const ratio = this.renderer.getPixelRatio();
    this.puffs.setPixelRatio(ratio);
    this.drops.setPixelRatio(ratio);
  }

  resize(screenW, screenH) {
    this.screenW = screenW;
    this.screenH = screenH;
    this.aspect = screenW / screenH;
    this.focal = (screenH / 2) / Math.tan(this.fov / 2 * Math.PI / 180);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  renderPasses() {
    const r = this.renderer;
    const cam = this.camera, m = this.mirrorCamera;
    cam.updateMatrixWorld();
    m.position.set(cam.position.x, -cam.position.y, cam.position.z);
    const f = v3(0, 0, -1).applyQuaternion(cam.quaternion), up = v3(0, 1, 0).applyQuaternion(cam.quaternion);
    f.y = -f.y; up.y = -up.y;
    m.up.copy(up);
    m.lookAt(m.position.clone().add(f));
    m.aspect = cam.aspect; m.fov = cam.fov; m.near = cam.near; m.far = cam.far;
    m.updateProjectionMatrix();
    m.updateMatrixWorld();
    const tm = this.water.uniforms.uMirrorMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
    const plane = new THREE.Plane(v3(0, 1, 0), 0).applyMatrix4(m.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = m.projectionMatrix, q = new THREE.Vector4();
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1;
    q.w = (1 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1; pm.elements[14] = clip.w;

    const prevTarget = r.getRenderTarget();
    const fog = G.uFogColor.value;
    cam.layers.enableAll();
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.refrTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    cam.layers.set(LAYER.BELOW);
    r.render(this.scene, cam);
    if (this.key.shadow.map) {
      G.uShadowMap.value = this.key.shadow.map.texture;
      G.uShadowMatrix.value.copy(this.key.shadow.matrix);
      G.uShadowOn.value = 1;
    }
    r.setRenderTarget(this.reflTarget);
    r.setClearColor(new THREE.Color(fog.x, fog.y, fog.z), 1);
    r.clear();
    r.render(this.scene, m);
    cam.layers.set(LAYER.MAIN);
    cam.layers.enable(LAYER.ABOVE);
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    for (const s of this.stones) s.dispose();
    for (const m of this.keptStones) this.scene.remove(m);
    for (const part of [this.craft, this.sky, this.moon, this.aurora, this.water, this.sim, this.floor, this.shrubs, this.blocks, this.puffs, this.drops, this.terrain, this.bridge]) part?.dispose();
    for (const t of Object.values(this.photos)) t.dispose();
    this.rockMaterial.dispose();
    this.blockMaterial.dispose();
    this.whiteTex.dispose();
    this.reflTarget?.dispose();
    this.refrTarget?.dispose();
    this.stoneGeometry.dispose();
    this.stoneMaterial.dispose();
  }
}
