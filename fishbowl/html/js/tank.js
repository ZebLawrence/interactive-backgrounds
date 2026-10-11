// Fishbowl — Lighting, the cursor, the glass overlay and the tank itself.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, randInt, coin, pick, smoothstep, v3, unit, quatAxis, quatFromTo, RGBA, Art, Detail, Mesh, Occlusion, sharedGeometry } from './util.js';
import { TIME_WRAP, G, patchMaterial, CAUSTICS_HEAD, CAUSTICS_APPLY, causticUniforms, beamMaterial, snowMaterial } from './shaders.js';
import { Species } from './species.js';
import { setObjectOpacity, Fish, Shark, Food } from './fish.js';
import { ReefTone, CoralReef, PlantTone, PlantBed } from './scenery.js';

// ---------------------------------------------------------------------------------------------
// Lighting (Lighting.swift): by day sunlight comes down through the surface; at night the tank
// goes dark apart from a lamp above the water that swivels to aim at the cursor, with a visible
// beam and caustics only inside its cone. Switching fades over ~2 s.
// ---------------------------------------------------------------------------------------------

/** SceneKit physically based light intensities (1000 = "normal") → three.js intensities. */
export const LIGHT_K = Math.PI / 1000;
export const DAY_WATER = new RGBA(0.035, 0.2, 0.29);
export const NIGHT_WATER = new RGBA(0.004, 0.022, 0.045);
export const SUN_DIR = v3(0.073, 0.955, 0.287).normalize();

export class Lighting {
  constructor(tank, night) {
    const { scene, surfaceY, depth } = tank;
    const floorY = tank.floorHeight(0, -depth * 0.45);
    this.night = night ? 1 : 0;
    this.spotHeight = 5;
    this.spotHalfAngle = 16 * Math.PI / 180;
    this.spotPosition = v3(0, surfaceY + this.spotHeight, -depth * 0.45);
    this.spotTarget = v3(0, (surfaceY + floorY) / 2, this.spotPosition.z);
    this.floorY = floorY;
    this.surfaceY = surfaceY;
    this.lastApplied = -1;
    this.sentTarget = v3(NaN, NaN, NaN);

    // Sunlight from above casting shadows, a soft fill from the viewer, blue ambient.
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.intensity = 0.5;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.fitSunShadow(tank);
    scene.add(this.sun, this.sun.target);

    this.fill = new THREE.DirectionalLight(new RGBA(0.6, 0.85, 0.95).color, 450 * LIGHT_K);
    this.fill.position.set(0, Math.sin(0.35), Math.cos(0.35)).multiplyScalar(10);
    scene.add(this.fill, this.fill.target);

    this.ambient = new THREE.AmbientLight(0xffffff, 1);
    scene.add(this.ambient);

    // The night spotlight, hanging above the water: fully lit in the middle of the beam, fading
    // out a little beyond its visible edge.
    this.spot = new THREE.SpotLight(new RGBA(1.0, 0.94, 0.82).color, 0, 0, this.spotHalfAngle * 1.35, 1 - 0.3 / 1.35, 0);
    this.spot.position.copy(this.spotPosition);
    this.spot.castShadow = false;
    this.spot.shadow.mapSize.set(2048, 2048);
    this.spot.shadow.intensity = 0.7;
    this.spot.shadow.bias = -0.0005;
    this.spot.shadow.normalBias = 0.02;
    this.spot.shadow.camera.near = 1;
    this.spot.shadow.camera.far = (this.spotHeight + surfaceY - floorY) * 1.5;
    scene.add(this.spot, this.spot.target);

    // A soft visible beam: a long cone with its tip at the lamp.
    const beamLength = 32;
    this.beamMaterial = beamMaterial();
    this.beamMaterial.uniforms.beamTop.value = surfaceY;
    this.beamMaterial.uniforms.beamBottom.value = floorY;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(beamLength * Math.tan(this.spotHalfAngle), beamLength, 64, 1, true), this.beamMaterial);
    cone.position.y = -beamLength / 2;
    cone.frustumCulled = false;
    this.beamPivot = new THREE.Group();
    this.beamPivot.position.copy(this.spotPosition);
    this.beamPivot.add(cone);
    scene.add(this.beamPivot);

    G.spotPos.value.copy(this.spotPosition);
    // A little wider than the beam so light fades out softly past its visible edge.
    G.spotCos.value = Math.cos(this.spotHalfAngle * 1.3);
    this.aim();
  }

  /** Fit the sun's orthographic shadow camera around the part of the tank near the camera. */
  fitSunShadow(tank) {
    const zFar = -tank.depth - 2, zNear = tank.frontZ + 1;
    const hw = tank.halfWidth(zFar) + 1;
    const center = v3(0, 0, (zFar + zNear) / 2);
    this.sun.position.copy(center).addScaledVector(SUN_DIR, 40);
    this.sun.target.position.copy(center);
    const view = new THREE.Matrix4().lookAt(this.sun.position, center, v3(0, 1, 0));
    view.setPosition(this.sun.position);
    view.invert();
    const box = new THREE.Box3();
    for (const x of [-hw, hw]) for (const y of [tank.floorBase - 1, tank.surfaceY + 1]) for (const z of [zFar, zNear]) {
      box.expandByPoint(v3(x, y, z).applyMatrix4(view));
    }
    const cam = this.sun.shadow.camera;
    cam.left = box.min.x; cam.right = box.max.x;
    cam.bottom = box.min.y; cam.top = box.max.y;
    cam.near = Math.max(0.1, -box.max.z - 1);
    cam.far = -box.min.z + 1;
    cam.updateProjectionMatrix();
  }

  /** Point the light and beam from the lamp toward `spotTarget`. */
  aim() {
    const dir = unit(this.spotTarget.clone().sub(this.spotPosition));
    this.spot.target.position.copy(this.spotTarget);
    this.beamPivot.quaternion.copy(quatFromTo(v3(0, -1, 0), dir));
  }

  /** A point along the beam at height y, for fish drawn to the light. */
  pointInBeam(y) {
    const dir = unit(this.spotTarget.clone().sub(this.spotPosition));
    const t = (y - this.spotPosition.y) / Math.min(dir.y, -0.05);
    return this.spotPosition.clone().addScaledVector(dir, t);
  }

  /** Caustic and fin-glow multiplier for fish (neither makes sense in the dark). */
  get fishCausticScale() { return Math.round((1 - this.night) / 0.1) * 0.1; }

  update(dt, tank, nightMode) {
    const target = nightMode ? 1 : 0;
    this.night += clamp(target - this.night, -dt * 0.5, dt * 0.5);

    // Aim at the cursor: the point on the cursor's line of sight in the lamp's depth plane.
    if (this.night > 0 && tank.cursor.present) {
      const z = this.spotPosition.z;
      const g = tank.cursorGlassPoint;
      const f = (tank.eyeDistance - z) / tank.eyeDistance;
      const hw = tank.halfWidth(z);
      const goal = v3(clamp(g.x * f, -hw, hw), clamp(g.y * f, this.floorY + 0.2, this.surfaceY - 0.4), z);
      if (goal.distanceTo(this.spotTarget) > 0.002) {
        this.spotTarget.lerp(goal, Math.min(1, dt * 5));
        this.aim();
      }
    }
    if (this.night > 0 && !(this.spotTarget.distanceTo(this.sentTarget) < 0.003)) {
      this.sentTarget.copy(this.spotTarget);
      G.spotT.value.set(this.spotTarget.x, this.spotTarget.y);
    }
    if (this.night === this.lastApplied) return;
    this.lastApplied = this.night;
    this.applyBlend(tank);
  }

  applyBlend(tank) {
    const n = this.night;
    this.sun.intensity = lerp(1500, 60, n) * LIGHT_K;
    this.sun.color.copy(new RGBA(0.85, 0.96, 1.0).mix(new RGBA(0.5, 0.65, 1.0), n).color);
    this.fill.intensity = lerp(450, 15, n) * LIGHT_K;
    this.ambient.intensity = lerp(250, 45, n) * LIGHT_K;
    this.ambient.color.copy(new RGBA(0.25, 0.5, 0.6).mix(new RGBA(0.1, 0.2, 0.4), n).color);
    this.spot.intensity = lerp(0, 3200, n) * LIGHT_K;
    // Toggling shadows recompiles shaders, so only flip them at the ends of the fade.
    if (n <= 0 || n >= 1) {
      this.spot.castShadow = n > 0;
      this.sun.castShadow = n < 1;
    } else {
      this.spot.castShadow = true;
      this.sun.castShadow = true;
    }
    this.beamMaterial.uniforms.beamStrength.value = 0.09 * n;
    this.beamPivot.visible = n > 0;

    const water = DAY_WATER.mix(NIGHT_WATER, n).color;
    tank.scene.fog.color.copy(water);
    tank.scene.background.copy(water);
    tank.scene.environmentIntensity = lerp(0.9, 0.1, n);
    G.causticNight.value = n;
    tank.overlay.setSkyGlow(1 - n * 0.9);
    tank.applyFishCaustics(this.fishCausticScale);
  }
}

// ---------------------------------------------------------------------------------------------
// The cursor in screen points (y up, origin bottom-left), with smoothed velocity
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// 2D layer over the 3D view (Tank.swift Overlay): a soft glow of light from above, reflections on
// the glass, and ripples where the cursor stirs. Plain DOM, blended additively.
// ---------------------------------------------------------------------------------------------

export class Overlay {
  constructor(el) {
    this.el = el;
    el.innerHTML = '';
    Overlay.ringURL ??= Art.ring().toDataURL();
    Overlay.streakURL ??= Art.glassStreak().toDataURL();
    this.sky = document.createElement('div');
    this.sky.className = 'fx-sky';
    el.appendChild(this.sky);
    for (const [x, w, a] of [[0.05, 0.035, 0.06], [0.095, 0.01, 0.045], [0.93, 0.02, 0.035]]) {
      const s = document.createElement('div');
      s.className = 'fx-streak';
      s.style.left = `${(x - w / 2) * 100}%`;
      s.style.width = `${w * 100}%`;
      s.style.opacity = a;
      s.style.backgroundImage = `url(${Overlay.streakURL})`;
      el.appendChild(s);
    }
  }

  setSkyGlow(amount) { this.sky.style.opacity = amount; }

  /** `p` in screen points, y up. */
  ripple(p, scale, height) {
    const ring = document.createElement('img');
    ring.src = Overlay.ringURL;
    ring.className = 'fx-ring';
    ring.style.left = `${p.x - 60}px`;
    ring.style.top = `${height - p.y - 60}px`;
    this.el.appendChild(ring);
    const anim = ring.animate([
      { transform: 'scale(0.15)', opacity: 0.14 },
      { transform: `scale(${scale})`, opacity: 0 },
    ], { duration: 800, easing: 'linear' });
    anim.onfinish = () => ring.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// The tank (Tank.swift). World layout: 1 unit = 100 screen points. The front glass is the plane
// z = 0 and exactly fills the view; the tank extends back to z = -depth. The camera sits in front
// of the glass on +z, so any screen point maps to a point on the glass and a ray into the tank.
// ---------------------------------------------------------------------------------------------

export class Tank {
  constructor(app, screenW, screenH) {
    this.app = app;
    this.screenW = screenW;
    this.screenH = screenH;
    this.width = screenW / 100;
    this.height = screenH / 100;
    this.depth = clamp(this.height * 1.0, 6, 12);
    const fov = 40;
    this.eyeDistance = (this.height / 2) / Math.tan(fov / 2 * Math.PI / 180);
    // No menu bar in a browser.
    this.menuBar = 0;
    this.surfaceY = this.height / 2 - this.menuBar * 0.3;
    this.floorBase = -this.height / 2 + 0.3;

    this.fish = [];
    this.shark = null;
    this.respawns = [];
    this.food = [];
    this.obstacles = [];
    this.anemoneTop = null;
    this.schoolGoals = {};
    this.cursor = new Cursor();
    this.clock = 0;
    this.rippleTimer = 0;
    this.shafts = [];
    this.tweens = [];
    this.textures = [];
    this.cameraAngles = new THREE.Vector2();
    this.cameraTurn = new THREE.Quaternion();
    this.cameraTurnInverse = new THREE.Quaternion();

    this.overlay = new Overlay(app.fxEl);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(fov, screenW / screenH, 0.5, this.eyeDistance + this.depth + 30);
    this.camera.position.set(0, 0, this.eyeDistance);
    this.scene.add(this.camera);

    // Water: backdrop exactly the fog colour so distant sand dissolves seamlessly, and a matching
    // environment for reflections. The haze only turns opaque well behind the tank, leaving room
    // for the shark to lurk as a fading shape.
    this.scene.background = DAY_WATER.color;
    this.scene.fog = new THREE.Fog(this.scene.background.clone(), this.eyeDistance + 1, this.eyeDistance + this.depth + 14);
    this.scene.environment = app.environment;

    this.lighting = new Lighting(this, app.settings.nightMode);
    G.eyeDist.value = this.eyeDistance;

    // Scenery first: the sand bakes its contact shadows from what's standing on it.
    const occluders = this.buildScenery();
    this.buildSand(occluders);
    this.buildShafts();
    this.buildParticles();
    this.populate();
    this.lighting.update(0, this, app.settings.nightMode);
  }

  // MARK: - Geometry helpers

  floorHeight(x, z) {
    // Gentle dunes, sloping up toward the back like a real aquascape.
    return this.floorBase + 0.12 * Math.sin(x * 0.45 + 0.7) + 0.08 * Math.sin(x * 1.1 + z * 0.6 + 2.1)
      + 0.06 * Math.sin(z * 0.9 + x * 0.2) - z * 0.07;
  }

  /** Half the visible width of the tank at depth z (the view frustum widens toward the back). */
  halfWidth(z) { return this.width / 2 * (this.eyeDistance - z) / this.eyeDistance; }
  halfHeight(z) { return this.height / 2 * (this.eyeDistance - z) / this.eyeDistance; }
  /** How far in front of the screen plane (toward the camera) fish may swim. */
  get frontZ() { return this.eyeDistance * 0.35; }

  /** Where a fish may be at depth p.z: inside the tank and inside what the camera can see there. */
  bounds(p, bodyLength) {
    const hw = this.halfWidth(p.z) - bodyLength * 0.6;
    const hh = this.halfHeight(p.z);
    return {
      minX: -hw, maxX: hw,
      minY: Math.max(this.floorHeight(p.x, p.z) + 0.25, -hh + 0.2) + bodyLength * 0.4,
      maxY: Math.min(this.surfaceY, hh * 0.91) - 0.45 - bodyLength * 0.3,
      minZ: -this.depth + 0.6, maxZ: this.frontZ - bodyLength * 0.3,
    };
  }

  randomPoint(band, near = null) {
    const z = rnd(-this.depth + 0.8, this.frontZ - 0.8);
    const hw = this.halfWidth(z) - 0.8;
    let x = rnd(-hw, hw);
    if (near) x = clamp(near.x + rnd(-6.5, 6.5), -hw, hw);
    const hh = this.halfHeight(z);
    const lo = Math.max(this.floorHeight(x, z) + 0.5, -hh + 0.6);
    const hi = Math.min(this.surfaceY, hh * 0.91) - 0.9;
    return v3(x, lo + (hi - lo) * rnd(band[0], band[1]), z);
  }

  /** Screen position (points, y up) of a world point, through the camera as it's currently turned. */
  project(p) {
    const q = p.clone().sub(v3(0, 0, this.eyeDistance)).applyQuaternion(this.cameraTurnInverse);
    const f = this.eyeDistance / Math.max(-q.z, 0.01);
    return { x: this.screenW / 2 + q.x * f * 100, y: this.screenH / 2 + q.y * f * 100 };
  }

  screenDistance(p, s) {
    const q = this.project(p);
    return Math.hypot(q.x - s.x, q.y - s.y);
  }

  /** Where the cursor touches the front glass. */
  get cursorGlassPoint() { return this.glassPoint(this.cursor.screen); }

  /** Where the line of sight through a screen point meets the front glass (z = 0), using the
   *  camera's actual rotation so everything aimed along the cursor ray stays under the cursor. */
  glassPoint(s) {
    const dir = v3((s.x - this.screenW / 2) / 100, (s.y - this.screenH / 2) / 100, -this.eyeDistance).applyQuaternion(this.cameraTurn);
    return v3(0, 0, this.eyeDistance).addScaledVector(dir, this.eyeDistance / Math.max(-dir.z, 0.01));
  }

  closestPointOnCursorRay(p) {
    const eye = v3(0, 0, this.eyeDistance);
    const dir = unit(this.cursorGlassPoint.sub(eye));
    return eye.clone().addScaledVector(dir, p.clone().sub(eye).dot(dir));
  }

  // MARK: - Setup

  buildSand(occluders) {
    // Extends well past the fog distance so its far edge dissolves into the water.
    const backZ = -this.depth - 26, frontZ = 2;
    const hw = this.halfWidth(backZ) + 2;
    const nx = 120, nz = 70;
    // Contact shadows are baked into a map covering the part of the floor with things on it.
    const aoFarZ = -this.depth - 13, aoNearZ = 1;
    const aoMaxX = this.halfWidth(aoFarZ) + 0.5, aoMinX = -aoMaxX;
    const ao = Occlusion.floorMap(aoMinX, aoMaxX, aoNearZ, aoFarZ, 2048, (x, z) => this.floorHeight(x, z), occluders);
    const m = new Mesh();
    for (let j = 0; j <= nz; j++) {
      const z = frontZ + (backZ - frontZ) * j / nz;
      for (let i = 0; i <= nx; i++) {
        const x = -hw + 2 * hw * i / nx;
        m.p.push(x, this.floorHeight(x, z), z);
        m.uv.push(x / 2.5, z / 2.5);
        m.uv2.push((x - aoMinX) / (aoMaxX - aoMinX), (z - aoNearZ) / (aoFarZ - aoNearZ));
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        // Rows run toward -z, so this winding faces up.
        m.triangle(a, b, c);
        m.triangle(b, d, c);
      }
    }
    m.computeNormals();
    const sandTex = Art.texture(Art.sand(), { repeat: true });
    this.textures.push(sandTex, ao);
    const mat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95, metalness: 0, normalMap: Detail.sand() });
    mat.normalScale.set(0.9, -0.9);
    patchMaterial(mat, {
      key: 'sand',
      uniforms: { ...causticUniforms(), uFloorAO: { value: ao } },
      vHead: 'attribute vec2 aUV2;\nvarying vec2 vAO;\n',
      vMain: 'vAO = aUV2;',
      fHead: CAUSTICS_HEAD + 'uniform sampler2D uFloorAO;\nvarying vec2 vAO;\n',
      fAfterEmissive: CAUSTICS_APPLY('0.55'),
      fBeforeOpaque: 'outgoingLight *= texture2D(uFloorAO, vAO).r;',
    });
    const node = new THREE.Mesh(m.geometry(), mat);
    node.receiveShadow = true;
    this.scene.add(node);
  }

  /** Builds the reef and plants; returns spheres approximating them for the sand's contact shadows. */
  buildScenery() {
    const reef = new CoralReef();
    const plants = new PlantBed();
    const D = this.depth;
    const floorAt = (x, z) => v3(x, this.floorHeight(x, z), z);
    const T = ReefTone, P = PlantTone;
    const obstacle = (center, radius) => this.obstacles.push({ center: center.clone(), radius });

    // Reef mounds: piles of live rock crowned with coral, with sea fans behind. One sits far
    // back, the other in the middle distance off to the side, so the reef has depth.
    const moundSides = coin() ? [-1, 1] : [1, -1];
    moundSides.forEach((side, i) => {
      const z = i === 0 ? -D * rnd(0.75, 0.88) : -D * rnd(0.38, 0.5);
      const cx = side * this.halfWidth(z) * (i === 0 ? rnd(0.25, 0.45) : rnd(0.45, 0.65));
      const scale = i === 0 ? rnd(1.0, 1.35) : rnd(0.75, 0.95);
      let top = this.floorHeight(cx, z);
      for (let k = randInt(5, 7); k > 0; k--) {
        const ox = rnd(-1.2, 1.2) * scale, oz = rnd(-0.6, 0.6) * scale;
        const size = v3(rnd(0.6, 1.1), rnd(0.5, 0.85), rnd(0.5, 0.9)).multiplyScalar(scale);
        // Rocks near the middle sit higher, so the pile rises to a peak.
        const lift = size.y * (0.25 + 0.5 * Math.max(0, 1 - Math.abs(ox) / (1.2 * scale)));
        const c = floorAt(cx + ox, z + oz).add(v3(0, lift, 0));
        reef.addRock(c, size, coin() ? T.rock : T.rockPurple);
        if (Math.abs(ox) < 0.7 * scale) top = Math.max(top, c.y + size.y * 0.75);
        obstacle(c, Math.max(size.x, size.z) * 0.95);
        this.encrust(reef, c, size);
      }
      const peak = v3(cx, top - 0.15, z);
      if (i === 0) reef.addBranching(peak, rnd(1.4, 1.9), pick([T.purple, T.teal, T.pink]));
      else reef.addTable(peak, rnd(0.7, 0.95), pick([T.tan, T.teal]));
      obstacle(peak.clone().add(v3(0, 0.5, 0)), 0.8);
      reef.addBrain(floorAt(cx - side * 1.3 * scale, z + 0.9).add(v3(0, -0.03, 0)), rnd(0.4, 0.55), pick([T.tan, T.orange, T.bone]));
      plants.addSeaFan(floorAt(cx + rnd(-0.6, 0.6), z - 0.9), rnd(1.8, 2.6), rnd(-0.35, 0.35), i === 0 ? P.fanPurple : P.fanRed);
      // An Anubias-like rosette of dark leaves tucked at the mound's foot.
      plants.addSword(floorAt(cx + side * 1.4 * scale, z + 0.7), 0.45, 7, 0.2, P.darkGreen);
    });

    // Coral gardens: small mixed patches across the middle of the floor.
    for (let k = Math.max(6, Math.floor(this.width / 2.5)); k > 0; k--) {
      const z = -D * rnd(0.1, 0.7);
      const c = floorAt(this.halfWidth(z) * rnd(-0.85, 0.85), z);
      for (let n = randInt(2, 4); n > 0; n--) {
        const p = floorAt(c.x + rnd(-0.5, 0.5), c.z + rnd(-0.4, 0.4)).add(v3(0, -0.03, 0));
        this.addSmallCoral(reef, p, rnd(0.8, 1.2));
      }
    }

    // Larger corals dotted across the middle of the floor.
    for (let k = 0; k < 2; k++) {
      const z = -D * rnd(0.2, 0.65);
      const x = (k === 0 ? -1 : 1) * this.halfWidth(z) * rnd(0.1, 0.35);
      const c = floorAt(x, z);
      reef.addBrain(c.clone().add(v3(0, -0.03, 0)), rnd(0.3, 0.45), pick([T.teal, T.tan, T.orange]));
      obstacle(c, 0.45);
    }
    for (let k = 0; k < 4; k++) {
      const z = -D * rnd(0.15, 0.7);
      const x = this.halfWidth(z) * rnd(-0.75, 0.75);
      reef.addBranching(floorAt(x, z).add(v3(0, -0.05, 0)), rnd(0.55, 0.85), pick([T.pink, T.orange, T.purple, T.red]));
    }

    // A sea anemone near the front, which the clownfish call home.
    const az = -rnd(1.0, 1.8);
    const ax = (coin() ? -1 : 1) * this.halfWidth(az) * rnd(0.25, 0.45);
    const anemoneBase = floorAt(ax, az).add(v3(0, -0.03, 0));
    plants.addAnemone(anemoneBase, 0.32);
    reef.addRock(anemoneBase.clone().add(v3(0, -0.05, 0)), v3(0.4, 0.2, 0.35), T.rock);
    this.anemoneTop = anemoneBase.clone().add(v3(0, 0.45, 0));

    // Scattered stones and pebbles.
    for (let k = 0; k < 9; k++) {
      const z = rnd(-D + 0.5, 0.3);
      const x = this.halfWidth(z) * rnd(-0.9, 0.9);
      const r = rnd(0.15, 0.4);
      reef.addRock(floorAt(x, z).add(v3(0, r * 0.15, 0)), v3(r * rnd(1, 1.5), r * rnd(0.5, 0.8), r), T.rock);
    }
    for (let k = 0; k < 100; k++) {
      const z = 0.5 - (D + 0.5) * Math.pow(rnd(0, 1), 1.3);
      const x = this.halfWidth(z) * rnd(-0.95, 0.95);
      reef.addPebble(floorAt(x, z), rnd(0.025, 0.07), pick([T.rock, T.rockPurple, T.bone, T.tan]));
    }

    // Foreground: tall plants close to the camera in both corners, rising from below the frame,
    // and a rock outcrop at one bottom corner.
    const bladeSide = coin() ? -1 : 1;
    for (const side of [-1, 1]) {
      const z = rnd(0.4, 1.2);
      const x = side * this.halfWidth(z) * rnd(0.78, 0.92);
      if (side === bladeSide) {
        for (let k = 0; k < 8; k++) {
          const p = floorAt(x + rnd(-0.45, 0.45), z + rnd(-0.35, 0.35));
          plants.addBlade(p, rnd(0.5, 1.0) * Math.min(this.height * 0.6, 5.5), rnd(0.18, 0.32), pick([P.green, P.brightGreen, P.olive]));
        }
      } else {
        const tone = coin() ? P.rotala : P.red;
        for (let k = 0; k < 7; k++) {
          plants.addStem(floorAt(x + rnd(-0.45, 0.45), z + rnd(-0.35, 0.35)), rnd(0.6, 1.0) * Math.min(this.height * 0.55, 5), tone);
        }
      }
    }
    {
      const z = rnd(0.2, 0.7);
      const x = -bladeSide * this.halfWidth(z) * rnd(0.45, 0.6);
      for (let k = 0; k < 3; k++) {
        const size = v3(rnd(0.7, 1.1), rnd(0.5, 0.75), rnd(0.6, 0.9));
        const c = floorAt(x + rnd(-0.8, 0.8), z + rnd(-0.4, 0.4)).add(v3(0, size.y * 0.3, 0));
        reef.addRock(c, size, coin() ? T.rock : T.rockPurple);
        obstacle(c, Math.max(size.x, size.z) * 0.95);
        this.encrust(reef, c, size);
      }
      plants.addSword(floorAt(x + rnd(0.9, 1.3) * bladeSide, z - 0.3), rnd(0.8, 1.1), randInt(9, 12), rnd(0.16, 0.22), P.brightGreen);
    }

    // Plant clusters filling the background.
    for (let k = 0; k < Math.max(6, Math.floor(this.width / 2.5)); k++) {
      const z = -D * rnd(0.55, 0.97);
      const x = this.halfWidth(z) * rnd(-0.95, 0.95);
      if (k % 2 === 0) {
        for (let n = randInt(4, 7); n > 0; n--) {
          const p = floorAt(x + rnd(-0.4, 0.4), z + rnd(-0.4, 0.4));
          plants.addBlade(p, rnd(0.4, 1.0) * Math.min(this.height * 0.5, 4.5), rnd(0.14, 0.26), pick([P.green, P.darkGreen, P.olive, P.maroon]));
        }
      } else {
        const tone = pick([P.lime, P.brightGreen, P.rotala]);
        for (let n = randInt(4, 6); n > 0; n--) {
          plants.addStem(floorAt(x + rnd(-0.35, 0.35), z + rnd(-0.35, 0.35)), rnd(0.5, 1.0) * Math.min(this.height * 0.45, 4), tone);
        }
      }
    }
    for (const side of [-1, 1]) {
      const z = -D * rnd(0.2, 0.45);
      plants.addSword(floorAt(side * this.halfWidth(z) * rnd(0.6, 0.8), z), rnd(0.9, 1.3), randInt(10, 14), rnd(0.16, 0.22),
        pick([P.green, P.brightGreen]));
    }

    this.buildFarBackground(reef, plants);

    reef.finish((x, z) => this.floorHeight(x, z));
    this.scene.add(reef.node);
    this.textures.push(reef.material.map);
    plants.finish();
    this.scene.add(plants.node);
    this.textures.push(plants.material.map);
    this.plantBed = plants;
    return [...reef.occluders, ...plants.occluders];
  }

  /** Reef, rocks and plants continuing from the back of the fish zone deep into the haze, on a
   *  jittered grid. Pieces get larger with distance so they still read as shapes through the fog. */
  buildFarBackground(reef, plants) {
    const floorAt = (x, z) => v3(x, this.floorHeight(x, z), z);
    const T = ReefTone, P = PlantTone;
    const D = this.depth;
    const bands = [[-D * 0.92, -D - 3], [-D - 3, -D - 7], [-D - 7, -D - 12]];
    bands.forEach(([near, far], bandIndex) => {
      const zMid = (near + far) / 2;
      const hw = this.halfWidth(zMid) * 0.97;
      const spacing = 3.2 + bandIndex * 0.8;
      const columns = Math.max(3, Math.floor(2 * hw / spacing));
      const grow = 1 + bandIndex * 0.35;
      for (let c = 0; c < columns; c++) {
        const x = -hw + 2 * hw * (c + rnd(0.2, 0.8)) / columns;
        const z = rnd(far, near);
        const roll = rnd(0, 1);
        if (roll < 0.45) {
          // Rock outcrop crowned with coral.
          let top = this.floorHeight(x, z);
          for (let k = randInt(2, 4); k > 0; k--) {
            const size = v3(rnd(0.7, 1.3), rnd(0.5, 0.9), rnd(0.6, 1.1)).multiplyScalar(grow);
            const cc = floorAt(x + rnd(-1, 1) * grow, z + rnd(-0.7, 0.7) * grow).add(v3(0, size.y * 0.3, 0));
            reef.addRock(cc, size, coin() ? T.rock : T.rockPurple);
            top = Math.max(top, cc.y + size.y * 0.7);
            this.obstacles.push({ center: cc, radius: Math.max(size.x, size.z) * 0.95 });
          }
          const crown = v3(x, top - 0.15, z);
          switch (randInt(0, 2)) {
            case 0: reef.addBranching(crown, rnd(1.1, 1.8) * grow, pick([T.purple, T.teal, T.pink, T.orange])); break;
            case 1: reef.addTable(crown, rnd(0.6, 0.9) * grow, pick([T.tan, T.teal, T.bone])); break;
            default: reef.addBrain(crown.clone().add(v3(0, -0.1, 0)), rnd(0.4, 0.6) * grow, pick([T.tan, T.orange, T.bone]));
          }
        } else if (roll < 0.7) {
          // Tall seaweed.
          for (let k = randInt(4, 7); k > 0; k--) {
            plants.addBlade(floorAt(x + rnd(-0.6, 0.6), z + rnd(-0.5, 0.5)), rnd(0.5, 1.0) * Math.min(this.height * 0.55, 5.5) * grow,
              rnd(0.18, 0.32) * grow, pick([P.green, P.darkGreen, P.olive, P.maroon]));
          }
        } else if (roll < 0.82) {
          // Stem plants.
          const tone = pick([P.lime, P.brightGreen, P.rotala, P.red]);
          for (let k = randInt(3, 5); k > 0; k--) {
            plants.addStem(floorAt(x + rnd(-0.5, 0.5), z + rnd(-0.5, 0.5)), rnd(0.6, 1.0) * Math.min(this.height * 0.45, 4) * grow, tone);
          }
        } else if (roll < 0.92) {
          plants.addSeaFan(floorAt(x, z), rnd(1.8, 2.8) * grow, rnd(-0.4, 0.4), coin() ? P.fanPurple : P.fanRed);
        } else {
          reef.addBrain(floorAt(x, z).add(v3(0, -0.05, 0)), rnd(0.5, 0.8) * grow, pick([T.tan, T.teal, T.orange]));
        }
      }
    });
  }

  /** Grow a few small corals over the upper surface of a rock. */
  encrust(reef, c, size) {
    for (let k = randInt(4, 6); k > 0; k--) {
      const a = rnd(0, TAU), up = rnd(0.35, 1.0);
      const dir = v3(Math.cos(a) * (1 - up * 0.7), up, Math.sin(a) * (1 - up * 0.7)).normalize();
      const p = c.clone().add(dir.multiply(size).multiplyScalar(0.95));
      this.addSmallCoral(reef, p, rnd(0.8, 1.4));
    }
  }

  addSmallCoral(reef, p, s) {
    const T = ReefTone;
    switch (randInt(0, 4)) {
      case 0: reef.addBrain(p, 0.22 * s, pick([T.tan, T.teal, T.orange, T.bone, T.green])); break;
      case 1: reef.addBranching(p, 0.5 * s, pick([T.pink, T.purple, T.orange, T.red])); break;
      case 2: reef.addFingers(p, 0.45 * s, pick([T.bone, T.tan, T.orange, T.pink])); break;
      default: reef.addPolyps(p, 0.2 * s, pick([T.green, T.orange, T.teal, T.pink]));
    }
  }

  buildShafts() {
    const tex = Art.texture(Art.lightShaft(), { mipmaps: false });
    tex.flipY = true;
    this.textures.push(tex);
    for (let k = Math.max(5, Math.floor(this.width / 2.5)); k > 0; k--) {
      const z = rnd(-this.depth + 0.5, -1.0);
      // Start above the top of the view at this depth, so shafts come in from off-screen.
      const top = (this.height / 2) * (this.eyeDistance - z) / this.eyeDistance + 1.5;
      const h = rnd(this.height * 0.7, this.height * 1.2);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      });
      const node = new THREE.Mesh(new THREE.PlaneGeometry(rnd(0.6, 1.8), h), mat);
      const x = rnd(-this.halfWidth(z), this.halfWidth(z));
      node.position.set(x, top - h / 2, z);
      // Billboard about the vertical axis, facing the camera.
      node.rotation.y = Math.atan2(-x, this.eyeDistance - z);
      this.scene.add(node);
      this.shafts.push({ node, phase: rnd(0, TAU) });
    }
  }

  buildParticles() {
    // Drifting specks ("marine snow") throughout the water.
    const count = Math.round(this.width * this.height * this.depth);
    const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4), motion = new Float32Array(count * 4), birth = new Float32Array(count);
    const bw = this.width * 1.6, bh = this.height, bd = this.depth;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rnd(-bw / 2, bw / 2);
      pos[i * 3 + 1] = rnd(-bh / 2, bh / 2);
      pos[i * 3 + 2] = rnd(-bd / 2, bd / 2);
      seed[i * 4 + 3] = 0.018 + rnd(-0.012, 0.012);
      const dir = v3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(0.04 + rnd(-0.04, 0.04));
      const life = 30 + rnd(-10, 10);
      motion.set([dir.x, dir.y, dir.z, life], i * 4);
      birth[i] = rnd(0, life);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('aMotion', new THREE.BufferAttribute(motion, 4));
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    this.snowMaterial = snowMaterial();
    this.snowMaterial.uniforms.fogNear.value = this.scene.fog.near;
    this.snowMaterial.uniforms.fogFar.value = this.scene.fog.far;
    const points = new THREE.Points(g, this.snowMaterial);
    points.position.set(0, 0, -this.depth / 2);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  populate() {
    // Scaled by screen area, plus a bit more for the deep tank.
    const areaFactor = clamp(this.screenW * this.screenH / (1512 * 982), 0.5, 2.5) * 1.3;
    for (const sp of Species.all) {
      const count = Math.max(1, Math.round(sp.population * areaFactor));
      for (let i = 0; i < count; i++) this.addFish(sp);
    }
  }

  // MARK: - Public actions

  addFish(sp, position = null) {
    const f = new Fish(sp, position ?? this.randomPoint(sp.band));
    f.setCausticScale(this.lighting.fishCausticScale);
    this.fish.push(f);
    this.scene.add(f.node);
    return f;
  }

  removeFish() {
    if (!this.fish.length) return;
    const f = this.fish.splice(randInt(0, this.fish.length - 1), 1)[0];
    this.tween(0.6, (k) => setObjectOpacity(f.node, 1 - k), () => this.discard(f.node));
  }

  /** Drop flakes of food where the click ray meets a plane a little behind the glass. */
  dropFood(p, count = 6) {
    const g = this.glassPoint(p);
    const eye = v3(0, 0, this.eyeDistance);
    const z = -1.4;
    const hit = eye.clone().add(g.sub(eye).multiplyScalar((this.eyeDistance - z) / this.eyeDistance));
    const start = v3(hit.x, Math.min(hit.y, this.surfaceY - 0.2), z);
    for (let i = 0; i < count; i++) {
      const f = new Food(start.clone().add(v3(rnd(-0.25, 0.25), rnd(-0.1, 0.1), rnd(-0.3, 0.3))));
      this.food.push(f);
      this.scene.add(f.node);
    }
    this.overlay.ripple(p, 0.6, this.screenH);
  }

  dropFoodRandomly() {
    for (let i = 0; i < 3; i++) {
      this.dropFood({ x: rnd(this.screenW * 0.15, this.screenW * 0.85), y: this.screenH * 0.8 }, 5);
    }
  }

  // MARK: - Helpers used by fish

  nearestFood(p, maxDist) {
    let best = null, bestD = maxDist;
    for (const f of this.food) {
      if (f.eaten) continue;
      const d = p.distanceTo(f.pos);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  eat(f) { f.eaten = true; }

  /** The shark caught a fish: it vanishes, and a replacement swims in from the back later. */
  eaten(f) {
    this.fish = this.fish.filter((o) => o !== f);
    const s0 = f.node.scale.x;
    this.tween(0.15, (k) => {
      f.node.scale.setScalar(lerp(s0, 0.05, k));
      setObjectOpacity(f.node, 1 - k);
    }, () => this.discard(f.node));
    this.respawns.push({ species: f.species, at: this.clock + rnd(45, 90) });
    this.respawns.sort((a, b) => a.at - b.at);
  }

  /** Add or remove the shark to match the setting. */
  syncShark(wanted) {
    if (wanted && !this.shark) {
      const s = new Shark(this);
      s.body.setCausticScale(this.lighting.fishCausticScale);
      this.scene.add(s.body.node);
      setObjectOpacity(s.body.node, 0);
      this.tween(2, (k) => setObjectOpacity(s.body.node, k));
      this.shark = s;
    } else if (!wanted && this.shark) {
      const node = this.shark.body.node;
      const s = this.shark;
      this.shark = null;
      // Keep it swimming off while it fades.
      this.fading = s;
      this.tween(1.5, (k) => setObjectOpacity(node, 1 - k), () => { this.discard(node); if (this.fading === s) this.fading = null; });
    }
  }

  applyFishCaustics(scale) {
    G.fishCaustic.value = 0.35 * scale;
    for (const f of this.fish) f.setCausticScale(scale);
    if (this.shark) this.shark.body.setCausticScale(scale);
  }

  /** At night, fish are drawn to the spotlight: often returns a point in its beam instead. */
  wanderPoint(band, p) {
    if (!(this.lighting.night > 0.5 && Math.random() < 0.65)) return this.randomPoint(band, p);
    const lo = this.floorBase + 0.6, hi = this.surfaceY - 0.9;
    const axis = this.lighting.pointInBeam(lo + (hi - lo) * rnd(band[0], band[1]));
    const z = clamp(axis.z + rnd(-1.5, 1.5), -this.depth + 0.8, this.frontZ - 0.8);
    const x = clamp(axis.x + rnd(-0.8, 0.8), -this.halfWidth(z) + 0.8, this.halfWidth(z) - 0.8);
    return v3(x, Math.max(axis.y, this.floorHeight(x, z) + 0.5), z);
  }

  schoolGoal(sp) { return this.schoolGoals[sp.id]?.point ?? null; }

  tween(duration, fn, done = null) {
    this.tweens.push({ t: 0, duration, fn, done });
  }

  discard(node) {
    this.scene.remove(node);
    Tank.disposeObject(node);
  }

  // MARK: - Frame loop

  /** The (wrapped) time the next frame will be rendered at. */
  get renderTime() { return this.clock % TIME_WRAP; }

  /** When the cursor nears an edge of the screen, the camera slowly pans or tilts a few degrees
   *  toward it, and drifts back to centre when it leaves. */
  updateCamera(dt) {
    const maxYaw = 3.5 * Math.PI / 180, maxPitch = 2 * Math.PI / 180;
    const target = new THREE.Vector2();
    const c = this.cursor;
    if (c.present) {
      const w = this.screenW, h = this.screenH;
      const menuBar = this.menuBar * 100;
      const x = c.screen.x, y = c.screen.y;
      const zoneX = w * 0.12, zoneY = h * 0.12;
      const right = smoothstep(w - zoneX, w, x) - smoothstep(zoneX, 0, x);
      const up = smoothstep(h - menuBar - zoneY, h - menuBar, y) * (y < h - menuBar ? 1 : 0) - smoothstep(zoneY, 0, y);
      // Turning right is a negative yaw; tilting up a positive pitch.
      target.set(-right * maxYaw, up * maxPitch);
    }
    const before = this.cameraAngles.clone();
    // Slow and smooth: a camera operator easing over, not a snap.
    this.cameraAngles.add(target.sub(this.cameraAngles).multiplyScalar(Math.min(1, dt * 1.2)));
    if (before.distanceTo(this.cameraAngles) <= 1e-6) return;
    this.cameraTurn = quatAxis(this.cameraAngles.x, 0, 1, 0).multiply(quatAxis(this.cameraAngles.y, 1, 0, 0));
    this.cameraTurnInverse = this.cameraTurn.clone().invert();
    this.camera.quaternion.copy(this.cameraTurn);
  }

  step(dt, pointer, settings) {
    this.clock += dt;
    G.uTime.value = this.renderTime;

    this.cursor.update(pointer, pointer.inside, dt);
    this.updateCamera(dt);

    if (this.cursor.present && this.cursor.speed > 900) {
      this.rippleTimer -= dt;
      if (this.rippleTimer <= 0) {
        this.rippleTimer = 0.07;
        this.overlay.ripple(this.cursor.screen, 0.45, this.screenH);
      }
    }

    this.updateSchools(dt);
    this.syncShark(settings.shark);
    if (this.shark) this.shark.update(dt, this);
    if (this.fading) this.fading.update(dt, this);
    for (const f of this.fish) f.update(dt, this);
    // Replacements for eaten fish arrive from the back of the tank.
    while (this.respawns.length && this.respawns[0].at <= this.clock) {
      const next = this.respawns.shift();
      const z = -this.depth + 1;
      const f = this.addFish(next.species, v3(rnd(-this.halfWidth(z) * 0.6, this.halfWidth(z) * 0.6), 0, z));
      setObjectOpacity(f.node, 0);
      this.tween(2, (k) => setObjectOpacity(f.node, k));
    }
    this.plantBed.update(dt, this);

    this.food = this.food.filter((f) => {
      const alive = f.update(dt, this.floorHeight(f.pos.x, f.pos.z) + 0.02);
      if (!alive) { this.scene.remove(f.node); f.node.material.dispose(); }
      return alive;
    });

    for (const { node, phase } of this.shafts) {
      node.material.opacity = (0.07 + 0.06 * Math.sin(this.clock * 0.25 + phase)) * (1 - this.lighting.night);
      node.visible = node.material.opacity > 0.001;
    }
    this.lighting.update(dt, this, settings.nightMode);

    this.tweens = this.tweens.filter((tw) => {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.duration);
      tw.fn(k);
      if (k >= 1) { tw.done?.(); return false; }
      return true;
    });
  }

  updateSchools(dt) {
    for (const sp of Species.all) {
      if (!sp.schooling) continue;
      const members = this.fish.filter((f) => f.species.id === sp.id);
      if (!members.length) { delete this.schoolGoals[sp.id]; continue; }
      const centre = members.reduce((a, f) => a.add(f.pos), v3()).divideScalar(members.length);
      let g = this.schoolGoals[sp.id] ?? { point: centre, timer: 0 };
      g.timer -= dt;
      if (g.timer <= 0 || centre.distanceTo(g.point) < 0.9) g = { point: this.wanderPoint(sp.band, centre), timer: rnd(6, 14) };
      this.schoolGoals[sp.id] = g;
    }
  }

  dispose() {
    Tank.disposeObject(this.scene);
    for (const t of this.textures) t.dispose();
  }

  /** Free GPU resources of an object tree, except the shared per-species fish models. */
  static disposeObject(root) {
    root.traverse((o) => {
      if (o.geometry && !sharedGeometry.has(o.geometry)) o.geometry.dispose();
      if (o.material && !o.material.userData.shared) o.material.dispose();
      if (o.customDepthMaterial) o.customDepthMaterial.dispose();
    });
  }
}
