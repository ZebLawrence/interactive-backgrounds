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
import { annotateFixtures, planLights, lightRooms } from './lightplan.js';
import { LightRig } from './lights.js';
import { Walker, resolveClickTarget } from './walker.js';
import { sectorAt } from './level.js';
import { Slime, SLIME_LAYER } from './slime.js';
import { bakeProbes } from './probes.js';
import { Walkway, BAR_LAYER } from './grate.js';
import { buildWetPatches } from './wet.js';
import { planWetPatches, slimeSkirts } from './wetplan.js';
import { PhobosSky, loadSkyData } from './sky.js';
import { openEdges, planShell, sectorClass, sunlitSectors } from './phobos.js';
import { Doors, Lift, Switches, PropMaterials } from './doors.js';
import { Consoles } from './screens.js';
import { scatterProps, CATALOGUE, planPipes, planDecals, propObstacles, blockNav } from './scatter.js';
import { Dressing } from './props.js';
import { buildPost, textureMemory } from './post.js';
import { planHaze } from './hazeplan.js';

// The level data carries this module's own ?v= (from the import map in index.html), so a push that changes it
// is fetched fresh, not served from a cached copy alongside new code.
const VERSION = new URL(import.meta.url).searchParams.get('v');
const versioned = (url) => (VERSION ? `${url}?v=${VERSION}` : url);

// The cursor "comes to rest after moving": it travelled more than REST_MOVE px within the last
// second, then stayed within REST_STILL px for REST_HOLD s. A cursor that just sits does nothing.
const REST_MOVE = 30, REST_STILL = 4, REST_HOLD = 0.8;

// Greybox stand-ins, worn until each scanned material arrives (and kept if one never does).
const GREYS = {
  steel: 0x8d96a0, 'steel-brushed': 0x9aa2aa, concrete: 0x777777, 'concrete-cracked': 0x737373, 'concrete-stained': 0x6e6c68,
  'concrete-painted': 0x8a8a86, computer: 0x5d7a8a, 'panel-brown': 0x8a6a4e, grate: 0x4a4a4a, regolith: 0xa0907a,
};

// Window glass: clean and nearly invisible, the view outside is the point. A faint cool tint head-on and a
// Fresnel sheen at grazing angles, unlit. The old standard material took the room probe's blurred image
// of the ceiling strips (rough 0.1 on a 128 px probe), which smeared soft bands across Mars and the sky.
const GLASS_VERT = /* glsl */ `
varying vec3 vGlassW;
varying vec3 vGlassN;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vGlassW = w.xyz;
  vGlassN = mat3( modelMatrix ) * normal;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const GLASS_FRAG = /* glsl */ `
varying vec3 vGlassW;
varying vec3 vGlassN;
void main() {
  vec3 V = cameraPosition - vGlassW;
  float vl = length( V ), nl = length( vGlassN );
  float c = ( vl > 1e-6 && nl > 1e-6 ) ? abs( dot( vGlassN / nl, V / vl ) ) : 1.0;
  float f = pow( clamp( 1.0 - c, 0.0, 1.0 ), 5.0 );
  gl_FragColor = vec4( mix( vec3( 0.02, 0.026, 0.03 ), vec3( 0.32, 0.36, 0.4 ), f ), 0.05 + 0.3 * f );
  #include <colorspace_fragment>
}
`;
function glassMaterial() {
  return new THREE.ShaderMaterial({
    name: 'glass', vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

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
    this.scene.background = new THREE.Color(0x000000); // space: Mars, the sun and the stars are sky.js
    // Far enough for the ground out to 2 km (the sky itself sits on the far plane, whatever it is).
    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 2500);
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
    this.disposed = false; // set by dispose(): a level that arrives later is not built (see build)
    this.level = null;
    this.walker = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.pendingClick = null;
    this.trail = []; // recent pointer samples [t, x, y] over the last second
    this.rest = { x: 0, y: 0, t: 0, armed: false };
    this.input = { gaze: null, restedAt: null, click: null };
    // The post stack (post.js): native-size targets, rebuilt on resize and on a Low Power change, nothing else.
    this.lowPower = !!settings?.lowPower;
    this.post = buildPost(renderer, this.scene, this.camera, w, h, app?.pixelRatio ?? renderer.getPixelRatio(), this.lowPower);
    // The level, and the real ground and stars (sky.js; fetched once per page, null if they fail).
    this.ready = Promise.all([fetch(versioned('./data/e1m1.json')).then((r) => {
      if (!r.ok) throw new Error(`level data ${r.url} returned HTTP ${r.status}`);
      return r.json();
    }), loadSkyData()]).then(([json, skyData]) => { this.skyData = skyData; this.build(json); });
  }

  build(json) {
    // A reseed (or two) while the level was still fetching disposes this scene before the data arrives: build
    // nothing then, or the lights, probes and textures of a scene nobody draws would never be freed.
    if (this.disposed) return;
    const level = (this.level = loadLevel(json));
    const rng = makeRng(this.seed);
    // Which variant each sector's floor, walls and ceiling wear this seed (rooms differ, a room is uniform).
    this.plan = planMaterials(level, rng.fork('materials'));
    const mats = new Map();
    for (const [name, color] of Object.entries(GREYS)) mats.set(name, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.FrontSide }));
    mats.set('window', glassMaterial());
    const keyOf = (sector, mat, surface) => this.plan.get(sector)?.[surface] ?? mat;
    // The walkway is a bridge of open grating: the solid lower walls under it go, and every slime pool gets a
    // skirt below its rim (its floor is hidden: the slime surface sits SLIME_DROP lower).
    const walkway = (id) => level.byId.get(id)?.tags.has('walkway');
    const slime = (id) => level.byId.get(id)?.tags.has('slime');
    // Open sectors' edges of the world: exterior ones go (the terrain runs on), courtyard ones become parapets
    // (phobos.openEdges); their inner faces join the level mesh, the rest of the base's outside is sky.js.
    this.edges = openEdges(level);
    this.shell = planShell(level, this.edges);
    const wallKey = (sector, a, b) => `${sector}|${a[0].toFixed(3)},${a[1].toFixed(3)}|${b[0].toFixed(3)},${b[1].toFixed(3)}`;
    const opened = new Set([...this.edges.dropped, ...this.edges.parapets, ...this.edges.lowered.keys()].map((w) => wallKey(w.front, w.a, w.b)));
    const family = (id) => [...level.byId.get(id).tags].find((t) => t.startsWith('mat:')).slice(4);
    this.mesh = buildLevelMesh(level, mats, undefined, keyOf, {
      skipWall: (q) => (q.kind === 'lower' && walkway(q.back) && slime(q.sector))
        || ((q.kind === 'solid' || q.kind === 'upper') && opened.has(wallKey(q.sector, [q.corners[0][0], q.corners[0][2]], [q.corners[1][0], q.corners[1][2]]))),
      extraQuads: [...slimeSkirts(level), ...this.shell.inner.map((q) => ({ ...q, mat: family(q.sector), kind: 'parapet' }))],
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
    this.hazePlan = planHaze(level);
    this.post.setHazeMap(this.hazePlan);
    for (const m of this.mesh.group.children) {
      if (m.userData.surface !== 'floor') continue;
      if (slime(m.userData.sector)) m.visible = false; // still a click collider
      // Exterior floors are the terrain itself (sky.js); the polygon stays as a click collider.
      const s = level.byId.get(m.userData.sector);
      if (s && sectorClass(s) === 'exterior' && !s.tags.has('slime')) m.visible = false;
      if (walkway(m.userData.sector)) {
        // The floor polygon becomes the far grating (grate.js); the scanned grate texture never lands here.
        m.material = this.walkway.floorMats.get(m.userData.sector);
        m.userData.walkway = true;
        m.castShadow = false; // the bars cast the real shadow
      }
    }
    this.lightPlan = planLights(annotateFixtures(level), rng.fork('lights'));
    const wetPlan = planWetPatches(level, this.lightPlan, rng.fork('wet'));
    this.wet = buildWetPatches(wetPlan, this.renderer);
    this.scene.add(this.wet);
    const rooms = lightRooms(level);
    this.rig = new LightRig(this.scene, this.lightPlan, { level, rooms });
    // The base reacting: doors, the lift, wall switches and consoles (they wear the scanned steels as they arrive).
    this.props = new PropMaterials();
    const sunlit = sunlitSectors(level);
    this.doors = new Doors(level, this.mesh, this.props, { sunlit });
    this.lift = level.lifts.length ? new Lift(level, this.mesh, this.props, level.lifts[0], { sunlit }) : null;
    const hasLights = (id) => this.lightPlan.some((f) => f.kind !== 'emergency' && f.room === rooms.get(id));
    this.switches = new Switches(level, this.doors.frames, this.props, this.rig, hasLights);
    this.consoles = new Consoles(level, this.scene, rng.fork('consoles'), { renderer: this.renderer, assets: this.props, switches: this.switches.list });
    for (const g of [this.doors.group, this.lift?.group, this.switches.group, this.consoles.group]) if (g) this.scene.add(g);
    this.interactive = [...this.doors.interactive, ...this.switches.interactive, ...this.consoles.interactive];
    // Seeded dressing: props on the floors and walls (never on the walker's routes or the wet patches), pipe runs,
    // grime and leaks. The walker plans round the props as round walls, on a nav graph without the nodes they cover.
    const navGraph = buildNavGraph(level);
    const placements = scatterProps(level, navGraph, rng.fork('props'), CATALOGUE, { avoid: wetPlan.map((p) => ({ x: p.x, z: p.z, r: p.r * p.stretch + 0.1 })) });
    this.obstacles = propObstacles(placements);
    this.graph = blockNav(navGraph, this.obstacles);
    this.dressing = new Dressing(level, { placements, pipes: planPipes(level, rng.fork('pipes')), decals: planDecals(level, rng.fork('decals')) }, this.props, { sunlit });
    this.scene.add(this.dressing.group);
    this.pickables = [...this.mesh.colliders, ...this.interactive];
    // Scanned materials that arrived before this scene was built (a reseed, or a slow level fetch).
    for (const it of this.app?.assetItems?.values?.() ?? []) this.applyAsset(it.kind, it.name, it.asset);
    // Phobos outside: Mars, the sun, stars, terrain, boulders, the base's outer walls (takes the items so far).
    this.sky = new PhobosSky(this.scene, this.app?.assetItems, rng.fork('sky'), { level, renderer: this.renderer, edges: this.edges, shell: this.shell, data: this.skyData });
    this.planSunReach();
    if (this.dressing.sunChanged) this.sky.refreshShadow(); // the sun's shadow map is static: props are new casters
    const tour = makeTour(level.pois, rng.fork('tour'));
    this.walker = new Walker(level, this.graph, tour, rng.fork('walker'), { doors: this.doors, lift: this.lift, obstacles: this.obstacles });
    this.doors.setWalker(this.walker);
    this.applyPose(this.walker.step(0, this.input));
    this.updateLights(1, this.settings); // start with the nearest lights already faded in
  }

  /**
   * Called by app.js as each asset finishes loading (and by build for those that came first): a material
   * replaces the greybox on every surface planned to wear it. The tour keeps running throughout.
   */
  applyAsset(kind, name, asset) {
    // The sky's own assets (Mars, boulders, regolith and concrete for the outside); the probes then re-bake so
    // the courtyard and window rooms see them.
    if (this.sky?.setAsset(kind, name, asset) && this.probes) { this.assignProbes(); this.probeRebakeAt = this.time + 0.5; }
    // A prop model: its instances appear, cast into the sun's (static) shadow map if the sun reaches them, and
    // the probes see them after a short settle.
    if (kind === 'model' && this.dressing?.setModel(name, asset)) {
      if (this.dressing.sunlitModel(name)) this.sky?.refreshShadow();
      if (this.probes) { this.assignProbes(); this.probeRebakeAt = this.time + 0.5; }
    }
    if (kind !== 'material' || !this.mesh || !asset?.color) return;
    if (name === 'mat:steel-brushed') this.walkway?.setMaps(asset);
    const key = name.startsWith('mat:') ? name.slice(4) : name;
    const meshes = this.mesh.group.children.filter((m) => m.userData.key === key && !m.userData.walkway);
    const made = () => makeMaterial(name, asset, this.app?.manifest?.materials?.[name], this.renderer); // cached per tag
    if (meshes.length) {
      const material = made();
      for (const m of meshes) m.material = material;
    }
    if (this.props?.has(name)) this.props.set(name, made());
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
      const noSun = this.sunDark ? (this.levelMeshes.has(o) ? this.sunDark.has(o) : !this.sunSectors.has(sector)) : false;
      const k = `${base.uuid}|${base.version}|${tex.uuid}|${noSun ? 'dark' : 'sun'}`;
      let v = this.envVariants.get(k);
      if (!v) { v = envVariant(base, tex, { noSun }); this.envVariants.set(k, v); }
      o.material = v;
    });
  }

  /**
   * Ruling R22: which surfaces the sun can reach. Level meshes outside sunlitSectors (corridors, tunnels, the
   * dark room) never can. In the rooms with windows a mesh counts as sunlit if any point of a sun-facing
   * triangle, on a grid of about 2 m, has a clear line to the sun through the level and the base's outer
   * shell. Ceilings never face the sun. Other meshes (fixtures, props) go by their sector. assignProbes
   * gives the rest a variant that compiles the sun's light and shadow lookup out.
   */
  planSunReach() {
    const level = this.level, L = this.sky.sunDir;
    this.sunSectors = sunlitSectors(level);
    this.levelMeshes = new Set(this.mesh.group.children);
    const occMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const occluders = [...this.mesh.group.children.filter((m) => m.userData.mat !== 'window'), ...this.sky.shellMeshes].map((m) => {
      const o = new THREE.Mesh(m.geometry, occMat);
      m.updateMatrixWorld();
      o.matrixWorld.copy(m.matrixWorld);
      o.matrixAutoUpdate = false;
      return o;
    });
    const rc = new THREE.Raycaster();
    rc.far = 40; // 20 m up at the sun's 30°: above every roof
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), P = new THREE.Vector3();
    const reaches = (m) => {
      const pos = m.geometry.attributes.position, nrm = m.geometry.attributes.normal, idx = m.geometry.index;
      const count = idx ? idx.count : pos.count;
      for (let t = 0; t < count; t += 3) {
        const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
        N.fromBufferAttribute(nrm, ia);
        if (N.dot(L) <= 0.02) continue;
        A.fromBufferAttribute(pos, ia); B.fromBufferAttribute(pos, ib); C.fromBufferAttribute(pos, ic);
        const k = Math.min(8, Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) / 2)));
        for (let i = 0; i <= k; i++) for (let j = 0; j <= k - i; j++) {
          const u = (i + 0.3) / (k + 1), v = (j + 0.3) / (k + 1);
          P.copy(A).multiplyScalar(1 - u - v).addScaledVector(B, u).addScaledVector(C, v).addScaledVector(N, 0.05);
          rc.set(P, L);
          if (rc.intersectObjects(occluders, false).length === 0) return true;
        }
      }
      return false;
    };
    const dark = new Set();
    for (const m of this.mesh.group.children) {
      const s = level.byId.get(m.userData.sector);
      if (!s || m.userData.mat === 'window') continue;
      if (!this.sunSectors.has(s.id)) { dark.add(m); continue; }
      if (s.tags.has('sky') || s.tags.has('window')) continue;
      if (!reaches(m)) dark.add(m);
    }
    occMat.dispose();
    this.sunDark = dark;
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
      // A door, switch or console operates; anything else is a hint of where to walk.
      if (!this.operate(hit?.object)) {
        const t = resolveClickTarget(this.level, this.graph, hit);
        if (t) inp.click = { x: t.x, y: hit.y, z: t.z };
      }
    }
    const pose = this.walker.step(dt, inp);
    this.applyPose(pose);
    // Doors and the lift; the sun's shadow map is static, so it re-renders while one it can see moves.
    let sunMoved = this.doors?.update(dt, pose) ?? false;
    if (this.lift?.update(dt)) sunMoved = true;
    if (sunMoved) this.sky?.refreshShadow();
    this.switches?.update(dt);
    if (this.rig?.roomsMoving) this.roomsSettle = true;
    else if (this.roomsSettle) { this.roomsSettle = false; this.probeRebakeAt = this.time; } // reflections see the room's new light
    this.updateLights(dt, settings ?? this.settings);
    this.consoles?.update(dt, this.camera);
    this.sky?.update(dt, this.camera);
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
    this.post?.setEmergency(e);
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

  /**
   * World point under a screen point (CSS px, y up): the first hit among the colliders and the doors, switches
   * and consoles ({ x, y, z, object }), or (if `far`) a point 40 m out.
   */
  pick(pt, far) {
    if (!this.mesh) return null;
    this.ndc.set((pt.x / this.screenW) * 2 - 1, (pt.y / this.screenH) * 2 - 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables ?? this.mesh.colliders, false)[0];
    if (hit && Number.isFinite(hit.point.x)) return { x: hit.point.x, y: hit.point.y, z: hit.point.z, object: hit.object };
    if (!far) return null;
    const p = this.raycaster.ray.at(40, new THREE.Vector3());
    return { x: p.x, y: p.y, z: p.z };
  }

  click(pt) { this.pendingClick = { x: pt.x, y: pt.y }; }

  /** Operates the door, switch or console `object` belongs to; false if it is none of those. */
  operate(object) {
    const it = object?.userData?.interactive;
    if (!it) return false;
    if (it.kind === 'door') this.doors?.operate(it.id);
    else if (it.kind === 'switch') this.switches?.operate(it.id);
    else if (it.kind === 'console') this.consoles?.operate(it.id);
    return true;
  }

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
        // The first bake rendered the sun's shadow map: hand it to the terrain and rocks before the second
        // bake, so the probes (a reseed's too) see the outside shadowed.
        this.sky?.syncShadow();
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
    this.sky?.syncShadow();
    this.post.render(); // the main pass (post.BeautyPass), then AO, haze, bloom and tone mapping
  }

  /** A new window size (CSS px) or pixel ratio: the camera and the post targets follow; everything else stays. */
  resize(w, h, pixelRatio = this.post.pixelRatio) {
    if (!(w > 0 && h > 0)) return;
    this.screenW = w;
    this.screenH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.resize(w, h, pixelRatio);
  }

  /** Low Power on or off: the post stack is rebuilt (no AO; MSAA stays) at the new pixel ratio; the walk stays. */
  setLowPower(on, pixelRatio) {
    on = !!on;
    if (on === this.lowPower && pixelRatio === this.post.pixelRatio) return;
    this.lowPower = on;
    this.post.dispose();
    this.post = buildPost(this.renderer, this.scene, this.camera, this.screenW, this.screenH, pixelRatio, on);
    if (this.hazePlan) this.post.setHazeMap(this.hazePlan);
    this.post.setEmergency(this.emergency * this.emergency * (3 - 2 * this.emergency));
  }

  /** ?perf: estimated texture memory in bytes (scene textures, post targets, probes, the slime mirror). */
  textureBytes() {
    const probeTargets = this.probes ? [this.probes.cube, ...this.probes.probes.map((p) => p.target)] : [];
    return textureMemory(this.scene, [...this.post.targets(), ...probeTargets, this.slime?.target].filter(Boolean));
  }

  dispose() {
    this.disposed = true;
    this.post?.dispose();
    this.rig?.dispose();
    this.consoles?.dispose(); // canvas textures (materials and geometry go with the traversal below)
    this.props?.dispose();
    this.dressing?.dispose(); // this seed's geometry and decal materials (the models' are the page's)
    this.sky?.dispose();
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
      if (!o.geometry?.userData?.shared) o.geometry?.dispose(); // loaded models' geometry is the page's
      // Scanned materials and their textures belong to the page (materials.js / app.assets), not the scene.
      if (!o.material?.userData?.shared) o.material?.dispose?.();
    });
  }
}
