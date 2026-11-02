// Hangar — Scene: greybox of the traced level. Later tasks replace materials, lights and the camera path, keeping the contract
// app.js relies on: constructor(app, renderer, w, h, settings, seed), step, click, render, resize, dispose.

import * as THREE from 'three';
import { loadLevel } from './level.js';
import { buildLevelMesh } from './levelmesh.js';
import { planMaterials, planUvJitter, jitterUv } from './materialplan.js';
import { makeMaterial, pomUniforms, envVariant } from './materials.js';
import { buildNavGraph } from './navgraph.js';
import { makeRng } from './rng.js';
import { makeTour } from './tour.js';
import { annotateFixtures, planLights } from './lightplan.js';
import { LightRig } from './lights.js';
import { Walker, resolveClickTarget } from './walker.js';
import { sectorAt } from './level.js';
import { Slime, SLIME_LAYER } from './slime.js';
import { bakeProbes } from './probes.js';
import { Walkway, BAR_LAYER } from './grate.js';
import { buildWetPatches } from './wet.js';
import { planWetPatches, slimeSkirts } from './wetplan.js';

// The cursor "comes to rest after moving": it travelled more than REST_MOVE px within the last
// second, then stayed within REST_STILL px for REST_HOLD s. A cursor that just sits does nothing.
const REST_MOVE = 30, REST_STILL = 4, REST_HOLD = 0.8;

// Greybox stand-ins, worn until each scanned material arrives (and kept if one never does).
const GREYS = {
  steel: 0x8d96a0, 'steel-brushed': 0x9aa2aa, concrete: 0x777777, 'concrete-cracked': 0x737373, 'concrete-stained': 0x6e6c68,
  'concrete-painted': 0x8a8a86, computer: 0x5d7a8a, 'panel-brown': 0x8a6a4e, grate: 0x4a4a4a, regolith: 0xa0907a,
};

export class Scene {
  constructor(app, renderer, w, h, settings, seed) {
    this.app = app;
    this.renderer = renderer;
    this.seed = seed;
    this.settings = settings;
    this.screenW = w;
    this.screenH = h;
    this.time = 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1018);
    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    // Light comes from the fixtures (lights.js) plus a low ambient there; reflections from the room probes
    // (probes.js), baked on the first render. There is no scene.environment: before the probes exist nothing
    // is drawn but the background, and the old neutral-room stand-in is gone.
    this.camera.layers.enable(SLIME_LAYER);
    this.camera.layers.enable(BAR_LAYER);
    this.probes = null;
    this.probeEmergency = null; // the Emergency Power level the probes were last baked at
    this.probeRebakeAt = null; // scene time at which to re-bake after materials arrived
    this.envVariants = new Map(); // base material uuid|version|probe uuid -> variant (scene-owned)
    // Shadow maps render once per frame (render() raises needsUpdate), not on every render() call.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this.rig = null;
    // Emergency Power eases over 1.5 s; a page opened with it on starts there.
    this.emergency = settings?.emergency ? 1 : 0;
    this.camDir = new THREE.Vector3();
    this.debugLamp = null;
    this.level = null;
    this.walker = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.pendingClick = null;
    this.trail = []; // recent pointer samples [t, x, y] over the last second
    this.rest = { x: 0, y: 0, t: 0, armed: false };
    this.input = { gaze: null, restedAt: null, click: null };
    this.ready = fetch('./data/e1m1.json').then((r) => {
      if (!r.ok) throw new Error(`level data ${r.url} returned HTTP ${r.status}`);
      return r.json();
    }).then((json) => this.build(json));
  }

  build(json) {
    const level = (this.level = loadLevel(json));
    const rng = makeRng(this.seed);
    // Which variant each sector's floor, walls and ceiling wear this seed (rooms differ, a room is uniform).
    this.plan = planMaterials(level, rng.fork('materials'));
    const mats = new Map();
    for (const [name, color] of Object.entries(GREYS)) mats.set(name, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.FrontSide }));
    mats.set('window', new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.18, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    const keyOf = (sector, mat, surface) => this.plan.get(sector)?.[surface] ?? mat;
    // The walkway is a bridge of open grating: the solid lower walls under it go, and every slime pool gets a
    // skirt below its rim (its floor is hidden: the slime surface sits SLIME_DROP lower).
    const walkway = (id) => level.byId.get(id)?.tags.has('walkway');
    const slime = (id) => level.byId.get(id)?.tags.has('slime');
    this.mesh = buildLevelMesh(level, mats, undefined, keyOf, {
      skipWall: (q) => q.kind === 'lower' && walkway(q.back) && slime(q.sector),
      extraQuads: slimeSkirts(level),
    });
    // Anti-tiling, part 1: each room's floor, walls and ceiling start the scan at their own offset (and floors
    // and ceilings at their own quarter turn), so the repeat never lines up from surface to surface. Part 2,
    // a world-space grime field over albedo and roughness, is in materials.js.
    const jitter = planUvJitter(level, rng.fork('uvs'));
    for (const m of this.mesh.group.children) {
      const j = jitter.get(m.userData.sector)?.[m.userData.surface];
      if (!j || m.userData.mat === 'window') continue;
      const uv = m.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) { const [a, b] = jitterUv(uv.getX(i), uv.getY(i), j); uv.setXY(i, a, b); }
      uv.needsUpdate = true;
    }
    for (const m of this.mesh.group.children) {
      m.receiveShadow = true;
      m.castShadow = m.userData.mat !== 'window';
    }
    this.scene.add(this.mesh.group);

    // Slime, the walkway's real grating and railings, wet floors.
    this.slime = new Slime(level, this.renderer, this.scene);
    this.walkway = new Walkway(level);
    this.scene.add(this.walkway.group);
    for (const m of this.mesh.group.children) {
      if (m.userData.surface !== 'floor') continue;
      if (slime(m.userData.sector)) m.visible = false; // still a click collider
      if (walkway(m.userData.sector)) {
        // The floor polygon becomes the far grating (grate.js); the scanned grate texture never lands here.
        m.material = this.walkway.floorMats.get(m.userData.sector);
        m.userData.walkway = true;
        m.castShadow = false; // the bars cast the real shadow
      }
    }
    this.lightPlan = planLights(annotateFixtures(level), rng.fork('lights'));
    this.wet = buildWetPatches(planWetPatches(level, this.lightPlan, rng.fork('wet')), this.renderer);
    this.scene.add(this.wet);
    this.rig = new LightRig(this.scene, this.lightPlan, { level });
    // Scanned materials that arrived before this scene was built (a reseed, or a slow level fetch).
    for (const it of this.app?.assetItems?.values?.() ?? []) this.applyAsset(it.kind, it.name, it.asset);
    this.graph = buildNavGraph(level);
    const tour = makeTour(level.pois, rng.fork('tour'));
    this.walker = new Walker(level, this.graph, tour, rng.fork('walker'));
    this.applyPose(this.walker.step(0, this.input));
    this.updateLights(1, this.settings); // start with the nearest lights already faded in
  }

  /**
   * Called by app.js as each asset finishes loading (and by build for those that came first): a material
   * replaces the greybox on every surface planned to wear it. The tour keeps running throughout.
   */
  applyAsset(kind, name, asset) {
    if (kind !== 'material' || !this.mesh || !asset?.color) return;
    if (name === 'mat:steel-brushed') this.walkway?.setMaps(asset);
    const key = name.startsWith('mat:') ? name.slice(4) : name;
    const meshes = this.mesh.group.children.filter((m) => m.userData.key === key && !m.userData.walkway);
    if (meshes.length) {
      const material = makeMaterial(name, asset, this.app?.manifest?.materials?.[name], this.renderer);
      for (const m of meshes) m.material = material;
    }
    // The probes see the new surfaces after a short settle (assets arrive in bursts).
    if (this.probes) { this.assignProbes(); this.probeRebakeAt = this.time + 0.5; }
  }

  /**
   * Every mesh's reflection is its room's probe (by userData.sector, else the sector under it). Level and
   * fixture materials are shared (per tag, per fixture kind), so each mesh gets a scene-owned variant per
   * probe; materials made for one room (userData.envDirect: slime, walkway, wet patches) take it directly.
   */
  assignProbes() {
    const box = new THREE.Box3(), c = new THREE.Vector3();
    this.scene.traverse((o) => {
      if (!o.isMesh || !(o.material?.isMeshStandardMaterial)) return;
      let sector = o.userData.sector;
      if (!sector) {
        box.setFromObject(o).getCenter(c);
        sector = sectorAt(this.level, c.x, c.z)?.id;
      }
      const tex = sector ? this.probes.get(sector) : null;
      if (!tex) return;
      const mat = o.material;
      if (mat.userData.envDirect) {
        if (mat.envMap !== tex) { mat.envMap = tex; mat.needsUpdate = true; }
        return;
      }
      const base = mat.userData.base ?? mat;
      const k = `${base.uuid}|${base.version}|${tex.uuid}`;
      let v = this.envVariants.get(k);
      if (!v) { v = envVariant(base, tex); this.envVariants.set(k, v); }
      o.material = v;
    });
  }

  /** Debug only (window.hangar.light): a raking point lamp for close inspection; never created otherwise. */
  setDebugLamp(x, y, z, intensity = 6, distance = 8) {
    if (!this.debugLamp) {
      this.debugLamp = new THREE.PointLight(0xfff2e0, intensity, distance, 2);
      this.scene.add(this.debugLamp);
    }
    this.debugLamp.position.set(x, y, z);
    this.debugLamp.intensity = intensity;
    this.debugLamp.distance = distance;
    return this.debugLamp;
  }

  /** Debug only: parallax relief on or off for every patched material (shared uniform). */
  setRelief(on) { pomUniforms.pomEnabled.value = on ? 1 : 0; }

  applyPose(p) {
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, p.roll);
  }

  step(dt, pointer, settings) {
    void settings;
    this.time += dt;
    if (!this.walker) return;
    const inp = this.input;
    inp.gaze = null; inp.restedAt = null; inp.click = null;
    if (pointer?.inside && this.screenW > 0 && this.screenH > 0) {
      // Gaze: the cursor's direction from the screen centre, as angles relative to the view.
      const nx = (pointer.x / this.screenW) * 2 - 1, ny = (pointer.y / this.screenH) * 2 - 1;
      const tv = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      inp.gaze = { yaw: -Math.atan(nx * tv * this.camera.aspect), pitch: Math.atan(ny * tv) };
      if (this.cursorRested(pointer)) inp.restedAt = this.pick(pointer, true);
    } else {
      this.trail.length = 0;
      this.rest.armed = false;
    }
    if (this.pendingClick) {
      const hit = this.pick(this.pendingClick, false);
      this.pendingClick = null;
      const t = resolveClickTarget(this.level, this.graph, hit);
      if (t) inp.click = { x: t.x, y: hit.y, z: t.z };
    }
    this.applyPose(this.walker.step(dt, inp));
    this.updateLights(dt, settings ?? this.settings);
    // Re-bake the probes once Emergency Power has settled at a new level, or after materials arrived.
    if (this.probes) {
      const settled = this.emergency === 0 || this.emergency === 1;
      if ((settled && this.probeEmergency !== this.emergency) || (this.probeRebakeAt !== null && this.time >= this.probeRebakeAt)) {
        this.probeEmergency = this.emergency;
        this.probeRebakeAt = null;
        this.probes.queue(this.camera.position);
      }
    }
  }

  /** Eases Emergency Power toward the setting (1.5 s, smoothstep-shaped) and updates the light rig. */
  updateLights(dt, settings) {
    if (!this.rig) return;
    const target = settings?.emergency ? 1 : 0;
    const k = dt / 1.5;
    this.emergency = target > this.emergency ? Math.min(target, this.emergency + k) : Math.max(target, this.emergency - k);
    const e = this.emergency * this.emergency * (3 - 2 * this.emergency);
    this.camera.getWorldDirection(this.camDir);
    this.rig.update(dt, this.camera.position, e, !!settings?.lowPower, this.camDir);
    this.slime?.update(dt, this.camera); // the glow lights and the pool to mirror (glow unchanged by Emergency)
  }

  /** True once when the pointer has come to rest after a deliberate move. */
  cursorRested(pt) {
    const now = this.time, tr = this.trail, r = this.rest;
    tr.push([now, pt.x, pt.y]);
    while (tr.length && tr[0][0] < now - 1) tr.shift();
    let travel = 0;
    for (let i = 1; i < tr.length; i++) travel += Math.hypot(tr[i][1] - tr[i - 1][1], tr[i][2] - tr[i - 1][2]);
    if (travel > REST_MOVE) r.armed = true;
    if (Math.hypot(pt.x - r.x, pt.y - r.y) > REST_STILL) { r.x = pt.x; r.y = pt.y; r.t = now; return false; }
    if (r.armed && now - r.t >= REST_HOLD) { r.armed = false; return true; }
    return false;
  }

  /** World point under a screen point (CSS px, y up): the first collider hit, or (if `far`) a point 40 m out. */
  pick(pt, far) {
    if (!this.mesh) return null;
    this.ndc.set((pt.x / this.screenW) * 2 - 1, (pt.y / this.screenH) * 2 - 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.mesh.colliders, false)[0];
    if (hit) return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    if (!far) return null;
    const p = this.raycaster.ray.at(40, new THREE.Vector3());
    return { x: p.x, y: p.y, z: p.z };
  }

  click(pt) { this.pendingClick = { x: pt.x, y: pt.y }; }

  render() {
    // One shadow-map update per frame (guidelines section 3), in the main pass, whose camera sees every
    // caster. Probe bakes and the mirror run first and reuse the previous frame's maps (the mirror's camera
    // leaves out the bars and the slime); only the very first bake renders them, with every layer on.
    const sm = this.renderer.shadowMap;
    sm.needsUpdate = false;
    if (this.level && this.slime) {
      if (!this.probes) {
        // First frame: bake every probe, hand them out, and bake again so metal sees metal (two bounces).
        sm.needsUpdate = true;
        const opts = { before: () => this.slime.setProbeMode(true), after: () => this.slime.setProbeMode(false) };
        this.probes = bakeProbes(this.level, this.scene, this.renderer, opts);
        this.assignProbes();
        this.probes.bakeAll();
        this.probeEmergency = this.emergency;
      } else {
        this.probes.update(1);
      }
      this.walkway.update(this.camera, this.renderer);
      this.walkway.setMirrorPass(true);
      this.slime.render(this.camera);
      this.walkway.setMirrorPass(false);
    }
    sm.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.screenW = w;
    this.screenH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.rig?.dispose();
    this.probes?.dispose();
    this.slime?.dispose();
    this.walkway?.dispose();
    this.wet?.userData.dispose?.();
    for (const v of this.envVariants.values()) {
      v.dispose();
      const base = v.userData.base;
      if (base && !base.userData.shared) base.dispose(); // greybox and fixture materials (no longer on a mesh)
    }
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      // Scanned materials and their textures belong to the page (materials.js / app.assets), not the scene.
      if (!o.material?.userData?.shared) o.material?.dispose?.();
    });
  }
}
